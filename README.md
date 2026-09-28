# Jack's Picker

A menu-bar screenshot and screen-recording app for macOS by Rind Works. It captures regions, windows, full screens, GIFs, scrolling pages and recordings with sound, and has an annotation editor with OCR, blur, projects and a video editor.

Built with Electron 41 and plain HTML/CSS/JS pages (no bundler).

## Getting started

Requirements: macOS 12 or later, Node 18 or later, and the Xcode Command Line Tools (`xcode-select --install`), which compile the OCR helpers.

```sh
npm install
npm start
```

`npm start` compiles the OCR helpers into `bin/` first. It also clears `ELECTRON_RUN_AS_NODE`, which some terminals (such as VS Code's) set; with it set, Electron runs as plain Node and the app can't start.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run from source (development) |
| `npm test` | Every test, about 1½ minutes (see below) |
| `npm run build:dir` | Build an unsigned app into `dist/mac-arm64/` |
| `npm run rebuild:open` | Build, then open that app |
| `npm run check:release` | List what's still needed for an App Store upload |
| `npm run build:mas-dev` | Signed, sandboxed test build (needs a development profile) |
| `npm run build:mas` | The App Store build (universal `.pkg`) |
| `npm run build:privacy` | Regenerate `docs/privacy.html` from `store/privacy-policy.md` |

## Tests

`npm test` runs, in order:

- `scripts/test-main-process.cjs` (Node): `main.js` against a stand-in for Electron. Covers the settings store, moving the captures folder, opening Settings, delete-to-Trash, the error log, crash recovery and the security checks.
- `scripts/test-scroll-stitch.cjs` (Node): the scrolling-capture stitcher.
- `scripts/test-settings-ui.cjs` (Electron): the Settings panel, the HUD's recording toggles and the editor's delete flow, on the real pages.
- `scripts/test-media-editor.cjs` (Electron): video/GIF trim, crop, combine and export.
- `scripts/test-theme.cjs` (Electron): renders every window in each theme. Screenshots go to `$TMPDIR/test-theme`.

## Where things are

- `main.js`: the main process. Tray, hotkeys, windows, capture, settings, files, error log.
- `preload.cjs`: the only bridge between the pages and `main.js` (`window.electronAPI`).
- `src/`: the HUD, capture overlay, window picker and editor pages. It also holds `theme.css`/`theme.js` (appearance tokens), `settings-panel.*`, and the media engine (`media-editor.js`, `scroll-stitch.js`, `vendor/`).
- `scripts/`: the OCR helper sources (`ocr*.swift`, built by `build-ocr.sh`), build hooks and tests. Only `ocr-table.ps1` (Windows OCR) ships in the app.
- `build/`: entitlements (`*.mas.plist` for the App Store, `entitlements.mac.plist` for Developer ID), the icon, and the provisioning profiles, which aren't committed.
- `store/`: App Store Connect text, privacy answers and the privacy policy source. `docs/` holds the published privacy page for GitHub Pages.

## Security in packaged builds

- **Fuses:** `scripts/after-pack.cjs` switches off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and turns on the app.asar integrity check. Otherwise another program could run code inside the app and use its Screen Recording and Microphone access. Check a build with `npx @electron/fuses read --app "dist/mac-arm64/Jack's Picker.app"`.
- **Remote debugging:** packaged builds also exit if started with `--remote-debugging-port` or `--remote-debugging-pipe`. Use `npm start` to debug.

## Error log

When something goes wrong, the app writes to `~/Library/Logs/Jack's Picker/main.log`. The App Store build writes to the same path inside its container. Errors from the pages are included. Settings → Storage → Diagnostic log opens it. Nothing is sent anywhere.

## Releasing to the Mac App Store

`npm run check:release` lists what's missing; `build:mas` and `build:mas-dev` run it first. The steps:

1. **Location:** keep the repo outside iCloud Drive (`~/Documents`, `~/Desktop`), for example in `~/Developer`. macOS tags app bundles there with Finder info, and `codesign` rejects it.
2. **Apple Developer Program:** join it. Then create the App ID `com.rindworks.jackspicker` and replace `TEAMID` in `build/entitlements.mas.plist` with your Team ID.
3. **Provisioning profiles:** download a macOS App Development profile as `build/dev.provisionprofile`. Run `npm run build:mas-dev` and test everything in the sandbox, especially:
   - OCR
   - saving to Pictures and changing the captures folder
   - linked project folders
   - microphone and system audio
   - launch at login
   - delete to Trash
4. **Store details:**
   - Fill in `[EFFECTIVE DATE]` and `[CONTACT EMAIL]` in `store/privacy-policy.md` and `store/app-store-listing.md`.
   - Run `npm run build:privacy`.
   - Enable GitHub Pages from `docs/`; that URL is the privacy policy URL.
5. **App Store build:** download a Mac App Store distribution profile as `build/embedded.provisionprofile`. Commit everything, run `npm run build:mas`, and upload the `.pkg` with Transporter. The build number is the git commit count, so each upload needs a new commit.
6. **App Store Connect:** add the screenshots (see `store/screenshots.md`), pricing, age rating and the App Privacy answers from `store/app-privacy.md`, then submit.

Direct downloads (outside the App Store) use the `mac` target with hardened runtime and `build/entitlements.mac.plist`. electron-builder notarizes automatically when `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` (or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) are set. Selling that way would also need payments, licensing and auto-updates, which the App Store otherwise handles.
