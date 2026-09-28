// Appearance for every window: theme (system / dark / light), accent colour and high contrast.
// Classic script loaded in <head>, so the last-used appearance (cached in localStorage, which all
// file:// windows share) is applied before first paint; the main process's settings then take over.
//   window.JPTheme = { apply(appearance), ACCENTS, current() }
//   appearance = { theme: 'system'|'dark'|'light', accent: <ACCENTS key>, highContrast: boolean }
// Every apply fires a 'jp-appearance' event on window (detail = appearance + resolved theme).
// The colours themselves live in theme.css; this only sets data-theme / data-contrast and the
// accent triplets. Nothing here may throw: tests and older windows lack parts of electronAPI.
(function () {
  const STORAGE_KEY = 'jqg-appearance';
  const DEFAULTS = { theme: 'dark', accent: 'purple', highContrast: false };

  // "R,G,B". Every accent carries white text at 4.5:1 or better, so it works as a button fill
  // on both themes.
  const ACCENTS = {
    purple: '108,78,246',
    blue:   '37,99,235',
    teal:   '13,125,116',
    green:  '21,128,61',
    orange: '201,72,13',
    pink:   '208,36,111',
  };
  // strong: hover / pressed fills and accent text on light surfaces; soft: accent text on dark ones.
  const SHADES = {
    purple: { strong: '90,61,224',  soft: '155,143,255' },
    blue:   { strong: '29,78,216',  soft: '143,179,255' },
    teal:   { strong: '11,100,93',  soft: '95,212,196' },
    green:  { strong: '22,101,52',  soft: '122,214,154' },
    orange: { strong: '161,56,11',  soft: '255,166,110' },
    pink:   { strong: '176,26,90',  soft: '255,143,196' },
  };

  const root = document.documentElement;
  let current = { ...DEFAULTS };
  let darkQuery = null;

  function normalize(appearance) {
    const a = appearance && typeof appearance === 'object' ? appearance : {};
    return {
      ...a,
      theme: ['system', 'dark', 'light'].includes(a.theme) ? a.theme : DEFAULTS.theme,
      accent: Object.prototype.hasOwnProperty.call(ACCENTS, a.accent) ? a.accent : DEFAULTS.accent,
      highContrast: a.highContrast === true,
    };
  }

  function systemIsDark() {
    try { return !darkQuery || darkQuery.matches; } catch { return true; }
  }

  function apply(appearance) {
    try {
      current = normalize(appearance);
      root.dataset.theme = current.theme === 'system' ? (systemIsDark() ? 'dark' : 'light') : current.theme;
      if (current.highContrast) root.dataset.contrast = 'high';
      else delete root.dataset.contrast;
      root.dataset.accent = current.accent;
      root.style.setProperty('--accent-rgb', ACCENTS[current.accent]);
      root.style.setProperty('--accent-strong-rgb', SHADES[current.accent].strong);
      root.style.setProperty('--accent-soft-rgb', SHADES[current.accent].soft);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch {}
      // For colours painted by script (canvas overlays), which CSS can't restyle.
      window.dispatchEvent(new CustomEvent('jp-appearance', { detail: { ...current, resolved: root.dataset.theme } }));
    } catch {}
    return { ...current };
  }

  function cached() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  }

  // Settings objects from main; ignore anything that doesn't carry an appearance.
  function applySettings(settings) {
    if (settings && settings.appearance && typeof settings.appearance === 'object') apply(settings.appearance);
  }

  window.JPTheme = { apply, ACCENTS, current: () => ({ ...current }) };

  try { darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); } catch {}
  apply(cached() || DEFAULTS);

  // 'system' follows the OS (main mirrors the setting into nativeTheme.themeSource).
  try {
    const onSystemChange = () => { if (current.theme === 'system') apply(current); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemChange);
    else darkQuery.addListener(onSystemChange);
  } catch {}

  try {
    const api = window.electronAPI;
    const pending = api && api.settingsGet && api.settingsGet();
    if (pending && typeof pending.then === 'function') pending.then(applySettings, () => {});
    if (api && api.onSettingsChanged) api.onSettingsChanged(applySettings);
  } catch {}
})();
