// Tests Smart Redact and the check before sharing: the detectors (src/redact-detect.js) on
// true and false cases, then the editor redacting just the sensitive words from the word-level
// OCR (stubbed here) and asking before a copy.
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-redact.cjs
// Exits non-zero on failure; the report is also written to $TMPDIR/test-redact.txt.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect, describe } = require('../src/redact-detect.js');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'test-redact.txt');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function detectorTests() {
  const cases = [
    ['emails', 'Contact jane.doe@acme.co.uk for access', ['email:jane.doe@acme.co.uk']],
    ['phone numbers with separators', 'Call +1 (415) 555-0132 or 415.555.0199', ['phone:+1 (415) 555-0132', 'phone:415.555.0199']],
    ['a Luhn-valid card number', 'Card 4111 1111 1111 1111 exp 12/27', ['card:4111 1111 1111 1111']],
    ['not a card when the checksum fails', 'Not a card 4111 1111 1111 1112', []],
    ['IPv4 and IPv6 addresses', 'Server 192.168.1.20 and fe80::1ff:fe23:4567:890a', ['ip:192.168.1.20', 'ip:fe80::1ff:fe23:4567:890a']],
    ['not dates, times or versions', 'Meeting 2024-03-15 at 12:30:45, v1.2.3', []],
    ['AWS keys', 'AWS key AKIAIOSFODNN7EXAMPLE here', ['secret:AKIAIOSFODNN7EXAMPLE']],
    ['just the value after "password:"', 'password: hunter2!', ['secret:hunter2!']],
    ['API keys after a label', 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456', ['secret:sk-proj-abcdefghijklmnopqrstuvwxyz123456']],
    ['not a git commit hash', 'commit 4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 fixed it', []],
    ['US Social Security numbers', 'SSN 123-45-6789', ['ssn:123-45-6789']],
    ['checksum-valid IBANs', 'IBAN GB82 WEST 1234 5698 7654 32', ['iban:GB82 WEST 1234 5698 7654 32']],
    ['not order numbers or amounts', 'Order #12345 shipped, total 1,299.00', []],
    ['JSON web tokens', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', ['secret:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']],
    ['not long ordinary words', 'internationalization and counterrevolutionaries', []],
    ['Slack and GitHub tokens', 'xoxb-1234567890-abcdefghij and ghp_abcdefghijklmnopqrstuvwxyz0123456789', ['secret:xoxb-1234567890-abcdefghij', 'secret:ghp_abcdefghijklmnopqrstuvwxyz0123456789']],
  ];
  for (const [name, text, want] of cases) {
    const got = detect(text).map(f => `${f.kind}:${f.text}`);
    check(`detects ${name}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  }
  check('describes findings for people', describe([{ kind: 'email' }, { kind: 'email' }, { kind: 'card' }]) === '2 email addresses and 1 card number');
}

// Word boxes as the table OCR helper returns them (words of a line share an obsId).
const word = (text, x, y, obsId) => ({ text, confidence: 1, x, y, w: text.length * 9, h: 20, obsId });
const OCR_WORDS = [
  word('Email:', 20, 20, 0), word('jane@acme.com', 90, 20, 0),
  word('Card', 20, 60, 1), word('4111', 70, 60, 1), word('1111', 115, 60, 1), word('1111', 160, 60, 1), word('1111', 205, 60, 1),
  word('Nothing', 20, 100, 2), word('here', 90, 100, 2),
];

async function editorTests(errors) {
  let ocrCalls = 0, copies = 0;
  ipcMain.handle('ocr-table-image', () => { ocrCalls++; return { success: true, items: OCR_WORDS }; });
  ipcMain.on('editor-copy', () => { copies++; });
  ipcMain.on('annotation-save', () => {});
  ipcMain.handle('settings-get', () => ({ editor: {}, appearance: {} }));
  ['app-info', 'permission-status', 'clipboard-image', 'gallery-load', 'shortcuts-get', 'settings-set'].forEach(c => ipcMain.handle(c, () => null));
  ipcMain.handle('gallery-list', () => []);
  ipcMain.handle('project-folders', () => ({}));
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `redact-${Date.now()}` },
  });
  w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await w.loadFile(path.join(ROOT, 'src', 'editor.html'));
  await wait(900);
  const js = code => w.webContents.executeJavaScript(code);
  await js(`(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 160; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 160);
    return loadImageWithAnns(c.toDataURL(), '/Users/x/Documents/Jack\\'s Picker/r.png', []).then(() => 0); })()`);

  await js('doSmartRedact().then(() => 0)'); await wait(150);
  const boxes = JSON.parse(await js(`JSON.stringify(anns.map(a => ({ kind: a.redact, x: Math.round(a.x), w: Math.round(a.w) })))`));
  check('Smart Redact covers just the sensitive words', JSON.stringify(boxes.map(b => b.kind)) === '["email","card"]', JSON.stringify(boxes));
  check('the email box skips the "Email:" label', boxes[0] && boxes[0].x >= 80, JSON.stringify(boxes[0]));
  check('the card box spans all four groups', boxes[1] && boxes[1].x < 70 && boxes[1].x + boxes[1].w > 240, JSON.stringify(boxes[1]));
  check('Smart Redact says what it found', (await js(`document.getElementById('toast').textContent`)) === 'Redacted 1 email address and 1 card number');

  // The check before sharing
  await js('anns = []; render(); appSettingsCache = { ...appSettingsCache, checkSensitive: true }; 0');
  ocrCalls = 0; copies = 0;
  js('doCopy()');
  await wait(300);
  const dialog = await js(`({ on: document.getElementById('sensitive-backdrop').classList.contains('on'), text: document.getElementById('sensitive-text').textContent,
    redact: document.getElementById('sensitive-redact').textContent, anyway: document.getElementById('sensitive-anyway').textContent })`);
  check('copying asks first when sensitive info is found', dialog.on && dialog.text === 'It shows 1 email address and 1 card number.' && dialog.redact === 'Redact and Copy' && dialog.anyway === 'Copy Anyway', JSON.stringify(dialog));
  await js(`document.getElementById('sensitive-cancel').click(); 0`); await wait(200);
  check('Cancel copies nothing', copies === 0);
  js('doCopy()'); await wait(300);
  check('an unchanged image isn’t read twice', ocrCalls === 1, `OCR ran ${ocrCalls} times`);
  await js(`document.getElementById('sensitive-redact').click(); 0`); await wait(300);
  check('Redact and Copy redacts, then copies', copies === 1 && (await js('anns.filter(a => a.redact).length')) === 2);
  await js('anns = []; render(); 0');
  js('doCopy()'); await wait(300);
  await js(`document.getElementById('sensitive-anyway').click(); 0`); await wait(200);
  js('doCopy()'); await wait(300);
  check('after Copy Anyway, the same image isn’t asked about again', copies === 3 && !(await js(`document.getElementById('sensitive-backdrop').classList.contains('on')`)), `copies=${copies}`);
  // Send to… goes through the same check
  await js('anns = []; render(); sensitiveChecked = null; 0');
  const sending = js(`checkCaptureBeforeSending(currentPath)`);
  await wait(300);
  const sendDialog = await js(`({ on: document.getElementById('sensitive-backdrop').classList.contains('on'), redact: document.getElementById('sensitive-redact').textContent, anyway: document.getElementById('sensitive-anyway').textContent })`);
  check('Send to… asks first too', sendDialog.on && sendDialog.redact === 'Redact and Send' && sendDialog.anyway === 'Send Anyway', JSON.stringify(sendDialog));
  await js(`document.getElementById('sensitive-cancel').click(); 0`);
  check('cancelling stops the send', (await sending) === false);
  await js('appSettingsCache = { ...appSettingsCache, checkSensitive: false }; 0');
  ocrCalls = 0;
  await js('doCopy().then(() => 0)');
  check('with the check off, copying doesn’t read the image', ocrCalls === 0 && copies === 4);
  w.destroy();
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const errors = [];
  try {
    detectorTests();
    await editorTests(errors);
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
