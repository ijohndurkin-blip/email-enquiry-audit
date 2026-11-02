// POST /api/audit
// Reads the given mailboxes (headers only, read-only) and returns the enquiries found.
// Passwords are used for this request only: never stored, never logged, never returned.
const { readMailbox } = require('../lib/mailbox');
const { buildEnquiries } = require('../lib/build');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

const DAY = 86400000;
const LOOKBACK_DAYS = 30; // read this much earlier mail too, to spot conversations already under way
const MAX_MAILBOXES = 5;
const MAX_SPAN_DAYS = 400;

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  const from = Date.parse(body.from);
  const to = Date.parse(body.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return send(res, 400, { error: 'Choose a valid date range.' });
  if ((to - from) / DAY > MAX_SPAN_DAYS) return send(res, 400, { error: `The date range can be at most ${MAX_SPAN_DAYS} days.` });
  // Each mailbox is either a saved connection (token) or typed-in details.
  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : [])
      .map((m) => (m && m.token ? { ...secret.open(m.token), ...(m.sentFolder ? { sentFolder: m.sentFolder } : {}) } : m))
      .filter((m) => m && m.email);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  if (!accounts.length) return send(res, 400, { error: 'Add at least one mailbox.' });
  if (accounts.length > MAX_MAILBOXES) return send(res, 400, { error: `At most ${MAX_MAILBOXES} mailboxes per audit.` });

  const since = from - LOOKBACK_DAYS * DAY;
  const results = await Promise.allSettled(accounts.map((a) => readMailbox({
    email: a.email, password: a.password, host: a.host || undefined, port: a.port || undefined,
    secure: a.secure !== false, user: a.user || undefined, allowBadCert: Boolean(a.allowBadCert), sentFolder: a.sentFolder || undefined,
  }, since, {
    // With AI sorting on, also read the first lines of each possible enquiry.
    withText: Boolean(body.withText),
    otherAddresses: String(body.otherAddresses || '').split(/[\s,;]+/).filter(Boolean),
  })));

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
