// Accessibility audit of every window: controls a screen reader can name (icon-only buttons need
// a label), images with alt text, dialogs announced as dialogs, a visible keyboard focus ring,
// and keyboard use of the editor's dialogs, colour swatches and Recents.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-accessibility.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-accessibility.txt.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-accessibility.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const DIR = "/Users/x/Documents/Jack's Picker";
const THUMB = nativeImage.createFromPath(path.join(ROOT, 'picker-hud.png')).resize({ width: 120 }).toDataURL();
const capture = name => ({ filename: name, filePath: `${DIR}/${name}`, fileURL: 'file://x', kind: 'image', thumb: THUMB, annotations: [], time: 1 });
const SETTINGS = {
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large' },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800, camera: false, cameraSize: 'medium', cameraCorner: 'bottom-right', cameraShape: 'circle' },
  brand: { name: '', logo: 0, watermark: 'off', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6, autoWatermark: false, stamp: 'none', palette: [], usePalette: false },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: false, searchText: true, checkSensitive: false, afterCapture: 'editor',
  capturesFolder: { path: DIR, isDefault: true, defaultPath: DIR }, managed: {}, sharing: { destinations: [] },
};
const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
handle('settings-get', () => SETTINGS);
handle('settings-set', () => SETTINGS);
handle('gallery-list', () => [capture('screenshot-1.png'), capture('screenshot-2.png')]);
handle('gallery-search', () => ({ items: [], enabled: true, indexed: 0, pending: 0 }));
handle('search-status', () => ({ enabled: true, indexed: 2, pending: 0 }));
handle('project-folders', () => ({}));
handle('shortcuts-get', () => ({ defaults: {}, shortcuts: { region: 'CommandOrControl+Shift+2', repeat: 'CommandOrControl+Alt+Shift+2', window: 'CommandOrControl+Alt+Shift+W', full: 'CommandOrControl+Shift+1', text: 'CommandOrControl+Alt+Shift+T' } }));
['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'brand-logo-get', 'mic-access', 'camera-access'].forEach(c => handle(c, () => null));
handle('guide-prepare', (_e, paths) => ({ steps: (paths || []).map(p => ({ filePath: p, name: path.basename(p), thumb: THUMB })), skipped: { media: 0, missing: 0 }, prefs: { format: 'pdf', numbered: true } }));
app.on('window-all-closed', () => {});

// Runs in the page: problems with names, images, dialogs and the document language.
const AUDIT = `(() => {
  const problems = [];
  const shown = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]'); };
  const text = el => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const labelledBy = el => (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim();
  const nameOf = el => (el.getAttribute('aria-label') || '').trim() || labelledBy(el)
    || (el.labels && el.labels[0] ? text(el.labels[0]) : '')
    || (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? '' : text(el))
    || (el.getAttribute('title') || '').trim() || (el.getAttribute('placeholder') || '').trim();
  const symbolsOnly = s => s && !/[A-Za-z0-9\\u00C0-\\u024F\\u0400-\\u04FF\\u3040-\\u30FF\\u4E00-\\u9FFF]/.test(s);
  const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + (text(el) ? ' "' + text(el).slice(0, 20) + '"' : '');
  document.querySelectorAll('button, [role=button], [role=radio], [role=switch], a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])').forEach(el => {
    if (!shown(el)) return;
    const name = nameOf(el);
    if (!name) problems.push('no accessible name: ' + describe(el));
    else if (!el.getAttribute('aria-label') && !labelledBy(el) && symbolsOnly(text(el))) problems.push('icon-only, needs aria-label: ' + describe(el));
  });
  document.querySelectorAll('img').forEach(img => { if (shown(img) && !img.hasAttribute('alt')) problems.push('image without alt: ' + describe(img)); });
  document.querySelectorAll('.choice-backdrop.on .choice-box, .settings-backdrop.on .settings-box').forEach(box => {
    if (box.getAttribute('role') !== 'dialog') problems.push('open dialog without role=dialog: ' + describe(box));
    else if (!nameOf(box)) problems.push('dialog without a name: ' + describe(box));
  });
  if (!document.documentElement.lang) problems.push('no lang on <html>');
  return problems;
})()`;

async function openPage(file, size, errors, setup) {
  const w = new BrowserWindow({
    show: false, ...size,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `a11y-${file}-${Date.now()}` },
  });
  w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(`${file}: ${e.message}`); });
  await w.loadFile(path.join(ROOT, 'src', file));
  await wait(900);
  if (setup) await setup(w);
  return w;
}

async function audit(w, where) {
  const problems = await w.webContents.executeJavaScript(AUDIT);
  check(`${where}: every control has a name`, problems.length === 0, problems.join('\n    '));
}

app.whenReady().then(async () => {
  const errors = [];
  try {
    // ── Editor, its dialogs and Settings ──
    const ed = await openPage('editor.html', { width: 1300, height: 860 }, errors);
    const js = code => ed.webContents.executeJavaScript(code);
    await js(`(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; return loadImageWithAnns(c.toDataURL(), ${JSON.stringify(`${DIR}/screenshot-1.png`)}, []).then(() => 0); })()`);
    await wait(300);
    await audit(ed, 'editor');
    check('editor: the toast is announced', (await js(`document.getElementById('toast').getAttribute('role')`)) === 'status');
    check('editor: the canvas has a description', !!(await js(`document.getElementById('c')?.getAttribute('aria-label') || document.querySelector('canvas')?.getAttribute('aria-label')`)));

    // A visible focus ring for keyboard users
    ed.webContents.focus();
    ed.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); ed.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait(150);
    // Offscreen windows never get OS focus, so :focus-visible may not apply here: check the rule
    // exists, and that it styles the focused control whenever the browser does apply it.
    const ring = await js(`(() => {
      const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
      const rule = rules.find(r => r.selectorText === ':focus-visible');
      const el = document.activeElement, cs = getComputedStyle(el);
      return { rule: !!rule && /solid/.test(rule.style.outline), tag: el.tagName, applies: el.matches(':focus-visible'), outline: cs.outlineStyle !== 'none' };
    })()`);
    check('keyboard focus is visible', ring.rule && ring.tag !== 'BODY' && (!ring.applies || ring.outline), JSON.stringify(ring));

    // Colour swatches and Recents work from the keyboard
    const swatch = await js(`(() => { const s = document.querySelector('.swatches .sw[data-c="#EF4444"]'); return { tab: s.tabIndex, role: s.getAttribute('role'), name: s.getAttribute('aria-label') }; })()`);
    check('colour swatches are keyboard buttons with names', swatch.tab === 0 && ['button', 'radio'].includes(swatch.role) && !!swatch.name, JSON.stringify(swatch));
    await js(`{ const s = document.querySelector('.swatches .sw[data-c="#EF4444"]'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } 0`);
    check('Enter on a swatch picks the colour', (await js('color')).toUpperCase() === '#EF4444');
    await js('loadGallery().then(() => 0)'); await wait(300);
    const card = await js(`(() => { const c = document.querySelector('.gallery-item'); return c && { tab: c.tabIndex, role: c.getAttribute('role'), name: c.getAttribute('aria-label') }; })()`);
    check('Recents cards can be reached and named', card && card.tab === 0 && !!card.name, JSON.stringify(card));

    // Dialogs: announced, focus moves in, Esc closes, focus comes back
    await js(`document.getElementById('btn-zoom-in').focus(); 0`);
    await js('showHotkeys().then(() => 0)'); await wait(200);
    await audit(ed, 'hotkey dialog');
    check('opening a dialog moves focus into it', await js(`!!document.activeElement.closest('#hotkey-backdrop')`));
    ed.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(200);
    check('Esc closes the dialog', !(await js(`document.getElementById('hotkey-backdrop').classList.contains('on')`)));
    check('focus returns to what opened it', (await js('document.activeElement.id')) === 'btn-zoom-in', await js('document.activeElement.id'));
    await js(`showStampChooser(); 0`); await wait(200);
    await audit(ed, 'stamp dialog');
    ed.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(200);
    if (await js('!!window.JPGuide')) {
      await js(`JPGuide.open([galleryItemsByPath.get(${JSON.stringify(`${DIR}/screenshot-1.png`)})]); 0`); await wait(500);
      await audit(ed, 'guide dialog');
      ed.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(200);
    }
    for (const section of ['appearance', 'annotations', 'brand', 'capture', 'recording', 'storage', 'sharing']) {
      const opened = await js(`JPSettings.open(${JSON.stringify(section)}).then(() => document.querySelector('.sp-body h2')?.textContent || '')`);
      if (section === 'sharing' && opened.toLowerCase() !== 'sharing') continue;   // only once Send to… is in
      await wait(150);
      await audit(ed, `Settings → ${opened}`);
    }
    await js('JPSettings.close(); 0');
    ed.destroy();

    // ── The other windows ──
    const hud = await openPage('hud.html', { width: 560, height: 90 }, errors);
    await audit(hud, 'HUD');
    hud.destroy();
    const picker = await openPage('window-picker.html', { width: 900, height: 600 }, errors, async w => {
      w.webContents.send('window-sources', [{ id: 'w1', name: 'Safari — Docs', thumb: THUMB }]);
      await wait(200);
    });
    await audit(picker, 'window picker');
    picker.destroy();
    const thumb = await openPage('thumbnail.html', { width: 240, height: 180 }, errors, async w => {
      w.webContents.send('thumbnail-data', { preview: THUMB, dismissAfterMs: 60000 }); await wait(200);
    });
    await audit(thumb, 'capture thumbnail');
    thumb.destroy();
    const pin = await openPage('pin.html', { width: 500, height: 400 }, errors, async w => {
      w.webContents.send('pin-data', { dataURL: THUMB, width: 500, height: 400, opacity: 1 }); await wait(200);
      await w.webContents.executeJavaScript(`document.body.classList.add('show-controls'); document.querySelector('button')?.focus(); 0`);
    });
    await audit(pin, 'pinned image');
    pin.destroy();
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
