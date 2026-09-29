// "Send to…" in the editor: the submenu (Export menu, and right-clicking a capture in Recents),
// the small form for issues and messages, and the progress / result toast. Which destinations
// exist, and whether sharing is allowed at all, arrives with the settings (settings.sharing);
// credentials never reach this page. Elements marked data-sharing are shown only while sharing
// is allowed. Classic script; exposes
//   window.JPSharing = { available(), menuButton(target), bind(button, getTarget), hideMenu() }
// where a target is a saved screenshot: { filePath, filename, thumb?, time?, prepare?() }.
(function () {
  const api = window.electronAPI;
  if (!api?.sharingSend) return;
  const tr = (text, vars) => (window.JPi18n ? window.JPi18n.t(text, vars)
    : vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);   // src/i18n.js

  const HEADINGS = { jira: 'New Jira issue', linear: 'New Linear issue', github: 'New GitHub issue', slack: 'Post to Slack', teams: 'Post to Microsoft Teams' };

  let sharing = { allowed: false, destinations: [] };
  let menu = null;
  let menuAnchor = null;
  let form = null;          // { close(result), submit() } while the details form is open
  let sending = false;
  let currentJob = null;
  let toastEl = null;
  let toastTimer = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    children.flat().forEach(c => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  }

  function applySettings(settings) {
    const s = settings?.sharing;
    if (!s || typeof s !== 'object') return;   // partial settings (tests, other windows) keep what we had
    sharing = { allowed: !!s.allowed, destinations: Array.isArray(s.destinations) ? s.destinations : [] };
    document.querySelectorAll('[data-sharing]').forEach(node => { node.hidden = !sharing.allowed; });
    if (!sharing.allowed) { hideMenu(); form?.close(null); }
  }

  // ── Dates for the form: auto-saved names carry the capture time in UTC ──
  function captureDate({ filename, time }) {
    const m = /^screenshot-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.\w+$/.exec(filename || '');
    if (m) return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return time ? new Date(time) : null;
  }
  const formatDate = d => d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  function defaultTitle(target) {
    const date = captureDate(target);
    const name = String(target.filename || '').replace(/\.[^.]+$/, '');
    return /^screenshot-[\d-]+$/.test(name) && date ? tr('Screenshot {date}', { date: formatDate(date) }) : name || tr('Screenshot');
  }

  // ── Submenu ──
  // Hovering or clicking `button` opens the submenu for getTarget() (null: nothing sendable open).
  function bind(button, getTarget) {
    const open = e => { e.stopPropagation(); if (menuAnchor !== button) openMenu(button, getTarget()); };
    button.addEventListener('mouseenter', open);
    button.addEventListener('click', open);
    return button;
  }

  const menuButton = target => bind(el('button', { type: 'button', class: 'has-submenu' }, 'Send to…'), () => target);

  function destinationItem(dest, target) {
    return el('button', {
      type: 'button', role: 'menuitem', class: 'jp-send-item', disabled: !dest.available,
      title: dest.available ? dest.summary : `${dest.typeLabel} posts a link to the image, so it needs S3-compatible storage. Add it in Settings → Sharing.`,
      onclick: () => { hideMenu(); send(dest, target); },
    }, el('span', { class: 'jp-send-name' }, dest.name),
    el('span', { class: 'jp-send-kind' }, !dest.available ? 'Needs storage' : dest.type === 's3' ? 'Copy Link' : dest.typeLabel));
  }

  function openMenu(anchor, target) {
    hideMenu();
    if (!sharing.allowed) return;
    window.hideProjectSubmenu?.();   // the gallery menu's other submenu
    menuAnchor = anchor;
    menu = el('div', { class: 'context-menu context-submenu jp-send-menu', role: 'menu', 'aria-label': 'Send to' });
    if (!target) menu.append(el('div', { class: 'jp-send-note' }, 'Open a saved screenshot to send it.'));
    else sharing.destinations.forEach(d => menu.append(destinationItem(d, target)));
    if (sharing.destinations.length) menu.append(el('div', { class: 'jp-send-sep', role: 'separator' }));
    menu.append(el('button', {
      type: 'button', role: 'menuitem', onclick: () => { hideMenu(); window.JPSettings?.open('sharing'); },
    }, sharing.destinations.length ? 'Manage Destinations…' : 'Add a Destination…'));
    document.body.append(menu);
    place(menu, anchor);
  }

  // Beside the anchor, flipped to the left or pulled up when it would leave the window.
  function place(pop, anchor) {
    pop.style.left = '-9999px';
    pop.style.top = '-9999px';
    pop.style.display = 'block';
    const a = anchor.getBoundingClientRect(), r = pop.getBoundingClientRect();
    let left = a.right + 6;
    if (left + r.width > window.innerWidth - 8) left = a.left - r.width - 6;
    let top = a.top - 5;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  }

  function hideMenu() {
    menu?.remove();
    menu = null;
    menuAnchor = null;
  }

  document.addEventListener('click', e => { if (menu && !menu.contains(e.target) && !menuAnchor?.contains(e.target)) hideMenu(); });
  document.addEventListener('contextmenu', hideMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });
  // Moving to another item of the menu it came from closes it, like the project submenu.
  document.addEventListener('mouseover', e => {
    const item = e.target.closest?.('button');
    if (menuAnchor && item && item !== menuAnchor && menuAnchor.parentElement?.contains(item)) hideMenu();
  });
  // The Export menu (a <details>) closing takes the submenu with it.
  document.addEventListener('toggle', e => { if (menuAnchor && !e.target.open && e.target.contains?.(menuAnchor)) hideMenu(); }, true);

  // ── Details form (issues: title + description; Slack / Teams: a message) ──
  function askDetails(dest, target) {
    return new Promise(resolve => {
      const issue = dest.form === 'issue';
      const date = captureDate(target);
      const title = issue ? el('input', { class: 'choice-input', type: 'text', maxlength: 250, 'aria-label': 'Title', value: defaultTitle(target) }) : null;
      const text = el('textarea', {
        class: 'choice-input jp-send-textarea', rows: 4, maxlength: issue ? 20000 : 4000,
        'aria-label': issue ? 'Description' : 'Message',
        placeholder: issue ? 'What should the team know?' : 'Add a message (optional)',
        value: issue && date ? tr('Captured {date}.', { date: formatDate(date) }) : '',
      });
      const error = el('div', { class: 'jp-send-error', role: 'alert' });
      const submit = () => {
        if (issue && !title.value.trim()) { error.textContent = 'Give the issue a title.'; title.focus(); return; }
        close(issue ? { title: title.value.trim(), description: text.value.trim() } : { title: defaultTitle(target), message: text.value.trim() });
      };
      const backdrop = el('div', { class: 'choice-backdrop on jp-send-backdrop' },
        el('div', { class: 'choice-box jp-send-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': HEADINGS[dest.type] || 'Send' },
          el('div', { class: 'jp-send-head' },
            target.thumb ? el('img', { class: 'jp-send-thumb', src: target.thumb, alt: '' }) : '',
            el('div', {}, el('h2', {}, HEADINGS[dest.type] || `Send to ${dest.name}`), el('p', { class: 'jp-send-sub' }, dest.name))),
          issue ? el('label', { class: 'jp-send-label' }, 'Title', title) : '',
          el('label', { class: 'jp-send-label' }, issue ? 'Description' : 'Message', text),
          error,
          el('div', { class: 'choice-actions' },
            el('button', { type: 'button', class: 'jp-send-primary', onclick: submit }, issue ? 'Create Issue' : 'Post'),
            el('button', { type: 'button', onclick: () => close(null) }, 'Cancel'))));
      function close(result) {
        backdrop.remove();
        form = null;
        resolve(result);
      }
      form = { close, submit };
      document.body.append(backdrop);
      setTimeout(() => { (title || text).focus(); title?.select(); }, 0);
    });
  }

  // While the form is up, keys belong to it: the editor's shortcuts (tools, Delete, ⌘C…) and its
  // image paste must not act on the canvas behind it. Capture phase runs before those listeners.
  document.addEventListener('keydown', e => {
    if (!form) return;
    if (e.key === 'Escape') { e.preventDefault(); form.close(null); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT')) { e.preventDefault(); form.submit(); }
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('paste', e => { if (form) e.stopImmediatePropagation(); }, true);

  // ── Progress and result ──
  function showToast({ kind, text, detail, url, copied, fix }) {
    clearTimeout(toastTimer);
    if (!toastEl) {
      toastEl = el('div', { class: 'jp-send-toast', role: 'status', 'aria-live': 'polite' });
      document.body.append(toastEl);
    }
    const actions = el('div', { class: 'jp-send-actions' });
    const action = (label, onclick) => actions.append(el('button', { type: 'button', class: 'jp-send-btn', onclick }, label));
    if (url && kind !== 'busy') {
      if (!copied) {
        action('Copy Link', e => { api.sharingLink({ url, action: 'copy' }); e.currentTarget.textContent = 'Copied'; });
      }
      action('Open', () => api.sharingLink({ url, action: 'open' }));
    }
    if (fix) action('Settings…', () => { hideToast(); window.JPSettings?.open('sharing'); });
    if (kind !== 'busy') actions.append(el('button', { type: 'button', class: 'jp-send-close', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: hideToast }, '✕'));
    toastEl.className = `jp-send-toast on ${kind}`;
    toastEl.replaceChildren(
      kind === 'busy' ? el('span', { class: 'jp-send-spinner', 'aria-hidden': 'true' }) : el('span', { class: 'jp-send-icon', 'aria-hidden': 'true' }, kind === 'ok' ? '✓' : '!'),
      el('div', { class: 'jp-send-body' }, el('div', { class: 'jp-send-text' }, text), detail ? el('div', { class: 'jp-send-detail' }, detail) : ''),
      actions);
    if (kind !== 'busy') toastTimer = setTimeout(hideToast, kind === 'ok' ? 8000 : 15000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl?.classList.remove('on');
  }

  api.onSharingProgress?.(p => {
    if (!p || p.jobId !== currentJob || !toastEl) return;
    const line = toastEl.querySelector('.jp-send-detail') || toastEl.querySelector('.jp-send-body').appendChild(el('div', { class: 'jp-send-detail' }));
    line.textContent = p.text;
  });

  async function send(dest, target) {
    if (sending) { window.toast?.('Still sending the last capture…'); return; }
    const details = dest.form ? await askDetails(dest, target) : {};
    if (!details) return;
    // The editor's check for sensitive info (when it's on) has the last word before anything leaves.
    if (target.check && !(await target.check())) return;
    sending = true;
    currentJob = `send-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    showToast({ kind: 'busy', text: tr('Sending to {name}…', { name: dest.name }) });
    let result;
    try {
      await target.prepare?.();   // the open capture: write its annotated image first
      result = await api.sharingSend({ id: dest.id, filePath: target.filePath, jobId: currentJob, ...details });
    } catch {
      result = { ok: false, error: 'Something went wrong. The details are in the diagnostic log.' };
    } finally {
      sending = false;
      currentJob = null;
    }
    if (result?.ok) {
      const until = result.expires ? tr('The link works until {date}.', { date: formatDate(new Date(result.expires)) }) : '';
      showToast({ kind: 'ok', text: `${result.copied ? tr('Link copied') : tr(result.label)} · ${dest.name}`, detail: until, url: result.url, copied: result.copied });
    } else {
      showToast({ kind: 'error', text: tr('Couldn’t send to {name}', { name: dest.name }), detail: tr(result?.error), url: result?.url, fix: !!result?.field });
    }
  }

  window.JPSharing = { available: () => sharing.allowed, menuButton, bind, hideMenu };

  api.settingsGet?.().then(applySettings, () => {});
  api.onSettingsChanged?.(applySettings);
})();
