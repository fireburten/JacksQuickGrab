// Translations: the lookup itself, the locale tables (same placeholders as the English), and
// every window rendered in German with its dialogs and Settings sections open, looking for
// English that has a translation but wasn't swapped. Also checks a language change reloads.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-i18n.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-i18n.txt.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-i18n.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const i18n = require('../src/i18n.js');
const CODES = Object.keys(i18n.LANGUAGES).filter(c => c !== 'en');
const TABLES = Object.fromEntries(CODES.map(c => [c, require(`../src/locales/${c}.js`)]));
const ENGLISH = new Set(CODES.flatMap(c => Object.keys(TABLES[c])));

const DIR = "/Users/x/Documents/Jack's Picker";
const THUMB = nativeImage.createFromPath(path.join(ROOT, 'picker-hud.png')).resize({ width: 120 }).toDataURL();
const capture = name => ({ filename: name, filePath: `${DIR}/${name}`, fileURL: 'file://x', kind: 'image', thumb: THUMB, annotations: [], time: 1 });
let language = 'de';
const settings = () => ({
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large', language },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800, camera: false, cameraSize: 'medium', cameraCorner: 'bottom-right', cameraShape: 'circle' },
  brand: { name: '', logo: 0, watermark: 'off', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6, autoWatermark: false, stamp: 'none', palette: ['#123456'], usePalette: false },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: true, searchText: true, checkSensitive: false, afterCapture: 'editor',
  capturesFolder: { path: DIR, isDefault: true, defaultPath: DIR }, managed: {},
  sharing: { allowed: true, destinations: [] },
});
const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
handle('settings-get', () => settings());
handle('settings-set', () => settings());
handle('gallery-list', () => [capture('screenshot-1.png'), capture('Quarterly report.png')]);
handle('gallery-search', () => ({ items: [], enabled: true, indexed: 0, pending: 0 }));
handle('search-status', () => ({ enabled: true, indexed: 2, pending: 0 }));
handle('project-folders', () => ({}));
handle('shortcuts-get', () => ({ defaults: {}, shortcuts: { region: 'CommandOrControl+Shift+2', repeat: 'CommandOrControl+Alt+Shift+2', window: 'CommandOrControl+Alt+Shift+W', full: 'CommandOrControl+Shift+1', text: 'CommandOrControl+Alt+Shift+T' } }));
['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'brand-logo-get', 'mic-access', 'camera-access'].forEach(c => handle(c, () => null));
handle('guide-prepare', (_e, paths) => ({ steps: (paths || []).map(p => ({ filePath: p, name: path.basename(p), thumb: THUMB })), skipped: { media: 1, missing: 0 }, prefs: { format: 'pdf', numbered: true } }));
app.on('window-all-closed', () => {});

function unit() {
  i18n.add('de', TABLES.de);
  check('resolve: System follows the Mac', i18n.resolve('system', 'de-DE') === 'de' && i18n.resolve('system', 'ja_JP') === 'ja');
  check('resolve: an unsupported language is English', i18n.resolve('system', 'pt-BR') === 'en' && i18n.resolve('xx') === 'en');
  check('resolve: a chosen language wins over the Mac', i18n.resolve('fr', 'de-DE') === 'fr');
  i18n.setLanguage('de');
  check('t: translates and fills placeholders', i18n.t('Copied {n} lines of text', { n: 3 }) === '3 Zeilen Text kopiert', i18n.t('Copied {n} lines of text', { n: 3 }));
  check('t: unknown text stays English', i18n.t('Not a real string {x}', { x: 1 }) === 'Not a real string 1');
  i18n.setLanguage('en');
  check('t: English fills placeholders too', i18n.t('Copied {n} lines of text', { n: 3 }) === 'Copied 3 lines of text');
  const RedactDetect = require('../src/redact-detect.js');
  const found = RedactDetect.detect('mail a@b.com or c@d.org, call +1 415 555 0100');
  i18n.setLanguage('de');
  check('redaction summary is translated whole', RedactDetect.describe(found, i18n.t) === '2 E-Mail-Adressen und 1 Telefonnummer', RedactDetect.describe(found, i18n.t));
  i18n.setLanguage('en');
}

function tables() {
  const placeholders = s => [...String(s).matchAll(/\{\w+\}/g)].map(m => m[0]).sort().join();
  for (const code of CODES) {
    const bad = Object.entries(TABLES[code]).filter(([en, tr]) => !tr || typeof tr !== 'string' || placeholders(en) !== placeholders(tr));
    check(`${code}: every translation keeps the placeholders`, !bad.length, bad.slice(0, 5).map(([en, tr]) => `${en} → ${tr}`).join(' | '));
    check(`${code}: has a full table`, Object.keys(TABLES[code]).length >= ENGLISH.size * .9, `${Object.keys(TABLES[code]).length} of ${ENGLISH.size}`);
  }
}

// Runs in the page: its language, and English text (outside your own content) that the table
// has a translation for, i.e. text that should have been swapped.
const LEFTOVERS = table => `(() => {
  const table = ${JSON.stringify(table)};
  const out = new Set();
  const skip = el => !el || el.closest('script, style, [data-no-i18n]');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\\s+/g, ' ').trim();
    if (text && !skip(n.parentElement) && table[text] && table[text] !== text) out.add(text);
  }
  document.querySelectorAll('[title], [placeholder], [aria-label], img[alt]').forEach(el => {
    if (skip(el)) return;
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) { const v = (el.getAttribute(a) || '').trim(); if (v && table[v] && table[v] !== v) out.add(a + '=' + v); }
  });
  return { lang: document.documentElement.lang, leftovers: [...out], sample: document.body.innerText.slice(0, 4000) };
})()`;

async function openPage(file, size, errors) {
  const w = new BrowserWindow({
    show: false, ...size,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `i18n-${file}-${Date.now()}` },
  });
  w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(`${file}: ${e.message}`); });
  // The first load starts in the Mac's language and the Settings language reloads the page,
  // which cuts that load short (ERR_ABORTED).
  await w.loadFile(path.join(ROOT, 'src', file)).catch(e => { if (!/ERR_ABORTED/.test(e.message)) throw e; });
  for (let i = 0; i < 40; i++) {
    await wait(100);
    const lang = await w.webContents.executeJavaScript('document.readyState === "complete" && document.documentElement.lang').catch(() => null);
    if (lang === language) break;
  }
  await wait(700);
  return w;
}

async function pageInGerman(file, size, steps, expect) {
  const errors = [];
  const w = await openPage(file, size, errors);
  const leftovers = new Set();
  let first = null;
  for (const step of [null, ...steps]) {
    if (step) { try { await w.webContents.executeJavaScript(step); } catch (e) { errors.push(`${file} step: ${e.message}`); } await wait(350); }
    const r = await w.webContents.executeJavaScript(LEFTOVERS(TABLES.de));
    if (!first) first = r;
    r.leftovers.forEach(s => leftovers.add(s));
  }
  check(`${file}: shown in German`, first.lang === 'de', first.lang);
  check(`${file}: no English left where there's a translation`, !leftovers.size, [...leftovers].slice(0, 12).join(' | '));
  if (expect) check(`${file}: German text shows`, expect.every(s => first.sample.includes(s)), `${expect.filter(s => !first.sample.includes(s)).join(', ')} not in: ${first.sample.slice(0, 300)}`);
  check(`${file}: no errors`, !errors.length, errors.join(' | '));
  w.destroy();
}

async function editorInGerman() {
  const IMG = `${DIR}/screenshot-1.png`;
  await pageInGerman('editor.html', { width: 1300, height: 860 }, [
    `(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; loadImageWithAnns(c.toDataURL(), ${JSON.stringify(IMG)}, []); return 0; })()`,
    `document.querySelectorAll('.toolbar-menu').forEach(m => m.open = true); 0`,
    `document.querySelectorAll('.toolbar-menu').forEach(m => m.open = false); showHotkeys(); 0`,
    `document.getElementById('hotkey-backdrop').classList.remove('on'); showStampChooser(); 0`,
    `document.getElementById('stamp-backdrop').classList.remove('on'); 0`,
    ...['appearance', 'annotations', 'brand', 'capture', 'recording', 'storage', 'sharing'].map(s => `JPSettings.open('${s}'); 0`),
    `JPSettings.close(); setTool('box'); 0`, `setTool('highlight'); 0`, `setTool('blur'); 0`, `setTool('arrow'); 0`,
    `toast('Text copied'); 0`,
    `window.JPGuide && JPGuide.open([galleryItemsByPath.get(${JSON.stringify(IMG)})]); 0`,
  ], ['Alle Aufnahmen', 'Kopieren']);
}

async function languageChange() {
  const errors = [];
  language = 'de';
  const w = await openPage('hud.html', { width: 560, height: 90 }, errors);
  const before = await w.webContents.executeJavaScript('document.documentElement.lang');
  language = 'fr';
  const reloaded = new Promise(resolve => w.webContents.once('did-finish-load', () => resolve(true)));
  w.webContents.send('settings-changed', settings());
  const didReload = await Promise.race([reloaded, wait(4000).then(() => false)]);
  await wait(500);
  const after = await w.webContents.executeJavaScript('document.documentElement.lang');
  check('changing the language reloads the window in it', before === 'de' && didReload && after === 'fr', `${before} → ${after}, reload: ${didReload}`);
  language = 'en';
  w.webContents.send('settings-changed', settings());
  await wait(1500);
  const english = await w.webContents.executeJavaScript('document.documentElement.lang + "|" + document.body.innerText');
  check('English again shows the English text', english.startsWith('en|'), english.slice(0, 80));
  w.destroy();
  language = 'de';
}

// Picking a language in Settings reloads the editor in it, with Settings open where it was.
async function languageFromSettings() {
  const errors = [];
  language = 'de';
  const w = await openPage('editor.html', { width: 1300, height: 860 }, errors);
  await w.webContents.executeJavaScript(`JPSettings.open('appearance').then(() => 0)`);
  await wait(300);
  const reloaded = new Promise(resolve => w.webContents.once('did-finish-load', () => resolve(true)));
  await w.webContents.executeJavaScript(`(() => { const s = document.querySelector('.sp-select[aria-label="Sprache"]'); s.value = 'ja'; s.dispatchEvent(new Event('change')); return 0; })()`);
  language = 'ja';
  w.webContents.send('settings-changed', settings());
  const didReload = await Promise.race([reloaded, wait(4000).then(() => false)]);
  await wait(1200);
  const state = await w.webContents.executeJavaScript(`({ lang: document.documentElement.lang, open: JPSettings.isOpen(), title: document.querySelector('.settings-box h2, .sp-main h2')?.textContent || '' })`);
  check('Settings → Language reloads the editor in the new language', didReload && state.lang === 'ja', JSON.stringify(state));
  check('Settings is open again on Appearance after the reload', state.open && state.title === '外観', JSON.stringify(state));
  await w.webContents.executeJavaScript('location.reload(); 0').catch(() => {});
  await wait(1500);
  check('a later reload doesn’t reopen Settings', !(await w.webContents.executeJavaScript('JPSettings.isOpen()')));
  check('editor: no errors while switching', !errors.length, errors.join(' | '));
  w.destroy();
  language = 'de';
}

app.whenReady().then(async () => {
  try {
    unit();
    tables();
    await editorInGerman();
    await pageInGerman('hud.html', { width: 560, height: 90 }, []);
    await pageInGerman('window-picker.html', { width: 900, height: 600 }, []);
    await pageInGerman('capture.html', { width: 900, height: 600 }, [], ['Aufnahme wird vorbereitet']);
    await pageInGerman('thumbnail.html', { width: 240, height: 180 }, []);
    await pageInGerman('pin.html', { width: 500, height: 400 }, []);
    await languageChange();
    await languageFromSettings();
  } catch (e) {
    check('harness ran to completion', false, e.stack);
  }
  const lines = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.detail}`}`);
  const failed = results.filter(r => !r.ok).length;
  lines.push('', `${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed`);
  fs.writeFileSync(REPORT, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  app.exit(failed ? 1 : 0);
});
