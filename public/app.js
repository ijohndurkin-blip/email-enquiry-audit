/* global EnquiryMetrics, Mailboxes */
(function () {
  const M = EnquiryMetrics;
  const DAY = 86400000;
  const $ = (sel, el = document) => el.querySelector(sel);
  const form = $('#setup');
  const statusEl = $('#status');
  const resultsEl = $('#results');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PROFILES_KEY = 'auditProfiles';

  let audit = null; // { result }
  let tab = 'counted';
  let profileId = null; // the saved business currently open
  let aiStatus = { ai: false, model: null }; // what the server has switched on
  let aiMessage = ''; // progress or errors from AI sorting, shown above the results
  let aiBusy = false;
  let neverOpen = null; // the enquiry whose "never count" choices are showing
  const FREE_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|aol|icloud|me|mac|btinternet|sky|virginmedia|talktalk|proton|protonmail|gmx|mail)\./;
  const NEVER = 'On your "never count" list';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode or full */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const num = (x, d = 0) => (x == null ? '–' : (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('en-GB'));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // --- Talking to the server -----------------------------------------------------

  function accessKey() {
    const k = form.accessKey.value.trim();
    if (k) store.set('auditAccessKey', k);
    return k;
  }

  async function api(path, body) {
    const key = accessKey();
    if (!key) {
      form.accessKey.focus();
      throw new Error('Enter the access key at the top of the page first.');
    }
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': key }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(res.status === 504 ? 'The mail server took too long to answer. Try again, or try a shorter period.' : `The server replied with an error (${res.status}).`);
    if (res.status === 401 || res.status === 500) { form.accessKey.focus(); throw new Error(data.error); }
    if (!res.ok && !('ok' in data)) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data });
    return data;
  }

  /** Ask the server which optional features are on (AI sorting). */
  async function checkStatus() {
    if (!form.accessKey.value.trim()) return;
    try {
      const r = await api('/api/status', {});
      aiStatus = { ai: Boolean(r.ai), model: r.aiModel };
    } catch { aiStatus = { ai: false, model: null }; }
    $('#aiRow').hidden = !aiStatus.ai;
    $('#aiOff').hidden = aiStatus.ai;
    if (audit) render();
  }

  // --- Saved businesses -------------------------------------------------------------

  function profiles() {
    try { return JSON.parse(store.get(PROFILES_KEY) || '[]'); } catch { return []; }
  }

  function renderProfiles() {
    const list = profiles();
    $('#profileSel').innerHTML = `<option value="">${list.length ? '+ New business' : 'None saved yet'}</option>${list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${esc(p.id)}"${p.id === profileId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    $('#deleteProfile').hidden = !profileId;
  }

  /** Save the open business (only once at least one mailbox is connected). */
  function saveProfile() {
    if (!Mailboxes.connectedCount() && !profileId) return;
    const list = profiles();
    const name = form.businessName.value.trim() || (Mailboxes.firstEmail().split('@')[1] || 'Business');
    if (!profileId) profileId = `p${Date.now().toString(36)}`;
    const entry = { id: profileId, name, savedAt: Date.now(), settings: settingsSnapshot({ tokens: true }) };
    const i = list.findIndex((p) => p.id === profileId);
    if (i >= 0) list[i] = entry; else list.push(entry);
    store.set(PROFILES_KEY, JSON.stringify(list));
    store.set('auditLastProfile', profileId);
    renderProfiles();
  }

  function openProfile(id) {
    const p = profiles().find((x) => x.id === id);
    profileId = p ? p.id : null;
    store.set('auditLastProfile', profileId || '');
    applySettings(p ? p.settings : null);
    audit = null;
    resultsEl.hidden = true;
    setStatus(p ? `Opened ${esc(p.name)}.` : '', p ? 'ok' : '');
    renderProfiles();
  }

  function deleteProfile() {
    const p = profiles().find((x) => x.id === profileId);
    if (!p || !confirm(`Delete the saved business "${p.name}" and its mailbox connections from this browser?`)) return;
    store.set(PROFILES_KEY, JSON.stringify(profiles().filter((x) => x.id !== profileId)));
    openProfile(null);
  }

  // --- Setup form -------------------------------------------------------------

  function defaultDates() {
    const today = new Date();
    form.aTo.value = iso(today);
    form.aFrom.value = iso(new Date(today.getTime() - 29 * DAY));
  }

  function initForm() {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
    const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [here]);
    form.tz.innerHTML = zones.map((z) => `<option${z === here ? ' selected' : ''}>${esc(z)}</option>`).join('');
    $('#workDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="check day"><input type="checkbox" value="${d}"${d >= 1 && d <= 5 ? ' checked' : ''}> ${DAYS[d]}</label>`).join('');
    defaultDates();
    form.accessKey.value = store.get('auditAccessKey') || '';
    form.accessKey.addEventListener('change', () => { accessKey(); checkStatus(); });

    Mailboxes.init($('#mailboxes'), { api, onChange: saveProfile });
    $('#addMailbox').addEventListener('click', () => Mailboxes.add());
    $('#profileSel').addEventListener('change', (e) => openProfile(e.target.value || null));
    $('#deleteProfile').addEventListener('click', deleteProfile);
    form.compare.addEventListener('change', syncCompare);

    // Changing hours, minutes or periods re-works the numbers without reading the mailboxes again.
    ['tz', 'workStart', 'workEnd', 'minsA', 'minsB', 'aFrom', 'aTo', 'bFrom', 'bTo', 'compare', 'businessName', 'otherAddresses', 'ignoreSenders', 'about', 'useAi'].forEach((n) => form[n].addEventListener('change', () => {
      if (audit) render();
      if (profileId) saveProfile();
    }));
    $('#workDays').addEventListener('change', () => { if (audit) render(); if (profileId) saveProfile(); });
    form.addEventListener('submit', run);
    $('#openFile').addEventListener('change', openSaved);

    const last = store.get('auditLastProfile');
    if (last && profiles().some((p) => p.id === last)) openProfile(last);
    else { renderProfiles(); syncCompare(); }
    if (!form.accessKey.value) form.accessKey.focus();
    else checkStatus();
  }

  function syncCompare() {
    const on = form.compare.checked;
    $('#afterRow').hidden = !on;
    document.querySelectorAll('.after-only').forEach((el) => { el.hidden = !on; });
  }

  function work() {
    return {
      tz: form.tz.value,
      workStart: form.workStart.value || '09:00',
      workEnd: form.workEnd.value || '17:30',
      workDays: [...$('#workDays').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    };
  }

  // A date picked in the form, as the start of that day in the chosen time zone.
  function dayStart(value, tz) {
    const [y, m, d] = value.split('-').map(Number);
    return M.localToUtc(y, m, d, 0, 0, tz);
  }

  function periods() {
    const { tz } = work();
    const list = [];
    const mk = (label, f, t, mins) => {
      if (!f || !t) return;
      const from = dayStart(f, tz);
      const to = Math.min(dayStart(t, tz) + DAY, Date.now());
      if (to > from) list.push({ label, from, to, mins: Number(mins) || null });
    };
    mk('Before', form.aFrom.value, form.aTo.value, form.minsA.value);
    if (form.compare.checked) mk('After', form.bFrom.value, form.bTo.value, form.minsB.value);
    return list;
  }

  function setStatus(html, kind = '') {
    statusEl.className = kind;
    statusEl.innerHTML = html;
  }

  async function run(ev) {
    ev.preventDefault();
    const ps = periods();
    if (!ps.length) return setStatus('Choose the dates to audit.', 'error');
    const pending = Mailboxes.pending();
    if (pending.length) return setStatus(`Enter the password for ${esc(pending.join(', '))} and press Test connection, or remove it.`, 'error');
    const mailboxes = Mailboxes.forAudit();
    if (!mailboxes.length) return setStatus('Connect at least one mailbox first.', 'error');
    const btn = $('#runBtn');
    btn.disabled = true;
    setStatus('<span class="spinner"></span> Reading the mailboxes. This usually takes 10–40 seconds…');
    try {
      const data = await api('/api/audit', {
        from: new Date(Math.min(...ps.map((p) => p.from))).toISOString(),
        to: new Date(Math.max(...ps.map((p) => p.to))).toISOString(),
        mailboxes,
        otherAddresses: form.otherAddresses.value,
        ignoreSenders: form.ignoreSenders.value,
        withText: useAi(),
      });
      audit = { result: data, withText: useAi() };
      tab = 'counted';
      aiMessage = '';
      setStatus('');
      render();
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (audit.withText) aiSort();
    } catch (err) {
      setStatus(`<strong>${esc(err.message)}</strong>${mailboxErrors(err.data && err.data.mailboxes)}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  const useAi = () => aiStatus.ai && form.useAi.checked;

  // --- AI sorting -------------------------------------------------------------------

  /** Enquiries the rules counted that the AI hasn't checked yet (your own ticks are never overridden). */
  const aiCandidates = () => (audit ? audit.result.enquiries.filter((e) => e.include && e.manual == null && !e.ai) : []);

  async function aiSort() {
    if (aiBusy || !audit) return;
    const todo = aiCandidates();
    if (!todo.length) { aiMessage = 'AI check: nothing left to check.'; render(); return; }
    aiBusy = true;
    const business = { name: form.businessName.value.trim(), about: form.about.value.trim() };
    const BATCH = 15;
    let done = 0;
    let moved = 0;
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        aiMessage = `<span class="spinner"></span> AI is checking the emails: ${done} of ${todo.length} done…`;
        render();
        const batch = todo.slice(i, i + BATCH);
        const r = await api('/api/classify', {
          business,
          items: batch.map((e) => ({
            id: e.id, fromName: e.customerName, fromEmail: e.customerEmail, subject: e.subject,
            viaForm: e.viaForm, replied: Boolean(e.firstReplyAt), snippet: e.snippet || '',
          })),
        });
        for (const v of r.results || []) {
          const e = audit.result.enquiries.find((x) => x.id === v.id);
          if (!e || e.manual != null) continue;
          e.ai = { category: v.category, label: v.label, reason: v.reason, enquiry: v.enquiry };
          if (!v.enquiry) {
            e.include = false;
            e.reason = `AI: ${v.label}. ${v.reason}`;
            moved += 1;
          }
        }
        done += batch.length;
      }
      aiMessage = `AI checked ${done} email${done === 1 ? '' : 's'} and moved ${moved} to Not counted. Check the Not counted tab and tick any it got wrong.`;
    } catch (err) {
      aiMessage = `<span class="bad">${esc(err.message)}</span> The ${done} checked so far are kept; press "Check with AI" to try the rest.`;
    } finally {
      aiBusy = false;
      render();
    }
  }

  // --- Never count -------------------------------------------------------------------

  const ignoreList = () => form.ignoreSenders.value.split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const onList = (email, list = ignoreList()) => Boolean(email) && list.some((x) => email.toLowerCase().includes(x));

  function neverCount(entry) {
    const list = ignoreList();
    if (!list.includes(entry)) form.ignoreSenders.value = [...list, entry].join('\n');
    let n = 0;
    for (const e of audit.result.enquiries) {
      if (!onList(e.customerEmail, [entry]) || e.manual === true || e.reason === NEVER) continue;
      e.before = { include: e.include, reason: e.reason || null };
      e.include = false;
      e.reason = NEVER;
      n += 1;
    }
    neverOpen = null;
    if (profileId || Mailboxes.connectedCount()) saveProfile();
    aiMessage = `Mail from <b>${esc(entry)}</b> won't be counted for this business from now on${n ? ` (${n} in this audit)` : ''}. Undo it with "Count again", or under More options.`;
    render();
  }

  function removeNever(email) {
    const keep = ignoreList().filter((x) => !email.toLowerCase().includes(x));
    form.ignoreSenders.value = keep.join('\n');
    for (const e of audit.result.enquiries) {
      if (e.reason !== NEVER || onList(e.customerEmail, keep)) continue;
      e.include = e.before ? e.before.include : true;
      e.reason = e.before ? e.before.reason : null;
      delete e.before;
    }
    if (profileId) saveProfile();
    render();
  }

  function mailboxErrors(list) {
    if (!list) return '';
    return `<ul class="mb-errors">${list.filter((m) => !m.ok).map((m) => `<li><strong>${esc(m.email)}:</strong> ${esc(m.error)}${m.help ? `<br><small>${esc(m.help)}</small>` : ''}</li>`).join('')}</ul>`;
  }

  // --- Saving and opening ------------------------------------------------------

  function settingsSnapshot({ tokens = false } = {}) {
    const w = work();
    return {
      businessName: form.businessName.value, about: form.about.value, useAi: form.useAi.checked, ...w,
      aFrom: form.aFrom.value, aTo: form.aTo.value, compare: form.compare.checked, bFrom: form.bFrom.value, bTo: form.bTo.value,
      minsA: form.minsA.value, minsB: form.minsB.value,
      mailboxes: Mailboxes.snapshot({ tokens }), // passwords are never saved
      otherAddresses: form.otherAddresses.value, ignoreSenders: form.ignoreSenders.value,
    };
  }

  function applySettings(s) {
    if (!s) {
      ['businessName', 'about', 'minsA', 'minsB', 'bFrom', 'bTo', 'otherAddresses', 'ignoreSenders'].forEach((k) => { form[k].value = ''; });
      form.compare.checked = false;
      form.useAi.checked = false;
      defaultDates();
      Mailboxes.load([]);
      syncCompare();
      return;
    }
    ['businessName', 'about', 'aFrom', 'aTo', 'bFrom', 'bTo', 'minsA', 'minsB', 'workStart', 'workEnd', 'otherAddresses', 'ignoreSenders'].forEach((k) => { if (s[k] != null) form[k].value = s[k]; });
    if (s.tz) form.tz.value = s.tz;
    form.useAi.checked = Boolean(s.useAi);
    form.compare.checked = Boolean(s.compare);
    if (Array.isArray(s.workDays)) $('#workDays').querySelectorAll('input').forEach((i) => { i.checked = s.workDays.includes(Number(i.value)); });
    if (Array.isArray(s.mailboxes)) Mailboxes.load(s.mailboxes);
    syncCompare();
  }

  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const fileBase = () => `enquiry-audit-${(form.businessName.value || 'business').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${form.aFrom.value}`;

  function saveAudit() {
    // The audit file carries no passwords or connection tokens.
    // Email text read for the AI check isn't kept in the file either.
    const result = { ...audit.result, enquiries: audit.result.enquiries.map(({ snippet, ...e }) => e) };
    download(`${fileBase()}.json`, 'application/json', JSON.stringify({ type: 'enquiry-audit', version: 1, settings: settingsSnapshot(), result }, null, 2));
  }

  async function openSaved(ev) {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.type !== 'enquiry-audit' || !data.result) throw new Error('This isn\'t a saved enquiry audit.');
      const s = { ...(data.settings || {}) };
      // Keep this browser's saved connections if the file is for the business that's open.
      if (Mailboxes.connectedCount()) delete s.mailboxes;
      applySettings(s);
      audit = { result: data.result };
      aiMessage = '';
      setStatus(`Opened the audit saved on ${new Date(data.result.generatedAt).toLocaleString('en-GB')}.`, 'ok');
      render();
    } catch (err) {
      setStatus(esc(err.message), 'error');
    }
  }

  function csv() {
    const { tz } = work();
    const ps = periods();
    const fmt = (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: tz }) : '');
    const rows = [['Counted', 'Period', 'Received', 'Customer name', 'Customer email', 'Subject', 'Mailbox(es)', 'Website form', 'First reply', 'Reply time (hours)', 'Reply time, working hours', 'Emails from customer', 'Emails from business', 'AI check', 'Reason not counted / note']];
    for (const e of audit.result.enquiries) {
      const p = ps.find((x) => e.receivedAt >= x.from && e.receivedAt < x.to);
      const w = work();
      rows.push([
        e.include ? 'yes' : 'no', p ? p.label : '', fmt(e.receivedAt), e.customerName, e.customerEmail, e.subject, e.mailboxes.join(' '),
        e.viaForm ? 'yes' : '', fmt(e.firstReplyAt),
        e.firstReplyAt ? ((e.firstReplyAt - e.receivedAt) / 3600000).toFixed(2) : '',
        e.firstReplyAt ? (M.workingMs(e.receivedAt, e.firstReplyAt, w) / 3600000).toFixed(2) : '',
        e.inboundCount, e.outboundCount, e.ai ? `${e.ai.label}: ${e.ai.reason}` : '', e.reason || e.note || '',
      ]);
    }
    const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    download(`${fileBase()}.csv`, 'text/csv', `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}`);
  }

  // --- Results -------------------------------------------------------------------

  function render() {
    const r = audit.result;
    const w = work();
    const ps = periods();
    const stats = ps.map((p) => ({
      p,
      m: M.compute(r.enquiries.filter((e) => e.include && e.receivedAt >= p.from && e.receivedAt < p.to), { ...w, from: p.from, to: p.to, minutesPerEnquiry: p.mins }),
    }));
    const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: w.tz, day: 'numeric', month: 'short', year: 'numeric' });
    const range = (p) => `${fmtDay(p.from)} – ${fmtDay(p.to - 1)}`;
    const name = form.businessName.value.trim();

    resultsEl.hidden = false;
    resultsEl.innerHTML = `
      <div class="report-brand"><img src="logo.png" alt="Rare Squared Labs"><span>Enquiry audit by Rare Squared Labs</span></div>
      <div class="results-head">
        <div>
          <h2>${esc(name ? `${name}: enquiry audit` : 'Enquiry audit')}</h2>
          <p class="sub">${stats.map((s) => `${esc(s.p.label)}: ${range(s.p)}`).join(' · ')} · ${esc(r.mailboxes.filter((m) => m.ok).map((m) => m.email).join(', '))}</p>
        </div>
        <div class="actions no-print">
          <button type="button" class="secondary" data-act="csv">Download spreadsheet (CSV)</button>
          <button type="button" class="secondary" data-act="save">Save audit file</button>
          <button type="button" class="secondary" data-act="print">Print / PDF</button>
          ${audit.withText && aiStatus.ai && !aiBusy && aiCandidates().length ? `<button type="button" class="primary" data-act="ai">Check ${aiCandidates().length} with AI</button>` : ''}
        </div>
      </div>
      ${aiMessage ? `<p class="ai-status no-print">${aiMessage}</p>` : ''}
      ${mailboxNotes(r)}
      ${stats.length === 1 ? tiles(stats[0].m) : compareTable(stats)}
      <div class="card story"><h3>For the case study</h3>${stats.map((s) => `<p>${story(s, name, range)}</p>`).join('')}${savingLine(stats)}</div>
      <div class="grid2">
        ${bars('When enquiries arrive: day of week', [1, 2, 3, 4, 5, 6, 0].map((d) => [DAYS[d], stats[0].m.byWeekday[d]]))}
        ${bars('When enquiries arrive: hour of day', stats[0].m.byHour.map((n, h) => [h % 3 ? '' : String(h).padStart(2, '0'), n, `${String(h).padStart(2, '0')}:00`]), true)}
      </div>
      ${table(r, ps, w)}
      <p class="report-foot">Prepared by Rare Squared Labs · ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>
      <p class="method">How this is counted: an enquiry is a conversation with one customer email address (website-form emails are credited to the address in Reply-To). A customer who writes again after ${14} quiet days starts a new enquiry. Reply time runs from their first email to the first email the business sent back to that address from any audited mailbox. Newsletters, receipts, notifications, auto-replies and bounces are left out unless the business replied to them. Replies by phone can't be seen, so "No reply found" may include some enquiries that were phoned back.</p>
    `;
    resultsEl.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'csv') csv();
      if (b.dataset.act === 'save') saveAudit();
      if (b.dataset.act === 'print') window.print();
      if (b.dataset.act === 'ai') aiSort();
    }));
    resultsEl.querySelectorAll('[data-never]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.never === 'open') { neverOpen = Number(b.dataset.id); render(); return; }
      if (b.dataset.never === 'cancel') { neverOpen = null; render(); return; }
      if (b.dataset.never === 'remove') { removeNever(b.dataset.email); return; }
      neverCount(b.dataset.never);
    }));
    resultsEl.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    resultsEl.querySelectorAll('input[data-id]').forEach((cb) => cb.addEventListener('change', () => {
      const e = r.enquiries.find((x) => x.id === Number(cb.dataset.id));
      e.include = cb.checked;
      e.manual = cb.checked; // your choice always wins over the rules and the AI
      render();
    }));
  }

  function mailboxNotes(r) {
    const notes = [];
    r.mailboxes.forEach((m) => {
      if (!m.ok) notes.push(`<li class="bad"><strong>${esc(m.email)} couldn't be read:</strong> ${esc(m.error)}${m.help ? ` ${esc(m.help)}` : ''}</li>`);
      else {
        notes.push(`<li><strong>${esc(m.email)}</strong>: ${m.inboxCount} received and ${m.sentCount} sent emails read${m.providerName ? ` (${esc(m.providerName)})` : ''}${m.sentFolder ? '' : ', <strong>no Sent folder found</strong>'}.</li>`);
        (m.warnings || []).forEach((wn) => notes.push(`<li class="warn">${esc(wn)}</li>`));
      }
    });
    if (r.stats.duplicates) notes.push(`<li>${r.stats.duplicates} emails were in more than one mailbox and were counted once.</li>`);
    return `<ul class="notes">${notes.join('')}</ul>`;
  }

  const METRICS = [
    ['Enquiries', (m) => num(m.count), (m) => `${num(m.perMonth)} a month · ${num(m.perWeek, 1)} a week`],
    ['Typical first reply', (m) => M.duration(m.medianReplyHours), () => 'median, clock time'],
    ['In working hours', (m) => M.duration(m.medianWorkingReplyHours), () => 'median, opening hours only'],
    ['Replied within 1 hour', (m) => pct(m.within1h), (m) => `within 4 hrs: ${pct(m.within4h)}`],
    ['Replied within 24 hours', (m) => pct(m.within24h), (m) => `slowest: ${M.duration(m.slowest)}`],
    ['No reply found', (m) => num(m.unreplied), (m) => `${pct(m.replyRate == null ? null : 1 - m.replyRate)} of enquiries${m.unmatchable ? ` · ${m.unmatchable} form emails can't be checked` : ''}`],
    ['Arrived out of hours', (m) => num(m.outOfHours), (m) => (m.count ? `${pct(m.outOfHours / m.count)} of enquiries` : '')],
    ['Emails per enquiry', (m) => num(m.avgEmails, 1), () => 'both directions'],
    ['From the website form', (m) => num(m.viaForm), (m) => (m.count ? `${pct(m.viaForm / m.count)} of enquiries` : '')],
    ['Time spent a month', (m) => (m.hoursPerMonth == null ? '–' : `${num(m.hoursPerMonth, 1)} hrs`), (m) => (m.minutesPerEnquiry ? `at ${num(m.minutesPerEnquiry, 1)} min an enquiry` : 'enter minutes per enquiry above')],
  ];

  function tiles(m) {
    return `<div class="tiles">${METRICS.map(([label, val, sub]) => `<div class="tile"><div class="label">${label}</div><div class="value">${val(m)}</div><div class="subv">${sub(m)}</div></div>`).join('')}</div>`;
  }

  function compareTable(stats) {
    const [a, b] = stats;
    const change = (label) => {
      const ch = {
        'Typical first reply': [a.m.medianReplyHours, b.m.medianReplyHours, true],
        'In working hours': [a.m.medianWorkingReplyHours, b.m.medianWorkingReplyHours, true],
        'No reply found': [a.m.replyRate == null ? null : 1 - a.m.replyRate, b.m.replyRate == null ? null : 1 - b.m.replyRate, true],
        'Time spent a month': [a.m.hoursPerMonth, b.m.hoursPerMonth, true],
        'Replied within 1 hour': [a.m.within1h, b.m.within1h, false],
        'Replied within 24 hours': [a.m.within24h, b.m.within24h, false],
      }[label];
      if (!ch || ch[0] == null || ch[1] == null || !a.m.count || !b.m.count) return '';
      const [x, y, lowerIsBetter] = ch;
      if (x === y) return '<span class="same">no change</span>';
      const better = lowerIsBetter ? y < x : y > x;
      let txt;
      if (label.startsWith('Replied') || label === 'No reply found') txt = `${y > x ? '+' : '−'}${Math.round(Math.abs(y - x) * 100)} pts`;
      else if (label === 'Time spent a month') txt = `${y < x ? '−' : '+'}${num(Math.abs(x - y), 1)} hrs`;
      else if (lowerIsBetter && y > 0 && x / y >= 2) txt = `${num(x / y, 1)}× faster`;
      else txt = `${y < x ? '−' : '+'}${Math.round(Math.abs(1 - y / (x || 1)) * 100)}%`;
      return `<span class="${better ? 'good' : 'bad'}">${txt}</span>`;
    };
    return `<div class="card"><table class="compare">
      <thead><tr><th></th><th>${esc(a.p.label)}</th><th>${esc(b.p.label)}</th><th>Change</th></tr></thead>
      <tbody>${METRICS.map(([label, val, sub]) => `<tr><th>${label}</th><td><b>${val(a.m)}</b><small>${sub(a.m)}</small></td><td><b>${val(b.m)}</b><small>${sub(b.m)}</small></td><td>${change(label)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function story({ p, m }, name, range) {
    const who = name || 'The business';
    if (!m.count) return `${esc(p.label)} (${range(p)}): no enquiries found.`;
    const parts = [`<b>${esc(p.label)}</b> (${range(p)}): ${esc(who)} received <b>${m.count} ${m.count === 1 ? 'enquiry' : 'enquiries'}</b> (about ${num(m.perMonth)} a month).`];
    if (m.medianReplyHours != null) parts.push(`Half were answered within <b>${M.duration(m.medianReplyHours)}</b>${m.medianWorkingReplyHours != null ? ` (${M.duration(m.medianWorkingReplyHours)} of working time)` : ''}, and ${pct(m.within1h)} within an hour.`);
    if (m.unreplied) parts.push(`<b>${m.unreplied}</b> got no email reply that we could find.`);
    if (m.outOfHours) parts.push(`${pct(m.outOfHours / m.count)} arrived outside opening hours.`);
    if (m.hoursPerMonth != null) parts.push(`At ${num(m.minutesPerEnquiry, 1)} minutes each, that's <b>${num(m.hoursPerMonth, 1)} hours a month</b> spent on enquiries.`);
    return parts.join(' ');
  }

  function savingLine(stats) {
    if (stats.length < 2) return '';
    const [a, b] = stats;
    if (!a.m.count || !b.m.count) return '<p class="hint">Both periods need enquiries before they can be compared.</p>';
    if (a.m.minutesPerEnquiry == null || b.m.minutesPerEnquiry == null) return '<p class="hint">Enter minutes per enquiry for both periods to show the time saved.</p>';
    // Time saved on the enquiries that actually came in after: old minutes vs new minutes each.
    const saved = (b.m.perMonth * (a.m.minutesPerEnquiry - b.m.minutesPerEnquiry)) / 60;
    return `<p class="headline">${saved >= 0 ? `About <b>${num(saved, 1)} hours a month saved</b>` : `About ${num(-saved, 1)} hours a month more`} on enquiries (${num(b.m.perMonth)} enquiries a month at ${num(b.m.minutesPerEnquiry, 1)} min each instead of ${num(a.m.minutesPerEnquiry, 1)})${a.m.medianReplyHours && b.m.medianReplyHours ? `, with typical replies going from ${M.duration(a.m.medianReplyHours)} to ${M.duration(b.m.medianReplyHours)}` : ''}.</p>`;
  }

  function bars(title, data, compact) {
    const max = Math.max(1, ...data.map((d) => d[1]));
    return `<div class="card"><h3>${title}</h3><div class="bars${compact ? ' compact' : ''}">${data.map(([label, n, full]) => `<div class="bar" style="--h:${(n / max) * 100}%" title="${esc(full || label)}: ${n}"><div class="fill" style="height:${(n / max) * 100}%"></div><span class="n">${n || ''}</span><span class="l">${esc(label)}</span></div>`).join('')}</div></div>`;
  }

  function table(r, ps, w) {
    const inAny = (e) => ps.some((p) => e.receivedAt >= p.from && e.receivedAt < p.to) || (e.receivedAt < ps[0].from && e.lastInboundAt >= ps[0].from);
    const list = r.enquiries.filter(inAny);
    const counted = list.filter((e) => e.include);
    const notCounted = list.filter((e) => !e.include).sort((a, b) => (a.reason || '').localeCompare(b.reason || '') || a.receivedAt - b.receivedAt);
    const rows = tab === 'counted' ? counted : notCounted;
    const fmt = (t) => new Date(t).toLocaleString('en-GB', { timeZone: w.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const reasons = {};
    notCounted.forEach((e) => {
      const key = e.ai && !e.ai.enquiry && /^AI:/.test(e.reason || '') ? `AI: ${e.ai.label}` : (e.reason || 'Unticked by you');
      reasons[key] = (reasons[key] || 0) + 1;
    });
    return `<div class="card tablecard">
      <div class="tabs no-print">
        <button type="button" data-tab="counted" class="${tab === 'counted' ? 'on' : ''}">Counted (${counted.length})</button>
        <button type="button" data-tab="not" class="${tab === 'not' ? 'on' : ''}">Not counted (${notCounted.length})</button>
      </div>
      <p class="hint no-print">${tab === 'counted' ? 'Untick anything that isn\'t a real enquiry; the numbers update straight away.' : `Tick anything that is a real enquiry. ${Object.entries(reasons).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}`}</p>
      <div class="scroll"><table class="list">
        <thead><tr><th class="no-print">Count</th><th>Received</th><th>From</th><th>Subject</th><th>First reply</th><th>Emails</th><th>${tab === 'counted' ? 'Note' : 'Why not counted'}</th><th class="no-print"></th></tr></thead>
        <tbody>${rows.map((e) => {
          const h = e.firstReplyAt ? (e.firstReplyAt - e.receivedAt) / 3600000 : null;
          const reply = !e.replyMatchable ? '<span class="muted">can\'t tell</span>' : (h == null ? '<span class="bad">none found</span>' : `${M.duration(h)}<small>${M.duration(M.workingMs(e.receivedAt, e.firstReplyAt, w) / 3600000)} working</small>`);
          const period = ps.length > 1 ? (ps.find((p) => e.receivedAt >= p.from && e.receivedAt < p.to) || {}).label : '';
          return `<tr>
            <td class="no-print"><input type="checkbox" data-id="${e.id}"${e.include ? ' checked' : ''} aria-label="Count this enquiry"></td>
            <td>${fmt(e.receivedAt)}${period ? `<small>${esc(period)}</small>` : ''}</td>
            <td>${esc(e.customerName || e.customerEmail || 'Website form')}<small>${esc(e.customerName ? e.customerEmail : '')}${e.viaForm ? ' · website form' : ''}${r.mailboxes.length > 1 ? ` · to ${esc(e.mailboxes.map((m) => m.split('@')[0]).join(', '))}` : ''}</small></td>
            <td class="subject">${esc(e.subject)}</td>
            <td>${reply}</td>
            <td>${e.inboundCount + e.outboundCount}</td>
            <td class="muted">${esc(tab === 'counted' ? (e.ai ? `AI: ${e.ai.reason}` : e.note) : (e.reason || 'Unticked by you'))}</td>
            <td class="no-print actions-cell">${neverButtons(e)}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="8" class="muted">Nothing here.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  }

  /** "Never count" choices for one row: the address, or the whole domain for business senders. */
  function neverButtons(e) {
    const email = (e.customerEmail || '').toLowerCase();
    if (!email) return '';
    if (e.reason === NEVER) return `<button type="button" class="link small" data-never="remove" data-email="${esc(email)}">Count again</button>`;
    if (neverOpen !== e.id) return `<button type="button" class="link small" data-never="open" data-id="${e.id}" title="Skip this sender in future audits">Never count…</button>`;
    const domain = email.split('@')[1] || '';
    return `<div class="never-menu"><span>Never count:</span>
      <button type="button" class="secondary small" data-never="${esc(email)}">${esc(email)}</button>
      ${domain && !FREE_MAIL.test(domain) ? `<button type="button" class="secondary small" data-never="@${esc(domain)}">anyone @${esc(domain)}</button>` : ''}
      <button type="button" class="link small" data-never="cancel">Cancel</button></div>`;
  }

  initForm();
}());
