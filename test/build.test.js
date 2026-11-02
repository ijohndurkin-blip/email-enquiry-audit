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
