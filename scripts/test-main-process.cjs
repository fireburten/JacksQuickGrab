// Tests main.js under plain Node with a stand-in for the electron module: the settings store,
// moving the captures folder, opening Settings, Trash-only delete, the error log, crash
// recovery and the packaged build's refusal of debugging switches.
//   node scripts/test-main-process.cjs
// Every case loads a fresh copy of main.js against its own temporary HOME, so nothing real is
// touched. Exits non-zero on failure.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = process.env.MAIN_JS || path.join(ROOT, 'main.js');   // MAIN_JS: test another copy
const REAL_HOME = process.env.HOME;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
console.error = () => {};   // main.js echoes everything it logs; the log file is what's checked

class ExitCalled extends Error {}

// Loads main.js against a fake electron and returns what it registered plus the fakes' records.
function loadMain({ packaged = false, switches = [], trash = 'ok' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-main-test-'));
  const env = {
    tmp, home: path.join(tmp, 'home'),
    handle: {}, on: {}, appOn: {}, sent: [], dialogs: [], exits: [], windows: [], shown: [], opened: [], registered: [], template: null,
  };
  fs.mkdirSync(env.home);
  process.env.HOME = env.home;   // os.homedir() → DEFAULT_SAVE_DIR

  // Like Electron: arguments that can't be serialized are dropped (Electron only logs it).
  const send = (channel, ...args) => {
    try { structuredClone(args); env.sent.push({ channel, args }); }
    catch (e) { env.sent.push({ channel, dropped: e.message }); }
  };
  let nextId = 1;
  class FakeWindow {
    constructor() {
      this.loadHandlers = [];
      this.reloads = 0;
      const win = this;
      this.webContents = {
        id: nextId++, send,
        once: (ev, fn) => { if (ev === 'did-finish-load') win.loadHandlers.push(fn); },
        setZoomFactor() {}, getURL: () => win.url || '', reload: () => { win.reloads++; }, isDestroyed: () => false,
      };
      env.windows.push(this);
    }
    loadFile(file) { this.url = 'file://' + file; setTimeout(() => this.loadHandlers.splice(0).forEach(fn => fn()), 5); }
    on() {} show() {} focus() {} setBackgroundColor() {} close() { this.closed = true; } destroy() {}
    isDestroyed() { return false; }
  }
  new FakeWindow();   // an already-open window, so broadcasts have somewhere to go

  const electron = {
    app: {
      getPath: name => path.join(tmp, name), whenReady: () => new Promise(() => {}), isReady: () => true,
      on: (ev, fn) => { (env.appOn[ev] ||= []).push(fn); }, focus() {},
      isPackaged: packaged, commandLine: { hasSwitch: name => switches.includes(name) },
      getVersion: () => '1.0.0', getAppPath: () => ROOT,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings() { throw new Error('must not register a dev build as a login item'); },
    },
    BrowserWindow: Object.assign(FakeWindow, {
      getAllWindows: () => env.windows,
      fromWebContents: contents => env.windows.find(w => w.webContents === contents) || null,
    }),
    Tray: class {}, Menu: { buildFromTemplate: t => { env.template = t; return {}; } },
    globalShortcut: { register: accelerator => { env.registered.push(accelerator); return true; }, unregisterAll: () => { env.registered.length = 0; } },
    ipcMain: {
      handle: (c, f) => { env.handle[c] = f; }, on: (c, f) => { env.on[c] = f; }, once() {}, removeListener() {},
    },
    screen: {}, clipboard: {}, nativeImage: {}, desktopCapturer: {}, systemPreferences: {}, ShareMenu: class {},
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [env.chooseDir], bookmarks: [] }),
      showMessageBox: async (...args) => { env.dialogs.push(args.find(a => a && a.message)); return { response: 0 }; },
    },
    shell: {
      trashItem: async file => {
        if (trash !== 'ok') throw new Error('The operation couldn’t be completed.');
        fs.mkdirSync(path.join(tmp, 'Trash'), { recursive: true });
        fs.renameSync(file, path.join(tmp, 'Trash', path.basename(file)));
      },
      showItemInFolder: file => env.shown.push(file), openPath: async dir => { env.shown.push(dir); return ''; },
      openExternal: async url => { env.opened.push(url); },
    },
  };
  env.electron = electron;

  const load = Module._load;
  const exit = process.exit;
  const before = { ex: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection') };
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  process.exit = code => { env.exits.push(code); throw new ExitCalled(); };
  try {
    const m = new Module(MAIN, module);
    m.filename = MAIN;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(fs.readFileSync(MAIN, 'utf8') + '\nmodule.exports.__test = { buildTrayMenu };', MAIN);
    env.buildTrayMenu = m.exports.__test.buildTrayMenu;
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
  } finally {
    Module._load = load;
    process.exit = exit;
    // Keep main's process-level handlers for the tests to call, but not installed: they would
    // swallow this script's own errors.
    env.onUncaught = process.listeners('uncaughtException').find(l => !before.ex.includes(l));
    env.onRejection = process.listeners('unhandledRejection').find(l => !before.rej.includes(l));
    if (env.onUncaught) process.removeListener('uncaughtException', env.onUncaught);
    if (env.onRejection) process.removeListener('unhandledRejection', env.onRejection);
  }
  env.saveDir = path.join(env.home, 'Documents', "Jack's Picker");
  env.log = () => { try { return fs.readFileSync(path.join(tmp, 'logs', 'main.log'), 'utf8'); } catch { return ''; } };
  return env;
}

const call = (m, channel, ...args) => m.handle[channel]({}, ...args);
const opened = m => m.sent.filter(s => s.channel === 'open-settings');

async function settingsStore() {
  const m = loadMain();
  const d = await call(m, 'settings-get');
  check('settings: defaults', d.appearance.theme === 'dark' && d.appearance.accent === 'purple' && d.editor.stroke === 15
    && d.editor.textSize === 0 && d.recording.gifFps === 12 && d.recording.gifWidth === 800 && d.autoCopyAfterCapture === false,
  JSON.stringify({ appearance: d.appearance, editor: d.editor, recording: d.recording }));
  const r = await call(m, 'settings-set', {
    appearance: { theme: 'light', accent: 'teal', uiScale: 1.1, hudScale: 7, thumbSize: 'huge' },
    editor: { color: 'red', stroke: 999, textSize: '30' }, recording: { gifFps: 15, mic: 1 },
    autoCopyAfterCapture: true, launchAtLogin: true, bogus: 1,
  });
  check('settings: valid values kept', r.appearance.theme === 'light' && r.appearance.accent === 'teal' && r.appearance.uiScale === 1.1
    && r.recording.gifFps === 15 && r.recording.mic === true && r.autoCopyAfterCapture === true, JSON.stringify(r.appearance));
  check('settings: invalid values fall back or clamp', r.appearance.hudScale === 1 && r.appearance.thumbSize === 'large'
    && r.editor.color === '#6C4EF6' && r.editor.stroke === 150 && r.editor.textSize === 30, JSON.stringify(r.editor));
  check('settings: launch at login is left alone in dev builds', r.launchAtLogin === false);
  check('settings: native dialogs follow the theme', m.electron.nativeTheme.themeSource === 'light');
  check('settings: windows are told', m.sent.some(s => s.channel === 'settings-changed' && s.args[0].appearance.theme === 'light'));
  check('settings: text size back to automatic', (await call(m, 'settings-set', { editor: { textSize: 0 } })).editor.textSize === 0);
}

async function capturesFolder() {
  const m = loadMain();
  const { saveDir: SAVE } = m;
  const NEW = path.join(m.home, 'Dropbox', 'Shots');
  fs.mkdirSync(path.join(SAVE, '.annotations'), { recursive: true });
  fs.mkdirSync(NEW, { recursive: true });
  for (const n of ['screenshot-1.png', 'screenshot-2.png', 'rec.mp4']) fs.writeFileSync(path.join(SAVE, n), n);
  fs.writeFileSync(path.join(SAVE, '.annotations', 'screenshot-1.json'), '{"anns":[]}');
  fs.writeFileSync(path.join(SAVE, '.annotations', 'screenshot-1.flat.png'), 'flat');
  fs.writeFileSync(path.join(SAVE, '.annotations', 'rec.mp4.video.json'), '{}');
  fs.writeFileSync(path.join(NEW, 'screenshot-2.png'), 'USER FILE ALREADY HERE');
  m.chooseDir = NEW;

  check('captures folder: counts captures', (await call(m, 'captures-folder-count')) === 3);
  const choice = await call(m, 'captures-folder-choose');
  check('captures folder: choosing reports the folder', choice?.path === NEW && choice.count === 3, JSON.stringify(choice));
  const moved = await call(m, 'captures-folder-apply', { target: 'pending', move: true });
  const names = moved.moved.map(x => path.basename(x.from)).sort();
  check('captures folder: moves captures and their sidecars', names.join() === 'rec.mp4,screenshot-1.png'
    && fs.existsSync(path.join(NEW, '.annotations', 'screenshot-1.json')) && fs.existsSync(path.join(NEW, '.annotations', 'rec.mp4.video.json')),
  names.join());
  check('captures folder: skips a name that is taken, leaving the user’s file', moved.skipped.map(p => path.basename(p)).join() === 'screenshot-2.png'
    && fs.readFileSync(path.join(NEW, 'screenshot-2.png'), 'utf8') === 'USER FILE ALREADY HERE' && fs.existsSync(path.join(SAVE, 'screenshot-2.png')));
  m.chooseDir = path.join(NEW, 'inside');
  fs.mkdirSync(m.chooseDir);
  check('captures folder: refuses a folder inside the current one', (await call(m, 'captures-folder-choose'))?.error === 'inside');
  const back = await call(m, 'captures-folder-apply', { target: 'default', move: false });
  check('captures folder: back to the default', back.newDir === SAVE, back.newDir);
}

async function openSettings() {
  const m = loadMain();
  m.buildTrayMenu();
  const item = m.template.find(i => i.label === 'Settings…');
  const menuItem = () => ({ label: 'Settings…', click() {} });   // Electron passes the MenuItem first
  item.click(menuItem(), undefined, {});
  await wait(30);
  const editors = () => m.windows.filter(w => /editor\.html$/.test(w.url || ''));
  check('open Settings: tray item opens the editor', editors().length === 1);
  check('open Settings: tray item reaches the new editor', opened(m).length === 1 && !opened(m)[0].dropped && opened(m)[0].args[0] === null,
    JSON.stringify(opened(m)));
  m.sent.length = 0;
  item.click(menuItem(), undefined, {});
  await wait(10);
  check('open Settings: tray item reaches an open editor', opened(m).length === 1 && !opened(m)[0].dropped && editors().length === 1,
    JSON.stringify(opened(m)));
  m.sent.length = 0;
  m.on['settings-open']({}, { unexpected: () => {} });
  await wait(10);
  check('open Settings: ⌘, in the HUD', opened(m).length === 1 && opened(m)[0].args[0] === null, JSON.stringify(opened(m)));
  return m;
}

async function deleteToTrash() {
  const ok = loadMain();
  fs.mkdirSync(path.join(ok.saveDir, '.annotations'), { recursive: true });
  const shot = path.join(ok.saveDir, 'screenshot-1.png');
  fs.writeFileSync(shot, 'png');
  fs.writeFileSync(path.join(ok.saveDir, '.annotations', 'screenshot-1.json'), '{}');
  const r = await call(ok, 'gallery-delete', shot);
  check('delete: moves the capture to the Trash', r.success && !fs.existsSync(shot) && fs.existsSync(path.join(ok.tmp, 'Trash', 'screenshot-1.png')), JSON.stringify(r));
  check('delete: removes its annotation sidecar', !fs.existsSync(path.join(ok.saveDir, '.annotations', 'screenshot-1.json')));

  const fails = loadMain({ trash: 'fail' });
  fs.mkdirSync(path.join(fails.saveDir, '.annotations'), { recursive: true });
  const kept = path.join(fails.saveDir, 'screenshot-2.png');
  fs.writeFileSync(kept, 'png');
  fs.writeFileSync(path.join(fails.saveDir, '.annotations', 'screenshot-2.json'), '{}');
  const f = await call(fails, 'gallery-delete', kept);
  check('delete: when the Trash fails, the capture is kept', !f.success && f.reason === 'trash' && fs.existsSync(kept)
    && fs.existsSync(path.join(fails.saveDir, '.annotations', 'screenshot-2.json')), JSON.stringify(f));
  check('delete: the failure is logged', /Move to Trash/.test(fails.log()));
}

async function errorLog() {
  const m = loadMain();
  m.onUncaught(new Error('boom-1'));
  m.onUncaught(new Error('boom-2'));
  m.onRejection('nope');
  await wait(10);
  const log = m.log();
  check('error log: uncaught errors are written to the log', /Uncaught exception: Error: boom-1/.test(log) && /boom-2/.test(log), log.slice(0, 200));
  check('error log: unhandled rejections are written to the log', /Unhandled rejection: nope/.test(log));
  check('error log: one friendly message, not one per error', m.dialogs.length === 1 && m.dialogs[0].message === "Jack's Picker ran into a problem",
    JSON.stringify(m.dialogs.map(d => d.message)));
  m.on['show-log']();
  check('error log: Show Log reveals the file', m.shown.at(-1) === path.join(m.tmp, 'logs', 'main.log'), m.shown.at(-1));

  const contents = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, setWindowOpenHandler(fn) { this.openHandler = fn; }, getURL: () => 'file:///app/src/editor.html' };
  m.appOn['web-contents-created'].forEach(fn => fn({}, contents));
  contents.handlers['console-message']({ level: 'error', message: 'TypeError: x is undefined', sourceId: 'file:///app/src/editor.html', lineNumber: 42 });
  contents.handlers['console-message']({ level: 'warning', message: 'just a warning', sourceId: '', lineNumber: 1 });
  check('error log: page errors are logged', /Page editor\.html: TypeError: x is undefined \(editor\.html:42\)/.test(m.log()));
  check('error log: page warnings are not', !/just a warning/.test(m.log()));
  let prevented = false;
  contents.handlers['will-navigate']({ preventDefault: () => { prevented = true; } });
  check('pages can’t navigate away or open windows', prevented && contents.openHandler().action === 'deny');
}

async function crashRecovery() {
  const m = await openSettings();   // leaves an editor window open
  const editor = m.windows.find(w => /editor\.html$/.test(w.url || ''));
  const gone = details => m.appOn['render-process-gone'].forEach(fn => fn({}, editor.webContents, details));
  m.dialogs.length = 0;
  gone({ reason: 'clean-exit', exitCode: 0 });
  check('crash: a clean exit is left alone', editor.reloads === 0);
  gone({ reason: 'crashed', exitCode: 5 });
  check('crash: a crashed editor is reloaded, with a message', editor.reloads === 1 && m.dialogs[0]?.message === 'The editor stopped unexpectedly');
  check('crash: it is logged', /Page editor\.html stopped: crashed \(exit code 5\)/.test(m.log()));
  gone({ reason: 'oom', exitCode: 1 });
  gone({ reason: 'oom', exitCode: 1 });
  gone({ reason: 'oom', exitCode: 1 });
  check('crash: no reload loop (at most 3 a minute)', editor.reloads === 3, `reloads=${editor.reloads}`);
  m.appOn['child-process-gone'].forEach(fn => fn({}, { type: 'GPU', reason: 'crashed', exitCode: 9 }));
  check('crash: helper processes are logged', /GPU process stopped: crashed/.test(m.log()));
}

async function hotkeys() {
  const m = loadMain();
  const r = await call(m, 'shortcuts-set', { region: 'CommandOrControl+Shift+4', full: 'CommandOrControl+Shift+3', window: 'CommandOrControl+Shift+5', repeat: '' });
  check('hotkeys: macOS’s ⌘⇧3/4/5 can be used', r.success && r.shortcuts.region === 'CommandOrControl+Shift+4'
    && r.shortcuts.full === 'CommandOrControl+Shift+3' && r.shortcuts.window === 'CommandOrControl+Shift+5', JSON.stringify(r));
  check('hotkeys: and are registered', ['CommandOrControl+Shift+4', 'CommandOrControl+Shift+3', 'CommandOrControl+Shift+5'].every(a => m.registered.includes(a)),
    JSON.stringify(m.registered));
  check('hotkeys: an empty field gets its default', r.shortcuts.repeat === 'CommandOrControl+Alt+Shift+2');
  check('hotkeys: kept for next launch', (await call(m, 'shortcuts-get')).shortcuts.region === 'CommandOrControl+Shift+4');
  m.on['open-keyboard-settings']();
  check('hotkeys: the dialog can open Keyboard settings', /^x-apple\.systempreferences:com\.apple\.preference\.keyboard/.test(m.opened.at(-1) || ''), m.opened.at(-1));
}

function debuggingRefusal() {
  check('packaged build refuses --remote-debugging-port', loadMain({ packaged: true, switches: ['remote-debugging-port'] }).exits.join() === '1');
  check('packaged build refuses --remote-debugging-pipe', loadMain({ packaged: true, switches: ['remote-debugging-pipe'] }).exits.join() === '1');
  check('packaged build starts normally without them', loadMain({ packaged: true }).exits.length === 0);
  check('development runs may still debug', loadMain({ switches: ['remote-debugging-port'] }).exits.length === 0);
}

(async () => {
  try {
    await settingsStore();
    await capturesFolder();
    await deleteToTrash();
    await errorLog();
    await crashRecovery();
    await hotkeys();
    debuggingRefusal();
  } catch (e) {
    check('harness ran to completion', false, e.stack);
  }
  process.env.HOME = REAL_HOME;
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? `\n    ${r.detail}` : ''}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
