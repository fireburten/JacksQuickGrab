// Translations. English is what the code says; each other language is a table from the English
// text to its translation (src/locales/<code>.js). t('Copied {n} lines', { n }) looks the text
// up, then fills in {placeholders}. Anything missing stays English rather than breaking.
// Pages load this first. translatePage() swaps the static text and labels in the markup at
// load, and the shared helpers (toast, dialogs, Settings rows, menus) call t() on what they're
// given, so most strings are translated where they're shown. The main process uses it too.
// Classic script (window.JPi18n) that also loads in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JPi18n = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LANGUAGES = { en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', ja: '日本語' };
  const STORE_KEY = 'jqg-language';   // the Settings choice, cached so pages start in it
  const tables = {};
  let lang = 'en';

  // 'system' (or nothing) follows the Mac; otherwise one of LANGUAGES.
  function resolve(choice, systemLocale) {
    const code = String(choice && choice !== 'system' ? choice : systemLocale || 'en').toLowerCase().split(/[-_]/)[0];
    return LANGUAGES[code] ? code : 'en';
  }

  function setLanguage(choice, systemLocale) {
    lang = resolve(choice, systemLocale);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    return lang;
  }

  function add(code, table) { tables[code] = { ...(tables[code] || {}), ...table }; }

  function t(text, vars) {
    if (text == null) return text;
    const source = String(text);
    const out = (lang !== 'en' && tables[lang] && tables[lang][source]) || source;
    return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out;
  }

  const has = text => lang === 'en' || !!(tables[lang] && tables[lang][String(text).trim()]);

  // The static text of a page: text nodes and the title, placeholder, aria-label and alt
  // attributes whose English is in the table. Runs once on the markup, before user content.
  const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];
  function translatePage(scope) {
    if (lang === 'en' || typeof document === 'undefined') return;
    const rootEl = scope || document.body;
    if (!rootEl) return;
    if (rootEl.nodeType === 1 && rootEl.closest && rootEl.closest('[data-no-i18n]')) return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && !n.parentElement.closest('script, style, [data-no-i18n]') && n.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      if (has(text)) n.nodeValue = n.nodeValue.replace(text, t(text));
    }
    rootEl.querySelectorAll('*').forEach(el => {
      if (el.closest('[data-no-i18n]')) return;
      for (const attr of ATTRIBUTES) {
        const v = el.getAttribute(attr);
        if (v && v.trim() && has(v.trim())) el.setAttribute(attr, t(v.trim()));
      }
    });
    if (rootEl === document.body && document.title && has(document.title)) document.title = t(document.title);
  }

  // Pages start in the cached choice; settings confirm it (and a change reloads the page).
  function startPage() {
    let cached = null;
    try { cached = localStorage.getItem(STORE_KEY); } catch {}
    setLanguage(cached || 'system', typeof navigator !== 'undefined' ? navigator.language : 'en');
  }

  // With the Settings language from main: remember it, and report whether the page must reload.
  function applySettingsLanguage(choice) {
    const wanted = choice || 'system';
    try { localStorage.setItem(STORE_KEY, wanted); } catch {}
    return resolve(wanted, typeof navigator !== 'undefined' ? navigator.language : 'en') !== lang;
  }

  // Text a page adds or changes later (toasts, dialogs, Settings rows…) is translated as it
  // appears. Your own content (file and project names, the gallery) sits in [data-no-i18n].
  function translateNode(node) {
    if (node.nodeType === 3) {
      const text = node.nodeValue.trim();
      if (text && node.parentElement && !node.parentElement.closest('script, style, [data-no-i18n]') && tables[lang] && tables[lang][text]) {
        node.nodeValue = node.nodeValue.replace(text, tables[lang][text]);
      }
    } else if (node.nodeType === 1 && !node.closest('[data-no-i18n]')) {
      translatePage(node);
      for (const attr of ATTRIBUTES) {
        const v = node.getAttribute(attr);
        if (v && tables[lang] && tables[lang][v.trim()]) node.setAttribute(attr, tables[lang][v.trim()]);
      }
    }
  }

  function watchPage() {
    if (lang === 'en' || typeof MutationObserver === 'undefined') return;
    new MutationObserver(records => records.forEach(r => {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') translateNode(r.target);
      else r.addedNodes.forEach(translateNode);
    })).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  }

  // In a page: start in the cached language, translate the markup once it's parsed, then
  // keep translating what the page adds.
  if (typeof document !== 'undefined') {
    startPage();
    document.addEventListener('DOMContentLoaded', () => { translatePage(); watchPage(); });
  }

  return { t, add, setLanguage, language: () => lang, translatePage, startPage, applySettingsLanguage, resolve, LANGUAGES, has };
});
