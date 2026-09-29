// AWS Signature Version 4, for S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2,
// MinIO, Wasabi). Written out rather than pulling in an SDK: uploads need one signed PUT and
// links need one presigned GET, and this is all that takes.
//   signRequest(): headers for a request (Authorization, X-Amz-Date)
//   presignUrl():  a GET link that works without credentials until it expires
// Paths are encoded once and never normalized, as S3 expects. Checked against AWS's published
// SigV4 test vectors in scripts/test-sharing.cjs.
const crypto = require('crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986: everything except A-Z a-z 0-9 - _ . ~ becomes %XX. encodeURIComponent leaves
// ! ' ( ) * alone, which SigV4 doesn't.
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const encodePath = pathname => pathname.split('/').map(segment => uriEncode(safeDecode(segment))).join('/');

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// "20150830T123600Z" and "20150830"
function amzDates(date) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// Query pairs from a URL's search string, decoded; a bare key ("?lifecycle") has an empty value.
function queryPairs(search) {
  return String(search || '').replace(/^\?/, '').split('&').filter(Boolean).map(part => {
    const i = part.indexOf('=');
    return i < 0 ? [safeDecode(part), ''] : [safeDecode(part.slice(0, i)), safeDecode(part.slice(i + 1))];
  });
}

function canonicalQuery(pairs) {
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// Lower-case names, values trimmed with inner runs of spaces collapsed, repeated headers joined.
function canonicalHeaderMap(headers) {
  const map = new Map();
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase().trim();
    const values = (Array.isArray(raw) ? raw : [raw]).map(v => String(v).trim().replace(/\s+/g, ' '));
    map.set(key, map.has(key) ? `${map.get(key)},${values.join(',')}` : values.join(','));
  }
  return map;
}

function canonicalRequest({ method, pathname, pairs, headerMap, payloadHash }) {
  const names = [...headerMap.keys()].sort();
  return {
    signedHeaders: names.join(';'),
    text: [
      method.toUpperCase(),
      encodePath(pathname || '/'),
      canonicalQuery(pairs),
      names.map(n => `${n}:${headerMap.get(n)}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n'),
  };
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  return hmac(hmac(hmac(kDate, region), service), 'aws4_request');
}

function sign({ secretAccessKey, dateStamp, amzDate, region, service, canonical }) {
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8').digest('hex');
  return { scope, stringToSign, signature };
}

// Signs a request in the Authorization header. `headers` are the ones to send (and sign); Host
// comes from the URL and is signed but not returned, since the HTTP stack sets it. Pass either
// `body` or `payloadHash`. S3 also wants the payload hash sent as x-amz-content-sha256, which
// the caller adds to `headers`.
function signRequest({ method = 'GET', url, headers = {}, body = '', payloadHash, region, service, accessKeyId, secretAccessKey, date = new Date() }) {
  const u = new URL(url);
  const { amzDate, dateStamp } = amzDates(date);
  const send = { ...headers };
  const hasHeader = name => Object.keys(send).some(k => k.toLowerCase() === name);
  if (!hasHeader('x-amz-date')) send['X-Amz-Date'] = amzDate;
  const toSign = hasHeader('host') ? send : { host: u.host, ...send };
  const canonical = canonicalRequest({
    method, pathname: u.pathname, pairs: queryPairs(u.search), headerMap: canonicalHeaderMap(toSign),
    payloadHash: payloadHash || sha256Hex(body),
  });
  const signed = sign({ secretAccessKey, dateStamp, amzDate, region, service, canonical: canonical.text });
  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${signed.scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signed.signature}`;
  const out = Object.fromEntries(Object.entries(send).filter(([k]) => k.toLowerCase() !== 'host'));
  return { headers: { ...out, Authorization: authorization }, authorization, signature: signed.signature, canonicalRequest: canonical.text, stringToSign: signed.stringToSign };
}

// A presigned URL (query-string auth): only the host header is signed and the payload isn't.
// S3 accepts `expires` from 1 second to 7 days (604800).
function presignUrl({ method = 'GET', url, region, service = 's3', accessKeyId, secretAccessKey, expires = 3600, date = new Date() }) {
  const u = new URL(url);
  const { amzDate, dateStamp } = amzDates(date);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const auth = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.round(expires))],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const pairs = [...queryPairs(u.search), ...auth];
  const canonical = canonicalRequest({ method, pathname: u.pathname, pairs, headerMap: new Map([['host', u.host]]), payloadHash: UNSIGNED_PAYLOAD });
  const { signature } = sign({ secretAccessKey, dateStamp, amzDate, region, service, canonical: canonical.text });
  return `${u.origin}${encodePath(u.pathname)}?${canonicalQuery(pairs)}&X-Amz-Signature=${signature}`;
}

module.exports = { signRequest, presignUrl, sha256Hex, uriEncode, encodePath, UNSIGNED_PAYLOAD };
