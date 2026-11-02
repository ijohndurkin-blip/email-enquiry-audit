const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

process.env.AUDIT_ACCESS_KEY = 'secret';
const store = require('../lib/store');
const storeApi = require('../api/store');

const calls = [];
store._setFetch(async (url, opts) => {
  calls.push({ url, opts });
  if (opts.method === 'POST' && url.includes('audit_companies')) return new Response(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', name: JSON.parse(opts.body).name }]), { status: 201 });
  if (url.includes('fail')) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
  return new Response('[]', { status: 200 });
});

function call(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'x-access-key': 'secret' };
  return new Promise((resolve) => {
    const res = { setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    storeApi(req, res);
  });
}

test('off until Supabase is configured', async () => {
  delete process.env.SUPABASE_URL;
  assert.strictEqual(store.enabled(), false);
  assert.strictEqual((await call({ action: 'listCompanies' })).status, 400);
});

test('uses the secret key in the apikey header (and Bearer only for legacy JWT keys)', async () => {
  process.env.SUPABASE_URL = 'https://abc.supabase.co/';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_xyz';
  calls.length = 0;
  const r = await call({ action: 'listCompanies' });
  assert.strictEqual(r.status, 200);
  assert.match(calls[0].url, /^https:\/\/abc\.supabase\.co\/rest\/v1\/audit_companies\?select=.*audit_runs\(/);
  assert.strictEqual(calls[0].opts.headers.apikey, 'sb_secret_xyz');
  assert.strictEqual(calls[0].opts.headers.Authorization, undefined);
  process.env.SUPABASE_SECRET_KEY = 'eyJhbGciOi.legacy.jwt';
  await call({ action: 'listCompanies' });
  assert.strictEqual(calls[1].opts.headers.Authorization, 'Bearer eyJhbGciOi.legacy.jwt');
});

test('creates a company and rejects bad ids', async () => {
  process.env.SUPABASE_URL = 'https://abc.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_xyz';
  const r = await call({ action: 'saveCompany', company: { name: "Darryn's Plumbing", go_live: '2026-11-10', settings: { about: 'x' } } });
  assert.strictEqual(r.body.data.name, "Darryn's Plumbing");
  const bad = await call({ action: 'deleteCompany', id: "1' or 1=1" });
  assert.strictEqual(bad.status, 400);
  const unknown = await call({ action: 'dropTables' });
  assert.strictEqual(unknown.status, 400);
});

test('a saved audit records its period and checkpoint', async () => {
  calls.length = 0;
  await call({ action: 'saveRun', run: { company_id: '11111111-1111-1111-1111-111111111111', kind: 'checkpoint', checkpoint: 'w1', label: 'Week 1', period_from: 1762300800000, period_to: 1762905600000, minutes_per_enquiry: '3', metrics: { count: 5 } } });
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(body.checkpoint, 'w1');
  assert.strictEqual(body.minutes_per_enquiry, 3);
  assert.strictEqual(body.period_from, new Date(1762300800000).toISOString());
});
