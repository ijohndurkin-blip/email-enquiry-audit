// Saved companies and audits, kept in Supabase. Server-side only: the secret key
// stays in Vercel and the tables allow no public access.
// Env: SUPABASE_URL and SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY).
const url = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const enabled = () => Boolean(url() && key());

let fetchImpl = (...a) => fetch(...a);

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const k = key();
  const headers = { apikey: k, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (k.startsWith('eyJ')) headers.Authorization = `Bearer ${k}`; // legacy JWT keys also go in Authorization
  if (prefer) headers.Prefer = prefer;
  const res = await fetchImpl(`${url()}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* plain text */ }
    throw Object.assign(new Error(`Supabase: ${msg}`.slice(0, 300)), { status: res.status });
  }
  return text ? JSON.parse(text) : null;
}

const UUID = /^[0-9a-f-]{36}$/i;
const id = (v) => { if (!UUID.test(String(v || ''))) throw Object.assign(new Error('Invalid id'), { status: 400 }); return v; };
const RUN_LIST = 'id,kind,checkpoint,label,period_from,period_to,minutes_per_enquiry,metrics,created_at,updated_at';

async function listCompanies() {
  return rest(`audit_companies?select=id,name,go_live,settings,created_at,updated_at,audit_runs(${RUN_LIST})&order=name.asc&audit_runs.order=period_from.asc`);
}

async function saveCompany({ id: cid, name, go_live: goLive, settings }) {
  const row = { name: String(name || 'Untitled').slice(0, 200), go_live: goLive || null, settings: settings || {} };
  if (cid) {
    const out = await rest(`audit_companies?id=eq.${id(cid)}`, { method: 'PATCH', body: row, prefer: 'return=representation' });
    if (!out.length) throw Object.assign(new Error('Company not found'), { status: 404 });
    return out[0];
  }
  return (await rest('audit_companies', { method: 'POST', body: row, prefer: 'return=representation' }))[0];
}

async function deleteCompany(cid) {
  await rest(`audit_companies?id=eq.${id(cid)}`, { method: 'DELETE' });
  return { ok: true };
}

async function saveRun(run) {
  const row = {
    company_id: id(run.company_id),
    kind: ['baseline', 'checkpoint', 'custom'].includes(run.kind) ? run.kind : 'custom',
    checkpoint: run.checkpoint ? String(run.checkpoint).slice(0, 20) : null,
    label: String(run.label || 'Audit').slice(0, 120),
    period_from: new Date(run.period_from).toISOString(),
    period_to: new Date(run.period_to).toISOString(),
    minutes_per_enquiry: run.minutes_per_enquiry == null || run.minutes_per_enquiry === '' ? null : Number(run.minutes_per_enquiry),
    metrics: run.metrics || {},
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
  };
  if (run.id) {
    const out = await rest(`audit_runs?id=eq.${id(run.id)}&select=${RUN_LIST}`, { method: 'PATCH', body: row, prefer: 'return=representation' });
    if (!out.length) throw Object.assign(new Error('Audit not found'), { status: 404 });
    return out[0];
  }
  return (await rest(`audit_runs?select=${RUN_LIST}`, { method: 'POST', body: row, prefer: 'return=representation' }))[0];
}

async function getRun(rid) {
  const out = await rest(`audit_runs?id=eq.${id(rid)}&select=*`);
  if (!out.length) throw Object.assign(new Error('Audit not found'), { status: 404 });
  return out[0];
}

async function deleteRun(rid) {
  await rest(`audit_runs?id=eq.${id(rid)}`, { method: 'DELETE' });
  return { ok: true };
}

module.exports = { enabled, listCompanies, saveCompany, deleteCompany, saveRun, getRun, deleteRun, _setFetch: (f) => { fetchImpl = f; } };
