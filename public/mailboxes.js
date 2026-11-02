// Mailbox connections: enter an email and password, test the connection, keep it.
// A connected mailbox is kept as an encrypted token from the server; the password
// itself is never stored in the browser.
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let seq = 0;
  let list = [];
  let el = null;
  let opts = { api: null, onChange: () => {} };

  function blank(v = {}) {
    return {
      id: `mb${seq += 1}`, email: '', password: '', host: '', port: '', user: '', secure: true, allowBadCert: false,
      conn: null, result: null, busy: false, editing: true, ...v,
    };
  }
  const find = (id) => list.find((m) => m.id === id);
  const changed = () => opts.onChange();

  function render() {
    el.innerHTML = list.map(card).join('');
  }

  function card(m) {
    if (m.conn && !m.editing) return connectedCard(m);
    const showServer = Boolean(m.host || m.user || m.allowBadCert || (m.result && !m.result.ok && /server|certificate/i.test(`${m.result.error} ${m.result.help}`)));
    return `<div class="mailbox" data-id="${m.id}">
      <div class="row">
        <label class="field">Email address <input type="email" data-k="email" value="${esc(m.email)}" placeholder="enquiries@business.co.uk" autocomplete="off" spellcheck="false"></label>
        <label class="field">Password <input type="password" data-k="password" value="${esc(m.password)}" autocomplete="new-password" placeholder="${m.conn ? 'enter it again to change' : ''}"></label>
        <button type="button" class="remove" data-act="remove" title="Remove this mailbox" aria-label="Remove this mailbox">×</button>
      </div>
      <details class="more"${showServer ? ' open' : ''}>
        <summary>Server settings <small>(leave empty and it finds them itself)</small></summary>
        <div class="row">
          <label class="field">Incoming (IMAP) server <input data-k="host" value="${esc(m.host)}" placeholder="mail.business.co.uk" spellcheck="false"></label>
          <label class="field narrow">Port <input type="number" data-k="port" value="${esc(m.port)}" placeholder="993"></label>
          <label class="field">Username <input data-k="user" value="${esc(m.user)}" placeholder="usually the email address" spellcheck="false"></label>
        </div>
        <label class="check"><input type="checkbox" data-k="secure"${m.secure ? ' checked' : ''}> SSL/TLS (port 993). Untick for port 143, which still encrypts with STARTTLS.</label>
        <label class="check"><input type="checkbox" data-k="allowBadCert"${m.allowBadCert ? ' checked' : ''}> Allow this server's certificate even if it doesn't match <small>(only for a host you trust)</small></label>
      </details>
      <div class="mb-actions">
        <button type="button" class="primary small" data-act="test"${m.busy ? ' disabled' : ''}>${m.busy ? '<span class="spinner light"></span>Testing…' : 'Test connection'}</button>
        ${m.conn ? '<button type="button" class="link" data-act="cancel">Cancel</button>' : ''}
        <span class="hint">${m.busy ? 'Finding the mail server and signing in. This can take up to 30 seconds.' : 'Signs in read-only and remembers the mailbox on this browser.'}</span>
      </div>
      ${resultBox(m)}
    </div>`;
  }

  function resultBox(m) {
    const r = m.result;
    if (!r || r.ok) return '';
    const certName = r.certProblem && r.certProblem.suggest && r.certProblem.suggest !== m.host ? r.certProblem.suggest : null;
    return `<div class="result bad">
      <strong>${esc(r.error)}</strong>
      ${r.help ? `<p>${esc(r.help)}</p>` : ''}
      <div class="fix-actions">
        ${certName ? `<button type="button" class="secondary small" data-act="use-host" data-host="${esc(certName)}">Use ${esc(certName)}</button>` : ''}
        ${r.certProblem && !m.allowBadCert ? '<button type="button" class="secondary small" data-act="allow-cert">Allow this certificate and try again</button>' : ''}
      </div>
      ${steps(r.steps)}
    </div>`;
  }

  function steps(list) {
    if (!list || !list.length) return '';
    return `<details class="steps"><summary>What it tried</summary><ol>${list.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>`;
  }

  function connectedCard(m) {
    const c = m.conn;
    const s = c.settings || {};
    const checked = c.checkedAt ? new Date(c.checkedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const folders = c.folders || [];
    const r = m.result;
    return `<div class="mailbox connected" data-id="${m.id}">
      <div class="conn-head">
        <span class="tick" aria-hidden="true">✓</span>
        <div class="conn-main">
          <strong>${esc(c.email)}</strong>
          <small>Connected to ${esc(s.host)}:${esc(s.port)}${c.providerName ? ` (${esc(c.providerName)})` : ''}${s.allowBadCert ? ' · certificate check off' : ''}${checked ? ` · checked ${esc(checked)}` : ''}</small>
        </div>
        <div class="conn-actions">
          <button type="button" class="secondary small" data-act="retest"${m.busy ? ' disabled' : ''}>${m.busy ? '<span class="spinner"></span>Checking…' : 'Check again'}</button>
          <button type="button" class="secondary small" data-act="edit">Change</button>
          <button type="button" class="remove" data-act="remove" title="Remove this mailbox" aria-label="Remove this mailbox">×</button>
        </div>
      </div>
      <div class="conn-info">
        <span>Inbox: <b>${c.inboxCount == null ? '?' : Number(c.inboxCount).toLocaleString('en-GB')}</b> emails</span>
        <label>Sent folder:
          <select data-k="sentFolder">
            ${c.sentFolder ? '' : '<option value="">Choose the Sent folder…</option>'}
            ${folders.map((f) => `<option${f === c.sentFolder ? ' selected' : ''}>${esc(f)}</option>`).join('')}
          </select>
        </label>
      </div>
      ${c.sentFolder ? '' : '<p class="result warn">No Sent folder was found. Choose the folder where this mailbox keeps sent emails, or reply times can\'t be measured.</p>'}
      ${r && !r.ok ? `<div class="result bad"><strong>${esc(r.error)}</strong>${r.help ? `<p>${esc(r.help)}</p>` : ''}${steps(r.steps)}</div>` : ''}
    </div>`;
  }

  async function test(m, { useToken = false } = {}) {
    m.busy = true;
    m.result = null;
    render();
    let r;
    try {
      r = await opts.api('/api/connect', useToken
        ? { token: m.conn.token, sentFolder: m.conn.sentFolder }
        : { email: m.email.trim(), password: m.password, host: m.host.trim(), port: m.port, user: m.user.trim(), secure: m.secure, allowBadCert: m.allowBadCert });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    m.busy = false;
    if (r.ok) {
      m.conn = {
        email: r.email, token: r.token, settings: r.settings, providerName: r.providerName, folders: r.folders,
        sentFolder: r.sentFolder || (m.conn && m.conn.sentFolder) || '', inboxCount: r.inboxCount, sentCount: r.sentCount, checkedAt: Date.now(),
      };
      Object.assign(m, { email: r.email, password: '', editing: false, result: { ok: true, steps: r.steps } });
      if (!useToken) Object.assign(m, { host: r.settings.host, port: String(r.settings.port), user: r.settings.user, secure: r.settings.secure, allowBadCert: Boolean(r.settings.allowBadCert) });
    } else {
      m.result = r;
    }
    render();
    changed();
  }

  function onInput(e) {
    const box = e.target.closest('.mailbox');
    const k = e.target.dataset.k;
    if (!box || !k) return;
    const m = find(box.dataset.id);
    if (k === 'sentFolder') {
      m.conn.sentFolder = e.target.value;
      render();
      changed();
      return;
    }
    m[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const m = find(b.closest('.mailbox').dataset.id);
    const act = b.dataset.act;
    if (act === 'remove') {
      if (m.conn && !confirm(`Remove ${m.conn.email} from this business?`)) return;
      list = list.filter((x) => x !== m);
      if (!list.length) list.push(blank());
      render();
      changed();
    } else if (act === 'test') {
      if (!m.email.trim()) return focus(m, 'email');
      if (!m.password) return focus(m, 'password');
      test(m);
    } else if (act === 'retest') {
      test(m, { useToken: true });
    } else if (act === 'edit') {
      Object.assign(m, { editing: true, result: null });
      render();
      focus(m, 'password');
    } else if (act === 'cancel') {
      Object.assign(m, { editing: false, result: null, password: '' });
      render();
    } else if (act === 'use-host') {
      Object.assign(m, { host: b.dataset.host, port: m.port || '993' });
      test(m);
    } else if (act === 'allow-cert') {
      m.allowBadCert = true;
      test(m);
    }
  }

  function focus(m, k) {
    const input = el.querySelector(`.mailbox[data-id="${m.id}"] [data-k="${k}"]`);
    if (input) input.focus();
  }

  root.Mailboxes = {
    init(container, options) {
      el = container;
      opts = { ...opts, ...options };
      el.addEventListener('input', onInput);
      el.addEventListener('change', onInput);
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input[data-k]')) {
          e.preventDefault();
          const btn = e.target.closest('.mailbox').querySelector('[data-act="test"]');
          if (btn) btn.click();
        }
      });
      this.load([]);
    },
    add() {
      list.push(blank());
      render();
      focus(list[list.length - 1], 'email');
    },
    /** For saving a business. Tokens only with { tokens: true }; passwords never. */
    snapshot({ tokens = false } = {}) {
      return list.filter((m) => m.email || m.conn).map((m) => ({
        email: m.conn ? m.conn.email : m.email.trim(), host: m.host, port: m.port, user: m.user, secure: m.secure, allowBadCert: m.allowBadCert,
        ...(m.conn ? { conn: { ...m.conn, token: tokens ? m.conn.token : undefined } } : {}),
      }));
    },
    load(items) {
      list = (items || []).map((it) => blank({
        email: it.email || '', host: it.host || '', port: it.port || '', user: it.user || '', secure: it.secure !== false, allowBadCert: Boolean(it.allowBadCert),
        conn: it.conn && it.conn.token ? it.conn : null,
        editing: !(it.conn && it.conn.token),
      }));
      if (!list.length) list.push(blank());
      render();
    },
    /** What the audit needs for each mailbox. */
    forAudit() {
      return list.map((m) => {
        if (m.conn && !m.editing) return { token: m.conn.token, sentFolder: m.conn.sentFolder || undefined };
        if (m.email.trim() && m.password) return { email: m.email.trim(), password: m.password, host: m.host.trim(), port: m.port, user: m.user.trim(), secure: m.secure, allowBadCert: m.allowBadCert };
        return null;
      }).filter(Boolean);
    },
    pending() { return list.filter((m) => (m.editing || !m.conn) && m.email.trim() && !m.password).map((m) => m.email.trim()); },
    connectedCount() { return list.filter((m) => m.conn && !m.editing).length; },
    firstEmail() { const m = list.find((x) => x.conn || x.email); return m ? (m.conn ? m.conn.email : m.email) : ''; },
  };
}(window));
