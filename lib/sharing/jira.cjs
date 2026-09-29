// Jira Cloud: creates an issue (POST /rest/api/3/issue) and attaches the capture to it
// (POST /rest/api/3/issue/{key}/attachments). Signs in with the account email and an API token.
const { SharingError, multipart } = require('./http.cjs');

const SERVICE = 'Jira';
const trim = v => String(v ?? '').trim();

function clean(raw) {
  const site = trim(raw.siteUrl);
  if (!site) throw new SharingError('Enter your Jira site, like https://your-team.atlassian.net.', { field: 'siteUrl' });
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new SharingError('Enter your Jira site as an https:// address, like https://your-team.atlassian.net.', { field: 'siteUrl' });
  const email = trim(raw.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new SharingError('Enter the email address of your Atlassian account.', { field: 'email' });
  const projectKey = trim(raw.projectKey).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(projectKey)) throw new SharingError('Enter the project key, like PROJ (it starts every issue number, e.g. PROJ-12).', { field: 'projectKey' });
  const issueType = trim(raw.issueType) || 'Task';
  return { siteUrl: url.origin, email, projectKey, issueType: issueType.slice(0, 60) };
}

function checkSecrets(secrets) {
  if (!trim(secrets.apiToken)) throw new SharingError('Enter an API token (id.atlassian.com → Security → API tokens).', { field: 'apiToken' });
}

// Atlassian Document Format: blank lines split paragraphs, single newlines become line breaks.
function adf(text) {
  return {
    type: 'doc', version: 1,
    content: text.split(/\n{2,}/).map(block => ({
      type: 'paragraph',
      content: block.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
  };
}

function jiraError(res, fields, context) {
  const errors = res.json?.errors || {};
  const listed = [...(res.json?.errorMessages || []), ...Object.values(errors)].filter(Boolean).join(' ');
  const key = fields.projectKey;
  let message, field;
  if (res.status === 401) { message = 'Jira didn’t accept the email and API token. Check both, or create a new token at id.atlassian.com → Security → API tokens.'; field = 'apiToken'; }
  else if (res.status === 403 && /AUTHENTICATION_DENIED/i.test(res.headers?.get?.('x-seraph-loginreason') || '')) message = 'Jira has paused sign-ins for this account after failed attempts. Sign in to Jira in a browser once, then try again.';
  else if (res.status === 403) message = `Your Jira account doesn’t have permission to do this in ${key}.`;
  else if (res.status === 404 && context === 'project') { message = `Jira has no project with the key ${key} (or your account can’t see it).`; field = 'projectKey'; }
  else if (res.status === 404) { message = 'Jira couldn’t find that. Check the site address.'; field = 'siteUrl'; }
  else if (res.status === 413) message = 'The image is bigger than this Jira site allows for attachments.';
  else if (res.status === 429) message = 'Jira is limiting requests right now. Try again in a minute.';
  else if (res.status >= 500) message = `Jira is having trouble (HTTP ${res.status}). Try again later.`;
  else if (errors.project) { message = `Jira has no project with the key ${key} that you can create issues in.`; field = 'projectKey'; }
  else if (errors.issuetype) { message = `“${fields.issueType}” isn’t an issue type in ${key}. Check the name (for example Task or Bug).`; field = 'issueType'; }
  else if (res.status >= 300 && res.status < 400) { message = 'That address redirected elsewhere. Enter your Jira Cloud site, like https://your-team.atlassian.net.'; field = 'siteUrl'; }
  else if (!res.json) { message = 'That doesn’t look like a Jira Cloud site. Check the address (like https://your-team.atlassian.net).'; field = 'siteUrl'; }
  return new SharingError(message || `Jira couldn’t do that: ${listed || `HTTP ${res.status}`}`, { status: res.status, field, detail: `${res.status} ${listed}` });
}

async function api(ctx, path, { method = 'GET', json, body, headers = {}, context, timeout } = {}) {
  const { siteUrl, email } = ctx.fields;
  const res = await ctx.request(`${siteUrl}${path}`, {
    method, timeout, service: SERVICE,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${trim(ctx.secrets.apiToken)}`).toString('base64')}`,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  if (!res.ok || (res.status !== 204 && res.json === undefined)) throw jiraError(res, ctx.fields, context);
  return res.json;
}

async function test(ctx) {
  const { projectKey, issueType } = ctx.fields;
  const me = await api(ctx, '/rest/api/3/myself');
  const project = await api(ctx, `/rest/api/3/project/${encodeURIComponent(projectKey)}`, { context: 'project' });
  const types = (project.issueTypes || []).map(t => t.name).filter(Boolean);
  if (types.length && !types.some(name => name.toLowerCase() === issueType.toLowerCase())) {
    throw new SharingError(`“${issueType}” isn’t an issue type in ${projectKey}. It has: ${types.join(', ')}.`, { field: 'issueType' });
  }
  return { message: `Connected as ${me.displayName || me.emailAddress || ctx.fields.email}. New issues go to ${project.name || projectKey} (${projectKey}) as ${issueType}.` };
}

async function send(ctx, image, input) {
  const { siteUrl, projectKey, issueType } = ctx.fields;
  ctx.progress('Creating the Jira issue…');
  const created = await api(ctx, '/rest/api/3/issue', {
    method: 'POST', context: 'create',
    json: { fields: {
      project: { key: projectKey },
      summary: input.title.slice(0, 255),
      issuetype: { name: issueType },
      ...(input.description ? { description: adf(input.description) } : {}),
    } },
  });
  const url = `${siteUrl}/browse/${created.key}`;
  ctx.progress(`Attaching the image to ${created.key}…`);
  const form = multipart([{ name: 'file', filename: image.filename, contentType: image.contentType, data: image.bytes }]);
  try {
    await api(ctx, `/rest/api/3/issue/${encodeURIComponent(created.key)}/attachments`, {
      method: 'POST', timeout: 120_000,
      headers: { 'X-Atlassian-Token': 'no-check', 'Content-Type': form.contentType },
      body: form.body,
    });
  } catch (err) {
    // The issue exists already; say so, and let the person open it.
    throw new SharingError(`Created ${created.key}, but the image couldn’t be attached: ${err.message}`, { ...err, url });
  }
  return { url, label: `Created ${created.key}` };
}

module.exports = {
  type: 'jira', label: 'Jira Cloud', secretKeys: ['apiToken'], form: 'issue', needsStorage: false,
  defaultName: fields => `Jira ${fields.projectKey}`,
  clean, checkSecrets, summary: fields => `${fields.projectKey} on ${new URL(fields.siteUrl).host} · ${fields.issueType}`, test, send, adf,
};
