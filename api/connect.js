// POST /api/connect
// Tests a mailbox: finds the server, signs in (read-only), finds the Sent folder.
// On success returns an encrypted token the browser can keep, so the mailbox
// doesn't have to be entered again. Body: { email, password, host?, port?, secure?,
// user?, allowBadCert?, sentFolder? } or { token } to re-check a saved one.
const { signIn } = require('../lib/discover');
const { describeMailbox } = require('../lib/mailbox');
const secret = require('../lib/secret');
const { guard, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;

  let account;
  try {
    account = body.token ? { ...secret.open(body.token), ...(body.sentFolder ? { sentFolder: body.sentFolder } : {}) } : body;
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message });
  }
  const email = String(account.email || '').trim().toLowerCase();

  let session;
  try {
    session = await signIn({
      email, password: account.password, host: account.host || undefined, port: account.port || undefined,
      secure: account.secure !== false, user: account.user || undefined, allowBadCert: Boolean(account.allowBadCert),
    });
  } catch (err) {
    return send(res, 200, { ok: false, email, error: err.message, help: err.help || null, steps: err.steps || [], certProblem: err.certProblem || null });
  }

  try {
    const info = await describeMailbox(session.client, account.sentFolder);
    const steps = [...session.steps, `Inbox: ${info.inboxCount ?? '?'} emails.`, info.sentFolder ? `Sent folder: "${info.sentFolder}" (${info.sentCount ?? '?'} emails).` : 'No Sent folder found: choose one below.'];
    const conn = { email, password: account.password, ...session.settings, ...(info.sentFolder ? { sentFolder: info.sentFolder } : {}) };
    return send(res, 200, {
      ok: true, email, providerName: session.providerName, steps,
      settings: session.settings, folders: info.folders, sentFolder: info.sentFolder,
      inboxCount: info.inboxCount, sentCount: info.sentCount,
      token: secret.seal(conn),
    });
  } catch (err) {
    return send(res, 200, { ok: false, email, error: `Signed in, but couldn't read the folders (${err.message}).`, steps: session.steps });
  } finally {
    await session.client.logout().catch(() => {});
  }
};
