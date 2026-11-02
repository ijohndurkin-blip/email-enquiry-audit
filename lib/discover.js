// Works out a mailbox's IMAP settings from just the email address and password.
// Ported from the Rare email enquiry app (src/autoconfig.js), receiving only:
// the audit never sends mail.
// 1. Known providers by domain or MX record
// 2. Mozilla's public mail-settings database (the one Thunderbird uses)
// 3. The domain's own autoconfig file
// 4. Common hosting guesses (mail.domain, imap.domain, the MX host)
// Each candidate is tried with the real password, so what comes back is proven to work.
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');
const cheerio = require('cheerio');
const { ImapFlow } = require('imapflow');

const TIMEOUT = 10000;
const imapSSL = (host) => ({ host, port: 993, secure: true });

const PROVIDERS = {
  gmail: {
    name: 'Google (Gmail / Google Workspace)', imap: imapSSL('imap.gmail.com'),
    authHelp: 'Google needs an app password, not the normal password. Turn on 2-Step Verification for the account, then create one at myaccount.google.com/apppasswords.',
  },
  microsoft: {
    name: 'Microsoft 365 / Outlook', imap: imapSSL('outlook.office365.com'),
    authHelp: 'Microsoft has switched off password sign-in for email apps on most Microsoft 365 and Outlook.com mailboxes, so this mailbox can\'t be read with a password. Export the mail instead, or ask the IT admin.',
  },
  zoho: { name: 'Zoho Mail', imap: imapSSL('imap.zoho.com'), authHelp: 'With two-factor sign-in on Zoho, create an app-specific password in Zoho Mail settings.' },
  zohoeu: { name: 'Zoho Mail (EU)', imap: imapSSL('imap.zoho.eu'), authHelp: 'With two-factor sign-in on Zoho, create an app-specific password in Zoho Mail settings.' },
  godaddy: { name: 'GoDaddy email', imap: imapSSL('imap.secureserver.net') },
  ionos: { name: 'IONOS', imap: imapSSL('imap.ionos.co.uk') },
  ionoscom: { name: 'IONOS', imap: imapSSL('imap.ionos.com') },
  hostinger: { name: 'Hostinger', imap: imapSSL('imap.hostinger.com') },
  namecheap: { name: 'Namecheap Private Email', imap: imapSSL('mail.privateemail.com') },
  reg123: { name: '123 Reg', imap: imapSSL('imap.123-reg.co.uk') },
  onecom: { name: 'one.com', imap: imapSSL('imap.one.com') },
  fasthosts: { name: 'Fasthosts', imap: imapSSL('imap.livemail.co.uk') },
  yahoo: { name: 'Yahoo Mail', imap: imapSSL('imap.mail.yahoo.com'), authHelp: 'Yahoo needs an app password: Account security → Generate app password.' },
  aol: { name: 'AOL Mail', imap: imapSSL('imap.aol.com'), authHelp: 'AOL needs an app password: Account security → Generate app password.' },
  icloud: { name: 'iCloud Mail', imap: imapSSL('imap.mail.me.com'), authHelp: 'iCloud needs an app-specific password from appleid.apple.com.' },
  fastmail: { name: 'Fastmail', imap: imapSSL('imap.fastmail.com'), authHelp: 'Fastmail needs an app password from Settings → Privacy & Security.' },
};

const DOMAIN_PROVIDERS = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'hotmail.co.uk': 'microsoft', 'live.com': 'microsoft', 'live.co.uk': 'microsoft', 'msn.com': 'microsoft',
  'yahoo.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'ymail.com': 'yahoo', 'aol.com': 'aol',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'zoho.com': 'zoho', 'zohomail.eu': 'zohoeu', 'fastmail.com': 'fastmail',
};

const MX_PROVIDERS = [
  [/google\.com$|googlemail\.com$/, 'gmail'],
  [/outlook\.com$|office365\.us$/, 'microsoft'],
  [/zoho\.eu$/, 'zohoeu'],
  [/zoho\.(com|in)$/, 'zoho'],
  [/secureserver\.net$/, 'godaddy'],
  [/(ionos|1and1|kundenserver)\./, null], // resolved by TLD below
  [/hostinger\.|titan\.email$/, 'hostinger'],
  [/privateemail\.com$|registrar-servers\.com$/, 'namecheap'],
  [/123-reg\.co\.uk$/, 'reg123'],
  [/one\.com$/, 'onecom'],
  [/livemail\.co\.uk$|fasthosts/, 'fasthosts'],
  [/yahoodns\.net$/, 'yahoo'],
  [/icloud\.com$|me\.com$/, 'icloud'],
  [/messagingengine\.com$/, 'fastmail'],
];

function parseAutoconfigXml(xml, email) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const local = email.split('@')[0];
  const domain = email.split('@')[1];
  const user = (u) => (u || '%EMAILADDRESS%').replace('%EMAILADDRESS%', email).replace('%EMAILLOCALPART%', local).replace('%EMAILDOMAIN%', domain);
  const servers = $('incomingServer[type="imap"]').map((_, el) => ({
    host: $(el).find('hostname').first().text().trim().replace('%EMAILDOMAIN%', domain),
    port: Number($(el).find('port').first().text().trim()),
    socket: $(el).find('socketType').first().text().trim().toUpperCase(),
    username: user($(el).find('username').first().text().trim()),
  })).get().filter((s) => s.host && s.port && s.socket !== 'PLAIN');
  const i = servers.find((s) => s.socket === 'SSL') || servers[0];
  if (!i) return null;
  return {
    imap: { host: i.host, port: i.port, secure: i.socket === 'SSL', user: i.username },
    name: $('emailProvider displayName').first().text().trim() || null,
  };
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/xml,text/xml' } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function lookupMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  } catch { return []; }
}

const baseDomain = (host) => host.split('.').slice(-((/\.(co|org|ac|gov|net)\.[a-z]{2}$/.test(host)) ? 3 : 2)).join('.');

/** Gather candidate IMAP servers, most likely first. */
async function findCandidates(email, log) {
  const domain = email.split('@')[1].toLowerCase();
  const imap = [];
  let provider = DOMAIN_PROVIDERS[domain] || null;
  let providerName = null;
  const add = (cfg, source) => {
    if (cfg && !imap.some((c) => c.host === cfg.host && c.port === cfg.port)) imap.push({ ...cfg, source });
  };

  const mx = provider ? [] : await lookupMx(domain);
  if (mx.length) log(`Mail for ${domain} is handled by ${mx[0]}`);
  if (!provider) {
    for (const [re, id] of MX_PROVIDERS) {
      if (mx.some((h) => re.test(h))) { provider = id || (domain.endsWith('.uk') ? 'ionos' : 'ionoscom'); break; }
    }
  }
  if (provider) {
    providerName = PROVIDERS[provider].name;
    log(`Recognised ${providerName}`);
    add(PROVIDERS[provider].imap, provider);
    return { provider, providerName, imap };
  }

  const sources = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    ...(mx[0] ? [`https://autoconfig.thunderbird.net/v1.1/${baseDomain(mx[0])}`] : []),
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  ];
  for (const url of sources) {
    const xml = await fetchText(url);
    const cfg = xml && parseAutoconfigXml(xml, email);
    if (cfg) {
      log(`Found published settings${cfg.name ? ` for ${cfg.name}` : ''}`);
      providerName = cfg.name;
      add(cfg.imap, 'autoconfig');
      break;
    }
  }

  // Common hosting set-ups (cPanel, Plesk, most UK hosts), then the same on port 143 with STARTTLS.
  const guesses = [`mail.${domain}`, `imap.${domain}`, ...(mx[0] ? [mx[0]] : [])];
  for (const h of guesses) add(imapSSL(h), 'guess');
  add({ host: `mail.${domain}`, port: 143, secure: false }, 'guess');
  return { provider, providerName, imap };
}

function isAuthError(err) {
  return Boolean(err && (err.authenticationFailed
    || /auth|credential|password|login|LOGIN failed|invalid/i.test(`${err.responseText || ''} ${err.response || ''}`)));
}

// --- Guard against the server being pointed at private addresses ------------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicHost(host) {
  if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253) throw new Error(`"${host}" isn't a valid server name.`);
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error(`Couldn't find the server ${host}.`), { code: 'ENOTFOUND' });
  if (process.env.AUDIT_ALLOW_PRIVATE_HOSTS !== '1' && addrs.some((a) => isPrivateIp(a.address))) throw new Error(`${host} points to a private network address, which isn't allowed.`);
}


// --- Certificates ----------------------------------------------------------------
// Shared hosting often serves a certificate for the host's own server name
// (e.g. server42.hostco.com) rather than mail.yourdomain.co.uk. When that happens
// we read the names on the certificate and try one of them instead, which keeps
// the connection fully verified.

const CERT_ERROR = /CERT|certificate|self[- ]signed|altname|unable to verify|UNABLE_TO_GET_ISSUER/i;
const isCertError = (err) => Boolean(err && (CERT_ERROR.test(err.code || '') || CERT_ERROR.test(err.message || '')));

function probeCertificate(host, port) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate() || {};
      const names = [
        ...String(cert.subjectaltname || '').split(/,\s*/).filter((n) => n.startsWith('DNS:')).map((n) => n.slice(4).toLowerCase()),
        ...(cert.subject && cert.subject.CN ? [String(cert.subject.CN).toLowerCase()] : []),
      ];
      resolve({ authorized: socket.authorized, problem: socket.authorizationError ? String(socket.authorizationError) : null, names: [...new Set(names)] });
      socket.destroy();
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

function certExplanation(host, probe) {
  if (!probe) return `The mail server ${host} has a security certificate problem.`;
  if (/SELF_SIGNED|self signed/i.test(probe.problem || '')) return `The mail server ${host} uses a self-signed security certificate.`;
  if (/EXPIRED/i.test(probe.problem || '')) return `The security certificate on ${host} has expired.`;
  const names = probe.names.slice(0, 3).join(', ');
  return `The mail server's security certificate is for ${names || 'a different name'}, not ${host}.`;
}

// --- Connecting --------------------------------------------------------------------

/** Open a connection. Callers must logout(). */
async function connect(cfg, user, pass) {
  await assertPublicHost(cfg.host);
  const port = Number(cfg.port) || 993;
  const secure = cfg.secure !== false && port !== 143;
  const client = new ImapFlow({
    host: cfg.host, port, secure, auth: { user, pass }, logger: false,
    // Port 143: insist on STARTTLS so the password is never sent unencrypted.
    ...(secure ? {} : { doSTARTTLS: true }),
    ...(cfg.allowBadCert ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 45000,
  });
  client.on('error', () => {}); // a dropped connection must not crash the function
  await client.connect();
  return client;
}

const describe = (c) => `${c.host}:${Number(c.port) || 993}`;

/**
 * Sign in to a mailbox, discovering the server if no host is given.
 * Tries each likely server; on a certificate mismatch it retries using the name on the certificate.
 * Stops after the first server that rejects the password, so hosts don't lock the account.
 * @returns {Promise<{client, settings:{host,port,secure,user,allowBadCert?}, providerName, steps:string[]}>}
 * @throws Error with .steps, .help and .certProblem
 */
async function signIn({ email, password, host, port, secure, user, allowBadCert }) {
  const steps = [];
  const log = (s) => steps.push(s);
  const fail = (message, extra = {}) => Object.assign(new Error(message), { steps, ...extra });
  const deadline = Date.now() + 45000;
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('That email address doesn\'t look right.');
  if (!password) throw fail(`Enter the password for ${email}.`);

  let candidates;
  let found = { provider: null, providerName: null };
  if (host) {
    const p = Number(port) || 993;
    candidates = [{ host: String(host).trim().toLowerCase(), port: p, secure: p === 143 ? false : secure !== false, user: user || '', source: 'manual' }];
  } else {
    found = await findCandidates(email, log);
    candidates = found.imap;
  }
  const help = found.provider ? PROVIDERS[found.provider].authHelp : null;
  const usernames = (c) => [...new Set([c.user || user || email, email, email.split('@')[0]].filter(Boolean))];

  let certProblem = null;
  let lastConnError = null;
  const tried = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (tried.has(describe(c))) continue;
    tried.add(describe(c));
    if (Date.now() > deadline) { log('Stopped trying: it was taking too long.'); break; }
    for (const u of usernames(c)) {
      try {
        log(`Signing in at ${describe(c)} as ${u}…`);
        const client = await connect({ ...c, allowBadCert }, u, password);
        log(`Signed in at ${describe(c)}${allowBadCert ? ' (certificate check skipped)' : ''}.`);
        return {
          client,
          settings: { host: c.host, port: Number(c.port) || 993, secure: c.secure !== false && Number(c.port) !== 143, user: u, ...(allowBadCert ? { allowBadCert: true } : {}) },
          providerName: found.providerName, steps,
        };
      } catch (err) {
        if (isAuthError(err)) {
          log(`${c.host} said the username or password is wrong (username tried: ${u}).`);
          continue; // try the next username form on the same server
        }
        if (isCertError(err)) {
          const probe = await probeCertificate(c.host, Number(c.port) || 993);
          const why = certExplanation(c.host, probe);
          log(why);
          const alt = probe && probe.names.find((n) => !n.startsWith('*') && n !== c.host && /\./.test(n));
          certProblem = { host: c.host, message: why, names: probe ? probe.names : [], suggest: alt || null };
          if (alt && !tried.has(`${alt}:${Number(c.port) || 993}`)) {
            log(`Trying the name on the certificate instead: ${alt}`);
            candidates.splice(i + 1, 0, { ...c, host: alt, source: 'certificate' });
          }
          break;
        }
        const reason = /STARTTLS/i.test(err.message || '')
          ? 'this port doesn\'t offer encryption, so the password wasn\'t sent; use port 993 with SSL on'
          : (err.code === 'ETIMEDOUT' || /timed? ?out/i.test(err.message || '') ? 'no answer (timed out)' : (err.code || err.message));
        lastConnError = `${describe(c)}: ${reason}`;
        log(`Couldn't connect to ${describe(c)} (${reason}).`);
        break; // unreachable: no point trying other usernames here
      }
    }
    // A real server rejected the password: stop, so the host doesn't lock the mailbox.
    if (steps.some((s) => s.includes('username or password is wrong'))) {
      throw fail(`The mail server rejected the password for ${email}. Check it by signing in to webmail with the same details.`, {
        help: help || 'If the business uses two-step sign-in, it may need an "app password" instead of the normal one. Some hosts use just the part before the @ as the username: try that under Server settings.',
      });
    }
  }

  if (certProblem) {
    throw fail(`${certProblem.message} This is common on shared hosting.`, {
      certProblem,
      help: certProblem.suggest
        ? `Try ${certProblem.suggest} as the incoming server. If you trust this host, you can instead allow its certificate.`
        : 'Ask the host for the correct incoming mail server name, or, if you trust this host, allow its certificate.',
    });
  }
  if (host) throw fail(`Couldn't connect to ${lastConnError || `${host}:${Number(port) || 993}`}. Check the server name and port: usually 993 with SSL on, or 143 with SSL off.`, { help });
  throw fail(found.provider
    ? `Couldn't reach ${found.providerName}'s mail server (${lastConnError || 'no answer'}). Try again in a minute.`
    : `Couldn't find the mail server for ${email} automatically. Open "Server settings" and enter the incoming (IMAP) server shown in the business's email set-up or webmail help page.`, { help });
}

module.exports = { signIn, parseAutoconfigXml, findCandidates, isPrivateIp, isAuthError, isCertError, probeCertificate, PROVIDERS };
