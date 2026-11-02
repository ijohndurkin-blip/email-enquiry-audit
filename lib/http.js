// Small helpers shared by the API functions.
const crypto = require('node:crypto');

/** null = no key configured, true/false = matches */
function keyMatches(given) {
  const expected = process.env.AUDIT_ACCESS_KEY || '';
  if (!expected) return null;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100000) throw new Error('Request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Checks method and access key; returns the parsed body, or null after sending an error. */
async function guard(req, res) {
  if (req.method !== 'POST') { send(res, 405, { error: 'Use POST.' }); return null; }
  const ok = keyMatches(req.headers['x-access-key']);
  if (ok === null) { send(res, 500, { error: 'This audit tool has no access key set. In Vercel, add an environment variable called AUDIT_ACCESS_KEY, then redeploy.' }); return null; }
  if (!ok) { send(res, 401, { error: 'Wrong access key.' }); return null; }
  try { return await readBody(req); } catch { send(res, 400, { error: 'Couldn\'t read the request.' }); return null; }
}

module.exports = { keyMatches, readBody, send, guard };
