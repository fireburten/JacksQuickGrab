// Renders store/privacy-policy.md to docs/privacy.html for GitHub Pages, so the App Store
// privacy policy URL always matches the Markdown source. Handles only the Markdown that
// file uses (headings, paragraphs, bullet lists, bold, code, links) to avoid a dependency.
// Usage: node scripts/build-privacy-page.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = 'store/privacy-policy.md';
const OUT = 'docs/privacy.html';

const escapeHtml = text => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inline = text => escapeHtml(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

function render(markdown) {
  const html = [];
  let title = '';
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) html.push(`<ul>\n${list.map(li => `  <li>${inline(li)}</li>`).join('\n')}\n</ul>`); list = null; };

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^-\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      if (level === 1) title = heading[2];
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      flushPara();
      (list ||= []).push(bullet[1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return { title, body: html.join('\n') };
}

const { title, body } = render(readFileSync(SRC, 'utf8'));

const page = `<!doctype html>
<!-- Generated from ${SRC} by scripts/build-privacy-page.mjs. Edit the Markdown, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf9fd; --fg: #1d1a2b; --muted: #5d5873; --accent: #6c4ef6; --rule: #e4e0f0; --code: #efecf8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #120c28; --fg: #ece9f7; --muted: #aaa4c4; --accent: #a894ff; --rule: #2c2449; --code: #221a40; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 0.5rem; }
  h2 { font-size: 1.2rem; margin: 2.25rem 0 0.5rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
  p, ul { margin: 0 0 1rem; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 0.35rem; }
  a { color: var(--accent); }
  code { background: var(--code); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.88em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  h1 + p { color: var(--muted); }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

mkdirSync('docs', { recursive: true });
writeFileSync(OUT, page);
console.log(`Wrote ${OUT}`);
