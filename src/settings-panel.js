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
    ['brand', 'Brand'],
    ['capture', 'Capture'],
    ['recording', 'Recording'],
    ['storage', 'Storage'],
    ['sharing', 'Sharing'],   // only while main allows sharing (settings.sharing.allowed)
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
  // Most text is translated as it's shown (src/i18n.js); strings with numbers or names use tr().
  const tr = (text, vars) => (window.JPi18n ? window.JPi18n.t(text, vars)
    : vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);

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

  function segmented(options, value, onPick, label, { disabled = false } = {}) {
    return el('div', { class: 'sp-seg', role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', disabled,
        onclick: () => { if (v !== value) onPick(v); },
      }, text)));
  }

  function select(options, value, onPick, label) {
    return el('select', { class: 'sp-select', 'aria-label': label, onchange: e => onPick(e.target.value) },
      options.map(([v, text]) => el('option', v === value ? { value: v, selected: true } : { value: v }, text)));
  }

  // Settings an organization fixes with a configuration profile (see main.js applyPolicy).
  const managed = key => !!settings.managed?.[key];
  const MANAGED_HINT = 'Set by your organization';

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

  function textInput(value, onCommit, { placeholder = '', label, maxLength = 80, disabled = false } = {}) {
    return el('input', {
      type: 'text', class: 'sp-text', value, placeholder, maxlength: maxLength, 'aria-label': label, spellcheck: 'false', disabled,
      onchange: e => onCommit(e.target.value.trim()),
      onkeydown: e => { if (e.key === 'Enter') e.target.blur(); },
    });
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
      row('Language', 'System follows your Mac’s language', select(
        [['system', tr('System')], ...Object.entries(window.JPi18n?.LANGUAGES || { en: 'English' })],
        a.language || 'system', v => { reopenAfterReload(v); set({ appearance: { language: v } }); }, 'Language')),
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
        el('input', { type: 'color', value: e.color.toLowerCase(), 'aria-label': 'Custom annotation color', onchange: ev => set({ editor: { color: ev.target.value.toUpperCase() } }) })));
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

  // The logo preview is fetched once per saved logo (settings only carry when it was saved).
  let brandLogo = null, brandLogoFor = 0;
  async function loadBrandLogo() {
    const saved = settings?.brand?.logo || 0;
    if (saved === brandLogoFor) return;
    brandLogoFor = saved;
    brandLogo = saved ? await api.brandLogoGet?.() : null;
    if (isOpen() && section === 'brand') render();
  }

  async function chooseLogo() {
    const result = await api.brandLogoChoose?.();
    if (!result) return;
    if (result.error) { notice = { kind: 'warn', text: result.error }; render(); return; }
    settings = result;
    render();
  }

  async function removeLogo() {
    settings = await api.brandLogoRemove();
    render();
  }

  function paletteEditor(colors) {
    return el('div', { class: 'sp-swatches' },
      colors.map(c => el('button', {
        type: 'button', class: 'sp-swatch square sp-removable', style: `--sw: ${c}`, title: tr('Remove {color}', { color: c }), 'aria-label': tr('Remove {color}', { color: c }),
        onclick: () => set({ brand: { palette: colors.filter(x => x !== c) } }),
      })),
      colors.length < 8 ? el('label', { class: 'sp-custom-color', title: 'Add a color' },
        el('input', {
          type: 'color', value: '#6c4ef6', 'aria-label': 'Add a brand color',
          onchange: ev => {
            const c = ev.target.value.toUpperCase();
            if (!colors.includes(c)) set({ brand: { palette: [...colors, c] } });
          },
        })) : '');
  }

  function brandSection() {
    const b = settings.brand || {};
    loadBrandLogo();
    const logo = el('div', { class: 'sp-stack' },
      b.logo && brandLogo ? el('img', { class: 'sp-logo', alt: 'Your logo', src: brandLogo }) : el('div', { class: 'sp-hint' }, b.logo ? '' : 'No logo yet'),
      el('div', { class: 'sp-buttons' },
        button(b.logo ? 'Change…' : 'Choose…', chooseLogo),
        button('Remove', removeLogo, { disabled: !b.logo })));
    const missing = b.watermark === 'logo' && !b.logo ? 'Choose a logo above first'
      : b.watermark === 'name' && !b.name ? 'Enter your company name above first' : '';
    const rows = [
      row('Company name', managed('companyName') ? MANAGED_HINT : 'Heads your step-by-step guides, and can be the watermark',
        textInput(b.name || '', v => set({ brand: { name: v } }), { placeholder: 'Your company', label: 'Company name', disabled: managed('companyName') })),
      row('Logo', 'For watermarks and guides (PNG or JPEG)', logo),
      row('Watermark', missing || 'Tools → Add Watermark puts it on the open capture', segmented(
        [['off', 'Off'], ['logo', 'Logo'], ['name', 'Name']], b.watermark, v => set({ brand: { watermark: v } }), 'Watermark')),
    ];
    if (b.watermark !== 'off') {
      rows.push(
        row('Position', '', segmented([['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘']], b.watermarkCorner,
          v => set({ brand: { watermarkCorner: v } }), 'Watermark position')),
        row('Size', '', segmented([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], b.watermarkSize,
          v => set({ brand: { watermarkSize: v } }), 'Watermark size')),
        row('Opacity', '', slider(20, 100, Math.round((b.watermarkOpacity ?? .6) * 100), v => `${v}%`,
          v => set({ brand: { watermarkOpacity: v / 100 } }), 'Watermark opacity')),
        row('Add to new captures', 'You can still move or delete it on each one',
          toggle(b.autoWatermark, v => set({ brand: { autoWatermark: v } }), { label: 'Add the watermark to new captures' })));
    }
    rows.push(
      row('Stamp new captures', managed('stamp') ? MANAGED_HINT : 'Tools → Add Stamp… adds one to any capture', segmented(
        [['none', 'None'], ['confidential', 'Confidential'], ['internal', 'Internal'], ['draft', 'Draft']], b.stamp,
        v => set({ brand: { stamp: v } }), 'Stamp new captures', { disabled: managed('stamp') })),
      row('Brand colors', 'Up to 8. Click one to remove it.', paletteEditor(b.palette || [])),
      row('Use brand colors in the toolbar', 'Instead of the standard swatches',
        toggle(b.usePalette, v => set({ brand: { usePalette: v } }), { disabled: !(b.palette || []).length, label: 'Use brand colors in the toolbar' })));
    return rows;
  }

  function captureSection() {
    const after = settings.afterCapture === 'thumbnail' ? 'thumbnail' : 'editor';
    return [
      row('After a capture', settings.thumbnailUnavailable
        ? 'Captures open in the editor while stamps, watermarks or the sensitive-info check are on'
        : after === 'thumbnail'
          ? 'A thumbnail waits in the corner: drag it into any app, or click it to edit'
          : 'Each new capture opens in the editor',
      segmented([['editor', 'Open the editor'], ['thumbnail', 'Show a thumbnail']], after,
        v => set({ afterCapture: v }), 'After a capture', { disabled: !!settings.thumbnailUnavailable })),
      row('Copy after capture', managed('autoCopyAfterCapture') ? MANAGED_HINT : 'Put each new capture on the clipboard',
        toggle(settings.autoCopyAfterCapture, v => set({ autoCopyAfterCapture: v }), { label: 'Copy after capture', disabled: managed('autoCopyAfterCapture') })),
      row('Check for sensitive info before sharing', managed('checkSensitive') ? MANAGED_HINT : 'Before a capture is copied, shared or saved, look for email addresses, card numbers, keys and more. Auto-copy after capture pauses while this is on.',
        toggle(settings.checkSensitive, v => set({ checkSensitive: v }), { label: 'Check for sensitive info before sharing', disabled: managed('checkSensitive') })),
      row('Launch at login', settings.launchAtLoginAvailable ? 'Start Jack’s Picker when you log in' : 'Available in the installed app',
        toggle(settings.launchAtLogin, v => set({ launchAtLogin: v }), { disabled: !settings.launchAtLoginAvailable, label: 'Launch at login' })),
      row('Capture hotkeys', 'Region, window, full screen and repeat',
        button('Edit Hotkeys…', () => { close(); window.showHotkeys?.(); })),
    ];
  }

  function recordingSection() {
    const r = settings.recording;
    return [
      row('Record system audio', managed('systemAudio') ? MANAGED_HINT : 'Sound your Mac plays (macOS 13 or later). Also the 🔊 button on the capture bar.',
        toggle(r.systemAudio, v => set({ recording: { systemAudio: v } }), { label: 'Record system audio', disabled: managed('systemAudio') })),
      row('Record microphone', managed('mic') ? MANAGED_HINT : 'Your voice. Also the 🎙 button on the capture bar.',
        toggle(r.mic, async v => {
          if (v && api.micAccess && !(await api.micAccess())) {
            notice = { kind: 'warn', text: 'Microphone access is off for Jack’s Picker.', action: ['Open System Settings', () => api.openMicSettings?.()] };
            render();
            return;
          }
          set({ recording: { mic: v } });
        }, { label: 'Record microphone', disabled: managed('mic') })),
      ...cameraRows(r),
      row('GIF frame rate', 'For GIF recordings from the capture bar', segmented(
        [[10, '10 fps'], [12, '12 fps'], [15, '15 fps'], [20, '20 fps']], r.gifFps, v => set({ recording: { gifFps: v } }), 'GIF frame rate')),
      row('GIF width', 'Larger GIFs look sharper but are bigger files', segmented(
        [[480, '480'], [640, '640'], [800, '800'], [1200, '1200']], r.gifWidth, v => set({ recording: { gifWidth: v } }), 'GIF width')),
    ];
  }

  // The 📷 camera bubble in screen recordings (drawn by src/webcam.js in the HUD).
  function cameraRows(r) {
    return [
      row('Camera bubble', managed('camera') ? MANAGED_HINT : 'Your camera in a corner of screen recordings. Also the 📷 button on the capture bar.',
        toggle(r.camera, async v => {
          if (v && api.cameraAccess && !(await api.cameraAccess())) {
            notice = { kind: 'warn', text: 'Camera access is off for Jack’s Picker.', action: ['Open System Settings', () => api.openCameraSettings?.()] };
            render();
            return;
          }
          set({ recording: { camera: v } });
        }, { label: 'Camera bubble', disabled: managed('camera') })),
      row('Bubble size', 'Scales with the recorded area', segmented(
        [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], r.cameraSize, v => set({ recording: { cameraSize: v } }), 'Bubble size')),
      row('Bubble position', 'Which corner of the recording', segmented(
        [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']],
        r.cameraCorner, v => set({ recording: { cameraCorner: v } }), 'Bubble position')),
      row('Bubble shape', '', segmented(
        [['circle', 'Circle'], ['rounded', 'Rounded']], r.cameraShape, v => set({ recording: { cameraShape: v } }), 'Bubble shape')),
    ];
  }

  function storageSection() {
    const f = settings.capturesFolder;
    const rows = [
      row('Captures folder', managed('capturesFolder') ? MANAGED_HINT : f.isDefault ? 'The default location' : 'A folder you chose', el('div', { class: 'sp-stack' },
        // Long paths are cut at the start (direction: rtl) so the folder name stays visible;
        // the left-to-right mark keeps the leading "/" where it belongs.
        el('div', { class: 'sp-path', title: f.path }, `\u200E${f.path}\u200E`),
        el('div', { class: 'sp-buttons' },
          button('Show in Finder', () => api.capturesFolderReveal()),
          button('Change…', chooseFolder, { disabled: managed('capturesFolder') }),
          button('Use Default', () => applyFolder('default', null), { disabled: f.isDefault || managed('capturesFolder') })))),
      row('Search text in captures', managed('searchText') ? MANAGED_HINT : searchHint(),
        toggle(settings.searchText !== false, v => set({ searchText: v }), { label: 'Search text in captures', disabled: managed('searchText') })),
      row('Diagnostic log', 'Written only when something goes wrong. It stays on your Mac.',
        button('Show in Finder', () => api.showLog?.())),
    ];
    if (folderPrompt) {
      rows.push(el('div', { class: 'sp-prompt' },
        el('p', {}, folderPrompt.count === 1
          ? tr('Move your 1 existing capture to “{name}” as well?', { name: folderPrompt.name })
          : tr('Move your {n} existing captures to “{name}” as well?', { n: folderPrompt.count, name: folderPrompt.name })),
        el('p', { class: 'sp-hint' }, 'Their annotations and edits come along. If you leave them, they stay in the current folder and won’t show in Recents.'),
        el('div', { class: 'sp-buttons' },
          button('Move Them', () => applyFolder(folderPrompt.target, true), { primary: true }),
          button('Leave Them', () => applyFolder(folderPrompt.target, false)),
          button('Cancel', () => { folderPrompt = null; render(); }))));
    }
    return rows;
  }

  // How far the on-device text index has got, fetched once each time Storage is shown.
  let searchStatus = null, searchStatusAsked = false;
  function searchHint() {
    if (!searchStatusAsked) {
      searchStatusAsked = true;
      api.searchStatus?.().then(status => { searchStatus = status; if (isOpen() && section === 'storage') render(); }).catch(() => {});
    }
    const base = 'Reads the words in your screenshots, on this Mac, so search finds them';
    if (settings.searchText === false || !searchStatus) return base;
    return searchStatus.pending
      ? tr('Reads the words in your screenshots, on this Mac, so search finds them. Still reading {n}…', { n: searchStatus.pending })
      : tr('Reads the words in your screenshots, on this Mac, so search finds them. {n} indexed.', { n: searchStatus.indexed });
  }

  async function chooseFolder() {
    if (window.isVideoEditing?.()) {
      notice = { kind: 'warn', text: 'Close the video editor first (✕ Close video), then change the folder.' };
      render();
      return;
    }
    const choice = await api.capturesFolderChoose();
    if (!choice) return;
    if (choice.error) {
      notice = { kind: 'warn', text: choice.error === 'inside' ? 'Pick a folder outside the current captures folder.' : 'Your organization sets the captures folder.' };
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
      if (count > 0) { folderPrompt = { target: 'default', count, name: tr('the default folder') }; render(); return; }
      move = false;
    }
    folderPrompt = null;
    const result = await api.capturesFolderApply({ target, move });
    if (!result || result.error) {
      notice = { kind: 'warn', text: result?.error ? `${tr('Couldn’t change the captures folder')}: ${tr(result.error)}` : tr('Couldn’t change the captures folder.') };
    } else {
      const moved = result.moved.length, skipped = result.skipped.length;
      notice = {
        kind: skipped ? 'warn' : 'info',
        text: [
          move ? (moved === 1 ? tr('Moved 1 capture.') : tr('Moved {n} captures.', { n: moved })) : tr('New captures will be saved here.'),
          skipped ? tr('{n} stayed behind because a file with the same name was already there.', { n: skipped }) : '',
        ].join(' ').trim(),
      };
      window.onCapturesFolderChanged?.(result);
    }
    settings = await api.settingsGet();
    render();
  }

  // ── Panel ──
  // The Sharing section lives in src/settings-sharing.js and is built with these helpers.
  function sharingSection() {
    const ui = { el, row, button, segmented, rerender: render, notify: n => { notice = n; }, sharing: settings.sharing };
    return window.JPSharingSettings?.section(ui) || [];
  }

  const BUILDERS = {
    appearance: appearanceSection, annotations: annotationsSection, brand: brandSection, capture: captureSection,
    recording: recordingSection, storage: storageSection, sharing: sharingSection,
  };

  function render() {
    if (!backdrop || !settings) return;
    const shown = SECTIONS.filter(([id]) => id !== 'sharing' || (settings.sharing?.allowed && window.JPSharingSettings));
    if (!shown.some(([id]) => id === section)) section = 'appearance';
    const nav = backdrop.querySelector('.sp-nav');
    nav.replaceChildren(...shown.map(([id, label]) => el('button', {
      type: 'button', class: id === section ? 'on' : '', 'aria-current': id === section ? 'page' : false,
      onclick: () => { section = id; notice = null; folderPrompt = null; searchStatusAsked = false; window.JPSharingSettings?.reset(); render(); },
    }, label)));
    const body = backdrop.querySelector('.sp-body');
    const title = SECTIONS.find(([id]) => id === section)[1];
    const anyManaged = Object.keys(settings.managed || {}).length > 0;
    body.replaceChildren(
      el('h2', {}, title),
      anyManaged ? el('div', { class: 'sp-notice info', role: 'note' }, 'Your organization manages some of these settings.') : '',
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
      [tr('Version {v}', { v: info.version }), info.packaged ? (date && tr('built {date}', { date })) : tr('development')].filter(Boolean).join(' · ');
  }

  async function open(which) {
    if (!backdrop) build();
    searchStatusAsked = false;
    if (which && BUILDERS[which]) section = which;
    notice = null;
    folderPrompt = null;
    window.JPSharingSettings?.reset();
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

  // A new language reloads the page (theme.js), so Settings comes back where it was.
  const REOPEN_KEY = 'jqg-reopen-settings';
  function reopenAfterReload(choice) {
    const i18n = window.JPi18n;
    if (!i18n || i18n.resolve(choice, navigator.language) === i18n.language()) return;   // no reload coming
    try { sessionStorage.setItem(REOPEN_KEY, section); } catch {}
  }
  try {
    const reopen = sessionStorage.getItem(REOPEN_KEY);
    if (reopen) { sessionStorage.removeItem(REOPEN_KEY); open(reopen); }
  } catch {}

  window.JPSettings = { open, close, isOpen };
})();
