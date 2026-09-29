// Tests the thumbnail after a capture and Pin to Screen: lib/quick-access.cjs, src/thumbnail.*,
// src/pin.*, and their parts in main.js, the editor and the Settings panel.
//   node scripts/test-quick-access.cjs
// Part 1 (Node) loads main.js against a stand-in for Electron, like test-main-process.cjs: the
// setting, when finishCapture shows a thumbnail, stacking, the thumbnail's actions, and the pin
// windows (options, sizes, path checks, controls). Part 2 runs this file again in Electron: the
// real pages offscreen with stubbed IPC (the thumbnail's and pin's controls, the dismiss timer
// pausing on hover, Settings → After a capture, the editor's Pin to Screen), and each page in dark,
// light and high contrast, with screenshots in $TMPDIR/test-quick-access.
// Exits non-zero on failure; the report is also written to $TMPDIR/test-quick-access.txt.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'preload.cjs');
const OUT = path.join(os.tmpdir(), 'test-quick-access');
const REPORT = path.join(os.tmpdir(), 'test-quick-access.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function report() {
  const failed = results.filter(r => !r.ok).length;
  return results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`).join('\n')
    + `\n\n${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed`;
}

if (process.versions.electron && process.type === 'browser') runPages();
else runMainProcess();

// ── Part 1: main.js against a stand-in for Electron ──────────────────────────
function runMainProcess() {
  const Module = require('module');
  const MAIN = path.join(ROOT, 'main.js');
  const REAL_HOME = process.env.HOME;
  // A Retina laptop with a menu bar and Dock, and a standard-resolution screen to its right.
  const DISPLAYS = [
    { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 } },
    { id: 2, scaleFactor: 1, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1050 } },
  ];
  const inside = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  console.error = () => {};   // main.js echoes everything it logs

  // Stand-in images: "FAKEIMG <w>x<h>" in a data URL, or in a file written from one.
  const fakeImageURL = (w, h) => `data:image/png;base64,${Buffer.from(`FAKEIMG ${w}x${h}`).toString('base64')}`;
  class FakeImage {
    constructor(width, height) { this.width = width; this.height = height; }
    static parse(text) {
      const m = /^FAKEIMG (\d+)x(\d+)/.exec(text || '');
      return m ? new FakeImage(+m[1], +m[2]) : new FakeImage(0, 0);
    }
    isEmpty() { return !(this.width > 0 && this.height > 0); }
    getSize() { return { width: this.width, height: this.height }; }
    crop(r) { return new FakeImage(r.width, r.height); }
    resize({ width, height }) {
      const w = width ?? Math.round(this.width * height / this.height);
      return new FakeImage(w, height ?? Math.round(this.height * w / this.width));
    }
    toDataURL() { return fakeImageURL(this.width, this.height); }
  }
  const imageOf = url => FakeImage.parse(Buffer.from(String(url).replace(/^data:image\/\w+;base64,/, ''), 'base64').toString());

  function loadMain() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-quick-test-'));
    const env = { tmp, home: path.join(tmp, 'home'), handle: {}, on: {}, windows: [], clipboard: [], drags: [], focus: [], cursor: { x: 700, y: 400 } };
    fs.mkdirSync(env.home);
    process.env.HOME = env.home;   // os.homedir() → the captures folder
    let nextId = 1;

    class FakeWindow {
      constructor(options = {}) {
        this.options = options;
        this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 800, height: options.height ?? 600 };
        this.events = {};
        this.contentsEvents = {};
        this.visible = false;
        this.opacity = 1;
        this.destroyed = false;
        const win = this;
        this.webContents = {
          id: nextId++, sent: [],
          // Like Electron: arguments that can't be serialized are dropped.
          send: (channel, ...args) => { try { structuredClone(args); win.webContents.sent.push({ channel, args }); } catch {} },
          on: (ev, fn) => { (win.contentsEvents[ev] ||= []).push({ fn }); },
          once: (ev, fn) => { (win.contentsEvents[ev] ||= []).push({ fn, once: true }); },
          startDrag: item => env.drags.push({ win, item }),
          setZoomFactor() {}, getURL: () => win.url || '', reload() {}, isDestroyed: () => win.destroyed,
        };
        env.windows.push(this);
      }
      emitContents(ev) {
        const handlers = this.contentsEvents[ev] || [];
        this.contentsEvents[ev] = handlers.filter(h => !h.once);
        handlers.forEach(h => h.fn());
      }
      loadFile(file) { this.url = `file://${file}`; setTimeout(() => { if (!this.destroyed) this.emitContents('did-finish-load'); }, 5); }
      on(ev, fn) { (this.events[ev] ||= []).push(fn); }
      once(ev, fn) { this.on(ev, fn); }
      show() { this.visible = true; this.shownWith = 'show'; }
      showInactive() { this.visible = true; this.shownWith = 'showInactive'; }
      hide() { this.visible = false; }
      isVisible() { return this.visible; }
      focus() {}
      setBackgroundColor() {}
      setAlwaysOnTop(flag, level) { this.alwaysOnTop = { flag, level }; }
      setVisibleOnAllWorkspaces(visible, options) { this.allWorkspaces = { visible, ...options }; }
      setContentProtection(on) { this.contentProtection = on; }
      setAspectRatio(ratio) { this.aspectRatio = ratio; }
      setOpacity(value) { this.opacity = value; }
      getOpacity() { return this.opacity; }
      setBounds(bounds, animate) { Object.assign(this.bounds, bounds); this.animated = !!animate; }
      getBounds() { return { ...this.bounds }; }
      setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
      getPosition() { return [this.bounds.x, this.bounds.y]; }
      close() {
        if (this.destroyed) return;
        this.destroyed = true;
        (this.events.closed || []).forEach(fn => fn());
      }
      destroy() { this.close(); }
      isDestroyed() { return this.destroyed; }
    }
    new FakeWindow();   // an already-open window, so broadcasts have somewhere to go

    const electron = {
      app: {
        getPath: name => path.join(tmp, name), whenReady: () => new Promise(() => {}), isReady: () => true,
        on() {}, focus: options => env.focus.push(options), isPackaged: false,
        commandLine: { hasSwitch: () => false }, getVersion: () => '1.0.0', getLocale: () => 'en-US', getAppPath: () => ROOT,
        getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {},
      },
      BrowserWindow: Object.assign(FakeWindow, {
        getAllWindows: () => env.windows.filter(w => !w.destroyed),
        fromWebContents: contents => env.windows.find(w => w.webContents === contents) || null,
      }),
      Tray: class {}, Menu: { buildFromTemplate: () => ({}) },
      globalShortcut: { register: () => true, unregisterAll() {} },
      ipcMain: { handle: (c, f) => { env.handle[c] = f; }, on: (c, f) => { env.on[c] = f; }, once() {}, removeListener() {} },
      screen: {
        getCursorScreenPoint: () => ({ ...env.cursor }),
        getDisplayNearestPoint: p => DISPLAYS.find(d => inside(p, d.bounds)) || DISPLAYS[0],
        getDisplayMatching: r => DISPLAYS.find(d => inside({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, d.bounds)) || DISPLAYS[0],
        getPrimaryDisplay: () => DISPLAYS[0],
        getAllDisplays: () => DISPLAYS,
      },
      clipboard: { writeImage: image => env.clipboard.push(image) },
      nativeImage: {
        createFromDataURL: url => imageOf(url),
        createFromPath: file => { try { return FakeImage.parse(fs.readFileSync(file, 'utf8')); } catch { return new FakeImage(0, 0); } },
      },
      desktopCapturer: {}, systemPreferences: {}, ShareMenu: class {},
      nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
      dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true }) },
      shell: { openPath: async () => '', showItemInFolder() {}, openExternal: async () => {}, trashItem: async () => {} },
    };

    const load = Module._load;
    const before = { ex: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection') };
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
    try {
      const m = new Module(MAIN, module);
      m.filename = MAIN;
      m.paths = Module._nodeModulePaths(ROOT);
      m._compile(`${fs.readFileSync(MAIN, 'utf8')}\nmodule.exports.__test = { finishCapture, quickAccess };`, MAIN);
      Object.assign(env, m.exports.__test);
    } finally {
      Module._load = load;
      // main's process-level handlers would swallow this script's own errors
      process.listeners('uncaughtException').filter(l => !before.ex.includes(l)).forEach(l => process.removeListener('uncaughtException', l));
      process.listeners('unhandledRejection').filter(l => !before.rej.includes(l)).forEach(l => process.removeListener('unhandledRejection', l));
    }
    env.saveDir = path.join(env.home, 'Documents', "Jack's Picker");
    fs.mkdirSync(path.join(env.saveDir, '.annotations'), { recursive: true });
    env.settingsFile = path.join(tmp, 'userData', 'settings.json');
    return env;
  }

  const call = (m, channel, ...args) => m.handle[channel]({}, ...args);
  const pages = (m, name) => m.windows.filter(w => !w.destroyed && (w.url || '').endsWith(`/src/${name}`));
  const sentTo = (win, channel) => win.webContents.sent.filter(s => s.channel === channel).map(s => s.args[0]);
  const pngs = m => fs.readdirSync(m.saveDir).filter(f => f.endsWith('.png'));
  const secure = o => o.webPreferences?.preload === PRELOAD && o.webPreferences.contextIsolation === true && o.webPreferences.nodeIntegration === false;

  async function settingTests() {
    const m = loadMain();
    check('setting: new captures open the editor by default', (await call(m, 'settings-get')).afterCapture === 'editor');
    check('setting: unknown values fall back to the editor', (await call(m, 'settings-set', { afterCapture: 'popup' })).afterCapture === 'editor');
    const r = await call(m, 'settings-set', { afterCapture: 'thumbnail' });
    check('setting: "thumbnail" is saved', r.afterCapture === 'thumbnail' && JSON.parse(fs.readFileSync(m.settingsFile, 'utf8')).afterCapture === 'thumbnail');
    check('setting: other changes keep it', (await call(m, 'settings-set', { appearance: { theme: 'light' } })).afterCapture === 'thumbnail');
    check('setting: windows are told', m.windows.some(w => sentTo(w, 'settings-changed').some(s => s.afterCapture === 'thumbnail')));
  }

  async function editorByDefault() {
    const m = loadMain();
    m.finishCapture(fakeImageURL(2880, 1800), null, DISPLAYS[0]);
    await wait(30);
    const [editor] = pages(m, 'editor.html');
    check('editor setting: finishCapture opens the capture in the editor', editor && sentTo(editor, 'image-data')[0]?.savedFilePath === path.join(m.saveDir, pngs(m)[0]));
    check('editor setting: no thumbnail', pages(m, 'thumbnail.html').length === 0);
  }

  async function thumbnailAfterCapture() {
    const m = loadMain();
    await call(m, 'settings-set', { afterCapture: 'thumbnail', autoCopyAfterCapture: true });
    m.on['hud-history']();   // an editor is already open, showing something else
    const [editor] = pages(m, 'editor.html');
    await wait(20);
    m.finishCapture(fakeImageURL(2880, 1800), null, DISPLAYS[0]);
    await wait(30);
    const [thumb] = pages(m, 'thumbnail.html');
    const o = thumb?.options || {}, b = thumb?.bounds || {};
    const area = DISPLAYS[0].workArea;
    check('thumbnail: shown instead of the editor', thumb && sentTo(editor, 'image-data').length === 0);
    check('thumbnail: frameless, always on top, never takes focus', o.frame === false && o.alwaysOnTop === true && o.focusable === false
      && o.acceptFirstMouse === true && o.skipTaskbar === true && o.resizable === false && thumb.alwaysOnTop?.level === 'floating'
      && (process.platform !== 'darwin' || o.type === 'panel'), JSON.stringify(o));
    check('thumbnail: preload with context isolation', secure(o));
    check('thumbnail: on every Space, and kept out of the next capture', thumb?.allWorkspaces?.visible === true
      && thumb.allWorkspaces.visibleOnFullScreen === true && thumb.contentProtection === true);
    check('thumbnail: sized to the capture', b.width === 216 && b.height === 135 + 34, JSON.stringify(b));
    check('thumbnail: bottom-right corner of the display the capture came from', b.x + b.width === area.x + area.width - 16
      && b.y + b.height === area.y + area.height - 16, JSON.stringify(b));
    const data = thumb && sentTo(thumb, 'thumbnail-data')[0];
    check('thumbnail: gets a preview sized for the display (2×) and the 6 s delay', data && imageOf(data.preview).width === 432
      && data.dismissAfterMs === 6000, JSON.stringify(data));
    check('thumbnail: appears without taking focus', thumb?.shownWith === 'showInactive');
    check('thumbnail: auto-copy still applies', m.clipboard.length === 1 && m.clipboard[0].width === 2880);
    check('thumbnail: the capture is saved', pngs(m).length === 1);
    check('thumbnail: an open editor refreshes Recents', sentTo(editor, 'captures-changed').length === 1);

    // Several quick captures stack up.
    m.finishCapture(fakeImageURL(1200, 800), null, DISPLAYS[0]);
    m.finishCapture(fakeImageURL(800, 3000), null, DISPLAYS[0]);   // a tall scrolling capture
    await wait(30);
    const stack = pages(m, 'thumbnail.html');
    const newestFirst = [...stack].reverse();
    check('stacking: one thumbnail per capture', stack.length === 3);
    check('stacking: every capture is saved, even within one second', pngs(m).length === 3, pngs(m).join());
    check('stacking: newest in the corner, older ones above it, none overlapping', newestFirst.every((w, i) => (i === 0
      ? w.bounds.y + w.bounds.height === area.y + area.height - 16
      : w.bounds.y + w.bounds.height + 10 === newestFirst[i - 1].bounds.y) && w.bounds.x + w.bounds.width === area.x + area.width - 16),
    JSON.stringify(newestFirst.map(w => w.bounds)));
    check('stacking: a tall capture’s thumbnail is capped', newestFirst[0].bounds.height === 200 + 34);
    check('stacking: thumbnails already on screen slide up (animated)', stack[0].animated === true && newestFirst[0].animated === false);

    const before = stack.map(w => JSON.stringify(w.bounds));
    m.finishCapture(fakeImageURL(1920, 1080), null, DISPLAYS[1]);
    await wait(30);
    const other = pages(m, 'thumbnail.html').find(w => !stack.includes(w));
    const area2 = DISPLAYS[1].workArea;
    check('stacking: another display gets its own corner and stack', other && other.bounds.x + other.bounds.width === area2.x + area2.width - 16
      && other.bounds.y + other.bounds.height === area2.y + area2.height - 16 && stack.every((w, i) => JSON.stringify(w.bounds) === before[i]));

    for (let i = 0; i < 4; i++) m.finishCapture(fakeImageURL(1600, 1000), null, DISPLAYS[0]);
    await wait(30);
    const onFirst = pages(m, 'thumbnail.html').filter(w => w.bounds.x < DISPLAYS[1].bounds.x);
    const height = onFirst.reduce((sum, w) => sum + w.bounds.height + 10, -10);
    check('stacking: at most five, never taller than the screen, oldest closed first', onFirst.length <= 5 && height <= area.height - 32
      && stack[0].destroyed && !onFirst.includes(stack[0]), `${onFirst.length} thumbnails, ${height}px`);
  }

  async function thumbnailActions() {
    const m = loadMain();
    await call(m, 'settings-set', { afterCapture: 'thumbnail' });
    const capture = (w, h) => { m.finishCapture(fakeImageURL(w, h), null, DISPLAYS[0]); return pages(m, 'thumbnail.html').at(-1); };
    const fileOf = win => m.quickAccess.thumbnails.find(t => t.win === win)?.filePath;
    const act = (win, action) => m.on['thumbnail-action']({ sender: win.webContents }, action);
    const area = DISPLAYS[0].workArea;
    const a = capture(1000, 600), b = capture(1100, 600), c = capture(1200, 600);
    await wait(30);
    const fileC = fileOf(c);

    act(a, 'copy');
    check('thumbnail Copy: the capture goes to the clipboard; the thumbnail stays', m.clipboard.at(-1)?.width === 1000 && !a.destroyed);
    act(b, 'close');
    check('thumbnail ✕: closes it, and the others close the gap', b.destroyed && c.bounds.y + c.bounds.height === area.y + area.height - 16
      && a.bounds.y + a.bounds.height + 10 === c.bounds.y, JSON.stringify([a.bounds, c.bounds]));

    m.cursor = { x: a.bounds.x + 20, y: a.bounds.y + 20 };
    act(a, 'dismiss');
    check('dismiss: kept while the cursor is over it (macOS sends no hover to inactive apps)', !a.destroyed);
    m.cursor = { x: 10, y: 400 };
    act(a, 'dismiss');
    check('dismiss: closes once the cursor is elsewhere', a.destroyed);

    act(c, 'edit');
    await wait(30);
    const [editor] = pages(m, 'editor.html');
    check('thumbnail Edit: opens that capture in the editor, in front, and closes the thumbnail', c.destroyed && editor
      && sentTo(editor, 'image-data')[0]?.savedFilePath === fileC && (process.platform !== 'darwin' || m.focus.some(f => f?.steal === true)));

    const d = capture(900, 700);
    await wait(20);
    act(d, 'pin');
    await wait(30);
    const [pin] = pages(m, 'pin.html');
    check('thumbnail Pin: pins the capture and closes the thumbnail', d.destroyed && pin && sentTo(pin, 'pin-data')[0]?.width === 900);

    const e = capture(1280, 720);
    await wait(20);
    const fileE = fileOf(e);
    m.on['thumbnail-drag']({ sender: e.webContents });
    const drag = m.drags.at(-1);
    check('thumbnail drag: drags the saved file out, with the preview as its icon', drag?.win === e && drag.item.file === fileE
      && fs.existsSync(fileE) && !drag.item.icon.isEmpty());
    act(e, 'dismiss');
    check('thumbnail drag: dismissed soon after, it’s hidden (the drop may still be coming), not closed', !e.destroyed && !e.visible
      && !m.quickAccess.thumbnails.some(t => t.win === e));

    const f = capture(1000, 600);
    await wait(20);
    const clips = m.clipboard.length, drags = m.drags.length;
    m.on['thumbnail-action']({ sender: editor.webContents }, 'copy');
    m.on['thumbnail-action']({ sender: editor.webContents }, 'close');
    m.on['thumbnail-drag']({ sender: editor.webContents });
    ['toString', '__proto__', 'constructor', null, { action: 'copy' }].forEach(x => act(f, x));
    check('thumbnail IPC: other windows and unknown actions are ignored', m.clipboard.length === clips && m.drags.length === drags
      && !f.destroyed && !editor.destroyed);
    fs.unlinkSync(fileOf(f));
    m.on['thumbnail-drag']({ sender: f.webContents });
    act(f, 'copy');
    check('thumbnail: a capture deleted meanwhile is neither dragged nor copied', m.drags.length === drags && m.clipboard.length === clips);
  }

  async function pinTests() {
    const m = loadMain();
    const shot = path.join(m.saveDir, 'screenshot-1.png');
    fs.writeFileSync(shot, 'FAKEIMG 800x600');
    const area = DISPLAYS[0].workArea;
    const r = await call(m, 'pin-open', { filePath: shot });
    await wait(30);
    const [pin] = pages(m, 'pin.html');
    const o = pin?.options || {};
    check('pin: opens for a capture', r?.success === true && pin);
    check('pin: borderless, resizable, always on top', o.frame === false && o.resizable === true && o.alwaysOnTop === true
      && o.skipTaskbar === true && pin.alwaysOnTop?.level === 'floating', JSON.stringify(o));
    check('pin: on every Space, full-screen apps included', pin?.allWorkspaces?.visible === true && pin.allWorkspaces.visibleOnFullScreen === true);
    check('pin: preload with context isolation', secure(o));
    check('pin: 1:1 on a Retina screen (800×600 px → 400×300 pt), centred', pin?.bounds.width === 400 && pin.bounds.height === 300
      && pin.bounds.x === Math.round(area.x + (area.width - 400) / 2) && pin.bounds.y === Math.round(area.y + (area.height - 300) / 2),
    JSON.stringify(pin?.bounds));
    check('pin: resizing keeps the image’s aspect ratio', Math.abs(pin?.aspectRatio - 800 / 600) < 1e-9);
    const data = pin && sentTo(pin, 'pin-data')[0];
    check('pin: gets the full image', data?.width === 800 && data.height === 600 && imageOf(data.dataURL).width === 800 && data.opacity === 1);
    check('pin: shown with focus, so Esc and ⌘1–⌘9 work', pin?.shownWith === 'show');

    await call(m, 'pin-open', { filePath: shot });
    await wait(30);
    const [, second] = pages(m, 'pin.html');
    check('pin: several can be open, each a little lower right', second && second.bounds.x === pin.bounds.x + 24 && second.bounds.y === pin.bounds.y + 24);

    m.cursor = { x: 2000, y: 500 };
    fs.writeFileSync(path.join(m.saveDir, 'screenshot-big.png'), 'FAKEIMG 5000x4000');
    await call(m, 'pin-open', { filePath: path.join(m.saveDir, 'screenshot-big.png') });
    await wait(30);
    const bb = pages(m, 'pin.html').at(-1).bounds, area2 = DISPLAYS[1].workArea;
    check('pin: a big image is clamped to the screen it opens on, aspect kept', bb.width <= area2.width - 80 && bb.height <= area2.height - 80
      && inside(bb, area2) && Math.abs(bb.width / bb.height - 1.25) < 0.01, JSON.stringify(bb));
    m.cursor = { x: 700, y: 400 };

    fs.writeFileSync(path.join(m.saveDir, '.annotations', 'screenshot-1.flat.png'), 'FAKEIMG 1000x700');
    await call(m, 'pin-open', { filePath: shot });
    await wait(30);
    check('pin: an annotated capture is pinned with its annotations', sentTo(pages(m, 'pin.html').at(-1), 'pin-data')[0]?.width === 1000);

    const linked = path.join(m.tmp, 'Client');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'screenshot-1.png'), 'FAKEIMG 640x480');
    fs.mkdirSync(path.dirname(m.settingsFile), { recursive: true });
    fs.writeFileSync(m.settingsFile, JSON.stringify({ projectFolders: { p1: { path: linked } } }));
    const fromLinked = await call(m, 'pin-open', { filePath: path.join(linked, 'screenshot-1.png') });
    await wait(30);
    check('pin: an image in a linked project folder, as it is (not a same-named capture’s annotations)', fromLinked.success
      && sentTo(pages(m, 'pin.html').at(-1), 'pin-data')[0]?.width === 640);

    fs.writeFileSync(path.join(m.saveDir, 'recording-1.mp4'), 'FAKEIMG 640x480');
    fs.writeFileSync(path.join(m.tmp, 'outside.png'), 'FAKEIMG 100x100');
    const count = pages(m, 'pin.html').length;
    const refused = [];
    for (const bad of [
      { filePath: path.join(m.tmp, 'outside.png') },
      { filePath: path.join(m.saveDir, '..', '..', '..', 'outside.png') },
      { filePath: path.join(m.saveDir, 'recording-1.mp4') },
      { filePath: path.join(m.saveDir, 'missing.png') },
      { filePath: 42 },
      { dataURL: 'javascript:alert(1)' },
      { dataURL: `data:text/html;base64,${Buffer.from('<b>x</b>').toString('base64')}` },
      { dataURL: 'data:image/png;base64,' },
      null, 'screenshot-1.png',
    ]) refused.push((await call(m, 'pin-open', bad))?.success);
    await wait(30);
    check('pin: refuses paths outside the captures folder, media, missing files and non-image data', refused.every(s => s === false)
      && pages(m, 'pin.html').length === count, JSON.stringify(refused));

    const fromEditor = await call(m, 'pin-open', { dataURL: fakeImageURL(640, 400) });
    await wait(30);
    check('pin: the editor’s current image (a data URL)', fromEditor.success && sentTo(pages(m, 'pin.html').at(-1), 'pin-data')[0]?.height === 400);

    const send = (win, channel, arg) => m.on[channel]({ sender: win.webContents }, arg);
    send(pin, 'pin-opacity', 0.5);
    const half = pin.opacity;
    send(pin, 'pin-opacity', 0);
    const floor = pin.opacity;
    send(pin, 'pin-opacity', 'x');
    check('pin opacity: set from the page, never below 10%', half === 0.5 && floor === 0.1 && pin.opacity === 1, `${half} ${floor} ${pin.opacity}`);

    const start = { ...pin.bounds };
    send(pin, 'pin-move', { phase: 'start', dx: 0, dy: 0 });
    send(pin, 'pin-move', { phase: 'move', dx: 30, dy: -20 });
    send(pin, 'pin-move', { phase: 'move', dx: 45, dy: -25 });
    send(pin, 'pin-move', { phase: 'end', dx: 45, dy: -25 });
    send(pin, 'pin-move', { phase: 'move', dx: 500, dy: 500 });   // no drag in progress
    check('pin move: follows the pointer’s travel since it went down', pin.bounds.x === start.x + 45 && pin.bounds.y === start.y - 25
      && pin.bounds.width === start.width, JSON.stringify(pin.bounds));

    const was = { ...pin.bounds };
    const centre = bounds => [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
    send(pin, 'pin-zoom', { factor: 1.5, x: 0.5, y: 0.5 });
    check('pin zoom: grows around the pointer, aspect kept', pin.bounds.width === 600 && pin.bounds.height === 450
      && centre(pin.bounds).every((v, i) => Math.abs(v - centre(was)[i]) <= 1), JSON.stringify(pin.bounds));
    for (let i = 0; i < 20; i++) send(pin, 'pin-zoom', { factor: 2, x: 0, y: 0 });
    check('pin zoom: never bigger than the screen', pin.bounds.width <= area.width && pin.bounds.height <= area.height, JSON.stringify(pin.bounds));
    for (let i = 0; i < 20; i++) send(pin, 'pin-zoom', { factor: 0.5, x: 1, y: 1 });
    check('pin zoom: never smaller than 40 pt', Math.min(pin.bounds.width, pin.bounds.height) === 40, JSON.stringify(pin.bounds));
    send(pin, 'pin-zoom', { factor: 1e9, x: 'left' });
    check('pin zoom: at most 2× per step', pin.bounds.height === 80, JSON.stringify(pin.bounds));

    const other = m.windows[0];
    const snapshot = JSON.stringify(pin.bounds);
    send(other, 'pin-opacity', 0.3);
    send(other, 'pin-move', { phase: 'start' });
    send(other, 'pin-move', { phase: 'move', dx: 99, dy: 99 });
    send(other, 'pin-zoom', { factor: 2 });
    send(other, 'pin-close');
    check('pin IPC: other windows can’t move, zoom, fade or close a pin', pin.opacity === 1 && JSON.stringify(pin.bounds) === snapshot
      && !pin.destroyed && !other.destroyed);
    send(pin, 'pin-close');
    check('pin: closes when asked (✕, Esc, double-click)', pin.destroyed && !m.quickAccess.pins.has(pin.webContents.id));
  }

  function runPagesInElectron() {
    const { spawnSync } = require('child_process');
    const resultsFile = path.join(os.tmpdir(), `test-quick-access-pages-${process.pid}.json`);
    const env = { ...process.env, QUICK_ACCESS_RESULTS: resultsFile };
    delete env.ELECTRON_RUN_AS_NODE;   // otherwise Electron runs as plain Node
    const run = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', timeout: 4 * 60 * 1000 });
    let pageResults = null;
    try { pageResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); fs.unlinkSync(resultsFile); } catch {}
    if (!pageResults) {
      check('pages: the Electron harness ran', false, `exit ${run.status} ${run.error || ''}\n${String(run.stderr || '').slice(-2000)}`);
      return;
    }
    results.push(...pageResults);
  }

  (async () => {
    try {
      await settingTests();
      await editorByDefault();
      await thumbnailAfterCapture();
      await thumbnailActions();
      await pinTests();
    } catch (e) {
      check('main-process harness ran to completion', false, e.stack);
    }
    process.env.HOME = REAL_HOME;
    runPagesInElectron();
    const text = report();
    fs.writeFileSync(REPORT, `${text}\n`);
    console.log(text);
    process.exit(results.some(r => !r.ok) ? 1 : 0);
  })();
}

// ── Part 2: the real pages, offscreen, with stubbed IPC ──────────────────────
function runPages() {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
  const DARK = { theme: 'dark', accent: 'purple', highContrast: false };
  const APPEARANCES = {
    dark: DARK,
    light: { theme: 'light', accent: 'purple', highContrast: false },
    'dark-hc': { theme: 'dark', accent: 'purple', highContrast: true },
    'light-hc': { theme: 'light', accent: 'teal', highContrast: true },
  };
  const OLD = "/Users/x/Documents/Jack's Picker";
  const IMAGE_ITEM = { filename: 'screenshot-1.png', filePath: `${OLD}/screenshot-1.png`, fileURL: 'file://x', kind: 'image', annotations: [], time: 2 };
  const GIF_ITEM = { filename: 'recording-1.gif', filePath: `${OLD}/recording-1.gif`, fileURL: 'file://y', kind: 'gif', annotations: [], time: 1 };
  const S = {
    appearance: DARK, editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
    recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800 },
    autoCopyAfterCapture: false, afterCapture: 'editor', launchAtLogin: false, launchAtLoginAvailable: false,
    capturesFolder: { path: OLD, isDefault: true, defaultPath: OLD },
  };
  const got = [];            // what the pages sent: { channel, arg, id }
  const sets = [];
  const errors = [];
  let pinResult = { success: true };
  let galleryLists = 0;
  let current = null;

  // A stand-in screenshot: a window with a header, a sidebar and lines of text.
  function sampleImage(w, h) {
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = [250, 250, 252];
      if (y < h * 0.12) c = [108, 78, 246];
      else if (x < w * 0.22) c = [236, 237, 243];
      else if (y % 24 < 8 && x > w * 0.28 && x < w * (0.6 + ((y * 7) % 30) / 100)) c = [196, 198, 210];
      const i = (y * w + x) * 4;
      buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = 255;   // BGRA
    }
    return nativeImage.createFromBitmap(buf, { width: w, height: h });
  }
  const PREVIEW = sampleImage(432, 270).toDataURL();
  const SAMPLE = sampleImage(800, 600).toDataURL();

  ipcMain.handle('settings-get', () => S);
  ipcMain.handle('settings-set', (_e, patch) => {
    sets.push(patch);
    for (const key of ['appearance', 'editor', 'recording']) if (patch[key]) S[key] = { ...S[key], ...patch[key] };
    if ('afterCapture' in patch) S.afterCapture = patch.afterCapture;
    current?.webContents.send('settings-changed', S);
    return S;
  });
  ipcMain.handle('pin-open', (e, source) => { got.push({ channel: 'pin-open', arg: source, id: e.sender.id }); return pinResult; });
  ipcMain.handle('gallery-list', () => { galleryLists++; return [IMAGE_ITEM, GIF_ITEM].map(i => ({ ...i, thumb: PREVIEW })); });
  ipcMain.handle('app-info', () => ({ version: '1.0.0', packaged: false, buildTime: '2026-09-28T12:00:00.000Z' }));
  ipcMain.handle('project-folders', () => ({}));
  ipcMain.handle('shortcuts-get', () => ({ defaults: {}, shortcuts: {} }));
  ['thumbnail-action', 'thumbnail-drag', 'pin-move', 'pin-zoom', 'pin-opacity', 'pin-close']
    .forEach(channel => ipcMain.on(channel, (e, arg) => got.push({ channel, arg, id: e.sender.id })));
  // Everything else the pages invoke answers null, as in test-theme.cjs.
  const preloadSource = fs.readFileSync(PRELOAD, 'utf8');
  const stubbed = new Set(['settings-get', 'settings-set', 'pin-open', 'gallery-list', 'app-info', 'project-folders', 'shortcuts-get']);
  [...preloadSource.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]).filter(c => !stubbed.has(c))
    .forEach(c => { stubbed.add(c); ipcMain.handle(c, () => null); });

  function openPage(file, size) {
    const win = new BrowserWindow({
      show: false, frame: false, ...size,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
        partition: `quick-access-${Math.random().toString(36).slice(2)}`,   // fresh localStorage (theme cache) per page
      },
    });
    win.webContents.on('console-message', (e, ...legacy) => {
      const level = e.level ?? legacy[0], message = e.message ?? legacy[1];
      if (level === 'error' || level === 3 || /Content Security Policy|Refused to/i.test(message)) errors.push(`${file}: ${message}`);
    });
    current = win;
    return win;
  }

  const js = (win, code) => win.webContents.executeJavaScript(code);
  const center = (win, selector) => js(win, `(r => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }))(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`);
  const mouse = (win, type, at, extra = {}) => win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...at, ...extra });
  async function clickAt(win, selector) {
    const at = await center(win, selector);
    mouse(win, 'mouseMove', at);
    mouse(win, 'mouseDown', at);
    mouse(win, 'mouseUp', at);
    await wait(150);
  }
  const noAnimations = win => win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');

  async function openThumbnail(dismissAfterMs, appearance = DARK) {
    S.appearance = appearance;
    const w = openPage('thumbnail.html', { width: 216, height: 169 });
    await w.loadFile(path.join(ROOT, 'src', 'thumbnail.html'));
    await noAnimations(w);
    w.webContents.send('thumbnail-data', { preview: PREVIEW, dismissAfterMs });
    await wait(200);
    return w;
  }

  async function openPin(appearance = DARK) {
    S.appearance = appearance;
    const w = openPage('pin.html', { width: 400, height: 300 });
    await w.loadFile(path.join(ROOT, 'src', 'pin.html'));
    await noAnimations(w);
    w.webContents.send('pin-data', { dataURL: SAMPLE, width: 800, height: 600, opacity: 1 });
    await wait(200);
    return w;
  }

  async function thumbnailPage() {
    let w = await openThumbnail(60_000);
    const id = w.webContents.id;
    const actions = () => got.filter(g => g.id === id && g.channel === 'thumbnail-action').map(g => g.arg);
    check('thumbnail page: shows the preview', (await js(w, `document.getElementById('preview').naturalWidth`)) === 432);
    await clickAt(w, '#btn-copy');
    check('thumbnail page: Copy sends "copy" and says Copied', actions().join() === 'copy' && (await js(w, `document.getElementById('btn-copy').textContent`)) === 'Copied');
    await clickAt(w, '#btn-edit');
    await clickAt(w, '#btn-pin');
    await clickAt(w, '#btn-close');
    await clickAt(w, '#shot');
    check('thumbnail page: Edit, Pin, ✕ and a click on the image send edit, pin, close, edit', actions().join() === 'copy,edit,pin,close,edit', actions().join());
    const prevented = await js(w, `(() => { const e = new DragEvent('dragstart', { bubbles: true, cancelable: true }); document.getElementById('shot').dispatchEvent(e); return e.defaultPrevented; })()`);
    await wait(100);
    check('thumbnail page: dragging the image asks main for a file drag', prevented && got.some(g => g.id === id && g.channel === 'thumbnail-drag'));
    w.destroy();

    // The dismiss timer
    w = await openThumbnail(500);
    let wid = w.webContents.id;
    const dismisses = () => got.filter(g => g.id === wid && g.arg === 'dismiss').length;
    await wait(650);
    const first = dismisses();
    await wait(1100);
    check('dismiss timer: asks after the delay, then again each second while main keeps it', first === 1 && dismisses() === 2, `${first}, then ${dismisses()}`);
    w.destroy();

    w = await openThumbnail(700);
    wid = w.webContents.id;
    mouse(w, 'mouseMove', { x: 100, y: 60 });
    await wait(1300);
    check('dismiss timer: paused while the pointer is over it', dismisses() === 0, dismisses());
    mouse(w, 'mouseLeave', { x: -5, y: -5 });
    await wait(1000);
    check('dismiss timer: restarts when the pointer leaves', dismisses() === 1, dismisses());
    mouse(w, 'mouseMove', { x: 100, y: 60 });
    await wait(200);
    const hovered = dismisses();
    await js(w, `document.getElementById('shot').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); 0`);
    await wait(1000);
    check('dismiss timer: restarts when a drag begins, even while hovered', dismisses() === hovered + 1, `${hovered} → ${dismisses()}`);
    w.destroy();
  }

  async function pinPage() {
    const w = await openPin();
    const id = w.webContents.id;
    const mine = channel => got.filter(g => g.id === id && g.channel === channel).map(g => g.arg);
    check('pin page: shows the image', (await js(w, `document.getElementById('image').naturalWidth`)) === 800);
    const closeAt = await center(w, '#btn-close');
    await js(w, `document.body.classList.remove('focused'); 0`);
    check('pin page: hidden controls don’t catch clicks', (await js(w, `document.elementFromPoint(${closeAt.x}, ${closeAt.y}).id`)) === 'image');
    mouse(w, 'mouseMove', { x: 200, y: 150 });
    await wait(150);
    check('pin page: the controls show while the pointer is over it', (await js(w, `getComputedStyle(document.getElementById('btn-close')).opacity`)) === '1'
      && (await js(w, `getComputedStyle(document.querySelector('.pin-opacity')).opacity`)) === '1');
    await clickAt(w, '#btn-close');
    check('pin page: ✕ closes', mine('pin-close').length === 1);

    const key = (keyCode, modifiers = []) => w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    key('Escape');
    await wait(100);
    check('pin page: Esc closes', mine('pin-close').length === 2);
    key('5', ['meta']);
    await wait(100);
    check('pin page: ⌘5 sets 50% opacity, shown on the slider', mine('pin-opacity').at(-1) === 0.5
      && (await js(w, `document.getElementById('opacity').value + '|' + document.getElementById('opacity-value').textContent`)) === '50|50%');
    key('0', ['meta']);
    await wait(100);
    check('pin page: ⌘0 makes it opaque again', mine('pin-opacity').at(-1) === 1);
    key('5');
    await wait(100);
    check('pin page: a digit without ⌘ does nothing', mine('pin-opacity').length === 2);
    await js(w, `(s => { s.value = 30; s.dispatchEvent(new Event('input', { bubbles: true })); })(document.getElementById('opacity')); 0`);
    check('pin page: the slider sets the opacity', mine('pin-opacity').at(-1) === 0.3);

    const spot = { x: 120, y: 200 };
    mouse(w, 'mouseDown', spot);
    mouse(w, 'mouseUp', spot);
    mouse(w, 'mouseDown', spot, { clickCount: 2 });
    mouse(w, 'mouseUp', spot, { clickCount: 2 });
    await wait(150);
    check('pin page: a double-click closes', mine('pin-close').length === 3);

    const movesBefore = mine('pin-move').length;
    mouse(w, 'mouseDown', { x: 100, y: 100, globalX: 1100, globalY: 600 });
    mouse(w, 'mouseMove', { x: 130, y: 80, globalX: 1130, globalY: 580, modifiers: ['leftButtonDown'] });
    mouse(w, 'mouseUp', { x: 130, y: 80, globalX: 1130, globalY: 580 });
    await wait(150);
    const moves = mine('pin-move').slice(movesBefore);
    check('pin page: dragging sends start, the pointer’s travel, then end', moves[0]?.phase === 'start'
      && moves.some(m => m.phase === 'move' && m.dx === 30 && m.dy === -20) && moves.at(-1)?.phase === 'end' && moves.at(-1).dx === 30, JSON.stringify(moves));

    const prevented = await js(w, `(() => {
      const img = document.getElementById('image');
      const scroll = new WheelEvent('wheel', { deltaY: -100, clientX: 100, clientY: 75, bubbles: true, cancelable: true });
      const pinch = new WheelEvent('wheel', { deltaY: 10, ctrlKey: true, clientX: 200, clientY: 150, bubbles: true, cancelable: true });
      img.dispatchEvent(scroll); img.dispatchEvent(pinch);
      return scroll.defaultPrevented && pinch.defaultPrevented;
    })()`);
    await wait(100);
    const [up, pinch] = mine('pin-zoom').slice(-2);
    check('pin page: scrolling up zooms in around the pointer', up && Math.abs(up.factor - Math.exp(0.2)) < 1e-9 && up.x === 0.25 && up.y === 0.25, JSON.stringify(up));
    check('pin page: a pinch zooms, and the page itself never scrolls or zooms', pinch && Math.abs(pinch.factor - Math.exp(-0.1)) < 1e-9 && prevented, JSON.stringify(pinch));
    const zooms = mine('pin-zoom').length;
    // In sendInputEvent a negative deltaY scrolls down, which zooms out.
    w.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 150, deltaX: 0, deltaY: -120, canScroll: true });
    await wait(200);
    check('pin page: real wheel input zooms too', mine('pin-zoom').length > zooms && mine('pin-zoom').at(-1).factor < 1, JSON.stringify(mine('pin-zoom').slice(zooms)));

    w.setSize(600, 450);
    await wait(250);
    const [text, on, width, ratio] = await js(w, `[document.getElementById('zoom').textContent, document.getElementById('zoom').classList.contains('on'), innerWidth, devicePixelRatio]`);
    check('pin page: shows the size against 1:1 after a resize', on && text === `${Math.round(width * ratio / 800 * 100)}%`, `${text} ${on} ${width} ${ratio}`);
    w.destroy();
  }

  async function editorPage() {
    S.appearance = DARK;
    const w = openPage('editor.html', { width: 1300, height: 850 });
    await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
    await wait(1200);
    const segment = () => js(w, `[...document.querySelectorAll('.sp-seg[aria-label="After a capture"] button')].map(b => b.textContent + ':' + b.getAttribute('aria-checked')).join('|')`);
    await js(w, `JPSettings.open('capture'); 0`);
    await wait(300);
    check('Settings → Capture: "After a capture", the editor by default', (await segment()) === 'Open the editor:true|Show a thumbnail:false', await segment());
    await js(w, `[...document.querySelectorAll('.sp-seg[aria-label="After a capture"] button')].find(b => b.textContent === 'Show a thumbnail').click(); 0`);
    await wait(300);
    const hint = await js(w, `[...document.querySelectorAll('.sp-row')].find(r => r.textContent.startsWith('After a capture')).querySelector('.sp-hint').textContent`);
    check('Settings → Capture: "Show a thumbnail" is saved and explained', sets.some(p => p.afterCapture === 'thumbnail')
      && (await segment()) === 'Open the editor:false|Show a thumbnail:true' && /thumbnail/i.test(hint), `${await segment()} / ${hint}`);
    await js(w, `JPSettings.close(); 0`);

    await js(w, `{ const c = document.createElement('canvas'); c.width = 400; c.height = 300; c.getContext('2d').fillRect(0, 0, 400, 300);
      loadImageWithAnns(c.toDataURL(), ${JSON.stringify(IMAGE_ITEM.filePath)}, [{ type: 'box', x: 20, y: 20, w: 100, h: 80, color: '#EF4444', sw: 6 }]); } 0`);
    await wait(400);
    const pinOpens = () => got.filter(g => g.channel === 'pin-open');
    const before = pinOpens().length;
    await js(w, `document.querySelector('.toolbar-menu:has(#btn-pin-screen)').open = true; document.getElementById('btn-pin-screen').click(); 0`);
    await wait(500);
    const sent = pinOpens().slice(before)[0]?.arg;
    const image = sent?.dataURL ? nativeImage.createFromDataURL(sent.dataURL) : null;
    const px = image ? image.toBitmap().subarray((50 * 400 + 20) * 4, (50 * 400 + 20) * 4 + 4) : [];   // on the box's left edge (BGRA)
    check('editor: Tools → Pin to Screen pins the image as it looks, annotations included', pinOpens().length === before + 1
      && image?.getSize().width === 400 && px[2] > 180 && px[1] < 120, JSON.stringify({ size: image?.getSize(), px: [...px] }));
    check('editor: …and closes the menu', !(await js(w, `[...document.querySelectorAll('.toolbar-menu')].some(m => m.open)`)));
    await js(w, `document.body.classList.add('video-mode'); 0`);
    check('editor: Pin to Screen is hidden in the video editor', (await js(w, `getComputedStyle(document.getElementById('btn-pin-screen')).display`)) === 'none');
    await js(w, `document.body.classList.remove('video-mode'); 0`);

    pinResult = { success: false };
    await js(w, `document.getElementById('btn-pin-screen').click(); 0`);
    await wait(500);
    check('editor: a pin that fails says so', (await js(w, `document.getElementById('toast').textContent`)) === 'Couldn’t pin that image');
    pinResult = { success: true };

    const labels = () => js(w, `[...document.querySelectorAll('#gallery-context button')].map(b => b.textContent)`);
    await js(w, `showGalleryContext(galleryItemsByPath.get(${JSON.stringify(IMAGE_ITEM.filePath)}), 100, 830); 0`);
    await wait(100);
    const imageMenu = await labels();
    const fits = await js(w, `(r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById('gallery-context').getBoundingClientRect())`);
    await js(w, `[...document.querySelectorAll('#gallery-context button')].find(b => b.textContent === 'Pin to Screen').click(); 0`);
    await wait(300);
    check('Recents: an image’s menu has Pin to Screen, which pins that capture', imageMenu.includes('Pin to Screen')
      && pinOpens().at(-1)?.arg?.filePath === IMAGE_ITEM.filePath, JSON.stringify(imageMenu));
    check('Recents: the menu stays inside the window near the bottom', fits);
    await js(w, `showGalleryContext(galleryItemsByPath.get(${JSON.stringify(GIF_ITEM.filePath)}), 100, 100); 0`);
    await wait(100);
    check('Recents: GIFs and recordings can’t be pinned', !(await labels()).includes('Pin to Screen'), JSON.stringify(await labels()));
    await js(w, `hideGalleryContext(); 0`);

    const lists = galleryLists;
    w.webContents.send('captures-changed');
    await wait(400);
    check('editor: Recents reloads when a capture is saved behind it', galleryLists > lists);

    await js(w, `bgImage = null; 0`);
    const count = pinOpens().length;
    await js(w, `document.getElementById('btn-pin-screen').click(); 0`);
    await wait(300);
    check('editor: with no image, nothing is pinned', pinOpens().length === count && (await js(w, `document.getElementById('toast').textContent`)) === 'No image loaded');
    w.destroy();
  }

  async function snap(win, name) {
    await js(win, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    win.webContents.invalidate();
    await wait(150);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }

  async function themes() {
    fs.mkdirSync(OUT, { recursive: true });
    const state = win => js(win, `({ theme: document.documentElement.dataset.theme, contrast: document.documentElement.dataset.contrast || null,
      body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.querySelector('button')).color })`);
    const seen = {};
    for (const [name, appearance] of Object.entries(APPEARANCES)) {
      const t = await openThumbnail(60_000, appearance);
      const p = await openPin(appearance);
      mouse(p, 'mouseMove', { x: 200, y: 150 });   // show the pin's controls
      await wait(150);
      const [ts, ps] = [await state(t), await state(p)];
      const ok = s => s.theme === appearance.theme && (s.contrast === 'high') === appearance.highContrast;
      check(`theme ${name}: both pages follow it`, ok(ts) && ok(ps), JSON.stringify({ ts, ps }));
      seen[name] = ts;
      await snap(t, `thumbnail-${name}`);
      await snap(p, `pin-${name}`);
      t.destroy();
      p.destroy();
    }
    check('theme: colours come from the theme tokens (dark and light differ, high contrast differs)', seen.dark.body !== seen.light.body
      && seen.dark.text !== seen['dark-hc'].text, JSON.stringify(seen));
  }

  function finish() {
    check('no page errors or CSP violations', errors.length === 0, JSON.stringify(errors));
    const file = process.env.QUICK_ACCESS_RESULTS;
    if (file) fs.writeFileSync(file, JSON.stringify(results));
    else fs.writeFileSync(REPORT, `${report()}\n`);
    process.stdout.write(file ? '' : `${report()}\n`, () => app.exit(results.some(r => !r.ok) ? 1 : 0));
  }

  app.on('window-all-closed', () => {});   // pages open one at a time
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide();
    const timer = setTimeout(() => { check('pages harness finished in time', false); finish(); }, 3 * 60 * 1000);
    try {
      await thumbnailPage();
      await pinPage();
      await editorPage();
      await themes();
    } catch (e) {
      check('pages harness ran to completion', false, e.stack);
    }
    clearTimeout(timer);
    finish();
  });
}
