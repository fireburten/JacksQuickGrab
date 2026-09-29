// GitHub issues. The REST API can't attach an image to an issue, so the capture goes to
// S3-compatible storage and the issue body shows it from there. Needs a token that can write
// issues in the repository (fine-grained: Issues read and write).
const { SharingError } = require('./http.cjs');

const API = 'https://api.github.com';
const SERVICE = 'GitHub';
const trim = v => String(v ?? '').trim();

function clean(raw) {
  // Also accepts a pasted repository URL.
  const repo = trim(raw.repo).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw new SharingError('Enter the repository as owner/name, like acme/website.', { field: 'repo' });
  }
  return { repo, storageId: trim(raw.storageId).slice(0, 40) };
}

function checkSecrets(secrets) {
  if (!trim(secrets.token)) throw new SharingError('Enter a GitHub token that can write issues in this repository.', { field: 'token' });
}

function githubError(res, repo) {
  const detail = `${res.status} ${res.json?.message || ''}`;
  const make = (message, field) => new SharingError(message, { status: res.status, field, detail });
  if (res.status === 401) return make('GitHub didn’t accept the token. It may have expired; create a new one with Issues: Read and write.', 'token');
  if ((res.status === 403 || res.status === 429) && (res.headers?.get?.('x-ratelimit-remaining') === '0' || /rate limit/i.test(res.json?.message || ''))) {
    return make('GitHub’s rate limit was reached. Try again in a few minutes.');
  }
  if (res.status === 403) return make(`The token can’t create issues in ${repo}. Give it Issues: Read and write for this repository.`, 'token');
  if (res.status === 404) return make(`GitHub can’t find ${repo} with this token. Check the name, and that the token can access the repository.`, 'repo');
  if (res.status === 410) return make(`Issues are turned off for ${repo}.`, 'repo');
  if (res.status >= 500) return make(`GitHub is having trouble (HTTP ${res.status}). Try again later.`);
  return make(`GitHub couldn’t do that: ${res.json?.message || `HTTP ${res.status}`}`);
}

async function api(ctx, path, { method = 'GET', json } = {}) {
  const res = await ctx.request(`${API}${path}`, {
    method, service: SERVICE,
    headers: {
      Authorization: `Bearer ${trim(ctx.secrets.token)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'JacksPicker',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (!res.ok || !res.json) throw githubError(res, ctx.fields.repo);
  return res.json;
}

const repoPath = repo => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;

async function test(ctx) {
  const repo = await api(ctx, repoPath(ctx.fields.repo));
  if (repo.has_issues === false) throw new SharingError(`Issues are turned off for ${repo.full_name}.`, { field: 'repo' });
  return { message: `Connected. New issues go to ${repo.full_name}.` };
}

async function send(ctx, image, input) {
  ctx.progress('Uploading the image…');
  const link = await ctx.storage.upload(image);
  // A presigned link stops working when it expires; the issue says so, so a broken image later isn't a mystery.
  const note = link.expires ? `\n<sub>This image link expires on ${new Date(link.expires).toUTCString().slice(0, 16)}.</sub>` : '';
  ctx.progress('Creating the GitHub issue…');
  const issue = await api(ctx, `${repoPath(ctx.fields.repo)}/issues`, {
    method: 'POST',
    json: { title: input.title, body: [input.description, `![${image.filename}](${link.url})${note}`].filter(Boolean).join('\n\n') },
  });
  return { url: issue.html_url, label: `Created issue #${issue.number}` };
}

module.exports = {
  type: 'github', label: 'GitHub Issues', secretKeys: ['token'], form: 'issue', needsStorage: true,
  defaultName: fields => `GitHub ${fields.repo}`,
  clean, checkSecrets, summary: fields => `${fields.repo} · image links from storage`, test, send,
};
