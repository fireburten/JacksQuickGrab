// Screenshot harness for the appearance themes (src/theme.css + src/theme.js).
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-theme.cjs [--root DIR] [--out DIR] [--only a,b]
// Renders the editor, HUD, window picker and capture overlay offscreen with stubbed IPC in each
// appearance and writes <window>-<appearance>-<state>.png plus report.json (console errors, CSP
// violations, the theme each page ended up with) to --out (default $TMPDIR/test-theme).
// --root renders another copy of the app (a dir containing src/ and preload.cjs), e.g. a snapshot
// from before the theme work, to pixel-diff it against the dark default. --only limits the
// appearances (names from APPEARANCES). Exits non-zero on page errors or a wrong data-theme.
const { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'test-theme')));
const ONLY = arg('--only', '').split(',').filter(Boolean);
const TIMEOUT_MS = 4 * 60 * 1000;

// null = main sends no appearance: the page falls back to its cache / the dark default.
const APPEARANCES = {
  default:       null,
  dark:          { theme: 'dark', accent: 'purple', highContrast: false },
  light:         { theme: 'light', accent: 'purple', highContrast: false },
  'dark-hc':     { theme: 'dark', accent: 'purple', highContrast: true },
  'light-hc':    { theme: 'light', accent: 'purple', highContrast: true },
  'dark-blue':   { theme: 'dark', accent: 'blue', highContrast: false },
  'light-teal':  { theme: 'light', accent: 'teal', highContrast: false },
  'dark-green':  { theme: 'dark', accent: 'green', highContrast: false },
  'light-orange': { theme: 'light', accent: 'orange', highContrast: false },
  'dark-pink':   { theme: 'dark', accent: 'pink', highContrast: false },
};
const CORE = ['default', 'dark', 'light', 'dark-hc', 'light-hc'];

let settings = {};                  // what the 'settings-get' stub returns for the current page
const report = { root: ROOT, pages: [], problems: [] };

// ── IPC stubs: everything the pages invoke at startup, plus a null default for the rest ──
function thumb(w, h, header, seed) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = [250, 250, 252];
    if (y < h * 0.16) c = header;
    else if (x < w * 0.22) c = [236, 237, 243];
    else if ((y % 14) < 5 && x > w * 0.28 && x < w * (0.62 + ((y * seed) % 30) / 100)) c = [196, 198, 210];
    buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = 255;   // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toDataURL();
}

function registerStubs() {
  const dir = '/tmp/jqg-theme-test';
  const gallery = [
    { filePath: `${dir}/screenshot-2026-09-26-101500.png`, filename: 'screenshot-2026-09-26-101500.png', kind: 'image', time: 5, thumb: thumb(160, 100, [108, 78, 246], 3) },
    { filePath: `${dir}/screenshot-2026-09-26-093000.png`, filename: 'screenshot-2026-09-26-093000.png', kind: 'image', time: 4, thumb: thumb(160, 100, [34, 197, 94], 7) },
    { filePath: `${dir}/recording-2026-09-25.gif`, filename: 'recording-2026-09-25.gif', kind: 'gif', time: 3, thumb: thumb(160, 100, [239, 68, 68], 5) },
    { filePath: `${dir}/recording-2026-09-24.webm`, filename: 'recording-2026-09-24.webm', kind: 'video', time: 2, thumb: null },
  ];
  const stubs = {
    'settings-get': () => settings,
    'gallery-list': () => gallery,
    'shortcuts-get': () => ({ shortcuts: { region: 'CommandOrControl+Shift+2', repeat: 'CommandOrControl+Alt+Shift+2', window: 'CommandOrControl+Alt+Shift+W', full: 'CommandOrControl+Shift+1' } }),
    'app-info': () => ({ version: '1.0.0', packaged: false, buildTime: '2026-09-26T09:30:00.000Z', execPath: '', appPath: '' }),
    'permission-status': () => ({ screen: 'granted', microphone: 'granted' }),
    'project-folders': () => ({}),
    'project-folder-list': () => ({ items: [] }),
    'media-list': () => [],
    'video-session-load': () => null,
  };
  const preload = fs.readFileSync(path.join(ROOT, 'preload.cjs'), 'utf8');
  const channels = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]));
  Object.keys(stubs).forEach(c => channels.add(c));
  channels.forEach(c => ipcMain.handle(c, (...a) => (stubs[c] ? stubs[c](...a) : null)));
}

// ── Page helpers ──
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); })])
    .finally(() => clearTimeout(t));
}
const run = (win, js, what = js.slice(0, 60)) => withTimeout(win.webContents.executeJavaScript(js), 15000, what);

async function openPage(file, { width, height, transparent = false, appearance }) {
  settings = appearance ? { appearance } : {};
  const win = new BrowserWindow({
    show: false, width, height, transparent, frame: false,
    backgroundColor: transparent ? '#00000000' : undefined,
    webPreferences: {
      offscreen: true, backgroundThrottling: false,
      partition: `theme-test-${Math.random().toString(36).slice(2)}`,   // fresh localStorage per page
      preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
    },
  });
  const page = { file, appearance, messages: [] };
  win.webContents.on('console-message', (e, ...legacy) => {
    const level = e.level ?? ['verbose', 'info', 'warning', 'error'][legacy[0]] ?? legacy[0];
    const message = e.message ?? legacy[1];
    if (level === 'warning' || level === 'error' || /Content Security Policy|Refused to/i.test(message)) page.messages.push(`[${level}] ${message}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => page.messages.push(`[preload-error] ${err}`));
  await win.loadFile(path.join(ROOT, 'src', file));
  // Deterministic frames: no animations / transitions (test-only stylesheet).
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}');
  await run(win, 'document.fonts.ready.then(() => true)', 'fonts');
  return { win, page };
}

async function settle(win) {
  await run(win, `(async () => {
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
    await new Promise(r => setTimeout(r, 120));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`, 'settle');
  win.webContents.invalidate();
  await new Promise(r => setTimeout(r, 120));
}

// WCAG contrast of every visible text run against its composited ancestor backgrounds (an
// approximation: it ignores images and non-ancestor overlaps, e.g. badges drawn over thumbnails).
const AUDIT = `(() => {
  const parse = s => {   // rgb()/rgba(), or color(srgb …) as color-mix() results serialize
    const m = /(rgba?|color)\\(\\s*(?:srgb\\s+)?([^)]+)\\)/.exec(s || ''); if (!m) return null;
    const p = m[2].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat), k = m[1] === 'color' ? 255 : 1;
    return [p[0] * k, p[1] * k, p[2] * k, p[3] === undefined ? 1 : p[3]]; };
  const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const lum = c => .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.textContent.trim(); const el = t.parentElement;
    if (!text || !el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    let opacity = 1, hidden = false; const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
      opacity *= parseFloat(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0 && layers.every(l => l[3] < 1)) layers.push(bg);
    }
    if (hidden || opacity < .05) continue;
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    fg[3] *= opacity;
    const cs = getComputedStyle(el);
    rows.push({ text: text.slice(0, 28), cls: (el.className && el.className.baseVal === undefined ? el.className : el.tagName).toString().slice(0, 40),
      ratio: +ratio(over(fg, bg), bg).toFixed(2), size: parseFloat(cs.fontSize), weight: cs.fontWeight });
  }
  return rows;
})()`;

async function snap(win, page, name) {
  await settle(win);
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  (page.shots = page.shots || []).push(path.basename(file));
  (page.audit = page.audit || {})[name] = await run(win, AUDIT, 'audit');
}

async function themeState(win) {
  return run(win, `(() => {
    const r = document.documentElement, cs = getComputedStyle(r), body = getComputedStyle(document.body);
    return { theme: r.dataset.theme || null, contrast: r.dataset.contrast || null, accent: cs.getPropertyValue('--accent-rgb').trim(),
      jpTheme: typeof window.JPTheme, bodyBg: body.backgroundColor, bodyFg: body.color };
  })()`, 'themeState');
}

function expectTheme(page, state, appearance) {
  page.state = state;
  if (state.jpTheme !== 'object') return;   // a pre-theme snapshot (--root)
  const want = appearance || APPEARANCES.dark;
  const problems = [];
  if (state.theme !== want.theme) problems.push(`data-theme ${state.theme} != ${want.theme}`);
  if ((state.contrast === 'high') !== !!want.highContrast) problems.push(`data-contrast ${state.contrast}`);
  if (want.accent === 'purple' && state.accent.replace(/\s/g, '') !== '108,78,246') problems.push(`accent ${state.accent}`);
  problems.forEach(p => report.problems.push(`${page.file} ${page.name}: ${p}`));
}

// ── Windows ──
const SAMPLE_IMAGE = `(() => {
  const c = document.createElement('canvas'); c.width = 960; c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f7fa'; g.fillRect(0, 0, 960, 600);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 960, 56);
  g.fillStyle = '#e6e6ee'; g.fillRect(0, 56, 960, 1); g.fillRect(0, 57, 200, 543);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(24 + i * 20, 28, 6, 0, 7); g.fill(); });
  g.fillStyle = '#1d1d28'; g.font = '600 20px Poppins, sans-serif'; g.fillText('Quarterly dashboard', 240, 108);
  g.font = '14px Poppins, sans-serif'; g.fillStyle = '#6b6b80';
  for (let i = 0; i < 6; i++) g.fillText('Sidebar item ' + (i + 1), 24, 100 + i * 34);
  const bars = [120, 190, 150, 240, 205, 280];
  bars.forEach((h, i) => { g.fillStyle = i === 5 ? '#6c4ef6' : '#c9c3f5'; g.fillRect(260 + i * 70, 470 - h, 44, h); });
  g.fillStyle = '#1d1d28'; g.font = '600 15px Poppins, sans-serif'; g.fillText('Revenue up 18%', 700, 180);
  g.font = '13px Poppins, sans-serif'; g.fillStyle = '#6b6b80';
  ['Signed up', 'Activated', 'Retained'].forEach((t, i) => g.fillText(t + '  ' + (82 - i * 17) + '%', 700, 216 + i * 26));
  return c.toDataURL('image/png');
})()`;

async function editorCase(name, appearance) {
  const { win, page } = await openPage('editor.html', { width: 1100, height: 760, appearance });
  page.name = name;
  report.pages.push(page);
  await run(win, `(async () => {
    localStorage.setItem('jqg-gallery-projects', JSON.stringify([{ id: 'p1', name: 'Client site' }, { id: 'p2', name: 'Bug reports' }]));
    localStorage.setItem('jqg-gallery-pins', JSON.stringify(['/tmp/jqg-theme-test/screenshot-2026-09-26-093000.png']));
    const url = ${SAMPLE_IMAGE};
    loadImageWithAnns(url, '/tmp/jqg-theme-test/screenshot-2026-09-26-101500.png', [
      { type: 'box', x: 680, y: 150, w: 230, h: 110, color: '#EF4444', sw: 6 },
      { type: 'arrow', x1: 560, y1: 90, x2: 690, y2: 150, color: '#6C4EF6', sw: 14 },
    ]);
    for (let i = 0; i < 100 && !(bgImage && bgImage.naturalWidth === 960); i++) await new Promise(r => setTimeout(r, 20));
    renderProjects(); await loadGallery();
    selectedIdx = 0; setTool('select'); render(); updateInspector();
    return true;
  })()`, 'editor setup');
  expectTheme(page, await themeState(win), appearance);
  await snap(win, page, `editor-${name}-main`);

  if (CORE.includes(name)) {
    await run(win, `(async () => {
      const menu = document.querySelector('.toolbar-menu'); menu.open = true;
      await new Promise(r => setTimeout(r, 50));
      return true;
    })()`, 'open menu');
    await snap(win, page, `editor-${name}-menu`);
    await run(win, `(async () => {
      document.querySelector('.toolbar-menu').open = false;
      const dock = document.getElementById('video-dock'); dock.hidden = false;
      document.getElementById('media-clips').innerHTML = '<span class="media-clip-chip"><span class="media-clip-name">1. recording-2026-09-24.mp4</span><button>✕</button></span>';
      document.getElementById('media-segments').innerHTML = '<div class="media-seg" style="left:0;width:62%"><div class="media-timeline-range" style="left:8%;width:80%"></div><div class="media-timeline-handle start" style="left:8%"></div><div class="media-timeline-handle end" style="left:88%"></div><span class="media-seg-label">1</span></div><div class="media-seg" style="left:62%;width:38%"><div class="media-timeline-range" style="left:0;width:100%"></div></div>';
      document.getElementById('media-playhead').style.left = '40%';
      document.getElementById('media-ann-lane').innerHTML = '<div class="media-ann-row"><div class="media-ann-bar selected timed" style="left:10%;width:35%;background:#EF4444">Box<span class="media-ann-handle start"></span><span class="media-ann-handle end"></span></div></div><div class="media-ann-row"><div class="media-ann-bar whole" style="left:0;width:100%;background:#6C4EF6">Arrow</div></div>';
      document.getElementById('media-time').textContent = '0:04.2 / 0:12.0';
      document.getElementById('media-crop-toggle').classList.add('on');
      return true;
    })()`, 'video dock');
    await snap(win, page, `editor-${name}-video`);
    await run(win, `(() => {
      document.getElementById('video-dock').hidden = true;
      // Clip finder with cached details, so no media files are read.
      const thumb = [...galleryItemsByPath.values()].find(i => i.thumb).thumb;
      const items = ['screen-recording-2026-09-24.mp4', 'bug-repro.gif', 'onboarding-walkthrough.mp4', 'hover-state.gif']
        .map((f, i) => ({ filename: f, filePath: '/tmp/jqg-theme-test/' + f, fileURL: 'file:///tmp/jqg-theme-test/' + f,
          kind: f.endsWith('.gif') ? 'gif' : 'video', time: 1790000000000 - i * 86400000, size: 2400000 * (i + 1) }));
      items.forEach((it, i) => clipDetailCache.set(clipKey(it), { thumb: i === 2 ? null : thumb, duration: 8.5 + i }));
      clipPickerState.items = items; clipPickerState.selected = [items[1].filePath, items[0].filePath];
      const projects = document.getElementById('clip-picker-project');
      projects.append(new Option('All projects', 'all'));
      renderClipPicker();
      document.getElementById('clip-picker-hint').textContent = '2 clips selected';
      document.getElementById('clip-picker-backdrop').classList.add('on');
      return true;
    })()`, 'clip picker');
    await snap(win, page, `editor-${name}-clips`);
    await run(win, `(() => {
      document.getElementById('clip-picker-backdrop').classList.remove('on');
      showGalleryContext(galleryItemsByPath.get('/tmp/jqg-theme-test/screenshot-2026-09-26-093000.png'), 140, 420);
      return true;
    })()`, 'context menu');
    await snap(win, page, `editor-${name}-context`);
    await run(win, `document.getElementById('gallery-context').style.display = 'none'; true`, 'hide context');
  }

  await run(win, `showHotkeys().then(() => true)`, 'hotkeys dialog');
  await snap(win, page, `editor-${name}-dialog`);
  win.destroy();
}

async function hudCase(name, appearance) {
  const { win, page } = await openPage('hud.html', { width: 557, height: 90, transparent: true, appearance });
  page.name = name;
  report.pages.push(page);
  expectTheme(page, await themeState(win), appearance);
  await snap(win, page, `hud-${name}-idle`);
  await run(win, `document.querySelector('.audio-toggle').classList.add('on');
    document.querySelector('[data-mode="region"]').classList.add('flash'); true`, 'hud states');
  await snap(win, page, `hud-${name}-states`);
  await run(win, `document.querySelector('[data-mode="region"]').classList.remove('flash');
    setRecordingUI('video'); document.getElementById('rec-timer').textContent = '0:07';
    const n = document.getElementById('rec-note'); n.hidden = false; n.textContent = 'Mic blocked'; true`, 'hud recording');
  await snap(win, page, `hud-${name}-recording`);
  win.destroy();
}

async function pickerCase(name, appearance) {
  const { win, page } = await openPage('window-picker.html', { width: 760, height: 620, appearance });
  page.name = name;
  report.pages.push(page);
  const sources = ['Safari — Docs', 'Visual Studio Code', 'Slack', 'Finder', 'Terminal'].map((n, i) => ({
    id: `window:${i}`, name: n, thumb: thumb(320, 200, [[108, 78, 246], [37, 99, 235], [219, 39, 119], [120, 120, 130], [30, 30, 36]][i], i + 2),
  }));
  win.webContents.send('window-sources', sources);
  await new Promise(r => setTimeout(r, 150));
  expectTheme(page, await themeState(win), appearance);
  await snap(win, page, `picker-${name}`);
  win.destroy();
}

async function captureCase(name, appearance) {
  const { win, page } = await openPage('capture.html', { width: 640, height: 160, transparent: true, appearance });
  page.name = name;
  report.pages.push(page);
  expectTheme(page, await themeState(win), appearance);
  await snap(win, page, `capture-${name}`);
  win.destroy();
}

// ── theme.js behaviour (skipped for a pre-theme --root) ──
async function behaviourTests() {
  if (!fs.existsSync(path.join(ROOT, 'src', 'theme.js'))) return;
  const results = report.behaviour = [];
  const check = (name, ok, detail = '') => {
    results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) report.problems.push(`theme.js: ${name} ${detail}`);
  };
  const partition = 'theme-test-behaviour';
  const make = (withPreload = true) => new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: {
    offscreen: true, partition, contextIsolation: true, nodeIntegration: false,
    ...(withPreload ? { preload: path.join(ROOT, 'preload.cjs') } : {}) } });
  const state = win => run(win, `({ theme: document.documentElement.dataset.theme, contrast: document.documentElement.dataset.contrast || null,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim(),
    strong: getComputedStyle(document.documentElement).getPropertyValue('--accent-strong-rgb').trim(),
    cached: localStorage.getItem('jqg-appearance'), systemDark: matchMedia('(prefers-color-scheme: dark)').matches })`, 'state');

  // 1. apply() validates and caches
  settings = {};
  let win = make();
  await win.loadFile(path.join(ROOT, 'src', 'window-picker.html'));
  let s = await state(win);
  check('no settings → dark default', s.theme === 'dark' && !s.contrast && s.accent === '108,78,246', JSON.stringify(s));
  const accents = await run(win, 'JSON.stringify(JPTheme.ACCENTS)');
  check('ACCENTS are "R,G,B" strings', Object.values(JSON.parse(accents)).every(v => /^\d+,\d+,\d+$/.test(v)), accents);
  await run(win, `JPTheme.apply({ theme: 'light', accent: 'teal', highContrast: true }); true`);
  s = await state(win);
  check('apply light/teal/high', s.theme === 'light' && s.contrast === 'high' && s.accent === '13,125,116' && s.strong === '11,100,93', JSON.stringify(s));
  check('apply caches the appearance', /"theme":"light"/.test(s.cached) && /"accent":"teal"/.test(s.cached), s.cached);
  const event = await run(win, `new Promise(res => {
    addEventListener('jp-appearance', e => res(JSON.stringify(e.detail)), { once: true });
    JPTheme.apply({ theme: 'system', accent: 'green' });
  })`, 'jp-appearance event');
  check('apply fires jp-appearance', /"accent":"green"/.test(event) && /"resolved":"(dark|light)"/.test(event), event);
  const bad = await run(win, `JSON.stringify([JPTheme.apply({ theme: 'sepia', accent: 'mauve', highContrast: 'yes' }), JPTheme.apply(null), JPTheme.apply('x')])`);
  s = await state(win);
  check('invalid values fall back to defaults', JSON.parse(bad).every(a => a.theme === 'dark' && a.accent === 'purple' && a.highContrast === false) && s.theme === 'dark' && !s.contrast, bad);
  await run(win, `JPTheme.apply({ theme: 'system', accent: 'pink' }); true`);
  s = await state(win);
  check('system follows prefers-color-scheme', s.theme === (s.systemDark ? 'dark' : 'light'), JSON.stringify(s));
  const flip = async source => { nativeTheme.themeSource = source; await new Promise(r => setTimeout(r, 300)); return state(win); };
  const other = s.systemDark ? 'light' : 'dark';
  s = await flip(other);
  check('system re-resolves when the OS appearance changes', s.theme === other, JSON.stringify(s));
  await run(win, `JPTheme.apply({ theme: 'dark', accent: 'pink' }); true`);
  s = await flip('light');
  check('an explicit theme ignores OS changes', s.theme === 'dark', JSON.stringify(s));
  nativeTheme.themeSource = 'system';

  // 2. settings-changed broadcasts re-theme the page; settings without an appearance are ignored
  win.webContents.send('settings-changed', { appearance: { theme: 'light', accent: 'orange', highContrast: false } });
  await new Promise(r => setTimeout(r, 150));
  s = await state(win);
  check('settings-changed applies', s.theme === 'light' && s.accent === '201,72,13', JSON.stringify(s));
  win.webContents.send('settings-changed', { autoCopyAfterCapture: true });
  await new Promise(r => setTimeout(r, 150));
  s = await state(win);
  check('settings without appearance are ignored', s.theme === 'light' && s.accent === '201,72,13', JSON.stringify(s));
  win.destroy();

  // 3. A new window paints with the cached appearance before main answers, then takes main's.
  settings = new Promise(r => setTimeout(() => r({ appearance: { theme: 'dark', accent: 'blue', highContrast: true } }), 800));
  win = make();
  const early = new Promise(resolve => win.webContents.once('dom-ready', () => resolve(state(win))));
  await win.loadFile(path.join(ROOT, 'src', 'window-picker.html'));
  s = await early;
  check('cached appearance applied at dom-ready', s.theme === 'light' && s.accent === '201,72,13', JSON.stringify(s));
  await new Promise(r => setTimeout(r, 1000));
  s = await state(win);
  check('then settings-get wins', s.theme === 'dark' && s.contrast === 'high' && s.accent === '37,99,235', JSON.stringify(s));
  win.destroy();

  // 4. No preload / electronAPI at all: still themed from the cache, no errors.
  settings = {};
  win = make(false);
  const errors = [];
  win.webContents.on('console-message', (e, ...legacy) => {
    const level = e.level ?? legacy[0];
    if (level === 'error' || level === 3 || level === 'warning' || level === 2) errors.push(e.message ?? legacy[1]);
  });
  await win.loadFile(path.join(ROOT, 'src', 'capture.html'));
  s = await state(win);
  check('works without electronAPI', s.theme === 'dark' && s.accent === '37,99,235' && !errors.length, errors.join(' | ') || JSON.stringify(s));
  win.destroy();
}

function finish(ok, extra = '') {
  report.ok = ok;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const text = `${extra}${report.behaviour ? `theme.js:\n  ${report.behaviour.join('\n  ')}\n` : ''}${report.problems.length ? `\nproblems:\n  ${report.problems.join('\n  ')}` : ''}\n${ok ? 'PASSED' : 'FAILED'}: screenshots in ${OUT}`;
  fs.writeFileSync(path.join(OUT, 'report.txt'), text + '\n');
  process.stdout.write(text + '\n', () => app.exit(ok ? 0 : 1));
}

app.on('window-all-closed', () => {});   // pages open one at a time; don't quit between them

app.whenReady().then(async () => {
  const timer = setTimeout(() => finish(false, 'FAIL: timed out'), TIMEOUT_MS);
  fs.mkdirSync(OUT, { recursive: true });
  registerStubs();
  try {
    const names = Object.keys(APPEARANCES).filter(n => !ONLY.length || ONLY.includes(n));
    for (const name of names) {
      const a = APPEARANCES[name];
      await editorCase(name, a);
      await hudCase(name, a);
      if (CORE.includes(name)) { await pickerCase(name, a); await captureCase(name, a); }
    }
    report.pages.forEach(p => p.messages.forEach(m => report.problems.push(`${p.file} ${p.name}: ${m}`)));
    await behaviourTests();
    clearTimeout(timer);
    finish(!report.problems.length);
  } catch (e) {
    clearTimeout(timer);
    finish(false, `FAIL: ${e && e.stack || e}`);
  }
});
