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
const RECEIPT_SUBJECT = /\b(receipt|your invoice|invoice (#|no\.?|number)|order confirmation|your order|payment (received|confirmation|failed)|password reset|reset your password|verify your|verification code|security alert|new sign-?in|statement is ready|renewal|subscription|webinar|unsubscribe)\b/i;

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
  const external = (m.replyTo || []).find((a) => !ctx.isOwnAddress(a.address) && !ctx.isOwnDomain(a.address));
  if (!from) return { customer: external || null, viaForm: Boolean(external) };
  const fromIsOurs = ctx.isOwnAddress(from.address) || ctx.isOwnDomain(from.address);
  const formSender = fromIsOurs || FORM_LOCAL.test(localOf(from.address));
  const formSubject = FORM_SUBJECT.test(m.subject || '');
  if ((formSender || formSubject) && external && external.address !== lc(from.address)) return { customer: external, viaForm: true };
  if (formSender && formSubject) return { customer: null, viaForm: true }; // form with no customer address
  if (fromIsOurs) return { customer: null, viaForm: false, internal: true };
  return { customer: from, viaForm: false };
}

/** Why an incoming message probably isn't a customer enquiry (null = looks genuine). */
function junkReason(m, ident) {
  const h = m.headers || {};
  const sender = ident.viaForm ? '' : localOf(m.from && m.from.address);
  const subject = m.subject || '';
  if (h.spam) return 'Marked as spam by the mail server';
  if (/^(mailer-daemon|postmaster)$/.test(sender) || BOUNCE_SUBJECT.test(subject) || (h.nullReturnPath && !ident.viaForm)) return 'Bounce / delivery failure';
  if (AUTOREPLY_SUBJECT.test(subject) || h.autoReply) return 'Out-of-office or auto-reply';
  if (h.listUnsubscribe || h.listId || ['bulk', 'list', 'junk'].includes(h.precedence)) return 'Newsletter or mailing list';
  if (h.autoSubmitted && h.autoSubmitted !== 'no' && !ident.viaForm) return 'Automated message';
  if (sender && AUTOMATED_LOCAL.test(sender)) return 'Automated sender (no-reply, notifications…)';
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

  // De-duplicate across mailboxes (one enquiry sent to both addresses, or Cc'd).
  const seen = new Map();
  const unique = [];
  for (const m of [...messages].sort((a, b) => a.at - b.at)) {
    const key = m.messageId ? `${m.kind}:${m.messageId}` : null;
    if (key && seen.has(key)) {
      const first = seen.get(key);
      if (!first.mailboxes.includes(m.mailbox)) first.mailboxes.push(m.mailbox);
      stats.duplicates += 1;
      continue;
    }
    const copy = { ...m, mailboxes: [m.mailbox] };
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
    if (m.messageId && ownMessageIds.has(m.messageId)) continue; // a copy of our own sent mail
    const ident = identify(m, ctx);
    if (ident.internal) { stats.internal += 1; continue; }
    stats.inbound += 1;
    const item = { m, ident, junk: junkReason(m, ident) };
    if (!ident.customer) { orphans.push(item); stats.unattributedForms += 1; continue; }
    const list = byCustomer.get(ident.customer.address) || [];
    list.push(item);
    byCustomer.set(ident.customer.address, list);
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
      enquiries.push(makeEnquiry({
        address, name: first.ident.customer.name || first.m.from?.name || '', g, replies, opts,
        followsOurEmail: contactedBefore && isReplyMessage(first.m),
      }));
    });
  }
  // Form emails with no customer address: each is its own enquiry; replies can't be matched.
  for (const item of orphans) {
    enquiries.push(makeEnquiry({ address: '', name: '', g: { start: item.m.at, items: [item] }, replies: [], opts, unmatched: true }));
  }

  return {
    // Keep enquiries that started in the period, plus earlier conversations still active in it.
    enquiries: enquiries.filter((e) => e.receivedAt < opts.to && (e.receivedAt >= opts.from || e.lastInboundAt >= opts.from)).sort((a, b) => a.receivedAt - b.receivedAt).map((e, i) => ({ ...e, id: i + 1 })),
    stats,
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

module.exports = { buildEnquiries, identify, junkReason, makeContext, normSubject, QUIET_DAYS };
