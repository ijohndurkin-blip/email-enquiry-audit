const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

// Swap the mailbox reader for a fake before loading the handler.
const mailbox = require('../lib/mailbox');
const T = Date.UTC(2026, 9, 10, 10);
mailbox.readMailbox = async (acct) => {
  if (acct.password !== 'right') throw Object.assign(new Error('rejected the email or password'), { steps: [] });
  return {
    email: acct.email, providerName: 'Test host', steps: [], warnings: [], settings: {}, sentFolder: 'Sent',
    messages: [
      { kind: 'in', mailbox: acct.email, at: T, from: { address: 'c@gmail.com', name: 'C' }, replyTo: [], to: [], cc: [], subject: 'Hi', messageId: '<1@g>', inReplyTo: null, references: [], headers: {} },
      { kind: 'out', mailbox: acct.email, at: T + 3600000, from: { address: acct.email }, replyTo: [], to: [{ address: 'c@gmail.com' }], cc: [], subject: 'Re: Hi', messageId: '<2@b>', inReplyTo: '<1@g>', references: [], headers: {} },
    ],
  };
};
const handler = require('../api/audit');

function call(body, key) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'x-access-key': key };
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    handler(req, res);
  });
}

const body = (password) => ({ from: '2026-10-03T00:00:00Z', to: '2026-11-02T00:00:00Z', mailboxes: [{ email: 'a@biz.co.uk', password }] });

test('needs the access key to be configured and correct', async () => {
  delete process.env.AUDIT_ACCESS_KEY;
  assert.strictEqual((await call(body('right'), 'k')).status, 500);
  process.env.AUDIT_ACCESS_KEY = 'secret';
  assert.strictEqual((await call(body('right'), 'wrong')).status, 401);
});

test('returns enquiries and never echoes the password', async () => {
  process.env.AUDIT_ACCESS_KEY = 'secret';
  const r = await call(body('right'), 'secret');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.enquiries.length, 1);
  assert.strictEqual(r.body.enquiries[0].firstReplyAt - r.body.enquiries[0].receivedAt, 3600000);
  assert.ok(!JSON.stringify(r.body).includes('right'));
});

test('reports a mailbox that could not be read', async () => {
  process.env.AUDIT_ACCESS_KEY = 'secret';
  const r = await call(body('bad'), 'secret');
  assert.strictEqual(r.status, 422);
  assert.match(r.body.mailboxes[0].error, /rejected/);
});
