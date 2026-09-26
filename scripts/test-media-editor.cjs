// Electron harness for src/media-editor.js (WebCodecs/MediaRecorder need a real renderer).
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-media-editor.cjs
// Loads scripts/test-media-editor.html from file:// (secure context) in an offscreen window, runs
// its window.runTests(), prints the report and exits non-zero on failure. The report is also
// written to $TMPDIR/test-media-editor.txt because stdout can be cut off on quit.
// Real recordings in ~/Documents/Jack's Picker are opened read-only when present.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPORT = path.join(os.tmpdir(), 'test-media-editor.txt');
const TIMEOUT_MS = 5 * 60 * 1000;

function realFiles() {
  const dir = path.join(os.homedir(), 'Documents', "Jack's Picker");
  try {
    const names = fs.readdirSync(dir);
    const pick = ext => names.filter(n => n.toLowerCase().endsWith(ext)).sort().reverse()[0];
    const mp4 = pick('.mp4'), gif = pick('.gif');
    return {
      mp4: mp4 ? pathToFileURL(path.join(dir, mp4)).href : null,
      gif: gif ? fs.readFileSync(path.join(dir, gif)).toString('base64') : null,
      gifName: gif || null,
    };
  } catch {
    return {};
  }
}

function finish(text, ok) {
  fs.writeFileSync(REPORT, text + '\n');
  process.stdout.write(text + '\n', () => app.exit(ok ? 0 : 1));
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => finish('FAIL: timed out', false), TIMEOUT_MS);
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e, ...legacy) => {
    const msg = e.message ?? legacy[1];
    if (msg) process.stdout.write(`  [page] ${msg}\n`);
  });
  try {
    await win.loadFile(path.join(__dirname, 'test-media-editor.html'));
    // JSON keeps the apostrophe in "Jack's Picker" out of the injected source's quoting.
    const arg = JSON.stringify(realFiles());
    const result = await win.webContents.executeJavaScript(`window.runTests(${arg})`);
    clearTimeout(timer);
    finish(result.lines.join('\n') + `\n\n${result.failed ? 'FAILED' : 'PASSED'}: ${result.passed} passed, ${result.failed} failed`, !result.failed);
  } catch (e) {
    clearTimeout(timer);
    finish(`FAIL: ${e && e.stack || e}`, false);
  }
});
