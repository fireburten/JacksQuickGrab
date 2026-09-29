// Create Guide dialog (editor window): turns the screenshots selected in Recents into a
// step-by-step guide. Set a title, reorder the steps (arrows, or drag the ⋮⋮ handle), edit each
// caption and pick PDF, HTML or Markdown; the main process builds the files (lib/guide.cjs).
// Classic script; exposes window.JPGuide = { open(items, { title }), close(), isOpen() }.
(function () {
  const api = window.electronAPI;
  if (!api?.guidePrepare) return;
  const tr = (text, vars) => (window.JPi18n ? window.JPi18n.t(text, vars)
    : vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);   // src/i18n.js

  const FORMATS = [
    ['pdf', 'PDF', 'One PDF file, ready to print or share.'],
    ['html', 'HTML', 'A folder with index.html and the images, for a website or help center.'],
    ['md', 'Markdown', 'A folder with guide.md and the images, for docs and wikis.'],
  ];

  let backdrop = null;
  // { title, steps: [{ filePath, name, thumb, annotated, caption }], format, numbered, skipped, loading, busy, error }
  let state = null;
  let openCount = 0;   // a slow guide-prepare answer for an earlier open is ignored

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

  const $ = selector => backdrop.querySelector(selector);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const isOpen = () => !!backdrop?.classList.contains('on');

  function build() {
    backdrop = el('div', { class: 'choice-backdrop guide-backdrop', onclick: e => { if (e.target === backdrop && !state?.busy) close(); } },
      el('div', { class: 'choice-box guide-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'guide-heading', tabindex: '-1' },
        el('h2', { id: 'guide-heading' }, 'Create Guide'),
        el('label', { class: 'guide-label', for: 'guide-title' }, 'Title'),
        el('input', {
          class: 'choice-input guide-title', id: 'guide-title', type: 'text', maxlength: '200', autocomplete: 'off',
          placeholder: 'e.g. How to submit an expense report', oninput: e => { state.title = e.target.value; },
        }),
        el('div', { class: 'guide-note', role: 'status', hidden: true }),
        el('div', { class: 'guide-steps-head' }, el('span', { class: 'guide-label' }, 'Steps'), el('span', { class: 'guide-hint' })),
        el('ol', { class: 'guide-steps', 'aria-label': 'Steps' }),
        el('div', { class: 'guide-options' },
          el('div', { class: 'guide-seg', role: 'radiogroup', 'aria-label': 'Format' }),
          el('label', { class: 'guide-check' },
            el('input', { type: 'checkbox', class: 'guide-numbered', onchange: e => { state.numbered = e.target.checked; } }),
            'Number the steps')),
        el('p', { class: 'guide-format-hint' }),
        el('p', { class: 'guide-error', role: 'alert', hidden: true }),
        el('div', { class: 'choice-actions guide-actions' },
          el('button', { type: 'button', class: 'guide-cancel', onclick: () => close() }, 'Cancel'),
          el('button', { type: 'button', class: 'guide-primary', onclick: create }, 'Create PDF…'))));
    // The editor's own shortcuts (tools, Delete, ⌘V pasting an image onto the canvas…) must not
    // act behind the dialog while you type in it.
    backdrop.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('paste', e => e.stopPropagation());
    document.body.appendChild(backdrop);
  }

  function onKeyDown(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!state?.busy) close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.classList.contains('guide-title'))) {
      e.preventDefault();
      create();
    }
  }

  // Keys aimed outside the dialog (focus on the page itself) are held back too.
  document.addEventListener('keydown', e => {
    if (!isOpen() || backdrop.contains(e.target)) return;
    if (e.key === 'Escape' && !state?.busy) close();
    e.stopImmediatePropagation();
  }, true);

  // items: gallery items ({ filePath, kind, time, … }); GIFs and videos among them are left out.
  async function open(items, { title = '' } = {}) {
    if (!backdrop) build();
    const token = ++openCount;
    // Steps start in capture order, oldest first: usually the order they were done in.
    const paths = (Array.isArray(items) ? items : [items])
      .filter(item => item?.filePath)
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (a.item.time || 0) - (b.item.time || 0) || a.i - b.i)
      .map(({ item }) => item.filePath);
    state = { title: String(title || ''), steps: [], format: 'pdf', numbered: true, skipped: null, loading: true, busy: false, error: '' };
    backdrop.classList.add('on');
    render();
    let prepared = null;
    try { prepared = await api.guidePrepare(paths); } catch {}
    if (token !== openCount || !isOpen()) return;
    state.loading = false;
    state.steps = (prepared?.steps || []).map(step => ({ ...step, caption: step.name }));
    state.skipped = prepared?.skipped || null;
    if (prepared?.prefs) Object.assign(state, { format: prepared.prefs.format, numbered: prepared.prefs.numbered });
    if (!prepared) state.error = 'Couldn’t read the selected screenshots.';
    render();
    $('.guide-title').focus();
    $('.guide-title').select();
  }

  function close() {
    if (!backdrop) return;
    backdrop.classList.remove('on');
    $('.guide-steps').replaceChildren();
    state = null;
    openCount++;
  }

  function skippedNote() {
    const { media = 0, missing = 0 } = state.skipped || {};
    return [
      media ? `${media === 1 ? '1 GIF or video isn’t' : `${media} GIFs or videos aren’t`} included: guides use screenshots only.` : '',
      missing ? `${missing === 1 ? '1 capture couldn’t' : `${missing} captures couldn’t`} be found.` : '',
    ].filter(Boolean).join(' ');
  }

  function render() {
    const { loading, busy, steps } = state;
    const format = FORMATS.find(([id]) => id === state.format) || FORMATS[0];
    $('.guide-box').classList.toggle('busy', busy);
    const title = $('.guide-title');
    if (title.value !== state.title) title.value = state.title;
    title.disabled = busy;
    const note = $('.guide-note');
    note.textContent = skippedNote();
    note.hidden = !note.textContent;
    $('.guide-hint').textContent = loading ? 'Loading…'
      : steps.length > 1 ? `${plural(steps.length, 'step', 'steps')} · drag ⋮⋮ or use the arrows to reorder` : plural(steps.length, 'step', 'steps');
    $('.guide-seg').replaceChildren(...FORMATS.map(([id, label]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(id === state.format), class: id === state.format ? 'on' : '', disabled: busy,
      onclick: () => { state.format = id; render(); },
    }, label)));
    const numbered = $('.guide-numbered');
    numbered.checked = state.numbered;
    numbered.disabled = busy;
    $('.guide-format-hint').textContent = format[2];
    const error = $('.guide-error');
    error.textContent = state.error;
    error.hidden = !state.error;
    $('.guide-cancel').disabled = busy;
    const primary = $('.guide-primary');
    primary.textContent = busy ? tr('Creating…') : tr('Create {format}…', { format: format[1] });
    primary.disabled = loading || busy || !steps.length;
    renderSteps();
  }

  function renderSteps() {
    const list = $('.guide-steps');
    if (state.loading) { list.replaceChildren(); return; }
    if (!state.steps.length) {
      list.replaceChildren(el('li', { class: 'guide-empty' },
        'None of the selected items can go in a guide. Select screenshots in Recents, then choose Create Guide… again.'));
      return;
    }
    list.replaceChildren(...state.steps.map(stepRow));
  }

  function stepRow(step, i) {
    const n = i + 1, last = state.steps.length - 1, busy = state.busy;
    const caption = el('textarea', {
      class: 'guide-caption', rows: '2', maxlength: '4000', placeholder: 'Caption (optional)',
      'aria-label': tr('Caption for step {n}', { n }), disabled: busy, oninput: e => { step.caption = e.target.value; },
    });
    caption.value = step.caption;
    const button = (text, label, move, onclick, disabled) => el('button', {
      type: 'button', title: label, 'aria-label': label, 'data-move': move, disabled: busy || disabled, onclick,
    }, text);
    return el('li', { class: 'guide-step' },
      el('span', { class: 'guide-grip', title: 'Drag to reorder', 'aria-hidden': 'true', onpointerdown: e => startDrag(e, i) }, '⋮⋮'),
      el('span', { class: 'guide-num', 'aria-hidden': 'true' }, String(n)),
      el('div', { class: 'guide-thumb', title: step.name },
        step.thumb ? el('img', { src: step.thumb, alt: '' }) : el('span', { 'aria-hidden': 'true' }, '▣'),
        step.annotated ? el('span', { class: 'guide-badge', title: 'Your annotations are included' }, 'Annotated') : ''),
      caption,
      el('div', { class: 'guide-step-buttons' },
        button('↑', tr('Move step {n} up', { n }), 'up', () => moveStep(i, i - 1, 'up'), i === 0),
        button('↓', tr('Move step {n} down', { n }), 'down', () => moveStep(i, i + 1, 'down'), i === last),
        button('✕', tr('Remove step {n}', { n }), 'remove', () => removeStep(i), last === 0)));
  }

  // Keeps focus on the moved step's button, so pressing it again keeps moving that step.
  function moveStep(from, to, focus) {
    if (!state || to < 0 || to >= state.steps.length || from === to) return;
    const [step] = state.steps.splice(from, 1);
    state.steps.splice(to, 0, step);
    renderSteps();
    const row = $(`.guide-step:nth-child(${to + 1})`);
    const again = focus && row?.querySelector(`[data-move="${focus}"]`);
    (again && !again.disabled ? again : row?.querySelector('.guide-caption'))?.focus();
  }

  function removeStep(i) {
    if (!state || state.steps.length < 2) return;
    state.steps.splice(i, 1);
    render();
    $(`.guide-step:nth-child(${Math.min(i, state.steps.length - 1) + 1}) .guide-caption`)?.focus();
  }

  // Drag by the handle: the row follows the pointer through the list (which scrolls when the
  // pointer nears its top or bottom) and drops where it is. The listeners are on the document:
  // moving the row within the list would drop a pointer capture on the handle.
  function startDrag(e, index) {
    if (e.button !== 0 || !state || state.busy || state.steps.length < 2) return;
    e.preventDefault();
    const row = e.currentTarget.closest('.guide-step'), list = row.parentElement, box = $('.guide-box');
    row.classList.add('dragging');
    box.classList.add('reordering');
    const onMove = ev => {
      const edge = list.getBoundingClientRect();
      if (ev.clientY < edge.top + 24) list.scrollTop -= 12;
      else if (ev.clientY > edge.bottom - 24) list.scrollTop += 12;
      const before = [...list.children].find(r => r !== row && ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
      if (before !== row.nextElementSibling) list.insertBefore(row, before);
    };
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      row.classList.remove('dragging');
      box.classList.remove('reordering');
      moveStep(index, [...list.children].indexOf(row));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  }

  async function create() {
    if (!state || state.loading || state.busy || !state.steps.length) return;
    state.busy = true;
    state.error = '';
    render();
    let result;
    try {
      result = await api.guideExport({
        title: state.title, format: state.format, numbered: state.numbered,
        steps: state.steps.map(step => ({ filePath: step.filePath, caption: step.caption })),
      });
    } catch (err) {
      result = { success: false, error: err?.message };
    }
    if (!isOpen() || !state) return;
    state.busy = false;
    if (result?.success) {
      const name = String(result.path || '').split(/[\\/]/).pop();
      const left = result.skipped ? ` (${plural(result.skipped, 'missing screenshot', 'missing screenshots')} left out)` : '';
      close();
      window.toast?.(`${tr('Guide saved: {name}', { name })}${left}`);
      return;
    }
    // Cancelling the save panel just returns here, with everything as it was.
    if (!result?.canceled) state.error = `${tr('Couldn’t create the guide.')} ${tr(result?.error || '')}`.trim();
    render();
  }

  window.JPGuide = { open, close, isOpen };
})();
