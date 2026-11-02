const test = require('node:test');
const assert = require('node:assert');
const { buildEnquiries } = require('../lib/build');

const H = 3600000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 6, 9, 0); // Tue 6 Oct 2026, 10:00 London
const opts = { from: Date.UTC(2026, 9, 3), to: Date.UTC(2026, 10, 2), mailboxes: ['enquiries@darryn.co.uk', 'darryn@darryn.co.uk'] };

let n = 0;
const inMsg = (at, from, subject, extra = {}) => ({
  kind: 'in', mailbox: 'enquiries@darryn.co.uk', at, from: { address: from, name: extra.name || '' }, replyTo: extra.replyTo || [],
  to: [{ address: 'enquiries@darryn.co.uk' }], cc: [], subject, messageId: extra.messageId || `<m${n += 1}@x>`,
  inReplyTo: extra.inReplyTo || null, references: [], headers: extra.headers || {}, ...(extra.mailbox ? { mailbox: extra.mailbox } : {}),
});
const outMsg = (at, to, subject, mailbox = 'darryn@darryn.co.uk') => ({
  kind: 'out', mailbox, at, from: { address: mailbox }, replyTo: [], to: [{ address: to }], cc: [], subject, messageId: `<o${n += 1}@darryn.co.uk>`, inReplyTo: null, references: [], headers: {},
});

test('matches the first reply, across mailboxes', () => {
  const { enquiries } = buildEnquiries([
    inMsg(T0, 'jo@gmail.com', 'Boiler quote please', { name: 'Jo' }),
    outMsg(T0 + 3 * H, 'jo@gmail.com', 'Re: Boiler quote please'),
    inMsg(T0 + 4 * H, 'jo@gmail.com', 'Re: Boiler quote please', { inReplyTo: '<x>' }),
    outMsg(T0 + 5 * H, 'jo@gmail.com', 'Re: Boiler quote please', 'enquiries@darryn.co.uk'),
  ], opts);
  assert.strictEqual(enquiries.length, 1);
  const e = enquiries[0];
  assert.strictEqual(e.include, true);
  assert.strictEqual(e.firstReplyAt - e.receivedAt, 3 * H);
  assert.strictEqual(e.inboundCount, 2);
  assert.strictEqual(e.outboundCount, 2);
  assert.strictEqual(e.customerName, 'Jo');
});

test('the same email sent to both addresses counts once', () => {
  const a = inMsg(T0, 'sam@acme.com', 'Leak', { messageId: '<same@acme.com>' });
  const b = { ...a, mailbox: 'darryn@darryn.co.uk' };
  const { enquiries, stats } = buildEnquiries([a, b], opts);
  assert.strictEqual(enquiries.length, 1);
  assert.deepStrictEqual(enquiries[0].mailboxes.sort(), ['darryn@darryn.co.uk', 'enquiries@darryn.co.uk']);
  assert.strictEqual(stats.duplicates, 1);
});

test('website form emails are credited to the Reply-To customer', () => {
  const { enquiries } = buildEnquiries([
    inMsg(T0, 'wordpress@darryn.co.uk', 'New enquiry from your website', { replyTo: [{ address: 'kim@yahoo.co.uk', name: 'Kim' }] }),
    outMsg(T0 + 30 * 60000, 'kim@yahoo.co.uk', 'Your enquiry'),
  ], opts);
  assert.strictEqual(enquiries.length, 1);
  assert.strictEqual(enquiries[0].viaForm, true);
  assert.strictEqual(enquiries[0].customerEmail, 'kim@yahoo.co.uk');
  assert.strictEqual(enquiries[0].firstReplyAt - enquiries[0].receivedAt, 30 * 60000);
});

test('form emails without a customer address are counted but not reply-checked', () => {
  const { enquiries } = buildEnquiries([inMsg(T0, 'no-reply@wix.com', 'New form submission')], opts);
  assert.strictEqual(enquiries.length, 1);
  assert.strictEqual(enquiries[0].include, true);
  assert.strictEqual(enquiries[0].replyMatchable, false);
});

test('junk is left out unless the business replied', () => {
  const { enquiries } = buildEnquiries([
    inMsg(T0, 'news@screwfix.com', 'Deals this week', { headers: { listUnsubscribe: true } }),
    inMsg(T0, 'noreply@xero.com', 'Your invoice INV-1'),
    inMsg(T0, 'pat@hotmail.com', 'Automatic reply: away'),
    inMsg(T0, 'mailer-daemon@host.com', 'Undeliverable: quote'),
    inMsg(T0, 'lee@builders.co.uk', 'Question', { headers: { listUnsubscribe: true } }),
    outMsg(T0 + H, 'lee@builders.co.uk', 'Re: Question'),
  ], opts);
  const counted = enquiries.filter((e) => e.include).map((e) => e.customerEmail);
  assert.deepStrictEqual(counted, ['lee@builders.co.uk']);
  const reasons = enquiries.filter((e) => !e.include).map((e) => e.reason);
  assert.ok(reasons.includes('Newsletter or mailing list'));
  assert.ok(reasons.includes('Out-of-office or auto-reply'));
  assert.ok(reasons.includes('Bounce / delivery failure'));
  assert.ok(enquiries.find((e) => e.customerEmail === 'lee@builders.co.uk').note.includes('business replied'));
});

test('internal mail from the business itself is ignored', () => {
  const { enquiries, stats } = buildEnquiries([inMsg(T0, 'darryn@darryn.co.uk', 'Note to self')], opts);
  assert.strictEqual(enquiries.length, 0);
  assert.strictEqual(stats.internal, 1);
});

test('a customer coming back after a quiet spell is a new enquiry', () => {
  const { enquiries } = buildEnquiries([
    inMsg(T0, 'al@gmail.com', 'Radiator'),
    outMsg(T0 + H, 'al@gmail.com', 'Re: Radiator'),
    inMsg(T0 + 20 * D, 'al@gmail.com', 'Bathroom tap'),
  ], opts);
  assert.strictEqual(enquiries.length, 2);
  assert.strictEqual(enquiries[1].firstReplyAt, null);
  assert.strictEqual(enquiries[0].outboundCount, 1);
});

test('conversations from before the period are listed but not counted', () => {
  const { enquiries } = buildEnquiries([
    inMsg(opts.from - 5 * D, 'old@gmail.com', 'Kitchen'),
    inMsg(opts.from + 2 * D, 'old@gmail.com', 'Re: Kitchen', { inReplyTo: '<y>' }),
    inMsg(opts.from - 20 * D, 'gone@gmail.com', 'Old one'),
  ], opts);
  assert.strictEqual(enquiries.length, 1);
  assert.strictEqual(enquiries[0].include, false);
  assert.strictEqual(enquiries[0].reason, 'Conversation started before this period');
});

test('a reply to an email the business sent first is not a new enquiry', () => {
  const { enquiries } = buildEnquiries([
    outMsg(T0, 'cold@co.uk', 'Your quote'),
    inMsg(T0 + D, 'cold@co.uk', 'Re: Your quote', { inReplyTo: '<o@darryn.co.uk>' }),
  ], opts);
  assert.strictEqual(enquiries[0].include, false);
  assert.strictEqual(enquiries[0].reason, 'Reply to an email the business sent first');
});

test('website and service notifications are not enquiries (from a real test mailbox)', () => {
  const { enquiries } = buildEnquiries([
    inMsg(T0, 'wordpress@co.uk', '[Rare Squared Labs] New Admin Email Address', { name: 'WordPress' }),
    inMsg(T0 + H, 'googlecloud@google.com', 'Important: 30 days left in your Google Cloud Free Trial'),
    inMsg(T0 + 2 * H, 'craig@mail.com', '(no subject)'),
  ], opts);
  const by = Object.fromEntries(enquiries.map((e) => [e.customerEmail, e]));
  assert.strictEqual(by['wordpress@co.uk'].include, false);
  assert.strictEqual(by['wordpress@co.uk'].reason, 'Website or system notification');
  assert.strictEqual(by['googlecloud@google.com'].include, false);
  assert.strictEqual(by['craig@mail.com'].include, true);
});

test('the "never count" list is applied', () => {
  const { enquiries } = buildEnquiries([inMsg(T0, 'orders@supplier.co.uk', 'Delivery tomorrow')], { ...opts, ignoreSenders: ['supplier.co.uk'] });
  assert.strictEqual(enquiries[0].include, false);
  assert.strictEqual(enquiries[0].reason, 'On your "never count" list');
});

test('form emails without Reply-To use the customer address found in the text', () => {
  const { needsBody, scanBody } = require('../lib/build');
  const m = inMsg(T0, 'wordpress@darryn.co.uk', 'New message from Ian Kelly');
  assert.strictEqual(needsBody(m, 'enquiries@darryn.co.uk'), true);
  const found = scanBody('Name: Ian Kelly\nEmail: Ian.Kelly@outlook.com\nMessage: Need a boiler service\n--\nSent from enquiries@darryn.co.uk');
  Object.assign(m, { bodyEmails: found.emails, bodyName: found.name });
  const { enquiries } = buildEnquiries([m, outMsg(T0 + 2 * H, 'ian.kelly@outlook.com', 'Re: your message')], opts);
  assert.strictEqual(enquiries.length, 1);
  assert.strictEqual(enquiries[0].customerEmail, 'ian.kelly@outlook.com');
  assert.strictEqual(enquiries[0].customerName, 'Ian Kelly');
  assert.strictEqual(enquiries[0].viaForm, true);
  assert.strictEqual(enquiries[0].firstReplyAt - enquiries[0].receivedAt, 2 * H);
});

test('only possible enquiries are picked for the AI to read', () => {
  const { isCandidate, stripQuoted } = require('../lib/build');
  assert.strictEqual(isCandidate(inMsg(T0, 'jo@gmail.com', 'Quote'), 'enquiries@darryn.co.uk'), true);
  assert.strictEqual(isCandidate(inMsg(T0, 'news@shop.com', 'Deals', { headers: { listUnsubscribe: true } }), 'enquiries@darryn.co.uk'), false);
  assert.strictEqual(isCandidate(inMsg(T0, 'darryn@darryn.co.uk', 'note'), 'enquiries@darryn.co.uk'), false);
  assert.strictEqual(stripQuoted('Yes Tuesday is fine\n\nOn Mon, 5 Oct 2026, Darryn wrote:\n> old text'), 'Yes Tuesday is fine');
});

test('records follow-ups and where each email lives', () => {
  const a = inMsg(T0, 'fu@gmail.com', 'Quote', { uid: 5 });
  a.uid = 5; a.folder = 'INBOX';
  const r1 = outMsg(T0 + H, 'fu@gmail.com', 'Re: Quote'); r1.uid = 9; r1.folder = 'Sent';
  const r2 = outMsg(T0 + 4 * D, 'fu@gmail.com', 'Just checking in'); r2.uid = 10; r2.folder = 'Sent';
  const { enquiries } = buildEnquiries([a, r1, r2], opts);
  const e = enquiries[0];
  assert.strictEqual(e.outsAfterLastIn, 2);
  assert.strictEqual(e.lastOutboundAt, T0 + 4 * D);
  assert.deepStrictEqual(e.msgs.map((m) => `${m.d}:${m.f}:${m.uid}`), ['in:INBOX:5', 'out:Sent:9', 'out:Sent:10']);
});

test('records what was decided about every email (for the all-emails download)', () => {
  const a = inMsg(T0, 'jo@gmail.com', 'Quote', { messageId: '<q1@g>' });
  const dup = { ...a, mailbox: 'darryn@darryn.co.uk' };
  const news = inMsg(T0 + H, 'news@shop.com', 'Deals', { headers: { listUnsubscribe: true } });
  const internal = inMsg(T0 + H, 'darryn@darryn.co.uk', 'Note');
  const reply = outMsg(T0 + 2 * H, 'jo@gmail.com', 'Re: Quote');
  const supplier = outMsg(T0 + 3 * H, 'orders@supplier.co.uk', 'Order');
  const old = inMsg(opts.from - 20 * D, 'old@gmail.com', 'Ancient');
  const { log } = buildEnquiries([a, dup, news, internal, reply, supplier, old], opts);
  const by = (subj, kind) => log.filter((l) => l.subject === subj && (!kind || l.kind === kind)).map((l) => l.status);
  assert.match(by('Quote')[0], /^Counted as enquiry #\d/);
  assert.match(by('Quote')[1], /^Duplicate/);
  assert.match(by('Deals')[0], /^Not counted \(enquiry #\d+\): Newsletter/);
  assert.match(by('Note')[0], /internal/);
  assert.match(by('Re: Quote')[0], /^Business reply in enquiry #\d+$/);
  assert.match(by('Order')[0], /not a reply to any enquiry/);
  assert.match(by('Ancient')[0], /Before the audit period/);
  assert.strictEqual(log.length, 7);
});

test('a reply sent to the website-form address instead of the customer is flagged', () => {
  // Like Ian Kelly: the form email comes from the business's own domain, the customer is in the text.
  const form = inMsg(T0, 'john@darryn.co.uk', 'New message from Ian Kelly', { messageId: '<form1@darryn.co.uk>' });
  form.bodyEmails = ['ian@plusdane.co.uk'];
  form.uid = 3; form.folder = 'INBOX';
  const wrong = outMsg(T0 + H, 'john@darryn.co.uk', 'Re: New message from Ian Kelly');
  wrong.inReplyTo = '<form1@darryn.co.uk>'; wrong.uid = 8; wrong.folder = 'Sent';
  const { enquiries, log } = buildEnquiries([form, wrong], opts);
  assert.strictEqual(enquiries.length, 1);
  const e = enquiries[0];
  assert.strictEqual(e.customerEmail, 'ian@plusdane.co.uk');
  assert.strictEqual(e.firstReplyAt, null); // the customer never got it
  assert.strictEqual(e.misdirected.length, 1);
  assert.match(e.note, /instead of the customer/);
  assert.match(log.find((l) => l.kind === 'out').status, /sent to the business's own address/);
});

test('a reply that reaches the customer at another address counts, via the reply chain', () => {
  const q = inMsg(T0, 'sam@work.co.uk', 'Quote', { messageId: '<q9@w>' });
  const r = outMsg(T0 + 2 * H, 'sam.personal@gmail.com', 'Re: Quote');
  r.inReplyTo = '<q9@w>';
  const { enquiries } = buildEnquiries([q, r], opts);
  assert.strictEqual(enquiries[0].firstReplyAt - enquiries[0].receivedAt, 2 * H);
});

test('replies to people with no enquiry in the mailbox are listed as possible missed enquiries', () => {
  // Like Jamie Siddall: the business replied and followed up, but the original enquiry isn't in this mailbox.
  const r1 = outMsg(T0, 'jamie@hotmail.com', 'Re: I need a shop sign creating');
  const r2 = outMsg(T0 + D, 'jamie@hotmail.com', 'Re: I need a shop sign creating');
  const order = outMsg(T0, 'orders@supplier.co.uk', 'New order');
  const { possibleMissed, log } = buildEnquiries([r1, r2, order], opts);
  assert.deepStrictEqual(possibleMissed.map((x) => [x.to, x.subject, x.replies]), [['jamie@hotmail.com', 'I need a shop sign creating', 2]]);
  assert.match(log.find((l) => l.subject === 'New order').status, /not a reply to any enquiry/);
});

test('picks Archive and own folders, skips Sent, Trash, Spam and Gmail All Mail', () => {
  const { otherFolders } = require('../lib/mailbox');
  const f = (path, specialUse, flags = new Set()) => ({ path, name: path.split(/[./]/).pop(), specialUse, flags });
  const picked = otherFolders([
    f('INBOX'), f('INBOX.Sent', '\\Sent'), f('Sent Items'), f('Drafts', '\\Drafts'), f('Trash'), f('Junk', '\\Junk'),
    f('[Gmail]/All Mail', '\\All'), f('[Gmail]', undefined, new Set(['\\Noselect'])), f('Archive', '\\Archive'), f('INBOX.Quotes'), f('Customers 2026'),
  ], 'INBOX.Sent');
  assert.deepStrictEqual(picked, ['Archive', 'INBOX.Quotes', 'Customers 2026']);
});
