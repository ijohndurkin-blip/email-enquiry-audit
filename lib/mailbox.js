// Reads message headers (never bodies) from a mailbox's inbox and Sent folder.
// Everything is read-only: mailboxes are opened with EXAMINE, so nothing is
// marked as read, moved or deleted.
const { simpleParser } = require('mailparser');
const { signIn } = require('./discover');
const { needsBody, scanBody } = require('./build');

const MAX_BODY_LOOKUPS = 150;

const MAX_PER_FOLDER = 6000;
const HEADERS = [
  'references', 'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted',
  'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'x-spam-flag', 'x-spam-status', 'return-path',
];

/** Parse a raw header block into { lowercased-name: value }. */
function parseHeaders(buf) {
  const out = {};
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const addr = (list) => (list || []).filter((a) => a && a.address).map((a) => ({ name: a.name || '', address: String(a.address).toLowerCase() }));
const ids = (s) => (String(s || '').match(/<[^<>\s]+>/g) || []);

function pickSentFolder(folders) {
  const special = folders.find((f) => f.specialUse === '\\Sent');
  if (special) return special.path;
  const byName = folders.find((f) => /^(inbox[./])?(sent|sent items|sent messages|sent mail|gesendet|envoy[ée]s)$/i.test(f.path));
  return byName ? byName.path : null;
}

/**
 * Choose a trustworthy timestamp. The server's arrival time (INTERNALDATE) is best,
 * unless the mail was migrated in later, in which case the Date header is closer.
 */
function messageTime(internalDate, headerDate) {
  const i = internalDate ? new Date(internalDate).getTime() : NaN;
  const h = headerDate ? new Date(headerDate).getTime() : NaN;
  if (Number.isFinite(i) && Number.isFinite(h)) return Math.abs(i - h) > 2 * 86400000 ? h : i;
  return Number.isFinite(i) ? i : h;
}

async function readFolder(client, path, since, kind, mailbox) {
  const out = [];
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    // IMAP searches by whole days, so look from the day before; exact filtering happens later.
    const uids = await client.search({ since: new Date(since - 86400000) }, { uid: true });
    if (!uids || !uids.length) return { messages: out, truncated: false };
    const pick = uids.slice(-MAX_PER_FOLDER);
    for await (const msg of client.fetch(pick.join(','), { uid: true, envelope: true, internalDate: true, headers: HEADERS }, { uid: true })) {
      const env = msg.envelope || {};
      const h = parseHeaders(msg.headers);
      const at = messageTime(msg.internalDate, env.date);
      if (!Number.isFinite(at) || at < since) continue;
      out.push({
        uid: msg.uid, kind, mailbox, at,
        from: addr(env.from)[0] || null,
        replyTo: addr(env.replyTo),
        to: addr(env.to),
        cc: addr(env.cc),
        subject: env.subject || '',
        messageId: env.messageId || null,
        inReplyTo: ids(env.inReplyTo)[0] || null,
        references: ids(h.references),
        headers: {
          listUnsubscribe: Boolean(h['list-unsubscribe']),
          listId: Boolean(h['list-id']),
          precedence: (h.precedence || '').toLowerCase(),
          autoSubmitted: (h['auto-submitted'] || '').toLowerCase(),
          autoReply: Boolean(h['x-autoreply'] || h['x-autorespond']),
          spam: /^yes/i.test(h['x-spam-flag'] || '') || /^yes/i.test(h['x-spam-status'] || ''),
          nullReturnPath: /^<\s*>$/.test(h['return-path'] || ''),
        },
      });
    }
    return { messages: out, truncated: uids.length > MAX_PER_FOLDER };
  } finally {
    lock.release();
  }
}

/**
 * Website-form emails often have no Reply-To, so the customer's address is only in the text.
 * Read just those emails (first 60 KB each) and note the addresses found. Read-only.
 */
async function readFormBodies(client, messages, mailboxEmail) {
  const wanted = messages.filter((m) => needsBody(m, mailboxEmail)).slice(-MAX_BODY_LOOKUPS);
  if (!wanted.length) return 0;
  const byUid = new Map(wanted.map((m) => [m.uid, m]));
  let found = 0;
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    for await (const msg of client.fetch(wanted.map((m) => m.uid).join(','), { uid: true, source: { maxLength: 60000 } }, { uid: true })) {
      const m = byUid.get(msg.uid);
      if (!m || !msg.source) continue;
      try {
        const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
        const text = parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' ');
        const { emails, name } = scanBody(text);
        if (emails.length) { m.bodyEmails = emails; found += 1; }
        if (name) m.bodyName = name;
      } catch { /* a malformed email: leave it as unmatched */ }
    }
  } catch { /* body lookups are a bonus; never fail the audit over them */ } finally {
    lock.release();
  }
  return found;
}

/** Folder list, the Sent folder and how many emails are in the inbox and Sent. */
async function describeMailbox(client, preferredSent) {
  const folders = await client.list();
  const paths = folders.map((f) => f.path);
  const sentFolder = preferredSent && paths.includes(preferredSent) ? preferredSent : pickSentFolder(folders);
  const count = async (path) => {
    try { return (await client.status(path, { messages: true })).messages; } catch { return null; }
  };
  return { folders: paths, sentFolder, inboxCount: await count('INBOX'), sentCount: sentFolder ? await count(sentFolder) : null };
}

/**
 * @param {{email, password, host?, port?, secure?, user?, allowBadCert?, sentFolder?}} account
 * @param {number} since  epoch ms
 */
async function readMailbox(account, since) {
  const email = String(account.email || '').trim().toLowerCase();
  const { client, settings, providerName, steps } = await signIn(account);
  const warnings = [];
  try {
    const folders = await client.list();
    const paths = folders.map((f) => f.path);
    const sentPath = account.sentFolder && paths.includes(account.sentFolder) ? account.sentFolder : pickSentFolder(folders);
    const inbox = await readFolder(client, 'INBOX', since, 'in', email);
    steps.push(`Read ${inbox.messages.length} emails from the inbox`);
    const found = await readFormBodies(client, inbox.messages, email);
    if (found) steps.push(`Found the customer's address in ${found} website-form email${found === 1 ? '' : 's'}`);
    if (inbox.truncated) warnings.push(`${email}: only the latest ${MAX_PER_FOLDER} inbox emails were read.`);
    let sent = { messages: [], truncated: false };
    if (sentPath) {
      sent = await readFolder(client, sentPath, since, 'out', email);
      steps.push(`Read ${sent.messages.length} sent emails from "${sentPath}"`);
      if (sent.truncated) warnings.push(`${email}: only the latest ${MAX_PER_FOLDER} sent emails were read.`);
    } else {
      warnings.push(`${email}: no Sent folder was found, so replies sent from this mailbox can't be matched. Folders: ${folders.map((f) => f.path).join(', ')}`);
    }
    return {
      email, providerName, steps, warnings,
      settings,
      sentFolder: sentPath,
      messages: [...inbox.messages, ...sent.messages],
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { readMailbox, describeMailbox, parseHeaders, pickSentFolder, messageTime };
