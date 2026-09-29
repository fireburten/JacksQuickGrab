// Settings → Sharing: the "Send to…" destinations. List, add, edit, test and remove them.
// src/settings-panel.js calls section(ui) to build the section with its own helpers
// (ui = { el, row, button, segmented, rerender, notify, sharing }). Credentials go to main and
// never come back: a saved one shows as an empty field that keeps its value unless retyped.
// Classic script; exposes window.JPSharingSettings = { section(ui), reset() }.
(function () {
  const api = window.electronAPI;
  if (!api?.sharingSave) return;
  const tr = (text, vars) => (window.JPi18n ? window.JPi18n.t(text, vars)
    : vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);   // src/i18n.js

  const KINDS = [
    ['s3', 'S3-compatible storage', 'AWS S3, Cloudflare R2, Backblaze B2, MinIO or Wasabi. Copy Link uploads the capture and copies a link to it.'],
    ['slack', 'Slack', 'Posts the capture to a channel, with an optional message.'],
    ['jira', 'Jira Cloud', 'Creates an issue with the capture attached.'],
    ['linear', 'Linear', 'Creates an issue with the capture in its description.'],
    ['teams', 'Microsoft Teams', 'Posts the capture to a channel as a link from your storage.'],
    ['github', 'GitHub Issues', 'Creates an issue that shows the capture from your storage.'],
  ];
  const NEEDS_STORAGE = ['teams', 'github'];

  const FIELDS = {
    s3: [
      { key: 'endpoint', label: 'Endpoint', hint: 'Leave empty for AWS. R2: https://‹account›.r2.cloudflarestorage.com', placeholder: 'https://s3.us-east-1.amazonaws.com' },
      { key: 'region', label: 'Region', hint: 'Like us-east-1. Cloudflare R2 uses auto.', placeholder: 'us-east-1' },
      { key: 'bucket', label: 'Bucket', placeholder: 'team-screenshots' },
      { key: 'prefix', label: 'Folder in the bucket', hint: 'Optional', placeholder: 'screenshots/' },
      { key: 'accessKeyId', label: 'Access key ID', secret: true, placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
      { key: 'linkType', label: 'Links', hint: 'Presigned links work with a private bucket and expire. Public links need a bucket or CDN that serves files publicly.', kind: 'segmented', options: [['presigned', 'Presigned'], ['public', 'Public URL']] },
      { key: 'expiry', label: 'Links expire after', kind: 'segmented', options: [[3600, '1 hour'], [86400, '1 day'], [604800, '7 days']], when: f => f.linkType !== 'public' },
      { key: 'publicBaseUrl', label: 'Public base URL', hint: 'The address that serves the bucket, like https://pub-123.r2.dev', placeholder: 'https://', when: f => f.linkType === 'public' },
    ],
    slack: [
      { key: 'token', label: 'Bot token', hint: 'Starts with xoxb-. The app needs the files:write and chat:write scopes.', secret: true, placeholder: 'xoxb-…' },
      { key: 'channel', label: 'Channel ID', hint: 'In the channel’s details, like C0123456789. Invite the app to the channel.', placeholder: 'C0123456789' },
    ],
    jira: [
      { key: 'siteUrl', label: 'Site', placeholder: 'https://your-team.atlassian.net' },
      { key: 'email', label: 'Account email', placeholder: 'you@company.com' },
      { key: 'apiToken', label: 'API token', hint: 'id.atlassian.com → Security → API tokens', secret: true },
      { key: 'projectKey', label: 'Project key', hint: 'The letters in issue numbers, like PROJ in PROJ-12', placeholder: 'PROJ' },
      { key: 'issueType', label: 'Issue type', placeholder: 'Task' },
    ],
    linear: [
      { key: 'apiKey', label: 'API key', hint: 'Linear → Settings → Security & access → Personal API keys', secret: true, placeholder: 'lin_api_…' },
      { key: 'team', label: 'Team', hint: 'Its key (like ENG) or its name', placeholder: 'ENG' },
    ],
    teams: [
      { key: 'webhookUrl', label: 'Workflow URL', hint: 'From a Teams workflow built on “Post to a channel when a webhook request is received”', secret: true, placeholder: 'https://…' },
      { key: 'storageId', label: 'Image storage', kind: 'storage' },
    ],
    github: [
      { key: 'token', label: 'Token', hint: 'A fine-grained token with Issues: Read and write for the repository', secret: true, placeholder: 'github_pat_…' },
      { key: 'repo', label: 'Repository', placeholder: 'owner/name' },
      { key: 'storageId', label: 'Image storage', kind: 'storage' },
    ],
  };
  const DEFAULTS = { s3: { linkType: 'presigned', expiry: 86400 }, jira: { issueType: 'Task' } };
  const TEST_NOTES = {
    s3: 'Test Connection uploads a small text file, opens its link, then deletes it.',
    slack: 'Test Connection posts a short message to the channel.',
    teams: 'Test Connection posts a short message to the channel.',
  };

  let view = 'list';        // 'list' | 'kinds' | 'form'
  let draft = null;         // { id?, type, name, fields, secrets } being added or edited
  let invalid = null;       // the field the last error was about
  let formStatus = null;    // { kind: 'busy' | 'ok' | 'warn', text } under the form
  let rowStatus = {};       // destination id → the same, for Test in the list
  let removing = null;      // destination id waiting for "Remove?"

  function reset() {
    view = 'list';
    draft = null;
    invalid = null;
    formStatus = null;
    rowStatus = {};
    removing = null;
  }

  const kindLabel = type => (KINDS.find(([t]) => t === type) || [])[1] || type;
  const statusLine = (el, s) => el('div', { class: `jp-share-status ${s.kind}`, role: 'status' }, s.text);
  const focusField = key => setTimeout(() => document.querySelector(`.settings-box [data-field="${key}"]`)?.focus(), 0);

  function section(ui) {
    const sharing = ui.sharing || { destinations: [] };
    const nodes = view === 'form' && draft ? formView(ui, sharing) : view === 'kinds' ? kindsView(ui, sharing) : listView(ui, sharing);
    return nodes.flat(Infinity).filter(Boolean);
  }

  // ── List ──
  function listView(ui, sharing) {
    const { el, button } = ui;
    return [
      el('p', { class: 'jp-share-intro' },
        'Send captures to your team from the editor: Export → Send to…, or right-click a capture. ',
        'Nothing leaves your Mac until you set up a destination and use it. Keys and tokens are encrypted with a key kept in your Keychain, and aren’t shown again.'),
      sharing.destinations.length ? '' : el('div', { class: 'jp-share-empty' }, 'No destinations yet.'),
      sharing.destinations.map(d => destinationRow(ui, d, sharing)),
      el('div', { class: 'sp-buttons jp-share-add' }, button('Add Destination…', () => { view = 'kinds'; ui.rerender(); }, { primary: true })),
    ];
  }

  function destinationRow(ui, d, sharing) {
    const { el, button } = ui;
    const status = rowStatus[d.id];
    const testing = status?.kind === 'busy';
    const row = el('div', { class: 'jp-share-row', 'data-id': d.id },
      el('div', { class: 'jp-share-main' },
        el('div', { class: 'jp-share-name' }, d.name, el('span', { class: 'jp-share-kind' }, d.typeLabel)),
        el('div', { class: 'sp-hint' }, d.summary),
        d.needsStorage ? el('div', { class: `sp-hint${d.available ? '' : ' jp-share-warn'}` },
          d.available ? tr('Images go to {name}.', { name: d.storageName }) : 'Needs S3-compatible storage for its image links. Add storage to use it.') : '',
        status ? statusLine(el, status) : ''),
      el('div', { class: 'sp-buttons jp-share-row-buttons' },
        button(testing ? 'Testing…' : 'Test', () => testSaved(ui, d), { disabled: testing }),
        button('Edit', () => edit(ui, d)),
        button('Remove', () => { removing = d.id; ui.rerender(); })));
    if (removing !== d.id) return row;
    const lastStorage = d.type === 's3' && sharing.destinations.filter(x => x.type === 's3').length === 1;
    const orphans = lastStorage && sharing.destinations.some(x => x.needsStorage);
    return [row, el('div', { class: 'sp-prompt' },
      el('p', {}, tr('Remove “{name}”?', { name: d.name })),
      el('p', { class: 'sp-hint' }, `Its saved credentials are deleted from this Mac.${orphans ? ' Teams and GitHub destinations can’t post images until you add storage again.' : ''}`),
      el('div', { class: 'sp-buttons' },
        button('Remove', () => remove(ui, d), { primary: true }),
        button('Cancel', () => { removing = null; ui.rerender(); })))];
  }

  async function testSaved(ui, d) {
    rowStatus[d.id] = { kind: 'busy', text: 'Testing…' };
    ui.rerender();
    const r = await api.sharingTest({ id: d.id }).catch(() => null);
    rowStatus[d.id] = r?.ok ? { kind: 'ok', text: r.message } : { kind: 'warn', text: r?.error || 'The test didn’t finish.' };
    ui.rerender();
  }

  async function remove(ui, d) {
    removing = null;
    delete rowStatus[d.id];
    const r = await api.sharingRemove(d.id).catch(() => null);
    ui.notify(r?.ok ? { kind: 'info', text: tr('Removed “{name}”.', { name: d.name }) } : { kind: 'warn', text: tr(r?.error || 'Couldn’t remove it.') });
    ui.rerender();
  }

  // ── Choosing what to add ──
  function kindsView(ui, sharing) {
    const { el, button } = ui;
    const hasStorage = sharing.destinations.some(d => d.type === 's3');
    return [
      el('p', { class: 'jp-share-intro' }, 'Where should captures go?'),
      el('div', { class: 'jp-share-kinds' }, KINDS.map(([type, label, about]) => {
        const blocked = NEEDS_STORAGE.includes(type) && !hasStorage;
        return el('button', { type: 'button', class: 'jp-share-kind-card', 'data-type': type, disabled: blocked, onclick: () => startAdd(ui, type, sharing) },
          el('span', { class: 'jp-share-kind-name' }, label),
          el('span', { class: 'jp-share-kind-about' }, blocked ? 'Needs S3-compatible storage first.' : about));
      })),
      hasStorage ? '' : el('p', { class: 'sp-hint jp-share-note' }, 'Teams and GitHub can’t take image uploads, so they post a link to the capture in your S3-compatible storage. Add storage first to use them.'),
      el('div', { class: 'sp-buttons jp-share-add' }, button('Cancel', () => { view = 'list'; ui.rerender(); })),
    ];
  }

  function startAdd(ui, type, sharing) {
    const fields = { ...(DEFAULTS[type] || {}) };
    if (NEEDS_STORAGE.includes(type)) fields.storageId = sharing.destinations.find(d => d.type === 's3')?.id || '';
    draft = { type, name: '', fields, secrets: {} };
    view = 'form';
    formStatus = null;
    invalid = null;
    ui.rerender();
    focusField(FIELDS[type][0].key);
  }

  function edit(ui, d) {
    draft = { id: d.id, type: d.type, name: d.name, fields: { ...d.fields }, secrets: {} };
    view = 'form';
    formStatus = null;
    invalid = null;
    removing = null;
    ui.rerender();
  }

  // ── The form ──
  function input(ui, key, { secret = false, placeholder = '', label = key } = {}) {
    const bag = secret ? draft.secrets : draft.fields;
    const value = key === 'name' ? draft.name : bag[key] ?? '';
    const saved = secret && draft.id && !draft.secrets[key];
    return ui.el('input', {
      class: `jp-share-input${invalid === key ? ' invalid' : ''}`, type: secret ? 'password' : 'text',
      value: String(value), placeholder: saved ? 'Saved. Type to replace it.' : placeholder,
      autocomplete: 'off', spellcheck: 'false', 'data-field': key, 'aria-label': label,
      oninput: e => { if (key === 'name') draft.name = e.target.value; else bag[key] = e.target.value; },
    });
  }

  function control(ui, f, sharing) {
    if (f.kind === 'segmented') {
      return ui.segmented(f.options, draft.fields[f.key] ?? f.options[0][0], v => { draft.fields[f.key] = v; ui.rerender(); }, f.label);
    }
    if (f.kind === 'storage') {
      const buckets = sharing.destinations.filter(d => d.type === 's3');
      if (!buckets.length) return ui.el('div', { class: 'sp-hint jp-share-warn' }, 'Add S3-compatible storage first.');
      return ui.el('select', {
        class: 'jp-share-input', 'data-field': f.key, 'aria-label': f.label,
        onchange: e => { draft.fields[f.key] = e.target.value; },
      }, buckets.map(b => ui.el('option', { value: b.id, selected: (draft.fields[f.key] || buckets[0].id) === b.id }, b.name)));
    }
    return input(ui, f.key, { secret: f.secret, placeholder: f.placeholder, label: f.label });
  }

  function formView(ui, sharing) {
    const { el, row, button } = ui;
    const busy = formStatus?.kind === 'busy';
    return [
      el('h3', { class: 'jp-share-form-title' }, draft.id ? `Edit “${draft.name || kindLabel(draft.type)}”` : `New ${kindLabel(draft.type)} destination`),
      FIELDS[draft.type].filter(f => !f.when || f.when(draft.fields)).map(f => row(f.label, f.hint || '', control(ui, f, sharing))),
      row('Name', 'How it’s listed in Send to…', input(ui, 'name', { placeholder: 'Optional', label: 'Name' })),
      TEST_NOTES[draft.type] ? el('p', { class: 'sp-hint jp-share-note' }, TEST_NOTES[draft.type]) : '',
      el('div', { class: 'sp-buttons jp-share-form-buttons' },
        button(busy && formStatus.what === 'test' ? 'Testing…' : 'Test Connection', () => testDraft(ui), { disabled: busy }),
        button('Save', () => saveDraft(ui), { primary: true, disabled: busy }),
        button('Cancel', () => { reset(); ui.rerender(); })),
      formStatus ? statusLine(el, formStatus) : '',
    ];
  }

  const payload = () => ({ id: draft.id, type: draft.type, name: draft.name, fields: { ...draft.fields }, secrets: { ...draft.secrets } });

  async function testDraft(ui) {
    formStatus = { kind: 'busy', what: 'test', text: 'Testing the connection…' };
    invalid = null;
    ui.rerender();
    const r = await api.sharingTest(payload()).catch(() => null);
    if (view !== 'form') return;
    formStatus = r?.ok ? { kind: 'ok', text: r.message } : { kind: 'warn', text: r?.error || 'The test didn’t finish.' };
    invalid = r?.ok ? null : r?.field || null;
    ui.rerender();
    if (invalid) focusField(invalid);
  }

  async function saveDraft(ui) {
    formStatus = { kind: 'busy', what: 'save', text: 'Saving…' };
    invalid = null;
    ui.rerender();
    const r = await api.sharingSave(payload()).catch(() => null);
    if (!r?.ok) {
      formStatus = { kind: 'warn', text: r?.error || 'Couldn’t save it.' };
      invalid = r?.field || null;
      ui.rerender();
      if (invalid) focusField(invalid);
      return;
    }
    reset();
    ui.notify({ kind: 'info', text: tr('Saved “{name}”. It’s in the editor’s Send to… menu.', { name: r.destination?.name || tr('the destination') }) });
    ui.rerender();
  }

  window.JPSharingSettings = { section, reset };
})();
