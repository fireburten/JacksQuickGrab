// Tests Create Guide: lib/guide.cjs, main.js's guide handlers and the dialog (src/guide-dialog.js).
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-guide.cjs
// 1. The HTML and Markdown builders: step order, captions, numbering, escaping, the brand hook.
// 2. main.js's guide-prepare / guide-export, loaded against a stand-in electron module whose
//    BrowserWindow and nativeImage are the real ones, so real PDFs are printed from fixture PNGs.
//    Everything is written under a temporary HOME; the save panel and Finder are stand-ins.
// 3. The dialog in the real editor page (offscreen), talking to those same handlers over IPC.
// Screenshots of the dialog in each theme go to $TMPDIR/test-guide. Exits non-zero on failure;
// the report is also written to $TMPDIR/test-guide.txt because stdout can be cut off on quit.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const guide = require(path.join(ROOT, 'lib', 'guide.cjs'));
const OUT = path.join(os.tmpdir(), 'test-guide');
const REPORT = path.join(os.tmpdir(), 'test-guide.txt');
const TIMEOUT_MS = 4 * 60 * 1000;
const REAL_HOME = process.env.HOME;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => JSON.stringify(value);
console.error = () => {};   // main.js echoes what it logs; its log file is what's checked

app.on('window-all-closed', () => {});   // windows come and go throughout; don't quit between them

// ── 1. Builders ──
function builderTests() {
  const steps = [
    { caption: 'Open <b>Billing</b> & click "Save"', src: 'step-01.png' },
    { caption: 'Line one\nLine two\n\n- not a list\n1. not a numbered item\n# not a heading\n[link](http://x) *bold* `code` a_b', src: 'step-02.png' },
    { caption: '', src: 'step-03.png' },
  ];
  const html = guide.guideHTML({ title: 'Onboarding <script>alert(1)</script> & "more"', date: 'September 28, 2026', steps, numbered: true });
  const at = name => html.indexOf(`src="${name}"`);
  check('HTML: steps in the given order', at('step-01.png') > 0 && at('step-01.png') < at('step-02.png') && at('step-02.png') < at('step-03.png'));
  check('HTML: numbered steps get Step 1, Step 2… headings', ['Step 1', 'Step 2', 'Step 3'].every(s => html.includes(`<h2>${s}</h2>`)) && !html.includes('Step 4'));
  check('HTML: each caption under its heading, escaped',
    html.includes('<h2>Step 1</h2>\n<p class="caption">Open &lt;b&gt;Billing&lt;/b&gt; &amp; click &quot;Save&quot;</p>'));
  check('HTML: caption line breaks kept', html.includes('<p class="caption">Line one\nLine two\n\n- not a list') && /\.caption \{[^}]*white-space: pre-line/.test(html));
  check('HTML: an empty caption leaves no paragraph', html.includes('<h2>Step 3</h2>\n<img class="shot" src="step-03.png"'));
  check('HTML: title escaped in the page title and heading',
    html.includes('<title>Onboarding &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;more&quot;</title>') && html.includes('<h1>Onboarding &lt;script&gt;'));
  check('HTML: no user text becomes markup', !/<script|<b>/i.test(html));
  check('HTML: nothing remote (inline CSS, local images)', !/(src|href)\s*=\s*"(https?:)?\/\//i.test(html) && !/@import|url\(|<link|<script/i.test(html));
  check('HTML: a CSP that allows only that', html.includes(`content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline';`));
  check('HTML: date and step count under the title', html.includes('<p class="guide-meta">September 28, 2026 · 3 steps</p>'));
  check('HTML: print CSS keeps a step on one page and fits images to it',
    /@media print[\s\S]*\.step \{[^}]*break-inside: avoid[\s\S]*\.shot \{[^}]*max-height/.test(html));
  check('HTML: images described', html.includes('alt="Screenshot for step 2"'));
  const plain = guide.guideHTML({ title: 'T', steps, numbered: false });
  check('HTML: unnumbered steps have no headings', !/<h2>/.test(plain) && plain.includes('<p class="caption">Open'));

  const branded = guide.guideHeader({ title: 'T', brand: { name: 'Acme <Corp>', logoSrc: 'logo.png' } });
  check('brand hook: logo and (escaped) name in the header',
    branded.includes('<div class="brand"><img class="brand-logo" src="logo.png" alt=""><span class="brand-name">Acme &lt;Corp&gt;</span></div>'), branded);
  check('brand hook: a logo alone is labelled', guide.guideHeader({ title: 'T', brand: { logoSrc: 'logo.png' } }).includes('alt="Logo"'));
  check('brand hook: no brand, no brand line', !guide.guideHeader({ title: 'T' }).includes('brand'));

  const md = guide.guideMarkdown({ title: 'Onboarding <b> #1 *fast*', date: 'September 28, 2026', steps, numbered: true, brand: { name: 'Acme_Co' } });
  check('Markdown: title escaped', md.split('\n').includes('# Onboarding \\<b\\> \\#1 \\*fast\\*'), md.split('\n').slice(0, 6).join(' / '));
  check('Markdown: brand name above the title', md.startsWith('**Acme\\_Co**\n\n# Onboarding'));
  const heads = [...md.matchAll(/^## (.*)$/gm)].map(m => m[1]);
  check('Markdown: numbered headings in order', json(heads) === json(['Step 1', 'Step 2', 'Step 3']), json(heads));
  check('Markdown: HTML in captions escaped', md.includes('Open \\<b\\>Billing\\</b\\> \\& click "Save"'));
  check('Markdown: formatting in captions escaped; line breaks and paragraphs kept',
    md.includes('Line one\\\nLine two\n\n\\- not a list\\\n1\\. not a numbered item\\\n\\# not a heading\\\n\\[link\\](http://x) \\*bold\\* \\`code\\` a\\_b'), md);
  const images = [...md.matchAll(/^!\[[^\]]*\]\(([^)]+)\)$/gm)].map(m => m[1]);
  check('Markdown: images by relative path, in order', json(images) === json(['step-01.png', 'step-02.png', 'step-03.png']), json(images));
  check('Markdown: unnumbered has no step headings', !guide.guideMarkdown({ title: 'T', steps, numbered: false }).includes('## Step'));

  const req = guide.cleanGuideRequest({ format: 'md', title: '  Two\n lines  ', numbered: 'yes',
    steps: [{ filePath: '/a.png', caption: 'a\r\nb\u0007 ' }, { filePath: 3 }, null, { filePath: '/b.png', caption: 7 }] });
  check('request: cleaned', json(req) === json({ format: 'md', title: 'Two lines', numbered: true, steps: [{ filePath: '/a.png', caption: 'a\nb' }, { filePath: '/b.png', caption: '' }] }), json(req));
  check('request: unknown format, no steps or not an object → nothing',
    guide.cleanGuideRequest({ format: 'exe', steps: [{ filePath: '/a.png' }] }) === null && guide.cleanGuideRequest({ format: 'pdf', steps: [] }) === null && guide.cleanGuideRequest('x') === null);
  check('request: at most 200 steps, long text cut', guide.cleanGuideRequest({ format: 'pdf', title: 'x'.repeat(500), steps: Array.from({ length: 300 }, () => ({ filePath: '/a.png', caption: 'y'.repeat(9000) })) })
    ?.steps.length === 200 && guide.cleanGuideRequest({ format: 'pdf', title: 'x'.repeat(500), steps: [{ filePath: '/a.png', caption: 'y'.repeat(9000) }] }).title.length === 200);
  check('request: an empty title becomes “Guide”', guide.cleanGuideRequest({ format: 'pdf', title: '   ', steps: [{ filePath: '/a.png' }] }).title === 'Guide');
  check('prefs: validated, PDF + numbered by default',
    json(guide.cleanGuidePrefs({ format: 'md', numbered: false })) === json({ format: 'md', numbered: false }) && json(guide.cleanGuidePrefs({ format: 'doc', numbered: 1 })) === json({ format: 'pdf', numbered: true }));
  check('file name: no characters a file system rejects', guide.guideFileName('a/b:c*d?"e"<f>|g') === 'a-b-c-d--e--f--g' && guide.guideFileName(' ..hidden ') === 'hidden' && guide.guideFileName('///') === '---' && guide.guideFileName('') === 'Guide');
  check('paper: Letter in the US and Canada, A4 elsewhere', guide.pageSizeFor('US') === 'Letter' && guide.pageSizeFor('ca') === 'Letter' && guide.pageSizeFor('GB') === 'A4' && guide.pageSizeFor('') === 'A4');
}

// ── 2. main.js ──
// Loads main.js against a stand-in electron (the real BrowserWindow and nativeImage) with its own
// temporary HOME, and returns what it registered plus the stand-ins' records.
function loadMain() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-guide-test-'));
  const env = { tmp, home: path.join(tmp, 'home'), handle: {}, on: {}, saveDialogs: [], savePath: null, shown: [], trashed: [] };
  fs.mkdirSync(env.home);
  process.env.HOME = env.home;   // os.homedir() → the captures folder
  const electron = {
    app: {
      getPath: name => path.join(tmp, name), whenReady: () => new Promise(() => {}), isReady: () => true,
      on() {}, focus() {}, isPackaged: false, commandLine: { hasSwitch: () => false },
      getVersion: () => '1.0.0', getLocale: () => 'en-US', getAppPath: () => ROOT, getLocaleCountryCode: () => 'US',
      getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {},
    },
    BrowserWindow, nativeImage,
    ipcMain: { handle: (c, f) => { env.handle[c] = f; }, on: (c, f) => { env.on[c] = f; }, once() {}, removeListener() {} },
    dialog: {
      // savePath: options → the path "chosen" in the panel, or null to cancel it.
      showSaveDialog: async (_win, options) => {
        env.saveDialogs.push(options);
        return env.savePath ? { canceled: false, filePath: env.savePath(options) } : { canceled: true, filePath: '' };
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: {
      showItemInFolder: file => env.shown.push(file), openPath: async () => '', openExternal: async () => {},
      trashItem: async file => { env.trashed.push(file); fs.renameSync(file, path.join(tmp, `trashed-${env.trashed.length}`)); },
    },
    Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, ShareMenu: class {},
    globalShortcut: { register: () => true, unregisterAll() {} },
    screen: {}, clipboard: {}, desktopCapturer: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
  };
  const load = Module._load;
  const before = { ex: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection') };
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  try {
    const MAIN = path.join(ROOT, 'main.js');
    const m = new Module(MAIN, module);
    m.filename = MAIN;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(fs.readFileSync(MAIN, 'utf8'), MAIN);
  } finally {
    Module._load = load;
    // main's crash handlers would swallow this script's own errors.
    process.listeners('uncaughtException').filter(l => !before.ex.includes(l)).forEach(l => process.removeListener('uncaughtException', l));
    process.listeners('unhandledRejection').filter(l => !before.rej.includes(l)).forEach(l => process.removeListener('unhandledRejection', l));
  }
  env.saveDir = path.join(env.home, 'Documents', "Jack's Picker");
  env.annDir = path.join(env.saveDir, '.annotations');
  env.settings = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'settings.json'), 'utf8')); } catch { return {}; } };
  env.log = () => { try { return fs.readFileSync(path.join(tmp, 'logs', 'main.log'), 'utf8'); } catch { return ''; } };
  return env;
}

const BLUE = [60, 90, 200], GREEN = [40, 160, 90], RED = [220, 40, 40];
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function makeImage(width, height, rgb, box = null) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
    const [r, g, b] = inBox ? box.rgb : rgb;
    const i = (y * width + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;   // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}

// Two tall-ish screenshots (so a PDF step fills most of a page), one annotated; a JPEG; a GIF; and
// an image outside the captures folder. Written a little apart, oldest first.
async function makeFixtures(m) {
  const f = {
    a: path.join(m.saveDir, 'screenshot-a.png'),
    aFlat: path.join(m.annDir, 'screenshot-a.flat.png'),
    billing: path.join(m.saveDir, 'Billing step.png'),
    photo: path.join(m.saveDir, 'photo.jpg'),
    gif: path.join(m.saveDir, 'recording-1.gif'),
    outside: path.join(m.tmp, 'elsewhere', 'secret.png'),
    out: path.join(m.tmp, 'out'),
  };
  fs.mkdirSync(m.annDir, { recursive: true });
  fs.mkdirSync(path.dirname(f.outside), { recursive: true });
  fs.mkdirSync(f.out);
  fs.writeFileSync(f.a, makeImage(1200, 1050, BLUE).toPNG());
  fs.writeFileSync(f.aFlat, makeImage(1200, 1050, BLUE, { x: 300, y: 260, w: 600, h: 530, rgb: RED }).toPNG());
  await wait(30);
  fs.writeFileSync(f.billing, makeImage(1200, 1050, GREEN).toPNG());
  await wait(30);
  fs.writeFileSync(f.photo, makeImage(640, 480, GREEN).toJPEG(85));
  await wait(30);
  fs.writeFileSync(f.gif, GIF_1PX);
  fs.writeFileSync(f.outside, makeImage(40, 30, RED).toPNG());
  return f;
}

function pdfInfo(file) {
  const s = fs.readFileSync(file).toString('latin1');
  return {
    valid: s.startsWith('%PDF-') && /%%EOF\s*$/.test(s),
    pages: (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length,
    has: text => s.includes(text),
    letter: /\/MediaBox\s*\[\s*0 0 612 792\s*\]/.test(s),
  };
}

const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

function centerColor(dataURL) {
  const img = nativeImage.createFromDataURL(dataURL || '');
  const { width, height } = img.getSize();
  if (!width) return [0, 0, 0];
  const px = img.toBitmap(), i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return [px[i + 2], px[i + 1], px[i]];
}

async function handlerTests(m, f) {
  // Handlers look up the window that asked, so calls come from a real (hidden) page.
  const host = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const call = (channel, ...args) => m.handle[channel]({ sender: host.webContents }, ...args);

  const prep = await call('guide-prepare', [f.gif, f.outside, f.a, f.billing, path.join(m.saveDir, 'gone.png')]);
  check('prepare: screenshots only, in the order given', prep.steps.map(s => path.basename(s.filePath)).join('|') === 'screenshot-a.png|Billing step.png', json(prep.steps.map(s => s.filePath)));
  check('prepare: GIFs and videos are counted as left out', prep.skipped.media === 1, json(prep.skipped));
  check('prepare: files outside the captures folder, or gone, are counted as missing', prep.skipped.missing === 2, json(prep.skipped));
  check('prepare: each step is named after its capture', prep.steps[0]?.name === 'screenshot-a' && prep.steps[1]?.name === 'Billing step');
  const [annotated, plain] = [centerColor(prep.steps[0]?.thumb), centerColor(prep.steps[1]?.thumb)];
  check('prepare: an annotated capture is shown with its annotations', prep.steps[0]?.annotated === true && annotated[0] > 180 && annotated[2] < 90, `${prep.steps[0]?.annotated} ${annotated}`);
  check('prepare: a plain capture is shown as it is', prep.steps[1]?.annotated === false && plain[1] > 120 && plain[0] < 90, `${plain}`);
  check('prepare: PDF and numbered to begin with', json(prep.prefs) === json({ format: 'pdf', numbered: true }), json(prep.prefs));
  check('prepare: nonsense gives no steps', (await call('guide-prepare', 'nope')).steps.length === 0);

  // HTML: a folder with index.html and the images
  m.savePath = options => path.join(f.out, options.defaultPath);
  const html = await call('guide-export', {
    title: 'Team <Onboarding> & "Setup"', format: 'html', numbered: true,
    steps: [{ filePath: f.billing, caption: 'Open <b>Billing</b>' }, { filePath: f.a, caption: 'Click Save\nThen close' },
      { filePath: f.outside, caption: 'secret' }, { filePath: f.gif, caption: 'gif' }, { filePath: f.photo, caption: '' }],
  });
  const panel = m.saveDialogs.at(-1);
  const dir = path.join(f.out, 'Team -Onboarding- & -Setup-');
  check('export: the save panel suggests the title as the folder name',
    panel?.defaultPath === 'Team -Onboarding- & -Setup-' && !panel.filters.length && /folder with index\.html/.test(panel.message || ''), json(panel));
  check('export (HTML): only screenshots from the captures folder go in', html.success && html.path === dir && html.count === 3 && html.skipped === 2, json(html));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().join('|') : '';
  check('export (HTML): index.html next to the images', files === 'index.html|step-01.png|step-02.png|step-03.jpg', files);
  check('export (HTML): images in step order, annotated where there are annotations',
    sameFile(path.join(dir, 'step-01.png'), f.billing) && sameFile(path.join(dir, 'step-02.png'), f.aFlat) && sameFile(path.join(dir, 'step-03.jpg'), f.photo));
  const page = fs.existsSync(dir) ? fs.readFileSync(path.join(dir, 'index.html'), 'utf8') : '';
  check('export (HTML): relative image paths, in order', /src="step-01\.png"[\s\S]*src="step-02\.png"[\s\S]*src="step-03\.jpg"/.test(page) && !page.includes(m.home));
  check('export (HTML): title and captions escaped', page.includes('<title>Team &lt;Onboarding&gt; &amp; &quot;Setup&quot;</title>')
    && page.includes('<p class="caption">Open &lt;b&gt;Billing&lt;/b&gt;</p>') && page.includes('<p class="caption">Click Save\nThen close</p>'));
  check('export (HTML): numbered', ['Step 1', 'Step 2', 'Step 3'].every(s => page.includes(`<h2>${s}</h2>`)) && !page.includes('Step 4'));
  check('export (HTML): nothing from outside the captures folder', !page.includes('secret') && !/gif/i.test(files));
  check('export (HTML): shown in Finder', m.shown.at(-1) === path.join(dir, 'index.html'), m.shown.at(-1));
  check('export: format and numbering remembered', json(m.settings().guide) === json({ format: 'html', numbered: true }), json(m.settings().guide));
  check('prepare: and offered next time', (await call('guide-prepare', [f.a])).prefs.format === 'html');

  // The same name again: the panel asked to replace it, so the earlier guide goes to the Trash.
  const md = await call('guide-export', { title: 'Team <Onboarding> & "Setup"', format: 'md', numbered: false, steps: [{ filePath: f.a, caption: '1. Open *Settings*' }] });
  const mdFiles = fs.existsSync(dir) ? fs.readdirSync(dir).sort().join('|') : '';
  check('export (Markdown): replaces an earlier guide by moving it to the Trash',
    md.success && m.trashed.length === 1 && m.trashed[0] === dir && mdFiles === 'guide.md|step-01.png', `${json(md)} ${mdFiles} ${m.trashed}`);
  const mdText = mdFiles ? fs.readFileSync(path.join(dir, 'guide.md'), 'utf8') : '';
  check('export (Markdown): escaped title and caption, unnumbered, relative image',
    mdText.startsWith('# Team \\<Onboarding\\> \\& "Setup"\n') && !mdText.includes('## Step') && mdText.includes('\n1\\. Open \\*Settings\\*\n')
    && mdText.includes('![Screenshot for step 1](step-01.png)'), mdText);

  // A folder holding anything else is never replaced.
  const notes = path.join(f.out, 'Notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'todo.txt'), 'mine');
  m.savePath = () => notes;
  const refused = await call('guide-export', { title: 'Notes', format: 'html', steps: [{ filePath: f.a }] });
  check('export: a folder with other files in it is left alone',
    !refused.success && /other files/.test(refused.error) && fs.readdirSync(notes).join() === 'todo.txt' && m.trashed.length === 1, json(refused));
  check('export: failures are logged', /Create guide/.test(m.log()));

  m.savePath = () => path.join(f.out, 'Typed.html');
  const typed = await call('guide-export', { title: 'Typed', format: 'html', steps: [{ filePath: f.a }] });
  check('export (HTML): “Typed.html” in the panel still makes a folder', typed.success && fs.existsSync(path.join(f.out, 'Typed', 'index.html')), json(typed));

  // PDF
  m.savePath = options => path.join(f.out, options.defaultPath);
  const temps = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('jqg-export-guide-')).length;
  const tempsBefore = temps();
  const pdf = await call('guide-export', { title: 'Expense report', format: 'pdf', numbered: true,
    steps: [{ filePath: f.a, caption: 'Open the Expenses tab' }, { filePath: f.billing, caption: 'Click New report' }] });
  const pdfPanel = m.saveDialogs.at(-1);
  const pdfFile = path.join(f.out, 'Expense report.pdf');
  check('export (PDF): the save panel suggests a .pdf', pdfPanel?.defaultPath === 'Expense report.pdf' && pdfPanel.filters[0]?.extensions?.[0] === 'pdf', json(pdfPanel));
  const info = pdf.success && fs.existsSync(pdfFile) ? pdfInfo(pdfFile) : null;
  check('export (PDF): a valid PDF', info?.valid, json(pdf));
  check('export (PDF): two steps, a page each (a step isn’t split)', info?.pages === 2, info?.pages);
  check('export (PDF): the step headings are bookmarks', info?.has('(Step 1)') && info?.has('(Step 2)'));
  check('export (PDF): titled, images described (tagged PDF)', info?.has('(Expense report)') && info?.has('Screenshot for step 2'));
  check('export (PDF): US Letter on a US Mac', info?.letter);
  check('export (PDF): its temporary page is removed', temps() === tempsBefore, `${tempsBefore} → ${temps()}`);
  check('export (PDF): shown in Finder', m.shown.at(-1) === pdfFile, m.shown.at(-1));

  const shown = m.saveDialogs.length, entries = fs.readdirSync(f.out).length;
  m.savePath = null;
  const canceled = await call('guide-export', { title: 'x', format: 'pdf', steps: [{ filePath: f.a }] });
  check('export: cancelling the save panel writes nothing', canceled.canceled === true && !canceled.success && fs.readdirSync(f.out).length === entries, json(canceled));
  const bad = [
    await call('guide-export', { title: 'x', format: 'exe', steps: [{ filePath: f.a }] }),
    await call('guide-export', { title: 'x', format: 'pdf', steps: [] }),
    await call('guide-export', 'nonsense'),
    await call('guide-export', { title: 'x', format: 'html', steps: [{ filePath: f.outside }, { filePath: f.gif }] }),
  ];
  check('export: unusable requests fail without asking where to save', bad.every(r => r && !r.success && !r.canceled) && m.saveDialogs.length === shown + 1, json(bad));
  check('export: screenshots from elsewhere can’t be used', /can’t be found/.test(bad[3].error || ''), bad[3].error);
  m.savePath = options => path.join(f.out, options.defaultPath);
  host.destroy();
}

// ── 3. The dialog in the editor ──
const APPEARANCES = {
  dark: { theme: 'dark', accent: 'purple', highContrast: false },
  light: { theme: 'light', accent: 'purple', highContrast: false },
  'dark-hc': { theme: 'dark', accent: 'purple', highContrast: true },
  'light-hc': { theme: 'light', accent: 'purple', highContrast: true },
};

// Contrast of each visible text run in the dialog against its composited backgrounds (the badge
// drawn over a thumbnail and disabled controls aside).
const AUDIT = `(() => {
  const parse = s => { const m = /(rgba?|color)\\(\\s*(?:srgb\\s+)?([^)]+)\\)/.exec(s || ''); if (!m) return null;
    const p = m[2].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat), k = m[1] === 'color' ? 255 : 1;
    return [p[0] * k, p[1] * k, p[2] * k, p[3] === undefined ? 1 : p[3]]; };
  const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const lum = c => .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const rows = [];
  const walker = document.createTreeWalker(document.querySelector('.guide-box'), NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.textContent.trim(), el = t.parentElement;
    if (!text || !el || el.closest('.guide-badge, :disabled')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let opacity = 1, hidden = false; const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
      opacity *= parseFloat(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0 && layers.every(l => l[3] < 1)) layers.push(bg);
    }
    if (hidden) continue;
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    fg[3] *= opacity;
    rows.push({ text: text.slice(0, 30), cls: String(el.className || el.tagName).slice(0, 30), ratio: +ratio(over(fg, bg), bg).toFixed(2) });
  }
  return rows;
})()`;

async function dialogTests(m, f, errors) {
  // The page's IPC goes to main.js's own handlers.
  for (const [channel, fn] of Object.entries(m.handle)) ipcMain.handle(channel, fn);
  for (const [channel, fn] of Object.entries(m.on)) ipcMain.on(channel, fn);
  const win = new BrowserWindow({
    show: false, width: 1200, height: 820,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `guide-ui-${Date.now()}` },
  });
  win.webContents.on('console-message', e => {
    if (e.level === 'error' || /Content Security Policy|Refused to/i.test(e.message)) errors.push(e.message);
  });
  await win.loadFile(path.join(ROOT, 'src', 'editor.html'));
  const js = code => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 6000) => {
    for (let t = 0; t < ms; t += 50) { if (await js(code)) return true; await wait(50); }
    return false;
  };
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const menuFor = paths => js(`(() => {
    selectedGalleryPaths = ${json(paths)}; syncGallerySelection();
    showGalleryContext(galleryItemsByPath.get(selectedGalleryPaths[0]), 60, 200);
    return [...document.querySelectorAll('#gallery-context button')].map(b => b.textContent);
  })()`);
  const pick = label => js(`[...document.querySelectorAll('#gallery-context button')].find(b => b.textContent === ${json(label)}).click(); 0`);
  const rows = () => js(`[...document.querySelectorAll('.guide-step')].map(r => r.querySelector('.guide-thumb').title + '=' + r.querySelector('.guide-caption').value)`);
  const click = selector => js(`document.querySelector(${json(selector)}).click(); 0`);
  const text = selector => js(`document.querySelector(${json(selector)})?.textContent ?? null`);
  const format = label => js(`[...document.querySelectorAll('.guide-seg button')].find(b => b.textContent === ${json(label)}).click(); 0`);

  check('editor: the gallery lists the fixtures', await until(`document.querySelectorAll('.gallery-item').length === 4`), await js(`document.querySelectorAll('.gallery-item').length`));

  // Menu
  let items = await menuFor([f.billing, f.gif, f.a, f.photo]);
  check('menu: a selection with screenshots offers Create Guide…, before Delete', items.at(-2) === 'Create Guide…' && items.at(-1) === 'Delete', json(items));
  check('menu: the mixed selection isn’t offered as a video', !items.includes('Combine into video'));
  const fits = await js(`(() => {
    showGalleryContext(galleryItemsByPath.get(${json(f.billing)}), 60, window.innerHeight - 4);
    const r = document.getElementById('gallery-context').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  })()`);
  check('menu: stays on screen when opened near the bottom', fits);
  check('menu: not for GIFs and videos alone', !(await menuFor([f.gif])).includes('Create Guide…'));

  // Open with three screenshots and a GIF
  await menuFor([f.billing, f.gif, f.a, f.photo]);
  await pick('Create Guide…');
  check('dialog: opens with the screenshots as steps', await until(`JPGuide.isOpen() && document.querySelectorAll('.guide-step').length === 3`));
  check('dialog: in capture order, captions from the capture names',
    json(await rows()) === json(['screenshot-a=screenshot-a', 'Billing step=Billing step', 'photo=photo']), json(await rows()));
  check('dialog: says the GIF was left out', (await text('.guide-note')) === '1 GIF or video isn’t included: guides use screenshots only.', await text('.guide-note'));
  check('dialog: marks the step that has annotations', (await js(`[...document.querySelectorAll('.guide-step')].map(r => !!r.querySelector('.guide-badge')).join()`)) === 'true,false,false');
  check('dialog: starts from the last format and numbering (PDF, numbered)',
    (await js(`document.querySelector('.guide-seg .on').textContent + '|' + document.querySelector('.guide-numbered').checked + '|' + document.querySelector('.guide-primary').textContent`)) === 'PDF|true|Create PDF…');
  check('dialog: the title field has focus', await js(`document.activeElement === document.querySelector('.guide-title')`));

  // Typing in the dialog stays in the dialog
  await js(`window.__keys = 0; window.__pastes = 0;
    document.addEventListener('keydown', () => window.__keys++); document.addEventListener('paste', () => window.__pastes++);
    { const c = document.querySelector('.guide-caption'); c.focus(); c.setSelectionRange(c.value.length, c.value.length); } 0`);
  const toolBefore = await js('tool');
  for (const k of ['b', 't', 'Backspace']) key(k);
  await wait(250);
  await js(`document.querySelector('.guide-caption').dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); 0`);
  check('dialog: typing in a caption doesn’t trigger editor shortcuts',
    (await js('tool')) === toolBefore && (await js('window.__keys')) === 0 && (await js('window.__pastes')) === 0,
    `${await js('tool')} keys=${await js('window.__keys')} pastes=${await js('window.__pastes')}`);
  check('dialog: …while the caption takes the typing', (await js(`document.querySelector('.guide-caption').value`)) === 'screenshot-ab', await js(`document.querySelector('.guide-caption').value`));

  // Reorder and remove
  await click('[aria-label="Remove step 3"]');
  check('dialog: a step can be removed', json(await rows()) === json(['screenshot-a=screenshot-ab', 'Billing step=Billing step']), json(await rows()));
  await click('[aria-label="Move step 1 down"]');
  check('dialog: ↓ moves a step down, caption and all', json(await rows()) === json(['Billing step=Billing step', 'screenshot-a=screenshot-ab']), json(await rows()));
  check('dialog: focus stays with the moved step', await js(`document.activeElement === document.querySelectorAll('.guide-caption')[1]`));
  const pts = await js(`(() => {
    const g = document.querySelectorAll('.guide-grip')[1].getBoundingClientRect(), r = document.querySelector('.guide-step').getBoundingClientRect();
    return { x: g.left + g.width / 2, y: g.top + g.height / 2, top: r.top + 4 };
  })()`);
  const mouse = (type, x, y, extra) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
  mouse('mouseDown', pts.x, pts.y, { button: 'left', clickCount: 1 });
  for (const y of [pts.y - 15, pts.y - 45, pts.top]) { mouse('mouseMove', pts.x, y, { button: 'left', modifiers: ['leftButtonDown'] }); await wait(40); }
  mouse('mouseUp', pts.x, pts.top, { button: 'left', clickCount: 1 });
  await wait(250);
  check('dialog: dragging a step by its handle reorders', json(await rows()) === json(['screenshot-a=screenshot-ab', 'Billing step=Billing step']), json(await rows()));
  check('dialog: the step numbers follow', (await js(`[...document.querySelectorAll('.guide-num')].map(n => n.textContent).join()`)) === '1,2');

  // Title, caption, Markdown, no numbers → Create
  await js(`(() => {
    const t = document.querySelector('.guide-title'); t.value = 'Expense <report> & "flow"'; t.dispatchEvent(new Event('input', { bubbles: true }));
    const c = document.querySelector('.guide-caption'); c.value = 'Click <b>Expenses</b>\\n- then wait'; c.dispatchEvent(new Event('input', { bubbles: true }));
    return 0;
  })()`);
  await format('Markdown');
  await click('.guide-numbered');
  check('dialog: Markdown changes the button and explains the folder',
    (await text('.guide-primary')) === 'Create Markdown…' && (await text('.guide-format-hint')) === 'A folder with guide.md and the images, for docs and wikis.');
  fs.mkdirSync(path.join(f.out, 'ui'));
  m.savePath = options => path.join(f.out, 'ui', options.defaultPath);
  await click('.guide-primary');
  check('dialog: Create saves the guide and closes', await until('!JPGuide.isOpen()'));
  const uiDir = path.join(f.out, 'ui', 'Expense -report- & -flow-');
  check('dialog: says where it went', (await text('#toast')) === 'Guide saved: Expense -report- & -flow-', await text('#toast'));
  const uiMd = fs.existsSync(path.join(uiDir, 'guide.md')) ? fs.readFileSync(path.join(uiDir, 'guide.md'), 'utf8') : '';
  check('dialog: the guide has the dialog’s title, order, captions and options',
    uiMd.startsWith('# Expense \\<report\\> \\& "flow"\n') && !uiMd.includes('## Step')
    && uiMd.includes('Click \\<b\\>Expenses\\</b\\>\\\n\\- then wait') && uiMd.indexOf('Expenses') < uiMd.indexOf('Billing step')
    && sameFile(path.join(uiDir, 'step-01.png'), f.aFlat) && sameFile(path.join(uiDir, 'step-02.png'), f.billing), uiMd);

  // One screenshot, from a project: the project's name is the suggested title
  await js(`localStorage.setItem('jqg-gallery-projects', JSON.stringify([{ id: 'p1', name: 'Payroll' }]));
    setProjectAssignments({ ${json(f.billing)}: 'p1' }); setActiveProject('p1'); 0`);
  await until(`document.querySelectorAll('.gallery-item').length === 1`);
  items = await menuFor([f.billing]);
  check('menu: a single screenshot offers Create Guide… too', items.includes('Create Guide…'), json(items));
  await pick('Create Guide…');
  check('dialog: one step, which can’t be removed', await until(`JPGuide.isOpen() && document.querySelectorAll('.guide-step').length === 1`)
    && (await js(`document.querySelector('[aria-label="Remove step 1"]').disabled && document.querySelector('.guide-note').hidden`)));
  check('dialog: the project’s name as the title', (await js(`document.querySelector('.guide-title').value`)) === 'Payroll');
  check('dialog: remembers Markdown, unnumbered', (await js(`document.querySelector('.guide-seg .on').textContent + '|' + document.querySelector('.guide-numbered').checked`)) === 'Markdown|false');
  await format('PDF');
  await click('.guide-numbered');
  m.savePath = null;
  await click('.guide-primary');
  await until(`!document.querySelector('.guide-primary').disabled`);
  check('dialog: cancelling the save panel leaves it as it was',
    (await js(`JPGuide.isOpen() && document.querySelector('.guide-error').hidden && document.querySelector('.guide-primary').textContent`)) === 'Create PDF…');
  fs.mkdirSync(path.join(f.out, 'ui', 'Folder.pdf'));
  m.savePath = () => path.join(f.out, 'ui', 'Folder.pdf');
  await click('.guide-primary');
  await until(`!document.querySelector('.guide-error').hidden`);
  check('dialog: a failure is explained in the dialog, which stays open',
    (await text('.guide-error')) === 'Couldn’t create the guide. “Folder.pdf” is a folder. Choose another name for the PDF.' && (await js('JPGuide.isOpen()')), await text('.guide-error'));
  m.savePath = options => path.join(f.out, 'ui', options.defaultPath);
  await click('.guide-primary');
  check('dialog: PDF from one screenshot', await until('!JPGuide.isOpen()', 10000) && pdfInfo(path.join(f.out, 'ui', 'Payroll.pdf')).pages === 1);
  await js(`setActiveProject('all'); 0`);
  await until(`document.querySelectorAll('.gallery-item').length === 4`);

  // Esc closes
  await menuFor([f.a]);
  await pick('Create Guide…');
  await until(`JPGuide.isOpen() && document.querySelectorAll('.guide-step').length === 1`);
  key('Escape');
  check('dialog: Esc closes it', await until('!JPGuide.isOpen()'));

  // Every theme: screenshots to look at, and readable text
  await menuFor([f.billing, f.gif, f.a]);
  await pick('Create Guide…');
  await until(`JPGuide.isOpen() && document.querySelectorAll('.guide-step').length === 2`);
  await js(`document.querySelector('.guide-title').value = 'How to submit an expense report'; document.activeElement.blur(); 0`);
  check('dialog: wide enough for captions (640px)', (await js(`Math.round(document.querySelector('.guide-box').getBoundingClientRect().width)`)) === 640,
    await js(`document.querySelector('.guide-box').getBoundingClientRect().width`));
  const panels = {};
  for (const [name, appearance] of Object.entries(APPEARANCES)) {
    await js(`JPTheme.apply(${json(appearance)}); 0`);
    await wait(200);
    win.webContents.invalidate();
    await wait(200);
    fs.writeFileSync(path.join(OUT, `guide-dialog-${name}.png`), (await win.webContents.capturePage()).toPNG());
    // The panel colour, and what the theme's --bg-panel token resolves to right now.
    panels[name] = await js(`(() => {
      const probe = document.createElement('div'); probe.style.background = 'var(--bg-panel)'; document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor; probe.remove();
      return [getComputedStyle(document.querySelector('.guide-box')).backgroundColor, token];
    })()`);
    const low = (await js(AUDIT)).filter(r => r.ratio < 4.5);
    check(`dialog (${name}): all text at least 4.5:1`, !low.length, json(low));
  }
  check('dialog: follows the theme (its panel is the theme’s --bg-panel)',
    Object.values(panels).every(([box, token]) => box === token) && panels.dark[0] !== panels.light[0], json(panels));
  await click('.guide-cancel');
  check('dialog: Cancel closes it', !(await js('JPGuide.isOpen()')));
  win.destroy();
}

function finish(fatal = '') {
  process.env.HOME = REAL_HOME;
  if (fatal) check(fatal, false);
  const failed = results.filter(r => !r.ok).length;
  const report = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`).join('\n')
    + `\n\n${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed (dialog screenshots in ${OUT})`;
  fs.writeFileSync(REPORT, report + '\n');
  process.stdout.write(report + '\n', () => app.exit(failed ? 1 : 0));
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => finish('timed out'), TIMEOUT_MS);
  fs.mkdirSync(OUT, { recursive: true });
  const errors = [];
  let m = null;
  try {
    builderTests();
    m = loadMain();
    const f = await makeFixtures(m);
    await handlerTests(m, f);
    await dialogTests(m, f, errors);
  } catch (e) {
    check('harness ran to completion', false, e.stack);
  }
  check('no page errors', errors.length === 0, json(errors));
  clearTimeout(timer);
  if (m) fs.rmSync(m.tmp, { recursive: true, force: true });
  finish();
});
