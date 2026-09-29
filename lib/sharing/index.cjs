// "Send to…" sharing: the destinations people set up in Settings → Sharing and use from the
// editor. createSharing() is everything main.js needs: list / save / remove / test / send, and
// the links a send produced (the only ones a page may open or copy). Nothing here touches the
// network until test() or send() runs, and decrypted credentials never leave this module:
// list() and save() return masked views.
const crypto = require('crypto');
const { SharingError, createRequest, scrub } = require('./http.cjs');
const { createStore } = require('./store.cjs');

const TYPES = Object.fromEntries([
  require('./s3.cjs'), require('./slack.cjs'), require('./jira.cjs'),
  require('./linear.cjs'), require('./teams.cjs'), require('./github.cjs'),
].map(t => [t.type, t]));

const MASK = '••••••••';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const REMEMBERED_LINKS = 50;

const plain = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

function createSharing({ read, write, safeStorage, fetch, isOnline, logError = () => {}, platform }) {
  const store = createStore({ read, write, safeStorage, platform });
  const request = createRequest({ fetch, isOnline });
  const links = [];

  // Teams and GitHub put the image in S3-compatible storage: the one they picked, else the first.
  function storageFor(dest, all = store.all()) {
    const buckets = all.filter(d => d.type === 's3');
    return buckets.find(d => d.id === dest.fields.storageId) || buckets[0] || null;
  }

  // What a page may see: no credentials, only a mask for each one that's saved.
  function publicView(dest, all) {
    const type = TYPES[dest.type];
    const storage = type.needsStorage ? storageFor(dest, all) : null;
    let summary = '';
    try { summary = type.summary(dest.fields); } catch {}
    return {
      id: dest.id, type: dest.type, typeLabel: type.label, name: dest.name, summary,
      fields: { ...dest.fields },
      secrets: Object.fromEntries(type.secretKeys.map(key => [key, MASK])),
      form: type.form, needsStorage: type.needsStorage,
      storageName: storage?.name || null,
      available: !type.needsStorage || !!storage,
    };
  }

  function list() {
    const all = store.all().filter(d => TYPES[d.type]);
    return all.map(d => publicView(d, all));
  }

  // A draft from Settings: { id?, type, name, fields, secrets }. A secret left blank (or still
  // showing the mask) keeps the saved one. { id } alone means the saved destination as it is.
  function resolve(draft) {
    draft = plain(draft);
    const saved = draft.id ? store.get(String(draft.id)) : null;
    if (draft.id && !saved) throw new SharingError('That destination was removed.');
    if (saved && !draft.type) {
      if (!TYPES[saved.type]) throw new SharingError('That destination type isn’t supported.');
      return { ...saved, secrets: store.decrypt(saved) };
    }
    const type = TYPES[draft.type];
    if (!type) throw new SharingError('Choose a kind of destination.');
    if (saved && saved.type !== type.type) throw new SharingError('A destination can’t change kind. Add a new one instead.');
    const fields = type.clean(plain(draft.fields));
    const typed = plain(draft.secrets);
    let previous = null;
    const secrets = {};
    for (const key of type.secretKeys) {
      const value = typeof typed[key] === 'string' && typed[key] !== MASK ? typed[key].trim() : '';
      if (value) secrets[key] = value;
      else if (saved) secrets[key] = (previous ||= store.decrypt(saved))[key];
    }
    type.checkSecrets(secrets);
    return {
      id: saved?.id || `d${crypto.randomBytes(6).toString('hex')}`,
      type: type.type, name: clip(draft.name, 60) || type.defaultName(fields), fields, secrets,
    };
  }

  function save(draft) {
    const dest = resolve(draft);
    if (TYPES[dest.type].needsStorage && !storageFor(dest)) {
      throw new SharingError(`${TYPES[dest.type].label} can’t take image uploads, so it posts a link from your S3-compatible storage. Add storage first.`);
    }
    store.put({ id: dest.id, type: dest.type, name: dest.name, fields: dest.fields, secret: store.encrypt(dest.secrets) });
    return list().find(d => d.id === dest.id);
  }

  const remove = id => store.remove(String(id));

  function remember(url) {
    if (!/^https?:\/\//i.test(url || '') || links.includes(url)) return;
    links.push(url);
    if (links.length > REMEMBERED_LINKS) links.shift();
  }
  const isResultLink = url => typeof url === 'string' && links.includes(url);

  // `used` collects every credential a job touches, so none of them can reach the log.
  function contextFor(dest, progress, used) {
    used.push(...Object.values(dest.secrets));
    const ctx = { fields: dest.fields, secrets: dest.secrets, progress, request };
    if (TYPES[dest.type].needsStorage) {
      ctx.storage = {
        upload(image) {
          const storage = storageFor(dest);
          if (!storage) throw new SharingError(`${TYPES[dest.type].label} needs S3-compatible storage for the image. Add it in Settings → Sharing.`);
          return TYPES.s3.upload(contextFor({ ...storage, secrets: store.decrypt(storage) }, progress, used), image);
        },
      };
    }
    return ctx;
  }

  // Runs a test or send; failures are logged without credentials and come back as SharingErrors.
  async function run(what, used, job) {
    try {
      return await job();
    } catch (err) {
      const e = err instanceof SharingError ? err
        : new SharingError('Something went wrong. The details are in the diagnostic log.', { detail: err?.stack || String(err) });
      if (e.url) remember(e.url);
      logError(`Sharing: ${what}`, scrub([e.message, e.detail && `(${e.detail})`].filter(Boolean).join(' '), used));
      throw e;
    }
  }

  async function test(draft) {
    const dest = resolve(draft);   // a mistake in the form isn't worth logging
    const used = [];
    const type = TYPES[dest.type];
    return run(`test ${type.label} “${dest.name}”`, used, async () => {
      const { message } = await type.test(contextFor(dest, () => {}, used));
      return { message };
    });
  }

  // image: { bytes, filename, contentType }; input: { title, description, message } from the form.
  async function send(id, image, input = {}, progress = () => {}) {
    const saved = store.get(String(id));
    if (!saved || !TYPES[saved.type]) throw new SharingError('That destination was removed. Pick another one.');
    if (!image?.bytes?.length) throw new SharingError('That capture is empty.');
    if (image.bytes.length > MAX_IMAGE_BYTES) throw new SharingError('That image is too large to send (over 50 MB).');
    const type = TYPES[saved.type];
    const used = [];
    return run(`send to ${type.label} “${saved.name}”`, used, async () => {
      const dest = { ...saved, secrets: store.decrypt(saved) };
      const fields = {
        title: clip(input.title, 250) || image.filename,
        description: clip(input.description, 20_000),
        message: clip(input.message, 4000),
      };
      const result = await type.send(contextFor(dest, progress, used), image, fields);
      remember(result.url);
      return result;
    });
  }

  return { list, save, remove, test, send, isResultLink };
}

module.exports = { createSharing, SharingError, TYPES, MASK };
