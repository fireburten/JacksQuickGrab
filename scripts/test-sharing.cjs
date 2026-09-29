// Tests for "Send to…" sharing: lib/sharing, its IPC in main.js, and the pages that use it.
//   node scripts/test-sharing.cjs      AWS's SigV4 test vectors, then main.js (with a stand-in for
//                                      electron) against a local mock of every destination
//   unset ELECTRON_RUN_AS_NODE; ./node_modules/.bin/electron scripts/test-sharing.cjs
//                                      all of that, plus Settings → Sharing and the editor's
//                                      Send to… flow on the real pages (offscreen), where main.js's
//                                      real handlers answer and Electron's net.fetch does the requests
// Nothing leaves this machine: the stand-in net.fetch sends every request to a mock server on
// 127.0.0.1, which checks what arrives (auth headers, SigV4 signatures, multipart bodies) and
// answers like the real service. Exits non-zero on failure; the report is also written to
// $TMPDIR/test-sharing.txt because stdout can be cut off when Electron quits.
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const IN_ELECTRON = typeof electron === 'object' && !!electron?.app;
const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');
const REPORT = path.join(os.tmpdir(), 'test-sharing.txt');
const v4 = require('../lib/sharing/sigv4.cjs');
const { createRequest } = require('../lib/sharing/http.cjs');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 700) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
console.error = () => {};   // main.js echoes what it logs; the log file is what's checked

// ── Credentials the mocks accept ──
const CREDS = {
  accessKeyId: 'AKIATESTKEYGOOD00001',
  secretAccessKey: 'tEsT/sEcReT+kEy/GOOD0123456789abcdefXYZ',
  slack: 'xoxb-1111-2222-TESTslackTOKENgood',
  jiraEmail: 'dev@acme.test',
  jira: 'ATATT3xTESTjiraTOKENgood',
  linear: 'lin_api_TESTlinearKEYgood',
  teamsSig: 'TESTteamsSIGgood0123',
  github: 'github_pat_TESTgithubTOKENgood',
};
const TEAMS_URL = `https://prod-12.westus.logic.azure.com:443/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${CREDS.teamsSig}`;
const JIRA_AUTH = `Basic ${Buffer.from(`${CREDS.jiraEmail}:${CREDS.jira}`).toString('base64')}`;
const SECRETS = [CREDS.accessKeyId, CREDS.secretAccessKey, CREDS.slack, CREDS.jira, CREDS.linear, CREDS.teamsSig, CREDS.github, JIRA_AUTH.slice(6)];
// Presigned links carry the access key ID (as every S3 presigned URL does), never the secret key.
const leaks = text => SECRETS.filter(s => String(text).replace(/X-Amz-Credential=[^&"\s]+/g, '').includes(s));
const SHOT = 'screenshot-2026-09-28-13-49-02.png';

// ── 1. SigV4 against AWS's published test vectors ──
function sigv4Vectors() {
  const suite = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', date: new Date('2015-08-30T12:36:00Z') };
  const base = { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' };
  const U = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  // aws-sig-v4-test-suite: [name, method, path and query, headers, body, signature]
  const vectors = [
    ['get-vanilla', 'GET', '/', {}, '', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
    ['get-vanilla-empty-query-key', 'GET', '/?Param1=value1', {}, '', 'a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb'],
    ['get-vanilla-query-order-key-case', 'GET', '/?Param2=value2&Param1=value1', {}, '', 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'],
    ['get-vanilla-query-unreserved', 'GET', `/?${U}=${U}`, {}, '', '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197'],
    ['get-header-value-trim', 'GET', '/', { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' }, '', 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736'],
    ['post-vanilla', 'POST', '/', {}, '', '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b'],
    ['post-vanilla-query', 'POST', '/?Param1=value1', {}, '', '28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11'],
    ['post-header-key-sort', 'POST', '/', { 'My-Header1': 'value1' }, '', 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c'],
    ['post-header-value-case', 'POST', '/', { 'My-Header1': 'VALUE1' }, '', 'cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d'],
    ['post-x-www-form-urlencoded', 'POST', '/', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'Param1=value1', 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a'],
    ['post-x-www-form-urlencoded-parameters', 'POST', '/', { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf8' }, 'Param1=value1', '1a72ec8f64bd914b0e42e42607c7fbce7fb2c7465f63e3092b3b0d39fa77a6fe'],
  ];
  for (const [name, method, p, headers, body, signature] of vectors) {
    const r = v4.signRequest({ ...suite, method, url: `https://example.amazonaws.com${p}`, headers: { ...base, ...headers }, body });
    check(`SigV4 test suite: ${name}`, r.signature === signature, r.signature);
  }
  const vanilla = v4.signRequest({ ...suite, url: 'https://example.amazonaws.com/', headers: base });
  check('SigV4 test suite: get-vanilla canonical request (.creq)', vanilla.canonicalRequest === 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', vanilla.canonicalRequest);
  check('SigV4 test suite: get-vanilla string to sign (.sts)', vanilla.stringToSign === 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63', vanilla.stringToSign);
  check('SigV4 test suite: get-vanilla Authorization header (.authz)', vanilla.headers.Authorization === 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    && !('Host' in vanilla.headers), JSON.stringify(vanilla.headers));

  // The S3 examples in AWS's SigV4 documentation (header auth and query-string auth).
  const s3 = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', date: new Date('2013-05-24T00:00:00Z') };
  const empty = sha256('');
  const welcome = sha256('Welcome to Amazon S3.');
  const s3Examples = [
    ['GET Object', 'GET', '/test.txt', { Range: 'bytes=0-9', 'x-amz-content-sha256': empty }, empty, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'],
    ['PUT Object (a $ in the key)', 'PUT', '/test$file.text', { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': welcome }, welcome, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'],
    ['GET Bucket Lifecycle', 'GET', '/?lifecycle', { 'x-amz-content-sha256': empty }, empty, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'],
    ['GET Bucket (List Objects)', 'GET', '/?max-keys=2&prefix=J', { 'x-amz-content-sha256': empty }, empty, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'],
  ];
  for (const [name, method, p, headers, payloadHash, signature] of s3Examples) {
    const r = v4.signRequest({ ...s3, method, url: `https://examplebucket.s3.amazonaws.com${p}`, headers, payloadHash });
    check(`SigV4 S3 example: ${name}`, r.signature === signature, r.signature);
  }
  const presigned = v4.presignUrl({ ...s3, url: 'https://examplebucket.s3.amazonaws.com/test.txt', expires: 86400 });
  check('SigV4 S3 example: presigned GET URL', presigned === 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404', presigned);
}

// ── 2. A mock of every destination ──
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const parseQuery = search => Object.fromEntries(search.replace(/^\?/, '').split('&').filter(Boolean).map(part => {
  const i = part.indexOf('=');
  return i < 0 ? [decodeURIComponent(part), ''] : [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
}));
const amzTime = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));

// SigV4, checked independently of lib/sharing from the request as it arrived (header auth or a
// presigned URL). Returns null when it's good, else what's wrong.
function verifySigV4(e) {
  const q = parseQuery(e.url.search);
  const presigned = 'X-Amz-Signature' in q;
  let credential, signedHeaders, signature, amzDate, payloadHash;
  if (presigned) {
    ({ 'X-Amz-Credential': credential, 'X-Amz-SignedHeaders': signedHeaders, 'X-Amz-Signature': signature, 'X-Amz-Date': amzDate } = q);
    payloadHash = 'UNSIGNED-PAYLOAD';
    if (Date.now() > amzTime(amzDate) + (+q['X-Amz-Expires']) * 1000) return 'expired';
  } else {
    const m = /^AWS4-HMAC-SHA256 Credential=(\S+), SignedHeaders=(\S+), Signature=([0-9a-f]{64})$/.exec(e.headers.authorization || '');
    if (!m) return 'no SigV4 Authorization header';
    [, credential, signedHeaders, signature] = m;
    amzDate = e.headers['x-amz-date'] || '';
    payloadHash = e.headers['x-amz-content-sha256'];
    if (payloadHash !== sha256(e.body)) return 'x-amz-content-sha256 isn’t the body’s hash';
    if (Math.abs(Date.now() - amzTime(amzDate)) > 15 * 60_000) return 'x-amz-date is off';
  }
  const [accessKey, ...scope] = credential.split('/');
  if (accessKey !== CREDS.accessKeyId) return 'InvalidAccessKeyId';
  const names = signedHeaders.split(';');
  if (!names.includes('host')) return 'host isn’t signed';
  const canonical = [
    e.method,
    e.url.pathname.split('/').map(s => rfc3986(decodeURIComponent(s))).join('/'),
    Object.entries(q).filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [rfc3986(k), rfc3986(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(pair => pair.join('=')).join('&'),
    names.map(n => `${n}:${n === 'host' ? e.url.host : String(e.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope.join('/'), sha256(canonical)].join('\n');
  const key = scope.slice(1).reduce((k, part) => hmac(k, part), hmac(`AWS4${CREDS.secretAccessKey}`, scope[0]));
  return crypto.createHmac('sha256', key).update(stringToSign).digest('hex') === signature ? null : 'SignatureDoesNotMatch';
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType || '')?.[1];
  if (!boundary) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  for (let pos = body.indexOf(delimiter); pos !== -1;) {
    const start = pos + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headEnd = body.indexOf('\r\n\r\n', start);
    const next = body.indexOf(delimiter, headEnd);
    if (headEnd < 0 || next < 0) break;
    const head = body.subarray(start + 2, headEnd).toString();
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1], filename: /filename="([^"]*)"/.exec(head)?.[1],
      type: /Content-Type: ([^\r\n]+)/i.exec(head)?.[1], data: body.subarray(headEnd + 4, next - 2),
    });
    pos = next;
  }
  return parts;
}

const reply = (res, status, body = '', type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const s3Error = (res, status, code, message = code) =>
  reply(res, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><AWSAccessKeyId>${CREDS.accessKeyId}</AWSAccessKeyId></Error>`, 'application/xml');
const jsonBody = e => { try { return JSON.parse(e.body.toString()); } catch { return null; } };

function s3Route(mock, e, res) {
  const problem = verifySigV4(e);
  if (problem === 'InvalidAccessKeyId') return s3Error(res, 403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');
  if (problem) return s3Error(res, 403, 'SignatureDoesNotMatch', problem);
  const virtual = /^([a-z0-9-]+)\.s3\.[a-z0-9-]+\.amazonaws\.com$/.exec(e.host);
  const parts = e.url.pathname.split('/').slice(1).map(decodeURIComponent);
  const bucket = virtual ? virtual[1] : parts.shift();
  const key = parts.join('/');
  if (bucket !== 'team-shots') return s3Error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
  if (e.method === 'PUT') { mock.objects.set(key, { body: e.body, type: e.headers['content-type'] }); return reply(res, 200); }
  if (e.method === 'DELETE') { mock.objects.delete(key); return reply(res, 204); }
  const object = mock.objects.get(key);
  return object ? reply(res, 200, object.body, object.type) : s3Error(res, 404, 'NoSuchKey');
}

function slackRoute(mock, e, res) {
  if (e.host === 'files.slack.com') {
    // The upload URL is already authorized; the token must not be sent along.
    if (e.headers.authorization || e.url.pathname !== '/upload/v1/ABC123') return reply(res, 400, 'bad upload', 'text/plain');
    return reply(res, 200, `OK - ${e.body.length}`, 'text/plain');
  }
  if (e.headers.authorization !== `Bearer ${CREDS.slack}`) return reply(res, 200, { ok: false, error: 'invalid_auth' });
  const form = /x-www-form-urlencoded/.test(e.headers['content-type']) ? Object.fromEntries(new URLSearchParams(e.body.toString())) : {};
  const data = /application\/json/.test(e.headers['content-type']) ? jsonBody(e) : {};
  switch (e.url.pathname) {
    case '/api/auth.test': return reply(res, 200, { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'jackspicker' });
    case '/api/files.getUploadURLExternal':
      if (!form.filename || !/^\d+$/.test(form.length || '')) return reply(res, 200, { ok: false, error: 'invalid_arguments' });
      return reply(res, 200, { ok: true, upload_url: 'https://files.slack.com/upload/v1/ABC123', file_id: 'F0TEST1234' });
    case '/api/files.completeUploadExternal':
      if (data.channel_id === 'C0NOTINCHAN') return reply(res, 200, { ok: false, error: 'not_in_channel' });
      if (data.files?.[0]?.id !== 'F0TEST1234') return reply(res, 200, { ok: false, error: 'file_not_found' });
      return reply(res, 200, { ok: true, files: [{ id: 'F0TEST1234', title: data.files[0].title, permalink: 'https://acme.slack.com/files/U1/F0TEST1234/screenshot.png' }] });
    case '/api/chat.postMessage':
      if (form.channel === 'C0NOTINCHAN') return reply(res, 200, { ok: false, error: 'not_in_channel' });
      return reply(res, 200, { ok: true, channel: form.channel, ts: '1727000000.000100' });
    default: return reply(res, 200, { ok: false, error: 'unknown_method' });
  }
}

function jiraRoute(mock, e, res) {
  if (e.headers.authorization !== JIRA_AUTH) return reply(res, 401, { errorMessages: ['Client must be authenticated to access this resource.'] });
  const p = e.url.pathname;
  if (e.method === 'GET' && p === '/rest/api/3/myself') return reply(res, 200, { displayName: 'Dev Person', emailAddress: CREDS.jiraEmail });
  if (e.method === 'GET' && p.startsWith('/rest/api/3/project/')) {
    const key = decodeURIComponent(p.split('/').pop());
    return key === 'PROJ' ? reply(res, 200, { key, name: 'Web Platform', issueTypes: [{ name: 'Task' }, { name: 'Bug' }] })
      : reply(res, 404, { errorMessages: [`No project could be found with key '${key}'.`] });
  }
  if (e.method === 'POST' && p === '/rest/api/3/issue') {
    const f = jsonBody(e)?.fields || {};
    if (f.project?.key !== 'PROJ') return reply(res, 400, { errors: { project: 'valid project is required' } });
    if (!['Task', 'Bug'].includes(f.issuetype?.name)) return reply(res, 400, { errors: { issuetype: 'Specify a valid issue type' } });
    return reply(res, 201, { id: '10007', key: 'PROJ-7', self: 'https://acme.atlassian.net/rest/api/3/issue/10007' });
  }
  if (e.method === 'POST' && p === '/rest/api/3/issue/PROJ-7/attachments') {
    if (e.headers['x-atlassian-token'] !== 'no-check') return reply(res, 403, 'XSRF check failed', 'text/plain');
    const [file] = parseMultipart(e.body, e.headers['content-type']);
    return file ? reply(res, 200, [{ id: '1', filename: file.filename }]) : reply(res, 400, { errorMessages: ['No file'] });
  }
  return reply(res, 404, { errorMessages: ['Not found'] });
}

function linearRoute(mock, e, res) {
  if (e.host === 'uploads.linear.app') return reply(res, e.method === 'PUT' && e.url.pathname === '/signed/abc123' && !e.headers.authorization ? 200 : 403, '');
  if (e.headers.authorization !== CREDS.linear) {
    return reply(res, 400, { errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR', type: 'authentication error', userPresentableMessage: 'You need to authenticate to access this operation.' } }] });
  }
  const { query = '', variables = {} } = jsonBody(e) || {};
  if (query.includes('viewer')) return reply(res, 200, { data: { viewer: { name: 'Dev Person' }, organization: { name: 'Acme' } } });
  if (query.includes('teams(')) return reply(res, 200, { data: { teams: { nodes: [{ id: 'team-uuid-eng', key: 'ENG', name: 'Engineering' }, { id: 'team-uuid-des', key: 'DES', name: 'Design' }] } } });
  if (query.includes('fileUpload')) {
    return reply(res, 200, { data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: 'https://uploads.linear.app/signed/abc123?X-Goog-Signature=zzz', assetUrl: 'https://uploads.linear.app/org1/abc123/shot.png',
      headers: [{ key: 'x-goog-meta-origin', value: 'jacks-picker-test' }],
    } } } });
  }
  if (query.includes('issueCreate') && variables.input?.teamId === 'team-uuid-eng') {
    return reply(res, 200, { data: { issueCreate: { success: true, issue: { identifier: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42/login-button' } } } });
  }
  return reply(res, 200, { errors: [{ message: 'Unexpected query', extensions: { code: 'INVALID_INPUT' } }] });
}

function teamsRoute(mock, e, res) {
  if (parseQuery(e.url.search).sig !== CREDS.teamsSig) return reply(res, 401, { error: { code: 'DirectApiAuthorizationRequired' } });
  const card = jsonBody(e);
  return reply(res, card?.type === 'message' && card.attachments?.[0]?.contentType === 'application/vnd.microsoft.card.adaptive' ? 202 : 400, '');
}

function githubRoute(mock, e, res) {
  if (e.headers.authorization !== `Bearer ${CREDS.github}`) return reply(res, 401, { message: 'Bad credentials' });
  if (e.headers['x-github-api-version'] !== '2022-11-28' || !e.headers['user-agent'] || e.headers.accept !== 'application/vnd.github+json') return reply(res, 400, { message: 'Bad headers' });
  if (e.method === 'GET' && e.url.pathname === '/repos/acme/web') return reply(res, 200, { full_name: 'acme/web', has_issues: true });
  if (e.method === 'POST' && e.url.pathname === '/repos/acme/web/issues') return reply(res, 201, { number: 42, html_url: 'https://github.com/acme/web/issues/42' });
  return reply(res, 404, { message: 'Not Found' });
}

function route(mock, e, res) {
  if (/\.amazonaws\.com$|\.r2\.cloudflarestorage\.com$/.test(e.host)) return s3Route(mock, e, res);
  if (e.host === 'cdn.acme.test') {   // the bucket's public base URL
    const object = mock.objects.get(decodeURIComponent(e.url.pathname.slice(1)));
    return object ? reply(res, 200, object.body, object.type) : reply(res, 404, 'Not Found', 'text/plain');
  }
  if (e.host === 'slack.com' || e.host === 'files.slack.com') return slackRoute(mock, e, res);
  if (e.host === 'acme.atlassian.net') return jiraRoute(mock, e, res);
  if (e.host === 'api.linear.app' || e.host === 'uploads.linear.app') return linearRoute(mock, e, res);
  if (e.host === 'prod-12.westus.logic.azure.com') return teamsRoute(mock, e, res);
  if (e.host === 'api.github.com') return githubRoute(mock, e, res);
  return reply(res, 404, 'Not a host this mock knows', 'text/plain');
}

async function startMock() {
  const mock = { log: [], objects: new Map(), port: 0 };
  mock.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, req.headers['x-test-origin'] || 'http://unknown.test');
      const e = { method: req.method, host: url.hostname, path: url.pathname, url, headers: req.headers, body: Buffer.concat(chunks) };
      mock.log.push(e);
      if (url.pathname === '/hang') return;   // never answers
      try { route(mock, e, res); } catch (err) { reply(res, 500, err.stack, 'text/plain'); }
    });
  });
  // A port that was just free: connecting to it is refused, like a server that's off.
  mock.closedPort = await new Promise(resolve => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  return new Promise(resolve => mock.server.listen(0, '127.0.0.1', () => { mock.port = mock.server.address().port; resolve(mock); }));
}

// Stand-in for net.fetch: every https:// request goes to the mock, which learns the real origin
// from a header. down.example.test goes to a closed port.
function mockFetch(mock, calls, send = globalThis.fetch) {
  return (url, init = {}) => {
    calls.push(String(url));
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    headers.set('x-test-origin', u.origin);
    const target = `http://127.0.0.1:${u.hostname === 'down.example.test' ? mock.closedPort : mock.port}${u.pathname}${u.search}`;
    return send(target, { ...init, headers });
  };
}

// ── 3. main.js with a stand-in for electron (after scripts/test-main-process.cjs) ──
function loadMain({ fetch, nativeImage = {}, forward = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-sharing-test-'));
  const env = {
    tmp, home: path.join(tmp, 'home'), handle: {}, on: {}, sent: [], opened: [], clipboard: [],
    online: true, encryption: true, sharingDisabled: false,
  };
  fs.mkdirSync(env.home);
  const send = (channel, ...args) => {
    structuredClone(args);   // like Electron, only what can be serialized gets through
    env.sent.push({ channel, args });
    forward?.(channel, ...args);
  };
  class FakeWindow {
    constructor() { this.webContents = { id: 1, send, once() {}, setZoomFactor() {}, getURL: () => '', isDestroyed: () => false }; }
    on() {} show() {} focus() {} setBackgroundColor() {} loadFile() {} isDestroyed() { return false; }
  }
  const windows = [new FakeWindow()];
  // Reversible, but never the plain text (like the Keychain-backed original).
  const flip = buf => Buffer.from(buf.map(b => b ^ 0x5a));
  env.safeStorage = {
    isEncryptionAvailable: () => env.encryption,
    encryptString: text => Buffer.concat([Buffer.from('v10'), flip(Buffer.from(text, 'utf8'))]),
    decryptString: buf => {
      if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return flip(buf.subarray(3)).toString('utf8');
    },
  };
  const electronStub = {
    app: {
      getPath: name => path.join(tmp, name), whenReady: () => new Promise(() => {}), isReady: () => true, on() {}, focus() {},
      isPackaged: false, commandLine: { hasSwitch: () => false }, getVersion: () => '1.0.0', getLocale: () => 'en-US', getAppPath: () => ROOT,
      getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {},
    },
    BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => windows, fromWebContents: () => null }),
    Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, globalShortcut: { register: () => true, unregisterAll() {} },
    ipcMain: { handle: (c, f) => { env.handle[c] = f; }, on: (c, f) => { env.on[c] = f; }, once() {}, removeListener() {} },
    screen: {}, desktopCapturer: {}, ShareMenu: class {}, nativeImage,
    clipboard: { writeText: text => env.clipboard.push(text), writeImage() {} },
    systemPreferences: { getUserDefault: key => (key === 'DisableSharing' && env.sharingDisabled ? '1' : '') },   // a managed profile value, read as a string
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
    dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal: async url => { env.opened.push(url); }, showItemInFolder() {}, openPath: async () => '', trashItem: async () => {} },
    net: { fetch: (url, init) => fetch(url, init), isOnline: () => env.online },
    safeStorage: env.safeStorage,
  };
  const realHome = process.env.HOME;
  process.env.HOME = env.home;   // os.homedir() → the default captures folder, read once at load
  const load = Module._load;
  const before = { ex: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection') };
  Module._load = function (request, ...rest) { return request === 'electron' ? electronStub : load.call(this, request, ...rest); };
  try {
    const m = new Module(MAIN, module);
    m.filename = MAIN;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(fs.readFileSync(MAIN, 'utf8'), MAIN);
  } finally {
    Module._load = load;
    process.env.HOME = realHome;
    process.listeners('uncaughtException').filter(l => !before.ex.includes(l)).forEach(l => process.removeListener('uncaughtException', l));
    process.listeners('unhandledRejection').filter(l => !before.rej.includes(l)).forEach(l => process.removeListener('unhandledRejection', l));
  }
  env.saveDir = path.join(env.home, 'Documents', "Jack's Picker");
  fs.mkdirSync(path.join(env.saveDir, '.annotations'), { recursive: true });
  env.settingsFile = path.join(tmp, 'userData', 'settings.json');
  env.settings = () => JSON.parse(fs.readFileSync(env.settingsFile, 'utf8'));
  env.log = () => { try { return fs.readFileSync(path.join(tmp, 'logs', 'main.log'), 'utf8'); } catch { return ''; } };
  env.sender = { isDestroyed: () => false, send: (channel, ...args) => env.sent.push({ channel, args }) };
  env.returned = [];
  env.call = async (channel, ...args) => { const r = await env.handle[channel]({ sender: env.sender }, ...args); env.returned.push(r); return r; };
  return env;
}

function addCapture(m, name, { flat = false, bytes = Buffer.from(`PNG original ${name}`) } = {}) {
  const file = path.join(m.saveDir, name);
  fs.writeFileSync(file, bytes);
  const flatFile = path.join(m.saveDir, '.annotations', name.replace(/\.(png|jpe?g)$/i, '.flat.png'));
  if (flat) fs.writeFileSync(flatFile, Buffer.from(`PNG annotated ${name}`));
  return { file, flatFile, sent: fs.readFileSync(flat ? flatFile : file) };
}

async function mainProcessTests(mock) {
  const calls = [];
  const m = loadMain({ fetch: mockFetch(mock, calls) });
  const call = m.call;
  const keys = { accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey };
  let r;

  // Off until set up; saving never touches the network
  let s = await call('settings-get');
  check('main: sharing starts allowed, with no destinations', s.sharing?.allowed === true && s.sharing.destinations.length === 0, JSON.stringify(s.sharing));
  r = await call('sharing-save', { type: 's3', fields: { bucket: 'team-shots' }, secrets: {} });
  check('save: a missing credential points at its field', !r.ok && r.field === 'accessKeyId', JSON.stringify(r));
  r = await call('sharing-save', { type: 'slack', fields: { channel: '#design' }, secrets: { token: CREDS.slack } });
  check('save: a Slack channel name instead of its ID is explained', !r.ok && r.field === 'channel' && /channel’s ID/.test(r.error), JSON.stringify(r));
  r = await call('sharing-save', { type: 'teams', fields: {}, secrets: { webhookUrl: TEAMS_URL } });
  check('save: Teams needs storage first', !r.ok && /Add storage first/.test(r.error), JSON.stringify(r));
  r = await call('sharing-save', { type: 'nope', fields: {}, secrets: {} });
  check('save: an unknown kind is refused', !r.ok, JSON.stringify(r));
  const s3 = await call('sharing-save', { type: 's3', name: '', fields: { endpoint: 'https://acct123.r2.cloudflarestorage.com', region: 'auto', bucket: 'team-shots' }, secrets: keys });
  check('save: S3-compatible storage (R2), presigned links for a day by default', s3.ok && s3.destination.name === 'team-shots'
    && s3.destination.fields.linkType === 'presigned' && s3.destination.fields.expiry === 86400, JSON.stringify(s3));
  check('save: pages get masks, not credentials', s3.ok && Object.values(s3.destination.secrets).every(v => v === '••••••••'), JSON.stringify(s3.destination?.secrets));
  const disk = fs.readFileSync(m.settingsFile, 'utf8');
  const stored = m.settings().sharing.destinations[0];
  check('at rest: settings.json has no credentials in it', SECRETS.every(x => !disk.includes(x)), SECRETS.filter(x => disk.includes(x)).join());
  check('at rest: they are kept as safeStorage ciphertext', JSON.stringify(JSON.parse(m.safeStorage.decryptString(Buffer.from(stored.secret, 'base64')))) === JSON.stringify(keys), stored.secret);
  check('save: every window is told', m.sent.some(x => x.channel === 'settings-changed' && x.args[0].sharing.destinations.length === 1));
  check('no network until a destination is tested or used', calls.length === 0, calls.join());

  // S3-compatible storage
  mock.log.length = 0;
  r = await call('sharing-test', { id: s3.destination.id });
  const testSteps = mock.log.map(x => `${x.method} ${x.path}`).join(', ');
  check('S3 test: signed PUT of a test file, its presigned link, then DELETE', r.ok && /presigned/.test(r.message)
    && testSteps === ['PUT', 'GET', 'DELETE'].map(verb => `${verb} /team-shots/jacks-picker-connection-test.txt`).join(', '), `${JSON.stringify(r)} ${testSteps}`);
  r = await call('sharing-test', { id: s3.destination.id, type: 's3', fields: s3.destination.fields, secrets: { secretAccessKey: 'wrong-secret' } });
  check('S3 test: a wrong secret key is named (the saved key ID is kept)', !r.ok && /secret access key doesn’t match/.test(r.error), JSON.stringify(r));
  r = await call('sharing-test', { type: 's3', fields: { ...s3.destination.fields, bucket: 'other-bucket' }, secrets: keys });
  check('S3 test: a missing bucket is named', !r.ok && /no bucket named “other-bucket”/.test(r.error) && r.field === 'bucket', JSON.stringify(r));
  r = await call('sharing-test', { type: 's3', fields: s3.destination.fields, secrets: { ...keys, accessKeyId: 'AKIAUNKNOWN' } });
  check('S3 test: an unknown access key is named', !r.ok && /didn’t recognize the access key ID/.test(r.error), JSON.stringify(r));

  const shot = addCapture(m, SHOT, { flat: true });
  mock.log.length = 0;
  r = await m.handle['sharing-send']({ sender: m.sender }, { id: s3.destination.id, filePath: shot.file, jobId: 'job-1' });
  m.returned.push(r);
  const put = mock.log.find(x => x.method === 'PUT');
  check('S3 send: uploads the annotated image (.flat.png)', r.ok && put?.body.equals(shot.sent) && put.headers['content-type'] === 'image/png', JSON.stringify(r));
  check('S3 send: into a random folder, keeping the name', /^\/team-shots\/[A-Za-z0-9_-]{12}\/screenshot-2026-09-28-13-49-02\.png$/.test(put?.path || ''), put?.path);
  check('S3 send: copies the presigned link', r.copied && m.clipboard.at(-1) === r.url && /X-Amz-Expires=86400/.test(r.url) && r.expires > Date.now(), JSON.stringify(r));
  const opened = await mockFetch(mock, [])(r.url);
  check('S3 send: the link opens the image, no credentials needed', opened.status === 200 && Buffer.from(await opened.arrayBuffer()).equals(shot.sent), opened.status);
  check('S3 send: progress reaches the page that asked', m.sent.some(x => x.channel === 'sharing-progress' && x.args[0].jobId === 'job-1' && x.args[0].text));
  const plain = addCapture(m, 'login-bug.png');
  mock.log.length = 0;
  r = await call('sharing-send', { id: s3.destination.id, filePath: plain.file });
  check('S3 send: without annotations, the capture itself', r.ok && mock.log.find(x => x.method === 'PUT')?.body.equals(plain.sent), JSON.stringify(r));
  const jpg = addCapture(m, 'photo.jpg');
  mock.log.length = 0;
  r = await call('sharing-send', { id: s3.destination.id, filePath: jpg.file });
  const jpgPut = mock.log.find(x => x.method === 'PUT');
  check('S3 send: a JPEG goes as image/jpeg', r.ok && jpgPut?.headers['content-type'] === 'image/jpeg' && /\/photo\.jpg$/.test(jpgPut.path), jpgPut?.path);

  const pub = await call('sharing-save', { type: 's3', name: 'Public shots', fields: { region: 'us-east-1', bucket: 'team-shots', prefix: 'shots', linkType: 'public', publicBaseUrl: 'cdn.acme.test/' }, secrets: keys });
  check('save: public links (base URL and folder tidied)', pub.ok && pub.destination.fields.publicBaseUrl === 'https://cdn.acme.test' && pub.destination.fields.prefix === 'shots/', JSON.stringify(pub));
  mock.log.length = 0;
  r = await call('sharing-test', { id: pub.destination.id });
  check('S3 test (public): AWS virtual-hosted upload, read back at the public URL', r.ok && mock.log.some(x => x.host === 'team-shots.s3.us-east-1.amazonaws.com' && x.method === 'PUT')
    && mock.log.some(x => x.host === 'cdn.acme.test'), `${JSON.stringify(r)} ${mock.log.map(x => x.host).join()}`);
  r = await call('sharing-send', { id: pub.destination.id, filePath: shot.file });
  check('S3 send (public): a lasting link under the base URL', r.ok && /^https:\/\/cdn\.acme\.test\/shots\/[A-Za-z0-9_-]{12}\/screenshot-2026-09-28-13-49-02\.png$/.test(r.url) && !r.expires, r.url);
  r = await call('sharing-test', { type: 's3', fields: { ...pub.destination.fields, publicBaseUrl: 'https://cdn.acme.test/wrong' }, secrets: keys });
  check('S3 test (public): a wrong public URL is caught', !r.ok && /public link didn’t/.test(r.error) && r.field === 'publicBaseUrl', JSON.stringify(r));

  // Slack
  const slack = await call('sharing-save', { type: 'slack', name: 'Design', fields: { channel: 'C0TESTCHAN' }, secrets: { token: CREDS.slack } });
  mock.log.length = 0;
  r = await call('sharing-test', { id: slack.destination.id });
  check('Slack test: auth.test, an upload URL, then a message, all with the bot token', r.ok && /Acme/.test(r.message)
    && mock.log.map(x => x.path).join() === '/api/auth.test,/api/files.getUploadURLExternal,/api/chat.postMessage'
    && mock.log.every(x => x.headers.authorization === `Bearer ${CREDS.slack}`), `${JSON.stringify(r)} ${mock.log.map(x => x.path)}`);
  mock.log.length = 0;
  r = await call('sharing-send', { id: slack.destination.id, filePath: shot.file, title: 'Checkout bug', message: 'Look at the total' });
  const [slot, upload, complete] = mock.log;
  const slotForm = new URLSearchParams(slot?.body.toString());
  const done = complete ? jsonBody(complete) : {};
  check('Slack send: asks for an upload URL with the name and size', slot?.path === '/api/files.getUploadURLExternal'
    && slotForm.get('filename') === SHOT && slotForm.get('length') === String(shot.sent.length), slot?.body.toString());
  check('Slack send: uploads the bytes there, without the token', upload?.host === 'files.slack.com' && upload.body.equals(shot.sent) && !upload.headers.authorization);
  check('Slack send: completes into the channel, with the message', complete?.path === '/api/files.completeUploadExternal' && /application\/json/.test(complete.headers['content-type'])
    && done.channel_id === 'C0TESTCHAN' && done.initial_comment === 'Look at the total' && done.files?.[0]?.id === 'F0TEST1234' && done.files[0].title === 'Checkout bug', complete?.body.toString());
  check('Slack send: returns the file’s link', r.ok && r.url === 'https://acme.slack.com/files/U1/F0TEST1234/screenshot.png' && r.label === 'Posted to Slack', JSON.stringify(r));
  const notIn = await call('sharing-save', { type: 'slack', fields: { channel: 'C0NOTINCHAN' }, secrets: { token: CREDS.slack } });
  r = await call('sharing-send', { id: notIn.destination.id, filePath: shot.file });
  check('Slack send: an app that isn’t in the channel is explained', !r.ok && /isn’t in that channel/.test(r.error) && r.field === 'channel', JSON.stringify(r));
  r = await call('sharing-test', { type: 'slack', fields: { channel: 'C0TESTCHAN' }, secrets: { token: 'xoxb-wrong' } });
  check('Slack test: a bad token is named', !r.ok && /didn’t accept the bot token/.test(r.error) && r.field === 'token', JSON.stringify(r));

  // Jira Cloud
  const jira = await call('sharing-save', { type: 'jira', fields: { siteUrl: 'acme.atlassian.net', email: CREDS.jiraEmail, projectKey: 'proj' }, secrets: { apiToken: CREDS.jira } });
  check('save: Jira (site and key tidied, Task by default)', jira.ok && jira.destination.fields.siteUrl === 'https://acme.atlassian.net'
    && jira.destination.fields.projectKey === 'PROJ' && jira.destination.fields.issueType === 'Task', JSON.stringify(jira));
  r = await call('sharing-test', { id: jira.destination.id });
  check('Jira test: signs in and finds the project', r.ok && /Dev Person/.test(r.message) && /Web Platform \(PROJ\)/.test(r.message), JSON.stringify(r));
  mock.log.length = 0;
  r = await call('sharing-send', { id: jira.destination.id, filePath: shot.file, title: 'Checkout total is wrong', description: 'Steps:\n1. Add an item\n\nExpected $10.' });
  const [create, attach] = mock.log;
  const fields = create ? jsonBody(create).fields : {};
  check('Jira send: creates the issue, description in ADF', create?.path === '/rest/api/3/issue' && create.headers.authorization === JIRA_AUTH
    && fields.project?.key === 'PROJ' && fields.summary === 'Checkout total is wrong' && fields.issuetype?.name === 'Task'
    && fields.description?.type === 'doc' && fields.description.content.length === 2 && fields.description.content[0].content.some(n => n.type === 'hardBreak'), create?.body.toString());
  const parts = attach ? parseMultipart(attach.body, attach.headers['content-type']) : [];
  check('Jira send: attaches the image (multipart, X-Atlassian-Token: no-check)', attach?.path === '/rest/api/3/issue/PROJ-7/attachments'
    && attach.headers['x-atlassian-token'] === 'no-check' && parts.length === 1 && parts[0].name === 'file' && parts[0].filename === SHOT
    && parts[0].type === 'image/png' && parts[0].data.equals(shot.sent), JSON.stringify(parts.map(p => ({ ...p, data: p.data.length }))));
  check('Jira send: returns the issue’s URL', r.ok && r.url === 'https://acme.atlassian.net/browse/PROJ-7' && r.label === 'Created PROJ-7', JSON.stringify(r));
  const jiraUrl = r.url;
  r = await call('sharing-test', { type: 'jira', fields: { ...jira.destination.fields, projectKey: 'NOPE' }, secrets: { apiToken: CREDS.jira } });
  check('Jira test: a missing project is named', !r.ok && /no project with the key NOPE/.test(r.error) && r.field === 'projectKey', JSON.stringify(r));
  r = await call('sharing-test', { id: jira.destination.id, type: 'jira', fields: { ...jira.destination.fields, issueType: 'Story' } });
  check('Jira test: an unknown issue type lists the real ones', !r.ok && /“Story” isn’t an issue type in PROJ\. It has: Task, Bug\./.test(r.error) && r.field === 'issueType', JSON.stringify(r));
  r = await call('sharing-test', { type: 'jira', fields: jira.destination.fields, secrets: { apiToken: 'wrong' } });
  check('Jira test: a bad token is named', !r.ok && /didn’t accept the email and API token/.test(r.error), JSON.stringify(r));

  // Linear
  const linear = await call('sharing-save', { type: 'linear', fields: { team: 'eng' }, secrets: { apiKey: CREDS.linear } });
  r = await call('sharing-test', { id: linear.destination.id });
  check('Linear test: signs in and finds the team by its key', r.ok && /Engineering \(ENG\)/.test(r.message), JSON.stringify(r));
  mock.log.length = 0;
  r = await call('sharing-send', { id: linear.destination.id, filePath: shot.file, title: 'Login button overlaps', description: 'On narrow windows.' });
  const gql = mock.log.filter(x => x.host === 'api.linear.app').map(jsonBody);
  const lUpload = mock.log.find(x => x.host === 'uploads.linear.app');
  check('Linear send: fileUpload with the type, name and size', gql[1]?.variables?.contentType === 'image/png' && gql[1].variables.filename === SHOT && gql[1].variables.size === shot.sent.length, JSON.stringify(gql[1]));
  check('Linear send: PUTs the image with the headers Linear returned', lUpload?.method === 'PUT' && lUpload.body.equals(shot.sent) && lUpload.headers['content-type'] === 'image/png'
    && lUpload.headers['x-goog-meta-origin'] === 'jacks-picker-test' && lUpload.headers['cache-control'] === 'public, max-age=31536000' && !lUpload.headers.authorization);
  check('Linear send: creates the issue with the image in its description', gql[2]?.variables?.input?.teamId === 'team-uuid-eng' && gql[2].variables.input.title === 'Login button overlaps'
    && gql[2].variables.input.description === `On narrow windows.\n\n![${SHOT}](https://uploads.linear.app/org1/abc123/shot.png)`
    && mock.log.filter(x => x.host === 'api.linear.app').every(x => x.headers.authorization === CREDS.linear), JSON.stringify(gql[2]));
  check('Linear send: returns the issue’s URL', r.ok && r.url === 'https://linear.app/acme/issue/ENG-42/login-button' && r.label === 'Created ENG-42', JSON.stringify(r));
  r = await call('sharing-test', { type: 'linear', fields: { team: 'ENG' }, secrets: { apiKey: 'lin_api_wrong' } });
  check('Linear test: a bad key is named', !r.ok && /didn’t accept the API key/.test(r.error) && r.field === 'apiKey', JSON.stringify(r));
  r = await call('sharing-test', { type: 'linear', fields: { team: 'Marketing' }, secrets: { apiKey: CREDS.linear } });
  check('Linear test: an unknown team is named', !r.ok && /team called “Marketing”/.test(r.error) && r.field === 'team', JSON.stringify(r));

  // Microsoft Teams and GitHub post a link from the storage
  const teams = await call('sharing-save', { type: 'teams', fields: {}, secrets: { webhookUrl: TEAMS_URL } });
  check('save: Teams, with its images going to the storage', teams.ok && teams.destination.available && teams.destination.storageName === 'team-shots', JSON.stringify(teams));
  mock.log.length = 0;
  r = await call('sharing-test', { id: teams.destination.id });
  check('Teams test: posts a text card to the workflow', r.ok && mock.log.length === 1 && /connected/.test(jsonBody(mock.log[0])?.attachments?.[0]?.content?.body?.[0]?.text), JSON.stringify(r));
  mock.log.length = 0;
  r = await call('sharing-send', { id: teams.destination.id, filePath: shot.file, message: 'New checkout screen' });
  const teamsPost = mock.log.find(x => x.host === 'prod-12.westus.logic.azure.com');
  const card = teamsPost ? jsonBody(teamsPost) : {};
  const content = card.attachments?.[0]?.content || {};
  check('Teams send: uploads to storage, then posts an Adaptive Card showing it', r.ok && mock.log[0]?.method === 'PUT' && mock.log[0].body.equals(shot.sent)
    && content.type === 'AdaptiveCard' && content.body?.[0]?.text === 'New checkout screen' && content.body[1]?.type === 'Image'
    && content.body[1].url === r.url && content.actions?.[0]?.url === r.url, JSON.stringify(card));
  check('Teams send: to the workflow URL exactly as given', teamsPost && parseQuery(teamsPost.url.search).sig === CREDS.teamsSig && teamsPost.path === '/workflows/0a1b2c/triggers/manual/paths/invoke');
  const gh = await call('sharing-save', { type: 'github', fields: { repo: 'https://github.com/acme/web.git' }, secrets: { token: CREDS.github } });
  check('save: GitHub (a pasted repository URL is fine)', gh.ok && gh.destination.fields.repo === 'acme/web', JSON.stringify(gh));
  mock.log.length = 0;
  r = await call('sharing-test', { id: gh.destination.id });
  check('GitHub test: finds the repository (token, API version, user agent)', r.ok && /acme\/web/.test(r.message), JSON.stringify(r));
  mock.log.length = 0;
  r = await call('sharing-send', { id: gh.destination.id, filePath: shot.file, title: 'Broken total', description: 'See below.' });
  const ghPost = mock.log.find(x => x.host === 'api.github.com');
  const ghIssue = ghPost ? jsonBody(ghPost) : {};
  check('GitHub send: an issue showing the image from storage, saying when the link expires', r.ok && ghPost?.path === '/repos/acme/web/issues' && ghIssue.title === 'Broken total'
    && ghIssue.body.startsWith(`See below.\n\n![${SHOT}](https://acct123.r2.cloudflarestorage.com/team-shots/`) && /link expires on/.test(ghIssue.body)
    && r.url === 'https://github.com/acme/web/issues/42', JSON.stringify(ghIssue));
  r = await call('sharing-test', { type: 'github', fields: { repo: 'acme/missing' }, secrets: { token: CREDS.github } });
  check('GitHub test: a repository the token can’t see is named', !r.ok && /can’t find acme\/missing/.test(r.error) && r.field === 'repo', JSON.stringify(r));
  r = await call('sharing-test', { type: 'github', fields: { repo: 'acme/web' }, secrets: { token: 'ghp_wrong' } });
  check('GitHub test: a bad token is named', !r.ok && /didn’t accept the token/.test(r.error) && r.field === 'token', JSON.stringify(r));

  // Network trouble
  const down = await call('sharing-save', { type: 's3', name: 'Down', fields: { endpoint: 'https://down.example.test', bucket: 'team-shots' }, secrets: keys });
  r = await call('sharing-test', { id: down.destination.id });
  check('network: a server that’s off is explained', !r.ok && /down\.example\.test refused the connection/.test(r.error), JSON.stringify(r));
  m.online = false;
  let before = calls.length;
  r = await call('sharing-send', { id: slack.destination.id, filePath: shot.file });
  check('network: offline is said plainly, without trying', !r.ok && /offline/.test(r.error) && calls.length === before, JSON.stringify(r));
  m.online = true;
  try {
    await createRequest({ fetch: mockFetch(mock, []), timeout: 300 })('https://slack.com/hang', { service: 'Slack' });
    check('network: a server that never answers times out', false, 'no error');
  } catch (err) {
    check('network: a server that never answers times out', /Slack didn’t answer in time/.test(err.message), err.message);
  }

  // Only screenshots in the captures folder; only links a send made
  const outside = path.join(m.tmp, 'elsewhere.png');
  fs.writeFileSync(outside, 'PNG');
  fs.writeFileSync(path.join(m.saveDir, 'clip.gif'), 'GIF89a');
  before = calls.length;
  for (const [what, filePath] of [['a file outside the captures folder', outside], ['a path that climbs out of it', path.join(m.saveDir, '..', '..', '..', 'elsewhere.png')],
    ['a GIF', path.join(m.saveDir, 'clip.gif')], ['a capture that’s gone', path.join(m.saveDir, 'gone.png')], ['no path', undefined]]) {
    r = await call('sharing-send', { id: s3.destination.id, filePath });
    check(`send: refuses ${what}`, !r.ok && /Only screenshots in the captures folder/.test(r.error), JSON.stringify(r));
  }
  check('send: refused paths never reach the network', calls.length === before);
  m.on['sharing-link']({}, { url: 'https://evil.example/', action: 'open' });
  m.on['sharing-link']({}, { url: jiraUrl, action: 'open' });
  m.on['sharing-link']({}, { url: jiraUrl, action: 'copy' });
  m.on['sharing-link']({}, null);
  check('links: Open works only for links a send produced', m.opened.join() === jiraUrl, m.opened.join());
  check('links: Copy Link copies it', m.clipboard.at(-1) === jiraUrl);

  // Credentials that can't be read (settings.json from another Mac), and no Keychain
  const raw = m.settings();
  raw.sharing.destinations.find(d => d.id === linear.destination.id).secret = Buffer.from('not ours').toString('base64');
  fs.writeFileSync(m.settingsFile, JSON.stringify(raw));
  r = await call('sharing-send', { id: linear.destination.id, filePath: shot.file });
  check('at rest: unreadable credentials ask to be entered again', !r.ok && /can’t be read on this Mac/.test(r.error), JSON.stringify(r));
  m.encryption = false;
  r = await call('sharing-save', { type: 'slack', fields: { channel: 'C0TESTCHAN' }, secrets: { token: CREDS.slack } });
  check('at rest: without the Keychain nothing is saved', !r.ok && /Keychain/.test(r.error), JSON.stringify(r));
  m.encryption = true;

  // Removing, and what depends on storage
  const count = m.settings().sharing.destinations.length;
  for (const d of [s3, pub, down]) await call('sharing-remove', d.destination.id);
  s = await call('settings-get');
  check('remove: gone from settings.json', m.settings().sharing.destinations.length === count - 3 && !m.settings().sharing.destinations.some(d => d.type === 's3'));
  check('remove: Teams and GitHub without storage are marked unavailable', s.sharing.destinations.filter(d => d.needsStorage).every(d => d.available === false), JSON.stringify(s.sharing.destinations.map(d => [d.type, d.available])));
  r = await call('sharing-send', { id: teams.destination.id, filePath: shot.file });
  check('send: Teams without storage says what to add', !r.ok && /needs S3-compatible storage/.test(r.error), JSON.stringify(r));
  await call('settings-set', { appearance: { theme: 'light' } });
  check('settings: other changes keep the destinations', m.settings().sharing.destinations.length === count - 3 && m.settings().appearance.theme === 'light');

  // IT's switch (a managed DisableSharing preference)
  if (process.platform === 'darwin') {
    m.sharingDisabled = true;
    before = calls.length;
    s = await call('settings-get');
    check('IT switch: pages are told sharing is off, with no destinations', s.sharing.allowed === false && s.sharing.destinations.length === 0, JSON.stringify(s.sharing));
    const refused = [
      await call('sharing-save', { type: 'slack', fields: { channel: 'C0TESTCHAN' }, secrets: { token: CREDS.slack } }),
      await call('sharing-test', { id: slack.destination.id }),
      await call('sharing-send', { id: slack.destination.id, filePath: shot.file }),
      await call('sharing-remove', slack.destination.id),
    ];
    check('IT switch: every sharing entry point refuses', refused.every(x => !x.ok && /turned off/.test(x.error)), JSON.stringify(refused));
    m.on['sharing-link']({}, { url: jiraUrl, action: 'open' });
    check('IT switch: nothing is sent or opened', calls.length === before && m.opened.length === 1);
    check('IT switch: saved destinations stay for when it’s back on', m.settings().sharing.destinations.length === count - 3);
    m.sharingDisabled = false;
  }

  // What pages saw, and what was logged
  const toPages = JSON.stringify([m.returned, m.sent]);
  check('pages never receive a credential', leaks(toPages).length === 0, leaks(toPages).join());
  const log = m.log();
  check('failures are logged', /Sharing: send to Slack “Slack C0NOTINCHAN”: The Slack app isn’t in that channel/.test(log) && /Sharing: test S3-compatible storage “Down”/.test(log), log.slice(0, 600));
  check('the log has no credentials or signed URLs', leaks(log).length === 0 && !log.includes(CREDS.accessKeyId) && !/X-Amz-Signature=|sig=/.test(log), leaks(log).join());
}

// ── 4. The pages (Electron only): Settings → Sharing and the editor's Send to… ──
async function uiTests(mock) {
  const { BrowserWindow, ipcMain, nativeImage, net } = electron;
  let page = null;
  const calls = [];
  const m = loadMain({
    fetch: mockFetch(mock, calls, (url, init) => net.fetch(url, init)),   // Chromium's network stack, as in the app
    nativeImage,
    forward: (channel, ...args) => { if (page && !page.isDestroyed()) page.webContents.send(channel, ...args); },
  });
  const shotPath = path.join(m.saveDir, SHOT);
  fs.writeFileSync(shotPath, nativeImage.createFromBitmap(Buffer.alloc(80 * 50 * 4, 0xc8), { width: 80, height: 50 }).toPNG());

  // The page talks to main.js's real handlers for settings, sharing, the gallery and annotations.
  const real = ['settings-get', 'settings-set', 'sharing-save', 'sharing-remove', 'sharing-test', 'sharing-send', 'gallery-list', 'gallery-load', 'annotation-save-now'];
  real.forEach(channel => ipcMain.handle(channel, m.handle[channel]));
  ['sharing-link', 'annotation-save'].forEach(channel => ipcMain.on(channel, m.on[channel]));
  const stubs = { 'app-info': { version: '1.0.0', packaged: false, buildTime: null }, 'project-folders': {}, 'project-folder-list': { items: [] }, 'media-list': [] };
  const preload = fs.readFileSync(path.join(ROOT, 'preload.cjs'), 'utf8');
  new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map(x => x[1])).forEach(channel => {
    if (!real.includes(channel)) ipcMain.handle(channel, () => stubs[channel] ?? null);
  });

  const errors = [];
  page = new BrowserWindow({
    show: false, width: 1300, height: 850,
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, offscreen: true, partition: `sharing-ui-${Date.now()}` },
  });
  page.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await page.loadFile(path.join(ROOT, 'src', 'editor.html'));
  const js = code => page.webContents.executeJavaScript(code);
  const until = async (code, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(60)) if (await js(code).catch(() => false)) return true;
    return false;
  };
  const clickIn = (scope, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (b) b.click(); return !!b; })()`);
  const fill = (key, value) => js(`(() => { const i = document.querySelector('.settings-box [data-field="${key}"]'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const rowId = name => js(`[...document.querySelectorAll('.jp-share-row')].find(r => r.querySelector('.jp-share-name').firstChild.textContent === ${JSON.stringify(name)})?.dataset.id || null`);
  const status = () => js(`document.querySelector('.settings-box .jp-share-status')?.className + ' ' + document.querySelector('.settings-box .jp-share-status')?.textContent`);

  check('UI: sharing is on, and Export has Send to…', await until('!!window.JPSharing && JPSharing.available()') && await js(`!document.getElementById('btn-send-to').hidden`));

  // Settings → Sharing: add storage (tested before saving)
  await js(`JPSettings.open('sharing'); true`);
  check('UI: Settings has a Sharing section, empty to start', await until(`!!document.querySelector('.jp-share-empty')`)
    && (await js(`[...document.querySelectorAll('.sp-nav button')].map(b => b.textContent).join('|')`)) === 'Appearance|Annotations|Brand|Capture|Recording|Storage|Sharing');
  await clickIn('.settings-box', 'Add Destination…');
  check('UI: Teams and GitHub wait for storage', await js(`['teams', 'github'].every(t => document.querySelector('.jp-share-kind-card[data-type="' + t + '"]').disabled) && !document.querySelector('.jp-share-kind-card[data-type="slack"]').disabled`));
  await js(`document.querySelector('.jp-share-kind-card[data-type="s3"]').click(); true`);
  for (const [key, value] of [['endpoint', 'https://acct123.r2.cloudflarestorage.com'], ['region', 'auto'], ['bucket', 'team-shots'], ['accessKeyId', CREDS.accessKeyId], ['secretAccessKey', CREDS.secretAccessKey]]) await fill(key, value);
  await clickIn('.settings-box', 'Test Connection');
  await until(`!!document.querySelector('.settings-box .jp-share-status.ok, .settings-box .jp-share-status.warn')`);
  check('UI: Test Connection works before saving', /\bok\b.*Connected/.test(await status()), await status());
  await clickIn('.settings-box', 'Save');
  check('UI: Save lists it and says so', await until(`!!document.querySelector('.jp-share-row')`) && /Saved “team-shots”/.test(await js(`document.querySelector('.sp-notice')?.textContent`)));

  // Add Jira, then edit it: the saved token stays unless retyped
  await clickIn('.settings-box', 'Add Destination…');
  await js(`document.querySelector('.jp-share-kind-card[data-type="jira"]').click(); true`);
  for (const [key, value] of [['siteUrl', 'https://acme.atlassian.net'], ['email', CREDS.jiraEmail], ['apiToken', CREDS.jira], ['projectKey', 'PROJ']]) await fill(key, value);
  await clickIn('.settings-box', 'Save');
  await until(`document.querySelectorAll('.jp-share-row').length === 2`);
  const jiraId = await rowId('Jira PROJ');
  await clickIn(`.jp-share-row[data-id="${jiraId}"]`, 'Edit');
  check('UI: editing shows a saved token as an empty field', await js(`(i => !!i && i.value === '' && /Saved/.test(i.placeholder))(document.querySelector('[data-field="apiToken"]'))`));
  await fill('issueType', 'Bug');
  await clickIn('.settings-box', 'Save');
  await until(`[...document.querySelectorAll('.jp-share-row')].some(r => r.textContent.includes('· Bug'))`);
  await clickIn(`.jp-share-row[data-id="${jiraId}"]`, 'Test');
  await until(`!!document.querySelector('.jp-share-row[data-id="${jiraId}"] .jp-share-status:not(.busy)')`);
  check('UI: after the edit the saved token still works (Test in the list)', await js(`document.querySelector('.jp-share-row[data-id="${jiraId}"] .jp-share-status.ok')?.textContent || ''`), await status());

  // Add Slack, then remove it
  await clickIn('.settings-box', 'Add Destination…');
  await js(`document.querySelector('.jp-share-kind-card[data-type="slack"]').click(); true`);
  await fill('token', CREDS.slack);
  await fill('channel', 'C0TESTCHAN');
  await clickIn('.settings-box', 'Save');
  await until(`document.querySelectorAll('.jp-share-row').length === 3`);
  const slackId = await rowId('Slack C0TESTCHAN');
  await clickIn(`.jp-share-row[data-id="${slackId}"]`, 'Remove');
  const asked = await js(`document.querySelector('.settings-box .sp-prompt p')?.textContent`);
  await clickIn('.settings-box .sp-prompt', 'Remove');
  check('UI: Remove asks first, then deletes it with its credentials', asked === 'Remove “Slack C0TESTCHAN”?' && await until(`document.querySelectorAll('.jp-share-row').length === 2`)
    && !m.settings().sharing.destinations.some(d => d.type === 'slack'), asked);
  await clickIn('.settings-box', 'Add Destination…');
  check('UI: with storage, Teams and GitHub can be added', await js(`!document.querySelector('.jp-share-kind-card[data-type="teams"]').disabled`));
  await clickIn('.settings-box', 'Cancel');
  check('UI: no credential stays in the page', leaks(await js('document.documentElement.outerHTML')).length === 0);
  await js('JPSettings.close(); true');

  // Export → Send to… → storage: the annotated image is uploaded and its link copied
  await js(`openGalleryItem(${JSON.stringify(shotPath)}).then(() => true)`);
  await until(`currentPath === ${JSON.stringify(shotPath)} && !!bgImage && bgImage.complete`);
  await js(`anns.push({ type: 'box', x: 6, y: 6, w: 40, h: 24, color: '#EF4444', sw: 4 }); render(); true`);
  mock.log.length = 0;
  await js(`document.querySelector('.toolbar-menu').open = true; document.getElementById('btn-send-to').click(); true`);
  await until(`!!document.querySelector('.jp-send-menu')`);
  const listed = await js(`[...document.querySelectorAll('.jp-send-menu .jp-send-item')].map(b => b.querySelector('.jp-send-name').textContent + ':' + b.querySelector('.jp-send-kind').textContent).join('|')`);
  check('UI: Export → Send to… lists the destinations', listed === 'team-shots:Copy Link|Jira PROJ:Jira Cloud', listed);
  await js(`[...document.querySelectorAll('.jp-send-menu .jp-send-item')].find(b => b.textContent.includes('team-shots')).click(); true`);
  await until(`/Link copied/.test(document.querySelector('.jp-send-toast.ok')?.textContent || '')`);
  const flatFile = path.join(m.saveDir, '.annotations', SHOT.replace('.png', '.flat.png'));
  const put = mock.log.find(x => x.method === 'PUT');
  check('UI: Copy Link uploads the annotated image and copies its link', fs.existsSync(flatFile) && put?.body.equals(fs.readFileSync(flatFile))
    && !put.body.equals(fs.readFileSync(shotPath)) && /X-Amz-Signature=/.test(m.clipboard.at(-1) || ''), `${put?.path} ${m.clipboard.at(-1)}`);
  check('UI: the Export menu closed', !(await js(`document.querySelector('.toolbar-menu').open`)));
  await clickIn('.jp-send-toast', 'Open');
  await wait(150);
  check('UI: Open opens the link', m.opened.at(-1) === m.clipboard.at(-1));

  // Right-click → Send to… → Jira: a form prefilled from the capture
  await js(`showGalleryContext(galleryItemsByPath.get(${JSON.stringify(shotPath)}), 60, 140); true`);
  const offered = await js(`[...document.querySelectorAll('#gallery-context button')].some(b => b.textContent === 'Send to…')`);
  await js(`[...document.querySelectorAll('#gallery-context button')].find(b => b.textContent === 'Send to…')?.click(); true`);
  check('UI: right-clicking a capture offers Send to…, and the menu stays up for it', offered && await until(`!!document.querySelector('.jp-send-menu')`)
    && await js(`document.getElementById('gallery-context').style.display === 'block'`));
  await js(`[...document.querySelectorAll('.jp-send-menu .jp-send-item')].find(b => b.textContent.includes('Jira PROJ')).click(); true`);
  await until(`!!document.querySelector('.jp-send-backdrop')`);
  const title = await js(`document.querySelector('.jp-send-backdrop input').value`);
  const description = await js(`document.querySelector('.jp-send-backdrop textarea').value`);
  check('UI: the issue form is prefilled from the capture', /^Screenshot .*2026/.test(title) && /^Captured .*2026/.test(description), `${title} / ${description}`);
  const toolBefore = await js(`document.querySelector('.tbtn.active')?.dataset.tool`);
  await js(`document.querySelector('.jp-send-backdrop textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); true`);
  check('UI: typing in the form doesn’t reach the editor’s shortcuts', (await js(`document.querySelector('.tbtn.active')?.dataset.tool`)) === toolBefore, toolBefore);
  await js(`(i => { i.value = 'Login button overlaps'; })(document.querySelector('.jp-send-backdrop input')); true`);
  mock.log.length = 0;
  await clickIn('.jp-send-backdrop', 'Create Issue');
  await until(`/PROJ-7/.test(document.querySelector('.jp-send-toast.ok')?.textContent || '')`);
  const created = mock.log.find(x => x.path === '/rest/api/3/issue');
  const attached = mock.log.find(x => x.path === '/rest/api/3/issue/PROJ-7/attachments');
  check('UI: the issue is created as a Bug, with the image attached', jsonBody(created || { body: Buffer.from('') })?.fields?.summary === 'Login button overlaps'
    && jsonBody(created).fields.issuetype.name === 'Bug' && parseMultipart(attached?.body || Buffer.alloc(0), attached?.headers['content-type'])[0]?.data.equals(fs.readFileSync(flatFile)));
  await clickIn('.jp-send-toast', 'Copy Link');
  await wait(150);
  check('UI: Copy Link copies the issue’s URL', m.clipboard.at(-1) === 'https://acme.atlassian.net/browse/PROJ-7', m.clipboard.at(-1));
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); true`);
  check('UI: (control) the same key outside the form picks the Box tool', (await js(`document.querySelector('.tbtn.active')?.dataset.tool`)) === 'box');
  await js(`setTool(${JSON.stringify(toolBefore)}); true`);

  // A failure explains itself and offers Settings
  await m.call('sharing-save', { type: 'github', fields: { repo: 'acme/missing' }, secrets: { token: CREDS.github } });
  await wait(300);   // main's broadcast reaches the page
  await js(`showGalleryContext(galleryItemsByPath.get(${JSON.stringify(shotPath)}), 60, 140); [...document.querySelectorAll('#gallery-context button')].find(b => b.textContent === 'Send to…').click(); true`);
  await until(`[...document.querySelectorAll('.jp-send-menu .jp-send-item')].some(b => b.textContent.includes('GitHub acme/missing'))`);
  await js(`[...document.querySelectorAll('.jp-send-menu .jp-send-item')].find(b => b.textContent.includes('GitHub acme/missing')).click(); true`);
  await until(`!!document.querySelector('.jp-send-backdrop')`);
  await clickIn('.jp-send-backdrop', 'Create Issue');
  await until(`!!document.querySelector('.jp-send-toast.error')`);
  const failure = await js(`document.querySelector('.jp-send-toast.error')?.textContent || ''`);
  check('UI: a failed send says why, with a way to fix it', /Couldn’t send to GitHub acme\/missing/.test(failure) && /can’t find acme\/missing/.test(failure) && /Settings…/.test(failure), failure);

  // IT turns sharing off: every trace of it goes from the pages
  m.sharingDisabled = true;
  await js('window.electronAPI.settingsSet({}).then(() => true)');   // any change re-broadcasts the settings
  await until('!JPSharing.available()');
  await js(`showGalleryContext(galleryItemsByPath.get(${JSON.stringify(shotPath)}), 60, 140); true`);
  const menuHasSend = await js(`[...document.querySelectorAll('#gallery-context button')].some(b => b.textContent === 'Send to…')`);
  await js(`hideGalleryContext(); JPSettings.open('sharing'); true`);
  await wait(300);
  check('UI: when IT turns sharing off, Send to… and the Sharing settings disappear', await js(`document.getElementById('btn-send-to').hidden`) && !menuHasSend
    && !(await js(`[...document.querySelectorAll('.sp-nav button')].some(b => b.textContent === 'Sharing')`)) && (await js(`document.querySelector('.sp-body h2').textContent`)) === 'Appearance');
  m.sharingDisabled = false;

  check('UI: pages never receive a credential', leaks(JSON.stringify(m.sent)).length === 0 && leaks(await js('document.documentElement.outerHTML')).length === 0);
  check('UI: no page errors', errors.length === 0, JSON.stringify(errors));
  page.destroy();
}

async function run() {
  let mock = null;
  try {
    sigv4Vectors();
    mock = await startMock();
    await mainProcessTests(mock);
    if (IN_ELECTRON) await uiTests(mock);
  } catch (err) {
    check('harness ran to completion', false, err.stack);
  }
  mock?.server.closeAllConnections();
  mock?.server.close();
  const failed = results.filter(r => !r.ok).length;
  const report = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`).join('\n')
    + `\n\n${IN_ELECTRON ? '' : '(UI tests skipped: run under Electron for those)\n'}${failed ? 'FAILED' : 'PASSED'}: ${results.length - failed} passed, ${failed} failed`;
  fs.writeFileSync(REPORT, `${report}\n`);
  console.log(report);
  return failed;
}

if (IN_ELECTRON) {
  electron.app.on('window-all-closed', () => {});
  electron.app.whenReady().then(run).then(failed => electron.app.exit(failed ? 1 : 0));
} else {
  run().then(failed => process.exit(failed ? 1 : 0));
}
