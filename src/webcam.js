// The camera bubble in screen recordings (📷 on the capture bar, Settings → Recording). The HUD
// opens the camera when a recording starts and draws it into every frame of the recording canvas:
// in the chosen corner, mirrored, cropped to fill a circle or rounded square, with a soft shadow
// and a thin light border.
// Classic script; exposes window.JPWebcam = { open(prefs), drawBubble(ctx, source, prefs), bubbleRect(width, height, prefs) }.
// prefs are Settings → Recording's { cameraSize, cameraCorner, cameraShape }.
(function () {
  // Bubble side as a share of the recording's shorter side; the margin keeps it off the edges.
  const SIZES = { small: 0.18, medium: 0.25, large: 0.34 };
  const MARGIN = 0.035;
  const OPEN_TIMEOUT_MS = 8000;
  const CONSTRAINTS = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false };

  // Where the bubble goes in a width × height frame: its top-left corner and side, in pixels.
  function bubbleRect(width, height, { cameraSize, cameraCorner } = {}) {
    const short = Math.min(width, height);
    const size = Math.round(short * (SIZES[cameraSize] || SIZES.medium));
    const margin = Math.round(short * MARGIN);
    const [vertical, horizontal] = String(cameraCorner || 'bottom-right').split('-');
    return {
      x: horizontal === 'left' ? margin : width - margin - size,
      y: vertical === 'top' ? margin : height - margin - size,
      size,
    };
  }

  function outline(ctx, { x, y, size }, shape) {
    ctx.beginPath();
    if (shape === 'rounded') ctx.roundRect(x, y, size, size, size * 0.22);
    else ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  }

  // source: the camera <video>, or any image source (a canvas in tests). Returns the bubble's
  // rect, or null when the source has no picture yet.
  function drawBubble(ctx, source, prefs = {}) {
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return null;
    const rect = bubbleRect(ctx.canvas.width, ctx.canvas.height, prefs);
    const { x, y, size } = rect;
    const shape = prefs.cameraShape;
    const side = Math.min(sw, sh);   // object-fit: cover, i.e. the middle square of the picture
    const border = Math.max(1.5, size * 0.012);

    // The shadow comes from a fill underneath; the picture itself would cast it on every frame.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = size * 0.08;
    ctx.shadowOffsetY = size * 0.02;
    ctx.fillStyle = '#000';
    outline(ctx, rect, shape);
    ctx.fill();
    ctx.restore();

    // Mirrored, the way people are used to seeing themselves on camera.
    ctx.save();
    outline(ctx, rect, shape);
    ctx.clip();
    ctx.translate(x + size, y);
    ctx.scale(-1, 1);
    ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, size, size);
    ctx.restore();

    // Inset, so the bubble covers exactly its rect.
    ctx.save();
    ctx.lineWidth = border;
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    outline(ctx, { x: x + border / 2, y: y + border / 2, size: size - border }, shape);
    ctx.stroke();
    ctx.restore();
    return rect;
  }

  const stopTracks = stream => stream.getTracks().forEach(t => t.stop());

  // A camera that hasn't started after a few seconds counts as failed, so the recording goes
  // ahead without it rather than never starting. One that turns up later anyway goes to onLate,
  // to be closed again (otherwise its light would stay on).
  function withTimeout(promise, onLate = () => {}) {
    let timer, expired = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('The camera didn’t start in time')); }, OPEN_TIMEOUT_MS);
    });
    promise.then(value => { if (expired) onLate(value); }, () => {});
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Opens the default camera and resolves once it shows a picture, so a recording never starts
  // with an empty corner. The camera draws with the prefs it was opened with.
  async function open(prefs = {}) {
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia(CONSTRAINTS), stopTracks);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    try {
      await withTimeout(video.play());
    } catch (err) {
      stopTracks(stream);
      throw err;
    }
    const [track] = stream.getVideoTracks();
    // Unplugged (or switched off) mid-recording: the recording carries on without the bubble.
    const live = () => track.readyState === 'live' && video.readyState >= 2;
    return {
      stream,
      prefs,
      draw: ctx => (live() ? drawBubble(ctx, video, prefs) : null),
      stop() {
        stopTracks(stream);
        video.srcObject = null;
      },
      onEnded: fn => track.addEventListener('ended', fn),
    };
  }

  window.JPWebcam = { open, drawBubble, bubbleRect };
})();
