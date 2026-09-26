const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, clipboard, nativeImage, dialog, shell,
  desktopCapturer, systemPreferences, ShareMenu,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const crypto = require('crypto');

let hudWindow  = null;
let captureWin = null;
let editorWin  = null;
let tray       = null;
let windowPickerWin = null;
let lastRegionRect = null;
// Display the region overlay was opened on; rects from it are relative to that display,
// so repeat-region and recording must target it rather than the primary display.
let regionDisplay = null;
let lastRegionDisplayId = null;
let recordingDisplayId = null;
// Set while the region overlay is open for a streamed capture: 'video' | 'gif' | 'scroll'.
let streamMode     = null;

const IS_MAS = !!process.mas;
// The App Store sandbox points os.homedir() at the app container, so MAS builds
// save to the real ~/Pictures (granted by the assets.pictures entitlement).
const SAVE_DIR = IS_MAS
  ? path.join(os.userInfo().homedir, 'Pictures', "Jack's Picker")
  : path.join(os.homedir(), 'Documents', "Jack's Picker");
const LEGACY_SAVE_DIR = path.join(os.homedir(), 'Documents', "Jack's Quick Grab");
const ANNOTATION_DIR = path.join(SAVE_DIR, '.annotations');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SHORTCUTS = {
  region: 'CommandOrControl+Shift+2',
  repeat: 'CommandOrControl+Alt+Shift+2',
  window: 'CommandOrControl+Alt+Shift+W',
  full: 'CommandOrControl+Shift+1',
};
// macOS owns ⌘⇧3 / ⌘⇧4 / ⌘⇧5 for its own screenshot tools.
const MACOS_RESERVED_SHORTCUTS = new Set([
  'CommandOrControl+Shift+3',
  'CommandOrControl+Shift+4',
  'CommandOrControl+Shift+5',
]);
const RECORDING_EXTS = new Set(['mp4', 'webm', 'gif']);
const HUD_WIDTH = 530;
const STREAM_MODES = { record: 'video', gif: 'gif', scroll: 'scroll' };

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
  if (process.platform === 'darwin') {
    Object.keys(shortcuts).forEach(kind => {
      if (MACOS_RESERVED_SHORTCUTS.has(shortcuts[kind])) shortcuts[kind] = DEFAULT_SHORTCUTS[kind];
    });
  }
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

const IMAGE_EXT = /\.(png|jpg|jpeg)$/i;
// GIFs and screen recordings share the captures folder; the gallery lists and plays them
// but they can't be annotated.
const MEDIA_EXT = /\.(gif|mp4|webm|mov|m4v)$/i;
const isImageFile = filePath => IMAGE_EXT.test(filePath);
const mediaKind = filePath => (/\.gif$/i.test(filePath) ? 'gif' : MEDIA_EXT.test(filePath) ? 'video' : 'image');

// Video and GIF thumbnails come from the OS (QuickLook / Windows shell): nativeImage can't
// decode either (a GIF loads as an empty image). They're slow-ish, so cache per file version.
const mediaThumbCache = new Map();
async function mediaThumb(filePath) {
  let key;
  try { key = `${filePath}:${fs.statSync(filePath).mtimeMs}`; } catch { return null; }
  if (mediaThumbCache.has(key)) return mediaThumbCache.get(key);
  let dataURL = null;
  try {
    const img = await nativeImage.createThumbnailFromPath(filePath, { width: 300, height: 300 });
    if (!img.isEmpty()) dataURL = img.resize({ width: 150 }).toDataURL();
  } catch {}   // e.g. .webm, which QuickLook can't preview; the gallery shows a placeholder
  mediaThumbCache.set(key, dataURL);
  return dataURL;
}

async function galleryPayload(filePath) {
  const filename = path.basename(filePath);
  const kind = mediaKind(filePath);
  const base = { filename, filePath, fileURL: pathToFileURL(filePath).href, kind };
  if (kind !== 'image') return { ...base, thumb: await mediaThumb(filePath), annotations: [], canvasSize: null, flatPath: null };
  const thumb = nativeImage.createFromPath(filePath).resize({ width: 150 }).toDataURL();
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
    ...base,
    thumb,
    annotations,
    canvasSize,
    flatPath: fs.existsSync(flatAnnotationPathFor(filePath)) ? flatAnnotationPathFor(filePath) : null,
  };
}

// Paths from the renderer must be inside the captures folder. Only screenshots by default;
// pass allowMedia for actions that also apply to GIFs and recordings (list, reveal, delete, rename, drag).
// allowLinked: also accept files directly inside a linked project folder. Only for reading
// (list, preview, play, drag out, edit a copy); nothing in a linked folder is renamed or deleted.
function safeCapturePath(filePath, { allowMedia = false, allowLinked = false } = {}) {
  const resolved = path.resolve(String(filePath || ''));
  const root = path.resolve(SAVE_DIR) + path.sep;
  const inCaptures = resolved.startsWith(root);
  if (!inCaptures && !(allowLinked && isInLinkedFolder(resolved))) return null;
  if (!isImageFile(resolved) && !(allowMedia && MEDIA_EXT.test(resolved))) return null;
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

// ── Project folders ───────────────────────────────────────────────────────────
// A project can be linked to a real folder. Captures added to the project are copied into it
// (annotated screenshots as their flattened image, refreshed when edited), and media already in
// the folder shows up in the project. The registry lives in settings.json:
//   projectFolders[projectId] = { path, bookmark, exported: { capture: folderFile }, imported: { capture: folderFile } }
// exported/imported record which folder files are our own copies, so they're neither listed
// twice nor ever overwritten unless we made them.
const FOLDER_LIST_LIMIT = 400;
const folderWatchers = new Map();
const folderAccess = new Map();   // MAS: security-scoped access, held while the folder is linked

function projectFolders() { return readSettings().projectFolders || {}; }
function saveProjectFolders(folders) { writeSettings({ projectFolders: folders }); }

function isInLinkedFolder(resolved) {
  const dir = path.dirname(resolved) + path.sep;
  return Object.values(projectFolders()).some(f => path.resolve(f.path) + path.sep === dir);
}

function uniqueFileIn(dir, filename) {
  const ext = path.extname(filename), base = path.basename(filename, ext);
  let name = filename;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
  return name;
}

function openFolderAccess(projectId, entry) {
  if (!IS_MAS || !entry.bookmark || folderAccess.has(projectId)) return;
  try { folderAccess.set(projectId, app.startAccessingSecurityScopedResource(entry.bookmark)); } catch {}
}

function watchProjectFolder(projectId, entry) {
  folderWatchers.get(projectId)?.close();
  let timer = null;
  try {
    folderWatchers.set(projectId, fs.watch(entry.path, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send('project-folder-changed', projectId);
      }, 400);
    }));
  } catch {}   // folder gone or unreadable; listing will report it
}

function releaseProjectFolder(projectId) {
  folderWatchers.get(projectId)?.close();
  folderWatchers.delete(projectId);
  try { folderAccess.get(projectId)?.(); } catch {}
  folderAccess.delete(projectId);
}

function startProjectFolders() {
  Object.entries(projectFolders()).forEach(([id, entry]) => { openFolderAccess(id, entry); watchProjectFolder(id, entry); });
}

ipcMain.handle('project-folders', () => Object.fromEntries(Object.entries(projectFolders()).map(([id, f]) =>
  [id, { path: f.path, name: path.basename(f.path), exists: fs.existsSync(f.path) }])));

ipcMain.handle('project-folder-link', async (_e, projectId) => {
  if (typeof projectId !== 'string' || !projectId) return null;
  const { canceled, filePaths, bookmarks } = await dialog.showOpenDialog(editorWin, {
    title: 'Link a folder to this project',
    buttonLabel: 'Link Folder',
    properties: ['openDirectory', 'createDirectory'],
    securityScopedBookmarks: IS_MAS,
  });
  if (canceled || !filePaths?.[0]) return null;
  const folders = projectFolders();
  const prev = folders[projectId];
  releaseProjectFolder(projectId);
  const samePath = prev && path.resolve(prev.path) === path.resolve(filePaths[0]);
  folders[projectId] = { path: filePaths[0], bookmark: bookmarks?.[0] || null, exported: samePath ? prev.exported : {}, imported: samePath ? prev.imported : {} };
  saveProjectFolders(folders);
  openFolderAccess(projectId, folders[projectId]);
  watchProjectFolder(projectId, folders[projectId]);
  return { path: filePaths[0], name: path.basename(filePaths[0]), exists: true };
});

ipcMain.handle('project-folder-unlink', (_e, projectId) => {
  const folders = projectFolders();
  if (!folders[projectId]) return false;
  releaseProjectFolder(projectId);
  delete folders[projectId];
  saveProjectFolders(folders);
  return true;   // the folder and its files are left exactly as they are
});

ipcMain.on('project-folder-reveal', (_e, projectId) => {
  const f = projectFolders()[projectId];
  if (f && fs.existsSync(f.path)) shell.openPath(f.path);
});

function listFolderFiles(entry) {
  const ours = new Set([...Object.values(entry.exported || {}), ...Object.values(entry.imported || {})]);
  return fs.readdirSync(entry.path)
    .filter(f => !f.startsWith('.') && !ours.has(f) && (isImageFile(f) || MEDIA_EXT.test(f)))
    .map(filename => {
      const filePath = path.join(entry.path, filename);
      const stat = fs.statSync(filePath);
      return stat.isFile() ? { filename, filePath, time: stat.birthtimeMs || stat.mtimeMs, size: stat.size } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time)
    .slice(0, FOLDER_LIST_LIMIT);
}

// Folder files as gallery items (external: true). Images get a quick nativeImage thumbnail;
// GIFs and videos go through the OS thumbnailer like captures do.
ipcMain.handle('project-folder-list', async (_e, projectId) => {
  const entry = projectFolders()[projectId];
  if (!entry || !fs.existsSync(entry.path)) return { items: [], missing: !!entry };
  try {
    const items = await Promise.all(listFolderFiles(entry).map(async f => {
      const kind = mediaKind(f.filePath);
      const thumb = kind === 'image'
        ? nativeImage.createFromPath(f.filePath).resize({ width: 150 }).toDataURL()
        : await mediaThumb(f.filePath);
      return { ...f, fileURL: pathToFileURL(f.filePath).href, kind, thumb, external: true, projectId, annotations: [], canvasSize: null, flatPath: null };
    }));
    return { items, missing: false };
  } catch { return { items: [], missing: false }; }
});

// Copies captures into the project's folder. Screenshots go as their annotated (flattened)
// image when there is one. Re-running refreshes our own copy; a user's file of the same name
// is never overwritten (we pick a new name instead).
ipcMain.handle('project-folder-export', (_e, { projectId, filePaths }) => {
  const folders = projectFolders();
  const entry = folders[projectId];
  if (!entry || !fs.existsSync(entry.path) || !Array.isArray(filePaths)) return 0;
  entry.exported ||= {};
  let copied = 0;
  for (const fp of filePaths) {
    const src = safeCapturePath(fp, { allowMedia: true });
    if (!src || !fs.existsSync(src)) continue;
    const captureName = path.basename(src);
    if (entry.imported?.[captureName]) continue;   // came from this folder: the original is already there
    const flat = isImageFile(src) ? flatAnnotationPathFor(src) : null;
    const from = flat && fs.existsSync(flat) ? flat : src;
    const destName = entry.exported[captureName] || uniqueFileIn(entry.path, captureName);
    try { fs.copyFileSync(from, path.join(entry.path, destName)); entry.exported[captureName] = destName; copied++; } catch {}
  }
  saveProjectFolders(folders);
  return copied;
});

// Opening a folder image to annotate it: copy it in as a capture (the original is untouched).
ipcMain.handle('project-folder-import', async (_e, { projectId, filePath }) => {
  const folders = projectFolders();
  const entry = folders[projectId];
  const src = safeCapturePath(filePath, { allowMedia: true, allowLinked: true });
  if (!entry || !src || path.dirname(src) !== path.resolve(entry.path)) return null;
  const captureName = uniqueFileIn(SAVE_DIR, path.basename(src));
  const dest = path.join(SAVE_DIR, captureName);
  try { fs.copyFileSync(src, dest); } catch { return null; }
  entry.imported ||= {};
  entry.imported[captureName] = path.basename(src);
  saveProjectFolders(folders);
  return { ...(await galleryPayload(dest)), time: captureTime(dest) };
});

function writeDataURLTemp(imageDataURL, ext = 'png') {
  const tmp = path.join(os.tmpdir(), `jqg-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  const data = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
  return tmp;
}

// macOS: precompiled Vision helpers in bin/ (built by scripts/build-ocr.sh).
// Windows: PowerShell script in scripts/.
function ocrHelperPath(kind) {
  const [dir, filename] = process.platform === 'win32'
    ? ['scripts', 'ocr-table.ps1']
    : ['bin', kind === 'table' ? 'ocr-table' : 'ocr'];
  if (app.isPackaged) {
    // Helpers are unpacked outside the ASAR so child processes can read them directly.
    return path.join(process.resourcesPath, 'app.asar.unpacked', dir, filename);
  }
  return path.join(__dirname, dir, filename);
}

// Share and drag-out write screenshot copies to the temp dir that nothing else removes.
// They must outlive the share/drag itself (the receiving app may read them later), so
// sweep ones older than a day on launch.
const TEMP_EXPORT_PREFIXES = ['jqg-share-', 'jqg-export-'];
const TEMP_EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupTempExports() {
  const tmp = os.tmpdir();
  const cutoff = Date.now() - TEMP_EXPORT_MAX_AGE_MS;
  try {
    fs.readdirSync(tmp)
      .filter(name => TEMP_EXPORT_PREFIXES.some(prefix => name.startsWith(prefix)))
      .forEach(name => {
        const p = path.join(tmp, name);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
        } catch {}
      });
  } catch {}
}

function migrateLegacySaveDir() {
  if (IS_MAS) return; // sandbox can't reach ~/Documents
  try {
    if (fs.existsSync(LEGACY_SAVE_DIR) && !fs.existsSync(SAVE_DIR)) {
      fs.renameSync(LEGACY_SAVE_DIR, SAVE_DIR);
    }
  } catch {}
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
  let icon = nativeImage.createFromPath(path.join(__dirname, 'picker-hud.png'));
  icon = icon.resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip("Jack's Picker");
  tray.on('click', toggleHUD);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu() {
  const settings = readSettings();
  const shortcuts = readShortcuts();
  return Menu.buildFromTemplate([
    { label: "Jack's Picker", enabled: false },
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
    // Off by default: App Review requires the user to opt in to launching at login.
    // Disabled in dev so the bare Electron binary doesn't get registered.
    { label: 'Launch at Login', type: 'checkbox', enabled: app.isPackaged, checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: "About Jack's Picker", click: showAbout },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function showAbout() {
  // No Dock icon, so bring the app forward or the panel opens behind other windows.
  if (process.platform === 'darwin') app.focus({ steal: true });
  app.showAboutPanel();
}

// ── HUD window ────────────────────────────────────────────────────────────────

function createHUD() {
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH, height: 90,
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
  hudWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const video = sources.find(s => String(s.display_id) === String(recordingDisplayId)) || sources[0];
    // System audio (HUD's 🔊 toggle): loopback captures what the Mac is playing (macOS 13+).
    callback(request.audioRequested ? { video, audio: 'loopback' } : { video });
  });
}

function toggleHUD() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.isVisible() ? hudWindow.hide() : (hudWindow.show(), hudWindow.focus());
}

// ── screencapture wrapper ─────────────────────────────────────────────────────
// Fallback to /usr/sbin/screencapture when desktopCapturer returns nothing.
// Unavailable inside the App Store sandbox, which can't launch it.

async function runScreencapture(flags) {
  if (process.platform !== 'darwin' || IS_MAS) return null;
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
      detail: "If captures show only the desktop background, allow Jack's Picker in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.",
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    }).catch(() => {});
  }
}

// Returns true when the welcome dialog was shown, so the permission help isn't stacked on top.
function showFirstRunOnboarding() {
  const settings = readSettings();
  if (settings.onboardingSeen) return false;
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
    message: "Welcome to Jack's Picker",
    detail: [
      `Use the ${isMac ? 'menu bar' : 'system tray'} icon for region, window, full-screen, delayed, and repeat-region captures.`,
      'Use the editor sidebar for history, search, pins, rename, reveal, and delete.',
      permissionNote,
    ].join('\n\n'),
  }).then(({ response }) => {
    if (isMac && response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }).catch(() => {});
  return true;
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
    streamMode = null;
    restoreEditorAfterStream();
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
    .filter(s => !/Jack's Picker/i.test(s.name))
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
  const display = screen.getAllDisplays().find(d => d.id === lastRegionDisplayId) || screen.getPrimaryDisplay();
  const dataURL = (await captureDisplayPayload(display))?.screens?.[0]?.dataURL;
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
  regionDisplay = display;
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
  if (STREAM_MODES[mode]) {
    streamMode = STREAM_MODES[mode];
    hideEditorForStream();
    triggerCapture('region');
  }
  else triggerCapture(mode);
});

ipcMain.on('hud-set-collapsed', (_e, collapsed) => {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.setResizable(true);
  hudWindow.setSize(collapsed ? 70 : HUD_WIDTH, collapsed ? 70 : 90, false);
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
  if (!RECORDING_EXTS.has(ext)) return null;
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const filename = `recording-${ts}.${ext}`;
  const filePath = path.join(SAVE_DIR, filename);
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(buffer));
  shell.showItemInFolder(filePath);
  return filePath;
});

// Live captures (record / GIF / scroll) grab the real screen. The overlay's app.focus()
// activates the whole app, which would bring the editor to the front over whatever the user
// is capturing, so it's hidden for the session and restored (without focus) afterwards.
let editorHiddenForStream = false;

function hideEditorForStream() {
  if (!editorWin || editorWin.isDestroyed() || !editorWin.isVisible()) return;
  editorWin.hide();
  editorHiddenForStream = true;
}

function restoreEditorAfterStream() {
  if (!editorHiddenForStream) return;
  editorHiddenForStream = false;
  if (editorWin && !editorWin.isDestroyed()) editorWin.showInactive();
}

function endStreamSession() {
  closeCaptureWin();
  restoreEditorAfterStream();
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.setAlwaysOnTop(true, 'floating');
  hudWindow.setContentProtection(false);
}

ipcMain.on('recording-stopped', endStreamSession);

// HUD's 🎙 toggle: macOS asks the user once; afterwards the answer comes from System Settings.
ipcMain.handle('mic-access', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
  return false;
});

ipcMain.on('open-mic-settings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  else if (process.platform === 'win32') shell.openExternal('ms-settings:privacy-microphone');
});

// Scrolling capture: the HUD stitches frames and sends back the tall image (or null if cancelled).
ipcMain.on('scroll-capture-done', (_e, imageDataURL) => {
  endStreamSession();
  if (imageDataURL) finishCapture(imageDataURL);
  else showHUD();
});

ipcMain.handle('shortcuts-get', () => ({
  defaults: DEFAULT_SHORTCUTS,
  shortcuts: readShortcuts(),
}));

ipcMain.handle('shortcuts-set', (_e, shortcuts) => {
  const cleaned = {};
  const failures = [];
  Object.keys(DEFAULT_SHORTCUTS).forEach(kind => {
    const value = String(shortcuts?.[kind] || '').trim();
    if (process.platform === 'darwin' && MACOS_RESERVED_SHORTCUTS.has(value)) {
      failures.push({ kind, accelerator: value, reason: 'reserved' });
      cleaned[kind] = DEFAULT_SHORTCUTS[kind];
      return;
    }
    cleaned[kind] = value || DEFAULT_SHORTCUTS[kind];
  });
  writeSettings({ shortcuts: cleaned });
  failures.push(...registerCaptureShortcuts());
  return { success: failures.length === 0, shortcuts: readShortcuts(), failures };
});

ipcMain.on('capture-done', (_e, { imageDataURL, rect }) => {
  if (streamMode) {
    const kind = streamMode;
    streamMode = null;
    const display = regionDisplay || screen.getPrimaryDisplay();
    recordingDisplayId = display.id;
    const sf = display.scaleFactor || 1;
    // No rect means the user picked the whole screen (Space) in the overlay.
    const logicalRect = {
      kind,
      x: rect ? Math.round(rect.x / sf) : 0, y: rect ? Math.round(rect.y / sf) : 0,
      w: rect ? Math.round(rect.w / sf) : display.bounds.width,
      h: rect ? Math.round(rect.h / sf) : display.bounds.height,
      displayW: display.bounds.width, displayH: display.bounds.height,
    };
    // Keep the overlay as the region indicator, but exclude it from the stream and let
    // clicks/scrolls through (scroll mode needs the page underneath to scroll). Raise the
    // HUD above it so its controls stay reachable.
    if (captureWin && !captureWin.isDestroyed()) {
      captureWin.setContentProtection(true);
      captureWin.setIgnoreMouseEvents(true, { forward: true });
      captureWin.webContents.send('recording-start', logicalRect);
    }
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.setAlwaysOnTop(true, 'screen-saver');
      // Keep the HUD out of the stream too: it would show up in recordings and GIFs and
      // break scroll stitching wherever it overlaps the region.
      hudWindow.setContentProtection(true);
      hudWindow.webContents.send('recording-region', logicalRect);
    }
    showHUD();
    return;
  }
  closeCaptureWin();
  if (rect) {
    lastRegionRect = rect;
    lastRegionDisplayId = regionDisplay?.id ?? null;
  }
  finishCapture(imageDataURL, rect);
});

ipcMain.on('capture-cancel', () => {
  closeCaptureWin();
  streamMode = null;
  restoreEditorAfterStream();
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

ipcMain.handle('share-image', async (event, { imageDataURL, filename }) => {
  try {
    // Own temp dir so the shared file keeps a readable name (recipients see it).
    const ext = /\.jpe?g$/i.test(filename || '') ? '.jpg' : '.png';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqg-share-'));
    const filePath = path.join(dir, safeCaptureName(filename, ext));
    const data = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    if (process.platform === 'darwin') {
      new ShareMenu({ filePaths: [filePath] }).popup({ window: BrowserWindow.fromWebContents(event.sender) });
      return { success: true, filePath, sheet: true };
    }
    clipboard.writeImage(nativeImage.createFromPath(filePath));
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch { return { success: false }; }
});

function runOCRHelper(helper, tmp) {
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, tmp]]
    : [helper, [tmp]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function runOCR(kind, imageDataURL) {
  if (process.platform !== 'darwin' && process.platform !== 'win32')
    return { success: false, error: 'OCR is only supported on macOS and Windows' };
  const helper = ocrHelperPath(kind);
  if (!fs.existsSync(helper)) return { success: false, error: 'OCR helper missing' };
  const tmp = writeDataURLTemp(imageDataURL, 'png');
  try {
    const out = await runOCRHelper(helper, tmp);
    return { success: true, items: JSON.parse(out || '[]') };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

ipcMain.handle('ocr-image', (_e, { imageDataURL }) => runOCR('text', imageDataURL));
ipcMain.handle('ocr-table-image', (_e, { imageDataURL }) => runOCR('table', imageDataURL));

ipcMain.on('editor-close', () => {
  if (editorWin && !editorWin.isDestroyed()) editorWin.close();
});

ipcMain.on('gallery-open-folder', () => shell.openPath(SAVE_DIR));
ipcMain.on('gallery-reveal', (_e, filePath) => {
  const safePath = safeCapturePath(filePath, { allowMedia: true, allowLinked: true });
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

// Newest first by creation time, not filename: renamed captures no longer sort like
// `screenshot-<timestamp>`, and birthtime survives both renames and annotation overwrites.
function captureTime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.birthtimeMs || stat.mtimeMs;
  } catch { return 0; }
}

const GALLERY_RECENT_LIMIT = 30;

// `include` lists captures the renderer always needs regardless of age (pinned or
// assigned to a project), since those live in renderer localStorage.
ipcMain.handle('gallery-list', async (_e, include = []) => {
  try {
    const all = fs.readdirSync(SAVE_DIR)
      .filter(f => isImageFile(f) || MEDIA_EXT.test(f))
      .map(filename => path.join(SAVE_DIR, filename))
      .map(filePath => ({ filePath, time: captureTime(filePath) }))
      .sort((a, b) => b.time - a.time);
    const wanted = new Set((Array.isArray(include) ? include : [])
      .map(p => safeCapturePath(p, { allowMedia: true })).filter(Boolean));
    const shown = all.filter((entry, i) => i < GALLERY_RECENT_LIMIT || wanted.has(entry.filePath));
    return Promise.all(shown.map(async ({ filePath, time }) => ({ ...(await galleryPayload(filePath)), time })));
  } catch { return []; }
});

ipcMain.handle('gallery-load', (_e, filePath) => {
  try {
    filePath = safeCapturePath(filePath);
    if (!filePath) return null;
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
    const safePath = safeCapturePath(filePath, { allowMedia: true });
    if (!safePath || !fs.existsSync(safePath)) return { success: false };
    try { await shell.trashItem(safePath); } catch { fs.unlinkSync(safePath); }
    if (MEDIA_EXT.test(safePath)) {
      try { fs.unlinkSync(videoSessionPathFor(safePath)); } catch {}
    }
    // Annotation sidecars only exist for screenshots (for media the "legacy" path is the file itself).
    if (isImageFile(safePath)) {
      [annotationPathFor(safePath), flatAnnotationPathFor(safePath), legacyAnnotationPathFor(safePath)].forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      });
    }
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('gallery-rename', async (_e, { filePath, name }) => {
  try {
    const safePath = safeCapturePath(filePath, { allowMedia: true });
    if (!safePath || !fs.existsSync(safePath)) return { success: false, reason: 'missing' };
    const ext = path.extname(safePath);
    const filename = safeCaptureName(name, ext);
    const nextPath = path.join(SAVE_DIR, filename);
    if (nextPath !== safePath && fs.existsSync(nextPath)) return { success: false, reason: 'exists' };

    if (nextPath !== safePath) fs.renameSync(safePath, nextPath);
    if (nextPath !== safePath && MEDIA_EXT.test(safePath) && fs.existsSync(videoSessionPathFor(safePath))) {
      fs.renameSync(videoSessionPathFor(safePath), videoSessionPathFor(nextPath));
    }
    // Move annotation sidecars too (screenshots only; media has none).
    if (nextPath !== safePath && isImageFile(safePath)) {
      const oldAnn = annotationPathFor(safePath);
      const newAnn = annotationPathFor(nextPath);
      const oldFlat = flatAnnotationPathFor(safePath);
      const newFlat = flatAnnotationPathFor(nextPath);
      const oldLegacy = legacyAnnotationPathFor(safePath);
      if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, newAnn);
      else if (fs.existsSync(oldLegacy)) fs.renameSync(oldLegacy, newAnn);
      if (fs.existsSync(oldFlat)) fs.renameSync(oldFlat, newFlat);
    }
    return { success: true, item: await galleryPayload(nextPath) };
  } catch { return { success: false }; }
});

// ── Media editing ─────────────────────────────────────────────────────────────

// GIF editing decodes the file in the renderer, which can't fetch file:// URLs.
const MEDIA_READ_LIMIT = 200 * 1024 * 1024;
ipcMain.handle('media-read', (_e, filePath) => {
  const safePath = safeCapturePath(filePath, { allowMedia: true, allowLinked: true });
  if (!safePath || !MEDIA_EXT.test(safePath) || !fs.existsSync(safePath)) return null;
  if (fs.statSync(safePath).size > MEDIA_READ_LIMIT) return null;
  return fs.readFileSync(safePath);
});

// Edits never overwrite the original: save next to it as "<name>-edited.<ext>" (then -2, -3…).
ipcMain.handle('save-media-edit', async (_e, { bytes, ext, sourcePath }) => {
  try {
    if (!MEDIA_EXT.test(`.${ext}`)) return { success: false };
    const source = safeCapturePath(sourcePath, { allowMedia: true, allowLinked: true });
    const base = source ? path.basename(source).replace(/\.[^.]+$/, '') : `edit-${Date.now()}`;
    let filePath = path.join(SAVE_DIR, `${base}-edited.${ext}`);
    for (let n = 2; fs.existsSync(filePath); n++) filePath = path.join(SAVE_DIR, `${base}-edited-${n}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { success: true, item: { ...(await galleryPayload(filePath)), time: captureTime(filePath) } };
  } catch { return { success: false }; }
});

// Video edit sessions (clips + trims, crop, annotations) auto-save next to the video, like
// screenshot annotations, and are restored the next time it's edited.
function videoSessionPathFor(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(path.resolve(SAVE_DIR) + path.sep)) return path.join(ANNOTATION_DIR, `${path.basename(resolved)}.video.json`);
  const key = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(ANNOTATION_DIR, `linked-${key}-${path.basename(resolved)}.video.json`);
}

const safeMediaPath = filePath => {
  const p = safeCapturePath(filePath, { allowMedia: true, allowLinked: true });
  return p && MEDIA_EXT.test(p) ? p : null;
};

ipcMain.handle('video-session-load', (_e, filePath) => {
  const safePath = safeMediaPath(filePath);
  if (!safePath) return null;
  let session;
  try { session = JSON.parse(fs.readFileSync(videoSessionPathFor(safePath), 'utf8')); } catch { return null; }
  // Clips are stored by name; resolve them in the captures folder and skip any that are gone.
  const clips = [];
  let missing = 0;
  for (const c of Array.isArray(session.clips) ? session.clips : []) {
    const p = (c?.path && safeMediaPath(c.path)) || safeMediaPath(path.join(SAVE_DIR, path.basename(String(c?.name || ''))));
    if (!p || !fs.existsSync(p)) { missing++; continue; }
    clips.push({
      item: { filename: path.basename(p), filePath: p, fileURL: pathToFileURL(p).href, kind: mediaKind(p) },
      start: +c.start || 0, end: c.end == null ? null : +c.end,
    });
  }
  return { clips, missing, W: session.W, H: session.H, crop: session.crop || null, anns: Array.isArray(session.anns) ? session.anns : [] };
});

ipcMain.handle('video-session-save', (_e, { filePath, session }) => {
  const safePath = safeMediaPath(filePath);
  if (!safePath || !session || typeof session !== 'object') return false;
  try {
    fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
    fs.writeFileSync(videoSessionPathFor(safePath), JSON.stringify(session));
    return true;
  } catch { return false; }
});

// Clip finder: every GIF/recording in the captures folder (the gallery only lists recent
// captures). Thumbnails are fetched separately, as cards scroll into view.
ipcMain.handle('media-list', () => {
  const asItem = (f, extra = {}) => ({ ...f, fileURL: pathToFileURL(f.filePath).href, kind: mediaKind(f.filePath), ...extra });
  let items = [];
  try {
    items = fs.readdirSync(SAVE_DIR)
      .filter(f => MEDIA_EXT.test(f))
      .map(filename => {
        const filePath = path.join(SAVE_DIR, filename);
        const stat = fs.statSync(filePath);
        return asItem({ filename, filePath, time: stat.birthtimeMs || stat.mtimeMs, size: stat.size });
      });
  } catch {}
  for (const [projectId, entry] of Object.entries(projectFolders())) {
    try {
      listFolderFiles(entry).filter(f => MEDIA_EXT.test(f.filename))
        .forEach(f => items.push(asItem(f, { external: true, projectId })));
    } catch {}
  }
  return items.sort((a, b) => b.time - a.time);
});

ipcMain.handle('media-thumb', (_e, filePath) => {
  const safePath = safeMediaPath(filePath);
  return safePath ? mediaThumb(safePath) : null;
});

// "Frame → screenshot": treat the grabbed frame like a fresh capture (auto-save + editor).
ipcMain.on('save-frame-capture', (_e, imageDataURL) => {
  if (typeof imageDataURL === 'string' && imageDataURL.startsWith('data:image/')) finishCapture(imageDataURL);
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
    const safePath = safeCapturePath(filePath, { allowMedia: true, allowLinked: true });
    if (!safePath) return;
    // Videos have no image to use as the drag icon, and startDrag rejects an empty one.
    let icon = nativeImage.createFromPath(safePath);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'picker-hud.png'));
    icon = icon.resize({ width: 64, height: 64 });
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

// Renderers only ever show bundled pages; block popups and navigation away from them.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', e => e.preventDefault());
});

app.whenReady().then(() => {
  migrateLegacySaveDir();
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
  migrateLegacyAnnotations();
  cleanupTempExports();
  startProjectFolders();
  if (!showFirstRunOnboarding()) maybeShowScreenPermissionHelp();
  if (process.platform === 'darwin') app.dock.hide();
  app.setAboutPanelOptions({
    applicationName: "Jack's Picker",
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Rind Works',
  });
  createTray();
  createHUD();
  registerCaptureShortcuts();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
