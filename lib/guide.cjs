// Create Guide: turns screenshots into a step-by-step guide, as a PDF or as a folder holding
// index.html (or guide.md) next to the images. main.js checks what the editor sends and asks
// where to save; this module builds the page and writes the files. It doesn't load electron
// itself: the PDF window class and the Trash are passed in, so tests can run it with fakes.
//
// Generated pages load nothing remote: inline CSS, images by relative path (or file: URL for
// the PDF), a CSP that allows only those, and every piece of user text escaped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FORMATS = ['pdf', 'html', 'md'];
const MAX_STEPS = 200;
const MAX_TITLE = 200;
const MAX_CAPTION = 4000;
const PAGE_CSP = "default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// A folder we may replace when the save panel says so: only guides made here, nothing else.
const GUIDE_FOLDER_FILE = /^(index\.html|guide\.md|step-\d+\.(png|jpe?g)|logo\.(png|jpe?g|gif|webp|svg)|\.DS_Store)$/i;
// Regions that print on US Letter; everywhere else uses A4.
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'BZ']);

const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);

// ── Checking what the renderer sends ──

function cleanTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'Guide';
}

function cleanCaption(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_CAPTION);
}

// { format, title, numbered, steps: [{ filePath, caption }] }, or null when there's nothing to
// make. File paths are only shape-checked here; main.js decides which ones may be read.
function cleanGuideRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!FORMATS.includes(r.format) || !Array.isArray(r.steps)) return null;
  const steps = r.steps
    .filter(s => s && typeof s === 'object' && typeof s.filePath === 'string' && s.filePath)
    .slice(0, MAX_STEPS)
    .map(s => ({ filePath: s.filePath, caption: cleanCaption(s.caption) }));
  if (!steps.length) return null;
  return {
    format: r.format,
    title: cleanTitle(r.title),
    numbered: typeof r.numbered === 'boolean' ? r.numbered : true,
    steps,
  };
}

// The last format and numbering used (settings.json `guide`), for the next guide.
function cleanGuidePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return { format: oneOf(p.format, FORMATS, 'pdf'), numbered: typeof p.numbered === 'boolean' ? p.numbered : true };
}

// The save panel's suggested name: the title, minus characters file systems reject.
function guideFileName(title) {
  const name = String(title ?? '')
    .replace(/[/\\:*?"<>|\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim();
  return name || 'Guide';
}

const pageSizeFor = region => (LETTER_REGIONS.has(String(region || '').toUpperCase()) ? 'Letter' : 'A4');

// ── HTML ──

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const GUIDE_CSS = `:root { color-scheme: light; --guide-accent: #5a3de0; --guide-text: #1d1b26; --guide-muted: #5f5b72; --guide-line: #e2e0ea; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #fff; color: var(--guide-text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.guide { max-width: 880px; margin: 0 auto; padding: 56px 28px 72px; }
.guide-header { margin: 0 0 40px; padding: 0 0 22px; border-bottom: 1px solid var(--guide-line); }
.brand { display: flex; align-items: center; gap: 10px; margin: 0 0 20px; font-size: 15px; font-weight: 600; color: var(--guide-muted); }
.brand-logo { display: block; height: 36px; width: auto; max-width: 220px; object-fit: contain; }
h1 { margin: 0; font-size: 32px; line-height: 1.2; font-weight: 700; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.guide-meta { margin: 10px 0 0; font-size: 14px; color: var(--guide-muted); }
.step { margin: 0 0 48px; }
.step h2 { margin: 0 0 4px; font-size: 14px; line-height: 1.4; font-weight: 700; letter-spacing: .02em; color: var(--guide-accent); }
.caption { margin: 0 0 16px; font-size: 18px; line-height: 1.5; font-weight: 500; white-space: pre-line; overflow-wrap: anywhere; }
.shot {
  display: block; max-width: 100%; height: auto;
  border: 1px solid var(--guide-line); border-radius: 10px; box-shadow: 0 2px 10px rgba(20, 16, 40, .08);
}
@media print {
  body { font-size: 11pt; }
  .guide { max-width: none; padding: 0; }
  .guide-header { margin-bottom: 22pt; padding-bottom: 12pt; }
  h1 { font-size: 22pt; }
  .guide-meta { font-size: 9.5pt; }
  /* A step (heading, caption, image) stays on one page; the image is capped to fit one. */
  .step { margin: 0 0 24pt; break-inside: avoid; page-break-inside: avoid; }
  .step h2 { font-size: 10pt; break-after: avoid; }
  .caption { font-size: 12.5pt; break-after: avoid; }
  .shot { width: auto; max-height: 7.2in; border-radius: 6px; box-shadow: none; }
}`;

const guideMeta = (date, count) => [date, `${count} step${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');

// The top of the guide: the title, the date and step count, and a brand when there is one.
// `brand` is the hook for company branding (brand presets are a separate feature; see
// guideBrand() in main.js): { name?, logoSrc? }, where logoSrc is the logo's address from the
// page (a file name next to it, or a file: URL for the PDF). Without it the header is plain.
function guideHeader({ title, brand = null, meta = '' }) {
  const name = brand?.name ? String(brand.name).trim() : '';
  const logo = brand?.logoSrc
    ? `<img class="brand-logo" src="${escapeHTML(brand.logoSrc)}" alt="${name ? '' : 'Logo'}">`
    : '';
  const brandLine = logo || name
    ? `<div class="brand">${logo}${name ? `<span class="brand-name">${escapeHTML(name)}</span>` : ''}</div>\n`
    : '';
  return `<header class="guide-header">
${brandLine}<h1>${escapeHTML(title)}</h1>
${meta ? `<p class="guide-meta">${escapeHTML(meta)}</p>\n` : ''}</header>`;
}

function guideStepHTML({ caption, src }, index, numbered) {
  const n = index + 1;
  return `<section class="step" id="step-${n}">
${numbered ? `<h2>Step ${n}</h2>\n` : ''}${caption ? `<p class="caption">${escapeHTML(caption)}</p>\n` : ''}<img class="shot" src="${escapeHTML(src)}" alt="Screenshot for step ${n}">
</section>`;
}

// steps: [{ caption, src }] in order; src is the image's address from the page.
function guideHTML({ title, date = '', steps, numbered = true, brand = null }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Jack's Picker">
<title>${escapeHTML(title)}</title>
<style>
${GUIDE_CSS}
</style>
</head>
<body>
<main class="guide">
${guideHeader({ title, brand, meta: guideMeta(date, steps.length) })}
${steps.map((step, i) => guideStepHTML(step, i, numbered)).join('\n')}
</main>
</body>
</html>
`;
}

// ── Markdown ──

// Backslash-escapes what could turn user text into formatting, links, tables or raw HTML, so it
// reads exactly as typed wherever the Markdown is shown.
function escapeMarkdown(value) {
  return String(value ?? '').replace(/[\\`*_[\]<>#|~&]/g, '\\$&');
}

// One caption line: also escape what starts a list, heading underline or numbered item.
function markdownLine(line) {
  return escapeMarkdown(line.trim())
    .replace(/^([-+=])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

// Blank lines keep separating paragraphs; single line breaks stay line breaks (a trailing "\").
function markdownParagraphs(text) {
  return String(text).split(/\n[ \t]*\n/)
    .map(para => para.split('\n').map(markdownLine).filter(Boolean).join('\\\n'))
    .filter(Boolean)
    .join('\n\n');
}

const markdownURL = src => encodeURI(String(src)).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function guideMarkdown({ title, date = '', steps, numbered = true, brand = null }) {
  const out = [];
  const name = brand?.name ? String(brand.name).trim() : '';
  if (brand?.logoSrc) out.push(`![${escapeMarkdown(name || 'Logo')}](${markdownURL(brand.logoSrc)})`, '');
  if (name) out.push(`**${escapeMarkdown(name)}**`, '');
  out.push(`# ${escapeMarkdown(title)}`, '', `_${escapeMarkdown(guideMeta(date, steps.length))}_`, '');
  steps.forEach((step, i) => {
    const n = i + 1;
    if (numbered) out.push(`## Step ${n}`, '');
    const caption = step.caption ? markdownParagraphs(step.caption) : '';
    if (caption) out.push(caption, '');
    out.push(`![Screenshot for step ${n}](${markdownURL(step.src)})`, '');
  });
  return out.join('\n');
}

// ── Writing ──

function stepImageName(index, imagePath, count) {
  const digits = Math.max(2, String(count).length);
  return `step-${String(index + 1).padStart(digits, '0')}${/\.jpe?g$/i.test(imagePath) ? '.jpg' : '.png'}`;
}

function usableLogo(brand) {
  const logoPath = brand?.logoPath;
  return typeof logoPath === 'string' && /\.(png|jpe?g|gif|webp|svg)$/i.test(logoPath) && fs.existsSync(logoPath) ? logoPath : null;
}

// Folder formats write into the chosen folder. If it already exists (the save panel has asked
// to replace it), an empty folder is used as is and a guide made earlier goes to the Trash first;
// a folder holding anything else is left alone.
async function prepareGuideFolder(dir, trashItem) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') { fs.mkdirSync(dir, { recursive: true }); return; }
    if (err.code === 'ENOTDIR') throw new Error(`“${path.basename(dir)}” is a file. Choose another name for the guide’s folder.`);
    throw err;
  }
  if (!names.some(n => n !== '.DS_Store')) return;
  const earlierGuide = names.some(n => /^(index\.html|guide\.md)$/i.test(n)) && names.every(n => GUIDE_FOLDER_FILE.test(n));
  if (!earlierGuide) throw new Error(`“${path.basename(dir)}” already has other files in it. Choose another name for the guide’s folder.`);
  await trashItem(dir);
  fs.mkdirSync(dir, { recursive: true });
}

async function writeGuideFolder({ format, dir, title, date, numbered, steps, brand, trashItem }) {
  await prepareGuideFolder(dir, trashItem);
  const pageSteps = steps.map((step, i) => {
    const name = stepImageName(i, step.imagePath, steps.length);
    fs.copyFileSync(step.imagePath, path.join(dir, name));
    return { caption: step.caption, src: name };
  });
  const logoPath = usableLogo(brand);
  let pageBrand = brand?.name ? { name: brand.name } : null;
  if (logoPath) {
    const logoName = `logo${path.extname(logoPath).toLowerCase()}`;
    fs.copyFileSync(logoPath, path.join(dir, logoName));
    pageBrand = { ...pageBrand, logoSrc: logoName };
  }
  const index = format === 'md' ? 'guide.md' : 'index.html';
  const page = { title, date, numbered, steps: pageSteps, brand: pageBrand };
  fs.writeFileSync(path.join(dir, index), format === 'md' ? guideMarkdown(page) : guideHTML(page));
  return path.join(dir, index);
}

const PDF_FOOTER = `<div style="width:100%;padding:0 0.6in;display:flex;justify-content:space-between;gap:16px;font:8px -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#8a8699">`
  + '<span class="title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>'
  + '<span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';

// Prints a guide page to PDF in a hidden window that runs no scripts and shares no storage.
// The page is written to a temp folder so its file: images load (a data: URL page can't); the
// "jqg-export-" prefix means main's launch cleanup sweeps it if the app quits halfway.
async function renderGuidePDF({ BrowserWindow, html, pageSize = 'A4' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqg-export-guide-'));
  const file = path.join(dir, 'index.html');
  let win = null;
  try {
    fs.writeFileSync(file, html);
    win = new BrowserWindow({
      show: false, width: 1000, height: 1300,
      webPreferences: {
        offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: 'jqg-guide-pdf',
      },
    });
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      pageSize,
      printBackground: true,
      margins: { top: 0.6, bottom: 0.75, left: 0.6, right: 0.6 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: PDF_FOOTER,
      // Accessible PDF: the step headings become bookmarks, the alt text is kept.
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Writes the guide and returns { path, reveal } (what was made, and what to show in Finder).
// steps: [{ caption, imagePath }] in order; brand: { name?, logoPath? } or null.
// deps: BrowserWindow (PDF only) and trashItem(path) (replacing an earlier guide folder).
async function writeGuide({ format, outPath, title, date = '', numbered = true, steps, brand = null, pageSize, BrowserWindow, trashItem }) {
  if (!FORMATS.includes(format)) throw new Error(`Unknown guide format: ${format}`);
  if (!steps?.length) throw new Error('A guide needs at least one screenshot.');
  if (format !== 'pdf') {
    // "Guide.html" or "Guide.md" typed into the save panel still means a folder named "Guide".
    const dir = outPath.replace(/\.(html?|md|markdown)$/i, '') || outPath;
    const index = await writeGuideFolder({ format, dir, title, date, numbered, steps, brand, trashItem });
    return { path: dir, reveal: index };
  }
  const file = /\.pdf$/i.test(outPath) ? outPath : `${outPath}.pdf`;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw new Error(`“${path.basename(file)}” is a folder. Choose another name for the PDF.`);
  const logoPath = usableLogo(brand);
  const html = guideHTML({
    title, date, numbered,
    steps: steps.map(s => ({ caption: s.caption, src: pathToFileURL(s.imagePath).href })),
    brand: brand?.name || logoPath ? { name: brand?.name, logoSrc: logoPath ? pathToFileURL(logoPath).href : null } : null,
  });
  fs.writeFileSync(file, await renderGuidePDF({ BrowserWindow, html, pageSize }));
  return { path: file, reveal: file };
}

module.exports = {
  FORMATS, MAX_STEPS, MAX_TITLE, MAX_CAPTION,
  cleanGuideRequest, cleanGuidePrefs, guideFileName, pageSizeFor,
  escapeHTML, escapeMarkdown, guideHeader, guideHTML, guideMarkdown,
  writeGuide, renderGuidePDF,
};
