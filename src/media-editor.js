// Media editing engine: open a recording (MP4/WebM via a hidden <video>) or a GIF (ImageDecoder),
// draw or grab a cropped frame at any time, and export trimmed/cropped clips as MP4 (WebCodecs
// H.264 + window.Mp4Muxer, optionally with an AAC track) or GIF (window.gifenc). Classic script:
// exposes window.MediaEditor.
//   const src = await MediaEditor.openSource({ kind: 'video', fileURL })  // or { kind: 'gif', bytes }
//   await MediaEditor.drawFrame(src, ctx, t, crop)     // crop {x,y,w,h} in source px, or null
//   const png = await MediaEditor.grabFrame(src, t, crop)
//   const out = await MediaEditor.exportMedia({ clips: [{ source, start, end, crop }], format: 'mp4' })
//   const buf = await MediaEditor.decodeAudio(bytes)   // AudioBuffer, or null when there is no audio
// Each source runs one frame request at a time (seek + draw is atomic), so scrubbing a source while
// it is being exported stays correct, but the two fight over the seek position and both slow down;
// the UI is expected not to do that.
(function (root) {
  'use strict';

  const MIN_GIF_DELAY_US = 100000;   // browsers play delays <= 10ms at 100ms
  const RVFC_WAIT_MS = 100;         // how long to wait for the seeked frame to be presented
  const SEEK_TIMEOUT_MS = 15000;
  const YIELD_MS = 16;
  const MAX_ENCODE_QUEUE = 8;
  const AUDIO_RATE = 48000, AUDIO_CHANNELS = 2, AUDIO_CHUNK = 1024;
  const AAC_CONFIG = { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: 128000 };
  const AUDIO_PROGRESS = 0.95;       // progress reached when the video frames are done and audio starts

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function abortError() {
    const e = new Error('Export cancelled');
    e.name = 'AbortError';
    return e;
  }

  // setTimeout is throttled in background windows; a MessageChannel hop is not.
  const yieldChannel = new MessageChannel();
  const yieldQueue = [];
  yieldChannel.port1.onmessage = () => yieldQueue.shift()();
  const yieldToUI = () => new Promise(r => { yieldQueue.push(r); yieldChannel.port2.postMessage(0); });

  function once(target, event, errorEvent, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const done = () => {
        target.removeEventListener(event, onOk);
        if (errorEvent) target.removeEventListener(errorEvent, onErr);
        clearTimeout(timer);
      };
      const onOk = e => { done(); resolve(e); };
      const onErr = () => { done(); reject(mediaError(target)); };
      target.addEventListener(event, onOk);
      if (errorEvent) target.addEventListener(errorEvent, onErr);
      if (timeoutMs) timer = setTimeout(() => { done(); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    });
  }

  function mediaError(video) {
    const err = video.error;
    return new Error('Could not load video' + (err && err.message ? `: ${err.message}` : ''));
  }

  function normCrop(crop, w, h) {
    if (!crop) return { x: 0, y: 0, w, h };
    const x = clamp(Math.round(crop.x), 0, w - 1), y = clamp(Math.round(crop.y), 0, h - 1);
    return {
      x, y,
      w: clamp(Math.round(crop.w), 1, w - x),
      h: clamp(Math.round(crop.h), 1, h - y),
    };
  }

  // ---- Sources ----

  class Source {
    constructor(kind) {
      this.kind = kind;
      this.width = 0; this.height = 0; this.duration = 0; this.fps = 30;
      this._busy = Promise.resolve();
      this._closed = false;
    }
    // Runs fn(image) with the frame at time t; image is any CanvasImageSource. Serialised per source.
    _withFrame(t, fn) {
      const run = this._busy.then(async () => {
        if (this._closed) throw new Error('Source is closed');
        return fn(await this._frameAt(clamp(+t || 0, 0, this.duration)));
      });
      this._busy = run.catch(() => {});
      return run;
    }
  }

  class VideoSource extends Source {
    constructor() {
      super('video');
      const v = this.video = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      // In the document (but invisible) so Chromium keeps decoding and presenting frames for it.
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      (document.body || document.documentElement).appendChild(v);
      this._shown = null;      // { from, to, m }: targets in [from, to] are known to show mediaTime m
      this._rvfcMisses = 0;
    }

    async _open(fileURL) {
      const v = this.video;
      v.src = fileURL;
      await once(v, 'loadedmetadata', 'error', SEEK_TIMEOUT_MS);
      if (!Number.isFinite(v.duration)) {
        // MediaRecorder WebM has no duration in its header; seeking far past the end makes Chromium
        // scan the file and report the real one.
        const changed = once(v, 'durationchange', 'error', SEEK_TIMEOUT_MS);
        v.currentTime = 1e101;
        await changed;
        while (!Number.isFinite(v.duration)) await once(v, 'durationchange', 'error', SEEK_TIMEOUT_MS);
        const back = once(v, 'seeked', 'error', SEEK_TIMEOUT_MS);
        v.currentTime = 0;
        await back;
      }
      if (v.readyState < 2) await once(v, 'loadeddata', 'error', SEEK_TIMEOUT_MS);
      this.width = v.videoWidth; this.height = v.videoHeight;
      this.duration = v.duration;
      this.fps = await this._estimateFps();
    }

    // Recordings are variable frame rate, so this is only a guess from a short muted playback burst.
    async _estimateFps() {
      const v = this.video;
      if (!v.requestVideoFrameCallback || document.visibilityState === 'hidden') return 30;
      const times = [];
      let id = 0;
      const tick = (_now, meta) => { times.push(meta.mediaTime); if (times.length < 10) id = v.requestVideoFrameCallback(tick); };
      id = v.requestVideoFrameCallback(tick);
      try {
        await v.play();
        const until = performance.now() + 400;
        while (times.length < 10 && performance.now() < until && !v.ended) await sleep(20);
      } catch { /* autoplay refused: keep the default */ }
      v.cancelVideoFrameCallback(id);
      v.pause();
      const back = once(v, 'seeked', 'error', SEEK_TIMEOUT_MS);
      v.currentTime = 0;
      await back;
      this._shown = null;
      const gaps = [];
      for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) gaps.push(times[i] - times[i - 1]);
      if (gaps.length < 3) return 30;
      gaps.sort((a, b) => a - b);
      const fps = 1 / gaps[gaps.length >> 1];
      return clamp(Math.round(fps), 1, 120);
    }

    async _frameAt(t) {
      await this._seek(Math.min(t, Math.max(0, this.duration - 0.001)));
      return this.video;
    }

    async _seek(t) {
      const v = this.video, s = this._shown;
      if (s && t >= s.from && t <= s.to) return;
      // Wait for the new frame to be presented (not just decoded) so drawImage can't see the old
      // one; its mediaTime also tells us which later targets map to the same frame. Skipped once it
      // has proven not to fire (e.g. window hidden), since then every seek would pay the timeout.
      const useRVFC = v.requestVideoFrameCallback && this._rvfcMisses < 3 && document.visibilityState !== 'hidden';
      let rvfcId = 0;
      const presented = useRVFC ? new Promise(r => { rvfcId = v.requestVideoFrameCallback((_n, meta) => r(meta.mediaTime)); }) : null;
      const seeked = once(v, 'seeked', 'error', SEEK_TIMEOUT_MS);
      v.currentTime = t;
      await seeked;
      const m = presented ? await Promise.race([presented, sleep(RVFC_WAIT_MS).then(() => null)]) : null;
      if (m == null) {
        if (presented) { v.cancelVideoFrameCallback(rvfcId); this._rvfcMisses++; }
        this._shown = { from: t, to: t, m: null };
      } else {
        this._rvfcMisses = 0;
        this._shown = s && s.m === m
          ? { from: Math.min(s.from, t), to: Math.max(s.to, t), m }
          : { from: Math.min(m, t), to: t, m };
      }
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
    }
  }

  class GifSource extends Source {
    constructor() {
      super('gif');
      this._decoder = null;
      this._starts = [];       // start time (s) of each frame
      this._cached = null;     // { index, frame: VideoFrame }
    }

    async _open(bytes) {
      if (!root.ImageDecoder) throw new Error('GIF editing needs ImageDecoder (WebCodecs)');
      const dec = this._decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
      await dec.tracks.ready;
      await dec.completed;
      const count = dec.tracks.selectedTrack.frameCount;
      if (!count) throw new Error('GIF has no frames');
      let us = 0;   // whole microseconds, so frame starts don't drift (0.1 + 0.2 !== 0.3)
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (i === 0) { this.width = image.displayWidth; this.height = image.displayHeight; }
        this._starts.push(us / 1e6);
        const d = Math.round(image.duration || 0);
        us += d <= 10000 ? MIN_GIF_DELAY_US : d;
        image.close();
      }
      this.duration = us / 1e6;
      this.fps = Math.round(count / this.duration) || 10;
    }

    _indexAt(t) {
      const s = this._starts;
      t += 1e-6;   // a sample time computed as start + k/fps may land a hair before a frame start
      let lo = 0, hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    async _frameAt(t) {
      const index = this._indexAt(t);
      if (this._cached && this._cached.index === index) return this._cached.frame;
      const { image } = await this._decoder.decode({ frameIndex: index });
      if (this._cached) this._cached.frame.close();
      this._cached = { index, frame: image };
      return image;
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      if (this._cached) this._cached.frame.close();
      this._cached = null;
      if (this._decoder) this._decoder.close();
    }
  }

  async function openSource({ kind, fileURL, bytes } = {}) {
    let src;
    if (kind === 'video') src = new VideoSource();
    else if (kind === 'gif') src = new GifSource();
    else throw new Error(`Unknown source kind: ${kind}`);
    try {
      await src._open(kind === 'video' ? fileURL : bytes);
    } catch (e) {
      src.close();
      throw e;
    }
    return src;
  }

  // ---- Frames ----

  function drawFrame(source, ctx, t, crop) {
    const c = normCrop(crop, source.width, source.height), cv = ctx.canvas;
    return source._withFrame(t, img => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
    });
  }

  async function grabFrame(source, t, crop) {
    const c = normCrop(crop, source.width, source.height);
    const canvas = document.createElement('canvas');
    canvas.width = c.w; canvas.height = c.h;
    await drawFrame(source, canvas.getContext('2d'), t, c);
    return canvas.toDataURL('image/png');
  }

  // ---- Audio ----

  // Decoded (and resampled) at AUDIO_RATE so export mixing rarely has to resample. An offline
  // context holds no audio device, so there's nothing to close.
  async function decodeAudio(bytes) {
    if (!bytes || !bytes.byteLength || !root.OfflineAudioContext) return null;
    try {
      const ctx = new OfflineAudioContext(1, 1, AUDIO_RATE);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer);   // copy: decodeAudioData detaches it
      return buf && buf.length ? buf : null;
    } catch {
      return null;   // no audio track, or not a format the decoder knows (e.g. GIF)
    }
  }

  // Lays the segments end to end in one stereo AUDIO_RATE buffer of exactly `length` frames; the
  // offline context resamples other rates, up-mixes mono to both channels, pads and trims.
  function mixAudio(segments, length) {
    const ctx = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_RATE);
    let at = 0;
    for (const seg of segments) {
      const start = Math.max(0, +seg.start || 0), len = Math.max(0, (+seg.end || 0) - start);
      if (seg.buffer && len > 0 && start < seg.buffer.duration) {
        const node = new AudioBufferSourceNode(ctx, { buffer: seg.buffer });
        node.connect(ctx.destination);
        node.start(at, start, len);
      }
      at += len;
    }
    return ctx.startRendering();
  }

  async function aacSupported() {
    if (!root.AudioEncoder || !root.OfflineAudioContext) return false;
    try { return !!(await AudioEncoder.isConfigSupported(AAC_CONFIG)).supported; } catch { return false; }
  }

  // AAC encoders emit "priming" samples before the real audio (2112 for macOS AudioToolbox) and
  // mp4-muxer can't write the edit list that would hide them, so the audio would lag the video
  // (~44 ms). The amount depends on the platform encoder, so measure it once: encode a tone that
  // starts at a known sample, decode it, and see where it comes out. 0 if that can't be done.
  let primingMeasured = null;
  const aacPriming = () => primingMeasured || (primingMeasured = measurePriming().catch(() => 0));

  async function measurePriming() {
    if (!root.AudioDecoder) return 0;
    const ONSET = 2048, TOTAL = 8192;
    const chunks = [];
    let config = null;
    const enc = new AudioEncoder({ output: (c, m) => { chunks.push(c); if (m && m.decoderConfig) config = m.decoderConfig; }, error: () => {} });
    enc.configure(AAC_CONFIG);
    const data = new Float32Array(TOTAL * AUDIO_CHANNELS);
    for (let i = ONSET; i < TOTAL; i++) data[i] = data[TOTAL + i] = 0.5 * Math.sin(2 * Math.PI * 1000 * (i - ONSET) / AUDIO_RATE);
    const audio = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, numberOfFrames: TOTAL, timestamp: 0, data });
    enc.encode(audio); audio.close();
    await enc.flush(); enc.close();
    if (!config) return 0;
    const pcm = [];
    const dec = new AudioDecoder({
      output: a => { const f = new Float32Array(a.numberOfFrames); a.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); a.close(); pcm.push(f); },
      error: () => {},
    });
    dec.configure(config);
    for (const c of chunks) dec.decode(c);
    await dec.flush(); dec.close();
    const all = new Float32Array(pcm.reduce((n, f) => n + f.length, 0));
    pcm.reduce((at, f) => (all.set(f, at), at + f.length), 0);
    const delay = all.findIndex(v => Math.abs(v) > 0.05) - ONSET;
    return delay > 0 && delay < TOTAL - ONSET ? delay : 0;
  }

  // ---- Export ----

  function outputSize(clip, format, maxWidth) {
    const c = normCrop(clip.crop, clip.source.width, clip.source.height);
    return sizeFor(c.w, c.h, format, maxWidth);
  }

  function sizeFor(cw, ch, format, maxWidth) {
    const s = maxWidth && cw > maxWidth ? maxWidth / cw : 1;
    let w = Math.max(1, Math.round(cw * s)), h = Math.max(1, Math.round(ch * s));
    if (format === 'mp4') { w = Math.max(2, w & ~1); h = Math.max(2, h & ~1); }
    return { w, h };
  }

  // Output frame list: every clip is sampled at the output fps from its own start.
  function planFrames(clips, fps) {
    const frames = [];
    for (const clip of clips) {
      const { source } = clip;
      const start = clamp(+clip.start || 0, 0, source.duration);
      const end = clamp(clip.end == null ? source.duration : +clip.end, start, source.duration);
      const n = Math.max(1, Math.round((end - start) * fps));
      const crop = normCrop(clip.crop, source.width, source.height);
      for (let k = 0; k < n; k++) frames.push({ source, crop, t: start + k / fps });
    }
    return frames;
  }

  // Fit (letterbox) a crop into the output; near-exact aspect matches just fill (even rounding).
  function fitRect(crop, W, H) {
    const s = Math.min(W / crop.w, H / crop.h);
    const w = crop.w * s, h = crop.h * s;
    if (W - w < 2 && H - h < 2) return { x: 0, y: 0, w: W, h: H };
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  const AVC_CODECS = ['avc1.640034', 'avc1.4d0034', 'avc1.42003e', 'avc1.640033', 'avc1.64002a', 'avc1.42002a', 'avc1.42001f'];

  async function pickEncoderConfig(w, h, fps) {
    if (!root.VideoEncoder) throw new Error('MP4 export needs VideoEncoder (WebCodecs)');
    const bitrate = clamp(Math.round(w * h * fps * 0.15), 2e6, 20e6);
    for (const codec of AVC_CODECS) {
      const config = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch { /* invalid for this size: try the next */ }
    }
    return null;
  }

  function muxerOptions(target, w, h, fps, withAudio) {
    return {
      target,
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      ...(withAudio && { audio: { codec: 'aac', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_RATE } }),
      fastStart: 'in-memory',
    };
  }

  // audio: { length, priming } (frames) or null for no audio track.
  function createMp4Writer(w, h, fps, config, audio) {
    const M = root.Mp4Muxer;
    if (!M) throw new Error('mp4-muxer is not loaded');
    const target = new M.ArrayBufferTarget();
    const muxer = new M.Muxer(muxerOptions(target, w, h, fps, !!audio));
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { failure = e; },
    });
    encoder.configure(config);
    // Priming is hidden by padding the input up to a whole AAC frame (1024 samples) and dropping
    // that many leading encoded frames; output is restamped from 0 and trimmed to `length`. The
    // first kept frame decodes without its predecessor's overlap: a ~20 ms fade-in at the start.
    const pad = audio ? (AUDIO_CHUNK - audio.priming % AUDIO_CHUNK) % AUDIO_CHUNK : 0;
    const drop = audio ? (audio.priming + pad) / AUDIO_CHUNK : 0;
    let audioOut = 0, firstMeta = null, audioIn = 0;
    const audioEncoder = audio ? new AudioEncoder({
      output: (chunk, meta) => {
        const k = audioOut++ - drop;
        if (!firstMeta && meta && meta.decoderConfig) firstMeta = meta;
        if (k < 0 || k * AUDIO_CHUNK >= audio.length) return;
        muxer.addAudioChunk(chunk, k === 0 ? firstMeta || meta : meta, Math.round(k * AUDIO_CHUNK * 1e6 / AUDIO_RATE));
      },
      error: e => { failure = e; },
    }) : null;
    if (audioEncoder) audioEncoder.configure(AAC_CONFIG);
    const encodeAudio = (data, count) => {
      const a = new AudioData({
        format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS,
        numberOfFrames: count, timestamp: Math.round(audioIn * 1e6 / AUDIO_RATE), data,
      });
      try { audioEncoder.encode(a); } finally { a.close(); }
      audioIn += count;
    };
    const keyEvery = Math.max(1, Math.round(fps * 2));
    let index = 0;
    return {
      async add(canvas) {
        if (failure) throw failure;
        const timestamp = Math.round(index * 1e6 / fps);
        const duration = Math.round((index + 1) * 1e6 / fps) - timestamp;
        const frame = new VideoFrame(canvas, { timestamp, duration });
        try { encoder.encode(frame, { keyFrame: index % keyEvery === 0 }); } finally { frame.close(); }
        index++;
        while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) await once(encoder, 'dequeue');
      },
      // Encodes `count` frames of the mixed stereo buffer starting at frame `from` (in order).
      async addAudio(buffer, from, count) {
        if (failure) throw failure;
        if (!audioIn && pad) encodeAudio(new Float32Array(pad * AUDIO_CHANNELS), pad);
        const data = new Float32Array(count * AUDIO_CHANNELS);
        for (let c = 0; c < AUDIO_CHANNELS; c++) data.set(buffer.getChannelData(c).subarray(from, from + count), c * count);
        encodeAudio(data, count);
        while (audioEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) await once(audioEncoder, 'dequeue');
      },
      async finish() {
        await encoder.flush();
        if (audioEncoder) await audioEncoder.flush();
        if (failure) throw failure;
        encoder.close();
        if (audioEncoder) audioEncoder.close();
        muxer.finalize();
        return new Uint8Array(target.buffer);
      },
      close() {
        if (encoder.state !== 'closed') encoder.close();
        if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
      },
    };
  }

  function createGifWriter(fps) {
    const G = root.gifenc;
    if (!G) throw new Error('gifenc is not loaded');
    const gif = G.GIFEncoder();
    const delay = Math.round(1000 / fps);
    return {
      delay,
      async add(canvas, ctx) {
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const palette = G.quantize(data, 256);
        gif.writeFrame(G.applyPalette(data, palette), width, height, { palette, delay });
      },
      async finish() { gif.finish(); return gif.bytes(); },
      close() {},
    };
  }

  async function exportMedia(opts) {
    // compose: { width, height, duration, renderFrame(ctx, w, h, tOut), audio? } lets the caller draw
    // every output frame itself (e.g. several clips on one canvas); the engine only encodes.
    // compose.audio: [{ buffer, start, end }] laid end to end on the output timeline (buffer null =
    // silence), MP4 only. It is padded/trimmed to the video's length. With no buffers at all, or
    // when AAC encoding is unavailable, the MP4 simply has no audio track (result.hasAudio false).
    const { clips, compose, format, drawOverlay, onProgress, signal } = opts || {};
    if (format !== 'mp4' && format !== 'gif') throw new Error(`Unknown export format: ${format}`);
    if (!compose && (!clips || !clips.length)) throw new Error('Nothing to export');
    if (compose && !(compose.duration > 0)) throw new Error('Nothing to export');
    const fps = opts.fps > 0 ? +opts.fps : format === 'mp4' ? 30 : 12;
    const maxWidth = opts.maxWidth > 0 ? opts.maxWidth : format === 'gif' ? 800 : 0;
    const checkAbort = () => { if (signal && signal.aborted) throw abortError(); };
    checkAbort();

    let { w, h } = compose ? sizeFor(compose.width, compose.height, format, maxWidth) : outputSize(clips[0], format, maxWidth);
    let config = null;
    if (format === 'mp4') {
      config = await pickEncoderConfig(w, h, fps);
      // Beyond what H.264 levels allow (e.g. 5K Retina): shrink to fit 4K, then 1080p.
      for (const [bw, bh] of [[3840, 2160], [1920, 1080]]) {
        if (config) break;
        const s = Math.min(1, bw / Math.max(w, h), bh / Math.min(w, h));
        w = Math.max(2, Math.round(w * s) & ~1); h = Math.max(2, Math.round(h * s) & ~1);
        config = await pickEncoderConfig(w, h, fps);
      }
      if (!config) throw new Error(`H.264 encoding is not supported at ${w}x${h}`);
    }

    const frames = compose ? new Array(Math.max(1, Math.round(compose.duration * fps))).fill(null) : planFrames(clips, fps);
    const segments = format === 'mp4' && compose && Array.isArray(compose.audio) ? compose.audio.filter(Boolean) : [];
    const withAudio = segments.some(s => s.buffer) && await aacSupported();
    const audio = withAudio ? { length: Math.round(frames.length / fps * AUDIO_RATE), priming: await aacPriming() } : null;
    checkAbort();
    // Mixed on the audio thread while the video frames are rendered.
    const mixing = audio ? mixAudio(segments, audio.length) : null;
    if (mixing) mixing.catch(() => {});   // only awaited if the video part succeeds
    const videoShare = withAudio ? AUDIO_PROGRESS : 0.99;
    const makeCanvas = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: format === 'gif', alpha: false });
      ctx.imageSmoothingQuality = 'high';
      return { canvas: c, ctx };
    };
    const frameBuf = makeCanvas();
    const outBuf = drawOverlay ? makeCanvas() : frameBuf;
    const writer = format === 'mp4' ? createMp4Writer(w, h, fps, config, audio) : createGifWriter(fps);

    // Resolves (never rejects) on abort so a slow seek can't hold up cancellation.
    const aborted = signal ? new Promise(r => signal.addEventListener('abort', r, { once: true })) : null;
    const race = p => aborted ? Promise.race([p, aborted.then(() => { throw abortError(); })]) : p;

    try {
      let lastYield = performance.now();
      for (let i = 0; i < frames.length; i++) {
        checkAbort();
        const f = frames[i], tOut = i / fps;
        if (compose) {
          frameBuf.ctx.fillStyle = '#000';
          frameBuf.ctx.fillRect(0, 0, w, h);
          await race(compose.renderFrame(frameBuf.ctx, w, h, tOut));
        } else {
          const r = fitRect(f.crop, w, h);
          await race(f.source._withFrame(f.t, img => {
            const { ctx } = frameBuf;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, f.crop.x, f.crop.y, f.crop.w, f.crop.h, r.x, r.y, r.w, r.h);
          }));
        }
        if (drawOverlay) {
          outBuf.ctx.drawImage(frameBuf.canvas, 0, 0);
          outBuf.ctx.save();
          drawOverlay(outBuf.ctx, w, h, frameBuf.canvas, tOut);
          outBuf.ctx.restore();
        }
        await race(writer.add(outBuf.canvas, outBuf.ctx));
        if (onProgress) onProgress((i + 1) / frames.length * videoShare);
        if (performance.now() - lastYield > YIELD_MS) { await yieldToUI(); lastYield = performance.now(); }
      }
      if (mixing) {
        const mixed = await race(mixing);
        for (let i = 0; i < mixed.length; i += AUDIO_CHUNK) {
          checkAbort();
          await race(writer.addAudio(mixed, i, Math.min(AUDIO_CHUNK, mixed.length - i)));
          if (onProgress) onProgress(videoShare + (0.99 - videoShare) * Math.min(1, (i + AUDIO_CHUNK) / mixed.length));
          if (performance.now() - lastYield > YIELD_MS) { await yieldToUI(); lastYield = performance.now(); }
        }
      }
      checkAbort();
      const bytes = await race(writer.finish());
      if (onProgress) onProgress(1);
      const duration = format === 'gif'
        ? frames.length * Math.round(writer.delay / 10) / 100   // GIF delays are whole centiseconds
        : frames.length / fps;
      return { bytes, ext: format, width: w, height: h, frames: frames.length, duration, hasAudio: withAudio };
    } finally {
      writer.close();
    }
  }

  root.MediaEditor = { openSource, drawFrame, grabFrame, decodeAudio, exportMedia };
})(window);
