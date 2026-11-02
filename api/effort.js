// POST /api/effort: estimates the minutes each enquiry took to handle by hand.
// Body: { business, mailboxes: [{ token }], items: [{ id, ins: [{mb,f,uid}], outs: [{mb,f,uid}] }] }
// Reads the emails live (read-only), counts words, and (if AI is on) asks what work was
// behind each reply. Only the minutes and short notes come back; no email text.
const ai = require('../lib/ai');
const { estimate } = require('../lib/effort');
const { fetchBodies, bodyKey } = require('../lib/bodies');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

const MAX_ITEMS = 6;
const ok = (r) => r && r.mb && r.f && Number.isInteger(Number(r.uid));

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({ id: Number(i.id), ins: (i.ins || []).filter(ok).slice(0, 8), outs: (i.outs || []).filter(ok).slice(0, 8) }))
    .filter((i) => Number.isInteger(i.id) && i.outs.length).slice(0, MAX_ITEMS);
  if (!items.length) return send(res, 400, { error: 'No replies to measure.' });
  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.token).map((m) => secret.open(m.token));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const { found, problems } = await fetchBodies(accounts, items.flatMap((i) => [...i.ins, ...i.outs]), { maxText: 8000 });
  const read = (r) => found.get(bodyKey(r.mb, r.f, r.uid));
  const prepared = items.map((i) => ({
    id: i.id,
    customer: i.ins.map(read).filter(Boolean).map((m) => `${m.subject ? `Subject: ${m.subject}\n` : ''}${m.text || ''}`).join('\n---\n'),
    replies: i.outs.map((r, n) => ({ n: n + 1, msg: read(r) })).filter((r) => r.msg),
  })).filter((i) => i.replies.length);

  let flags = new Map();
  let usedAi = false;
  if (ai.enabled() && prepared.length) {
    try {
      flags = await ai.assessEffort(prepared.map((i) => ({ id: i.id, customer: i.customer, replies: i.replies.map((r) => ({ n: r.n, text: r.msg.text })) })), body.business || {});
      usedAi = true;
    } catch (err) {
      problems.push(`The AI context check didn't run (${err.message}); this batch uses word counts only.`);
    }
  }
  const results = prepared.map((i) => ({
    id: i.id,
    ...estimate({
      customerText: i.customer,
      replies: i.replies.map((r) => ({ text: r.msg.text, attachments: r.msg.attachments, flags: flags.get(`${i.id}:${r.n}`) })),
    }),
  }));
  return send(res, 200, { results, usedAi, problems });
};
