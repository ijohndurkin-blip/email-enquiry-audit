// POST /api/thread: shows one enquiry's emails, read live from the mailbox when asked.
// Body: { mailboxes: [{ token }], refs: [{ mb, f, uid, d, at }] }. Nothing is stored or logged.
const { fetchBodies, bodyKey } = require('../lib/bodies');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .filter((r) => r && r.mb && r.f && Number.isInteger(Number(r.uid)))
    .slice(0, 40);
  if (!refs.length) return send(res, 400, { error: 'This enquiry has no emails that can be opened (it may be from an older audit).' });
  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.token).map((m) => secret.open(m.token));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const { found, problems } = await fetchBodies(accounts, refs);
  const messages = refs.map((r) => {
    const m = found.get(bodyKey(r.mb, r.f, r.uid));
    const direction = r.d === 'out' ? 'out' : 'in';
    return m ? { direction, ...m } : { direction, missing: true, date: r.at ? new Date(r.at).toISOString() : null };
  });
  return send(res, 200, { messages, problems });
};
