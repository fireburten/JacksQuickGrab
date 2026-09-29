const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, clipboard, nativeImage, dialog, shell,
  desktopCapturer, systemPreferences, ShareMenu, nativeTheme,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { createSearchIndex } = require('./lib/search-index.cjs');
// Translations (src/i18n.js + src/locales): the menu-bar menu, dialogs and HUD messages.
const i18n = require('./src/i18n.js');
for (const code of Object.keys(i18n.LANGUAGES).filter(c => c !== 'en')) {
  try { i18n.add(code, require(`./src/locales/${code}.js`)); } catch {}
}
const tr = (text, vars) => i18n.t(text, vars);

// Packaged builds refuse remote debugging: another program could start the app with it and drive
// it, along with its Screen Recording and Microphone access. (--inspect and ELECTRON_RUN_AS_NODE
// are switched off by Electron fuses, see scripts/after-pack.cjs.)
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some(s => app.commandLine.hasSwitch(s))) {
  process.exit(1);
}

// ── Error log ─────────────────────────────────────────────────────────────────
// Problems go to a small local log (~/Library/Logs/Jack's Picker/main.log, inside the app's
// container in the App Store build) instead of Electron's raw error dialog. Nothing is sent
// anywhere; Settings → Storage → Diagnostic log shows it.
const LOG_MAX_BYTES = 1024 * 1024;
let lastProblemDialogAt = 0;

function logPath() {
  return path.join(app.getPath('logs'), 'main.log');
}

function logError(where, err) {
  const line = `[${new Date().toISOString()}] ${where}: ${err?.stack || err}\n`;
  console.error(line.trimEnd());
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One backup (main.log.1) keeps it small.
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, line);
  } catch {}
}

// An unexpected error in the main process: log it and say so (at most every 30 s). The
// menu-bar app keeps running.
function reportProblem(where, err) {
  logError(where, err);
  if (!app.isReady() || Date.now() - lastProblemDialogAt < 30_000) return;
  lastProblemDialogAt = Date.now();
  dialog.showMessageBox({
    type: 'error',
    message: tr("Jack's Picker ran into a problem"),
    detail: tr('The details were saved to its log. If this keeps happening, quit and reopen the app.'),
    buttons: [tr('OK'), tr('Show Log')],
    defaultId: 0,
  }).then(({ response }) => { if (response === 1) showLog(); }).catch(() => {});
}

function showLog() {
  const file = logPath();
  if (fs.existsSync(file)) { shell.showItemInFolder(file); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  shell.openPath(path.dirname(file));
}

process.on('uncaughtException', err => reportProblem('Uncaught exception', err));
process.on('unhandledRejection', reason => logError('Unhandled rejection', reason));

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
const DEFAULT_SAVE_DIR = IS_MAS
  ? path.join(os.userInfo().homedir, 'Pictures', "Jack's Picker")
  : path.join(os.homedir(), 'Documents', "Jack's Picker");
const LEGACY_SAVE_DIR = path.join(os.homedir(), 'Documents', "Jack's Quick Grab");
// The captures folder can be changed in Settings; everything reads these at call time.
let SAVE_DIR = DEFAULT_SAVE_DIR;
let ANNOTATION_DIR = path.join(SAVE_DIR, '.annotations');
function setSaveDir(dir) {
  SAVE_DIR = dir;
  ANNOTATION_DIR = path.join(dir, '.annotations');
}
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// The company logo for watermarks and guides: a PNG next to settings.json, not inside it
// (settings.json is read often).
const BRAND_LOGO_PATH = path.join(app.getPath('userData'), 'brand', 'logo.png');
const DEFAULT_SHORTCUTS = {
  region: 'CommandOrControl+Shift+2',
  repeat: 'CommandOrControl+Alt+Shift+2',
  window: 'CommandOrControl+Alt+Shift+W',
  full: 'CommandOrControl+Shift+1',
  text: 'CommandOrControl+Alt+Shift+T',   // copy the text in a region, no screenshot
};
// ⌘⇧3 / ⌘⇧4 / ⌘⇧5 are allowed too: they're macOS's screenshot keys, and macOS takes them first
// until they're turned off in System Settings (the hotkey dialog explains and links there).
const RECORDING_EXTS = new Set(['mp4', 'webm', 'gif']);
const HUD_WIDTH = 557;
const HUD_HEIGHT = 90;
const HUD_COLLAPSED = 70;
let hudCollapsed = false;
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
  return { ...DEFAULT_SHORTCUTS, ...(readSettings().shortcuts || {}) };
}

// ── App settings (the editor's Settings panel) ────────────────────────────────
// Kept in settings.json alongside hotkeys and project folders. appSettings() always returns a
// complete, validated object, so an old or hand-edited file can't break a window; changes go
// through updateSettings(), which applies them and tells every window.
const THEMES = ['system', 'dark', 'light'];
const ACCENTS = ['purple', 'blue', 'teal', 'green', 'orange', 'pink'];
const UI_SCALES = [0.9, 1, 1.1, 1.25];
const HUD_SCALES = [0.85, 1, 1.2];
const THUMB_SIZES = ['small', 'medium', 'large'];
const GIF_FPS_OPTIONS = [10, 12, 15, 20];
const GIF_WIDTH_OPTIONS = [480, 640, 800, 1200];
const WATERMARK_KINDS = ['off', 'logo', 'name'];
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const WATERMARK_SIZES = ['small', 'medium', 'large'];
const STAMP_KINDS = ['none', 'confidential', 'internal', 'draft'];
// The 📷 camera bubble in screen recordings (src/webcam.js draws it).
const CAMERA_SIZES = ['small', 'medium', 'large'];
const CAMERA_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const CAMERA_SHAPES = ['circle', 'rounded'];
const AFTER_CAPTURE_OPTIONS = ['editor', 'thumbnail'];   // what a new capture opens
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);
const clampNumber = (value, min, max, fallback) => (Number.isFinite(+value) && value !== null && value !== '' ? Math.min(max, Math.max(min, +value)) : fallback);
const plainObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function cleanPrefs(raw) {
  const a = plainObject(raw.appearance), e = plainObject(raw.editor), r = plainObject(raw.recording), b = plainObject(raw.brand);
  return {
    appearance: {
      theme: oneOf(a.theme, THEMES, 'dark'),
      accent: oneOf(a.accent, ACCENTS, 'purple'),
      highContrast: !!a.highContrast,
      uiScale: oneOf(a.uiScale, UI_SCALES, 1),
      hudScale: oneOf(a.hudScale, HUD_SCALES, 1),
      thumbSize: oneOf(a.thumbSize, THUMB_SIZES, 'large'),
      language: oneOf(a.language, ['system', ...Object.keys(i18n.LANGUAGES)], 'system'),
    },
    editor: {
      color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color.toUpperCase() : '#6C4EF6',
      stroke: clampNumber(e.stroke, 1, 150, 15),
      // 0 = automatic (the editor's default scales text with the stroke width)
      textSize: e.textSize === 0 || e.textSize == null ? 0 : clampNumber(e.textSize, 8, 220, 0),
    },
    recording: {
      systemAudio: !!r.systemAudio,
      mic: !!r.mic,
      gifFps: oneOf(r.gifFps, GIF_FPS_OPTIONS, 12),
      gifWidth: oneOf(r.gifWidth, GIF_WIDTH_OPTIONS, 800),
      camera: !!r.camera,
      cameraSize: oneOf(r.cameraSize, CAMERA_SIZES, 'medium'),
      cameraCorner: oneOf(r.cameraCorner, CAMERA_CORNERS, 'bottom-right'),
      cameraShape: oneOf(r.cameraShape, CAMERA_SHAPES, 'circle'),
    },
    // Company branding: the name heads exported guides; the logo (or name) can watermark captures.
    brand: {
      name: typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '',
      logo: Number.isFinite(b.logo) && b.logo > 0 ? b.logo : 0,   // when the logo file was saved; 0 = none
      watermark: oneOf(b.watermark, WATERMARK_KINDS, 'off'),
      watermarkCorner: oneOf(b.watermarkCorner, CORNERS, 'br'),
      watermarkSize: oneOf(b.watermarkSize, WATERMARK_SIZES, 'medium'),
      watermarkOpacity: clampNumber(b.watermarkOpacity, 0.2, 1, 0.6),
      autoWatermark: !!b.autoWatermark,
      stamp: oneOf(b.stamp, STAMP_KINDS, 'none'),
      palette: (Array.isArray(b.palette) ? b.palette : [])
        .filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toUpperCase()).slice(0, 8),
      usePalette: !!b.usePalette,
    },
    autoCopyAfterCapture: !!raw.autoCopyAfterCapture,
    searchText: raw.searchText !== false,   // index the text in screenshots for search
    checkSensitive: !!raw.checkSensitive,   // look for emails, card numbers, keys… before sharing
    afterCapture: oneOf(raw.afterCapture, AFTER_CAPTURE_OPTIONS, 'editor'),
  };
}

// ── Managed settings (IT) ──
// An organization can fix some settings with a configuration profile (MDM) for the app's domain,
// com.rindworks.jackspicker (keys and an example profile: README → Managed settings). macOS
// includes managed values in the app's user defaults. Read as strings, which also tells "not
// set" apart from false (a boolean reads as "1" or "0").
const MANAGED_KEYS = {
  CapturesFolder: 'string', CompanyName: 'string', Stamp: 'string',
  CheckSensitiveInfo: 'bool', DisableTextSearch: 'bool', DisableSharing: 'bool', AutoCopyAfterCapture: 'bool',
  DisableMicrophone: 'bool', DisableSystemAudio: 'bool', DisableCamera: 'bool',
};

// Read on every call: user defaults are an in-memory lookup, and a profile can change any time.
function managedPolicy() {
  if (process.platform !== 'darwin' || typeof systemPreferences.getUserDefault !== 'function') return {};
  const policy = {};
  for (const [key, kind] of Object.entries(MANAGED_KEYS)) {
    let raw = '';
    try { raw = systemPreferences.getUserDefault(key, 'string'); } catch {}
    if (raw == null || raw === '') continue;
    policy[key] = kind === 'bool' ? /^(1|true|yes)$/i.test(String(raw)) : String(raw).trim();
  }
  return policy;
}

// Overrides the user's choices with the organization's; `managed` tells the UI which to lock.
function applyPolicy(settings, policy = managedPolicy()) {
  const managed = {};
  const force = (key, apply) => { apply(); managed[key] = true; };
  if ('CheckSensitiveInfo' in policy) force('checkSensitive', () => { settings.checkSensitive = policy.CheckSensitiveInfo; });
  if ('DisableTextSearch' in policy) force('searchText', () => { settings.searchText = !policy.DisableTextSearch; });
  if ('AutoCopyAfterCapture' in policy) force('autoCopyAfterCapture', () => { settings.autoCopyAfterCapture = policy.AutoCopyAfterCapture; });
  if (policy.DisableMicrophone) force('mic', () => { settings.recording.mic = false; });
  if (policy.DisableSystemAudio) force('systemAudio', () => { settings.recording.systemAudio = false; });
  if (policy.DisableCamera) force('camera', () => { settings.recording.camera = false; });
  if (policy.CompanyName) force('companyName', () => { settings.brand.name = policy.CompanyName.slice(0, 80); });
  if (STAMP_KINDS.includes(policy.Stamp)) force('stamp', () => { settings.brand.stamp = policy.Stamp; });
  if (policy.DisableSharing) managed.sharing = true;
  if (managedCapturesFolder()) managed.capturesFolder = true;
  settings.managed = managed;
  // Stamps, watermarks and the check before sharing are applied in the editor, so while any is
  // on, captures open there rather than as a thumbnail (the choice returns when they're off).
  const b = settings.brand;
  settings.thumbnailUnavailable = !!(settings.checkSensitive || b.stamp !== 'none' || (b.autoWatermark && b.watermark !== 'off'));
  if (settings.thumbnailUnavailable) settings.afterCapture = 'editor';
  return settings;
}

// The folder IT set, if it can be used: ~ expanded, and in the App Store build only inside
// Pictures (the sandbox can't write elsewhere without the user choosing the folder).
function managedCapturesFolder() {
  const raw = managedPolicy().CapturesFolder;
  if (!raw) return null;
  // The real home: inside the App Store sandbox os.homedir() is the app's container.
  const home = IS_MAS ? os.userInfo().homedir : os.homedir();
  const dir = path.resolve(raw.replace(/^~(?=$|\/)/, home));
  if (IS_MAS && !dir.startsWith(path.join(home, 'Pictures') + path.sep)) return null;
  return dir;
}

function appSettings() {
  const prefs = cleanPrefs(readSettings());
  if (prefs.brand.logo && !fs.existsSync(BRAND_LOGO_PATH)) prefs.brand.logo = 0;
  return applyPolicy({
    ...prefs,
    launchAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    launchAtLoginAvailable: app.isPackaged,   // a dev build would register the bare Electron binary
    capturesFolder: { path: SAVE_DIR, isDefault: SAVE_DIR === DEFAULT_SAVE_DIR, defaultPath: DEFAULT_SAVE_DIR },
    sharing: sharingState(),   // "Send to…" destinations, credentials masked (see Send to… below)
  });
}

function broadcastSettings(settings = appSettings()) {
  BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('settings-changed', settings); });
  return settings;
}

function updateSettings(patch = {}) {
  patch = plainObject(patch);
  const raw = readSettings();
  writeSettings(cleanPrefs({
    ...raw,
    appearance: { ...plainObject(raw.appearance), ...plainObject(patch.appearance) },
    editor: { ...plainObject(raw.editor), ...plainObject(patch.editor) },
    recording: { ...plainObject(raw.recording), ...plainObject(patch.recording) },
    brand: { ...plainObject(raw.brand), ...plainObject(patch.brand) },
    autoCopyAfterCapture: 'autoCopyAfterCapture' in patch ? patch.autoCopyAfterCapture : raw.autoCopyAfterCapture,
    searchText: 'searchText' in patch ? patch.searchText : raw.searchText,
    checkSensitive: 'checkSensitive' in patch ? patch.checkSensitive : raw.checkSensitive,
    afterCapture: 'afterCapture' in patch ? patch.afterCapture : raw.afterCapture,
  }));
  if ('launchAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
  const settings = appSettings();
  applyAppearance(settings);
  if ('searchText' in patch) {
    searchIndex.setEnabled(settings.searchText);
    searchIndex.schedule(500);
  }
  return broadcastSettings(settings);
}

// Native pieces (dialogs, menus, scrollbars, colour pickers) follow the app's theme; the
// editor and HUD scale with their own window zoom (file:// pages zoom independently).
function applyAppearance({ appearance }) {
  nativeTheme.themeSource = appearance.theme;
  i18n.setLanguage(appearance.language, app.getLocale());
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.webContents.setZoomFactor(appearance.uiScale);
    editorWin.setBackgroundColor(windowBackground());
  }
  sizeHUD();
}

// Shown before a window's page paints (matches --bg-app in theme.css), so it doesn't flash white.
function windowBackground() {
  const { theme } = appSettings().appearance;
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#221f32' : '#f0eff5';
}

ipcMain.handle('settings-get', () => appSettings());

// ── Brand logo ── (the file lives at BRAND_LOGO_PATH)
const BRAND_LOGO_MAX = 1024;

ipcMain.handle('brand-logo-choose', async e => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: tr('Choose your logo'),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'heic', 'webp'] }],
  });
  if (canceled || !filePaths?.[0]) return null;
  let img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) return { error: 'That file isn’t an image Jack’s Picker can read.' };
  const { width, height } = img.getSize();
  const scale = Math.min(1, BRAND_LOGO_MAX / Math.max(width, height));
  if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' });
  fs.mkdirSync(path.dirname(BRAND_LOGO_PATH), { recursive: true });
  fs.writeFileSync(BRAND_LOGO_PATH, img.toPNG());
  return updateSettings({ brand: { logo: Date.now() } });
});

ipcMain.handle('brand-logo-get', () => {
  try { return `data:image/png;base64,${fs.readFileSync(BRAND_LOGO_PATH).toString('base64')}`; }
  catch { return null; }
});

ipcMain.handle('brand-logo-remove', () => {
  try { fs.unlinkSync(BRAND_LOGO_PATH); } catch {}
  return updateSettings({ brand: { logo: 0 } });
});
ipcMain.handle('settings-set', (_e, patch) => updateSettings(patch));
ipcMain.on('settings-open', () => openSettings());

// `section` must stay a plain string: whatever is passed here is sent to the editor, and
// an object that can't be serialized (e.g. a MenuItem) is dropped without an error.
function openSettings(section = null) {
  if (typeof section !== 'string') section = null;
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.show();
    editorWin.focus();
    editorWin.webContents.send('open-settings', section);
    return;
  }
  createEditorWindow();
  editorWin.webContents.once('did-finish-load', () => editorWin.webContents.send('open-settings', section));
}

// ── Captures folder ──
// Changing it can move the existing captures (and their .annotations sidecars) along; a
// capture whose name is already taken in the new folder stays where it is. The App Store
// build keeps access to a chosen folder with a security-scoped bookmark.
let saveDirAccessStop = null;
let pendingSaveDir = null;

function restoreCapturesFolder() {
  const managedDir = managedCapturesFolder();
  if (managedDir) {
    try { fs.mkdirSync(managedDir, { recursive: true }); setSaveDir(managedDir); return; }
    catch (err) { logError('Managed captures folder', err); }
  }
  const { saveDir, saveDirBookmark } = readSettings();
  if (!saveDir) return;
  if (IS_MAS && saveDirBookmark) {
    try { saveDirAccessStop = app.startAccessingSecurityScopedResource(saveDirBookmark); } catch {}
  }
  // A folder on an unplugged drive: use the default until it's back (the setting is kept).
  if (fs.existsSync(saveDir)) setSaveDir(saveDir);
}

const isCaptureFile = f => !f.startsWith('.') && (isImageFile(f) || MEDIA_EXT.test(f));

function sidecarNamesFor(name) {
  const ext = path.extname(name);
  return [name.slice(0, -ext.length) + '.json', name.slice(0, -ext.length) + '.flat.png', `${name}.video.json`];
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;   // different volume: copy, then remove the original
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function moveCaptures(fromDir, toDir) {
  const fromAnn = path.join(fromDir, '.annotations'), toAnn = path.join(toDir, '.annotations');
  fs.mkdirSync(toAnn, { recursive: true });
  const moved = [], skipped = [];
  for (const name of fs.readdirSync(fromDir).filter(isCaptureFile)) {
    if (fs.existsSync(path.join(toDir, name))) { skipped.push(name); continue; }
    try {
      moveFile(path.join(fromDir, name), path.join(toDir, name));
      moved.push({ from: path.join(fromDir, name), to: path.join(toDir, name) });
      for (const side of sidecarNamesFor(name)) {
        if (fs.existsSync(path.join(fromAnn, side)) && !fs.existsSync(path.join(toAnn, side))) moveFile(path.join(fromAnn, side), path.join(toAnn, side));
      }
    } catch { skipped.push(name); }
  }
  // Sessions for linked-folder videos aren't tied to a capture; they travel with the rest.
  try {
    fs.readdirSync(fromAnn).filter(f => f.startsWith('linked-') && !fs.existsSync(path.join(toAnn, f)))
      .forEach(f => moveFile(path.join(fromAnn, f), path.join(toAnn, f)));
  } catch {}
  return { moved, skipped };
}

ipcMain.handle('captures-folder-choose', async () => {
  if (managedCapturesFolder()) return { error: 'managed' };
  const { canceled, filePaths, bookmarks } = await dialog.showOpenDialog(editorWin, {
    title: tr('Choose where captures are saved'),
    buttonLabel: tr('Use This Folder'),
    properties: ['openDirectory', 'createDirectory'],
    securityScopedBookmarks: IS_MAS,
  });
  if (canceled || !filePaths?.[0]) return null;
  const dir = path.resolve(filePaths[0]);
  if (dir === path.resolve(SAVE_DIR)) return null;
  if (dir.startsWith(path.resolve(SAVE_DIR) + path.sep)) return { error: 'inside' };
  pendingSaveDir = { dir, bookmark: bookmarks?.[0] || null };
  let count = 0;
  try { count = fs.readdirSync(SAVE_DIR).filter(isCaptureFile).length; } catch {}
  return { path: dir, count };
});

// target: 'pending' (the folder just chosen) or 'default'; move: bring existing captures along.
ipcMain.handle('captures-folder-apply', (_e, { target, move }) => {
  if (managedCapturesFolder()) return { error: 'Your organization sets the captures folder.' };
  const next = target === 'default' ? { dir: DEFAULT_SAVE_DIR, bookmark: null } : pendingSaveDir;
  pendingSaveDir = null;
  if (!next) return null;
  const oldDir = SAVE_DIR;
  try {
    fs.mkdirSync(next.dir, { recursive: true });
    const result = move ? moveCaptures(oldDir, next.dir) : { moved: [], skipped: [] };
    try { saveDirAccessStop?.(); } catch {}
    saveDirAccessStop = null;
    if (IS_MAS && next.bookmark) {
      try { saveDirAccessStop = app.startAccessingSecurityScopedResource(next.bookmark); } catch {}
    }
    setSaveDir(next.dir);
    fs.mkdirSync(ANNOTATION_DIR, { recursive: true });
    const isDefault = path.resolve(next.dir) === path.resolve(DEFAULT_SAVE_DIR);
    writeSettings({ saveDir: isDefault ? null : next.dir, saveDirBookmark: isDefault ? null : next.bookmark });
    broadcastSettings();
    return { oldDir, newDir: SAVE_DIR, moved: result.moved, skipped: result.skipped };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('captures-folder-reveal', () => shell.openPath(SAVE_DIR));
ipcMain.handle('captures-folder-count', () => {
  try { return fs.readdirSync(SAVE_DIR).filter(isCaptureFile).length; } catch { return 0; }
});

function captureFromShortcut(kind) {
  if (kind === 'repeat') return captureLastRegion();
  if (kind === 'text') return captureText();
  return triggerCapture(kind);
}

// ── Copy text from the screen ──
// Pick a region as for a screenshot; its text goes on the clipboard and nothing is saved.
let textCaptureMode = false;

function captureText() {
  textCaptureMode = true;
  return triggerCapture('region');
}

async function copyTextFromImage(dataURL, ocr = runOCR) {
  showHUD();
  const r = await ocr('text', dataURL);
  const text = r?.success ? ocrItemsToText(r.items || []).trim() : '';
  if (!text) {
    flashHUD(r?.success ? tr('No text found there') : tr('Text recognition isn’t available'));
    return '';
  }
  clipboard.writeText(text);
  const lines = text.split('\n').length;
  flashHUD(lines === 1 ? tr('Copied 1 line of text') : tr('Copied {n} lines of text', { n: lines }));
  return text;
}

function flashHUD(text) {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send('hud-flash', text);
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
    title: tr('Link a folder to this project'),
    buttonLabel: tr('Link Folder'),
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
  if (IS_MAS || SAVE_DIR !== DEFAULT_SAVE_DIR) return; // sandbox can't reach ~/Documents; custom folder: nothing to migrate
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
  const settings = appSettings();   // effective values (an organization may manage some)
  const shortcuts = readShortcuts();
  return Menu.buildFromTemplate([
    { label: tr("Jack's Picker"), enabled: false },
    { type: 'separator' },
    { label: tr('Capture Region'),      accelerator: shortcuts.region, click: () => triggerCapture('region') },
    { label: tr('Repeat Last Region'),  accelerator: shortcuts.repeat, enabled: !!lastRegionRect, click: captureLastRegion },
    { label: tr('Capture Window'),      accelerator: shortcuts.window, click: () => triggerCapture('window') },
    { label: tr('Capture Full Screen'), accelerator: shortcuts.full, click: () => triggerCapture('full') },
    { label: tr('Copy Text from Screen'), accelerator: shortcuts.text, click: () => captureText() },
    { label: tr('Delayed Full Screen (5s)'), click: () => delayedCapture('full', 5000) },
    { label: tr('Auto-copy After Capture'), type: 'checkbox', checked: !!settings.autoCopyAfterCapture, enabled: !settings.managed.autoCopyAfterCapture, click: item => updateSettings({ autoCopyAfterCapture: item.checked }) },
    { type: 'separator' },
    { label: tr('Show / Hide HUD'), click: toggleHUD },
    { label: tr('Open Captures Folder'), click: () => shell.openPath(SAVE_DIR) },
    { type: 'separator' },
    // Off by default: App Review requires the user to opt in to launching at login.
    // Disabled in dev so the bare Electron binary doesn't get registered.
    { label: tr('Launch at Login'), type: 'checkbox', enabled: app.isPackaged, checked: app.getLoginItemSettings().openAtLogin, click: item => updateSettings({ launchAtLogin: item.checked }) },
    { label: tr('Settings…'), click: () => openSettings() },
    { label: tr("About Jack's Picker"), click: showAbout },
    { type: 'separator' },
    { label: tr('Quit'), click: () => app.quit() },
  ]);
}

function showAbout() {
  // No Dock icon, so bring the app forward or the panel opens behind other windows.
  if (process.platform === 'darwin') app.focus({ steal: true });
  app.showAboutPanel();
}

// ── HUD window ────────────────────────────────────────────────────────────────

function createHUD() {
  const { hudScale } = appSettings().appearance;
  hudWindow = new BrowserWindow({
    width: Math.round(HUD_WIDTH * hudScale), height: Math.round(HUD_HEIGHT * hudScale),
    x: 120, y: 80,
    frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: hudScale,
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
      buttons: [tr('Open Settings'), tr('OK')],
      defaultId: 0,
      cancelId: 1,
      message: tr('Screen Recording permission is needed'),
      detail: tr("If captures show only the desktop background, allow Jack's Picker in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app."),
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
    ? tr('Enable Screen Recording permission if captures show only the desktop background.')
    : tr('If captures are blank, allow screen capture in Windows Settings → Privacy & Security → Screen capture.');
  dialog.showMessageBox({
    type: 'info',
    buttons: isMac ? [tr('Open Screen Settings'), tr('Start Using')] : [tr('Start Using')],
    defaultId: isMac ? 1 : 0,
    cancelId: isMac ? 1 : 0,
    message: tr("Welcome to Jack's Picker"),
    detail: [
      isMac ? tr('Use the menu bar icon for region, window, full-screen, delayed, and repeat-region captures.')
        : tr('Use the system tray icon for region, window, full-screen, delayed, and repeat-region captures.'),
      tr('Use the editor sidebar for history, search, pins, rename, reveal, and delete.'),
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

// display: the one the capture came from, where a thumbnail appears (default: the cursor's).
function finishCapture(dataURL, rect = null, display = null) {
  const { filePath } = autoSave(dataURL);
  // The check before sharing can't vet a raw capture, so auto-copy waits while it's on.
  const prefs = appSettings();
  if (prefs.autoCopyAfterCapture && !prefs.checkSensitive) {
    try { clipboard.writeImage(nativeImage.createFromDataURL(dataURL)); } catch {}
  }
  if (prefs.afterCapture === 'thumbnail') return showCaptureThumbnail(dataURL, filePath, display);
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
  finishCapture(dataURL, null, screen.getPrimaryDisplay());
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
      backgroundColor: windowBackground(),
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
  finishCapture(cropped, lastRegionRect, display);
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
  // Two captures within a second (easy with thumbnails) get -2, -3… rather than overwriting.
  const filename = uniqueFileIn(SAVE_DIR, `screenshot-${ts}.png`);
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

  createEditorWindow();
  editorWin.webContents.once('did-finish-load', () => {
    editorWin.webContents.send('image-data', payload);
  });
}

function createEditorWindow() {
  editorWin = new BrowserWindow({
    width: 1100, height: 760, minWidth: 700, minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
      zoomFactor: appSettings().appearance.uiScale,
    },
  });
  editorWin.loadFile(path.join(__dirname, 'src', 'editor.html'));
  editorWin.on('closed', () => {
    editorWin = null;
    showHUD();
  });
  return editorWin;
}

// ── Quick access: thumbnail after a capture, Pin to Screen ────────────────────
// The windows and their IPC live in lib/quick-access.cjs. Main decides when a thumbnail appears
// and which files may be pinned.
const { createQuickAccess } = require('./lib/quick-access.cjs');

const quickAccess = createQuickAccess({
  electron: { BrowserWindow, ipcMain, screen, clipboard, nativeImage },
  preload: path.join(__dirname, 'preload.cjs'),
  pagesDir: path.join(__dirname, 'src'),
  windowBackground,
  pinnableImagePath,
  openInEditor: openCaptureInEditor,
  logError,
});

// Settings → Capture → After a capture → Show a thumbnail. The capture is already saved (and
// copied, with auto-copy on). With no editor coming up, the HUD returns without taking focus, and
// an open editor's Recents is told about the new capture.
function showCaptureThumbnail(dataURL, filePath, display) {
  try {
    quickAccess.showThumbnail({ dataURL, filePath, display });
  } catch (err) {
    logError('Capture thumbnail', err);
    openEditor(dataURL, null, filePath);
    return;
  }
  if (hudWindow && !hudWindow.isDestroyed() && !hudWindow.isVisible()) hudWindow.showInactive();
  if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send('captures-changed');
}

// The thumbnail's Edit (or a click on it): the capture opens as it would have straight after capture.
function openCaptureInEditor(filePath) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return false;
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (editorWin && !editorWin.isDestroyed()) editorWin.show();
  openEditor(image.toDataURL(), null, filePath);
  return true;
}

// A capture is pinned as Recents shows it: annotated, when it has annotations. An image in a
// linked project folder is pinned as it is.
function pinnableImagePath(filePath) {
  const capture = safeCapturePath(filePath);
  if (!capture) return safeCapturePath(filePath, { allowLinked: true });
  const flat = flatAnnotationPathFor(capture);
  return fs.existsSync(flat) ? flat : capture;
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
  hudCollapsed = !!collapsed;
  sizeHUD();
});

// The HUD's content is scaled with the window's zoom, so its size scales too.
function sizeHUD() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const { hudScale } = appSettings().appearance;
  hudWindow.webContents.setZoomFactor(hudScale);
  hudWindow.setResizable(true);
  hudWindow.setSize(
    Math.round((hudCollapsed ? HUD_COLLAPSED : HUD_WIDTH) * hudScale),
    Math.round((hudCollapsed ? HUD_COLLAPSED : HUD_HEIGHT) * hudScale), false);
  hudWindow.setResizable(false);
}

ipcMain.on('hud-history', () => {
  if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return; }
  createEditorWindow();
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

// The Keyboard Shortcuts window, where macOS's own screenshot shortcuts (⌘⇧3/4/5) can be turned
// off. It opens on whichever section was used last: macOS has no link to its Screenshots section,
// so the hotkey dialog tells people to pick it.
ipcMain.on('open-keyboard-settings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.keyboard?Shortcuts');
});

ipcMain.on('open-mic-settings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  else if (process.platform === 'win32') shell.openExternal('ms-settings:privacy-microphone');
});

// ── Camera bubble (📷) ────────────────────────────────────────────────────────
// The HUD's 📷 toggle and Settings → Recording ask here when the camera is switched on, like the
// microphone: macOS asks the user once; afterwards the answer comes from System Settings.
ipcMain.handle('camera-access', async () => {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('camera');
    if (status === 'granted') return true;
    if (status === 'not-determined') return await systemPreferences.askForMediaAccess('camera');
  } catch (err) {
    logError('Camera access', err);
  }
  return false;
});

ipcMain.on('open-camera-settings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
  else if (process.platform === 'win32') shell.openExternal('ms-settings:privacy-webcam');
});

// Scrolling capture: the HUD stitches frames and sends back the tall image (or null if cancelled).
ipcMain.on('scroll-capture-done', (_e, imageDataURL) => {
  endStreamSession();
  if (imageDataURL) finishCapture(imageDataURL, null, regionDisplay);
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
  if (textCaptureMode) {
    textCaptureMode = false;
    copyTextFromImage(imageDataURL);
    return;
  }
  if (rect) {
    lastRegionRect = rect;
    lastRegionDisplayId = regionDisplay?.id ?? null;
  }
  finishCapture(imageDataURL, rect, regionDisplay);
});

function cancelCapture() {
  closeCaptureWin();
  streamMode = null;
  textCaptureMode = false;
  restoreEditorAfterStream();
  showHUD();
}

ipcMain.on('capture-cancel', () => cancelCapture());

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

// ── Send to… (team sharing) ───────────────────────────────────────────────────
// Opt-in destinations (S3-compatible storage, Slack, Jira, Linear, Teams, GitHub) set up in
// Settings → Sharing; lib/sharing does the work. Nothing goes over the network until a
// destination is saved and then tested or used. Credentials are encrypted with safeStorage (a
// Keychain key) before they're written to settings.json, and pages only ever get masked values.
const { net, safeStorage } = require('electron');
const { createSharing, SharingError } = require('./lib/sharing/index.cjs');

const sharing = createSharing({
  read: () => readSettings().sharing,
  write: value => writeSettings({ sharing: value }),
  safeStorage,
  fetch: (url, init) => net.fetch(url, init),   // Chromium's stack: the Mac's proxy settings and certificates
  isOnline: () => net.isOnline(),
  logError,
});

// The one switch for sharing: every sharing entry point checks it, and pages hide the Sharing
// settings and "Send to…" menus when it's off. IT can turn it off with a configuration profile
// for com.rindworks.jackspicker that sets SharingDisabled to true.
// IT can turn Send to… off with a configuration profile (DisableSharing, see managedPolicy).
function sharingAllowed() {
  return !managedPolicy().DisableSharing;
}

// Part of appSettings(), so pages learn about changes with every settings broadcast.
function sharingState() {
  return sharingAllowed() ? { allowed: true, destinations: sharing.list() } : { allowed: false, destinations: [] };
}

// Every sharing request from a page: the switch first, then { ok: false, error } instead of a throw.
async function sharingCall(work) {
  if (!sharingAllowed()) return { ok: false, error: 'Sharing is turned off on this Mac.' };
  try {
    return { ok: true, ...(await work()) };
  } catch (err) {
    if (err instanceof SharingError) return { ok: false, error: err.message, field: err.field, url: err.url };
    logError('Sharing', err);
    return { ok: false, error: 'Something went wrong. The details are in the diagnostic log.' };
  }
}

// The annotated image when there is one (.annotations/<name>.flat.png), else the capture itself.
function captureForSharing(filePath) {
  const safePath = safeCapturePath(filePath);
  if (!safePath || !fs.existsSync(safePath)) throw new SharingError('Only screenshots in the captures folder can be sent.');
  const flat = flatAnnotationPathFor(safePath);
  const source = fs.existsSync(flat) ? flat : safePath;
  const png = source === flat || /\.png$/i.test(safePath);
  return {
    bytes: fs.readFileSync(source),
    filename: path.basename(safePath).replace(IMAGE_EXT, png ? '.png' : '.jpg'),
    contentType: png ? 'image/png' : 'image/jpeg',
  };
}

ipcMain.handle('sharing-save', (_e, draft) => sharingCall(() => {
  const destination = sharing.save(draft);
  broadcastSettings();
  return { destination };
}));

ipcMain.handle('sharing-remove', (_e, id) => sharingCall(() => {
  sharing.remove(id);
  broadcastSettings();
  return {};
}));

ipcMain.handle('sharing-test', (_e, draft) => sharingCall(() => sharing.test(draft)));

ipcMain.handle('sharing-send', (event, request) => sharingCall(async () => {
  const { id, filePath, title, description, message, jobId } = plainObject(request);
  const progress = text => { if (!event.sender.isDestroyed()) event.sender.send('sharing-progress', { jobId, text }); };
  const result = await sharing.send(id, captureForSharing(filePath), { title, description, message }, progress);
  if (result.copy) clipboard.writeText(result.url);
  return { url: result.url, label: result.label, copied: !!result.copy, expires: result.expires || null };
}));

// "Open" / "Copy Link" on a result toast; only links a send produced in this session.
ipcMain.on('sharing-link', (_e, request) => {
  const { url, action } = plainObject(request);
  if (!sharingAllowed() || !sharing.isResultLink(url)) return;
  if (action === 'copy') clipboard.writeText(url);
  else shell.openExternal(url);
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

// ── Search index ──
// The text in every screenshot, for the gallery search (see lib/search-index.cjs).
const searchIndex = createSearchIndex({
  file: path.join(app.getPath('userData'), 'search-index.json'),
  listImages: () => {
    let names = [];
    try { names = fs.readdirSync(SAVE_DIR).filter(isImageFile); } catch {}
    return names
      .map(name => ({ name, path: path.join(SAVE_DIR, name) }))
      .map(img => ({ ...img, time: captureTime(img.path) }))
      .sort((a, b) => b.time - a.time);
  },
  // The annotated copy when there is one, so text typed in annotations is findable too.
  sourceFor: filePath => {
    const flat = flatAnnotationPathFor(filePath);
    return fs.existsSync(flat) ? flat : filePath;
  },
  readText: ocrTextOfFile,
  logError,
});

// The helper reads a temp copy: inside the App Store sandbox it can't always reach a captures
// folder the user chose (the app's access to it isn't passed on to child processes).
async function ocrTextOfFile(src) {
  const helper = ocrHelperPath('text');
  if (!fs.existsSync(helper)) return '';
  const tmp = path.join(os.tmpdir(), `jqg-index-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(src) || '.png'}`);
  fs.copyFileSync(src, tmp);
  try { return ocrItemsToText(JSON.parse(await runOCRHelper(helper, tmp) || '[]')); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// macOS returns lines; the Windows helper returns words tagged with their line (obsId).
function ocrItemsToText(items) {
  if (!items.some(i => i.obsId !== undefined)) return items.map(i => i.text).join('\n');
  const lines = new Map();
  items.forEach(i => lines.set(i.obsId, [...(lines.get(i.obsId) || []), i.text]));
  return [...lines.values()].map(words => words.join(' ')).join('\n');
}

const SEARCH_RESULT_LIMIT = 60;
// Every capture whose name or text matches, newest first (not just the gallery's recent ones).
ipcMain.handle('gallery-search', async (_e, query) => {
  let names = [];
  try { names = fs.readdirSync(SAVE_DIR).filter(f => isImageFile(f) || MEDIA_EXT.test(f)); } catch {}
  const hits = searchIndex.search(String(query || ''), names)
    .map(hit => ({ ...hit, filePath: path.join(SAVE_DIR, hit.name) }))
    .map(hit => ({ ...hit, time: captureTime(hit.filePath) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, SEARCH_RESULT_LIMIT);
  const items = await Promise.all(hits.map(async hit => ({ ...(await galleryPayload(hit.filePath)), time: hit.time, snippet: hit.snippet })));
  return { items, ...searchIndex.status() };
});

ipcMain.handle('search-status', () => searchIndex.status());

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
  searchIndex.schedule(3000);   // the gallery reloads after captures, renames, deletes and moves
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
    // Only ever to the Trash: if that fails the capture stays where it is.
    try { await shell.trashItem(safePath); }
    catch (err) { logError('Move to Trash', err); return { success: false, reason: 'trash' }; }
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
    const byPath = c?.path ? safeMediaPath(c.path) : null;   // linked-folder clips; stale after a folder move
    const p = byPath && fs.existsSync(byPath) ? byPath : safeMediaPath(path.join(SAVE_DIR, path.basename(String(c?.name || ''))));
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
  searchIndex.schedule(4000);   // the annotated copy changed; wait for edits to settle
});

ipcMain.handle('annotation-save-now', (_e, data) => {
  const success = writeAnnotationBundle(data);
  searchIndex.schedule(4000);
  return { success };
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

// ── Create Guide ──────────────────────────────────────────────────────────────
// Screenshots selected in Recents become a step-by-step guide: a PDF, or a folder with
// index.html (or guide.md) and the images. lib/guide.cjs builds the pages and writes the files;
// this part checks the paths the editor sends, picks each step's image and asks where to save.
// GIFs and recordings are left out: a guide is made of still screenshots.
const guide = require('./lib/guide.cjs');

// A step shows the annotated copy (.annotations/<name>.flat.png) when there is one. Images in a
// linked project folder have no annotations here, so they're used as they are.
function guideImageFor(imagePath) {
  const capture = safeCapturePath(imagePath);
  const flat = capture ? flatAnnotationPathFor(capture) : null;
  return flat && fs.existsSync(flat) ? flat : imagePath;
}

// Brand presets (a separate feature) plug in here: return { name, logoPath } and the guide's
// header shows that logo and name (see guideHeader in lib/guide.cjs).
// Settings → Brand: the company name and logo head each guide.
function guideBrand() {
  const { name, logo } = appSettings().brand;
  const logoPath = logo && fs.existsSync(BRAND_LOGO_PATH) ? BRAND_LOGO_PATH : null;
  return name || logoPath ? { name, logoPath } : null;
}

// Screenshots from the captures folder or a linked project folder, and a count of what was left out.
function guideScreenshots(filePaths) {
  const images = [];
  const skipped = { media: 0, missing: 0 };
  for (const fp of (Array.isArray(filePaths) ? filePaths : []).slice(0, guide.MAX_STEPS)) {
    const image = safeCapturePath(fp, { allowLinked: true });
    if (image && fs.existsSync(image)) images.push(image);
    else if (!image && safeCapturePath(fp, { allowMedia: true, allowLinked: true })) skipped.media++;
    else skipped.missing++;
  }
  return { images, skipped };
}

function guideThumb(imagePath) {
  try {
    const img = nativeImage.createFromPath(imagePath);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const scale = Math.min(1, 240 / width, 160 / height);
    return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL();
  } catch { return null; }
}

// The dialog's starting point: the steps it can use (with the image each one will show) and
// the format and numbering used last time.
ipcMain.handle('guide-prepare', (_e, filePaths) => {
  const { images, skipped } = guideScreenshots(filePaths);
  return {
    steps: images.map(filePath => {
      const image = guideImageFor(filePath);
      return { filePath, name: path.basename(filePath).replace(/\.[^.]+$/, ''), thumb: guideThumb(image), annotated: image !== filePath };
    }),
    skipped,
    prefs: guide.cleanGuidePrefs(readSettings().guide),
  };
});

// request: { title, format: 'pdf'|'html'|'md', numbered, steps: [{ filePath, caption }] }
ipcMain.handle('guide-export', async (event, request) => {
  const req = guide.cleanGuideRequest(request);
  if (!req) return { success: false, error: 'There’s nothing to put in the guide.' };
  const steps = [];
  for (const step of req.steps) {
    const image = safeCapturePath(step.filePath, { allowLinked: true });
    if (image && fs.existsSync(image)) steps.push({ caption: step.caption, imagePath: guideImageFor(image) });
  }
  if (!steps.length) return { success: false, error: 'Those screenshots can’t be found.' };
  const pdf = req.format === 'pdf';
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || editorWin, {
    title: tr('Save Guide'),
    defaultPath: guide.guideFileName(req.title) + (pdf ? '.pdf' : ''),
    filters: pdf ? [{ name: 'PDF Document', extensions: ['pdf'] }] : [],
    ...(pdf ? {} : { message: tr('The guide is saved as a folder with {file} and the images.', { file: req.format === 'md' ? 'guide.md' : 'index.html' }) }),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    const out = await guide.writeGuide({
      ...req, steps, outPath: filePath, brand: guideBrand(),
      date: new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }),
      pageSize: guide.pageSizeFor(app.getLocaleCountryCode?.()),
      BrowserWindow, trashItem: p => shell.trashItem(p),
    });
    writeSettings({ guide: { format: req.format, numbered: req.numbered } });
    shell.showItemInFolder(out.reveal);
    return { success: true, path: out.path, count: steps.length, skipped: req.steps.length - steps.length };
  } catch (err) {
    logError('Create guide', err);
    return { success: false, error: err.message };
  }
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
  // Page errors, including uncaught exceptions, go to the log too.
  contents.on('console-message', details => {
    if (details.level !== 'error') return;
    logError(`Page ${pageName(contents)}`, `${details.message} (${path.basename(details.sourceId || '')}:${details.lineNumber})`);
  });
});

// A page that crashed (e.g. out of memory on a long video) is reloaded rather than left blank;
// the capture overlay and window picker are cancelled instead. After three crashes in a minute
// the window is left alone, so a crash loop can't spin.
const pageCrashes = new Map();
app.on('render-process-gone', (_e, contents, details) => {
  logError(`Page ${pageName(contents)} stopped`, `${details.reason} (exit code ${details.exitCode})`);
  if (details.reason === 'clean-exit') return;
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed()) return;
  if (win === captureWin) { cancelCapture(); return; }
  if (win === windowPickerWin) { win.close(); return; }
  const now = Date.now();
  const recent = (pageCrashes.get(contents.id) || []).filter(t => now - t < 60_000).concat(now);
  pageCrashes.set(contents.id, recent);
  if (recent.length > 3) return;
  contents.reload();
  if (win === editorWin) {
    dialog.showMessageBox(win, {
      type: 'warning',
      message: tr('The editor stopped unexpectedly'),
      detail: tr('It has been reopened. Your saved captures are not affected.'),
    }).catch(() => {});
  }
});

app.on('child-process-gone', (_e, details) => {
  if (details.reason !== 'clean-exit') logError(`${details.type} process stopped`, `${details.reason} (exit code ${details.exitCode})`);
});

function pageName(contents) {
  try { return path.basename(new URL(contents.getURL()).pathname) || 'window'; }
  catch { return 'window'; }
}

ipcMain.on('show-log', () => showLog());

app.whenReady().then(() => {
  restoreCapturesFolder();
  nativeTheme.themeSource = appSettings().appearance.theme;
  i18n.setLanguage(appSettings().appearance.language, app.getLocale());
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
  // Catch up on captures made since the last run once the app has settled.
  searchIndex.setEnabled(appSettings().searchText);
  searchIndex.schedule(8000);
});

app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
