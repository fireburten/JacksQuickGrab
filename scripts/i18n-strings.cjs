// Lists the English text people see, for translators: what every window shows (rendered
// offscreen, with Settings sections and dialogs opened) plus the messages the code passes to
// toast(), confirm(), notices and the like. Writes $TMPDIR/i18n-strings.json, one string per
// entry, sorted. Compare it with the tables in src/locales to find what's untranslated:
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/i18n-strings.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'i18n-strings.json');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const DIR = "/Users/x/Documents/Jack's Picker";
const THUMB = nativeImage.createFromPath(path.join(ROOT, 'picker-hud.png')).resize({ width: 120 }).toDataURL();
const capture = name => ({ filename: name, filePath: `${DIR}/${name}`, fileURL: 'file://x', kind: 'image', thumb: THUMB, annotations: [], time: 1 });
const SETTINGS = {
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large', language: 'en' },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800, camera: false, cameraSize: 'medium', cameraCorner: 'bottom-right', cameraShape: 'circle' },
  brand: { name: '', logo: 0, watermark: 'logo', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6, autoWatermark: false, stamp: 'none', palette: ['#123456'], usePalette: false },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: true, searchText: true, checkSensitive: false, afterCapture: 'editor',
  capturesFolder: { path: DIR, isDefault: true, defaultPath: DIR }, managed: {},
  sharing: { allowed: true, destinations: [] },
};
const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
handle('settings-get', () => SETTINGS);
handle('settings-set', () => SETTINGS);
handle('gallery-list', () => [capture('screenshot-1.png')]);
handle('gallery-search', () => ({ items: [], enabled: true, indexed: 0, pending: 0 }));
handle('search-status', () => ({ enabled: true, indexed: 2, pending: 0 }));
handle('project-folders', () => ({}));
handle('shortcuts-get', () => ({ defaults: {}, shortcuts: {} }));
['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'brand-logo-get', 'mic-access', 'camera-access'].forEach(c => handle(c, () => null));
handle('guide-prepare', (_e, paths) => ({ steps: (paths || []).map(p => ({ filePath: p, name: path.basename(p), thumb: THUMB })), skipped: { media: 1, missing: 0 }, prefs: { format: 'pdf', numbered: true } }));
app.on('window-all-closed', () => {});

const COLLECT = `(() => {
  const out = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement && !n.parentElement.closest('script, style') && n.nodeValue.trim() ? 1 : 2 });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.add(n.nodeValue.replace(/\\s+/g, ' ').trim());
  document.querySelectorAll('[title], [placeholder], [aria-label], img[alt]').forEach(el => ['title', 'placeholder', 'aria-label', 'alt'].forEach(a => { const v = el.getAttribute(a); if (v && v.trim()) out.add(v.trim()); }));
  return [...out];
})()`;

async function page(file, size, steps = []) {
  const w = new BrowserWindow({ show: false, ...size, webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `i18n-${file}-${Date.now()}` } });
  await w.loadFile(path.join(ROOT, 'src', file));
  await wait(900);
  const found = new Set(await w.webContents.executeJavaScript(COLLECT));
  for (const step of steps) {
    try { await w.webContents.executeJavaScript(step); } catch {}
    await wait(300);
    (await w.webContents.executeJavaScript(COLLECT)).forEach(s => found.add(s));
  }
  w.destroy();
  return found;
}

// Text handed to the helpers that show it (toasts, dialogs, notices, flashes, rows…).
function fromSource() {
  const files = ['src/editor.html', 'src/hud.html', 'src/capture.html', 'src/window-picker.html', 'src/thumbnail.js', 'src/pin.js',
    'src/settings-panel.js', 'src/settings-sharing.js', 'src/sharing.js', 'src/guide-dialog.js', 'src/webcam.js', 'main.js', 'lib/sharing/http.cjs'];
  const sinks = /(?:toast|confirm|askText|showRecNote|flashHUD|showToast|row|button|el\('[a-z0-9]+',\s*\{[^}]*\})\(?\s*(['"])((?:(?!\1)[^\\\n]|\\.){2,160})\1|(?:text|label|message|detail|title|error|hint|placeholder|buttonLabel)\s*:\s*(['"])((?:(?!\3)[^\\\n]|\\.){2,200})\3/g;
  const found = new Set();
  for (const f of files) {
    let s = '';
    try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const m of s.matchAll(sinks)) {
      const v = (m[2] || m[4] || '').replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
      if (/[A-Za-z]{2}/.test(v) && !/^[a-z0-9_.-]+$/.test(v) && !/^(https?:|#|\.|\/)/.test(v)) found.add(v);
    }
  }
  return found;
}

app.whenReady().then(async () => {
  const all = new Set();
  const add = set => set.forEach(s => { if (/[A-Za-z]{2}/.test(s)) all.add(s); });
  add(await page('editor.html', { width: 1300, height: 860 }, [
    `(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; loadImageWithAnns(c.toDataURL(), ${JSON.stringify(`${DIR}/screenshot-1.png`)}, []); return 0; })()`,
    `document.querySelectorAll('.toolbar-menu').forEach(m => m.open = true); 0`,
    `showHotkeys(); 0`, `document.getElementById('hotkey-backdrop').classList.remove('on'); showStampChooser(); 0`,
    `document.getElementById('stamp-backdrop').classList.remove('on'); 0`,
    ...['appearance', 'annotations', 'brand', 'capture', 'recording', 'storage', 'sharing'].map(s => `JPSettings.open('${s}'); 0`),
    `JPSettings.close(); setTool('box'); 0`, `setTool('highlight'); 0`, `setTool('blur'); 0`, `setTool('arrow'); 0`,
    `window.JPGuide && JPGuide.open([galleryItemsByPath.get(${JSON.stringify(`${DIR}/screenshot-1.png`)})]); 0`,
  ]));
  add(await page('hud.html', { width: 560, height: 90 }));
  add(await page('window-picker.html', { width: 900, height: 600 }));
  add(await page('capture.html', { width: 900, height: 600 }));
  add(await page('thumbnail.html', { width: 240, height: 180 }));
  add(await page('pin.html', { width: 500, height: 400 }));
  add(fromSource());
  const list = [...all].filter(s => !/^[\d\s%.:×x·|,+−-]+$/.test(s)).sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
  console.log(`${list.length} strings → ${OUT}`);
  app.exit(0);
});
