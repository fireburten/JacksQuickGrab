// Microsoft Teams, through a Workflows webhook ("Post to a channel when a webhook request is
// received"). Webhooks can't take a file, so the capture goes to S3-compatible storage first
// and the channel gets an Adaptive Card showing it. The webhook URL is the credential.
const { SharingError, hostOf } = require('./http.cjs');

const SERVICE = 'Microsoft Teams';
const trim = v => String(v ?? '').trim();

const clean = raw => ({ storageId: trim(raw.storageId).slice(0, 40) });

function checkSecrets(secrets) {
  const text = trim(secrets.webhookUrl);
  if (!text) throw new SharingError('Paste the workflow’s webhook URL.', { field: 'webhookUrl' });
  let url;
  try { url = new URL(text); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new SharingError('The webhook URL should start with https://. Copy it from the workflow’s “When a Teams webhook request is received” step.', { field: 'webhookUrl' });
}

function card(text, image) {
  const body = [{ type: 'TextBlock', text, wrap: true }];
  if (image) body.push({ type: 'Image', url: image.url, altText: image.filename, size: 'Stretch' });
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        ...(image ? { actions: [{ type: 'Action.OpenUrl', title: 'Open image', url: image.url }] } : {}),
      },
    }],
  };
}

async function post(ctx, payload) {
  const res = await ctx.request(trim(ctx.secrets.webhookUrl), {
    method: 'POST', service: SERVICE,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (res.ok) return;
  const messages = {
    400: 'Teams didn’t accept the message. Check that the workflow uses the “Post to a channel when a webhook request is received” template.',
    401: 'Teams rejected the webhook URL. Copy it again from the workflow’s trigger.',
    403: 'Teams rejected the webhook URL. Copy it again from the workflow’s trigger.',
    404: 'That workflow doesn’t exist any more (or the URL is incomplete). Copy the URL again.',
    429: 'Teams is limiting requests right now. Try again in a minute.',
  };
  throw new SharingError(messages[res.status] || `Teams returned an error (HTTP ${res.status}).`, {
    status: res.status, field: [401, 403, 404].includes(res.status) ? 'webhookUrl' : undefined, detail: `${hostOf(ctx.secrets.webhookUrl)} ${res.status}`,
  });
}

async function test(ctx) {
  await post(ctx, card('Jack’s Picker is connected. Captures sent from the app will show up here.'));
  return { message: 'Connected. Posted a test message to the channel.' };
}

async function send(ctx, image, input) {
  ctx.progress('Uploading the image…');
  const link = await ctx.storage.upload(image);
  ctx.progress('Posting to Teams…');
  await post(ctx, card(input.message || input.title, { url: link.url, filename: image.filename }));
  return { url: link.url, expires: link.expires, label: 'Posted to Teams' };
}

module.exports = {
  type: 'teams', label: 'Microsoft Teams', secretKeys: ['webhookUrl'], form: 'message', needsStorage: true,
  defaultName: () => 'Microsoft Teams',
  clean, checkSecrets, summary: () => 'Posts an image link through a Workflows webhook', test, send, card,
};
