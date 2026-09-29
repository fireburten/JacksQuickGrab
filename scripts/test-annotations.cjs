// Electron harness for the editor's annotation tools: the tool variants (line, ellipse,
// spotlight, pixelate), step numbers, and what ends up in copies and exports. Loads the real
// editor offscreen with main's IPC stubbed, draws with real mouse events and checks pixels.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-annotations.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-annotations.txt.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-annotations.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let copied = null, settingsSets = [];
// A 200×100 red logo for the watermark tests (made once the app is ready).
let LOGO = null;
ipcMain.on('editor-copy', (_e, dataURL) => { copied = dataURL; });
ipcMain.on('annotation-save', () => {});
ipcMain.handle('annotation-save-now', () => ({ success: true }));
ipcMain.handle('settings-set', (_e, patch) => { settingsSets.push(patch); return { ...SETTINGS, ...patch, brand: { ...SETTINGS.brand, ...patch.brand } }; });
ipcMain.handle('brand-logo-get', () => LOGO);
const SETTINGS = {
  appearance: { theme: 'dark', accent: 'purple', highContrast: false, uiScale: 1, hudScale: 1, thumbSize: 'large' },
  editor: { color: '#6C4EF6', stroke: 15, textSize: 0 },
  recording: { systemAudio: false, mic: false, gifFps: 12, gifWidth: 800 },
  brand: { name: '', logo: 0, watermark: 'off', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6, autoWatermark: false, stamp: 'none', palette: [], usePalette: false },
  autoCopyAfterCapture: false, launchAtLogin: false, launchAtLoginAvailable: false,
  capturesFolder: { path: "/Users/x/Documents/Jack's Picker", isDefault: true, defaultPath: "/Users/x/Documents/Jack's Picker" },
};
ipcMain.handle('settings-get', () => SETTINGS);
['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'shortcuts-get'].forEach(c => ipcMain.handle(c, () => null));
ipcMain.handle('gallery-list', () => []);
ipcMain.handle('project-folders', () => ({}));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const { nativeImage } = require('electron');
  const red = Buffer.alloc(200 * 100 * 4);
  for (let i = 0; i < red.length; i += 4) red.set([0, 0, 255, 255], i);   // BGRA
  LOGO = nativeImage.createFromBitmap(red, { width: 200, height: 100 }).toDataURL();
  const errors = [];
  const w = new BrowserWindow({
    show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `annotations-${Date.now()}` },
  });
  w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const js = code => w.webContents.executeJavaScript(code);
  try {
    await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
    await wait(1000);
    // A 600×400 checkerboard (so blur and pixelate change it visibly), zoomed to 100%.
    await js(`{ const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d');
      for (let y = 0; y < 400; y += 10) for (let x = 0; x < 600; x += 10) { g.fillStyle = ((x + y) / 10) % 2 ? '#f5f5f5' : '#3c64c8'; g.fillRect(x, y, 10, 10); }
      loadImageWithAnns(c.toDataURL(), '/Users/x/Documents/Jack\\'s Picker/test.png', []); } 0`);
    await wait(400);
    await js('setZoom(1); 0');
    await wait(150);

    // Real mouse input at canvas coordinates.
    const toClient = (x, y) => js(`(() => { const r = canvas.getBoundingClientRect(); return { x: r.left + ${x} * r.width / canvas.width, y: r.top + ${y} * r.height / canvas.height }; })()`);
    const mouse = async (type, x, y) => {
      const p = await toClient(x, y);
      w.webContents.sendInputEvent({ type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
      await wait(30);
    };
    const drag = async (x1, y1, x2, y2) => {
      await mouse('mouseDown', x1, y1);
      await mouse('mouseMove', (x1 + x2) / 2, (y1 + y2) / 2);
      await mouse('mouseMove', x2, y2);
      await mouse('mouseUp', x2, y2);
    };
    const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await wait(60); };
    const clearAnns = () => js('anns = []; selectedIdx = -1; render(); 0');
    const last = () => js('JSON.stringify(anns[anns.length - 1] || null)').then(JSON.parse);
    // Pixel of the export (no selection handles or guides).
    const pixel = (x, y) => js(`new Promise(res => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); res([...g.getImageData(${x}, ${y}, 1, 1).data].slice(0, 3)); }; img.src = compositeDataURL(); })`);
    const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const BLUE = [60, 100, 200], LIGHT = [245, 245, 245], RED = [239, 68, 68];
    const bg = (x, y) => ((Math.floor(x / 10) + Math.floor(y / 10)) % 2 ? LIGHT : BLUE);   // the checkerboard

    // Tool variants share a rail button; the props bar offers them.
    await key('O');
    const railBox = () => js(`(b => ({ active: b.classList.contains('active'), tool: b.dataset.tool, label: b.querySelector('.lbl').textContent }))(document.querySelector('.tbtn[data-group=box]'))`);
    const chips = () => js(`[...document.querySelectorAll('#tool-variants button')].map(b => (b.classList.contains('on') ? '*' : '') + b.textContent).join(' | ')`);
    check('O picks Ellipse on the Box button', (await js('tool')) === 'ellipse' && JSON.stringify(await railBox()) === JSON.stringify({ active: true, tool: 'ellipse', label: 'Ellipse' }), JSON.stringify(await railBox()));
    check('the props bar offers Box and Ellipse', (await chips()) === '▭ Box | *◯ Ellipse', await chips());
    await js(`[...document.querySelectorAll('#tool-variants button')][0].click(); 0`);
    check('choosing Box from the props bar', (await js('tool')) === 'box' && (await railBox()).label === 'Box');
    await key('D');
    check('tools without variants hide the chips', await js(`document.getElementById('tool-variants').hidden && !document.getElementById('p-tool').hidden`));

    // Ellipse
    await clearAnns(); await key('O'); await js(`setColor('#EF4444'); 0`);
    await drag(100, 100, 300, 250);
    const ell = await last();
    check('ellipse is drawn from a drag', ell?.type === 'ellipse' && Math.round(ell.w) === 200 && Math.round(ell.h) === 150, JSON.stringify(ell));
    const [edge, middle] = [await pixel(100, 175), await pixel(205, 175)];
    check('ellipse: outline in colour, middle untouched', near(edge, RED, 40) && near(middle, bg(205, 175)), JSON.stringify([edge, middle]));

    // Line: drawn, selectable near the stroke, movable
    await clearAnns(); await key('L');
    await drag(50, 350, 550, 350);
    const line = await last();
    check('line is drawn from a drag', line?.type === 'line' && Math.abs(line.x1 - 50) <= 1 && Math.abs(line.x2 - 550) <= 1, JSON.stringify(line));
    check('line appears in the export', near(await pixel(300, 350), RED, 40), JSON.stringify(await pixel(300, 350)));
    await js('selectedIdx = -1; setTool("select"); 0');
    await mouse('mouseDown', 300, 353); await mouse('mouseMove', 300, 330); await mouse('mouseUp', 300, 330);
    const moved = await last();
    check('line can be selected near its stroke and moved', Math.round(moved.y1) === 327 && Math.round(moved.y2) === 327, JSON.stringify(moved));

    // Steps: click places 1, 2, 3; renumbering closes gaps
    await clearAnns(); await key('N');
    for (const [x, y] of [[100, 100], [200, 100], [300, 100]]) { await mouse('mouseDown', x, y); await mouse('mouseUp', x, y); }
    const steps = await js(`JSON.stringify(anns.map(a => a.type + a.n))`);
    check('clicks place numbered steps 1, 2, 3', steps === '["step1","step2","step3"]', steps);
    const s1 = await js('JSON.stringify(anns[0])').then(JSON.parse);
    check('a step is centred on the click, round', Math.abs(s1.x + s1.w / 2 - 100) <= 1 && Math.abs(s1.y + s1.h / 2 - 100) <= 1 && s1.w === s1.h, JSON.stringify(s1));
    check('step badge is drawn in colour', near(await pixel(100 - Math.round(s1.w * .3), 100), RED, 40), JSON.stringify(await pixel(100 - Math.round(s1.w * .3), 100)));
    await js('selectedIdx = 1; deleteSelected(); 0');
    await js(`document.getElementById('insp-step-renumber').click(); 0`);
    check('Renumber closes the gap', (await js(`JSON.stringify(anns.map(a => a.n))`)) === '[1,2]');
    await js('selectedIdx = 0; updateInspector(); 0');
    check('the inspector shows the step number', (await js(`!document.getElementById('insp-step').hidden && document.getElementById('insp-step-n').value`)) === '1');
    await js(`{ const i = document.getElementById('insp-step-n'); i.value = 7; i.dispatchEvent(new Event('input')); } 0`);
    check('the step number can be changed', (await js('anns[0].n')) === 7);
    await js('setTool("step"); 0');
    await mouse('mouseDown', 400, 300); await mouse('mouseUp', 400, 300);
    check('the next step continues from the highest', (await last()).n === 8);

    // Spotlight: dims outside, not inside; two spotlights don't darken each other
    await clearAnns(); await key('F');
    await drag(50, 50, 150, 150);
    check('spotlight: inside untouched', near(await pixel(75, 75), bg(75, 75)), JSON.stringify(await pixel(75, 75)));
    const outside = await pixel(405, 305);
    check('spotlight: outside dimmed', outside.every((v, i) => v <= bg(405, 305)[i] * .5), JSON.stringify(outside));
    await drag(250, 150, 120, 50);   // overlaps the first (started outside it: a drag that starts on one moves it)
    const overlap = await pixel(135, 75), inSecond = await pixel(205, 75), stillOut = await pixel(405, 305);
    check('two spotlights: both inside areas stay undimmed', near(overlap, bg(135, 75)) && near(inSecond, bg(205, 75)), JSON.stringify([overlap, inSecond]));
    check('two spotlights: outside dimmed once, not twice', near(stillOut, outside, 3), JSON.stringify([outside, stillOut]));

    // Pixelate: whole blocks of one colour
    await clearAnns(); await key('P');
    await drag(300, 50, 500, 250);
    const pix = await last();
    check('pixelate is a blur variant', pix?.type === 'blur' && pix.mode === 'pixelate', JSON.stringify(pix));
    const blocky = await js(`new Promise(res => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(300, 50, 200, 200).data; let same = 0, total = 0;
      for (let y = 0; y < 200; y += 3) for (let x = 0; x < 199; x += 3) { const i = (y * 200 + x) * 4, j = i + 4; total++; if (d[i] === d[j] && d[i+1] === d[j+1] && d[i+2] === d[j+2]) same++; }
      res(same / total); }; img.src = compositeDataURL(); })`);
    check('pixelated area is made of flat blocks', blocky > .85, `neighbours equal: ${blocky}`);
    // Each block is the average of its pixels: a fine checkerboard turns into in-between shades.
    const mids = await Promise.all([[330, 80], [400, 150], [470, 220]].map(([x, y]) => pixel(x, y)));
    check('pixelate averages each block (no moiré, detail wiped)', mids.every(p => p[0] > 90 && p[0] < 215 && p[2] > 205), JSON.stringify(mids));

    // Copies and exports never include selection handles or guides
    await clearAnns(); await key('B');
    await drag(100, 100, 200, 200);   // the new box stays selected, with handles on screen
    check('the new box stays selected (handles on screen)', (await js('selectedIdx')) === 0);
    await js('doCopy(); 0'); await wait(200);
    check('copy matches the export (no selection handles)', copied && copied === await js('compositeDataURL()'), 'copied image differs from the clean export');

    // ── Brand: stamps, watermarks, new-capture defaults, palette, Settings → Brand ──
    await clearAnns();
    await js(`showStampChooser(); 0`); await wait(150);
    check('Add Stamp offers the presets and Custom', (await js(`[...document.querySelectorAll('#stamp-choices button')].map(b => b.textContent).join('|')`)) === 'CONFIDENTIAL|INTERNAL|DRAFT|APPROVED|Custom…');
    await js(`document.querySelector('#stamp-choices button').click(); 0`); await wait(150);
    const stamp = await last();
    check('a stamp lands in the top-right corner', stamp?.type === 'stamp' && stamp.text === 'CONFIDENTIAL' && stamp.x + stamp.w > 560 && stamp.y < 30, JSON.stringify(stamp));
    const border = await pixel(Math.floor(stamp.x + Math.max(2, stamp.fs * .12) / 2), Math.round(stamp.y + stamp.h / 2));
    check('the stamp is drawn with its coloured border', near(border, [220, 38, 38], 50), JSON.stringify(border));
    await js(`{ const a = anns[anns.length - 1], h = getHandles(a).find(h => h.id === 'sw'); selectedIdx = anns.length - 1; resizeAnchor = computeAnchor(a, 'sw'); applyResize(a, h.x - 40, h.y + 20); } 0`);
    const bigger = await last();
    check('resizing a stamp scales its text', bigger.fs > stamp.fs, `${stamp.fs} → ${bigger.fs}`);

    await clearAnns();
    await js(`appSettingsCache = { ...appSettingsCache, brand: { name: 'Rind Works', watermark: 'name', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6 } }; addWatermark(); 0`); await wait(200);
    const wm = await last();
    check('name watermark sits bottom-right', wm?.type === 'stamp' && wm.style === 'watermark' && wm.text === 'Rind Works' && wm.x + wm.w > 560 && wm.y + wm.h > 370, JSON.stringify(wm));
    await js(`addWatermark(); 0`); await wait(200);
    check('adding the watermark again replaces it', (await js(`anns.filter(a => a.brand === 'watermark').length`)) === 1);
    await js(`appSettingsCache.brand = { ...appSettingsCache.brand, watermark: 'logo', logo: 1, watermarkCorner: 'tl', watermarkSize: 'small' }; addWatermark(); 0`); await wait(300);
    const lw = await last();
    check('logo watermark: 10% of the width, aspect kept, top-left', lw?.type === 'image' && Math.round(lw.w) === 60 && Math.round(lw.h) === 30 && lw.x < 20 && lw.y < 20 && lw.opacity === .6, JSON.stringify({ ...lw, src: undefined }));
    const logoPx = await pixel(Math.round(lw.x + lw.w / 2), Math.round(lw.y + lw.h / 2));
    check('logo watermark is blended at its opacity', logoPx[0] > 150 && logoPx[1] < 150, JSON.stringify(logoPx));
    await js(`appSettingsCache.brand = { watermark: 'off' }; JPSettings.close(); addWatermark(); 0`); await wait(300);
    check('with no brand set up, Add Watermark opens Settings → Brand', await js(`JPSettings.isOpen() && document.querySelector('.sp-body h2').textContent === 'Brand'`));
    await js('JPSettings.close(); 0');

    // A new capture gets the watermark and stamp, and auto-copy copies them
    copied = null;
    await js(`appSettingsCache = { ...appSettingsCache, autoCopyAfterCapture: true, brand: { name: 'Rind Works', watermark: 'name', watermarkCorner: 'br', watermarkSize: 'medium', watermarkOpacity: .6, autoWatermark: true, stamp: 'internal' } }; 0`);
    const shot = await js(`(() => { const c = document.createElement('canvas'); c.width = 500; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 500, 300); return c.toDataURL(); })()`);
    w.webContents.send('image-data', { imageDataURL: shot, savedFilePath: '/Users/x/Documents/Jack\'s Picker/new.png' });
    await wait(700);
    check('a new capture gets the watermark and INTERNAL stamp', (await js(`JSON.stringify(anns.map(a => a.style + ':' + a.text))`)) === JSON.stringify(['watermark:Rind Works', 'stamp:INTERNAL']), await js(`JSON.stringify(anns.map(a => a.style + ':' + a.text))`));
    check('auto-copy includes them', copied && copied === await js('compositeDataURL()'));
    await js(`appSettingsCache = { ...appSettingsCache, autoCopyAfterCapture: false, brand: {} }; 0`);

    // Brand colours replace the toolbar swatches
    await js(`applyAppSettings({ brand: { usePalette: true, palette: ['#123456', '#ABCDEF'] } }); 0`);
    check('brand colours replace the swatches', (await js(`[...document.querySelectorAll('.swatches .sw')].map(s => s.dataset.c).join(',')`)) === '#123456,#ABCDEF');
    await js(`document.querySelector('.swatches .sw[data-c="#ABCDEF"]').click(); 0`);
    check('a brand swatch sets the colour', (await js('color')).toUpperCase() === '#ABCDEF');
    await js(`applyAppSettings({ brand: { usePalette: false, palette: ['#123456'] } }); 0`);
    check('turning them off restores the standard swatches', (await js(`document.querySelectorAll('.swatches .sw').length`)) === 8);

    // Settings → Brand
    await js(`JPSettings.open('brand'); 0`); await wait(300);
    const brandRows = await js(`[...document.querySelectorAll('.sp-body .sp-label')].map(l => l.firstChild.textContent).join('|')`);
    check('Settings → Brand lists its options', brandRows === 'Company name|Logo|Watermark|Stamp new captures|Brand colors|Use brand colors in the toolbar', brandRows);
    await js(`{ const i = document.querySelector('.sp-text'); i.value = 'Acme Inc'; i.dispatchEvent(new Event('change')); } 0`); await wait(150);
    check('company name is saved', settingsSets.some(p => p.brand?.name === 'Acme Inc'), JSON.stringify(settingsSets.slice(-2)));
    await js('JPSettings.close(); 0');

    // One of each, for a look: $TMPDIR/test-annotations.png
    await js(`anns = [
      { type: 'spotlight', x: 330, y: 40, w: 230, h: 150 },
      { type: 'ellipse', x: 40, y: 40, w: 220, h: 120, color: '#EF4444', sw: 6 },
      { type: 'line', x1: 40, y1: 220, x2: 280, y2: 220, color: '#22C55E', sw: 8 },
      { type: 'blur', mode: 'pixelate', x: 40, y: 250, w: 220, h: 120, sw: 12 },
      { type: 'step', x: 350, y: 60, w: 40, h: 40, n: 1, color: '#6C4EF6' },
      { type: 'step', x: 420, y: 60, w: 40, h: 40, n: 2, color: '#F59E0B' },
      { type: 'step', x: 490, y: 60, w: 40, h: 40, n: 12, color: '#FFFFFF' },
    ]; selectedIdx = -1; setTool('ellipse'); render(); 0`);
    await wait(200);
    fs.writeFileSync(path.join(os.tmpdir(), 'test-annotations.png'), (await w.webContents.capturePage()).toPNG());
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
