const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

process.env.AUDIT_ACCESS_KEY = 'secret';

// Fake the mail server side before loading the handlers.
const discover = require('../lib/discover');
const mailbox = require('../lib/mailbox');
const fakeClient = { logout: async () => {} };
const seen = [];
discover.signIn = async (a) => {
  seen.push(a);
  if (a.password !== 'right') throw Object.assign(new Error('The mail server rejected the password'), { steps: ['Signing in…'], help: 'Check it' });
  return { client: fakeClient, settings: { host: 'mail.biz.co.uk', port: 993, secure: true, user: a.email }, providerName: null, steps: ['Signed in'] };
};
mailbox.describeMailbox = async () => ({ folders: ['INBOX', 'INBOX.Sent'], sentFolder: 'INBOX.Sent', inboxCount: 120, sentCount: 40 });
const readCalls = [];
mailbox.readMailbox = async (a) => { readCalls.push(a); return { email: a.email, steps: [], warnings: [], settings: {}, sentFolder: a.sentFolder, messages: [] }; };

const connect = require('../api/connect');
const audit = require('../api/audit');
const secret = require('../lib/secret');

function call(handler, body, key = 'secret') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'x-access-key': key };
  return new Promise((resolve) => {
    const res = { setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    handler(req, res);
  });
}

test('saved connections round-trip and resist tampering', () => {
  const t = secret.seal({ email: 'a@b.co.uk', password: 'p' });
  assert.strictEqual(secret.open(t).password, 'p');
  const parts = t.split('.');
  parts[3] = `${parts[3].slice(0, -2)}AA`;
  assert.throws(() => secret.open(parts.join('.')), /can't be opened/);
  process.env.AUDIT_ACCESS_KEY = 'other';
  assert.throws(() => secret.open(t), /can't be opened/);
  process.env.AUDIT_ACCESS_KEY = 'secret';
});

test('a successful test returns settings and a token, never the password', async () => {
  const r = await call(connect, { email: 'Enquiries@Biz.co.uk', password: 'right' });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.email, 'enquiries@biz.co.uk');
  assert.strictEqual(r.body.sentFolder, 'INBOX.Sent');
  assert.strictEqual(r.body.inboxCount, 120);
  assert.ok(r.body.token);
  assert.ok(!JSON.stringify(r.body).includes('right'));
  assert.strictEqual(secret.open(r.body.token).password, 'right');
});

test('a failed test explains why and lists the steps', async () => {
  const r = await call(connect, { email: 'a@biz.co.uk', password: 'wrong' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /rejected/);
  assert.deepStrictEqual(r.body.steps, ['Signing in…']);
});

test('a saved connection can be checked again and used for an audit', async () => {
  const { body } = await call(connect, { email: 'a@biz.co.uk', password: 'right' });
  const again = await call(connect, { token: body.token });
  assert.strictEqual(again.body.ok, true);
  assert.strictEqual(seen.at(-1).host, 'mail.biz.co.uk'); // goes straight to the known server

  const r = await call(audit, { from: '2026-10-03T00:00:00Z', to: '2026-11-02T00:00:00Z', mailboxes: [{ token: body.token, sentFolder: 'Sent Items' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(readCalls.at(-1).password, 'right');
  assert.strictEqual(readCalls.at(-1).sentFolder, 'Sent Items');
});

test('connect needs the access key', async () => {
  assert.strictEqual((await call(connect, { email: 'a@biz.co.uk', password: 'right' }, 'nope')).status, 401);
});
