// Reads specific emails' text from the mailboxes, on request (read-only, EXAMINE).
// Used to show a conversation and to check reply quality. Nothing is stored.
const { simpleParser } = require('mailparser');
const { signIn } = require('./discover');
const { stripQuoted } = require('./build');

const key = (mb, f, uid) => `${String(mb).toLowerCase()}|${f}|${Number(uid)}`;

/**
 * @param {object[]} accounts  decrypted mailbox connections ({ email, password, host, ... })
 * @param {{mb, f, uid}[]} refs
 * @returns {Promise<{ found: Map<string, {from,to,date,subject,text,attachments}>, problems: string[] }>}
 */
async function fetchBodies(accounts, refs, { maxText = 6000 } = {}) {
  const found = new Map();
  const problems = [];
  for (const mb of [...new Set(refs.map((r) => String(r.mb).toLowerCase()))]) {
    const acct = accounts.find((a) => String(a.email).toLowerCase() === mb);
    if (!acct) { problems.push(`${mb} isn't connected, so its emails can't be read.`); continue; }
    let session;
    try {
      session = await signIn(acct);
      const byFolder = {};
      refs.filter((r) => String(r.mb).toLowerCase() === mb).forEach((r) => { (byFolder[r.f] = byFolder[r.f] || new Set()).add(Number(r.uid)); });
      for (const [folder, uids] of Object.entries(byFolder)) {
        const lock = await session.client.getMailboxLock(folder, { readOnly: true });
        try {
          for await (const msg of session.client.fetch([...uids].join(','), { uid: true, source: { maxLength: 300000 } }, { uid: true })) {
            const p = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true }).catch(() => null);
            if (!p) continue;
            const text = p.text || String(p.html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
            found.set(key(mb, folder, msg.uid), {
              from: p.from ? p.from.text : '',
              to: p.to ? (Array.isArray(p.to) ? p.to.map((t) => t.text).join(', ') : p.to.text) : '',
              date: p.date ? p.date.toISOString() : null,
              subject: p.subject || '',
              text: stripQuoted(text).replace(/\n{3,}/g, '\n\n').slice(0, maxText),
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
  return { found, problems };
}

module.exports = { fetchBodies, bodyKey: key };
