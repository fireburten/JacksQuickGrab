// Tests for the 📷 camera bubble in screen recordings:
//  - main.js against a stand-in for electron (like test-main-process.cjs): the camera settings
//    are validated, and camera access is asked for (or refused) like the microphone's;
//  - the entitlements and Info.plist text the camera needs;
//  - src/webcam.js: the bubble's corner, size, mirroring, cover crop, shape, border and shadow
//    (pixel checks), and Chromium's fake camera through JPWebcam.open();
//  - the HUD's 📷 toggle, and whole recordings: camera on, blocked, failing, disconnected,
//    a start that fails, and GIF / scrolling captures (which never use the camera);
//  - Settings → Recording's camera rows, on the real editor page.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-webcam.cjs
// Chromium's fake camera stands in for a real one and the screen is a canvas stream, so nothing
// real is recorded. Exits non-zero on failure; the report is also written to
// $TMPDIR/test-webcam.txt (stdout can be cut off on quit), with sample images in $TMPDIR/test-webcam/.
const { app, BrowserWindow, ipcMain } = require('electron');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// getUserMedia gets Chromium's fake camera (a green test picture) without a permission prompt.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');
const REPORT = path.join(os.tmpdir(), 'test-webcam.txt');
const IMAGES = path.join(os.tmpdir(), 'test-webcam');
const TIMEOUT_MS = 3 * 60 * 1000;
const HUD_WIDTH = +/const HUD_WIDTH = (\d+);/.exec(fs.readFileSync(MAIN, 'utf8'))[1];
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value || Date.now() - t0 > ms) return value;
    await wait(50);
  }
}

// ── main.js against a stand-in for electron ──────────────────────────────────
// Only what the settings store and the camera handlers touch. Nothing is created in the real
// home folder: the captures folder is only made once the app is ready, which never happens here.
function loadMain({ mediaStatus = {}, askAnswer = true, askThrows = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-webcam-main-'));
  const env = { tmp, handle: {}, on: {}, sent: [], opened: [], asked: [] };
  const webContents = { send: (channel, ...args) => env.sent.push({ channel, args }), setZoomFactor() {} };
  const electron = {
    app: {
      getPath: name => path.join(tmp, name), whenReady: () => new Promise(() => {}), isReady: () => true,
      on() {}, focus() {}, isPackaged: false, commandLine: { hasSwitch: () => false },
      getVersion: () => '1.0.0', getLocale: () => 'en-US', getAppPath: () => ROOT, getLoginItemSettings: () => ({ openAtLogin: false }),
    },
    BrowserWindow: Object.assign(class {}, {
      getAllWindows: () => [{ isDestroyed: () => false, webContents }], fromWebContents: () => null,
    }),
    Tray: class {}, Menu: { buildFromTemplate: () => ({}) },
    globalShortcut: { register: () => true, unregisterAll() {} },
    ipcMain: { handle: (c, f) => { env.handle[c] = f; }, on: (c, f) => { env.on[c] = f; }, once() {}, removeListener() {} },
    screen: {}, clipboard: {}, nativeImage: {}, desktopCapturer: {}, ShareMenu: class {}, dialog: {},
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
    systemPreferences: {
      getMediaAccessStatus: kind => mediaStatus[kind] || 'not-determined',
      askForMediaAccess: async kind => {
        env.asked.push(kind);
        if (askThrows) throw new Error('askForMediaAccess failed');
        return askAnswer;
      },
    },
    shell: { openExternal: async url => { env.opened.push(url); } },
  };
  const load = Module._load;
  const before = { ex: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection') };
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  try {
    const m = new Module(MAIN, module);
    m.filename = MAIN;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(fs.readFileSync(MAIN, 'utf8'), MAIN);
  } finally {
    Module._load = load;
    // main's crash handlers belong to the app, not to this harness.
    process.listeners('uncaughtException').filter(l => !before.ex.includes(l)).forEach(l => process.removeListener('uncaughtException', l));
    process.listeners('unhandledRejection').filter(l => !before.rej.includes(l)).forEach(l => process.removeListener('unhandledRejection', l));
  }
  env.settingsFile = path.join(tmp, 'userData', 'settings.json');
  env.log = () => { try { return fs.readFileSync(path.join(tmp, 'logs', 'main.log'), 'utf8'); } catch { return ''; } };
  return env;
}

const call = (m, channel, ...args) => m.handle[channel]({}, ...args);

async function mainProcessTests() {
  const m = loadMain();
  const d = (await call(m, 'settings-get')).recording;
  check('main: the camera is off by default (medium, bottom right, circle)',
    d.camera === false && d.cameraSize === 'medium' && d.cameraCorner === 'bottom-right' && d.cameraShape === 'circle', JSON.stringify(d));
  check('main: the other recording settings keep their defaults',
    d.systemAudio === false && d.mic === false && d.gifFps === 12 && d.gifWidth === 800, JSON.stringify(d));

  const r = (await call(m, 'settings-set', { recording: { camera: true, cameraSize: 'large', cameraCorner: 'top-left', cameraShape: 'rounded' } })).recording;
  check('main: valid camera settings are kept',
    r.camera === true && r.cameraSize === 'large' && r.cameraCorner === 'top-left' && r.cameraShape === 'rounded', JSON.stringify(r));
  check('main: windows are told about camera changes',
    m.sent.some(s => s.channel === 'settings-changed' && s.args[0].recording.cameraCorner === 'top-left'));

  const accepted = [];
  for (const cameraSize of ['small', 'medium', 'large']) accepted.push((await call(m, 'settings-set', { recording: { cameraSize } })).recording.cameraSize === cameraSize);
  for (const cameraCorner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) accepted.push((await call(m, 'settings-set', { recording: { cameraCorner } })).recording.cameraCorner === cameraCorner);
  for (const cameraShape of ['circle', 'rounded']) accepted.push((await call(m, 'settings-set', { recording: { cameraShape } })).recording.cameraShape === cameraShape);
  check('main: every size, corner and shape is accepted', accepted.every(Boolean), JSON.stringify(accepted));

  await call(m, 'settings-set', { recording: { cameraCorner: 'top-right', mic: true } });
  const partial = (await call(m, 'settings-set', { recording: { cameraShape: 'circle' } })).recording;
  check('main: changing one camera setting keeps the rest (and the audio ones)',
    partial.camera === true && partial.cameraCorner === 'top-right' && partial.cameraShape === 'circle' && partial.cameraSize === 'large' && partial.mic === true,
    JSON.stringify(partial));

  const bad = (await call(m, 'settings-set', { recording: { camera: 0, cameraSize: 'huge', cameraCorner: 'center', cameraShape: 'star' } })).recording;
  check('main: invalid camera settings fall back to the defaults',
    bad.camera === false && bad.cameraSize === 'medium' && bad.cameraCorner === 'bottom-right' && bad.cameraShape === 'circle', JSON.stringify(bad));
  const odd = (await call(m, 'settings-set', { recording: { camera: 1, cameraSize: ['large'], cameraCorner: 7, cameraShape: null } })).recording;
  check('main: so do values of the wrong type',
    odd.camera === true && odd.cameraSize === 'medium' && odd.cameraCorner === 'bottom-right' && odd.cameraShape === 'circle', JSON.stringify(odd));

  fs.writeFileSync(m.settingsFile, JSON.stringify({ recording: { camera: 'yes', cameraSize: 'LARGE', cameraCorner: 'left', cameraShape: '' } }));
  const edited = (await call(m, 'settings-get')).recording;
  check('main: a hand-edited settings file can’t break the camera settings',
    edited.camera === true && edited.cameraSize === 'medium' && edited.cameraCorner === 'bottom-right' && edited.cameraShape === 'circle', JSON.stringify(edited));

  m.on['open-camera-settings']();
  check('main: open-camera-settings opens Privacy & Security → Camera',
    m.opened.at(-1) === 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera', m.opened.at(-1));

  await cameraAccessTests();
}

async function cameraAccessTests() {
  if (process.platform !== 'darwin') {
    check('camera access: allowed outside macOS', (await call(loadMain(), 'camera-access')) === true);
    return;
  }
  const access = async (camera, options = {}) => {
    const m = loadMain({ mediaStatus: { camera, microphone: 'granted' }, ...options });
    return { answer: await call(m, 'camera-access'), asked: m.asked, m };
  };
  let a = await access('granted');
  check('camera access: granted → yes, without asking', a.answer === true && !a.asked.length, JSON.stringify(a.asked));
  a = await access('not-determined', { askAnswer: true });
  check('camera access: not asked yet → macOS asks for the camera', a.answer === true && a.asked.join() === 'camera', JSON.stringify(a.asked));
  a = await access('not-determined', { askAnswer: false });
  check('camera access: …and “Don’t Allow” is a no', a.answer === false);
  for (const status of ['denied', 'restricted']) {
    a = await access(status);
    check(`camera access: ${status} → no, without asking`, a.answer === false && !a.asked.length, JSON.stringify(a.asked));
  }
  const quiet = console.error;
  console.error = () => {};   // main echoes what it logs; the log file is what's checked
  try { a = await access('not-determined', { askThrows: true }); } finally { console.error = quiet; }
  check('camera access: an error is a no, and is logged', a.answer === false && /Camera access: Error: askForMediaAccess failed/.test(a.m.log()), a.m.log());

  const mic = loadMain({ mediaStatus: { microphone: 'not-determined', camera: 'granted' } });
  await call(mic, 'mic-access');
  check('microphone access still asks for the microphone', mic.asked.join() === 'microphone', JSON.stringify(mic.asked));
}

// ── Packaging: entitlements and Info.plist ────────────────────────────────────
function packagingTests() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('Info.plist: camera usage text',
    pkg.build.mac.extendInfo.NSCameraUsageDescription === "Jack's Picker shows your camera in a recording only when you turn on 📷.",
    pkg.build.mac.extendInfo.NSCameraUsageDescription);
  for (const file of ['entitlements.mas.plist', 'entitlements.mac.plist']) {
    const full = path.join(ROOT, 'build', file);
    let entitlements = null, detail = '';
    try {
      // plutil also proves the file is still a valid plist (a broken one fails code signing).
      entitlements = process.platform === 'darwin'
        ? JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', full]).toString())
        : { 'com.apple.security.device.camera': /<key>com\.apple\.security\.device\.camera<\/key>\s*<true\/>/.test(fs.readFileSync(full, 'utf8')) };
    } catch (e) { detail = e.message; }
    check(`${file}: camera entitlement`, entitlements?.['com.apple.security.device.camera'] === true, detail || JSON.stringify(entitlements));
  }
}

// ── Stand-ins for main.js's IPC, for the real pages ───────────────────────────
const DEFAULT_RECORDING = { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800, camera: false, cameraSize: 'medium', cameraCorner: 'bottom-right', cameraShape: 'circle' };
const freshSettings = (recording = {}) => ({
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large' },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { ...DEFAULT_RECORDING, ...recording },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: false,
  capturesFolder: { path: '/tmp/jp-webcam-test', isDefault: true, defaultPath: '/tmp/jp-webcam-test' },
});
let S = freshSettings();
let current = null;   // the page under test; it gets the settings-changed broadcasts
let cameraOK = true, micOK = true;
const ipc = { sets: [], cameraAsks: 0, cameraSettingsOpened: 0, micSettingsOpened: 0, saved: [], stopped: 0, scrollDone: 0 };

function registerStubs() {
  const stubs = {
    'settings-get': () => S,
    'settings-set': (_e, patch) => {
      ipc.sets.push(patch);
      for (const key of ['appearance', 'editor', 'recording']) if (patch[key]) S[key] = { ...S[key], ...patch[key] };
      current?.webContents.send('settings-changed', S);
      return S;
    },
    'camera-access': () => { ipc.cameraAsks++; return cameraOK; },
    'mic-access': () => micOK,
    'save-recording': (_e, buffer, ext) => { ipc.saved.push({ bytes: Buffer.from(buffer), ext }); return `/tmp/jp-webcam-test/recording.${ext}`; },
    'shortcuts-get': () => ({ shortcuts: {} }),
    'gallery-list': () => [],
    'project-folders': () => ({}),
  };
  // Every channel the pages can invoke gets an answer (null unless stubbed above).
  const preload = fs.readFileSync(path.join(ROOT, 'preload.cjs'), 'utf8');
  const channels = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]));
  Object.keys(stubs).forEach(c => channels.add(c));
  channels.forEach(c => ipcMain.handle(c, (...args) => (stubs[c] ? stubs[c](...args) : null)));
  ipcMain.on('open-camera-settings', () => { ipc.cameraSettingsOpened++; });
  ipcMain.on('open-mic-settings', () => { ipc.micSettingsOpened++; });
  ipcMain.on('recording-stopped', () => { ipc.stopped++; });
  ipcMain.on('scroll-capture-done', () => { ipc.scrollDone++; });
}

function openPage(file, { width, height }, errors) {
  const win = new BrowserWindow({
    show: false, width, height,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, backgroundThrottling: false,
      partition: `webcam-${Date.now()}-${Math.random().toString(36).slice(2)}`,   // fresh localStorage per page
    },
  });
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(`${file}: ${e.message}`); });
  current = win;
  return win;
}

async function saveImage(name, dataURL) {
  fs.mkdirSync(IMAGES, { recursive: true });
  fs.writeFileSync(path.join(IMAGES, name), Buffer.from(dataURL.split(',')[1], 'base64'));
}

const inPage = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);

// [r, g, b] at a CSS-pixel point of a capturePage() image (a BGRA bitmap, maybe at 2x).
function pixelOf(image, cssWidth, x, y) {
  const { width } = image.getSize(), scale = width / cssWidth, bitmap = image.toBitmap();
  const i = (Math.round(y * scale) * width + Math.round(x * scale)) * 4;
  return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
}

// ── src/webcam.js: drawing the bubble ─────────────────────────────────────────
// Runs in the page. An 800×500 blue "screen"; the "camera" is a 4:3 canvas whose middle square is
// red on the left and green on the right, with magenta bands at the sides that a cover crop to a
// square cuts off. Mirrored, the bubble is green on its left and red on its right.
function bubbleCases() {
  const W = 800, H = 500;
  const screen = document.createElement('canvas');
  screen.width = W; screen.height = H;
  const ctx = screen.getContext('2d', { willReadFrequently: true });
  const camera = document.createElement('canvas');
  camera.width = 640; camera.height = 480;
  const g = camera.getContext('2d');
  g.fillStyle = '#f0f'; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#f00'; g.fillRect(80, 0, 240, 480);
  g.fillStyle = '#0f0'; g.fillRect(320, 0, 240, 480);
  const px = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
  const cases = [];
  for (const cameraSize of ['small', 'medium', 'large']) {
    for (const cameraCorner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      for (const cameraShape of ['circle', 'rounded']) {
        ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, W, H);
        const prefs = { cameraSize, cameraCorner, cameraShape };
        const rect = window.JPWebcam.drawBubble(ctx, camera, prefs);
        const { x, y, size } = rect;
        const cx = x + size / 2, cy = y + size / 2;
        // The middle of each corner's bubble, for checking the others are untouched.
        const others = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].filter(c => c !== cameraCorner).map(c => {
          const o = window.JPWebcam.bubbleRect(W, H, { cameraSize, cameraCorner: c });
          return px(o.x + o.size / 2, o.y + o.size / 2);
        });
        cases.push({
          prefs, rect,
          left: px(cx - size / 4, cy), right: px(cx + size / 4, cy),
          leftEdge: px(x + size * 0.06, cy), rightEdge: px(x + size * 0.94, cy),
          nearCorner: px(x + size * 0.1, y + size * 0.1),
          outside: px(cameraCorner.endsWith('left') ? x + size + 3 : x - 3, cy),
          others,
        });
      }
    }
  }
  // Border and shadow: a black camera on black shows the border; a white one on white, the shadow.
  const solid = colour => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const cg = c.getContext('2d'); cg.fillStyle = colour; cg.fillRect(0, 0, 320, 240); return c; };
  const prefs = { cameraSize: 'medium', cameraCorner: 'bottom-right', cameraShape: 'circle' };
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const b = window.JPWebcam.drawBubble(ctx, solid('#000'), prefs);
  const ring = Math.max(...[0, 1, 2, 3].map(dy => px(b.x + b.size / 2, b.y + dy)[0]));
  const middle = px(b.x + b.size / 2, b.y + b.size / 2)[0];
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  window.JPWebcam.drawBubble(ctx, solid('#fff'), prefs);
  const shadow = px(b.x + b.size / 2, b.y + b.size + 4)[0];
  const farAway = px(40, 40)[0];
  // A camera with no picture yet draws nothing.
  ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, W, H);
  const empty = window.JPWebcam.drawBubble(ctx, document.createElement('video'), prefs);
  return { cases, ring, middle, shadow, farAway, empty, emptyPixel: px(b.x + b.size / 2, b.y + b.size / 2) };
}

// The fake camera through JPWebcam.open(): drawn in the corner, then turned off. Also times a
// full-screen Retina frame (2880×1800) and returns it scaled down as a sample image.
async function fakeCameraCase() {
  const W = 640, H = 400;
  const screen = document.createElement('canvas');
  screen.width = W; screen.height = H;
  const ctx = screen.getContext('2d', { willReadFrequently: true });
  const px = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
  ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, W, H);
  const camera = await window.JPWebcam.open({ cameraSize: 'medium', cameraCorner: 'top-right', cameraShape: 'circle' });
  const rect = camera.draw(ctx);
  const { x, y, size } = rect;
  const cx = x + size / 2, cy = y + size / 2;
  const out = {
    rect, live: camera.stream.getVideoTracks().map(t => t.readyState).join(),
    inside: [px(cx - size * 0.3, cy), px(cx + size * 0.3, cy), px(cx, cy - size * 0.3), px(cx, cy + size * 0.3)],
    outside: [px(40, 40), px(W - 40, H - 40), px(40, H - 40)],
  };

  // A desktop-like picture with both shapes, to look at.
  const big = document.createElement('canvas');
  big.width = 2880; big.height = 1800;
  const bg = big.getContext('2d');
  const desktop = () => {
    bg.fillStyle = '#f4f4f8'; bg.fillRect(0, 0, 2880, 1800);
    bg.fillStyle = '#ffffff'; bg.fillRect(0, 0, 2880, 110);
    bg.fillStyle = '#d9d8e4';
    for (let i = 0; i < 14; i++) bg.fillRect(420, 220 + i * 100, 1400 + (i * 137) % 800, 36);
    bg.fillStyle = '#6c4ef6'; bg.fillRect(2000, 260, 620, 420);
  };
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) { desktop(); camera.draw(bg); }
  bg.getImageData(0, 0, 1, 1);   // waits for the drawing to finish
  out.msPerFrame = (performance.now() - t0) / 30;
  desktop(); camera.draw(bg);
  const small = document.createElement('canvas');
  small.width = 1440; small.height = 900;
  small.getContext('2d').drawImage(big, 0, 0, 1440, 900);
  out.circleImage = small.toDataURL('image/png');

  camera.stop();
  out.ended = camera.stream.getTracks().every(t => t.readyState === 'ended');
  ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, W, H);
  out.drawAfterStop = camera.draw(ctx);
  out.afterStop = px(cx, cy);
  return out;
}

// Rounded bubble, bottom left and large, from the fake camera: a sample image to look at.
async function roundedSample() {
  const camera = await window.JPWebcam.open({ cameraSize: 'large', cameraCorner: 'bottom-left', cameraShape: 'rounded' });
  const c = document.createElement('canvas');
  c.width = 1440; c.height = 900;
  const g = c.getContext('2d');
  g.fillStyle = '#1f2330'; g.fillRect(0, 0, 1440, 900);
  g.fillStyle = '#2d3345'; for (let i = 0; i < 12; i++) g.fillRect(360, 90 + i * 60, 700 + (i * 97) % 300, 22);
  camera.draw(g);
  camera.stop();
  return c.toDataURL('image/png');
}

const isBlue = ([r, g, b]) => b > 100 && r < 70 && g < 70;             // the "screen", maybe in shadow
const isPureBlue = ([r, g, b]) => b > 240 && r < 10 && g < 10;
const isGreen = ([r, g, b]) => g > 180 && r < 90 && b < 90;
const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
const isCameraGreen = ([r, g, b]) => g > 100 && g > r + 40 && g > b + 40;   // the fake camera's picture

async function drawingTests(errors) {
  S = freshSettings();
  const w = openPage('hud.html', { width: HUD_WIDTH, height: 90 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'hud.html'));
  check('webcam.js loads in the HUD', await w.webContents.executeJavaScript('typeof window.JPWebcam?.drawBubble === "function"'));

  const r = await inPage(w, bubbleCases);
  // 800×500: the shorter side is 500, so the margin is 18 px and the sizes 90 / 125 / 170 px.
  const SIZE = { small: 90, medium: 125, large: 170 }, M = 18;
  const expected = ({ cameraSize, cameraCorner }) => {
    const size = SIZE[cameraSize];
    return { x: cameraCorner.endsWith('left') ? M : 800 - M - size, y: cameraCorner.startsWith('top') ? M : 500 - M - size, size };
  };
  const wrong = key => r.cases.filter(c => !c[key]).map(c => `${c.prefs.cameraSize}/${c.prefs.cameraCorner}/${c.prefs.cameraShape}`);
  r.cases.forEach(c => {
    const e = expected(c.prefs);
    c.placed = c.rect.x === e.x && c.rect.y === e.y && c.rect.size === e.size;
    c.mirrored = isGreen(c.left) && isRed(c.right);
    c.covered = isGreen(c.leftEdge) && isRed(c.rightEdge);
    c.shaped = c.prefs.cameraShape === 'circle' ? isBlue(c.nearCorner) : isGreen(c.nearCorner);
    c.contained = isBlue(c.outside) && c.others.every(isPureBlue);
  });
  check('bubble: every size lands in every corner, at the right size (24 cases)', r.cases.length === 24 && !wrong('placed').length,
    wrong('placed').join(', ') + JSON.stringify(r.cases.find(c => !c.placed)?.rect));
  check('bubble: the camera is mirrored', !wrong('mirrored').length, wrong('mirrored').join(', '));
  check('bubble: the camera fills the bubble (object-fit: cover, no stretching)', !wrong('covered').length, wrong('covered').join(', '));
  check('bubble: clipped to a circle or a rounded square', !wrong('shaped').length, wrong('shaped').join(', '));
  check('bubble: nothing is drawn outside it', !wrong('contained').length, wrong('contained').join(', '));
  check('bubble: a thin light border', r.ring > 100 && r.middle < 20, `ring ${r.ring}, middle ${r.middle}`);
  check('bubble: a soft shadow below it', r.shadow < 245 && r.farAway === 255, `shadow ${r.shadow}, far away ${r.farAway}`);
  check('bubble: a camera without a picture yet draws nothing', r.empty === null && isPureBlue(r.emptyPixel), JSON.stringify(r.emptyPixel));

  const f = await inPage(w, fakeCameraCase);
  // 640×400: margin 14 px, medium 100 px, top right.
  check('fake camera: opens and is drawn in its corner', f.live === 'live' && f.rect.x === 526 && f.rect.y === 14 && f.rect.size === 100,
    JSON.stringify({ live: f.live, rect: f.rect }));
  check('fake camera: its picture fills the bubble, the rest is the screen', f.inside.every(isCameraGreen) && f.outside.every(isPureBlue),
    JSON.stringify({ inside: f.inside, outside: f.outside }));
  check('fake camera: stop() turns it off, and it draws nothing after', f.ended && f.drawAfterStop === null && isPureBlue(f.afterStop),
    JSON.stringify({ ended: f.ended, drawAfterStop: f.drawAfterStop, afterStop: f.afterStop }));
  results.push({ name: `· ${f.msPerFrame.toFixed(2)} ms to draw a 2880×1800 frame with the bubble (offscreen)`, ok: true, detail: '' });
  await saveImage('bubble-circle.png', f.circleImage);
  await saveImage('bubble-rounded.png', await inPage(w, roundedSample));
  w.destroy();
}

// ── The HUD's 📷 toggle ───────────────────────────────────────────────────────
async function hudToggleTests(errors) {
  S = freshSettings();
  cameraOK = true;
  const w = openPage('hud.html', { width: HUD_WIDTH, height: 90 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'hud.html'));
  await wait(600);
  const js = code => w.webContents.executeJavaScript(code);
  const isOn = () => js(`document.getElementById('cam-toggle').classList.contains('on')`);
  const title = () => js(`document.getElementById('cam-toggle').title`);
  const click = async () => { await js(`document.getElementById('cam-toggle').click(); 0`); await wait(300); };

  check('HUD: 📷 is off by default', !(await isOn()));
  const layout = await js(`(() => {
    const box = el => { const r = document.querySelector(el).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const hud = document.querySelector('.hud');
    return { overflow: hud.scrollWidth - hud.clientWidth, width: innerWidth, hist: box('.hist-btn'), cam: box('#cam-toggle'),
      sys: box('.audio-toggle[data-audio=system]'), mic: box('.audio-toggle[data-audio=mic]'), gif: box('.mode-btn[data-mode=gif]') };
  })()`);
  check(`HUD: everything fits in main’s HUD_WIDTH (${HUD_WIDTH})`, layout.overflow === 0 && layout.hist.right <= layout.width - 12, JSON.stringify(layout));
  check('HUD: 📷 sits beside 🔊/🎙, as tall as both, before GIF',
    layout.cam.left >= layout.sys.right && layout.cam.top === layout.sys.top && Math.abs(layout.cam.bottom - layout.mic.bottom) <= 1 && layout.cam.right <= layout.gif.left,
    JSON.stringify(layout));
  await saveImage('hud-idle.png', (await w.webContents.capturePage()).toDataURL());

  const asked = ipc.cameraAsks;
  await click();
  check('HUD: 📷 asks for camera access, then saves the setting',
    ipc.cameraAsks === asked + 1 && JSON.stringify(ipc.sets.at(-1)) === JSON.stringify({ recording: { camera: true } }) && S.recording.camera === true && (await isOn()),
    JSON.stringify(ipc.sets.at(-1)));
  const sets = ipc.sets.length;
  await click();
  check('HUD: 📷 turns off without asking again', !(await isOn()) && S.recording.camera === false && ipc.cameraAsks === asked + 1 && ipc.sets.length === sets + 1);
  cameraOK = false;
  const opened = ipc.cameraSettingsOpened;
  await click();
  check('HUD: 📷 stays off when camera access is blocked, and opens Camera settings',
    !(await isOn()) && S.recording.camera === false && ipc.sets.length === sets + 1 && ipc.cameraSettingsOpened === opened + 1 && /Privacy & Security → Camera/.test(await title()),
    await title());
  cameraOK = true;
  S.recording = { ...S.recording, camera: true };
  w.webContents.send('settings-changed', S);
  await wait(200);
  check('HUD: 📷 follows changes made in Settings', (await isOn()) && /^Showing your camera/.test(await title()), await title());
  check('HUD: 🔊 and 🎙 are unaffected',
    (await js(`[...document.querySelectorAll('.audio-toggle')].map(b => b.dataset.audio + ':' + b.classList.contains('on')).join(' ')`)) === 'system:false mic:false');
  await js('setCollapsed(true); 0');
  check('HUD: collapsing it hides 📷', await js(`document.getElementById('cam-toggle').getClientRects().length === 0`));
  await js('setCollapsed(false); 0');
  w.destroy();
}

// ── Whole recordings in the HUD ───────────────────────────────────────────────
// Runs in the page: the screen is a blue canvas stream in place of getDisplayMedia, and
// getUserMedia is wrapped to keep hold of every camera / mic stream the HUD opens.
function installFakes() {
  const screen = document.createElement('canvas');
  screen.width = 640; screen.height = 400;
  const g = screen.getContext('2d');
  const paint = () => { g.fillStyle = '#00f'; g.fillRect(0, 0, 640, 400); };
  paint();
  setInterval(paint, 30);   // a canvas stream only sends frames when the canvas is drawn to
  window.__fail = { display: false, camera: false };
  navigator.mediaDevices.getDisplayMedia = async () => {
    if (window.__fail.display) throw new DOMException('Permission denied', 'NotAllowedError');
    return screen.captureStream(30);
  };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = [];
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (constraints.video && window.__fail.camera) throw new DOMException('Could not start video source', 'NotReadableError');
    const stream = await getUserMedia(constraints);
    window.__streams.push({ kind: constraints.video ? 'camera' : 'mic', stream });
    return stream;
  };
}

const REGION = { x: 0, y: 0, w: 640, h: 400, displayW: 640, displayH: 400 };
const STATE = `(() => {
  const preview = document.getElementById('rec-camera'), note = document.getElementById('rec-note');
  const tracks = kind => window.__streams.filter(s => s.kind === kind).flatMap(s => s.stream.getTracks());
  return {
    bar: getComputedStyle(document.getElementById('rec-bar')).display,
    preview: !preview.hidden, previewSrc: !!preview.srcObject,
    note: note.hidden ? '' : note.textContent,
    cameras: window.__streams.filter(s => s.kind === 'camera').length, mics: window.__streams.filter(s => s.kind === 'mic').length,
    cameraLive: tracks('camera').filter(t => t.readyState === 'live').length, micLive: tracks('mic').filter(t => t.readyState === 'live').length,
  };
})()`;

async function startRecording(recording, errors, { kind = 'video', fail = {} } = {}) {
  S = freshSettings(recording);
  const w = openPage('hud.html', { width: HUD_WIDTH, height: 90 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'hud.html'));
  await wait(400);
  await inPage(w, installFakes);
  await w.webContents.executeJavaScript(`Object.assign(window.__fail, ${JSON.stringify(fail)}); 0`);
  w.webContents.send('recording-region', { kind, ...REGION });
  return { w, js: code => w.webContents.executeJavaScript(code), state: () => w.webContents.executeJavaScript(STATE) };
}

async function stopRecording({ w, js }, what = { saved: 1 }) {
  const saved = ipc.saved.length, scrolls = ipc.scrollDone;
  await js(`document.getElementById('btn-stop-rec').click(); 0`);
  const done = await until(() => (what.scroll ? ipc.scrollDone === scrolls + 1 : ipc.saved.length === saved + 1), 10000);
  await until(() => js(`getComputedStyle(document.getElementById('rec-bar')).display === 'none'`), 3000);
  return done;
}

// Decodes a saved recording in a plain page (the HUD's CSP doesn't allow blob: media). Returns
// pixel samples from a frame 0.3 s in, and how much two areas ([x, y, w, h]) change between
// frames a moment apart: the camera is live video, while the canvas "screen" stays still.
function decodeInPage(base64, ext, { points, bubble, screen }) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(new Blob([bytes], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' }));
  const grab = () => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0);
    return { c, g, time: video.currentTime };
  };
  const change = (a, b, [x, y, w, h]) => {   // mean difference per channel, 0–255
    const pa = a.g.getImageData(x, y, w, h).data, pb = b.g.getImageData(x, y, w, h).data;
    let sum = 0;
    for (let i = 0; i < pa.length; i += 4) sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    return sum / (pa.length / 4) / 3;
  };
  return new Promise((resolve, reject) => {
    video.onerror = () => reject(new Error(`can't decode the recording: ${video.error?.message}`));
    video.onloadeddata = async () => {
      await video.play();
      const frames = [], t0 = performance.now();
      for (const t of [0.3, 0.7, 1.1]) {
        while (video.currentTime < t && !video.ended && performance.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20));
        frames.push(grab());
      }
      video.pause();
      const [first] = frames, pairs = frames.slice(1).map((f, i) => [frames[i], f]);
      resolve({
        width: first.c.width, height: first.c.height, times: frames.map(f => +f.time.toFixed(2)),
        samples: points.map(([x, y]) => [...first.g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3)),
        bubbleChange: Math.max(...pairs.map(([a, b]) => change(a, b, bubble))),
        screenChange: Math.max(...pairs.map(([a, b]) => change(a, b, screen))),
        image: first.c.toDataURL('image/png'),
      });
    };
  });
}

async function decodeRecording({ bytes, ext }, areas) {
  const win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'webcam-decode' } });
  try {
    await win.loadURL('about:blank');
    return await inPage(win, decodeInPage, bytes.toString('base64'), ext, areas);
  } finally {
    win.destroy();
  }
}

async function recordingTests(errors) {
  // 1. Camera on: large, top left, circle.
  cameraOK = true; micOK = true;
  const asked = ipc.cameraAsks;
  let rec = await startRecording({ camera: true, cameraSize: 'large', cameraCorner: 'top-left', cameraShape: 'circle' }, errors);
  const started = await until(async () => { const s = await rec.state(); return s.bar === 'flex' && s.preview; }, 8000);
  const preview = await rec.js(`(() => {
    const v = document.getElementById('rec-camera'), cs = getComputedStyle(v), r = v.getBoundingClientRect();
    const cam = window.__streams.find(s => s.kind === 'camera');
    return { same: !!cam && v.srcObject === cam.stream, live: !!v.srcObject && v.srcObject.getVideoTracks().every(t => t.readyState === 'live'),
      transform: cs.transform, radius: cs.borderRadius, width: r.width, x: r.x + r.width / 2, y: r.y + r.height / 2,
      toggles: getComputedStyle(document.querySelector('.audio-toggles')).display };
  })()`);
  await wait(500);
  rec.w.webContents.invalidate();
  await wait(200);
  const shot = await rec.w.webContents.capturePage();
  await saveImage('hud-recording.png', shot.toDataURL());
  const painted = pixelOf(shot, HUD_WIDTH, preview.x, preview.y);
  check('recording: starts with a live preview of the camera in the HUD', started && preview.same && preview.live && isCameraGreen(painted),
    JSON.stringify({ ...preview, painted }));
  check('recording: the preview is a small mirrored circle', preview.transform === 'matrix(-1, 0, 0, 1, 0, 0)' && preview.radius === '50%' && preview.width === 44,
    JSON.stringify(preview));
  check('recording: camera access is checked when it starts', ipc.cameraAsks === asked + 1, `${asked} → ${ipc.cameraAsks}`);
  check('recording: 📷 and the other toggles are hidden while recording', preview.toggles === 'none', preview.toggles);
  await wait(900);
  const stopped = ipc.stopped;
  check('recording: Stop saves it', await stopRecording(rec) && ipc.stopped === stopped + 1);
  let s = await rec.state();
  check('recording: stopping turns the camera off and hides the preview', s.cameras === 1 && s.cameraLive === 0 && !s.preview && !s.previewSrc, JSON.stringify(s));
  const video = ipc.saved.at(-1);
  // 640×400 → large is 136 px at a 14 px margin: the bubble's middle is at (82, 82).
  const frame = await decodeRecording(video, {
    points: [[82 - 40, 82], [82 + 40, 82], [82, 82 - 40], [82, 82 + 40], [27, 27], [558, 318], [320, 200], [600, 40]],
    bubble: [42, 42, 80, 80], screen: [300, 150, 200, 150],
  });
  await saveImage('recorded-frame.png', frame.image);
  const [l, r, t, b, corner, ...screen] = frame.samples;
  check(`recording: the saved ${video.ext} is the recorded area`, video.bytes.length > 1000 && frame.width === 640 && frame.height === 400,
    JSON.stringify({ ext: video.ext, bytes: video.bytes.length, width: frame.width, height: frame.height }));
  check('recording: the saved video has the camera bubble at the top left', [l, r, t, b].every(isCameraGreen), JSON.stringify(frame.samples));
  check('recording: …as a circle, with the screen everywhere else', isBlue(corner) && screen.every(isBlue), JSON.stringify(frame.samples));
  check('recording: the bubble is live video, not a still frame', frame.bubbleChange > 3 && frame.screenChange < 1,
    JSON.stringify({ times: frame.times, bubbleChange: frame.bubbleChange, screenChange: frame.screenChange }));
  results.push({ name: `· the bubble area changes ${frame.bubbleChange.toFixed(1)}/255 between frames ${frame.times.join(' / ')} s; the screen ${frame.screenChange.toFixed(2)}`, ok: true, detail: '' });
  rec.w.destroy();

  // 2. The camera unplugged mid-recording: the recording carries on without it.
  rec = await startRecording({ camera: true }, errors);
  await until(async () => (await rec.state()).preview, 8000);
  await rec.js(`window.__streams.find(s => s.kind === 'camera').stream.getVideoTracks().forEach(t => { t.stop(); t.dispatchEvent(new Event('ended')); }); 0`);
  await wait(200);
  s = await rec.state();
  check('camera disconnected: the preview goes and a note says so', !s.preview && s.note === '⚠ Camera disconnected' && s.bar === 'flex', JSON.stringify(s));
  check('camera disconnected: the recording is still saved', await stopRecording(rec));
  rec.w.destroy();

  // 3. Camera access blocked: the recording goes ahead without it.
  cameraOK = false;
  rec = await startRecording({ camera: true }, errors);
  await until(async () => (await rec.state()).bar === 'flex', 8000);
  s = await rec.state();
  check('camera blocked: records without it, with a “Camera blocked” note', s.note === '⚠ Camera blocked' && !s.preview && s.cameras === 0, JSON.stringify(s));
  const opened = ipc.cameraSettingsOpened;
  await rec.js(`document.getElementById('rec-note').click(); 0`);
  await wait(200);
  check('camera blocked: clicking the note opens Camera settings', ipc.cameraSettingsOpened === opened + 1);
  check('camera blocked: the recording is still saved', await stopRecording(rec));
  rec.w.destroy();
  cameraOK = true;

  // 4. The camera fails to open (e.g. in use elsewhere).
  rec = await startRecording({ camera: true }, errors, { fail: { camera: true } });
  await until(async () => (await rec.state()).bar === 'flex', 8000);
  s = await rec.state();
  check('camera fails: records without it, with a “No camera” note', s.note === '⚠ No camera' && !s.preview, JSON.stringify(s));
  check('camera fails: the recording is still saved', await stopRecording(rec));
  rec.w.destroy();

  // 5. The recording can't start (no screen access) after the camera and mic opened.
  const errorsBefore = errors.length;
  const stoppedBefore = ipc.stopped;
  rec = await startRecording({ camera: true, mic: true }, errors, { fail: { display: true } });
  await until(() => ipc.stopped === stoppedBefore + 1, 8000);
  await wait(200);
  s = await rec.state();
  check('start fails: the camera and mic are turned off again',
    s.cameras === 1 && s.cameraLive === 0 && s.mics === 1 && s.micLive === 0 && !s.preview && s.bar === 'none' && ipc.stopped === stoppedBefore + 1, JSON.stringify(s));
  const failure = errors.splice(errorsBefore);
  check('start fails: the failure is logged', failure.length === 1 && /video capture failed/.test(failure[0]), JSON.stringify(failure));
  rec.w.destroy();

  // 6. GIFs and scrolling captures never use the camera.
  for (const kind of ['gif', 'scroll']) {
    const before = ipc.cameraAsks;
    rec = await startRecording({ camera: true }, errors, { kind });
    await until(async () => (await rec.state()).bar === 'flex', 8000);
    await wait(500);
    s = await rec.state();
    check(`${kind === 'gif' ? 'GIF' : 'scrolling capture'}: the camera isn’t used`, s.cameras === 0 && !s.preview && ipc.cameraAsks === before, JSON.stringify(s));
    check(`${kind === 'gif' ? 'GIF' : 'scrolling capture'}: still finishes`, await stopRecording(rec, kind === 'gif' ? { saved: 1 } : { scroll: true }));
    rec.w.destroy();
  }

  // 7. The mic's own note still opens Microphone settings (it shares the note with the camera's).
  micOK = false;
  rec = await startRecording({ mic: true }, errors);
  await until(async () => (await rec.state()).bar === 'flex', 8000);
  s = await rec.state();
  const micOpened = ipc.micSettingsOpened;
  await rec.js(`document.getElementById('rec-note').click(); 0`);
  await wait(200);
  check('mic blocked: its note still opens Microphone settings', s.note === '⚠ Mic blocked' && ipc.micSettingsOpened === micOpened + 1, JSON.stringify(s));
  await stopRecording(rec);
  rec.w.destroy();
  micOK = true;
}

// ── Settings → Recording ──────────────────────────────────────────────────────
async function settingsPanelTests(errors) {
  S = freshSettings();
  cameraOK = false;
  const w = openPage('editor.html', { width: 1300, height: 850 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
  await wait(1200);
  const js = code => w.webContents.executeJavaScript(code);
  const notice = () => js(`document.querySelector('.sp-notice')?.textContent || ''`);
  const seg = label => js(`[...document.querySelectorAll('.sp-seg[aria-label="${label}"] button')].map(b => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')).join('|')`);
  const pick = async (label, text) => { await js(`[...document.querySelectorAll('.sp-seg[aria-label="${label}"] button')].find(b => b.textContent === ${JSON.stringify(text)})?.click(); 0`); await wait(250); };
  const cameraSwitch = `document.querySelector('.sp-switch[aria-label="Camera bubble"]')`;

  await js(`JPSettings.open('recording'); 0`);
  await wait(400);
  const rows = await js(`[...document.querySelectorAll('.sp-row .sp-label')].map(l => l.firstChild.textContent)`);
  const at = rows.indexOf('Record microphone');
  check('Settings: the camera rows follow the microphone in Recording',
    at >= 0 && rows.slice(at + 1, at + 5).join('|') === 'Camera bubble|Bubble size|Bubble position|Bubble shape', rows.join('|'));
  check('Settings: bubble size is Small / Medium / Large', (await seg('Bubble size')) === 'Small|Medium*|Large', await seg('Bubble size'));
  check('Settings: bubble position is one of the four corners', (await seg('Bubble position')) === 'Top left|Top right|Bottom left|Bottom right*', await seg('Bubble position'));
  check('Settings: bubble shape is Circle / Rounded', (await seg('Bubble shape')) === 'Circle*|Rounded', await seg('Bubble shape'));
  const fit = await js(`(() => {
    const s = document.querySelector('.sp-seg[aria-label="Bubble position"]'), r = s.getBoundingClientRect();
    const box = document.querySelector('.sp-main').getBoundingClientRect(), tops = [...s.children].map(b => b.getBoundingClientRect().top);
    return { overflow: s.scrollWidth - s.clientWidth, right: r.right, boxRight: box.right, oneLine: tops.every(t => t === tops[0]) };
  })()`);
  check('Settings: the corner choices fit on one line', fit.overflow <= 0 && fit.right <= fit.boxRight && fit.oneLine, JSON.stringify(fit));
  await saveImage('settings-recording.png', (await w.webContents.capturePage()).toDataURL());

  await js(`${cameraSwitch}?.click(); 0`);
  await wait(300);
  check('Settings: the camera stays off when access is blocked, with a notice',
    S.recording.camera === false && (await js(`${cameraSwitch}?.getAttribute('aria-checked')`)) === 'false' && (await notice()).includes('Camera access is off'), await notice());
  const opened = ipc.cameraSettingsOpened;
  await js(`[...document.querySelectorAll('.sp-notice button')].find(b => b.textContent === 'Open System Settings')?.click(); 0`);
  await wait(200);
  check('Settings: the notice opens Camera settings', ipc.cameraSettingsOpened === opened + 1);
  cameraOK = true;
  await js(`${cameraSwitch}?.click(); 0`);
  await wait(300);
  check('Settings: the camera turns on once access is allowed',
    S.recording.camera === true && (await js(`${cameraSwitch}?.getAttribute('aria-checked')`)) === 'true');
  for (const [label, text, key, value] of [['Bubble size', 'Large', 'cameraSize', 'large'], ['Bubble position', 'Top left', 'cameraCorner', 'top-left'], ['Bubble shape', 'Rounded', 'cameraShape', 'rounded']]) {
    await pick(label, text);
    check(`Settings: ${label.toLowerCase()} is saved`, S.recording[key] === value && (await seg(label)).includes(`${text}*`), `${S.recording[key]} ${await seg(label)}`);
  }
  w.destroy();
}

// ── Run ───────────────────────────────────────────────────────────────────────
function finish(extra = '') {
  if (extra) check(extra, false);
  const failed = results.filter(r => !r.ok).length;
  const counted = results.filter(r => !r.name.startsWith('·')).length;
  const report = results.map(r => (r.name.startsWith('·') ? `  ${r.name}` : `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`)).join('\n')
    + `\n\n${failed ? 'FAILED' : 'PASSED'}: ${counted - failed} passed, ${failed} failed (sample images in ${IMAGES})`;
  fs.writeFileSync(REPORT, report + '\n');
  process.stdout.write(report + '\n', () => app.exit(failed ? 1 : 0));
}

app.on('window-all-closed', () => {});   // pages open one at a time; don't quit between them

app.whenReady().then(async () => {
  const timer = setTimeout(() => finish('harness finished in time'), TIMEOUT_MS);
  const errors = [];
  try {
    await mainProcessTests();
    packagingTests();
    registerStubs();
    await drawingTests(errors);
    await hudToggleTests(errors);
    await recordingTests(errors);
    await settingsPanelTests(errors);
  } catch (e) {
    check('harness ran to completion', false, e.stack);
  }
  clearTimeout(timer);
  check('no page errors', errors.length === 0, JSON.stringify(errors));
  finish();
});
