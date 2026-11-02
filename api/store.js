// POST /api/store  { action, ... }: saved companies and audits (Supabase).
const store = require('../lib/store');
const { guard, send } = require('../lib/http');

const ACTIONS = {
  listCompanies: () => store.listCompanies(),
  saveCompany: (b) => store.saveCompany(b.company || {}),
  deleteCompany: (b) => store.deleteCompany(b.id),
  saveRun: (b) => store.saveRun(b.run || {}),
  getRun: (b) => store.getRun(b.id),
  deleteRun: (b) => store.deleteRun(b.id),
};

module.exports = async function handler(req, res) {
  const body = await guard(req, res, { maxBytes: 4_000_000 });
  if (!body) return;
  if (!store.enabled()) return send(res, 400, { error: 'Saving to Supabase isn\'t set up. In Vercel, add SUPABASE_URL and SUPABASE_SECRET_KEY, then redeploy.' });
  const fn = ACTIONS[body.action];
  if (!fn) return send(res, 400, { error: 'Unknown action.' });
  try {
    return send(res, 200, { ok: true, data: await fn(body) });
  } catch (err) {
    return send(res, err.status === 400 || err.status === 404 ? err.status : 502, { error: err.message });
  }
};
