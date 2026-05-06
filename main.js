const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, clipboard, nativeImage, dialog, shell,
  desktopCapturer, systemPreferences,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

let hudWindow  = null;
let captureWin = null;
let editorWin  = null;
let tray       = null;
let windowPickerWin = null;
let lastRegionRect = null;
let recordingMode  = false;

const SAVE_DIR = path.join(os.homedir(), 'Documents', "Jack's Quick Grab");
const ANNOTATION_DIR = path.join(SAVE_DIR, '.annotations');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SHORTCUTS = {
  region: 'CommandOrControl+Shift+2',
  repeat: 'CommandOrControl+Shift+5',
  window: 'CommandOrControl+Shift+W',
  full: 'CommandOrControl+Shift+3',
};
const MACOS_REGION_SHORTCUT = 'CommandOrControl+Shift+4';

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

function writeSettings(next) {
  const settings = { ...readSettings(), ...next };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

function readShortcuts() {
  const shortcuts = { ...DEFAULT_SHORTCUTS, ...(readSettings().shortcuts || {}) };
  if (shortcuts.region === MACOS_REGION_SHORTCUT) shortcuts.region = DEFAULT_SHORTCUTS.region;
  return shortcuts;
}

function captureFromShortcut(kind) {
  if (kind === 'repeat') return captureLastRegion();
  return triggerCapture(kind);
}

function registerCaptureShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = readShortcuts();
  const failures = [];
  Object.entries(shortcuts).forEach(([kind, accelerator]) => {
    if (!accelerator) return;
    const ok = globalShortcut.register(accelerator, () => captureFromShortcut(kind));
    if (!ok) failures.push({ kind, accelerator });
  });
  return failures;
}

function annotationPathFor(filePath) {
  const base = path.basename(filePath).replace(/\.(png|jpg|jpeg)$/i, '.json');
  return path.join(ANNOTATION_DIR, base);
}

function flatAnnotationPathFor(filePath) {
  const base = path.basename(filePath).replace(/\.(png|jpg|jpeg)$/i, '.flat.png');
  return path.join(ANNOTATION_DIR, base);
}

function legacyAnnotationPathFor(filePath) {
  return filePath.replace(/\.(png|jpg|jpeg)$/i, '.json');
}

function galleryPayload(filePath) {
  const filename = path.basename(filePath);
  const img = nativeImage.createFromPath(filePath);
  const thumb = img.resize({ width: 150 });
  let annotations = [];
  let canvasSize = null;
  try {
    const annPath = annotationPathFor(filePath);
    const legacyAnnPath = legacyAnnotationPathFor(filePath);
    const readPath = fs.existsSync(annPath) ? annPath : legacyAnnPath;
    const saved = fs.existsSync(readPath) ? JSON.parse(fs.readFileSync(readPath, 'utf8')) : [];
    annotations = Array.isArray(saved) ? saved : (saved.anns || []);
    canvasSize = Array.isArray(saved) ? null : (saved.canvasSize || null);
  } catch {}
  return {
    filename,
    filePath,
    fileURL: pathToFileURL(filePath).href,
    thumb: thumb.toDataURL(),
    annotations,
    canvasSize,
    flatPath: fs.existsSync(flatAnnotationPathFor(filePath)) ? flatAnnotationPathFor(filePath) : null,
  };
}

function safeCapturePath(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(SAVE_DIR) + path.sep;
  if (!resolved.startsWith(root) || !/\.(png|jpg|jpeg)$/i.test(resolved)) return null;
  return resolved;
}

function safeCaptureName(name, ext) {
  const base = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[/:\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || `screenshot-${Date.now()}`) + ext.toLowerCase();
}

function writeDataURLTemp(imageDataURL, ext = 'png') {
  const tmp = path.join(os.tmpdir(), `jqg-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  const data = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
  return tmp;
}

function ocrScriptPath(filename = 'ocr.swift') {
  const bundled = path.join(app.getAppPath(), 'scripts', filename);
  const tmp = path.join(os.tmpdir(), `jqg-${filename}`);
  try {
    fs.copyFileSync(bundled, tmp);
    return tmp;
  } catch {
    return bundled;
  }
}

function migrateLegacyAnnotations() {
  try {
    fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
    fs.readdirSync(SAVE_DIR)
      .filter(f => /^screenshot-.*\.json$/i.test(f))
      .forEach(filename => {
        const oldPath = path.join(SAVE_DIR, filename);
        const newPath = path.join(ANNOTATION_DIR, filename);
        if (!fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
      });
  } catch {}
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'logo2-hud.png'));
  icon = icon.resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip("Jack's Quick Grab");
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleHUD);
}

function buildTrayMenu() {
  const settings = readSettings();
  const shortcuts = readShortcuts();
  return Menu.buildFromTemplate([
    { label: "Jack's Quick Grab", enabled: false },
    { type: 'separator' },
    { label: 'Capture Region',      accelerator: shortcuts.region, click: () => triggerCapture('region') },
    { label: 'Repeat Last Region',  accelerator: shortcuts.repeat, enabled: !!lastRegionRect, click: captureLastRegion },
    { label: 'Capture Window',      accelerator: shortcuts.window, click: () => triggerCapture('window') },
    { label: 'Capture Full Screen', accelerator: shortcuts.full, click: () => triggerCapture('full') },
    { label: 'Delayed Full Screen (5s)', click: () => delayedCapture('full', 5000) },
    { label: 'Auto-copy After Capture', type: 'checkbox', checked: !!settings.autoCopyAfterCapture, click: item => writeSettings({ autoCopyAfterCapture: item.checked }) },
    { type: 'separator' },
    { label: 'Show / Hide HUD', click: toggleHUD },
    { label: 'Open Captures Folder', click: () => shell.openPath(SAVE_DIR) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// ── HUD window ────────────────────────────────────────────────────────────────

function createHUD() {
  hudWindow = new BrowserWindow({
    width: 500, height: 90,
    x: 120, y: 80,
    frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hudWindow.loadFile(path.join(__dirname, 'src', 'hud.html'));
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.setAlwaysOnTop(true, 'floating');

  // Auto-grant display media for screen recording from the HUD
  hudWindow.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    callback({ video: sources[0] });
  });
}

function toggleHUD() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.isVisible() ? hudWindow.hide() : (hudWindow.show(), hudWindow.focus());
}

// ── screencapture wrapper ─────────────────────────────────────────────────────
// Uses the macOS built-in /usr/sbin/screencapture which has system-level screen
// access and requires no TCC permission from this app.

async function runScreencapture(flags) {
  if (process.platform !== 'darwin') return null;
  const tmpFile = path.join(os.tmpdir(), `jqg-${Date.now()}.png`);
  await new Promise(resolve => {
    execFile('/usr/sbin/screencapture', [...flags, tmpFile], () => resolve());
  });
  if (!fs.existsSync(tmpFile)) return null; // cancelled by user
  const buf = fs.readFileSync(tmpFile);
  try { fs.unlinkSync(tmpFile); } catch {}
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function capturePrimaryScreen() {
  const primary = screen.getPrimaryDisplay();
  const payload = await captureDisplayPayload(primary);
  return payload?.screens?.[0]?.dataURL || null;
}

async function captureDisplayPayload(display) {
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size,
  });
  const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  if (!source?.thumbnail || source.thumbnail.isEmpty()) return null;
  return {
    type: 'single-screen',
    bounds: display.bounds,
    screens: [{
      dataURL: source.thumbnail.toDataURL(),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    }],
  };
}

function unionDisplayBounds(displays) {
  const left = Math.min(...displays.map(d => d.bounds.x));
  const top = Math.min(...displays.map(d => d.bounds.y));
  const right = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function captureAllScreensPayload() {
  const displays = screen.getAllDisplays();
  if (displays.length === 1) {
    return captureDisplayPayload(displays[0]);
  }
  const maxW = Math.max(...displays.map(d => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map(d => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  });
  const screens = displays.map((display, index) => {
    const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[index];
    if (!source?.thumbnail || source.thumbnail.isEmpty()) return null;
    return {
      dataURL: source.thumbnail.toDataURL(),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    };
  }).filter(Boolean);
  if (!screens.length) return null;
  return {
    type: 'multi-screen',
    bounds: unionDisplayBounds(displays),
    screens,
  };
}

function maybeShowScreenPermissionHelp() {
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted' || status === 'not-determined') {
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['Open Settings', 'OK'],
      defaultId: 0,
      cancelId: 1,
      message: 'Screen Recording permission is needed',
      detail: "If captures show only the desktop background, allow Jack's Quick Grab, Electron, or your terminal app in System Settings → Privacy & Security → Screen Recording, then restart the app.",
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    }).catch(() => {});
  }
}

function showFirstRunOnboarding() {
  const settings = readSettings();
  if (settings.onboardingSeen) return;
  writeSettings({ onboardingSeen: true });
  const isMac = process.platform === 'darwin';
  const permissionNote = isMac
    ? 'Enable Screen Recording permission if captures show only the desktop background.'
    : 'If captures are blank, allow screen capture in Windows Settings → Privacy & Security → Screen capture.';
  dialog.showMessageBox({
    type: 'info',
    buttons: isMac ? ['Open Screen Settings', 'Start Using'] : ['Start Using'],
    defaultId: isMac ? 1 : 0,
    cancelId: isMac ? 1 : 0,
    message: "Welcome to Jack's Quick Grab",
    detail: [
      'Use the system tray icon for region, window, full-screen, delayed, and repeat-region captures.',
      'Use the editor sidebar for history, search, pins, rename, reveal, and delete.',
      permissionNote,
    ].join('\n\n'),
  }).then(({ response }) => {
    if (isMac && response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }).catch(() => {});
}

// ── Capture flow ──────────────────────────────────────────────────────────────

async function triggerCapture(mode) {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
  await delay(120); // let HUD fully disappear before screenshot
  try {
    if (mode === 'full')   return await captureFullScreen();
    if (mode === 'window') return await captureActiveWindow();
    return await openRegionOverlay();
  } catch {
    showHUD();
  }
}

function finishCapture(dataURL, rect = null) {
  const { filePath } = autoSave(dataURL);
  if (readSettings().autoCopyAfterCapture) {
    try { clipboard.writeImage(nativeImage.createFromDataURL(dataURL)); } catch {}
  }
  openEditor(dataURL, rect, filePath);
}

async function delayedCapture(mode, ms) {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
  await delay(ms);
  return triggerCapture(mode);
}

async function captureFullScreen() {
  let dataURL = await capturePrimaryScreen();
  if (!dataURL) dataURL = await runScreencapture(['-x']);
  if (!dataURL) { showHUD(); return; }
  finishCapture(dataURL);
}

async function captureActiveWindow() {
  let dataURL = await captureWindowFromPicker();
  if (!dataURL) dataURL = await runScreencapture(['-W', '-x']);
  if (!dataURL) { showHUD(); return; }
  finishCapture(dataURL);
}

async function captureWindowFromPicker() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 2400, height: 1600 },
    fetchWindowIcons: true,
  });
  const windows = sources
    .filter(s => s.thumbnail && !s.thumbnail.isEmpty())
    .filter(s => !/Jack's Quick Grab/i.test(s.name))
    .slice(0, 9);
  if (!windows.length) return null;

  const pickedId = await new Promise(resolve => {
    let settled = false;
    windowPickerWin = new BrowserWindow({
      width: 760, height: 620,
      show: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      resizable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const cleanup = result => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('window-pick', onPick);
      ipcMain.removeListener('window-cancel', onCancel);
      const win = windowPickerWin;
      windowPickerWin = null;
      if (win && !win.isDestroyed()) win.close();
      resolve(result);
    };
    const onPick = (_e, id) => cleanup(id);
    const onCancel = () => cleanup(null);
    ipcMain.once('window-pick', onPick);
    ipcMain.once('window-cancel', onCancel);
    windowPickerWin.on('closed', () => {
      if (windowPickerWin) cleanup(null);
    });
    windowPickerWin.loadFile(path.join(__dirname, 'src', 'window-picker.html'));
    windowPickerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    windowPickerWin.setAlwaysOnTop(true, 'screen-saver');
    windowPickerWin.webContents.once('did-finish-load', () => {
      windowPickerWin.webContents.send('window-sources', windows.map(w => ({
        id: w.id,
        name: w.name,
        thumb: w.thumbnail.toDataURL(),
      })));
      if (process.platform === 'darwin') app.focus({ steal: true });
      windowPickerWin.show();
      windowPickerWin.moveTop();
      windowPickerWin.setAlwaysOnTop(true, 'screen-saver');
      windowPickerWin.focus();
    });
  });
  const picked = windows.find(w => w.id === pickedId);
  return picked ? picked.thumbnail.toDataURL() : null;
}

async function captureLastRegion() {
  if (!lastRegionRect) return;
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
  await delay(120);
  const dataURL = await capturePrimaryScreen();
  if (!dataURL) { showHUD(); return; }
  const img = nativeImage.createFromDataURL(dataURL);
  const cropped = img.crop({
    x: Math.max(0, Math.round(lastRegionRect.x)),
    y: Math.max(0, Math.round(lastRegionRect.y)),
    width: Math.max(1, Math.round(lastRegionRect.w)),
    height: Math.max(1, Math.round(lastRegionRect.h)),
  }).toDataURL();
  finishCapture(cropped, lastRegionRect);
}

async function openRegionOverlay() {
  // Start capture first so the overlay does not appear in its own screenshot.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = display.bounds;
  const payloadPromise = captureDisplayPayload(display);
  captureWin = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    show: false,
    acceptFirstMouse: true,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, resizable: false, movable: false,
    skipTaskbar: true, enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  const showCaptureWin = () => {
    if (!captureWin || captureWin.isDestroyed()) return;
    if (process.platform === 'darwin') app.focus({ steal: true });
    captureWin.show();
    captureWin.moveTop();
    captureWin.focus();
  };
  ipcMain.once('capture-ready', showCaptureWin);
  captureWin.on('closed', () => {
    ipcMain.removeListener('capture-ready', showCaptureWin);
  });
  captureWin.loadFile(path.join(__dirname, 'src', 'capture.html'));
  captureWin.setVisibleOnAllWorkspaces(true);
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.webContents.once('did-finish-load', () => {
    showCaptureWin();
    payloadPromise.then(async payload => {
      if (!payload) {
        const dataURL = await runScreencapture(['-x']);
        if (!dataURL) { showHUD(); return; }
        const primary = screen.getPrimaryDisplay();
        payload = { type: 'single-screen', bounds: primary.bounds, screens: [{ dataURL, bounds: primary.bounds, scaleFactor: 1 }] };
      }
      if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('screen-image', payload);
    }).catch(() => showHUD());
  });
}

// ── Auto-save ─────────────────────────────────────────────────────────────────

function autoSave(imageDataURL) {
  const ts       = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const filename = `screenshot-${ts}.png`;
  const filePath = path.join(SAVE_DIR, filename);
  const data     = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  return { filename, filePath };
}

// ── Editor window ─────────────────────────────────────────────────────────────

function openEditor(imageDataURL, rect, savedFilePath) {
  const payload = { imageDataURL, rect, savedFilePath };
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.webContents.send('image-data', payload);
    editorWin.focus();
    return;
  }

  editorWin = new BrowserWindow({
    width: 1100, height: 760, minWidth: 700, minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  editorWin.loadFile(path.join(__dirname, 'src', 'editor.html'));
  editorWin.webContents.once('did-finish-load', () => {
    editorWin.webContents.send('image-data', payload);
  });
  editorWin.on('closed', () => {
    editorWin = null;
    showHUD();
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('hud-capture', (_e, mode) => {
  if (mode === 'record') { recordingMode = true; triggerCapture('region'); }
  else triggerCapture(mode);
});

ipcMain.on('hud-set-collapsed', (_e, collapsed) => {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.setResizable(true);
  hudWindow.setSize(collapsed ? 70 : 500, collapsed ? 70 : 90, false);
  hudWindow.setResizable(false);
});

ipcMain.on('hud-history', () => {
  if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return; }
  editorWin = new BrowserWindow({
    width: 1100, height: 760, minWidth: 700, minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  editorWin.loadFile(path.join(__dirname, 'src', 'editor.html'));
  editorWin.on('closed', () => { editorWin = null; showHUD(); });
});

ipcMain.handle('save-recording', async (_e, buffer, ext) => {
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const filename = `recording-${ts}.${ext}`;
  const filePath = path.join(SAVE_DIR, filename);
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(buffer));
  shell.showItemInFolder(filePath);
  return filePath;
});

ipcMain.on('recording-stopped', () => {
  closeCaptureWin();
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.setAlwaysOnTop(true, 'floating');
});

ipcMain.handle('shortcuts-get', () => ({
  defaults: DEFAULT_SHORTCUTS,
  shortcuts: readShortcuts(),
}));

ipcMain.handle('shortcuts-set', (_e, shortcuts) => {
  const cleaned = {};
  Object.keys(DEFAULT_SHORTCUTS).forEach(kind => {
    const value = String(shortcuts?.[kind] || '').trim();
    cleaned[kind] = value || DEFAULT_SHORTCUTS[kind];
  });
  writeSettings({ shortcuts: cleaned });
  const failures = registerCaptureShortcuts();
  if (tray) tray.setContextMenu(buildTrayMenu());
  return { success: failures.length === 0, shortcuts: readShortcuts(), failures };
});

ipcMain.on('capture-done', (_e, { imageDataURL, rect }) => {
  if (recordingMode) {
    recordingMode = false;
    if (rect) {
      const display = screen.getPrimaryDisplay();
      const sf = display.scaleFactor || 1;
      const logicalRect = {
        x: Math.round(rect.x / sf), y: Math.round(rect.y / sf),
        w: Math.round(rect.w / sf), h: Math.round(rect.h / sf),
        displayW: display.bounds.width, displayH: display.bounds.height,
      };
      // Keep capture overlay as a recording indicator; exclude it from the recording
      // and raise the HUD above it so the timer is visible
      if (captureWin && !captureWin.isDestroyed()) {
        captureWin.setContentProtection(true);
        captureWin.setIgnoreMouseEvents(true, { forward: true });
        captureWin.webContents.send('recording-start', logicalRect);
      }
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.setAlwaysOnTop(true, 'screen-saver');
        hudWindow.webContents.send('recording-region', logicalRect);
      }
    }
    showHUD();
    return;
  }
  closeCaptureWin();
  if (rect) lastRegionRect = rect;
  finishCapture(imageDataURL, rect);
  if (tray) tray.setContextMenu(buildTrayMenu());
});

ipcMain.on('capture-cancel', () => {
  closeCaptureWin();
  recordingMode = false;
  showHUD();
});

ipcMain.on('editor-copy', (_e, dataURL) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
});

ipcMain.handle('editor-save', async (_e, { imageDataURL, defaultName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(editorWin, {
    defaultPath: path.join(SAVE_DIR, defaultName || `screenshot-${Date.now()}.png`),
    filters: [
      { name: 'PNG Image',  extensions: ['png'] },
      { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
    ],
  });
  if (!canceled && filePath) {
    const data = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return { success: true, filePath };
  }
  return { success: false };
});

ipcMain.handle('image-overwrite', (_e, { filePath, imageDataURL }) => {
  try {
    const safePath = safeCapturePath(filePath);
    if (!safePath || !fs.existsSync(safePath)) return { success: false };
    const data = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(safePath, Buffer.from(data, 'base64'));
    return { success: true };
  } catch {
    return { success: false };
  }
});

ipcMain.handle('share-image', async (_e, { imageDataURL, filename }) => {
  try {
    const filePath = writeDataURLTemp(imageDataURL, /\.jpe?g$/i.test(filename || '') ? 'jpg' : 'png');
    clipboard.writeImage(nativeImage.createFromPath(filePath));
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch { return { success: false }; }
});

ipcMain.handle('ocr-image', async (_e, { imageDataURL }) => {
  if (process.platform !== 'darwin') return { success: false, error: 'OCR is only supported on macOS' };
  const tmp = writeDataURLTemp(imageDataURL, 'png');
  try {
    const script = ocrScriptPath();
    if (!fs.existsSync(script)) return { success: false, error: 'OCR helper missing' };
    const out = await new Promise((resolve, reject) => {
      execFile('/usr/bin/swift', [script, tmp], {
        maxBuffer: 1024 * 1024 * 8,
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'jqg-swift-cache') },
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    return { success: true, items: JSON.parse(out || '[]') };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

ipcMain.handle('ocr-table-image', async (_e, { imageDataURL }) => {
  if (process.platform !== 'darwin') return { success: false, error: 'OCR is only supported on macOS' };
  const tmp = writeDataURLTemp(imageDataURL, 'png');
  try {
    const script = ocrScriptPath('ocr-table.swift');
    if (!fs.existsSync(script)) return { success: false, error: 'OCR table helper missing' };
    const out = await new Promise((resolve, reject) => {
      execFile('/usr/bin/swift', [script, tmp], {
        maxBuffer: 1024 * 1024 * 8,
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'jqg-swift-cache') },
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    return { success: true, items: JSON.parse(out || '[]') };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

ipcMain.on('editor-close', () => {
  if (editorWin && !editorWin.isDestroyed()) editorWin.close();
});

ipcMain.on('gallery-open-folder', () => shell.openPath(SAVE_DIR));
ipcMain.on('gallery-reveal', (_e, filePath) => {
  const safePath = safeCapturePath(filePath);
  if (safePath && fs.existsSync(safePath)) shell.showItemInFolder(safePath);
});

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  execPath: process.execPath,
  buildTime: (() => {
    try { return fs.statSync(app.getAppPath()).mtime.toISOString(); }
    catch { return null; }
  })(),
}));

ipcMain.handle('permission-status', () => ({
  screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
}));

ipcMain.on('open-screen-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  } else if (process.platform === 'win32') {
    shell.openExternal('ms-settings:privacy');
  }
});

ipcMain.handle('gallery-list', () => {
  try {
    return fs.readdirSync(SAVE_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .sort()
      .reverse()
      .slice(0, 30)
      .map(filename => galleryPayload(path.join(SAVE_DIR, filename)));
  } catch { return []; }
});

ipcMain.handle('gallery-load', (_e, filePath) => {
  try {
    const dataURL = nativeImage.createFromPath(filePath).toDataURL();
    const annPath = annotationPathFor(filePath);
    const legacyAnnPath = legacyAnnotationPathFor(filePath);
    const readPath = fs.existsSync(annPath) ? annPath : legacyAnnPath;
    const saved   = fs.existsSync(readPath)
      ? JSON.parse(fs.readFileSync(readPath, 'utf8'))
      : [];
    return Array.isArray(saved)
      ? { dataURL, anns: saved }
      : { dataURL, anns: saved.anns || [], canvasSize: saved.canvasSize || null };
  } catch { return null; }
});

ipcMain.handle('gallery-delete', async (_e, filePath) => {
  try {
    const safePath = safeCapturePath(filePath);
    if (!safePath || !fs.existsSync(safePath)) return { success: false };
    try { await shell.trashItem(safePath); } catch { fs.unlinkSync(safePath); }
    [annotationPathFor(safePath), flatAnnotationPathFor(safePath), legacyAnnotationPathFor(safePath)].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('gallery-rename', (_e, { filePath, name }) => {
  try {
    const safePath = safeCapturePath(filePath);
    if (!safePath || !fs.existsSync(safePath)) return { success: false, reason: 'missing' };
    const ext = path.extname(safePath);
    const filename = safeCaptureName(name, ext);
    const nextPath = path.join(SAVE_DIR, filename);
    if (nextPath !== safePath && fs.existsSync(nextPath)) return { success: false, reason: 'exists' };

    if (nextPath !== safePath) {
      fs.renameSync(safePath, nextPath);
      const oldAnn = annotationPathFor(safePath);
      const newAnn = annotationPathFor(nextPath);
      const oldFlat = flatAnnotationPathFor(safePath);
      const newFlat = flatAnnotationPathFor(nextPath);
      const oldLegacy = legacyAnnotationPathFor(safePath);
      if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, newAnn);
      else if (fs.existsSync(oldLegacy)) fs.renameSync(oldLegacy, newAnn);
      if (fs.existsSync(oldFlat)) fs.renameSync(oldFlat, newFlat);
    }
    return { success: true, item: galleryPayload(nextPath) };
  } catch { return { success: false }; }
});

ipcMain.handle('image-load-file', (_e, filePath) => {
  try {
    if (!/\.(png|jpg|jpeg|gif|webp|bmp|tiff?)$/i.test(filePath)) return null;
    if (!fs.existsSync(filePath)) return null;
    const dataURL = nativeImage.createFromPath(filePath).toDataURL();
    return dataURL && dataURL !== 'data:image/png;base64,' ? dataURL : null;
  } catch { return null; }
});

ipcMain.handle('clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toDataURL();
  } catch { return null; }
});

function writeAnnotationBundle({ filePath, anns, canvasSize, flatDataURL }) {
  try {
    fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
    const annPath = annotationPathFor(filePath);
    fs.writeFileSync(annPath, JSON.stringify({ anns, canvasSize }));
    if (flatDataURL) {
      const flatPath = flatAnnotationPathFor(filePath);
      const data = flatDataURL.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(flatPath, Buffer.from(data, 'base64'));
    }
    return true;
  } catch { return false; }
}

ipcMain.on('annotation-save', (_e, data) => {
  writeAnnotationBundle(data);
});

ipcMain.handle('annotation-save-now', (_e, data) => {
  return { success: writeAnnotationBundle(data) };
});

ipcMain.on('ondragstart', (event, filePath) => {
  try {
    const safePath = safeCapturePath(filePath);
    if (!safePath) return;
    const icon = nativeImage.createFromPath(safePath).resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: safePath, icon });
  } catch {}
});

ipcMain.on('ondragstart-composite', (event, { filePath, compositeDataURL, filename }) => {
  try {
    const safeName = safeCaptureName(filename || path.basename(filePath || ''), '.png');
    const tmp  = path.join(os.tmpdir(), `jqg-export-${Date.now()}-${safeName}`);
    const data = compositeDataURL.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
    const icon = nativeImage.createFromPath(tmp).resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: tmp, icon });
  } catch {}
});

ipcMain.on('ondragstart-annotated', (event, filePath) => {
  try {
    const safePath = safeCapturePath(filePath);
    if (!safePath) return;
    const flatPath = flatAnnotationPathFor(safePath);
    const dragPath = fs.existsSync(flatPath) ? flatPath : safePath;
    const icon = nativeImage.createFromPath(dragPath).resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: dragPath, icon });
  } catch {}
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function closeCaptureWin() {
  if (captureWin && !captureWin.isDestroyed()) { captureWin.close(); captureWin = null; }
}

function showHUD() {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.show();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
  migrateLegacyAnnotations();
  showFirstRunOnboarding();
  maybeShowScreenPermissionHelp();
  if (process.platform === 'darwin') app.dock.hide();
  createTray();
  createHUD();
  registerCaptureShortcuts();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
