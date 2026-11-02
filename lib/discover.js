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

  // Common hosting set-ups (cPanel, Plesk, most UK hosts).
  for (const h of [`mail.${domain}`, `imap.${domain}`, ...(mx[0] ? [mx[0]] : [])]) add(imapSSL(h), 'guess');
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

// -----------------------------------------------------------------------------

/** Open a connection. Callers must logout(). */
async function connect(cfg, user, pass) {
  await assertPublicHost(cfg.host);
  const client = new ImapFlow({
    host: cfg.host, port: Number(cfg.port) || 993, secure: cfg.secure !== false, auth: { user, pass }, logger: false,
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 45000,
  });
  client.on('error', () => {}); // a dropped connection must not crash the function
  await client.connect();
  return client;
}

/**
 * Sign in to a mailbox, discovering the server if no host is given.
 * @returns {Promise<{client, settings:{host,port,secure,user}, providerName, steps:string[]}>}
 */
async function signIn({ email, password, host, port, secure, user }) {
  const steps = [];
  const log = (s) => steps.push(s);
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('That email address doesn\'t look right.'), { steps });
  if (!password) throw Object.assign(new Error(`Enter the password for ${email}.`), { steps });

  if (host) {
    const cfg = { host: String(host).trim().toLowerCase(), port: Number(port) || 993, secure: secure !== false };
    const u = user || email;
    log(`Signing in at ${cfg.host}…`);
    try {
      const client = await connect(cfg, u, password);
      return { client, settings: { ...cfg, user: u }, providerName: null, steps };
    } catch (err) {
      throw Object.assign(new Error(isAuthError(err)
        ? `${cfg.host} rejected the email or password for ${email}.`
        : `Couldn't connect to ${cfg.host}:${cfg.port} (${err.code || err.message}).`), { steps });
    }
  }

  const found = await findCandidates(email, log);
  const help = found.provider && PROVIDERS[found.provider].authHelp;
  const users = (c) => [...new Set([c.user || email, email, email.split('@')[0]])];
  let authFailed = false;
  let connError = null;
  for (const c of found.imap) {
    for (const u of users(c)) {
      try {
        log(`Trying to sign in at ${c.host}…`);
        const client = await connect(c, u, password);
        log(`Signed in (${c.host})`);
        return { client, settings: { host: c.host, port: c.port, secure: c.secure, user: u }, providerName: found.providerName, steps };
      } catch (err) {
        if (isAuthError(err)) { authFailed = true; continue; }
        connError = connError || `${c.host}: ${err.code || err.message}`;
        break; // server unreachable: no point trying other usernames
      }
    }
    if (authFailed && c.source !== 'guess') break; // don't hammer guesses after a real server said no
  }
  const message = authFailed
    ? `The mail server for ${email} was found but it rejected the email or password.`
    : found.provider
      ? `Couldn't reach ${found.providerName}'s mail server (${connError}). Try again shortly.`
      : `Couldn't find the mail server for ${email} automatically. Open "Server settings" and enter the incoming (IMAP) server from the email host.`;
  throw Object.assign(new Error(message), { steps, help });
}

module.exports = { signIn, parseAutoconfigXml, findCandidates, isPrivateIp, isAuthError, PROVIDERS };
