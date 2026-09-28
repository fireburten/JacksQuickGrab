// Settings panel (editor window): appearance, annotation defaults, capture, recording and
// storage. Every change goes straight to the main process, which stores it and re-broadcasts
// the settings to every window (HUD, overlays, this editor) — so there's no Save button.
// Classic script; exposes window.JPSettings = { open(section), close(), isOpen() }.
(function () {
  const api = window.electronAPI;
  if (!api?.settingsGet) return;

  const SECTIONS = [
    ['appearance', 'Appearance'],
    ['annotations', 'Annotations'],
    ['capture', 'Capture'],
    ['recording', 'Recording'],
    ['storage', 'Storage'],
  ];
  // Fallback if theme.js didn't load; keep in sync with its palette.
  const ACCENT_RGB = window.JPTheme?.ACCENTS || {
    purple: '108,78,246', blue: '37,99,235', teal: '13,125,116', green: '21,128,61', orange: '201,72,13', pink: '208,36,111',
  };
  const ANNOTATION_COLORS = ['#6C4EF6', '#EF4444', '#F59E0B', '#22C55E', '#3B82F6', '#EC4899', '#FFFFFF', '#000000'];

  let settings = null;
  let section = 'appearance';
  let backdrop = null;
  let notice = null;          // { text, kind: 'info' | 'warn', action?: [label, fn] }
  let folderPrompt = null;    // pending captures-folder change awaiting "move them?"

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    children.flat().forEach(c => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  }

  async function set(patch) {
    settings = await api.settingsSet(patch);
    render();
  }

  // ── Controls ──
  function row(label, hint, control) {
    return el('div', { class: 'sp-row' },
      el('div', { class: 'sp-label' }, label, hint ? el('div', { class: 'sp-hint' }, hint) : ''),
      el('div', { class: 'sp-control' }, control));
  }

  function segmented(options, value, onPick, label) {
    return el('div', { class: 'sp-seg', role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '',
        onclick: () => { if (v !== value) onPick(v); },
      }, text)));
  }

  function toggle(on, onChange, { disabled = false, label } = {}) {
    return el('button', {
      type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label,
      class: `sp-switch${on ? ' on' : ''}`, disabled,
      onclick: () => onChange(!on),
    }, el('span', { class: 'sp-knob' }));
  }

  function slider(min, max, value, format, onCommit, label) {
    const out = el('span', { class: 'sp-value' }, format(value));
    const input = el('input', {
      type: 'range', min, max, value, 'aria-label': label,
      oninput: e => { out.textContent = format(+e.target.value); },
      onchange: e => onCommit(+e.target.value),
    });
    return el('div', { class: 'sp-slider' }, input, out);
  }

  function button(text, onclick, { primary = false, disabled = false } = {}) {
    return el('button', { type: 'button', class: `sp-button${primary ? ' primary' : ''}`, disabled, onclick }, text);
  }

  // ── Sections ──
  function appearanceSection() {
    const a = settings.appearance;
    const accentRow = el('div', { class: 'sp-swatches', role: 'radiogroup', 'aria-label': 'Accent color' },
      Object.entries(ACCENT_RGB).map(([name, rgb]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(a.accent === name), title: cap(name),
        class: `sp-swatch${a.accent === name ? ' on' : ''}`, style: `--sw: rgb(${rgb})`,
        onclick: () => set({ appearance: { accent: name } }),
      })));
    return [
      row('Theme', 'System follows your Mac’s appearance', segmented(
        [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], a.theme, v => set({ appearance: { theme: v } }), 'Theme')),
      row('Accent color', 'Buttons, selection and the timeline', accentRow),
      row('High contrast', 'Stronger borders and brighter secondary text',
        toggle(a.highContrast, v => set({ appearance: { highContrast: v } }), { label: 'High contrast' })),
      row('Interface size', 'Scales the editor window', segmented(
        [[0.9, 'Small'], [1, 'Default'], [1.1, 'Large'], [1.25, 'Larger']], a.uiScale, v => set({ appearance: { uiScale: v } }), 'Interface size')),
      row('Capture bar size', 'The floating capture bar (HUD)', segmented(
        [[0.85, 'Compact'], [1, 'Default'], [1.2, 'Large']], a.hudScale, v => set({ appearance: { hudScale: v } }), 'Capture bar size')),
      row('Thumbnails', 'Recents sidebar', segmented(
        [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], a.thumbSize, v => set({ appearance: { thumbSize: v } }), 'Thumbnail size')),
    ];
  }

  function annotationsSection() {
    const e = settings.editor;
    const colors = el('div', { class: 'sp-swatches', role: 'radiogroup', 'aria-label': 'Default color' },
      ANNOTATION_COLORS.map(c => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(e.color === c), title: c,
        class: `sp-swatch square${e.color === c ? ' on' : ''}`, style: `--sw: ${c}`,
        onclick: () => set({ editor: { color: c } }),
      })),
      el('label', { class: `sp-custom-color${ANNOTATION_COLORS.includes(e.color) ? '' : ' on'}`, title: 'Custom color' },
        el('input', { type: 'color', value: e.color.toLowerCase(), onchange: ev => set({ editor: { color: ev.target.value.toUpperCase() } }) })));
    const autoText = e.textSize === 0;
    return [
      row('Default color', 'Also changes when you pick a color in the toolbar', colors),
      row('Default stroke', 'Arrows, boxes, drawing and blur strength', slider(1, 60, Math.min(60, e.stroke), v => `${v}px`, v => set({ editor: { stroke: v } }), 'Default stroke')),
      row('Default text size', autoText ? 'Automatic: grows with the stroke width' : 'New text annotations', el('div', { class: 'sp-stack' },
        segmented([['auto', 'Auto'], ['custom', 'Custom']], autoText ? 'auto' : 'custom',
          v => set({ editor: { textSize: v === 'auto' ? 0 : 42 } }), 'Text size mode'),
        autoText ? '' : slider(8, 160, Math.min(160, e.textSize), v => `${v}px`, v => set({ editor: { textSize: v } }), 'Default text size'))),
    ];
  }

  function captureSection() {
    return [
      row('Copy after capture', 'Put each new capture on the clipboard',
        toggle(settings.autoCopyAfterCapture, v => set({ autoCopyAfterCapture: v }), { label: 'Copy after capture' })),
      row('Launch at login', settings.launchAtLoginAvailable ? 'Start Jack’s Picker when you log in' : 'Available in the installed app',
        toggle(settings.launchAtLogin, v => set({ launchAtLogin: v }), { disabled: !settings.launchAtLoginAvailable, label: 'Launch at login' })),
      row('Capture hotkeys', 'Region, window, full screen and repeat',
        button('Edit Hotkeys…', () => { close(); window.showHotkeys?.(); })),
    ];
  }

  function recordingSection() {
    const r = settings.recording;
    return [
      row('Record system audio', 'Sound your Mac plays (macOS 13 or later). Also the 🔊 button on the capture bar.',
        toggle(r.systemAudio, v => set({ recording: { systemAudio: v } }), { label: 'Record system audio' })),
      row('Record microphone', 'Your voice. Also the 🎙 button on the capture bar.',
        toggle(r.mic, async v => {
          if (v && api.micAccess && !(await api.micAccess())) {
            notice = { kind: 'warn', text: 'Microphone access is off for Jack’s Picker.', action: ['Open System Settings', () => api.openMicSettings?.()] };
            render();
            return;
          }
          set({ recording: { mic: v } });
        }, { label: 'Record microphone' })),
      row('GIF frame rate', 'For GIF recordings from the capture bar', segmented(
        [[10, '10 fps'], [12, '12 fps'], [15, '15 fps'], [20, '20 fps']], r.gifFps, v => set({ recording: { gifFps: v } }), 'GIF frame rate')),
      row('GIF width', 'Larger GIFs look sharper but are bigger files', segmented(
        [[480, '480'], [640, '640'], [800, '800'], [1200, '1200']], r.gifWidth, v => set({ recording: { gifWidth: v } }), 'GIF width')),
    ];
  }

  function storageSection() {
    const f = settings.capturesFolder;
    const rows = [
      row('Captures folder', f.isDefault ? 'The default location' : 'A folder you chose', el('div', { class: 'sp-stack' },
        // Long paths are cut at the start (direction: rtl) so the folder name stays visible;
        // the left-to-right mark keeps the leading "/" where it belongs.
        el('div', { class: 'sp-path', title: f.path }, `\u200E${f.path}\u200E`),
        el('div', { class: 'sp-buttons' },
          button('Show in Finder', () => api.capturesFolderReveal()),
          button('Change…', chooseFolder),
          button('Use Default', () => applyFolder('default', null), { disabled: f.isDefault })))),
      row('Diagnostic log', 'Written only when something goes wrong. It stays on your Mac.',
        button('Show in Finder', () => api.showLog?.())),
    ];
    if (folderPrompt) {
      rows.push(el('div', { class: 'sp-prompt' },
        el('p', {}, `Move your ${folderPrompt.count} existing capture${folderPrompt.count === 1 ? '' : 's'} to “${folderPrompt.name}” as well?`),
        el('p', { class: 'sp-hint' }, 'Their annotations and edits come along. If you leave them, they stay in the current folder and won’t show in Recents.'),
        el('div', { class: 'sp-buttons' },
          button('Move Them', () => applyFolder(folderPrompt.target, true), { primary: true }),
          button('Leave Them', () => applyFolder(folderPrompt.target, false)),
          button('Cancel', () => { folderPrompt = null; render(); }))));
    }
    return rows;
  }

  async function chooseFolder() {
    if (window.isVideoEditing?.()) {
      notice = { kind: 'warn', text: 'Close the video editor first (✕ Close video), then change the folder.' };
      render();
      return;
    }
    const choice = await api.capturesFolderChoose();
    if (!choice) return;
    if (choice.error === 'inside') {
      notice = { kind: 'warn', text: 'Pick a folder outside the current captures folder.' };
      render();
      return;
    }
    const name = choice.path.split(/[\\/]/).filter(Boolean).pop();
    if (choice.count > 0) { folderPrompt = { target: 'pending', count: choice.count, name }; render(); }
    else applyFolder('pending', false);
  }

  async function applyFolder(target, move) {
    // "Use Default" with captures to carry over asks the same question as Change….
    if (window.isVideoEditing?.()) {
      notice = { kind: 'warn', text: 'Close the video editor first (✕ Close video), then change the folder.' };
      render();
      return;
    }
    if (target === 'default' && move === null) {
      const count = await api.capturesFolderCount();
      if (count > 0) { folderPrompt = { target: 'default', count, name: 'the default folder' }; render(); return; }
      move = false;
    }
    folderPrompt = null;
    const result = await api.capturesFolderApply({ target, move });
    if (!result || result.error) {
      notice = { kind: 'warn', text: `Couldn’t change the captures folder${result?.error ? `: ${result.error}` : '.'}` };
    } else {
      const moved = result.moved.length, skipped = result.skipped.length;
      notice = {
        kind: skipped ? 'warn' : 'info',
        text: [
          move ? `Moved ${moved} capture${moved === 1 ? '' : 's'}.` : 'New captures will be saved here.',
          skipped ? `${skipped} stayed behind because a file with the same name was already there.` : '',
        ].join(' ').trim(),
      };
      window.onCapturesFolderChanged?.(result);
    }
    settings = await api.settingsGet();
    render();
  }

  // ── Panel ──
  const BUILDERS = {
    appearance: appearanceSection, annotations: annotationsSection, capture: captureSection,
    recording: recordingSection, storage: storageSection,
  };

  function render() {
    if (!backdrop || !settings) return;
    const nav = backdrop.querySelector('.sp-nav');
    nav.replaceChildren(...SECTIONS.map(([id, label]) => el('button', {
      type: 'button', class: id === section ? 'on' : '', 'aria-current': id === section ? 'page' : false,
      onclick: () => { section = id; notice = null; folderPrompt = null; render(); },
    }, label)));
    const body = backdrop.querySelector('.sp-body');
    const title = SECTIONS.find(([id]) => id === section)[1];
    body.replaceChildren(
      el('h2', {}, title),
      notice ? el('div', { class: `sp-notice ${notice.kind}`, role: 'status' }, notice.text,
        notice.action ? button(notice.action[0], notice.action[1]) : '') : '',
      ...BUILDERS[section]());
  }

  function build() {
    backdrop = el('div', { class: 'settings-backdrop', onclick: e => { if (e.target === backdrop) close(); } },
      el('div', { class: 'settings-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
        el('div', { class: 'sp-side' },
          el('div', { class: 'sp-title' }, 'Settings'),
          el('nav', { class: 'sp-nav' }),
          el('div', { class: 'sp-foot' }, 'Changes apply right away.', el('div', { class: 'sp-version' }))),
        el('div', { class: 'sp-main' },
          el('button', { type: 'button', class: 'sp-close', 'aria-label': 'Close settings', title: 'Close (Esc)', onclick: close }, '✕'),
          el('div', { class: 'sp-body' }))));
    document.body.appendChild(backdrop);
    showVersion();
  }

  // "Version 1.0.0 · built Sep 27" — which build is running, for support questions.
  async function showVersion() {
    let info = null;
    try { info = await api.appInfo?.(); } catch {}
    if (!info) return;
    const built = info.buildTime ? new Date(info.buildTime) : null;
    const date = built && !Number.isNaN(built.getTime())
      ? built.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    backdrop.querySelector('.sp-version').textContent =
      [`Version ${info.version}`, info.packaged ? (date && `built ${date}`) : 'development'].filter(Boolean).join(' · ');
  }

  async function open(which) {
    if (!backdrop) build();
    if (which && BUILDERS[which]) section = which;
    notice = null;
    folderPrompt = null;
    settings = await api.settingsGet();
    backdrop.classList.add('on');
    render();
    backdrop.querySelector('.sp-nav button.on')?.focus();
  }

  function close() { backdrop?.classList.remove('on'); }
  const isOpen = () => !!backdrop?.classList.contains('on');

  // Other windows (tray, HUD toggles) can change settings while the panel is open.
  api.onSettingsChanged?.(next => { settings = next; if (isOpen()) render(); });
  api.onOpenSettings?.(which => open(which));

  // Esc closes; while open, the editor's own shortcuts stay out of the way.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); isOpen() ? close() : open(); return; }
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopImmediatePropagation();
  }, true);

  window.JPSettings = { open, close, isOpen };
})();
