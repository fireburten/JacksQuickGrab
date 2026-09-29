// On-device text index behind the gallery search: the text in each screenshot, read once with
// the Vision OCR helper and kept in a JSON file in the app's data folder (it never leaves the
// Mac). An entry is keyed by file name and re-read when the image, or its annotated copy,
// changes. Indexing runs one image at a time, newest first, so recent captures are findable
// soonest and a big backlog doesn't hog the machine.
const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;
const SNIPPET_RADIUS = 36;

// Lowercase, without accents, whitespace collapsed: "Café  Menu" matches "cafe menu".
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// The words around the first match, for the card under the thumbnail.
function snippetFor(text, terms) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  const hay = normalize(plain);
  const at = Math.min(...terms.map(t => hay.indexOf(t)).filter(i => i >= 0));
  if (!Number.isFinite(at)) return '';
  const start = Math.max(0, at - SNIPPET_RADIUS), end = Math.min(plain.length, at + SNIPPET_RADIUS * 2);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`;
}

/**
 * @param {object} o
 * @param {string} o.file              where the index is kept
 * @param {() => {name: string, path: string}[]} o.listImages   screenshots to index, newest first
 * @param {(imagePath: string) => string} o.sourceFor          the file to read (annotated copy if any)
 * @param {(sourcePath: string) => Promise<string>} o.readText  OCR
 */
function createSearchIndex({ file, listImages, sourceFor, readText, logError = () => {}, onChange = () => {} }) {
  let data = load();
  let enabled = true, running = false, again = false, timer = null, pending = 0;

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.version === INDEX_VERSION && d.entries && typeof d.entries === 'object') return d;
    } catch {}
    return { version: INDEX_VERSION, entries: {} };
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (err) { logError('Search index', err); }
  }

  function fingerprint(src) {
    try { const st = fs.statSync(src); return `${st.size}:${Math.round(st.mtimeMs)}`; }
    catch { return null; }
  }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const images = listImages();
        const names = new Set(images.map(i => i.name));
        let changed = false;
        for (const name of Object.keys(data.entries)) {
          if (!names.has(name)) { delete data.entries[name]; changed = true; }
        }
        const todo = images
          .map(img => ({ ...img, src: sourceFor(img.path) }))
          .map(img => ({ ...img, stamp: fingerprint(img.src) }))
          .filter(img => img.stamp && data.entries[img.name]?.stamp !== img.stamp);
        pending = todo.length;
        for (const img of todo) {
          if (!enabled) break;
          let text = '';
          try { text = await readText(img.src); } catch (err) { logError('Search index', err); }
          data.entries[img.name] = { stamp: img.stamp, text: String(text || '').slice(0, 20000) };
          pending--;
          changed = true;
          if (pending % 10 === 0) save();   // keep progress if the app quits mid-way
        }
        pending = 0;
        if (changed) { save(); onChange(); }
      } while (again && enabled);
    } finally {
      running = false;
    }
  }

  return {
    // Coalesces bursts (a capture writes the image, then its annotated copy).
    schedule(delay = 1500) {
      if (!enabled) return;
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    run,
    setEnabled(on) {
      enabled = !!on;
      if (enabled) return;
      clearTimeout(timer);
      data = { version: INDEX_VERSION, entries: {} };
      try { fs.unlinkSync(file); } catch {}
    },
    // Captures whose name or text holds every word of the query, as [{ name, snippet }].
    search(query, names) {
      const terms = normalize(query).split(' ').filter(Boolean);
      if (!terms.length) return [];
      return names.flatMap(name => {
        const text = enabled ? data.entries[name]?.text || '' : '';
        const hay = `${normalize(name)} ${normalize(text)}`;
        if (!terms.every(t => hay.includes(t))) return [];
        const inName = terms.every(t => normalize(name).includes(t));
        return [{ name, snippet: inName ? '' : snippetFor(text, terms) }];
      });
    },
    status: () => ({ enabled, indexed: Object.keys(data.entries).length, pending }),
    textOf: name => data.entries[name]?.text || '',
  };
}

module.exports = { createSearchIndex, normalize, snippetFor };
