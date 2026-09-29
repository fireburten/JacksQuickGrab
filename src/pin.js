// An image pinned to the screen (lib/quick-access.cjs makes the window: always on top, on every
// Space). Drag to move; scroll or pinch to zoom; the slider or ⌘1–⌘9 set its opacity (⌘0: opaque);
// Esc, ✕ or a double-click closes it. Main moves, zooms and fades the window.
(function () {
  const api = window.electronAPI;
  const image = document.getElementById('image');
  const slider = document.getElementById('opacity');
  const readout = document.getElementById('opacity-value');
  const zoomBadge = document.getElementById('zoom');
  let imageWidth = 0;   // px, for the zoom readout
  let move = null;      // the pointer's travel while moving the window
  let zoomTimer = null;

  function showOpacity(value) {
    const percent = Math.round(value * 100);
    slider.value = percent;
    readout.textContent = `${percent}%`;
  }

  function setOpacity(value) {
    const clamped = Math.min(1, Math.max(0.1, value));
    showOpacity(clamped);
    api?.pinOpacity(clamped);
  }

  api?.onPinData(data => {
    image.src = data.dataURL;
    imageWidth = data.width;
    showOpacity(typeof data.opacity === 'number' ? data.opacity : 1);
  });

  // Moving: main moves the window by how far the pointer has travelled since it went down.
  image.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    move = { x: e.screenX, y: e.screenY, dx: 0, dy: 0 };
    image.setPointerCapture(e.pointerId);
    document.body.classList.add('moving');
    api?.pinMove({ phase: 'start', dx: 0, dy: 0 });
  });
  image.addEventListener('pointermove', e => {
    if (!move) return;
    move.dx = e.screenX - move.x;
    move.dy = e.screenY - move.y;
    api?.pinMove({ phase: 'move', dx: move.dx, dy: move.dy });
  });
  function endMove() {
    if (!move) return;
    api?.pinMove({ phase: 'end', dx: move.dx, dy: move.dy });
    move = null;
    document.body.classList.remove('moving');
  }
  image.addEventListener('pointerup', endMove);
  image.addEventListener('pointercancel', endMove);
  image.addEventListener('dblclick', () => api?.pinClose());

  // Zoom around the pointer. A trackpad pinch arrives as a wheel event with ctrlKey.
  window.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    api?.pinZoom({ factor, x: e.clientX / innerWidth, y: e.clientY / innerHeight });
  }, { passive: false });

  // "150%": the size against 1:1, briefly, after zooming or resizing.
  window.addEventListener('resize', () => {
    if (!imageWidth) return;
    zoomBadge.textContent = `${Math.round(innerWidth * devicePixelRatio / imageWidth * 100)}%`;
    zoomBadge.classList.add('on');
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => zoomBadge.classList.remove('on'), 800);
  });

  slider.addEventListener('input', () => setOpacity(slider.value / 100));
  document.getElementById('btn-close').addEventListener('click', () => api?.pinClose());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); api?.pinClose(); return; }
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (!digit || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    setOpacity(digit[1] === '0' ? 1 : digit[1] / 10);
  });

  // The controls show while the pin has focus (just opened, or clicked).
  window.addEventListener('focus', () => document.body.classList.add('focused'));
  window.addEventListener('blur', () => document.body.classList.remove('focused'));
  if (document.hasFocus()) document.body.classList.add('focused');
})();
