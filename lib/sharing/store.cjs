// Where destinations live: settings.json → sharing.destinations[], each
//   { id, type, name, fields: { … }, secret: '<base64>' }
// `fields` holds only what isn't secret. A destination's credentials are one JSON object
// encrypted with Electron's safeStorage (its key is kept in the macOS Keychain); only that
// ciphertext is written to disk. Decrypted values are returned to lib/sharing and nowhere else.
const { SharingError } = require('./http.cjs');

const MAX_DESTINATIONS = 24;
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

function createStore({ read, write, safeStorage, platform = process.platform }) {
  const current = () => { const value = read(); return isPlain(value) ? value : {}; };

  // Whatever is on disk, as well-formed entries (a hand-edited file can't break the app).
  function all() {
    const { destinations } = current();
    return (Array.isArray(destinations) ? destinations : [])
      .filter(d => isPlain(d) && typeof d.id === 'string' && typeof d.type === 'string' && typeof d.secret === 'string')
      .map(d => ({ id: d.id, type: d.type, name: String(d.name || ''), fields: isPlain(d.fields) ? { ...d.fields } : {}, secret: d.secret }));
  }

  const get = id => all().find(d => d.id === id) || null;
  const save = destinations => write({ ...current(), destinations });

  function put(dest) {
    const list = all();
    const i = list.findIndex(d => d.id === dest.id);
    if (i < 0 && list.length >= MAX_DESTINATIONS) throw new SharingError(`You can set up to ${MAX_DESTINATIONS} destinations.`);
    if (i < 0) list.push(dest);
    else list[i] = dest;
    save(list);
  }

  function remove(id) {
    const list = all();
    const next = list.filter(d => d.id !== id);
    if (next.length !== list.length) save(next);
    return next.length !== list.length;
  }

  function encryptionAvailable() {
    try {
      if (!safeStorage?.isEncryptionAvailable?.()) return false;
      // On Linux without a keyring, safeStorage falls back to a hard-coded key: no protection.
      return !(platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
    } catch { return false; }
  }

  function encrypt(secrets) {
    if (!encryptionAvailable()) throw new SharingError('Secure storage (the Keychain) isn’t available, so credentials can’t be saved on this Mac.');
    return safeStorage.encryptString(JSON.stringify(secrets)).toString('base64');
  }

  // Fails if the file came from another Mac or user, or the Keychain entry was reset.
  function decrypt(dest) {
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(dest.secret, 'base64')));
      if (isPlain(value)) return value;
    } catch {}
    throw new SharingError(`The saved credentials for “${dest.name}” can’t be read on this Mac. Edit the destination in Settings → Sharing and enter them again.`);
  }

  return { all, get, put, remove, encrypt, decrypt };
}

module.exports = { createStore };
