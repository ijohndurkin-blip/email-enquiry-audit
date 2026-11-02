// Turns raw message headers from one or more mailboxes into enquiries.
// Pure functions only (no network), so the rules can be tested.
//
// Definitions (kept in line with the Rare email enquiry app so before/after numbers compare):
// - An enquiry is a conversation with one customer email address. Messages from the same
//   customer stay in one enquiry unless they go quiet for QUIET_DAYS and then write afresh.
// - Reply time is from the customer's first email to the business's first email back to them.
// - Website-form emails (sent from a no-reply or own-domain address with the customer in
//   Reply-To) are attributed to the customer in Reply-To.

const QUIET_DAYS = 14;
const DAY = 86400000;

const AUTOMATED_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|newsletters?|alerts?|marketing|updates|mailer|automated|system)([._+-]|$)/i;
const FORM_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|wordpress|forms?|website|wix|squarespace|jotform|typeform|formspree|webflow|hubspot)([._+-]|$)/i;
const FORM_SUBJECT = /(enquir|inquir|contact (form|us)|form submission|new (form|message|submission|lead|entry)|quote request|request a quote|booking request|message from|website message|callback)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|delivery has failed|couldn't be delivered)/i;
const AUTOREPLY_SUBJECT = /^(auto(matic)?[ -]?reply|out of (the )?office|ooo\b|autoreply|away from|on (annual )?leave|abwesenheit)/i;
const RECEIPT_SUBJECT = /\b(receipt|your invoice|invoice (#|no\.?|number)|order confirmation|your order|payment (received|confirmation|failed)|password reset|reset your password|verify your|verification code|security alert|new sign-?in|statement is ready|renewal|subscription|webinar|unsubscribe|free trial|trial (ends|expires|ending|is ending)|terms of (service|use)|privacy policy|action (required|advised)|legal notice)\b/i;
// Companies whose emails are account or service mail, not customer enquiries. Customers write
// from gmail.com, hotmail.co.uk etc., which are not on this list. Lead sites (Checkatrade, Bark…)
// are deliberately left off: their emails can be real enquiries.
const SERVICE_DOMAINS = [
  'google.com', 'microsoft.com', 'office.com', 'apple.com', 'amazon.com', 'amazon.co.uk', 'amazonaws.com', 'facebookmail.com',
  'meta.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com', 'paypal.com', 'paypal.co.uk', 'stripe.com',
  'xero.com', 'intuit.com', 'sage.com', 'godaddy.com', 'ionos.co.uk', 'ionos.com', '123-reg.co.uk', 'hostinger.com', 'namecheap.com',
  'vercel.com', 'github.com', 'supabase.com', 'supabase.io', 'anthropic.com', 'openai.com', 'canva.com', 'mailchimp.com',
  'hubspot.com', 'shopify.com', 'squarespace.com', 'wix.com', 'wordpress.com', 'zoom.us', 'slack.com', 'dropbox.com',
  'hmrc.gov.uk', 'gov.uk', 'ebay.com', 'ebay.co.uk', 'trustpilot.com', 'uber.com', 'booking.com', 'adobe.com', 'zoho.com',
];
const isServiceDomain = (d) => SERVICE_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`));
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const lc = (s) => String(s || '').trim().toLowerCase();
const domainOf = (email) => lc(email).split('@')[1] || '';
const localOf = (email) => lc(email).split('@')[0] || '';
const normSubject = (s) => lc(s).replace(/^((re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();
const isReplyMessage = (m) => Boolean(m.inReplyTo) || /^\s*(re|aw|sv|antw)\s*:/i.test(m.subject || '');

function makeContext({ mailboxes = [], otherAddresses = [], ignoreSenders = [] }) {
  const own = new Set([...mailboxes, ...otherAddresses].map(lc).filter((e) => e.includes('@')));
  const FREE = /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|icloud|me|mac|msn|btinternet|sky|virginmedia|proton|protonmail|gmx)\./;
  // The business's own domains, unless they use a free-mail address (then only the exact address counts).
  const ownDomains = new Set([...own].map(domainOf).filter((d) => d && !FREE.test(d)));
  const ignore = ignoreSenders.map(lc).filter(Boolean);
  return {
    isOwnAddress: (e) => own.has(lc(e)),
    isOwnDomain: (e) => ownDomains.has(domainOf(e)),
    isIgnored: (e) => ignore.some((s) => lc(e).includes(s)),
  };
}

/**
 * Work out who the customer is for an incoming message, or why it isn't from a customer.
 * @returns {{customer:{address,name}|null, viaForm:boolean, internal?:true}}
 */
function identify(m, ctx) {
  const from = m.from;
  const isExternal = (a) => a && !ctx.isOwnAddress(a.address) && !ctx.isOwnDomain(a.address);
  // Customer address from Reply-To, or (for form emails without one) the first suitable address in the body.
  const subjectName = ((m.subject || '').match(/\bfrom\s+([^:|\-\[\]]{2,60})$/i) || [])[1];
  const fromBody = (m.bodyEmails || []).map((address) => ({ address, name: m.bodyName || (subjectName || '').trim() }))
    .find((a) => isExternal(a) && !AUTOMATED_LOCAL.test(localOf(a.address)) && (!from || a.address !== lc(from.address)));
  const external = (m.replyTo || []).find(isExternal) || fromBody;
  if (!from) return { customer: external || null, viaForm: Boolean(external) };
  const fromIsOurs = ctx.isOwnAddress(from.address) || ctx.isOwnDomain(from.address);
  const formSender = fromIsOurs || FORM_LOCAL.test(localOf(from.address));
  const formSubject = FORM_SUBJECT.test(m.subject || '');
  if ((formSender || formSubject) && external && external.address !== lc(from.address)) return { customer: external, viaForm: true };
  if (formSender && formSubject) return { customer: null, viaForm: true }; // form with no customer address
  if (fromIsOurs) return { customer: null, viaForm: false, internal: true };
  return { customer: from, viaForm: false };
}

/** Should this message's body be read to find the customer's address? (A form email without Reply-To.) */
function needsBody(m, mailboxEmail) {
  if (m.kind !== 'in' || !m.from) return false;
  const ownDomain = domainOf(mailboxEmail);
  const hasExternalReplyTo = (m.replyTo || []).some((a) => domainOf(a.address) !== ownDomain && a.address !== lc(m.from.address));
  const formSender = domainOf(m.from.address) === ownDomain || FORM_LOCAL.test(localOf(m.from.address));
  return !hasExternalReplyTo && formSender && FORM_SUBJECT.test(m.subject || '');
}

/** Could this incoming message be a customer enquiry? (Used to decide whose text the AI sees.) */
function isCandidate(m, mailboxEmail, extra = {}) {
  if (m.kind !== 'in' || !m.from) return false;
  const ctx = makeContext({ mailboxes: [mailboxEmail], ...extra });
  const ident = identify(m, ctx);
  return !ident.internal && !junkReason(m, ident, ctx);
}

// Keep only what the customer just wrote: drop quoted replies and signatures' reply history.
function stripQuoted(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || (/^From:\s.+/i.test(line) && out.length > 3)) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Email addresses and a likely name from a form email's text. */
function scanBody(text) {
  const t = String(text || '').slice(0, 20000);
  const emails = [...new Set((t.match(EMAIL_RE) || []).map(lc))].slice(0, 5);
  const name = (t.match(/^\s*(?:your |full |first )?name\s*[:\-]\s*(.{2,60})$/im) || [])[1];
  return { emails, name: name ? name.trim() : '' };
}

/** Why an incoming message probably isn't a customer enquiry (null = looks genuine). */
function junkReason(m, ident, ctx) {
  const h = m.headers || {};
  const sender = ident.viaForm ? '' : localOf(m.from && m.from.address);
  const senderAddress = ident.customer ? ident.customer.address : '';
  const subject = m.subject || '';
  if (ctx && senderAddress && ctx.isIgnored(senderAddress)) return 'On your "never count" list';
  if (h.spam) return 'Marked as spam by the mail server';
  if (/^(mailer-daemon|postmaster)$/.test(sender) || BOUNCE_SUBJECT.test(subject) || (h.nullReturnPath && !ident.viaForm)) return 'Bounce / delivery failure';
  if (AUTOREPLY_SUBJECT.test(subject) || h.autoReply) return 'Out-of-office or auto-reply';
  if (h.listUnsubscribe || h.listId || ['bulk', 'list', 'junk'].includes(h.precedence)) return 'Newsletter or mailing list';
  if (h.autoSubmitted && h.autoSubmitted !== 'no' && !ident.viaForm) return 'Automated message';
  if (sender && AUTOMATED_LOCAL.test(sender)) return 'Automated sender (no-reply, notifications…)';
  if (sender && FORM_LOCAL.test(sender)) return 'Website or system notification';
  if (!ident.viaForm && isServiceDomain(domainOf(m.from && m.from.address))) return 'Account or service email';
  if (RECEIPT_SUBJECT.test(subject) && !ident.viaForm) return 'Receipt, account or marketing email';
  return null;
}

/**
 * @param {object[]} messages   from readMailbox(): { kind:'in'|'out', mailbox, at, from, replyTo, to, cc, subject, messageId, inReplyTo, references, headers }
 * @param {{from:number, to:number, mailboxes:string[], otherAddresses?:string[], ignoreSenders?:string[]}} opts
 *   from/to: the audit period (epoch ms). Messages before `from` are context only.
 * @returns {{ enquiries: object[], stats: object }}
 */
function buildEnquiries(messages, opts) {
  const ctx = makeContext(opts);
  const stats = { inbound: 0, outbound: 0, duplicates: 0, internal: 0, unattributedForms: 0 };
  // What the audit decided about every email it read, for the "all emails" export.
  const decided = new Map(); // original message -> { status, enquiry }
  const orig = (m) => m._orig || m;
  const note = (m, status) => decided.set(orig(m), { status });

  // De-duplicate across mailboxes (one enquiry sent to both addresses, or Cc'd).
  const seen = new Map();
  const unique = [];
  for (const m of [...messages].sort((a, b) => a.at - b.at)) {
    const key = m.messageId ? `${m.kind}:${m.messageId}` : null;
    if (key && seen.has(key)) {
      const first = seen.get(key);
      if (!first.mailboxes.includes(m.mailbox)) first.mailboxes.push(m.mailbox);
      stats.duplicates += 1;
      decided.set(m, { status: 'Duplicate: the same email is also in another audited mailbox', sameAs: orig(first) });
      continue;
    }
    const copy = { ...m, mailboxes: [m.mailbox], _orig: m };
    if (key) seen.set(key, copy);
    unique.push(copy);
  }

  // Outgoing mail, indexed by recipient.
  const sentTo = new Map();
  const ownMessageIds = new Set();
  for (const m of unique) {
    if (m.kind !== 'out') continue;
    stats.outbound += 1;
    if (m.messageId) ownMessageIds.add(m.messageId);
    for (const r of [...(m.to || []), ...(m.cc || [])]) {
      if (ctx.isOwnAddress(r.address)) continue;
      const list = sentTo.get(r.address) || [];
      list.push(m);
      sentTo.set(r.address, list);
    }
  }

  // Incoming mail, grouped by customer.
  const byCustomer = new Map();
  const orphans = [];
  for (const m of unique) {
    if (m.kind !== 'in') continue;
    if (m.messageId && ownMessageIds.has(m.messageId)) { note(m, 'Copy of an email the business sent'); continue; }
    const ident = identify(m, ctx);
    if (ident.internal) { stats.internal += 1; note(m, 'From the business itself (internal)'); continue; }
    stats.inbound += 1;
    const item = { m, ident, junk: junkReason(m, ident, ctx) };
    if (!ident.customer) { orphans.push(item); stats.unattributedForms += 1; continue; }
    const list = byCustomer.get(ident.customer.address) || [];
    list.push(item);
    byCustomer.set(ident.customer.address, list);
  }

  // Replies are normally matched by the customer's address. Also follow the reply chain
  // (In-Reply-To / References), which catches replies sent to a different address:
  // - to another outside address (e.g. the customer's other email): counted as a reply;
  // - only to the business's own addresses (e.g. hitting Reply on a website-form
  //   notification): the customer never got it, so it's recorded as "misdirected".
  const inboundById = new Map();
  for (const item of [...[...byCustomer.values()].flat(), ...orphans]) if (item.m.messageId) inboundById.set(item.m.messageId, item);
  const misdirected = new Map(); // inbound message -> [outbound]
  const orphanReplies = new Map(); // orphan form item -> [outbound]
  for (const o of unique) {
    if (o.kind !== 'out') continue;
    const target = [o.inReplyTo, ...(o.references || [])].filter(Boolean).map((id) => inboundById.get(id)).find(Boolean);
    if (!target) continue;
    const recipients = [...(o.to || []), ...(o.cc || [])].map((a) => lc(a.address));
    const customer = target.ident.customer && target.ident.customer.address;
    if (customer && recipients.includes(customer)) continue; // already matched by address
    const outside = recipients.find((a) => !ctx.isOwnAddress(a) && !ctx.isOwnDomain(a));
    if (outside && customer) {
      const list = sentTo.get(customer) || [];
      if (!list.includes(o)) { list.push(o); list.sort((a, b) => a.at - b.at); sentTo.set(customer, list); }
    } else if (outside && !customer) {
      orphanReplies.set(target, [...(orphanReplies.get(target) || []), o]);
    } else {
      misdirected.set(target.m, [...(misdirected.get(target.m) || []), o]);
    }
  }

  const enquiries = [];
  for (const [address, items] of byCustomer) {
    const outs = sentTo.get(address) || [];
    const groups = [];
    let cur = null;
    for (const item of items) {
      const lastActivity = cur ? Math.max(cur.lastAt, ...outs.filter((o) => o.at <= item.m.at && o.at >= cur.start).map((o) => o.at)) : 0;
      if (!cur || (item.m.at - lastActivity > QUIET_DAYS * DAY && !isReplyMessage(item.m))) {
        cur = { start: item.m.at, lastAt: item.m.at, items: [] };
        groups.push(cur);
      }
      cur.items.push(item);
      cur.lastAt = item.m.at;
    }
    groups.forEach((g, gi) => {
      const end = gi + 1 < groups.length ? groups[gi + 1].start : Infinity;
      const replies = outs.filter((o) => o.at >= g.start && o.at < end);
      const first = g.items[0];
      // Did the business email them first (e.g. a quote sent before this conversation)?
      const contactedBefore = outs.some((o) => o.at < g.start && o.at >= g.start - 30 * DAY);
      enquiries.push(Object.assign(makeEnquiry({
        address, name: first.ident.customer.name || first.m.from?.name || '', g, replies, opts,
        followsOurEmail: contactedBefore && isReplyMessage(first.m),
      }), { _in: g.items.map((i) => i.m), _out: replies }));
    });
  }
  // Form emails with no customer address: each is its own enquiry; replies can't be matched.
  for (const item of orphans) {
    const found = (orphanReplies.get(item) || []).sort((a, b) => a.at - b.at);
    const to = found.length ? lc(((found[0].to || [])[0] || {}).address) : '';
    enquiries.push(Object.assign(makeEnquiry({ address: to, name: '', g: { start: item.m.at, items: [item] }, replies: found, opts, unmatched: !found.length }), { _in: [item.m], _out: found }));
  }

  for (const e of enquiries) {
    const mis = e._in.flatMap((m) => misdirected.get(m) || []).sort((a, b) => a.at - b.at);
    if (!mis.length) continue;
    e._mis = mis;
    e.misdirected = mis.map((o) => ({ at: o.at, to: [...(o.to || []), ...(o.cc || [])].map((a) => a.address).join(', ') }));
    e.msgs = [...(e.msgs || []), ...mis.map((o) => ({ d: 'out', at: o.at, mb: o.mailbox, f: o.folder, uid: o.uid, mis: true }))].filter((x) => x.uid && x.f).sort((a, b) => a.at - b.at);
    if (!e.firstReplyAt) e.note = `A reply was sent to ${e.misdirected[0].to} (the business's own address) instead of the customer, so they never got it`;
  }

  // Keep enquiries that started in the period, plus earlier conversations still active in it.
  const kept = enquiries.filter((e) => e.receivedAt < opts.to && (e.receivedAt >= opts.from || e.lastInboundAt >= opts.from))
    .sort((a, b) => a.receivedAt - b.receivedAt).map((e, i) => Object.assign(e, { id: i + 1 }));
  // Replies in conversations from before the period aren't "missed enquiries".
  const keptSet = new Set(kept);
  for (const e of enquiries) {
    if (keptSet.has(e)) continue;
    [...e._in, ...e._out].filter((m) => m.at >= opts.from).forEach((m) => decided.set(orig(m), { status: 'Part of a conversation from before this period' }));
  }
  for (const e of kept) {
    const verdict = e.include ? `Counted as enquiry #${e.id}` : `Not counted (enquiry #${e.id}): ${e.reason}`;
    e._in.forEach((m, i) => decided.set(orig(m), { status: i === 0 ? verdict : (e.include ? `Customer's follow-up email in enquiry #${e.id}` : `Also from this sender (enquiry #${e.id}, not counted)`), enquiry: e.id }));
    (e._mis || []).forEach((m) => decided.set(orig(m), { status: `Reply to enquiry #${e.id} sent to the business's own address, not the customer`, enquiry: e.id }));
    e._out.forEach((m) => { if (!decided.has(orig(m))) decided.set(orig(m), { status: `Business reply in enquiry #${e.id}${e.include ? '' : ' (not counted)'}`, enquiry: e.id }); });
  }
  const log = messages.map((m) => {
    let d = decided.get(m);
    if (d && d.sameAs) d = { status: d.status, enquiry: (decided.get(d.sameAs) || {}).enquiry || null };
    if (!d) {
      if (m.at < opts.from || m.at >= opts.to) d = { status: m.at < opts.from ? 'Before the audit period (read for context only)' : 'After the audit period' };
      else if (m.kind === 'out') {
        const outside = [...(m.to || []), ...(m.cc || [])].some((a) => !ctx.isOwnAddress(a.address) && !ctx.isOwnDomain(a.address));
        d = { status: outside && isReplyMessage(m) ? 'Possible missed enquiry: a reply to someone whose enquiry isn\'t in the audited mailbox' : 'Sent email: not a reply to any enquiry in this audit' };
      }
      else d = { status: 'Not part of an enquiry in this period' };
    }
    return {
      kind: m.kind, mb: m.mailbox, f: m.folder || (m.kind === 'in' ? 'INBOX' : ''), uid: m.uid || null, at: m.at,
      fromName: (m.from && m.from.name) || '', from: (m.from && m.from.address) || '',
      to: [...(m.to || []), ...(m.cc || [])].map((a) => a.address).join(', '),
      subject: m.subject || '', status: d.status, enquiry: d.enquiry || null,
    };
  }).sort((a, b) => a.at - b.at);

  // Group the possible missed enquiries by person, for a warning on the results page.
  const missed = new Map();
  for (const l of log) {
    if (!l.status.startsWith('Possible missed enquiry')) continue;
    const key = l.to.split(',')[0].trim();
    const x = missed.get(key) || { to: key, subject: l.subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, ''), first: l.at, replies: 0 };
    x.replies += 1;
    missed.set(key, x);
  }
  return {
    possibleMissed: [...missed.values()],
    enquiries: kept.map(({ _in, _out, _mis, ...e }) => e),
    stats,
    log,
  };
}

function makeEnquiry({ address, name, g, replies, opts, followsOurEmail = false, unmatched = false }) {
  const first = g.items[0];
  const mailboxes = [...new Set(g.items.flatMap((i) => i.m.mailboxes))];
  const firstReply = replies[0] || null;
  let reason = null;
  if (first.junk && !replies.length) reason = first.junk;
  else if (g.start < opts.from) reason = 'Conversation started before this period';
  else if (followsOurEmail) reason = 'Reply to an email the business sent first';
  return {
    customerEmail: address,
    customerName: name,
    subject: first.m.subject || '(no subject)',
    receivedAt: g.start,
    lastInboundAt: g.items[g.items.length - 1].m.at,
    lastOutboundAt: replies.length ? replies[replies.length - 1].at : null,
    // Emails the business sent after the customer's latest email (2+ means they chased).
    outsAfterLastIn: replies.filter((o) => o.at > g.items[g.items.length - 1].m.at).length,
    // Where each email lives, so the conversation can be opened on request (read live, never stored).
    msgs: [...g.items.map((i) => ({ d: 'in', at: i.m.at, mb: i.m.mailbox, f: i.m.folder || 'INBOX', uid: i.m.uid })),
      ...replies.map((o) => ({ d: 'out', at: o.at, mb: o.mailbox, f: o.folder, uid: o.uid }))]
      .filter((x) => x.uid && x.f).sort((a, b) => a.at - b.at).slice(0, 40),
    ...(first.m.snippet ? { snippet: first.m.snippet } : {}),
    mailboxes,
    viaForm: first.ident.viaForm,
    inboundCount: g.items.length,
    outboundCount: replies.length,
    firstReplyAt: firstReply ? firstReply.at : null,
    replyMatchable: !unmatched,
    note: first.junk && replies.length ? `Looked like "${first.junk}" but the business replied, so it's counted` : (unmatched ? 'Website form with no customer address: replies can\'t be matched' : ''),
    include: !reason,
    reason,
  };
}

module.exports = { buildEnquiries, identify, junkReason, makeContext, normSubject, needsBody, scanBody, isCandidate, stripQuoted, QUIET_DAYS };
