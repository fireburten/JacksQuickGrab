// S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi). "Copy Link"
// uploads the capture with a signed PUT and copies either a presigned link (1 hour to 7 days)
// or a link under the bucket's public base URL. Teams and GitHub use this too, for image links.
// Objects go to <prefix><random>/<name>, so public links can't be guessed from the file name.
const crypto = require('crypto');
const { signRequest, presignUrl, sha256Hex, uriEncode } = require('./sigv4.cjs');
const { SharingError, hostOf } = require('./http.cjs');

const SERVICE = 'The storage service';
const EXPIRY_OPTIONS = [3600, 86400, 604800];   // S3 caps presigned links at 7 days
const TEST_OBJECT = 'jacks-picker-connection-test.txt';

const trim = v => String(v ?? '').trim();

function httpUrl(value, field, label) {
  const text = trim(value);
  if (!text) return '';
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) throw new SharingError(`Enter the ${label} as a web address, like https://…`, { field });
  return url;
}

function clean(raw) {
  const endpoint = httpUrl(raw.endpoint, 'endpoint', 'endpoint');
  const region = trim(raw.region) || 'us-east-1';
  if (!/^[a-z0-9-]{2,40}$/i.test(region)) throw new SharingError('Enter a region like us-east-1 (Cloudflare R2 uses “auto”).', { field: 'region' });
  const bucket = trim(raw.bucket);
  if (!bucket) throw new SharingError('Enter the bucket name.', { field: 'bucket' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(bucket)) throw new SharingError('That isn’t a valid bucket name (letters, numbers, dots and dashes).', { field: 'bucket' });
  let prefix = trim(raw.prefix).replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  if (prefix.split('/').some(s => s === '..' || s === '.') || /[\u0000-\u001f]/.test(prefix) || prefix.length > 200) {
    throw new SharingError('Use a plain folder name for the key prefix, like screenshots/.', { field: 'prefix' });
  }
  const linkType = raw.linkType === 'public' ? 'public' : 'presigned';
  const expiry = EXPIRY_OPTIONS.includes(+raw.expiry) ? +raw.expiry : 86400;
  const publicUrl = linkType === 'public' ? httpUrl(raw.publicBaseUrl, 'publicBaseUrl', 'public base URL') : '';
  if (linkType === 'public' && !publicUrl) throw new SharingError('Enter the public base URL that serves this bucket, or use presigned links.', { field: 'publicBaseUrl' });
  return {
    endpoint: endpoint ? endpoint.origin : '',
    region, bucket, prefix, linkType, expiry,
    publicBaseUrl: publicUrl ? publicUrl.href.replace(/\/+$/, '') : '',
  };
}

function checkSecrets(secrets) {
  if (!trim(secrets.accessKeyId)) throw new SharingError('Enter the access key ID.', { field: 'accessKeyId' });
  if (!trim(secrets.secretAccessKey)) throw new SharingError('Enter the secret access key.', { field: 'secretAccessKey' });
}

const expiryLabel = seconds => ({ 3600: '1 hour', 86400: '1 day', 604800: '7 days' }[seconds] || `${Math.round(seconds / 3600)} hours`);
const endpointOf = fields => fields.endpoint || `https://s3.${fields.region}.amazonaws.com`;

function summary(fields) {
  const links = fields.linkType === 'public' ? `public links (${hostOf(fields.publicBaseUrl)})` : `presigned links, ${expiryLabel(fields.expiry)}`;
  return `${fields.bucket} on ${hostOf(endpointOf(fields))} · ${links}`;
}

const encodeKey = key => key.split('/').map(uriEncode).join('/');

// AWS gets virtual-hosted URLs (bucket.s3.region.amazonaws.com), which newer regions require;
// other providers, and bucket names with dots (they break TLS on virtual hosts), get path-style.
function objectUrl(fields, key) {
  const base = new URL(endpointOf(fields));
  const virtual = /(^|\.)amazonaws\.com$/i.test(base.hostname) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(fields.bucket);
  return virtual
    ? `${base.protocol}//${fields.bucket}.${base.host}/${encodeKey(key)}`
    : `${base.origin}/${uriEncode(fields.bucket)}/${encodeKey(key)}`;
}

const credentialsOf = ({ fields, secrets }) => ({
  region: fields.region, accessKeyId: trim(secrets.accessKeyId), secretAccessKey: trim(secrets.secretAccessKey),
});

function linkFor(ctx, key) {
  if (ctx.fields.linkType === 'public') return `${ctx.fields.publicBaseUrl}/${encodeKey(key)}`;
  return presignUrl({ ...credentialsOf(ctx), url: objectUrl(ctx.fields, key), expires: ctx.fields.expiry });
}

const xmlValue = (xml, tag) => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml || '') || [])[1] || '';

function storageError(res, fields) {
  const code = xmlValue(res.text, 'Code');
  const region = xmlValue(res.text, 'Region') || res.headers?.get?.('x-amz-bucket-region') || '';
  const inRegion = region ? ` (${region})` : '';
  const messages = {
    InvalidAccessKeyId: 'The storage service didn’t recognize the access key ID. Check it, and that it’s for this provider.',
    SignatureDoesNotMatch: 'The secret access key doesn’t match the access key ID.',
    NoSuchBucket: `There’s no bucket named “${fields.bucket}” at ${hostOf(endpointOf(fields))}.`,
    AccessDenied: 'Access denied. The key needs permission to upload to this bucket (s3:PutObject).',
    AuthorizationHeaderMalformed: `This bucket is in a different region${inRegion}. Update the region.`,
    IllegalLocationConstraintException: `This bucket is in a different region${inRegion}. Update the region.`,
    PermanentRedirect: `This bucket has to be reached through its own region${inRegion}. Update the region or endpoint.`,
    RequestTimeTooSkewed: 'Your Mac’s clock is too far off for the storage service. Turn on “Set time and date automatically” in System Settings.',
    InvalidBucketName: 'That bucket name isn’t valid for this provider.',
    EntityTooLarge: 'The image is too large for this bucket.',
  };
  let message = messages[code];
  if (!message && res.status >= 300 && res.status < 400) message = `This bucket has to be reached through a different region or endpoint${inRegion}.`;
  if (!message && res.status >= 500) message = `The storage service is having trouble (HTTP ${res.status}). Try again later.`;
  return new SharingError(message || `The storage service returned an error (HTTP ${res.status}${code ? `, ${code}` : ''}).`, {
    status: res.status, code, field: ['NoSuchBucket', 'InvalidBucketName'].includes(code) ? 'bucket' : undefined,
    detail: `${res.status} ${code} ${xmlValue(res.text, 'Message')}`,
  });
}

async function signedRequest(ctx, method, key, { body = Buffer.alloc(0), contentType, timeout } = {}) {
  const url = objectUrl(ctx.fields, key);
  const payloadHash = sha256Hex(body);
  const headers = { 'x-amz-content-sha256': payloadHash, ...(contentType ? { 'Content-Type': contentType } : {}) };
  const signed = signRequest({ ...credentialsOf(ctx), method, url, headers, payloadHash, service: 's3' });
  const res = await ctx.request(url, { method, headers: signed.headers, body: method === 'PUT' ? body : undefined, timeout, service: SERVICE });
  if (!res.ok) throw storageError(res, ctx.fields);
  return res;
}

const objectKey = (fields, filename) =>
  `${fields.prefix}${crypto.randomBytes(9).toString('base64url')}/${filename.replace(/[^A-Za-z0-9._-]+/g, '-')}`;

// Uploads the image and returns its link. Used by "Copy Link" and as Teams/GitHub image storage.
async function upload(ctx, image) {
  const key = objectKey(ctx.fields, image.filename);
  await signedRequest(ctx, 'PUT', key, { body: image.bytes, contentType: image.contentType, timeout: 120_000 });
  const presigned = ctx.fields.linkType !== 'public';
  return { url: linkFor(ctx, key), expires: presigned ? Date.now() + ctx.fields.expiry * 1000 : null };
}

// Uploads a small text file, opens its link the way a teammate would, then deletes it.
async function test(ctx) {
  const key = `${ctx.fields.prefix}${TEST_OBJECT}`;
  const body = Buffer.from('Jack’s Picker connection test. It’s safe to delete this file.\n');
  await signedRequest(ctx, 'PUT', key, { body, contentType: 'text/plain; charset=utf-8' });
  try {
    const link = await ctx.request(linkFor(ctx, key), { service: SERVICE });
    if (!link.ok || !link.buffer.equals(body)) {
      throw new SharingError(ctx.fields.linkType === 'public'
        ? `Uploading works, but the public link didn’t (HTTP ${link.status}). Check the public base URL, and that the bucket allows public reads.`
        : `Uploading works, but the presigned link didn’t open (HTTP ${link.status}).`, { status: link.status, field: ctx.fields.linkType === 'public' ? 'publicBaseUrl' : undefined });
    }
  } finally {
    await signedRequest(ctx, 'DELETE', key).catch(() => {});   // a key without delete permission leaves one tiny file
  }
  return { message: ctx.fields.linkType === 'public'
    ? 'Connected. Uploaded a test file and opened it at the public URL.'
    : `Connected. Uploaded a test file and opened its presigned link (links last ${expiryLabel(ctx.fields.expiry)}).` };
}

async function send(ctx, image) {
  ctx.progress('Uploading…');
  const link = await upload(ctx, image);
  return { url: link.url, expires: link.expires, copy: true, label: 'Link copied' };
}

module.exports = {
  type: 's3', label: 'S3-compatible storage', secretKeys: ['accessKeyId', 'secretAccessKey'], form: null, needsStorage: false,
  defaultName: fields => fields.bucket,
  clean, checkSecrets, summary, test, send, upload, expiryLabel,
};
