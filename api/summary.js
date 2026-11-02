// POST /api/summary: a plain-English summary of the audit numbers, written by AI.
// Body: { business: { name, about }, stats: { periods: [...] } }. Only totals are sent; no emails.
const ai = require('../lib/ai');
const { guard, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  if (!ai.enabled()) return send(res, 400, { error: 'AI isn\'t set up. In Vercel, add an environment variable called ANTHROPIC_API_KEY, then redeploy.' });
  if (!body.stats || typeof body.stats !== 'object') return send(res, 400, { error: 'No audit numbers to summarise.' });
  try {
    return send(res, 200, await ai.summarise(body.stats, body.business || {}));
  } catch (err) {
    const why = err.status === 401 ? 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Vercel.'
      : err.status === 429 ? 'The AI is busy (rate limit). Try again in a minute.' : err.message;
    return send(res, 502, { error: `Couldn't write the summary: ${why}` });
  }
};
