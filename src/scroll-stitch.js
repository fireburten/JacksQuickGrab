// Scrolling capture: stitches frames of a fixed screen region, grabbed while the user scrolls
// the page underneath (downward), into one tall image. DirectionalScrollStitcher (bottom)
// handles up/left/right by re-orienting frames so the same engine sees a downward scroll. Offsets are found on per-row
// signatures (grayscale averaged into ~64 column bins) so a 1600x1200 frame stays cheap.
// Classic script: exposes window.ScrollStitcher in the browser, module.exports in Node.
//   const s = new ScrollStitcher({ maxHeight: 20000 });
//   s.addFrame({ width, height, data }) -> { status, dy, height }
//     status: 'first' | 'appended' | 'unchanged' (no/tiny/upward move; dy = detected move)
//           | 'lost' (no confident match; next frame is compared to the last accepted one) | 'full'
//   s.result() -> { width, height, data } ; s.height
// Blank/uniform areas: only "informative" rows vouch for an offset, and any rival offset that
// fits nearly as well makes the frame 'lost', so ambiguity is skipped rather than guessed.
(function (root) {
  'use strict';

  // Best offset must beat every other candidate (and dy=0) by this factor + margin.
  const RATIO = 2, MARGIN = 1;
  const MIN_BAND = 16;   // moving band smaller than this is a cursor/animation, not a scroll
  const NEAR = 3;        // offsets this close to the best are the same match, not rivals
  const SEEDS = 4;

  class ScrollStitcher {
    constructor(opts = {}) {
      this.maxHeight = opts.maxHeight || 20000;
      this.samples = opts.samples || 64;
      this.noise = opts.noise ?? 2;             // per-bin luma diff ignored as noise
      this.maxMismatch = opts.maxMismatch ?? 5; // mean per-bin diff per informative row
      this.minStep = opts.minStep ?? 2;         // smaller moves are ignored (lossless: we compare to last accepted)
      this.minInfo = opts.minInfo ?? 10;        // informative rows needed in the overlap
      this.width = 0; this.frameH = 0;
      this.strips = []; this.contentRows = 0;
      this.contentEnd = 0;  // row in the last accepted frame where emitted content stops
      this.footer = { data: new Uint8ClampedArray(0), rows: 0 }; // last frame rows [contentEnd, H)
      this.prev = null; this.lastDy = 0; this.full = false;
    }

    get height() { return this.contentRows + this.footer.rows; }
    get length() { return this.height; }   // stitched size along the scroll direction

    addFrame(frame) {
      if (!this.prev) return this._first(frame);
      if (this.full) return this._res('full', 0);
      this._check(frame);
      const H = this.frameH, S = this.S, cur = this._analyze(frame), p = this.prev;

      // Rows identical at the same position are sticky header/footer (or blank): keep them
      // out of matching. Overestimating them is harmless; content is only taken above the footer.
      let t = 0;
      while (t < H && this._same(cur.sig, p.sig, t)) t++;
      if (t === H) return this._res('unchanged', 0);
      let b = 0;
      while (this._same(cur.sig, p.sig, H - 1 - b)) b++;
      const e = H - b, band = e - t;
      if (band < MIN_BAND) return this._res('unchanged', 0);

      const minOv = Math.max(8, Math.min(40, Math.ceil(band * 0.15)));
      const maxD = band - minOv;
      const scores = new Float64Array(2 * maxD + 1).fill(NaN); // NaN = not scored yet
      let best = Infinity, bestDy = 0;
      const tryDy = (dy, limit) => {
        const i = dy + maxD;
        if (i < 0 || i >= scores.length || !Number.isNaN(scores[i])) return;
        const s = scores[i] = this._score(cur.sig, p, t, e, dy, minOv, Math.min(limit, best * RATIO + MARGIN));
        if (s < best) { best = s; bestDy = dy; }
      };
      // A good early best tightens the early-abort bound for the full sweep, which dominates cost.
      const mm = this.maxMismatch;
      tryDy(this.lastDy, mm);
      for (const dy of this._seeds(cur, p, t, e, maxD, minOv)) tryDy(dy, mm);
      tryDy(0, mm);
      for (let dy = -maxD; dy <= maxD; dy++) tryDy(dy, mm);
      if (best > mm) return this._res('lost', 0);
      const lim = best * RATIO + MARGIN;
      // Rivals are judged against lim; if that exceeds the first pass's bound, rescore aborted ones.
      if (lim > mm) {
        for (let i = 0; i < scores.length; i++) if (scores[i] === Infinity) { scores[i] = NaN; tryDy(i - maxD, lim); }
      }
      if (bestDy < this.minStep) return this._res('unchanged', bestDy); // still, jitter, or scrolled up
      if (scores[maxD] < lim) return this._res('unchanged', 0);
      // A rival offset that fits almost as well (blank or repetitive content) means we can't tell.
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] < lim && Math.abs(i - maxD - bestDy) > NEAR) return this._res('lost', 0);
      }
      return this._accept(frame, cur, bestDy, t, e);
    }

    result() {
      const rb = this.width * 4, out = new Uint8ClampedArray(this.height * rb);
      let off = 0;
      for (const s of this.strips) { out.set(s.data.subarray(0, s.rows * rb), off); off += s.rows * rb; }
      out.set(this.footer.data.subarray(0, this.footer.rows * rb), off);
      return { width: this.width, height: this.height, data: out };
    }

    _res(status, dy) { return { status, dy, height: this.height }; }

    _check({ width, height, data }) {
      if (width !== this.width || height !== this.frameH) throw new Error(`ScrollStitcher: frame is ${width}x${height}, expected ${this.width}x${this.frameH}`);
      if (!data || data.length !== width * height * 4) throw new Error('ScrollStitcher: frame data must be width*height*4 RGBA bytes');
    }

    _first(frame) {
      const { width: W, height: H } = frame;
      if (!(W > 0 && H > 0)) throw new Error('ScrollStitcher: empty frame');
      this.width = W; this.frameH = H;
      this._check(frame);
      const S = this.S = Math.min(this.samples, W);
      const step = this.step = Math.max(1, Math.floor(W / (S * 16))); // ~16 samples per bin is plenty
      this.edges = new Int32Array(S + 1);
      this.scale = new Float64Array(S);
      for (let k = 0; k <= S; k++) this.edges[k] = Math.floor(k * W / S);
      for (let k = 0; k < S; k++) this.scale[k] = 1 / (256 * Math.ceil((this.edges[k + 1] - this.edges[k]) / step));
      const rows = Math.min(H, this.maxHeight);
      this.strips.push({ data: frame.data.slice(0, rows * W * 4), rows });
      this.contentRows = this.contentEnd = rows;
      this.full = rows < H;
      this.prev = this._analyze(frame);
      return this._res('first', 0);
    }

    // Per-row signature plus a prefix count of "informative" rows (horizontal detail or an edge
    // from the row above), so blank overlaps can't vouch for an offset.
    _analyze({ data }) {
      const { width: W, frameH: H, S, edges, scale } = this, st = this.step * 4;
      const sig = new Float32Array(H * S), info = new Int32Array(H + 1), mean = new Float32Array(H);
      for (let y = 0; y < H; y++) {
        const row = y * W * 4, o = y * S;
        let mn = 255, mx = 0, v = 0, m = 0;
        for (let k = 0; k < S; k++) {
          let sum = 0;
          for (let i = row + edges[k] * 4, end = row + edges[k + 1] * 4; i < end; i += st) {
            sum += data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29;
          }
          const g = sum * scale[k];
          sig[o + k] = g; m += g;
          if (g < mn) mn = g;
          if (g > mx) mx = g;
          if (y) v += Math.abs(g - sig[o - S + k]);
        }
        info[y + 1] = info[y] + (mx - mn > 8 || v > 2 * S ? 1 : 0);
        mean[y] = m / S;
      }
      return { sig, info, mean };
    }

    // Tolerates a couple of differing bins so a blinking cursor or clock doesn't break a sticky row.
    _same(a, b, y) {
      const S = this.S, o = y * S, noise = this.noise;
      let bad = 0;
      for (let k = 0; k < S; k++) if (Math.abs(a[o + k] - b[o + k]) > noise && ++bad > S >> 5) return false;
      return true;
    }

    // Mismatch of new row y vs previous row y+dy over the band overlap, normalized per informative
    // row. Returns Infinity when the overlap is too small/blank or the sum exceeds `limit` (early abort).
    _score(cs, p, t, e, dy, minOv, limit) {
      const S = this.S, ps = p.sig, noise = this.noise;
      const y0 = Math.max(t, t - dy), y1 = Math.min(e, e - dy);
      if (y1 - y0 < minOv) return Infinity;
      const info = p.info[y1 + dy] - p.info[y0 + dy];
      if (info < this.minInfo) return Infinity;
      const cap = limit * info * S;
      let sum = 0;
      // Interleaved row order spreads early samples over the whole overlap, so wrong offsets
      // hit detailed rows (and abort) quickly even when the overlap starts with blank space.
      for (let ph = 0; ph < 8; ph++) {
        for (let y = y0 + ph; y < y1; y += 8) {
          for (let o = y * S, q = (y + dy) * S, end = o + S; o < end; o++, q++) {
            let d = cs[o] - ps[q];
            if (d < 0) d = -d;
            if (d > noise) sum += d - noise;
          }
          if (sum > cap) return Infinity;
        }
      }
      return sum / (info * S);
    }

    // Cheap 1-D pass on row means: a few likely offsets to score first. Only affects speed.
    _seeds(cur, p, t, e, maxD, minOv) {
      const a = cur.mean, b = p.mean, top = [];
      for (let dy = -maxD; dy <= maxD; dy++) {
        const y0 = Math.max(t, t - dy), y1 = Math.min(e, e - dy);
        const info = p.info[y1 + dy] - p.info[y0 + dy];
        if (y1 - y0 < minOv || info < this.minInfo) continue;
        let s = 0;
        for (let y = y0; y < y1; y++) { const d = a[y] - b[y + dy]; s += d < 0 ? -d : d; }
        s /= info;
        if (top.length < SEEDS || s < top[top.length - 1][0]) {
          top.push([s, dy]); top.sort((x, y) => x[0] - y[0]);
          if (top.length > SEEDS) top.pop();
        }
      }
      return top.map(x => x[1]);
    }

    // Trims content that turned out to be footer, then appends rows [contentEnd - dy, e) of the
    // new frame; the new frame's rows [e, H) become the footer.
    _accept(frame, cur, dy, t, e) {
      const H = this.frameH, rb = this.width * 4, data = frame.data;
      if (this.contentEnd > e) { this._trim(this.contentEnd - e); this.contentEnd = e; }
      const pieces = [];
      let start = this.contentEnd - dy;
      // Content previously held back as "footer" (static blank rows) now scrolled into the
      // new frame's static top zone; it is only available from the old footer copy.
      if (start < t) { pieces.push({ data: this.footer.data, rows: t - start }); start = t; }
      pieces.push({ data: data.subarray(start * rb, e * rb), rows: e - start });
      let footRows = H - e, room = this.maxHeight - this.contentRows - footRows;
      const want = pieces.reduce((n, pc) => n + pc.rows, 0);
      const full = want > room;
      if (full) {
        if (room < 0) { footRows += room; room = 0; }
        for (const pc of pieces) { pc.rows = Math.min(pc.rows, room); room -= pc.rows; }
      }
      for (const pc of pieces) {
        if (pc.rows > 0) this.strips.push({ data: pc.data.slice(0, pc.rows * rb), rows: pc.rows });
        this.contentRows += pc.rows;
      }
      this.footer = { data: data.slice(e * rb, (e + footRows) * rb), rows: footRows };
      this.contentEnd = e; this.prev = cur; this.lastDy = dy; this.full = full;
      return this._res(full ? 'full' : 'appended', dy);
    }

    _trim(n) {
      this.contentRows -= n;
      while (n > 0) {
        const s = this.strips[this.strips.length - 1];
        if (s.rows <= n) { n -= s.rows; this.strips.pop(); } else { s.rows -= n; n = 0; }
      }
    }
  }

  // Swaps rows and columns (RGBA pixels move as whole 32-bit words).
  function transpose({ width, height, data }) {
    const src = data.byteOffset % 4 ? new Uint32Array(data.slice().buffer) : new Uint32Array(data.buffer, data.byteOffset, width * height);
    const out = new Uint8ClampedArray(width * height * 4);
    const dst = new Uint32Array(out.buffer);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) dst[x * height + y] = src[row + x];
    }
    return { width: height, height: width, data: out };
  }

  // Reverses row order (top-to-bottom flip).
  function flipRows({ width, height, data }) {
    const rb = width * 4, out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) out.set(data.subarray(y * rb, (y + 1) * rb), (height - 1 - y) * rb);
    return { width, height, data: out };
  }

  // Every scroll direction is the vertical "down" case after re-orienting the frame:
  // up = flipped, right = transposed, left = transposed then flipped. The engine runs
  // unchanged, so fixed sidebars/headers are handled on whichever edges they end up on.
  // `out` undoes `in` for the stitched result.
  const ORIENT = {
    down:  { in: f => f, out: f => f },
    up:    { in: flipRows, out: flipRows },
    right: { in: transpose, out: transpose },
    left:  { in: f => flipRows(transpose(f)), out: f => transpose(flipRows(f)) },
  };

  class DirectionalScrollStitcher extends ScrollStitcher {
    // opts.maxLength caps the stitched size along the scroll direction.
    constructor(direction = 'down', opts = {}) {
      if (!ORIENT[direction]) throw new Error(`unknown scroll direction: ${direction}`);
      super({ ...opts, maxHeight: opts.maxLength || opts.maxHeight });
      this.direction = direction;
    }
    addFrame(frame) { return super.addFrame(ORIENT[this.direction].in(frame)); }
    result() { return ORIENT[this.direction].out(super.result()); }
  }

  // Kept for callers that only need rightward scrolling; opts.maxWidth caps the stitched width.
  class HorizontalScrollStitcher extends DirectionalScrollStitcher {
    constructor(opts = {}) { super('right', { ...opts, maxLength: opts.maxWidth || opts.maxHeight }); }
  }

  const api = { ScrollStitcher, DirectionalScrollStitcher, HorizontalScrollStitcher };
  if (root) Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
