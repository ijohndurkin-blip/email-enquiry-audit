// POST /api/quality: checks the business's first reply to each enquiry with AI.
// Body: { business, mailboxes: [{ token }], items: [{ id, subject, ins: [{mb,f,uid}] (customer emails before the reply), out: {mb,f,uid} }] }
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
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({ ...i, ins: (Array.isArray(i.ins) ? i.ins : [i.in]).filter(ok).slice(-5) }))
    .filter((i) => i && Number.isInteger(Number(i.id)) && i.ins.length && ok(i.out)).slice(0, MAX_ITEMS);
  if (!items.length) return send(res, 400, { error: 'No replies to check.' });
  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.token).map((m) => secret.open(m.token));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const { found, problems } = await fetchBodies(accounts, items.flatMap((i) => [...i.ins, i.out]), { maxText: 3000 });
  // Everything the customer sent before the reply, with subject lines (the question is often only in the subject).
  const customerText = (ins) => ins.map((r) => found.get(bodyKey(r.mb, r.f, r.uid))).filter(Boolean)
    .map((m, n, all) => `${all.length > 1 ? `Email ${n + 1}: ` : ''}Subject: ${m.subject || '(none)'}\n${m.text || ''}`).join('\n---\n');
  const pairs = items.map((i) => {
    const reply = found.get(bodyKey(i.out.mb, i.out.f, i.out.uid));
    return { id: i.id, subject: i.subject || '', customer: customerText(i.ins), reply: reply ? `Subject: ${reply.subject || ''}\n${reply.text || ''}` : '' };
  }).filter((p) => p.reply);
  if (!pairs.length) return send(res, 200, { results: [], problems: problems.length ? problems : ['The replies couldn\'t be read from the mailbox.'] });
  try {
    return send(res, 200, { results: await ai.scoreReplies(pairs, body.business || {}), problems });
  } catch (err) {
    const why = err.status === 401 ? 'The Anthropic API key was rejected.' : err.status === 429 ? 'The AI is busy; try again in a minute.' : err.message;
    return send(res, 502, { error: `Reply check failed: ${why}` });
  }
};
