// Linear: uploads the capture (the fileUpload mutation, then a PUT to the signed URL it returns)
// and creates an issue with the image in its description (issueCreate). Uses a personal API key.
const { SharingError } = require('./http.cjs');

const API = 'https://api.linear.app/graphql';
const SERVICE = 'Linear';
const trim = v => String(v ?? '').trim();

function clean(raw) {
  const team = trim(raw.team);
  if (!team) throw new SharingError('Enter the team’s key (like ENG) or name.', { field: 'team' });
  return { team: team.slice(0, 80) };
}

function checkSecrets(secrets) {
  if (!trim(secrets.apiKey)) throw new SharingError('Enter a personal API key (Linear → Settings → Security & access).', { field: 'apiKey' });
}

const AUTH_MESSAGE = 'Linear didn’t accept the API key. Create a new one in Linear → Settings → Security & access → Personal API keys.';

async function gql(ctx, query, variables = {}) {
  const res = await ctx.request(API, {
    method: 'POST', service: SERVICE,
    headers: { Authorization: trim(ctx.secrets.apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const error = res.json?.errors?.[0];
  if (res.status === 401 || error?.extensions?.code === 'AUTHENTICATION_ERROR' || /authenticat/i.test(error?.extensions?.type || '')) {
    throw new SharingError(AUTH_MESSAGE, { status: res.status, field: 'apiKey', detail: error?.message });
  }
  if (res.status === 429 || error?.extensions?.code === 'RATELIMITED') throw new SharingError('Linear is limiting requests right now. Try again in a minute.', { status: res.status });
  if (res.status >= 500) throw new SharingError(`Linear is having trouble (HTTP ${res.status}). Try again later.`, { status: res.status });
  if (error) throw new SharingError(`Linear couldn’t do that: ${error.extensions?.userPresentableMessage || error.message}`, { status: res.status, detail: error.message });
  if (!res.ok || !res.json?.data) throw new SharingError(`Linear returned an unexpected answer (HTTP ${res.status}).`, { status: res.status });
  return res.json.data;
}

// The team can be given by key (ENG), name or id.
async function findTeam(ctx) {
  const data = await gql(ctx, 'query Teams { teams(first: 250) { nodes { id key name } } }');
  const want = ctx.fields.team.toLowerCase();
  const team = (data.teams?.nodes || []).find(t => [t.key, t.name, t.id].some(v => String(v || '').toLowerCase() === want));
  if (!team) throw new SharingError(`This API key can’t see a Linear team called “${ctx.fields.team}”. Use the team’s key (like ENG) or its name.`, { field: 'team' });
  return team;
}

async function test(ctx) {
  const me = await gql(ctx, 'query Me { viewer { name } organization { name } }');
  const team = await findTeam(ctx);
  return { message: `Connected to ${me.organization?.name || 'Linear'} as ${me.viewer?.name || 'you'}. New issues go to ${team.name} (${team.key}).` };
}

async function send(ctx, image, input) {
  const team = await findTeam(ctx);
  ctx.progress('Uploading the image to Linear…');
  const data = await gql(ctx, `mutation Upload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } }
  }`, { contentType: image.contentType, filename: image.filename, size: image.bytes.length });
  const file = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !/^https:\/\//.test(file?.uploadUrl || '') || !file.assetUrl) throw new SharingError('Linear didn’t return an upload address.');
  const headers = { 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=31536000' };
  for (const { key, value } of file.headers || []) headers[key] = value;
  const put = await ctx.request(file.uploadUrl, { method: 'PUT', headers, body: image.bytes, timeout: 120_000, service: SERVICE });
  if (!put.ok) throw new SharingError(`Linear’s storage didn’t accept the upload (HTTP ${put.status}).`, { status: put.status });
  ctx.progress('Creating the Linear issue…');
  const created = await gql(ctx, `mutation Create($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { identifier url } }
  }`, { input: {
    teamId: team.id,
    title: input.title,
    description: [input.description, `![${image.filename}](${file.assetUrl})`].filter(Boolean).join('\n\n'),
  } });
  const issue = created.issueCreate?.issue;
  if (!created.issueCreate?.success || !issue?.url) throw new SharingError('Linear didn’t create the issue.');
  return { url: issue.url, label: `Created ${issue.identifier}` };
}

module.exports = {
  type: 'linear', label: 'Linear', secretKeys: ['apiKey'], form: 'issue', needsStorage: false,
  defaultName: fields => `Linear ${fields.team}`,
  clean, checkSecrets, summary: fields => `Team ${fields.team}`, test, send,
};
