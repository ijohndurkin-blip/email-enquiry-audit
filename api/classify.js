// POST /api/classify: asks the AI which possible enquiries are real customer enquiries.
// Body: { business: { name, about }, items: [{ id, fromName, fromEmail, subject, viaForm, replied, snippet }] }
// The browser sends emails in small batches so each request stays well inside the time limit.
const ai = require('../lib/ai');
const { guard, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  if (!ai.enabled()) return send(res, 400, { error: 'AI sorting isn\'t set up. In Vercel, add an environment variable called ANTHROPIC_API_KEY, then redeploy.' });
  const items = Array.isArray(body.items) ? body.items.filter((i) => i && Number.isInteger(Number(i.id))) : [];
  if (!items.length) return send(res, 400, { error: 'Nothing to sort.' });
  if (items.length > ai.MAX_ITEMS) return send(res, 400, { error: `At most ${ai.MAX_ITEMS} emails per request.` });
  try {
    const out = await ai.classify(items, body.business || {});
    return send(res, 200, out);
  } catch (err) {
    const status = err.status === 401 ? 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.'
      : err.status === 429 ? 'The AI is busy (rate limit). Try again in a minute.'
        : err.message;
    return send(res, 502, { error: `AI sorting failed: ${status}` });
  }
};
