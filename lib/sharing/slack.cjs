// Slack: posts the capture to a channel with Slack's upload flow (files.getUploadURLExternal,
// the bytes to the URL it returns, then files.completeUploadExternal), with an optional message.
// Needs a bot token (xoxb-) with files:write and chat:write, and the app invited to the channel.
const { SharingError } = require('./http.cjs');

const API = 'https://slack.com/api';
const SERVICE = 'Slack';
const trim = v => String(v ?? '').trim();

function clean(raw) {
  const channel = trim(raw.channel);
  if (!channel) throw new SharingError('Enter the channel ID.', { field: 'channel' });
  if (!/^[CGD][A-Z0-9]{6,}$/.test(channel)) {
    throw new SharingError('Use the channel’s ID (like C0123456789), not its name. In Slack, open the channel’s details; the ID is at the bottom.', { field: 'channel' });
  }
  return { channel };
}

function checkSecrets(secrets) {
  const token = trim(secrets.token);
  if (!token) throw new SharingError('Enter the bot token.', { field: 'token' });
  if (!token.startsWith('xoxb-')) throw new SharingError('Use the app’s bot token, which starts with xoxb- (OAuth & Permissions in your Slack app’s settings).', { field: 'token' });
}

const ERRORS = {
  invalid_auth: 'Slack didn’t accept the bot token. Check it, or reinstall the app to your workspace.',
  not_authed: 'Slack didn’t accept the bot token. Check it, or reinstall the app to your workspace.',
  token_revoked: 'That Slack token was revoked. Reinstall the app and copy the new bot token.',
  token_expired: 'That Slack token has expired. Reinstall the app and copy the new bot token.',
  account_inactive: 'The Slack app or its workspace is no longer active.',
  channel_not_found: 'Slack couldn’t find that channel. Check the channel ID, and invite the app to the channel.',
  not_in_channel: 'The Slack app isn’t in that channel. In the channel, type /invite and pick your app.',
  is_archived: 'That Slack channel is archived.',
  ratelimited: 'Slack is limiting requests right now. Try again in a minute.',
  file_uploads_disabled: 'File uploads are turned off in this Slack workspace.',
};

function slackError(data, status) {
  const code = data?.error || `http_${status}`;
  let message = ERRORS[code];
  if (code === 'missing_scope') message = `The Slack app is missing a permission (${data.needed || 'files:write, chat:write'}). Add it under OAuth & Permissions, then reinstall the app.`;
  if (!message && status === 429) message = ERRORS.ratelimited;
  if (!message && status >= 500) message = `Slack is having trouble (HTTP ${status}). Try again later.`;
  const field = ['channel_not_found', 'not_in_channel', 'is_archived'].includes(code) ? 'channel' : /auth|token/.test(code) ? 'token' : undefined;
  return new SharingError(message || `Slack returned an error: ${code}.`, { status, code, field, detail: code });
}

async function call(ctx, method, params, { json = false } = {}) {
  const res = await ctx.request(`${API}/${method}`, {
    method: 'POST',
    service: SERVICE,
    headers: {
      Authorization: `Bearer ${trim(ctx.secrets.token)}`,
      'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });
  if (!res.json || res.json.ok !== true) throw slackError(res.json, res.status);
  return res.json;
}

// Checks the token (auth.test) and files:write (an upload URL that's never used), then posts a
// short message, which is the only way to check chat:write and the channel without a file.
async function test(ctx) {
  const who = await call(ctx, 'auth.test', {});
  await call(ctx, 'files.getUploadURLExternal', { filename: 'jacks-picker-test.txt', length: '1' });
  await call(ctx, 'chat.postMessage', { channel: ctx.fields.channel, text: 'Jack’s Picker is connected. Captures sent from the app will show up here.' });
  return { message: `Connected to ${who.team || 'Slack'}${who.user ? ` as ${who.user}` : ''}. Posted a test message to the channel.` };
}

async function send(ctx, image, input) {
  ctx.progress('Uploading to Slack…');
  const slot = await call(ctx, 'files.getUploadURLExternal', { filename: image.filename, length: String(image.bytes.length) });
  if (!/^https:\/\//.test(slot.upload_url || '') || !slot.file_id) throw new SharingError('Slack didn’t return an upload address.', { detail: 'no upload_url' });
  const up = await ctx.request(slot.upload_url, {
    method: 'POST', service: SERVICE, timeout: 120_000,
    headers: { 'Content-Type': 'application/octet-stream' }, body: image.bytes,
  });
  if (!up.ok) throw new SharingError(`Slack didn’t accept the upload (HTTP ${up.status}).`, { status: up.status });
  ctx.progress('Posting to the channel…');
  const done = await call(ctx, 'files.completeUploadExternal', {
    files: [{ id: slot.file_id, title: input.title }],
    channel_id: ctx.fields.channel,
    ...(input.message ? { initial_comment: input.message } : {}),
  }, { json: true });
  // Slack may answer with just the file's id and title; then link to the channel instead.
  const permalink = done.files?.[0]?.permalink;
  return { url: permalink || `https://slack.com/app_redirect?channel=${ctx.fields.channel}`, label: 'Posted to Slack' };
}

module.exports = {
  type: 'slack', label: 'Slack', secretKeys: ['token'], form: 'message', needsStorage: false,
  defaultName: fields => `Slack ${fields.channel}`,
  clean, checkSecrets, summary: fields => `Channel ${fields.channel}`, test, send,
};
