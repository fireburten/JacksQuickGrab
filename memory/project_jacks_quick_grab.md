---
name: Jack's Quick Grab
description: Snagit-style screenshot and annotation desktop app built with Electron 41 + HTML/CSS/JS
type: project
---

Desktop screenshot tool built from a Hi-Fi HTML prototype. Tech stack: Electron 41, plain HTML/CSS/JS renderers, no build step.

**Architecture:**
- `main.js` — Electron main process (CJS); tray icon, global hotkeys (⌘⇧4, ⌘⇧3, ⌘⇧W), window lifecycle
- `preload.cjs` — IPC bridge (must be .cjs, not .js, to stay CommonJS)
- `src/hud.html` — Floating draggable toolbar; `-webkit-app-region: drag` on logo handle
- `src/capture.html` — Fullscreen region-selection overlay; canvas-based screenshot + drag selection
- `src/editor.html` — Canvas annotation editor; tools: arrow, text, box, highlight, blur, draw; copy/save actions

**Capture flow:** hide HUD → 180ms delay → desktopCapturer screenshot → show overlay with screenshot as background → user drags region → crop in renderer → open editor.

**Why:** User built a Snagit-like app as a prototype and wanted it converted to a real desktop app.

**How to apply:** When adding features, keep renderers as plain HTML (no bundler). Use IPC for all main↔renderer communication.
