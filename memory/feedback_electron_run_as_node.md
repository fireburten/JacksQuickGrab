---
name: Electron ELECTRON_RUN_AS_NODE fix
description: When running Electron apps from Claude Code terminal, ELECTRON_RUN_AS_NODE=1 is inherited and breaks the app — must unset it in the npm start script
type: feedback
---

Always prefix the `electron .` start script with `unset ELECTRON_RUN_AS_NODE &&` in package.json:

```json
"start": "unset ELECTRON_RUN_AS_NODE && electron ."
```

**Why:** Claude Code is itself an Electron app and sets `ELECTRON_RUN_AS_NODE=1` so it can run Node.js scripts. Child processes (including `npm start`) inherit this env var. When Electron sees `ELECTRON_RUN_AS_NODE=1`, it runs as plain Node.js — `process.type` is `undefined`, `require('electron')` returns the npm package path string (not the API), and no windows open.

**How to apply:** Any Electron project started/debugged from the Claude Code terminal needs this unset. electron-forge explicitly deletes it before spawning; plain `electron .` does not.
