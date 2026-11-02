// POST /api/audit
// Reads the given mailboxes (headers only, read-only) and returns the enquiries found.
// Passwords are used for this request only: never stored, never logged, never returned.
const crypto = require('node:crypto');
const { readMailbox } = require('../lib/mailbox');
const { buildEnquiries } = require('../lib/build');

const DAY = 86400000;
const LOOKBACK_DAYS = 30; // read this much earlier mail too, to spot conversations already under way
const MAX_MAILBOXES = 5;
const MAX_SPAN_DAYS = 400;

function keyMatches(given) {
  const expected = process.env.AUDIT_ACCESS_KEY || '';
  if (!expected) return null;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100000) throw new Error('Request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

  const ok = keyMatches(req.headers['x-access-key']);
  if (ok === null) return send(res, 500, { error: 'This audit tool has no access key set. In Vercel, add an environment variable called AUDIT_ACCESS_KEY, then redeploy.' });
  if (!ok) return send(res, 401, { error: 'Wrong access key.' });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Couldn\'t read the request.' }); }

  const from = Date.parse(body.from);
  const to = Date.parse(body.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return send(res, 400, { error: 'Choose a valid date range.' });
  if ((to - from) / DAY > MAX_SPAN_DAYS) return send(res, 400, { error: `The date range can be at most ${MAX_SPAN_DAYS} days.` });
  const accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.email);
  if (!accounts.length) return send(res, 400, { error: 'Add at least one mailbox.' });
  if (accounts.length > MAX_MAILBOXES) return send(res, 400, { error: `At most ${MAX_MAILBOXES} mailboxes per audit.` });

  const since = from - LOOKBACK_DAYS * DAY;
  const results = await Promise.allSettled(accounts.map((a) => readMailbox({
    email: a.email, password: a.password, host: a.host || undefined, port: a.port || undefined,
    secure: a.secure !== false, user: a.user || undefined,
  }, since)));

  const mailboxes = results.map((r, i) => {
    const email = String(accounts[i].email).trim().toLowerCase();
    if (r.status === 'fulfilled') {
      const { messages, ...info } = r.value;
      return { ok: true, ...info, inboxCount: messages.filter((m) => m.kind === 'in').length, sentCount: messages.filter((m) => m.kind === 'out').length };
    }
    return { ok: false, email, error: r.reason?.message || 'Failed', help: r.reason?.help || null, steps: r.reason?.steps || [] };
  });
  if (!mailboxes.some((m) => m.ok)) return send(res, 422, { error: 'Couldn\'t read any of the mailboxes.', mailboxes });

  const messages = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.messages : []));
  const { enquiries, stats } = buildEnquiries(messages, {
    from, to,
    mailboxes: accounts.map((a) => a.email),
    otherAddresses: String(body.otherAddresses || '').split(/[\s,;]+/).filter(Boolean),
    ignoreSenders: String(body.ignoreSenders || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
  });

  return send(res, 200, {
    generatedAt: new Date().toISOString(),
    from, to,
    mailboxes,
    stats,
    enquiries,
  });
};
