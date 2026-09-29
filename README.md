# Jack's Picker

A menu-bar screenshot and screen-recording app for macOS by Rind Works. It captures regions, windows, full screens, GIFs, scrolling pages and recordings with sound, and has an annotation editor with OCR, blur, projects and a video editor.

Built with Electron 41 and plain HTML/CSS/JS pages (no bundler).

## Features for teams

- **Search inside screenshots:** Recents search finds the words in every capture, not just its name, using on-device text recognition. The index lives in the app's data folder (Settings → Storage turns it off).
- **Step-by-step guides:** number steps with the Step tool, then select captures → right-click → Create Guide… for a PDF, an HTML page or Markdown. Guides are headed with your company name and logo.
- **Redaction:** Smart Redact blacks out email addresses, phone and card numbers, IP addresses, keys, passwords, US Social Security numbers and IBANs, word by word. The optional check before sharing (Settings → Capture) asks before a capture holding any of them is copied, shared or saved.
- **Brand:** your company name, logo watermark, brand colors as the toolbar swatches, and Confidential / Internal / Draft stamps, added by hand or to every new capture (Settings → Brand).
- **Send to…:** share a capture to Slack, Jira, Linear, Teams or GitHub, or get a link from your own S3-compatible storage. It's off until a destination is set up in Settings → Sharing, and credentials are kept in the Keychain.
- **Camera bubble:** 📷 on the capture bar adds your camera to screen recordings.
- **Quick access:** a thumbnail after each capture (Settings → Capture) that you can drag into any app, Pin to Screen for keeping an image on top, and Copy Text from Screen (⌘⌥⇧T).
- **More annotation tools:** step numbers, line, ellipse, spotlight and pixelate, alongside arrows, text, boxes, highlights, blur and drawing.
- **Settings IT can lock** with a configuration profile (see **Managed settings**).
- **Accessibility and languages:** every control has a VoiceOver label, the editor's dialogs, swatches and Recents work from the keyboard, and the app follows Reduce Motion. It's in English, German, Spanish, French and Japanese (Settings → Appearance → Language). The translations are machine-drafted: have a native speaker review each one before release (see **Translations**).

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

`npm test` runs:

- `scripts/test-main-process.cjs` (Node): `main.js` against a stand-in for Electron. Covers the settings store, moving the captures folder, opening Settings, delete-to-Trash, the error log, crash recovery and the security checks.
- `scripts/test-scroll-stitch.cjs` (Node): the scrolling-capture stitcher.
- `scripts/test-settings-ui.cjs` (Electron): the Settings panel, the HUD's recording toggles and the editor's delete flow, on the real pages.
- `scripts/test-media-editor.cjs` (Electron): video/GIF trim, crop, combine and export.
- `scripts/test-theme.cjs` (Electron): renders every window in each theme. Screenshots go to `$TMPDIR/test-theme`.
- `scripts/test-quick-access.cjs` (Node, then Electron): the thumbnail after a capture and Pin to Screen.
- `scripts/test-annotations.cjs` (Electron): the annotation tools and brand marks, drawn with real mouse input and checked pixel by pixel. It also checks that copies never include selection handles.
- `scripts/test-search.cjs` (Electron): the text index, real Vision OCR on rendered images, and the gallery search.
- `scripts/test-redact.cjs` (Electron): the sensitive-text detectors, Smart Redact and the check before sharing.
- `scripts/test-guide.cjs` (Electron): Create Guide's builders, real PDFs from fixture images, and the dialog.
- `scripts/test-webcam.cjs` (Electron): the camera bubble, with Chromium's fake camera.
- `scripts/test-accessibility.cjs` (Electron): control names, dialogs, the focus ring and keyboard use in every window.
- `scripts/test-i18n.cjs` (Electron): the translation tables, every window rendered in German with no English left where a translation exists, and switching languages.
- `scripts/test-sharing.cjs` (Node, then Electron): Send to… against a local mock of each service, AWS's SigV4 test vectors, and Settings → Sharing on the real pages. Nothing leaves the machine and no real accounts are used.

## Where things are

- `main.js`: the main process. Tray, hotkeys, windows, capture, settings, files, error log.
- `preload.cjs`: the only bridge between the pages and `main.js` (`window.electronAPI`).
- `lib/`: main-process modules. They include `search-index.cjs` (the text index), `guide.cjs` (Create Guide output), `quick-access.cjs` (thumbnail and pin windows) and `sharing/` (Send to…).
- `src/`: the HUD, capture overlay, window picker, editor, thumbnail and pin pages. Supporting scripts include `redact-detect.js` (sensitive-text detectors), `webcam.js` (camera bubble) and `guide-dialog.*`. It also holds `theme.css`/`theme.js` (appearance tokens), `settings-panel.*`, and the media engine (`media-editor.js`, `scroll-stitch.js`, `vendor/`).
- `src/i18n.js` and `src/locales/`: translations (see **Translations**).
- `scripts/`: the OCR helper sources (`ocr*.swift`, built by `build-ocr.sh`), build hooks and tests. Only `ocr-table.ps1` (Windows OCR) ships in the app.
- `build/`: entitlements (`*.mas.plist` for the App Store, `entitlements.mac.plist` for Developer ID), the icon, and the provisioning profiles, which aren't committed.
- `store/`: App Store Connect text, privacy answers and the privacy policy source. `docs/` holds the published privacy page for GitHub Pages.

## Translations

The code is written in English, and English text is the key: `tr('Copied {n} lines of text', { n })` in the pages, `tr()` in `main.js`. Text in the HTML markup and anything a page adds later (toasts, dialogs, Settings rows) is translated automatically when there's a match. Your own content, like file and project names, sits inside `[data-no-i18n]` and is never touched.

To add or change a string, edit its row in `scripts/locales-source.py` (English, German, Spanish, French, Japanese), then run `python3 scripts/locales-source.py` to regenerate `src/locales/*.js`. Keep `{placeholders}` exactly as they are; the script and `test-i18n.cjs` both check them. Anything without a translation stays in English rather than breaking. To list every English string the windows show, run `electron scripts/i18n-strings.cjs`.

A new language needs a column in that script, an entry in `LANGUAGES` in `src/i18n.js`, a `<script src="locales/<code>.js">` tag in each page, and the code in `electronLanguages` in `package.json`. The build also writes the macOS permission prompts in each language (`scripts/after-pack.cjs`).

## Security in packaged builds

- **Fuses:** `scripts/after-pack.cjs` switches off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and turns on the app.asar integrity check. Otherwise another program could run code inside the app and use its Screen Recording, Microphone and Camera access. Check a build with `npx @electron/fuses read --app "dist/mac-arm64/Jack's Picker.app"`.
- **Remote debugging:** packaged builds also exit if started with `--remote-debugging-port` or `--remote-debugging-pipe`. Use `npm start` to debug.

## Managed settings

An organization can fix some settings with a configuration profile for the preference domain `com.rindworks.jackspicker`, deployed with its MDM. `docs/managed-settings-example.mobileconfig` is an example to adapt. Locked settings show "Set by your organization" in Settings, and a banner says some settings are managed.

| Key | Type | Effect |
| --- | --- | --- |
| `CapturesFolder` | string | Where captures are saved (`~/…` allowed). In the App Store version it must be inside `~/Pictures`. |
| `CompanyName` | string | Company name for guides and name watermarks. |
| `Stamp` | string | `none`, `confidential`, `internal` or `draft`: stamps every new capture. |
| `CheckSensitiveInfo` | bool | The check for emails, card numbers, keys… before copying, sharing or saving. |
| `DisableTextSearch` | bool | Don't index the text in captures. |
| `DisableSharing` | bool | Hides Send to…. |
| `AutoCopyAfterCapture` | bool | Forces auto-copy on or off. |
| `DisableMicrophone`, `DisableSystemAudio`, `DisableCamera` | bool | Recordings never include them. |

While a stamp, an automatic watermark or the sensitive-info check is on, new captures open in the editor, which applies them, rather than as a thumbnail.

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
   - the camera bubble (📷)
   - Send to… (network access) and the Keychain for saved credentials
   - search indexing of a captures folder chosen in Settings
4. **Store details:**
   - Fill in `[EFFECTIVE DATE]` and `[CONTACT EMAIL]` in `store/privacy-policy.md` and `store/app-store-listing.md`.
   - Run `npm run build:privacy`.
   - Enable GitHub Pages from `docs/`; that URL is the privacy policy URL.
5. **App Store build:** download a Mac App Store distribution profile as `build/embedded.provisionprofile`. Commit everything, run `npm run build:mas`, and upload the `.pkg` with Transporter. The build number is the git commit count, so each upload needs a new commit.
6. **App Store Connect:** add the screenshots (see `store/screenshots.md`), pricing, age rating and the App Privacy answers from `store/app-privacy.md`, then submit.

Direct downloads (outside the App Store) use the `mac` target with hardened runtime and `build/entitlements.mac.plist`. electron-builder notarizes automatically when `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` (or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) are set. Selling that way would also need payments, licensing and auto-updates, which the App Store otherwise handles.
