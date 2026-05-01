const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, clipboard, nativeImage, dialog, shell,
  desktopCapturer, systemPreferences,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execFile } = require('child_process');

let hudWindow  = null;
let captureWin = null;
let editorWin  = null;
let tray       = null;

const SAVE_DIR = path.join(os.homedir(), 'Documents', "Jack's Quick Grab");
const ANNOTATION_DIR = path.join(SAVE_DIR, '.annotations');

function annotationPathFor(filePath) {
  const base = path.basename(filePath).replace(/\.(png|jpg|jpeg)$/i, '.json');
  return path.join(ANNOTATION_DIR, base);
}

function legacyAnnotationPathFor(filePath) {
  return filePath.replace(/\.(png|jpg|jpeg)$/i, '.json');
}

function galleryPayload(filePath) {
  const filename = path.basename(filePath);
  const img = nativeImage.createFromPath(filePath);
  const thumb = img.resize({ width: 150 });
  return { filename, filePath, thumb: thumb.toDataURL() };
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
  let icon = nativeImage.createFromPath(path.join(__dirname, 'logo.png'));
  icon = icon.resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip("Jack's Quick Grab");
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleHUD);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Jack's Quick Grab", enabled: false },
    { type: 'separator' },
    { label: 'Capture Region',      accelerator: 'CmdOrCtrl+Shift+4', click: () => triggerCapture('region') },
    { label: 'Capture Window',      accelerator: 'CmdOrCtrl+Shift+W', click: () => triggerCapture('window') },
    { label: 'Capture Full Screen', accelerator: 'CmdOrCtrl+Shift+3', click: () => triggerCapture('full') },
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
}

function toggleHUD() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.isVisible() ? hudWindow.hide() : (hudWindow.show(), hudWindow.focus());
}

// ── screencapture wrapper ─────────────────────────────────────────────────────
// Uses the macOS built-in /usr/sbin/screencapture which has system-level screen
// access and requires no TCC permission from this app.

async function runScreencapture(flags) {
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
  const size = {
    width: Math.round(primary.size.width * primary.scaleFactor),
    height: Math.round(primary.size.height * primary.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size,
  });
  const source = sources.find(s => String(s.display_id) === String(primary.id)) || sources[0];
  return source?.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null;
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

async function captureFullScreen() {
  let dataURL = await capturePrimaryScreen();
  if (!dataURL) dataURL = await runScreencapture(['-x']);
  if (!dataURL) { showHUD(); return; }
  const { filePath } = autoSave(dataURL);
  openEditor(dataURL, null, filePath);
}

async function captureActiveWindow() {
  let dataURL = await captureWindowFromPicker();
  if (!dataURL) dataURL = await runScreencapture(['-W', '-x']);
  if (!dataURL) { showHUD(); return; }
  const { filePath } = autoSave(dataURL);
  openEditor(dataURL, null, filePath);
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

  const buttons = windows.map(w => w.name || 'Untitled Window').concat('Cancel');
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Choose a window to capture',
    buttons,
    cancelId: buttons.length - 1,
  });
  if (response >= windows.length) return null;
  return windows[response].thumbnail.toDataURL();
}

async function openRegionOverlay() {
  // Take a silent full-screen grab, then show our region-selection overlay on top
  let dataURL = await capturePrimaryScreen();
  if (!dataURL) dataURL = await runScreencapture(['-x']);
  if (!dataURL) { showHUD(); return; }

  const { bounds } = screen.getPrimaryDisplay();
  captureWin = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    frame: false, transparent: false,
    alwaysOnTop: true, resizable: false, movable: false,
    skipTaskbar: true, enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'src', 'capture.html'));
  captureWin.setVisibleOnAllWorkspaces(true);
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.webContents.once('did-finish-load', () => {
    captureWin.webContents.send('screen-image', dataURL);
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

ipcMain.on('hud-capture', (_e, mode) => triggerCapture(mode));

ipcMain.on('capture-done', (_e, { imageDataURL, rect }) => {
  closeCaptureWin();
  const { filePath } = autoSave(imageDataURL);
  openEditor(imageDataURL, rect, filePath);
});

ipcMain.on('capture-cancel', () => {
  closeCaptureWin();
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
}));

ipcMain.handle('permission-status', () => ({
  screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
}));

ipcMain.on('open-screen-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
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
    [annotationPathFor(safePath), legacyAnnotationPathFor(safePath)].forEach(p => {
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
      const oldLegacy = legacyAnnotationPathFor(safePath);
      if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, newAnn);
      else if (fs.existsSync(oldLegacy)) fs.renameSync(oldLegacy, newAnn);
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

ipcMain.on('annotation-save', (_e, { filePath, anns, canvasSize }) => {
  try {
    fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
    const annPath = annotationPathFor(filePath);
    fs.writeFileSync(annPath, JSON.stringify({ anns, canvasSize }));
  } catch {}
});

ipcMain.on('ondragstart', (event, filePath) => {
  try {
    const icon = nativeImage.createFromPath(filePath).resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: filePath, icon });
  } catch {}
});

ipcMain.on('ondragstart-composite', (event, { filePath, compositeDataURL }) => {
  try {
    const tmp  = path.join(os.tmpdir(), `jqg-export-${Date.now()}.png`);
    const data = compositeDataURL.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
    const icon = nativeImage.createFromPath(tmp).resize({ width: 64, height: 64 });
    event.sender.startDrag({ file: tmp, icon });
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
  maybeShowScreenPermissionHelp();
  if (process.platform === 'darwin') app.dock.hide();
  createTray();
  createHUD();
  globalShortcut.register('CommandOrControl+Shift+4', () => triggerCapture('region'));
  globalShortcut.register('CommandOrControl+Shift+3', () => triggerCapture('full'));
  globalShortcut.register('CommandOrControl+Shift+W', () => triggerCapture('window'));
});

app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
