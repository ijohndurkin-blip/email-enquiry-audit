// Saved mailbox connections. The browser keeps an encrypted token; only this server
// (with its key) can read the password inside it. AES-256-GCM.
const crypto = require('node:crypto');

function key() {
  const base = process.env.AUDIT_ENCRYPTION_KEY || process.env.AUDIT_ACCESS_KEY;
  if (!base) throw new Error('No encryption key configured');
  return crypto.createHash('sha256').update(`enquiry-audit/mailbox-token/v1/${base}`).digest();
}

/** @param {{email, password, host, port, secure, user, allowBadCert?, sentFolder?}} conn */
function seal(conn) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...conn, v: 1, at: Date.now() }), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** @returns the connection, or throws if the token is invalid or was made with another key. */
function open(token) {
  const [v, iv, tag, body] = String(token || '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('Saved connection is not valid');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('This saved connection can\'t be opened (the access key may have changed). Connect the mailbox again.');
  }
}

module.exports = { seal, open };
