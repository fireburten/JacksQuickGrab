// Electron harness for the Settings panel (src/settings-panel.js) in the editor, the HUD's
// recording toggles and ⌘, and the editor's Trash-only delete. Loads the real pages offscreen
// with main's IPC replaced by in-memory stand-ins.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-settings-ui.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-settings-ui.txt
// because stdout can be cut off on quit.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-settings-ui.txt');
const OLD = "/Users/x/Documents/Jack's Picker", NEW = '/Users/x/Dropbox/Shots';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Stand-ins for main.js ──
const freshSettings = () => ({
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large' },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800 },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: false,
  capturesFolder: { path: OLD, isDefault: true, defaultPath: OLD },
});
let S = freshSettings();
let current = null;             // the window under test (receives broadcasts)
let appInfo = null;
let micOK = false;
let deleteResults = [];
const sets = [], deletes = [], opens = [], savedHotkeys = [];
let keyboardSettingsOpened = 0;
let logShown = 0;
const thumb = nativeImage.createFromPath(path.join(ROOT, 'picker-hud.png')).resize({ width: 150 }).toDataURL();
const capture = name => ({ filename: name, filePath: `${OLD}/${name}`, fileURL: 'file://x', kind: 'image', thumb, annotations: [], time: 1 });

ipcMain.handle('settings-get', () => S);
ipcMain.handle('settings-set', (_e, patch) => {
  sets.push(patch);
  for (const key of ['appearance', 'editor', 'recording']) if (patch[key]) S[key] = { ...S[key], ...patch[key] };
  if ('autoCopyAfterCapture' in patch) S.autoCopyAfterCapture = !!patch.autoCopyAfterCapture;
  current.webContents.send('settings-changed', S);
  return S;
});
ipcMain.handle('mic-access', () => micOK);
ipcMain.on('open-mic-settings', () => {});
ipcMain.on('show-log', () => { logShown++; });
ipcMain.on('settings-open', () => { opens.push('settings-open'); });
ipcMain.handle('captures-folder-count', () => 2);
ipcMain.handle('captures-folder-choose', () => ({ path: NEW, count: 2 }));
ipcMain.handle('captures-folder-apply', (_e, { move }) => {
  S = { ...S, capturesFolder: { path: NEW, isDefault: false, defaultPath: OLD } };
  return { oldDir: `${OLD}/`, newDir: `${NEW}/`, moved: move ? [{ from: `${OLD}/screenshot-1.png`, to: `${NEW}/screenshot-1.png` }] : [], skipped: [] };
});
ipcMain.handle('gallery-list', () => ['screenshot-1.png', 'screenshot-2.png', 'screenshot-3.png'].map(capture));
ipcMain.handle('gallery-delete', (_e, filePath) => { deletes.push(filePath); return deleteResults.shift() || { success: true }; });
ipcMain.handle('app-info', () => appInfo);
const DEFAULT_HOTKEYS = { region: 'CommandOrControl+Shift+2', repeat: 'CommandOrControl+Alt+Shift+2', window: 'CommandOrControl+Alt+Shift+W', full: 'CommandOrControl+Shift+1' };
ipcMain.handle('shortcuts-get', () => ({ defaults: DEFAULT_HOTKEYS, shortcuts: DEFAULT_HOTKEYS }));
ipcMain.handle('shortcuts-set', (_e, shortcuts) => { savedHotkeys.push(shortcuts); return { success: true, shortcuts, failures: [] }; });
ipcMain.on('open-keyboard-settings', () => { keyboardSettingsOpened++; });
['permission-status', 'clipboard-image', 'gallery-load'].forEach(channel => ipcMain.handle(channel, () => null));
ipcMain.handle('project-folders', () => ({}));
ipcMain.handle('search-status', () => ({ enabled: true, indexed: 12, pending: 0 }));

app.on('window-all-closed', () => {});

function openPage(file, size, errors) {
  const win = new BrowserWindow({
    show: false, ...size,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `settings-ui-${Date.now()}-${file}` },
  });
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(`${file}: ${e.message}`); });
  current = win;
  return win;
}

async function editorTests(errors) {
  appInfo = { version: '1.0.0', packaged: false, buildTime: '2026-09-27T12:00:00.000Z' };
  const w = openPage('editor.html', { width: 1300, height: 850 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
  await wait(1200);
  const js = code => w.webContents.executeJavaScript(code);
  const button = text => `[...document.querySelectorAll('.settings-box button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const click = async text => { await js(`${button(text)}.click(); 0`); await wait(250); };
  const section = async name => { await js(`[...document.querySelectorAll('.sp-nav button')].find(b => b.textContent === ${JSON.stringify(name)}).click(); 0`); await wait(200); };
  const notice = () => js(`document.querySelector('.sp-notice')?.textContent || ''`);

  check('dev build shows the runtime badge', /^Dev /.test(await js(`document.getElementById('runtime-badge')?.textContent || ''`)));
  await js(`{ const c = document.createElement('canvas'); c.width = 400; c.height = 300; c.getContext('2d').fillRect(0, 0, 400, 300);
    setProjectAssignments({ ${JSON.stringify(`${OLD}/screenshot-1.png`)}: 'p1' }); setGalleryPins([${JSON.stringify(`${OLD}/screenshot-1.png`)}]);
    loadImageWithAnns(c.toDataURL(), ${JSON.stringify(`${OLD}/screenshot-1.png`)}, []); } 0`);
  await wait(300);

  // Opening
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['meta'] });
  await wait(400);
  check('⌘, opens Settings', await js('JPSettings.isOpen()'));
  const sections = await js(`[...document.querySelectorAll('.sp-nav button')].map(b => b.textContent).join('|')`);
  check('Settings lists its sections', sections === 'Appearance|Annotations|Brand|Capture|Recording|Storage', sections);
  check('footer shows the version (development)', (await js(`document.querySelector('.sp-version')?.textContent`)) === 'Version 1.0.0 · development',
    await js(`document.querySelector('.sp-version')?.textContent`));

  // Appearance
  await click('Light');
  check('Light theme applies', (await js('document.documentElement.dataset.theme')) === 'light');
  await js(`document.querySelector('.sp-swatch[title="Teal"]').click(); 0`); await wait(300);
  const accent = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()`);
  check('accent colour applies, canvas drawing included', accent === '13,125,116' && (await js('uiAccentRgb')) === accent, accent);
  await js(`document.querySelector('.sp-switch[aria-label="High contrast"]').click(); 0`); await wait(300);
  check('high contrast applies', (await js('document.documentElement.dataset.contrast')) === 'high');
  await click('Small');   // the first "Small" is the interface size
  check('interface size is sent to main', sets.some(p => p.appearance?.uiScale === 0.9));
  await js(`[...document.querySelectorAll('.sp-seg[aria-label="Thumbnail size"] button')].find(b => b.textContent === 'Small').click(); 0`); await wait(300);
  check('small thumbnails use a 3-column grid', (await js('document.body.dataset.thumbs')) === 'small'
    && (await js(`getComputedStyle(document.getElementById('gallery-scroll')).gridTemplateColumns.split(' ').length`)) === 3);

  // Annotation defaults
  await section('Annotations');
  await js(`document.querySelector('.sp-swatch[title="#EF4444"]').click(); 0`); await wait(300);
  check('default colour reaches the editor and toolbar', (await js('color')) === '#EF4444' && (await js(`document.querySelector('.sw.on')?.dataset.c`)) === '#EF4444');
  await js(`{ const r = document.querySelector('.sp-slider input'); r.value = 24; r.dispatchEvent(new Event('change')); } 0`); await wait(300);
  check('default stroke reaches the editor', (await js('sw')) === 24);
  await click('Custom');
  check('custom text size is used', S.editor.textSize === 42 && (await js('Math.round(toScreenSize(currentCanvasTextSize()))')) === 42);
  await click('Auto');
  check('automatic text size follows the stroke', S.editor.textSize === 0 && (await js('Math.round(toScreenSize(currentCanvasTextSize()))')) === Math.max(42, 24 * 6));
  const before = sets.length;
  await js(`document.querySelector('.sw[data-c="#3B82F6"]').click(); 0`); await wait(700);
  check('toolbar colour becomes the default (one save)', S.editor.color === '#3B82F6' && sets.length - before === 1, `${S.editor.color} ×${sets.length - before}`);

  // Recording
  await section('Recording');
  await js(`document.querySelector('.sp-switch[aria-label="Record microphone"]').click(); 0`); await wait(300);
  check('microphone stays off when access is blocked, with a notice', S.recording.mic === false && (await notice()).includes('Microphone access is off'));
  await click('20 fps');
  check('GIF frame rate is saved', S.recording.gifFps === 20);

  // Storage
  await section('Storage');
  await js('window.__isVideoEditing = window.isVideoEditing; window.isVideoEditing = () => true; 0');
  await click('Change…');
  check('folder can’t change mid video edit', (await notice()).startsWith('Close the video editor first'));
  await js('window.isVideoEditing = window.__isVideoEditing; 0');
  await click('Change…'); await wait(200);
  check('changing the folder offers to move captures', (await js(`document.querySelector('.sp-prompt p')?.textContent`)) === 'Move your 2 existing captures to “Shots” as well?');
  await click('Move Them'); await wait(500);
  check('move result is reported and the new path shown', (await notice()) === 'Moved 1 capture.' && (await js(`document.querySelector('.sp-path')?.textContent`)).includes(NEW));
  check('pins, projects and the open capture follow the move',
    (await js('JSON.stringify(getProjectAssignments())')) === JSON.stringify({ [`${NEW}/screenshot-1.png`]: 'p1' })
    && (await js('JSON.stringify(getGalleryPins())')) === JSON.stringify([`${NEW}/screenshot-1.png`])
    && (await js('currentPath')) === `${NEW}/screenshot-1.png`);
  await js(`[...document.querySelectorAll('.settings-box button')].filter(b => b.textContent.trim() === 'Show in Finder').pop().click(); 0`); await wait(200);
  check('Diagnostic log → Show in Finder asks main', logShown === 1);

  // Closing and reopening
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(300);
  check('Esc closes Settings', !(await js('JPSettings.isOpen()')));
  await js(`document.querySelector('.toolbar-menu:has(#btn-prefs)').open = true; document.getElementById('btn-prefs').click(); 0`); await wait(400);
  check('Tools → Settings… opens it and closes the menu', (await js('JPSettings.isOpen()')) && !(await js(`[...document.querySelectorAll('.toolbar-menu')].some(m => m.open)`)));
  await js('JPSettings.close(); window.confirm = () => true; 0');

  // Hotkeys: macOS takes ⌘⇧3/4/5 until its own shortcuts are off; the dialog says so
  await js('showHotkeys().then(() => 0)'); await wait(200);
  const note = () => js(`(n => n.hidden ? 'hidden' : n.className)(document.getElementById('hotkey-mac-note'))`);
  check('hotkeys: the Mac note is shown', (await note()) === 'hotkey-note', await note());
  const key = (type, init) => js(`document.querySelector('.hotkey-input[data-hotkey=region]').dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${JSON.stringify({ bubbles: true, ...init })})); 0`);
  await js(`document.querySelector('.hotkey-input[data-hotkey=region]').click(); 0`);
  await key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
  await key('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
  await key('keyup', { key: 'Shift', code: 'ShiftLeft', metaKey: true });   // the 4 never arrived: macOS took it
  check('hotkeys: when macOS takes the keys, the note is highlighted', (await note()) === 'hotkey-note attention', await note());
  await js(`document.querySelector('.hotkey-input[data-hotkey=region]').click(); 0`);
  await key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
  await key('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
  await key('keydown', { key: '$', code: 'Digit4', metaKey: true, shiftKey: true });   // macOS's shortcut turned off
  check('hotkeys: ⌘⇧4 can be recorded', (await js(`document.querySelector('.hotkey-input[data-hotkey=region]').textContent`)) === '⇧⌘4');
  await js(`document.getElementById('hotkey-open-keyboard').click(); document.getElementById('hotkey-save').click(); 0`); await wait(300);
  check('hotkeys: Open Keyboard Settings asks main', keyboardSettingsOpened === 1);
  check('hotkeys: ⌘⇧4 is saved', savedHotkeys.at(-1)?.region === 'CommandOrControl+Shift+4', JSON.stringify(savedHotkeys.at(-1)));

  // Delete only ever goes to the Trash
  const toast = () => js(`document.getElementById('toast').textContent`);
  const open = await js('currentPath');
  deleteResults = [{ success: false, reason: 'trash' }];
  await js(`deleteGalleryItem({ filename: 'screenshot-1.png', filePath: currentPath }).then(() => 0)`); await wait(200);
  check('delete: a Trash failure is reported and the capture stays open', (await toast()) === 'Couldn’t move it to the Trash' && (await js('currentPath')) === open);
  deleteResults = [{ success: true }];
  await js(`deleteGalleryItem({ filename: 'screenshot-1.png', filePath: currentPath }).then(() => 0)`); await wait(200);
  check('delete: success says it went to the Trash', (await toast()) === 'Moved to the Trash' && (await js('currentPath')) === null);
  deleteResults = [{ success: true }, { success: false, reason: 'trash' }];
  await js(`deleteGalleryTargets([${JSON.stringify(`${OLD}/screenshot-2.png`)}, ${JSON.stringify(`${OLD}/screenshot-3.png`)}]).then(() => 0)`); await wait(200);
  check('delete: several, with one failure, says so', (await toast()) === '1 couldn’t be moved to the Trash', await toast());

  // Installed build: no badge, version and build date in Settings instead
  appInfo = { version: '1.0.0', packaged: true, buildTime: '2026-09-27T12:00:00.000Z' };
  w.webContents.reload(); await wait(1200);
  check('installed build hides the runtime badge', !(await js(`!!document.getElementById('runtime-badge')`)));
  await js('JPSettings.open(); 0'); await wait(300);
  check('installed build shows version and build date in Settings', /^Version 1\.0\.0 · built \w+ \d+, 2026$/.test(await js(`document.querySelector('.sp-version')?.textContent`)),
    await js(`document.querySelector('.sp-version')?.textContent`));
  w.destroy();
}

async function hudTests(errors) {
  S = freshSettings();
  S.recording = { systemAudio: true, mic: false, gifFps: 15, gifWidth: 640 };
  sets.length = 0;
  micOK = true;
  const w = openPage('hud.html', { width: 530, height: 90 }, errors);
  await w.loadFile(path.join(ROOT, 'src', 'hud.html'));
  // A pre-Settings toggle state in localStorage is carried over once.
  await w.webContents.executeJavaScript(`localStorage.setItem('jqg-rec-audio', JSON.stringify({ system: false, mic: true })); 0`);
  w.webContents.reload(); await wait(1200);
  const js = code => w.webContents.executeJavaScript(code);
  const toggles = () => js(`[...document.querySelectorAll('.audio-toggle')].map(b => b.dataset.audio + ':' + b.classList.contains('on')).join(' ')`);
  const toggle = async which => { await js(`document.querySelector('.audio-toggle[data-audio=${which}]').click(); 0`); await wait(300); };

  check('HUD: old toggle state is migrated once', (await toggles()) === 'system:false mic:true'
    && (await js(`localStorage.getItem('jqg-rec-audio') === null`)) && JSON.stringify(sets[0]) === JSON.stringify({ recording: { systemAudio: false, mic: true } }),
  await toggles());
  check('HUD: GIF settings come from Settings', (await js('GIF_FPS + "/" + GIF_MAX_WIDTH')) === '15/640');
  await toggle('system');
  check('HUD: 🔊 saves to Settings', (await toggles()) === 'system:true mic:true' && S.recording.systemAudio === true);
  micOK = false;
  await toggle('mic');
  check('HUD: 🎙 turns off without asking for access', (await toggles()) === 'system:true mic:false' && S.recording.mic === false);
  await toggle('mic');
  check('HUD: 🎙 stays off when access is blocked', (await toggles()) === 'system:true mic:false' && S.recording.mic === false);
  S.recording = { systemAudio: true, mic: true, gifFps: 20, gifWidth: 1200 };
  w.webContents.send('settings-changed', S); await wait(200);
  check('HUD: follows changes made in Settings', (await toggles()) === 'system:true mic:true' && (await js('GIF_FPS + "/" + GIF_MAX_WIDTH')) === '20/1200');
  check('HUD: theme applies', (await js('document.documentElement.dataset.theme')) === 'dark');
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['meta'] }); await wait(300);
  check('HUD: ⌘, asks main to open Settings', opens.length === 1);
  w.webContents.send('hud-flash', 'Copied 2 lines of text'); await wait(150);
  check('HUD: shows a short message (e.g. after Copy Text)', (await js(`(f => !f.hidden && f.textContent)(document.getElementById('hud-flash'))`)) === 'Copied 2 lines of text');
  await wait(2300);
  check('HUD: the message clears itself', await js(`document.getElementById('hud-flash').hidden`));
  w.destroy();
}

app.whenReady().then(async () => {
  const errors = [];
  try {
    await editorTests(errors);
    await hudTests(errors);
  } catch (e) {
    check('harness ran to completion', false, e.stack);
  }
  check('no page errors', errors.length === 0, JSON.stringify(errors));
  const failed = results.filter(r => !r.ok).length;
  const report = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`).join('\n')
    + `\n\n${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed`;
  fs.writeFileSync(REPORT, report + '\n');
  console.log(report);
  app.exit(failed ? 1 : 0);
});
