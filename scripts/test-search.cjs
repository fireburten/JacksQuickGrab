// Tests the gallery's text search: the index (lib/search-index.cjs) with a stand-in OCR, the
// same index reading real images with the Vision helper (bin/ocr), and the gallery showing
// results in the real editor page.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-search.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-search.txt.
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSearchIndex, normalize } = require('../lib/search-index.cjs');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-search.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jp-search-'));

// ── The index, with a stand-in for OCR ──
async function indexTests() {
  const dir = tmpDir();
  const texts = { 'a.png': 'Invoice 4471 total due', 'b.png': 'Café menu: crème brûlée', 'c.png': 'Error 504 Gateway Timeout' };
  const write = (name, t) => { fs.writeFileSync(path.join(dir, name), name); fs.utimesSync(path.join(dir, name), t, t); };
  write('a.png', 1000); write('b.png', 3000); write('c.png', 2000);
  const read = [];
  const index = createSearchIndex({
    file: path.join(dir, 'index', 'search-index.json'),
    listImages: () => fs.readdirSync(dir).filter(n => n.endsWith('.png'))
      .map(name => ({ name, path: path.join(dir, name), time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((x, y) => y.time - x.time),
    sourceFor: p => p,
    readText: async src => { read.push(path.basename(src)); return texts[path.basename(src)]; },
  });
  await index.run();
  check('index: reads every screenshot, newest first', read.join() === 'b.png,c.png,a.png', read.join());
  check('index: status counts them', JSON.stringify(index.status()) === JSON.stringify({ enabled: true, indexed: 3, pending: 0 }), JSON.stringify(index.status()));
  const names = ['a.png', 'b.png', 'c.png', 'clip.mp4'];
  const find = q => index.search(q, names).map(h => h.name).join();
  check('search: finds text inside images', find('gateway') === 'c.png');
  check('search: every word must match', find('invoice total') === 'a.png' && find('invoice gateway') === '');
  check('search: ignores case and accents', find('CREME BRULEE') === 'b.png');
  check('search: matches file names too, including videos', find('clip') === 'clip.mp4');
  const hit = index.search('504', names)[0];
  check('search: a snippet shows the matching text', hit.snippet === 'Error 504 Gateway Timeout', JSON.stringify(hit));
  check('normalize collapses spaces', normalize('  A  B ') === 'a b');

  read.length = 0;
  await index.run();
  check('index: unchanged images are not read again', read.length === 0, read.join());
  texts['a.png'] = 'Invoice 4471 PAID';
  fs.writeFileSync(path.join(dir, 'a.png'), 'changed contents');
  await index.run();
  check('index: an edited image is read again', read.join() === 'a.png' && find('paid') === 'a.png', read.join());
  fs.renameSync(path.join(dir, 'c.png'), path.join(dir, 'renamed.png'));
  await index.run();
  check('index: a deleted image is forgotten', index.textOf('c.png') === '' && find('gateway') === '');

  const reopened = createSearchIndex({ file: path.join(dir, 'index', 'search-index.json'), listImages: () => [], sourceFor: p => p, readText: async () => '' });
  check('index: kept on disk between runs', reopened.textOf('b.png').includes('brûlée'));
  index.setEnabled(false);
  check('turning search off deletes the index', !fs.existsSync(path.join(dir, 'index', 'search-index.json')) && find('invoice') === '');
}

// ── The same index reading real images with the Vision helper ──
async function realOcrTests() {
  const helper = path.join(ROOT, 'bin', 'ocr');
  if (process.platform !== 'darwin' || !fs.existsSync(helper)) {
    check('real OCR: helper available (run npm run build:ocr)', false, helper);
    return;
  }
  const dir = tmpDir();
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<body></body>');
  const render = text => w.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 200); g.fillStyle = '#111'; g.font = '600 44px Helvetica';
    g.fillText(${JSON.stringify(text)}, 40, 115); return c.toDataURL(); })()`);
  for (const [name, text] of [['shot-1.png', 'Quarterly revenue report'], ['shot-2.png', 'Server error 504 Gateway']]) {
    fs.writeFileSync(path.join(dir, name), Buffer.from((await render(text)).split(',')[1], 'base64'));
  }
  w.destroy();
  const ocr = src => new Promise((resolve, reject) => execFile(helper, [src], (err, out) => (err ? reject(err) : resolve(JSON.parse(out).map(i => i.text).join('\n')))));
  const index = createSearchIndex({
    file: path.join(dir, 'search-index.json'),
    listImages: () => ['shot-1.png', 'shot-2.png'].map(name => ({ name, path: path.join(dir, name) })),
    sourceFor: p => p,
    readText: ocr,
  });
  await index.run();
  const names = ['shot-1.png', 'shot-2.png'];
  check('real OCR: finds words rendered in an image', index.search('revenue', names).map(h => h.name).join() === 'shot-1.png', index.textOf('shot-1.png'));
  check('real OCR: finds numbers too', index.search('504 gateway', names).map(h => h.name).join() === 'shot-2.png', index.textOf('shot-2.png'));
}

// ── The gallery shows results, snippets and progress ──
async function galleryTests(errors) {
  const DIR = "/Users/x/Documents/Jack's Picker";
  const item = (name, snippet) => ({ filename: name, filePath: `${DIR}/${name}`, fileURL: 'file://x', kind: 'image', thumb: '', annotations: [], snippet, time: 1 });
  let searched = [];
  ipcMain.handle('gallery-list', () => [item('recent.png')]);
  ipcMain.handle('gallery-search', (_e, q) => {
    searched.push(q);
    return q === 'invoice'
      ? { items: [item('old-invoice-shot.png', '…Invoice 4471 total due…'), item('invoice.png', '')], enabled: true, indexed: 40, pending: 3 }
      : { items: [], enabled: true, indexed: 40, pending: 0 };
  });
  ipcMain.handle('settings-get', () => ({ editor: {}, appearance: {} }));
  ['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'shortcuts-get', 'settings-set'].forEach(c => ipcMain.handle(c, () => null));
  ipcMain.handle('project-folders', () => ({}));
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `search-${Date.now()}` },
  });
  w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
  await wait(1000);
  const js = code => w.webContents.executeJavaScript(code);
  const type = async q => { await js(`{ const i = document.getElementById('gallery-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); } 0`); await wait(600); };
  await js(`{ const i = document.getElementById('gallery-search'); ['i', 'in', 'inv'].forEach(v => { i.value = v; i.dispatchEvent(new Event('input')); }); } 0`);
  await wait(500);
  check('typing searches once the keys pause', searched.length === 1 && searched[0] === 'inv', JSON.stringify(searched));
  await type('invoice');
  const cards = await js(`[...document.querySelectorAll('.gallery-item')].map(c => c.dataset.fp.split('/').pop() + (c.querySelector('.gallery-item-snippet') ? ' [' + c.querySelector('.gallery-item-snippet').textContent + ']' : '')).join(' | ')`);
  check('search shows matches from all captures, with snippets', cards === 'old-invoice-shot.png […Invoice 4471 total due…] | invoice.png', cards);
  check('search says when the index is still reading', (await js(`(s => !s.hidden && s.textContent)(document.getElementById('gallery-search-status'))`)) === 'Still reading text in 3 captures…');
  await type('zzz');
  check('no matches says so', (await js(`document.querySelector('.gallery-empty')?.textContent`)) === 'No captures match “zzz”');
  await type('');
  check('clearing the search shows the recent captures again', (await js(`[...document.querySelectorAll('.gallery-item')].map(c => c.dataset.fp.split('/').pop()).join()`)) === 'recent.png'
    && await js(`document.getElementById('gallery-search-status').hidden`));
  w.destroy();
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const errors = [];
  try {
    await indexTests();
    await realOcrTests();
    await galleryTests(errors);
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
