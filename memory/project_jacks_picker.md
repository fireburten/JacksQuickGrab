---
name: Jack's Picker
description: Screenshot and annotation desktop app by Rind Works, built with Electron 41 + HTML/CSS/JS
type: project
---

Desktop screenshot tool. Tech stack: Electron 41, plain HTML/CSS/JS renderers, no build step.

**Branding:** Product name "Jack's Picker" (formerly "Jack's Quick Grab"). Owned by Rind Works. App icon is `picker-icon.png` (1024×1024 dock); HUD/tray uses `picker-hud.png`.

**Architecture:**
- `main.js` — Electron main process (CJS); tray icon, global hotkeys (⌘⇧2 region, ⌘⇧1 full, ⌘⌥⇧W window, ⌘⌥⇧2 repeat-region; macOS-reserved ⌘⇧3/4/5 are refused), window lifecycle
- `preload.cjs` — IPC bridge (must be .cjs, not .js, to stay CommonJS)
- `src/hud.html` — Floating draggable toolbar; `-webkit-app-region: drag` on logo handle
- `src/capture.html` — Fullscreen region-selection overlay; canvas-based screenshot + drag selection
- `src/editor.html` — Canvas annotation editor; tools: arrow, text, box, highlight, blur, draw; copy/save/OCR actions
- `src/window-picker.html` — Window thumbnail picker
- `scripts/ocr*.swift` — Vision-framework OCR sources, precompiled by `scripts/build-ocr.sh` into universal `bin/ocr` + `bin/ocr-table` (gitignored, asarUnpacked; runs automatically before `npm start`/builds). Never run them via `/usr/bin/swift` — end users lack Xcode tools and the App Store forbids runtime code.
- `scripts/ocr-table.ps1` — Windows.Media.Ocr helper
- `build/` — Mac App Store entitlements + padded macOS icon; `store/` — App Store Connect copy and privacy policy

**Capture flow:** hide HUD → 120ms delay → desktopCapturer screenshot → show overlay with screenshot as background → user drags region → crop in renderer → open editor.

**Captures save to:** `~/Documents/Jack's Picker/` (direct builds) or `~/Pictures/Jack's Picker/` (Mac App Store builds, `process.mas` — sandbox only has the Pictures entitlement) (legacy `~/Documents/Jack's Quick Grab/` is auto-renamed on first launch via `migrateLegacySaveDir`). Annotations live in `.annotations/*.json` + `.flat.png` sidecars.

**How to apply:** When adding features, keep renderers as plain HTML (no bundler). Use IPC for all main↔renderer communication. Internal identifiers (`jqg-*` localStorage keys, `jqg-*` temp prefixes, IPC channel names) are intentionally kept unchanged across the rebrand to preserve user state — only user-visible strings, the app icon, and packaging identity moved to "Jack's Picker" / "com.rindworks.jackspicker".
