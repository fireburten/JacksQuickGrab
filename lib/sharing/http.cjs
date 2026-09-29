// Network plumbing shared by the sharing destinations. Every request goes through request():
// it has a timeout, never follows redirects (a token must not be carried to another host), and
// turns failures into SharingErrors whose message tells a person what to do next.
const crypto = require('crypto');

class SharingError extends Error {
  // field: the settings field to fix; detail: extra context for the log (never shown, never secret);
  // url: something worth opening anyway (e.g. an issue created before its attachment failed).
  constructor(message, { status, code, field, detail, url } = {}) {
    super(message);
    this.name = 'SharingError';
    Object.assign(this, { status, code, field, detail, url });
  }
}

const hostOf = url => { try { return new URL(url).host; } catch { return 'the server'; } };

function networkError(err, url, service, timedOut) {
  const host = hostOf(url);
  const text = [err?.cause?.code, err?.cause?.message, err?.message].filter(Boolean).join(' ');
  const make = (message, code) => new SharingError(message, { code, detail: `${service}: ${text}` });
  if (timedOut || err?.name === 'TimeoutError') return make(`${service} didn’t answer in time. Check your internet connection and try again.`, 'timeout');
  if (/INTERNET_DISCONNECTED|ENETUNREACH|ENETDOWN|NETWORK_CHANGED/i.test(text)) return make('Your Mac seems to be offline. Check your internet connection and try again.', 'offline');
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(text)) return make(`Couldn’t find ${host}. Check the address and your internet connection.`, 'dns');
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) return make(`${host} refused the connection. Check the address.`, 'refused');
  if (/CERT|SSL|TLS/i.test(text)) return make(`Couldn’t make a secure connection to ${host} (a certificate problem).`, 'tls');
  return make(`Couldn’t connect to ${host}. Check your internet connection and try again.`, 'network');
}

// request(url, { method, headers, body, timeout, service }) → { status, ok, headers, text, json }
// The whole body is read (responses here are small). 3xx responses come back as not ok.
function createRequest({ fetch, isOnline = () => true, timeout: defaultTimeout = 30_000 }) {
  return async function request(url, { method = 'GET', headers = {}, body, timeout = defaultTimeout, service = 'The server' } = {}) {
    if (isOnline() === false) throw new SharingError('Your Mac is offline. Connect to the internet and try again.', { code: 'offline' });
    const signal = AbortSignal.timeout(timeout);
    let res, buffer;
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw networkError(err, url, service, signal.aborted);
    }
    // An opaque redirect (status 0) can't be inspected; either way it isn't followed.
    if (res.status === 0 || res.type === 'opaqueredirect') {
      throw new SharingError(`${service} sent the request somewhere else. Check the address.`, { code: 'redirect' });
    }
    const text = buffer.toString('utf8');
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text, json, buffer };
  };
}

// multipart/form-data with our own boundary, as one Buffer (so it has a known length).
function multipart(parts) {
  const boundary = `----JacksPicker${crypto.randomBytes(12).toString('hex')}`;
  const quote = s => String(s).replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const chunks = [];
  for (const { name, filename, contentType, data } of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"`;
    if (filename != null) head += `; filename="${quote(filename)}"`;
    head += `\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ''}\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(data) ? data : Buffer.from(String(data)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// For the log: secrets (as typed and URL-encoded) become ••••, and query strings, which can
// carry signatures (presigned links, workflow URLs), are dropped.
function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('••••');
  }
  return out.replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?…');
}

module.exports = { SharingError, createRequest, multipart, scrub, hostOf };
