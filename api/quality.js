// POST /api/quality: checks the business's first reply to each enquiry with AI.
// Body: { business, mailboxes: [{ token }], items: [{ id, subject, in: {mb,f,uid}, out: {mb,f,uid} }] }
// The two emails are read live (read-only) and sent to the AI; only the scores come back.
const ai = require('../lib/ai');
const { fetchBodies, bodyKey } = require('../lib/bodies');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

const MAX_ITEMS = 8;
const ok = (r) => r && r.mb && r.f && Number.isInteger(Number(r.uid));

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  if (!ai.enabled()) return send(res, 400, { error: 'AI isn\'t set up. In Vercel, add ANTHROPIC_API_KEY, then redeploy.' });
  const items = (Array.isArray(body.items) ? body.items : []).filter((i) => i && Number.isInteger(Number(i.id)) && ok(i.in) && ok(i.out)).slice(0, MAX_ITEMS);
  if (!items.length) return send(res, 400, { error: 'No replies to check.' });
  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.token).map((m) => secret.open(m.token));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const { found, problems } = await fetchBodies(accounts, items.flatMap((i) => [i.in, i.out]), { maxText: 3000 });
  const pairs = items.map((i) => ({
    id: i.id, subject: i.subject || '',
    customer: (found.get(bodyKey(i.in.mb, i.in.f, i.in.uid)) || {}).text,
    reply: (found.get(bodyKey(i.out.mb, i.out.f, i.out.uid)) || {}).text,
  })).filter((p) => p.reply);
  if (!pairs.length) return send(res, 200, { results: [], problems: problems.length ? problems : ['The replies couldn\'t be read from the mailbox.'] });
  try {
    return send(res, 200, { results: await ai.scoreReplies(pairs, body.business || {}), problems });
  } catch (err) {
    const why = err.status === 401 ? 'The Anthropic API key was rejected.' : err.status === 429 ? 'The AI is busy; try again in a minute.' : err.message;
    return send(res, 502, { error: `Reply check failed: ${why}` });
  }
};
