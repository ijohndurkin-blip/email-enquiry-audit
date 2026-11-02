// POST /api/thread: shows one enquiry's emails, read live from the mailbox when asked.
// Body: { mailboxes: [{ token }], refs: [{ mb, f, uid, d, at }] }
// Read-only (mailboxes opened with EXAMINE). Nothing is stored or logged.
const { simpleParser } = require('mailparser');
const { signIn } = require('../lib/discover');
const { stripQuoted } = require('../lib/build');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

const MAX_REFS = 40;
const MAX_TEXT = 6000;

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .filter((r) => r && r.mb && r.f && Number.isInteger(Number(r.uid)))
    .slice(0, MAX_REFS);
  if (!refs.length) return send(res, 400, { error: 'This enquiry has no emails that can be opened (it may be from an older audit).' });

  let accounts;
  try {
    accounts = (Array.isArray(body.mailboxes) ? body.mailboxes : []).filter((m) => m && m.token).map((m) => secret.open(m.token));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const out = new Map();
  const problems = [];
  for (const mb of [...new Set(refs.map((r) => String(r.mb).toLowerCase()))]) {
    const acct = accounts.find((a) => String(a.email).toLowerCase() === mb);
    if (!acct) { problems.push(`${mb} isn't connected, so its emails can't be shown.`); continue; }
    let session;
    try {
      session = await signIn({ ...acct, password: acct.password });
      const byFolder = {};
      refs.filter((r) => String(r.mb).toLowerCase() === mb).forEach((r) => { (byFolder[r.f] = byFolder[r.f] || []).push(Number(r.uid)); });
      for (const [folder, uids] of Object.entries(byFolder)) {
        const lock = await session.client.getMailboxLock(folder, { readOnly: true });
        try {
          for await (const msg of session.client.fetch(uids.join(','), { uid: true, source: { maxLength: 300000 } }, { uid: true })) {
            const p = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true }).catch(() => null);
            if (!p) continue;
            const text = p.text || String(p.html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
            out.set(`${mb}|${folder}|${msg.uid}`, {
              from: p.from ? p.from.text : '',
              to: p.to ? (Array.isArray(p.to) ? p.to.map((t) => t.text).join(', ') : p.to.text) : '',
              date: p.date ? p.date.toISOString() : null,
              subject: p.subject || '',
              text: stripQuoted(text).replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT),
              attachments: (p.attachments || []).map((a) => a.filename).filter(Boolean).slice(0, 10),
            });
          }
        } finally {
          lock.release();
        }
      }
    } catch (err) {
      problems.push(`${mb}: ${err.message}`);
    } finally {
      if (session) await session.client.logout().catch(() => {});
    }
  }
  const messages = refs.map((r) => {
    const m = out.get(`${String(r.mb).toLowerCase()}|${r.f}|${Number(r.uid)}`);
    return m ? { direction: r.d === 'out' ? 'out' : 'in', ...m } : { direction: r.d === 'out' ? 'out' : 'in', missing: true, date: r.at ? new Date(r.at).toISOString() : null };
  });
  return send(res, 200, { messages, problems });
};
