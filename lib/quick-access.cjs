// Quick access after a capture: the floating thumbnail (Settings → Capture → After a capture →
// Show a thumbnail) and images pinned to the screen. main.js creates it once and hands over the
// Electron modules and the few main-process helpers it needs.
//
// IPC (see preload.cjs). A thumbnail or pin only ever acts on its own window and file, found
// from the sender, so the pages never send a path back:
//   thumbnail-data    main → thumbnail   { preview, dismissAfterMs }
//   thumbnail-action  thumbnail → main   'copy' | 'edit' | 'pin' | 'close' | 'dismiss'
//   thumbnail-drag    thumbnail → main   drag the saved file out
//   pin-open          editor → main      { filePath } or { dataURL }  →  { success }
//   pin-data          main → pin         { dataURL, width, height, opacity }
//   pin-move, pin-zoom, pin-opacity, pin-close   pin → main
const fs = require('fs');
const path = require('path');

const THUMB_WIDTH = 216;
const THUMB_IMAGE_HEIGHT = { min: 80, max: 200 };
const THUMB_BAR_HEIGHT = 34;       // the Copy / Edit / Pin / ✕ row under the image
const THUMB_MARGIN = 16;           // from the corner of the screen
const THUMB_GAP = 10;              // between stacked thumbnails
const THUMB_STACK_MAX = 5;         // per display; the oldest go first
const THUMB_DISMISS_MS = 6000;
// A drag out of a thumbnail is carried by its window. One dismissed within this long after a drag
// began is only hidden, and closed once any drop has surely finished.
const THUMB_DRAG_GRACE_MS = 60_000;
const DRAG_ICON_WIDTH = 160;
const PIN_MIN_SIDE = 40;
const PIN_SCREEN_MARGIN = 40;      // a pin opens at 1:1 unless that's bigger than the screen minus this
const PIN_CASCADE = 24;            // each further pin opens this much lower right
const PIN_MIN_OPACITY = 0.1;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg);base64,/;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function createQuickAccess({ electron, preload, pagesDir, windowBackground, pinnableImagePath, openInEditor, logError }) {
  const { BrowserWindow, ipcMain, screen, clipboard, nativeImage } = electron;
  const thumbnails = [];     // on screen, oldest first
  const pins = new Map();    // webContents id → pin

  const webPreferences = () => ({ preload, contextIsolation: true, nodeIntegration: false });
  const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const displayById = id => screen.getAllDisplays().find(d => d.id === id) || screen.getPrimaryDisplay();

  // Above other windows on every Space, full-screen apps included. The app is already a UIElement
  // (no Dock icon), so Electron's process-type switch, which briefly hides windows, is skipped.
  function floatEverywhere(win) {
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // ── Thumbnail after a capture ──
  function thumbnailSize(image) {
    const { width, height } = image.getSize();
    const imageHeight = clamp(Math.round(THUMB_WIDTH * height / Math.max(1, width)), THUMB_IMAGE_HEIGHT.min, THUMB_IMAGE_HEIGHT.max);
    return { width: THUMB_WIDTH, height: imageHeight + THUMB_BAR_HEIGHT, imageHeight };
  }

  // The card shows the top of a tall capture (object-fit: cover), so only that part is scaled
  // down: a whole scrolling capture would make a needlessly big preview.
  function thumbnailPreview(image, size, scaleFactor) {
    const { width, height } = image.getSize();
    const aspect = size.width / size.imageHeight;
    const cropWidth = Math.max(1, Math.min(width, Math.round(height * aspect)));
    const cropHeight = Math.max(1, Math.min(height, Math.round(cropWidth / aspect)));
    const top = image.crop({ x: Math.round((width - cropWidth) / 2), y: 0, width: cropWidth, height: cropHeight });
    return top.resize({ width: Math.min(cropWidth, Math.round(size.width * (scaleFactor || 1))), quality: 'good' }).toDataURL();
  }

  function showThumbnail({ dataURL, filePath, display }) {
    const image = nativeImage.createFromDataURL(dataURL);
    if (image.isEmpty()) return null;
    display = display || cursorDisplay();
    const size = thumbnailSize(image);
    const preview = thumbnailPreview(image, size, display.scaleFactor);
    const win = new BrowserWindow({
      width: size.width, height: size.height, show: false,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: true,
      // Like macOS's own screenshot thumbnail, clicking or dragging it leaves the app you're in
      // active: a non-activating panel that never takes focus. acceptFirstMouse lets the click through.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      focusable: false, acceptFirstMouse: true,
      backgroundColor: windowBackground(),
      webPreferences: webPreferences(),
    });
    const thumb = { win, id: win.webContents.id, filePath, displayId: display.id, size, preview, draggedAt: 0, placed: false };
    floatEverywhere(win);
    // Transient: keeps it out of the next capture when captures come quickly.
    win.setContentProtection(true);
    win.webContents.on('did-finish-load', () => {   // also after a crash reload
      win.webContents.send('thumbnail-data', { preview, dismissAfterMs: THUMB_DISMISS_MS });
      if (!thumb.shown) { thumb.shown = true; win.showInactive(); }
    });
    win.on('closed', () => forgetThumbnail(thumb));
    makeRoom(thumb.displayId, size);
    thumbnails.push(thumb);
    layoutThumbnails(thumb.displayId);
    win.loadFile(path.join(pagesDir, 'thumbnail.html'));
    return win;
  }

  const stackOn = displayId => thumbnails.filter(t => t.displayId === displayId);

  // Newest in the corner, older ones above it. Once a thumbnail is on screen its moves are
  // animated (macOS).
  function layoutThumbnails(displayId) {
    const area = displayById(displayId).workArea;
    let bottom = area.y + area.height - THUMB_MARGIN;
    for (const thumb of stackOn(displayId).reverse()) {
      const { width, height } = thumb.size;
      bottom -= height;
      if (!thumb.win.isDestroyed()) thumb.win.setBounds({ x: area.x + area.width - width - THUMB_MARGIN, y: bottom, width, height }, thumb.placed);
      thumb.placed = true;
      bottom -= THUMB_GAP;
    }
  }

  // Room for one more on this display: the oldest go first.
  function makeRoom(displayId, incoming) {
    const room = displayById(displayId).workArea.height - 2 * THUMB_MARGIN;
    const stack = stackOn(displayId);
    const stackHeight = () => stack.reduce((sum, t) => sum + t.size.height + THUMB_GAP, incoming.height);
    while (stack.length && (stack.length >= THUMB_STACK_MAX || stackHeight() > room)) closeThumbnail(stack.shift());
  }

  function closeThumbnail(thumb) {
    if (!forgetThumbnail(thumb)) return;
    const { win } = thumb;
    if (win.isDestroyed()) return;
    if (Date.now() - thumb.draggedAt < THUMB_DRAG_GRACE_MS) {
      win.hide();
      setTimeout(() => { if (!win.isDestroyed()) win.close(); }, THUMB_DRAG_GRACE_MS);
    } else {
      win.close();
    }
  }

  function forgetThumbnail(thumb) {
    const index = thumbnails.indexOf(thumb);
    if (index < 0) return false;
    thumbnails.splice(index, 1);
    layoutThumbnails(thumb.displayId);
    return true;
  }

  const thumbnailFor = sender => thumbnails.find(t => t.id === sender.id) || null;

  function cursorOver(win) {
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  function copyImageFile(filePath) {
    const image = nativeImage.createFromPath(filePath);
    if (!image.isEmpty()) clipboard.writeImage(image);
  }

  const THUMBNAIL_ACTIONS = {
    copy: thumb => copyImageFile(thumb.filePath),
    edit: thumb => { closeThumbnail(thumb); openInEditor(thumb.filePath); },
    pin: thumb => { closeThumbnail(thumb); pinFile(thumb.filePath, displayById(thumb.displayId)); },
    close: thumb => closeThumbnail(thumb),
    // The page's timer. The page pauses it while hovered, but macOS doesn't send hover events to
    // an inactive app's windows, so the real cursor decides too (the page asks again later).
    dismiss: thumb => { if (!cursorOver(thumb.win)) closeThumbnail(thumb); },
  };

  ipcMain.on('thumbnail-action', (event, action) => {
    const thumb = thumbnailFor(event.sender);
    if (thumb && Object.hasOwn(THUMBNAIL_ACTIONS, action)) THUMBNAIL_ACTIONS[action](thumb);
  });

  // Drag out: the saved file itself, as if it were dragged from Finder.
  ipcMain.on('thumbnail-drag', event => {
    const thumb = thumbnailFor(event.sender);
    if (!thumb || !fs.existsSync(thumb.filePath)) return;
    try {
      thumb.draggedAt = Date.now();
      const icon = nativeImage.createFromDataURL(thumb.preview).resize({ width: DRAG_ICON_WIDTH });
      event.sender.startDrag({ file: thumb.filePath, icon });
    } catch (err) {
      logError('Thumbnail drag', err);
    }
  });

  // ── Images pinned to the screen ──
  // 1:1 (an image pixel per screen pixel) unless that's bigger than the screen; tiny images are
  // scaled up to PIN_MIN_SIDE.
  function pinSize(imageSize, display) {
    const area = display.workArea;
    const width = imageSize.width / (display.scaleFactor || 1), height = imageSize.height / (display.scaleFactor || 1);
    const grow = Math.max(1, PIN_MIN_SIDE / Math.min(width, height));
    const fit = Math.min(1, (area.width - 2 * PIN_SCREEN_MARGIN) / (width * grow), (area.height - 2 * PIN_SCREEN_MARGIN) / (height * grow));
    return { width: Math.max(1, Math.round(width * grow * fit)), height: Math.max(1, Math.round(height * grow * fit)) };
  }

  // Centred on the screen; each further pin opens a little lower right, so none hides another.
  function pinPosition(size, display) {
    const area = display.workArea;
    const step = (pins.size % 8) * PIN_CASCADE;
    return {
      x: Math.round(Math.min(area.x + (area.width - size.width) / 2 + step, area.x + area.width - size.width)),
      y: Math.round(Math.min(area.y + (area.height - size.height) / 2 + step, area.y + area.height - size.height)),
    };
  }

  function openPin({ dataURL, size }, display = cursorDisplay()) {
    const bounds = pinSize(size, display);
    Object.assign(bounds, pinPosition(bounds, display));
    const win = new BrowserWindow({
      ...bounds, show: false,
      minWidth: Math.min(bounds.width, PIN_MIN_SIDE), minHeight: Math.min(bounds.height, PIN_MIN_SIDE),
      frame: false, resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: true, acceptFirstMouse: true,
      backgroundColor: windowBackground(),
      webPreferences: webPreferences(),
    });
    const pin = { win, id: win.webContents.id, size, moveFrom: null };
    pins.set(pin.id, pin);
    win.setAspectRatio(size.width / size.height);
    floatEverywhere(win);
    win.webContents.on('did-finish-load', () => {   // also after a crash reload
      win.webContents.send('pin-data', { dataURL, width: size.width, height: size.height, opacity: win.getOpacity() });
      if (!pin.shown) { pin.shown = true; win.show(); }
    });
    win.on('closed', () => pins.delete(pin.id));
    win.loadFile(path.join(pagesDir, 'pin.html'));
    return win;
  }

  // { dataURL }: the editor's image as it looks right now. { filePath }: a capture, which main's
  // pinnableImagePath checks with safeCapturePath (and swaps for its annotated copy).
  function pinSource(source) {
    const { dataURL, filePath } = source && typeof source === 'object' ? source : {};
    if (typeof dataURL === 'string') {
      if (!IMAGE_DATA_URL.test(dataURL)) return null;
      const image = nativeImage.createFromDataURL(dataURL);
      return image.isEmpty() ? null : { dataURL, size: image.getSize() };
    }
    const file = pinnableImagePath(filePath);
    const image = file ? nativeImage.createFromPath(file) : null;
    return image && !image.isEmpty() ? { dataURL: image.toDataURL(), size: image.getSize() } : null;
  }

  function pinFile(filePath, display) {
    const image = pinSource({ filePath });
    return image ? openPin(image, display) : null;
  }

  ipcMain.handle('pin-open', (_e, source) => {
    const image = pinSource(source);
    if (!image) return { success: false };
    openPin(image);
    return { success: true };
  });

  const pinFor = sender => pins.get(sender.id) || null;

  // Moving: the page sends how far the pointer has travelled since it went down.
  ipcMain.on('pin-move', (event, move) => {
    const pin = pinFor(event.sender);
    if (!pin || !move || typeof move !== 'object') return;
    if (move.phase === 'start') { pin.moveFrom = pin.win.getPosition(); return; }
    if (!pin.moveFrom) return;
    const [x, y] = pin.moveFrom;
    pin.win.setPosition(Math.round(x + num(move.dx, 0)), Math.round(y + num(move.dy, 0)));
    if (move.phase === 'end') pin.moveFrom = null;
  });

  // Zooms around the pointer (x, y: where it is in the window, 0–1), from PIN_MIN_SIDE up to the
  // size of the screen.
  ipcMain.on('pin-zoom', (event, zoom) => {
    const pin = pinFor(event.sender);
    if (!pin || !zoom || typeof zoom !== 'object') return;
    const bounds = pin.win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const aspect = pin.size.width / pin.size.height;
    const maxWidth = Math.min(area.width, area.height * aspect);
    const minWidth = Math.min(maxWidth, aspect >= 1 ? PIN_MIN_SIDE * aspect : PIN_MIN_SIDE);
    const width = clamp(bounds.width * clamp(num(zoom.factor, 1), 0.5, 2), minWidth, maxWidth);
    const height = width / aspect;
    const ax = clamp(num(zoom.x, 0.5), 0, 1), ay = clamp(num(zoom.y, 0.5), 0, 1);
    pin.win.setBounds({
      x: Math.round(bounds.x + (bounds.width - width) * ax), y: Math.round(bounds.y + (bounds.height - height) * ay),
      width: Math.round(width), height: Math.round(height),
    });
  });

  ipcMain.on('pin-opacity', (event, value) => {
    const pin = pinFor(event.sender);
    if (pin) pin.win.setOpacity(clamp(num(value, 1), PIN_MIN_OPACITY, 1));
  });

  ipcMain.on('pin-close', event => { pinFor(event.sender)?.win.close(); });

  return { showThumbnail, openPin, thumbnails, pins };
}

module.exports = { createQuickAccess, THUMB_DISMISS_MS };
