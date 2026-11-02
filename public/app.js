/* global EnquiryMetrics, Mailboxes, EnquiryCharts */
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
      if (Boolean(r.store) !== remote) {
        remote = Boolean(r.store);
        try {
          await loadCompanies();
        } catch (err) {
          remote = false;
          await loadCompanies();
          setStatus(`Couldn't load companies from Supabase (${esc(err.message)}). Using this browser for now.`, 'error');
        }
        const last = store.get('auditLastProfile');
        if (last && companies.some((p) => p.id === last)) openProfile(last); else { profileId = null; renderProfiles(); }
      }
    } catch { aiStatus = { ai: false, model: null }; }
    $('#aiRow').hidden = !aiStatus.ai;
    $('#aiOff').hidden = aiStatus.ai;
    if (audit) render();
  }

  // --- Companies (saved in Supabase when it's set up, otherwise in this browser) ---------------

  let companies = []; // [{ id, name, goLive, settings, runs: [...] }]
  let remote = false; // true when the server stores companies in Supabase
  let saveChain = Promise.resolve();
  let saveTimer = null;
  const baselineCache = {}; // company id -> full baseline audit (with its enquiries)

  const localProfiles = () => { try { return JSON.parse(store.get(PROFILES_KEY) || '[]'); } catch { return []; } };
  const fromRow = (row) => ({ id: row.id, name: row.name, goLive: row.go_live || '', settings: row.settings || {}, runs: (row.audit_runs || []).slice().sort((a, b) => Date.parse(a.period_from) - Date.parse(b.period_from)) });
  const current = () => companies.find((c) => c.id === profileId) || null;
  const storeApi = (action, extra = {}) => api('/api/store', { action, ...extra }).then((r) => r.data);

  async function loadCompanies() {
    if (!remote) {
      companies = localProfiles().map((p) => ({ id: p.id, name: p.name, goLive: (p.settings && p.settings.goLive) || '', settings: p.settings || {}, runs: [] }));
      return;
    }
    // First time with Supabase: move companies saved in this browser across.
    const local = localProfiles();
    if (local.length && !store.get('auditMovedToSupabase')) {
      for (const p of local) await storeApi('saveCompany', { company: { name: p.name, go_live: (p.settings && p.settings.goLive) || null, settings: p.settings || {} } });
      store.set('auditMovedToSupabase', '1');
      setStatus(`Moved ${local.length} saved compan${local.length === 1 ? 'y' : 'ies'} from this browser to your Supabase.`, 'ok');
    }
    companies = (await storeApi('listCompanies')).map(fromRow);
  }

  function renderProfiles() {
    const list = companies.slice().sort((a, b) => a.name.localeCompare(b.name));
    $('#profileSel').innerHTML = `<option value="">${list.length ? '+ New company' : 'None saved yet'}</option>${list
      .map((p) => `<option value="${esc(p.id)}"${p.id === profileId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    $('#deleteProfile').hidden = !profileId;
    $('#storeNote').textContent = remote ? '(saved in your Supabase)' : '(saved on this browser)';
    renderTracker();
  }

  /** Save the open company (only once at least one mailbox is connected). */
  function saveProfile() {
    if (!Mailboxes.connectedCount() && !profileId) return;
    const name = form.businessName.value.trim() || (Mailboxes.firstEmail().split('@')[1] || 'Company');
    const settings = settingsSnapshot({ tokens: true });
    if (!remote) {
      const list = localProfiles();
      if (!profileId) profileId = `p${Date.now().toString(36)}`;
      const entry = { id: profileId, name, savedAt: Date.now(), settings: { ...settings, goLive: (current() || {}).goLive || '' } };
      const i = list.findIndex((p) => p.id === profileId);
      if (i >= 0) list[i] = entry; else list.push(entry);
      store.set(PROFILES_KEY, JSON.stringify(list));
      store.set('auditLastProfile', profileId);
      const c = current();
      if (c) Object.assign(c, { name, settings: entry.settings }); else companies.push({ id: profileId, name, goLive: '', settings: entry.settings, runs: [] });
      renderProfiles();
      return;
    }
    // Supabase: saves run one after another so a new company is never created twice.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveChain = saveChain.then(async () => {
        const c = current();
        const row = await storeApi('saveCompany', { company: { id: profileId || undefined, name, go_live: c ? c.goLive || null : null, settings } });
        if (!profileId) {
          profileId = row.id;
          companies.push(fromRow(row));
        } else if (c) Object.assign(c, { name: row.name, settings: row.settings });
        store.set('auditLastProfile', profileId);
        renderProfiles();
      }).catch((err) => setStatus(`Couldn't save the company: ${esc(err.message)}`, 'error'));
    }, profileId ? 600 : 0);
  }

  function openProfile(id) {
    const p = companies.find((x) => x.id === id);
    profileId = p ? p.id : null;
    store.set('auditLastProfile', profileId || '');
    applySettings(p ? p.settings : null);
    audit = null;
    runMeta = null;
    resultsEl.hidden = true;
    setStatus(p ? `Opened ${esc(p.name)}.` : '', p ? 'ok' : '');
    renderProfiles();
    if (p) loadBaseline(p);
  }

  async function deleteProfile() {
    const p = current();
    if (!p) return;
    const what = remote ? `"${p.name}", its mailbox connections and all ${p.runs.length} saved audits from your Supabase` : `"${p.name}" and its mailbox connections from this browser`;
    if (!confirm(`Delete ${what}? This can't be undone.`)) return;
    try {
      if (remote) await storeApi('deleteCompany', { id: p.id });
      else store.set(PROFILES_KEY, JSON.stringify(localProfiles().filter((x) => x.id !== p.id)));
      companies = companies.filter((x) => x.id !== p.id);
      openProfile(null);
    } catch (err) {
      setStatus(`Couldn't delete: ${esc(err.message)}`, 'error');
    }
  }

  // --- Before-and-after checks --------------------------------------------------------------

  const CHECKS = [
    { key: 'baseline', kind: 'baseline', label: 'Before the app', note: 'the 30 days before go-live', from: -30, to: 0 },
    { key: 'w1', kind: 'checkpoint', label: 'Week 1', note: 'first week with the app', from: 0, to: 7 },
    { key: 'w2', kind: 'checkpoint', label: 'Week 2', note: 'second week', from: 7, to: 14 },
    { key: 'm1', kind: 'checkpoint', label: 'Month 1', note: 'first month', from: 0, to: 30 },
    { key: 'm2', kind: 'checkpoint', label: 'Month 2', note: 'second month', from: 30, to: 60 },
    { key: 'm3', kind: 'checkpoint', label: 'Month 3', note: 'third month', from: 60, to: 90 },
  ];
  let runMeta = null; // what the next/last audit is: { kind, checkpoint, label }

  const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
  const todayStr = () => iso(new Date());
  const niceDate = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

  /** The dates a check covers: { from, to } as inclusive YYYY-MM-DD, plus when it's complete. */
  function checkWindow(ch, goLive) {
    if (!goLive) {
      if (ch.kind !== 'baseline') return null;
      return { from: addDays(todayStr(), -29), to: todayStr(), endsAfter: todayStr() };
    }
    let to = addDays(goLive, ch.to - 1);
    let from = addDays(goLive, ch.from);
    if (ch.kind === 'baseline' && to > todayStr()) { to = todayStr(); from = addDays(to, -29); } // go-live still to come
    return { from, to, endsAfter: addDays(goLive, ch.to - 1) };
  }

  const runFor = (c, key) => [...c.runs].reverse().find((r) => r.checkpoint === key || (key === 'baseline' && r.kind === 'baseline'));

  function runNumbers(r) {
    const m = r.metrics || {};
    if (m.count == null) return '';
    const bits = [`${m.count} enquir${m.count === 1 ? 'y' : 'ies'}`];
    if (m.medianReplyHours != null) bits.push(`typical reply ${M.duration(m.medianReplyHours)}`);
    if (m.within1h != null) bits.push(`${Math.round(m.within1h * 100)}% within an hour`);
    if (m.unreplied) bits.push(`${m.unreplied} no reply`);
    return bits.join(' · ');
  }

  function renderTracker() {
    const card = $('#trackerCard');
    const c = current();
    if (!c || !remote) {
      card.hidden = true;
      if (c && !remote) { card.hidden = false; card.innerHTML = '<h2>Before-and-after checks</h2><p class="hint">To save audits and track this company over time, connect your Supabase: add <code>SUPABASE_URL</code> and <code>SUPABASE_SECRET_KEY</code> in Vercel and redeploy.</p>'; }
      return;
    }
    card.hidden = false;
    const today = todayStr();
    const rows = CHECKS.map((ch) => {
      const win = checkWindow(ch, c.goLive);
      const r = runFor(c, ch.key);
      let status;
      if (r) status = `<span class="badge good"><b aria-hidden="true">✓</b>Done</span>`;
      else if (!win) status = '<span class="muted">Set the go-live date</span>';
      else if (win.endsAfter < today || ch.kind === 'baseline') status = '<span class="badge warn"><b aria-hidden="true">!</b>Ready to run</span>';
      else status = `<span class="muted">Due ${niceDate(addDays(win.endsAfter, 1))}</span>`;
      const early = win && !r && ch.kind !== 'baseline' && win.endsAfter >= today && win.from <= today;
      return `<li class="check-row${r ? ' done' : ''}">
        <div class="cr-main">
          <strong>${esc(ch.label)}</strong> <small class="muted">${win ? `${niceDate(win.from)} – ${niceDate(win.to)}` : esc(ch.note)}</small>
          ${r ? `<div class="cr-nums">${esc(runNumbers(r))}</div>` : ''}
        </div>
        <div class="cr-status">${status}</div>
        <div class="cr-actions">
          ${r ? `<button type="button" class="secondary small" data-run-open="${r.id}">Open</button>` : ''}
          ${win && (win.from <= today) ? `<button type="button" class="${r ? 'link small' : 'primary small'}" data-run-check="${ch.key}"${running ? ' disabled' : ''}>${r ? 'Run again' : early ? 'Run so far' : 'Run'}</button>` : ''}
          ${r ? `<button type="button" class="remove" data-run-del="${r.id}" title="Delete this audit" aria-label="Delete this audit">×</button>` : ''}
        </div>
      </li>`;
    }).join('');
    const custom = c.runs.filter((r) => r.kind === 'custom');
    card.innerHTML = `
      <h2>Before-and-after checks <small class="muted">for ${esc(c.name)}</small></h2>
      <p class="hint">Run the "Before" audit before the enquiry app goes live, then each check as it comes due. Every audit is saved, compared with "Before", and added to the progress charts.</p>
      <label class="field golive">Date the enquiry app went live (or will)
        <input type="date" id="goLive" value="${esc(c.goLive || '')}">
      </label>
      <ol class="check-list">${rows}</ol>
      ${custom.length ? `<h3>Other saved audits</h3><ol class="check-list">${custom.map((r) => `<li class="check-row done"><div class="cr-main"><strong>${esc(r.label)}</strong> <small class="muted">${esc(new Date(r.period_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))} – ${esc(new Date(Date.parse(r.period_to) - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</small><div class="cr-nums">${esc(runNumbers(r))}</div></div><div class="cr-status"></div><div class="cr-actions"><button type="button" class="secondary small" data-run-open="${r.id}">Open</button><button type="button" class="remove" data-run-del="${r.id}" title="Delete this audit" aria-label="Delete this audit">×</button></div></li>`).join('')}</ol>` : ''}
    `;
    $('#goLive').addEventListener('change', (e) => {
      c.goLive = e.target.value;
      saveProfile();
      renderTracker();
    });
    card.querySelectorAll('[data-run-check]').forEach((b) => b.addEventListener('click', () => startCheck(b.dataset.runCheck)));
    card.querySelectorAll('[data-run-open]').forEach((b) => b.addEventListener('click', () => openRun(b.dataset.runOpen)));
    card.querySelectorAll('[data-run-del]').forEach((b) => b.addEventListener('click', () => deleteRun(b.dataset.runDel)));
  }

  function startCheck(key) {
    if (running) return;
    const c = current();
    const ch = CHECKS.find((x) => x.key === key);
    const win = checkWindow(ch, c.goLive);
    form.aFrom.value = win.from;
    form.aTo.value = win.to > todayStr() ? todayStr() : win.to;
    form.compare.checked = false;
    syncCompare();
    nextRunMeta = { kind: ch.kind, checkpoint: ch.key, label: ch.label };
    form.requestSubmit();
  }

  async function openRun(id) {
    setStatus('<span class="spinner"></span> Opening the saved audit…');
    try {
      const row = await storeApi('getRun', { id });
      const from = new Date(row.period_from);
      const to = new Date(Date.parse(row.period_to) - 1);
      form.aFrom.value = iso(from);
      form.aTo.value = iso(to);
      form.compare.checked = false;
      syncCompare();
      runMeta = { kind: row.kind, checkpoint: row.checkpoint, label: row.label };
      audit = { result: row.result || { enquiries: [], mailboxes: [], stats: {} }, summary: row.summary || null, runId: row.id, meta: runMeta, withText: false };
      audit.savedSig = runSignature();
      view = 'summary';
      setStatus(`Opened the "${esc(row.label)}" audit, saved ${esc(new Date(row.updated_at || row.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}.`, 'ok');
      render();
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(`Couldn't open it: ${esc(err.message)}`, 'error');
    }
  }

  async function deleteRun(id) {
    const c = current();
    const r = c && c.runs.find((x) => x.id === id);
    if (!r || !confirm(`Delete the saved "${r.label}" audit? This can't be undone.`)) return;
    try {
      await storeApi('deleteRun', { id });
      c.runs = c.runs.filter((x) => x.id !== id);
      if (r.kind === 'baseline') delete baselineCache[c.id];
      if (audit && audit.runId === id) audit.runId = null;
      renderTracker();
      if (audit) render();
    } catch (err) {
      setStatus(`Couldn't delete: ${esc(err.message)}`, 'error');
    }
  }

  /** Load the company's "Before" audit (with its enquiries) so later checks can be compared with it. */
  async function loadBaseline(c) {
    const b = c && remote ? runFor(c, 'baseline') : null;
    if (!b || (baselineCache[c.id] && baselineCache[c.id].id === b.id)) return;
    try {
      baselineCache[c.id] = await storeApi('getRun', { id: b.id });
      if (audit) render();
    } catch { /* comparisons just won't show */ }
  }

  // --- Saving each audit -------------------------------------------------------------------

  const runSignature = () => (audit ? JSON.stringify([audit.result.enquiries.filter((e) => e.include).map((e) => e.id), audit.summary && audit.summary.at, form.minsA.value, form.minsB.value]) : '');
  let runSaveTimer = null;

  /** Save (or update) the audit on screen for the open company. */
  function scheduleRunSave(immediate = false) {
    const c = current();
    if (!remote || !c || !audit || !audit.meta || form.compare.checked) return;
    const sig = runSignature();
    if (!immediate && sig === audit.savedSig) return;
    clearTimeout(runSaveTimer);
    runSaveTimer = setTimeout(() => {
      saveChain = saveChain.then(async () => {
        const ps = periods();
        const p = ps[ps.length - 1];
        const stat = periodStats().find((s) => s.p === p) || periodStats().slice(-1)[0];
        const existing = audit.runId || (audit.meta.checkpoint && (runFor(c, audit.meta.checkpoint) || {}).id) || undefined;
        const result = { ...audit.result, enquiries: audit.result.enquiries.map(({ snippet, ...e }) => e) };
        const row = await storeApi('saveRun', {
          run: {
            id: existing, company_id: c.id, kind: audit.meta.kind, checkpoint: audit.meta.checkpoint || null, label: audit.meta.label,
            period_from: p.from, period_to: p.to, minutes_per_enquiry: p.mins, metrics: stat.m, result, summary: audit.summary || null,
          },
        });
        audit.runId = row.id;
        audit.savedSig = runSignature();
        c.runs = [...c.runs.filter((x) => x.id !== row.id), row].sort((a, b) => Date.parse(a.period_from) - Date.parse(b.period_from));
        if (row.kind === 'baseline') { delete baselineCache[c.id]; loadBaseline(c); }
        renderTracker();
        aiMessage = aiMessage || '';
        const note = resultsEl.querySelector('.saved-note');
        if (note) note.textContent = `Saved to ${c.name} as "${row.label}".`;
      }).catch((err) => setStatus(`The audit ran but couldn't be saved: ${esc(err.message)}`, 'error'));
    }, immediate ? 0 : 1500);
  }

  /** "Before" stats for a check, from the saved baseline audit. */
  function baselineStat() {
    const c = current();
    if (!c || !audit || !audit.meta || audit.meta.kind === 'baseline' || form.compare.checked) return null;
    const b = baselineCache[c.id];
    if (!b || !b.result) return null;
    const w = work();
    const p = { label: 'Before', from: Date.parse(b.period_from), to: Date.parse(b.period_to), mins: b.minutes_per_enquiry };
    const list = (b.result.enquiries || []).filter((e) => e.include && e.receivedAt >= p.from && e.receivedAt < p.to);
    return { p, list, m: M.compute(list, { ...w, from: p.from, to: p.to, minutesPerEnquiry: p.mins }), saved: true };
  }

  /** Saved audits for the open company, in date order, for the progress charts. */
  function progressRuns() {
    const c = current();
    if (!c || !remote) return [];
    return c.runs.filter((r) => r.kind !== 'custom' && r.metrics && r.metrics.count != null);
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

    loadCompanies();
    const last = store.get('auditLastProfile');
    if (last && companies.some((p) => p.id === last)) openProfile(last);
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
    const meta = (audit && audit.meta) || runMeta;
    const label = meta && meta.kind !== 'custom' ? meta.label : (form.compare.checked ? 'Before' : (meta ? meta.label : 'This period'));
    mk(label, form.aFrom.value, form.aTo.value, meta && meta.kind === 'checkpoint' ? form.minsB.value : form.minsA.value);
    if (form.compare.checked) mk('After', form.bFrom.value, form.bTo.value, form.minsB.value);
    return list;
  }

  function setStatus(html, kind = '') {
    statusEl.className = kind;
    statusEl.innerHTML = html;
  }

  let nextRunMeta = null;
  let running = false;

  async function run(ev) {
    ev.preventDefault();
    if (running) return;
    const meta = nextRunMeta || { kind: 'custom', checkpoint: null, label: form.compare.checked ? 'Comparison' : 'Custom audit' };
    nextRunMeta = null;
    const ps = periods();
    if (!ps.length) return setStatus('Choose the dates to audit.', 'error');
    const pending = Mailboxes.pending();
    if (pending.length) return setStatus(`Enter the password for ${esc(pending.join(', '))} and press Test connection, or remove it.`, 'error');
    const mailboxes = Mailboxes.forAudit();
    if (!mailboxes.length) return setStatus('Connect at least one mailbox first.', 'error');
    const btn = $('#runBtn');
    btn.disabled = true;
    running = true;
    renderTracker();
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
      runMeta = meta;
      audit = { result: data, withText: useAi(), meta };
      if (remote && current() && !form.compare.checked) scheduleRunSave(true);
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
      running = false;
      renderTracker();
    }
  }

  const useAi = () => aiStatus.ai && form.useAi.checked;

  // --- AI sorting -------------------------------------------------------------------

  /** Enquiries the rules counted that the AI hasn't checked yet (your own ticks are never overridden). */
  const aiCandidates = () => (audit ? audit.result.enquiries.filter((e) => e.include && e.manual == null && !e.ai) : []);

  async function aiSort() {
    if (aiBusy || !audit) return;
    const todo = aiCandidates();
    if (!todo.length) { aiMessage = ''; render(); writeSummary(); return; }
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
      aiMessage = `AI checked ${done} email${done === 1 ? '' : 's'} and moved ${moved} to Not counted. Check the Enquiries tab (Not counted) and tick any it got wrong.`;
      writeSummary();
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
    const result = { ...audit.result, enquiries: audit.result.enquiries.map(({ snippet, ...e }) => e), summary: audit.summary ? { ...audit.summary } : undefined };
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
      audit = { result: data.result, summary: data.result.summary || null };
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

  const SITE = 'https://www.raresquaredlabs.co.uk';
  let view = 'summary'; // results tab: summary | charts | list

  function periodStats() {
    const r = audit.result;
    const w = work();
    const own = periods().map((p) => {
      const list = r.enquiries.filter((e) => e.include && e.receivedAt >= p.from && e.receivedAt < p.to);
      return { p, list, m: M.compute(list, { ...w, from: p.from, to: p.to, minutesPerEnquiry: p.mins }) };
    });
    const base = baselineStat();
    return base && own.length === 1 ? [base, ...own] : own;
  }

  function render() {
    const r = audit.result;
    const w = work();
    const ps = periods();
    const stats = periodStats();
    const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: w.tz, day: 'numeric', month: 'short', year: 'numeric' });
    const range = (p) => `${fmtDay(p.from)} – ${fmtDay(p.to - 1)}`;
    const name = form.businessName.value.trim();
    const counted = r.enquiries.filter((e) => e.include).length;

    resultsEl.hidden = false;
    resultsEl.innerHTML = `
      <div class="report-brand"><a href="${SITE}" target="_blank" rel="noopener"><img src="logo.png" alt="Rare Squared Labs"></a><span>Enquiry audit by <a href="${SITE}" target="_blank" rel="noopener">Rare Squared Labs</a></span></div>
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
      ${remote && current() && audit.meta ? `<p class="saved-note hint no-print">${audit.runId ? `Saved to ${esc(current().name)} as "${esc(audit.meta.label)}".` : 'Saving…'}</p>` : ''}
      ${stats.length > 1 && stats[0].saved ? `<p class="hint">Compared with the saved "Before" audit (${esc(range(stats[0].p))}).</p>` : ''}
      <nav class="views no-print" role="tablist" aria-label="Results">
        ${[['summary', 'Summary'], ['charts', 'Charts'], ['list', `Enquiries (${counted})`]].map(([k, label]) => `<button type="button" role="tab" aria-selected="${view === k}" data-view="${k}" class="${view === k ? 'on' : ''}">${label}</button>`).join('')}
      </nav>
      <section class="panel${view === 'summary' ? '' : ' screen-hidden'}" data-panel="summary">
        ${mailboxNotes(r)}
        ${glance(stats)}
        ${summaryCard(stats)}
        ${stats.length === 1 ? tiles(stats[0].m) : compareTable(stats)}
        ${progressTable()}
        <div class="card story"><h3>For the case study</h3>${stats.map((s) => `<p>${story(s, name, range)}</p>`).join('')}${savingLine(stats)}</div>
      </section>
      <section class="panel${view === 'charts' ? '' : ' screen-hidden'}" data-panel="charts">
        <h2 class="print-only">Charts</h2>
        ${progressCharts()}
        ${chartsHtml(stats, w)}
      </section>
      <section class="panel${view === 'list' ? '' : ' screen-hidden'}" data-panel="list">
        <h2 class="print-only">The enquiries</h2>
        ${table(r, ps, w)}
      </section>
      <p class="report-foot">Prepared by Rare Squared Labs · <a href="${SITE}" target="_blank" rel="noopener">www.raresquaredlabs.co.uk</a> · ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>
      <p class="method">How this is counted: an enquiry is a conversation with one customer email address (website-form emails are credited to the customer's address). A customer who writes again after 14 quiet days starts a new enquiry. Reply time runs from their first email to the first email the business sent back to that address from any audited mailbox. Newsletters, receipts, notifications, auto-replies and bounces are left out unless the business replied to them. Replies by phone can't be seen, so "No reply found" may include some enquiries that were phoned back.</p>
    `;
    resultsEl.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'csv') csv();
      if (b.dataset.act === 'save') saveAudit();
      if (b.dataset.act === 'print') window.print();
      if (b.dataset.act === 'ai') aiSort();
      if (b.dataset.act === 'summary') writeSummary();
    }));
    resultsEl.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
    resultsEl.querySelectorAll('[data-never]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.never === 'open') { neverOpen = Number(b.dataset.id); render(); return; }
      if (b.dataset.never === 'cancel') { neverOpen = null; render(); return; }
      if (b.dataset.never === 'remove') { removeNever(b.dataset.email); return; }
      neverCount(b.dataset.never);
    }));
    scheduleRunSave();
    resultsEl.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    resultsEl.querySelectorAll('input[data-id]').forEach((cb) => cb.addEventListener('change', () => {
      const e = r.enquiries.find((x) => x.id === Number(cb.dataset.id));
      e.include = cb.checked;
      e.manual = cb.checked; // your choice always wins over the rules and the AI
      render();
    }));
  }

  // --- "At a glance": plain-English checks with a status (icon + words, never colour alone) ----

  const STATUS = {
    good: { icon: '✓', word: 'Good' },
    warn: { icon: '!', word: 'Could be better' },
    bad: { icon: '✕', word: 'Needs attention' },
    info: { icon: 'i', word: 'Worth knowing' },
  };

  function checks(m) {
    const out = [];
    if (!m.count) return out;
    const wh = m.medianWorkingReplyHours;
    if (wh != null) {
      const s = wh <= 1 ? 'good' : wh <= 4 ? 'warn' : 'bad';
      const clock = m.medianReplyHours;
      const extra = clock != null && Math.abs(clock - wh) > 0.25 ? ` Counting only your opening hours, that's ${M.duration(wh)}.` : '';
      out.push({ s, title: 'How quickly enquiries get a reply', text: `Half of enquiries got a reply within ${M.duration(clock)}.${extra} ${s === 'good' ? 'That\'s quick.' : s === 'warn' ? 'Customers often go with whoever replies first, so faster is better.' : 'Customers often book whoever replies first, so slow replies can lose work.'}` });
    }
    if (m.replied + m.unreplied > 0) {
      const share = m.unreplied / (m.replied + m.unreplied);
      const s = m.unreplied === 0 ? 'good' : share <= 0.1 ? 'warn' : 'bad';
      out.push({ s, title: 'Enquiries without a reply', text: m.unreplied === 0 ? 'Every enquiry got an email reply.' : `${m.unreplied} of ${m.replied + m.unreplied} enquiries got no email reply that we could see. Some may have been phoned back, but each one could be a lost job.` });
    }
    if (m.count) {
      const share = m.outOfHours / m.count;
      out.push({ s: share >= 0.25 ? 'info' : 'good', title: 'Enquiries that arrive when you\'re closed', text: share >= 0.25 ? `About ${Math.round(share * 10)} in 10 enquiries arrive evenings or weekends. An automatic first reply would let those customers know they've been heard.` : `Most enquiries arrive during opening hours (${m.count - m.outOfHours} of ${m.count}).` });
    }
    if (m.avgEmails != null) {
      out.push({ s: m.avgEmails >= 4 ? 'warn' : 'good', title: 'Back-and-forth emails', text: m.avgEmails >= 4 ? `Each enquiry takes about ${num(m.avgEmails)} emails in total. Asking for details like phone number, address and photos in the first reply can cut this down.` : `Enquiries are sorted in about ${num(m.avgEmails)} emails each, which is efficient.` });
    }
    return out;
  }

  function glance(stats) {
    const latest = stats[stats.length - 1];
    const list = checks(latest.m);
    if (!list.length) return '<div class="card"><h3>At a glance</h3><p>No enquiries were found in this period.</p></div>';
    return `<div class="card glance">
      <h3>At a glance${stats.length > 1 ? ` <small>(${esc(latest.p.label)} period)</small>` : ''}</h3>
      ${latest.m.count < 10 ? `<p class="hint">Only ${latest.m.count} enquir${latest.m.count === 1 ? 'y' : 'ies'} in this period, so treat these as a rough guide.</p>` : ''}
      <ul class="checks">${list.map((c) => `<li class="check-item ck-${c.s}"><span class="badge ${c.s}"><b aria-hidden="true">${STATUS[c.s].icon}</b>${STATUS[c.s].word}</span><div><strong>${esc(c.title)}</strong><p>${esc(c.text)}</p></div></li>`).join('')}</ul>
    </div>`;
  }

  // --- AI summary (numbers only) -------------------------------------------------------------

  function summaryStats(stats) {
    const w = work();
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const pc = (x) => (x == null ? null : Math.round(x * 100));
    const busiest = (arr, names) => { const max = Math.max(...arr); return max ? names[arr.indexOf(max)] : null; };
    return {
      openingHours: `${w.workStart}–${w.workEnd}, ${w.workDays.map((d) => DAYS[d]).join(' ')}`,
      goLiveDate: current() && current().goLive ? current().goLive : null,
      savedChecksSoFar: progressRuns().map((r) => ({ check: r.label, enquiries: r.metrics.count, typicalReplyHoursClock: r1(r.metrics.medianReplyHours), repliedWithin1HourPct: pc(r.metrics.within1h), noEmailReplyFound: r.metrics.unreplied })),
      periods: stats.map(({ p, m }) => ({
        label: p.label, days: Math.round(m.days), enquiries: m.count, enquiriesPerMonth: r1(m.perMonth),
        typicalReplyHoursClock: r1(m.medianReplyHours), typicalReplyHoursOpeningHours: r1(m.medianWorkingReplyHours),
        repliedWithin1HourPct: pc(m.within1h), repliedWithin24HoursPct: pc(m.within24h), slowestReplyHours: r1(m.slowest),
        noEmailReplyFound: m.unreplied, websiteFormsWithoutCustomerAddress: m.unmatchable,
        arrivedOutOfHours: m.outOfHours, emailsPerEnquiry: r1(m.avgEmails), viaWebsiteForm: m.viaForm,
        busiestDay: busiest(m.byWeekday, DAYS), busiestHour: busiest(m.byHour, m.byHour.map((_, h) => `${h}:00`)),
        minutesPerEnquiry: m.minutesPerEnquiry, hoursPerMonthOnEnquiries: r1(m.hoursPerMonth),
      })),
    };
  }

  async function writeSummary() {
    if (!audit || audit.summaryBusy) return;
    const stats = summaryStats(periodStats());
    audit.summaryBusy = true;
    audit.summaryError = null;
    render();
    try {
      const r = await api('/api/summary', { business: { name: form.businessName.value.trim(), about: form.about.value.trim() }, stats });
      audit.summary = { ...r, key: JSON.stringify(stats), at: Date.now() };
    } catch (err) {
      audit.summaryError = err.message;
    } finally {
      audit.summaryBusy = false;
      render();
    }
  }

  function summaryCard(stats) {
    const s = audit.summary;
    if (!aiStatus.ai && !s) return '';
    const stale = s && s.key !== JSON.stringify(summaryStats(stats));
    const button = (label) => `<button type="button" class="${s ? 'secondary' : 'primary'} small no-print" data-act="summary">${label}</button>`;
    if (audit.summaryBusy) return '<div class="card ai-summary"><h3>In plain English</h3><p><span class="spinner"></span> Writing a summary…</p></div>';
    if (!s) {
      return `<div class="card ai-summary no-print"><h3>In plain English</h3>
        <p class="hint">Get a short summary of what these numbers mean and what could help, written by AI. Only the totals above are sent, not any emails.</p>
        ${audit.summaryError ? `<p class="bad">${esc(audit.summaryError)}</p>` : ''}${button('Write a summary')}</div>`;
    }
    const part = (title, items, cls) => (items && items.length ? `<div class="sum-part ${cls}"><h4>${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    return `<div class="card ai-summary">
      <h3>In plain English <small class="muted">written by AI from the numbers in this report</small></h3>
      <p class="sum-headline">${esc(s.headline)}</p>
      <div class="sum-grid">
        ${part('What\'s going well', s.goingWell, 'sum-good')}
        ${part('What needs attention', s.needsAttention, 'sum-warn')}
        ${part('What could help', s.suggestions, 'sum-tip')}
      </div>
      ${stale ? `<p class="hint no-print">The numbers have changed since this was written. ${button('Update summary')}</p>` : `<p class="no-print">${button('Rewrite')}</p>`}
      ${audit.summaryError ? `<p class="bad no-print">${esc(audit.summaryError)}</p>` : ''}
    </div>`;
  }

  // --- Progress over time (saved checks) ---------------------------------------------------

  function progressTable() {
    const runs = progressRuns();
    if (runs.length < 2) return '';
    const cur = audit && audit.runId;
    const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    return `<div class="card progress">
      <h3>Progress so far</h3>
      <p class="hint">Each saved check for this company, oldest first. "Before" is the period before the enquiry app.</p>
      <div class="scroll"><table class="list">
        <thead><tr><th>Check</th><th>Dates</th><th>Enquiries a month</th><th>Typical reply</th><th>Replied within an hour</th><th>No reply found</th><th>Time spent a month</th></tr></thead>
        <tbody>${runs.map((r) => {
          const m = r.metrics;
          const d = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
          return `<tr${r.id === cur ? ' class="current-run"' : ''}>
            <td><b>${esc(r.label)}</b>${r.id === cur ? '<small>this audit</small>' : ''}</td>
            <td>${d(r.period_from)} – ${d(Date.parse(r.period_to) - 1)}</td>
            <td>${num(m.perMonth)}</td>
            <td>${M.duration(m.medianReplyHours)}</td>
            <td>${pct(m.within1h)}</td>
            <td>${m.unreplied ?? '–'}${m.replyRate != null ? ` <small>${pct(1 - m.replyRate)}</small>` : ''}</td>
            <td>${m.hoursPerMonth == null ? '–' : `${num(m.hoursPerMonth, 1)} hrs`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
  }

  function progressCharts() {
    const runs = progressRuns();
    if (runs.length < 2) return '';
    const C = EnquiryCharts;
    const legend = [{ name: 'Before the app', cls: 'before' }, { name: 'With the app', cls: 'after' }];
    const rows = (fn) => runs.map((r) => ({ label: r.label, short: r.label.replace('Before the app', 'Before'), values: [fn(r.metrics)], cls: r.kind === 'baseline' ? 'before' : 'after' }));
    const first = runs[0].metrics;
    const last = runs[runs.length - 1].metrics;
    const hrs = (h) => M.duration(h);
    const pc = (x) => `${Math.round(x)}%`;
    const charts = [
      C.vbar({ title: 'Typical reply time', takeaway: first.medianReplyHours != null && last.medianReplyHours != null ? `From <b>${hrs(first.medianReplyHours)}</b> to <b>${hrs(last.medianReplyHours)}</b>. Lower is better.` : 'Lower is better.', rows: rows((m) => m.medianReplyHours ?? 0), series: [{ name: 'Typical reply', cls: 'after' }], legendSeries: legend, unit: '', format: hrs }),
      C.vbar({ title: 'Replied within an hour', takeaway: `From <b>${pc((first.within1h || 0) * 100)}</b> to <b>${pc((last.within1h || 0) * 100)}</b>. Higher is better.`, rows: rows((m) => Math.round((m.within1h || 0) * 100)), series: [{ name: 'Within an hour', cls: 'after' }], legendSeries: legend, unit: '', format: pc }),
      C.vbar({ title: 'Enquiries with no reply found', takeaway: `From <b>${pc(first.replyRate != null ? (1 - first.replyRate) * 100 : 0)}</b> to <b>${pc(last.replyRate != null ? (1 - last.replyRate) * 100 : 0)}</b> of enquiries. Lower is better.`, rows: rows((m) => (m.replyRate != null ? Math.round((1 - m.replyRate) * 100) : 0)), series: [{ name: 'No reply', cls: 'after' }], legendSeries: legend, unit: '', format: pc }),
    ];
    if (runs.some((r) => r.metrics.hoursPerMonth != null)) {
      charts.push(C.vbar({ title: 'Time spent on enquiries a month', takeaway: 'Based on the minutes per enquiry you entered. Lower is better.', rows: rows((m) => Math.round((m.hoursPerMonth || 0) * 10) / 10), series: [{ name: 'Hours', cls: 'after' }], legendSeries: legend, unit: 'hours', format: (v) => `${num(v, 1)} hrs` }));
    }
    return `<h3 class="section-title">Progress since go-live</h3><div class="charts-grid progress-grid">${charts.join('')}</div><h3 class="section-title">This audit</h3>`;
  }

  // --- Charts tab --------------------------------------------------------------------------

  function chartsHtml(stats, w) {
    const C = EnquiryCharts;
    const compare = stats.length > 1;
    const series = compare ? stats.map((s, i) => ({ name: s.p.label, cls: i ? 'after' : 'before' })) : [{ name: stats[0].p.label, cls: 'after' }];
    const pctOf = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
    const total = (s) => s.m.replied + s.m.unreplied;
    if (!stats.some((s) => s.m.count)) return '<div class="card"><p>No enquiries to chart in this period.</p></div>';

    // 1. Reply speed
    const buckets = stats.map((s) => M.replyBuckets(s.list));
    const speedRows = M.BUCKETS.map((b, i) => ({ label: b.label, values: buckets.map((bs) => bs[i].count) }));
    const speedTake = compare
      ? `Replied within an hour: <b>${pctOf(buckets[0][0].count, total(stats[0]))}</b> before, <b>${pctOf(buckets[1][0].count, total(stats[1]))}</b> after.`
      : `<b>${buckets[0][0].count} of ${total(stats[0])}</b> enquiries got a reply within an hour${buckets[0][5].count ? `, and <b>${buckets[0][5].count}</b> got no email reply` : ''}.`;

    // 2. Enquiries each week (bars take their period's colour)
    const from = Math.min(...stats.map((s) => s.p.from));
    const to = Math.max(...stats.map((s) => s.p.to));
    const all = stats.flatMap((s) => s.list.map((e) => ({ ...e, _p: s.p.label })));
    const weeks = M.weekly(all, from, to, w.tz);
    const periodOf = (t) => stats.findIndex((s) => t + 3.5 * DAY >= s.p.from && t + 3.5 * DAY < s.p.to);
    const weekRows = weeks.map((wk) => {
      const d = new Date(wk.start);
      const lab = d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
      const pi = periodOf(wk.start);
      return { label: `Week of ${lab}`, short: lab, values: [wk.count], cls: compare ? (pi > 0 ? 'after' : 'before') : 'after' };
    });
    const busiestWeek = weekRows.reduce((a, b) => (b.values[0] > a.values[0] ? b : a), weekRows[0]);

    // 3. Day of week, 4. hour of day
    const order = [1, 2, 3, 4, 5, 6, 0];
    const dayRows = order.map((d) => ({ label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d], short: DAYS[d], values: stats.map((s) => s.m.byWeekday[d]), shade: w.workDays.includes(d) }));
    const dayTotals = order.map((d) => stats.reduce((n, s) => n + s.m.byWeekday[d], 0));
    const topDay = dayRows[dayTotals.indexOf(Math.max(...dayTotals))];
    const [sh] = w.workStart.split(':').map(Number);
    const [eh, em] = w.workEnd.split(':').map(Number);
    const hourRows = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00 to ${String((h + 1) % 24).padStart(2, '0')}:00`, short: String(h).padStart(2, '0'), values: stats.map((s) => s.m.byHour[h]), shade: h >= sh && (h < eh || (h === eh && em > 0)) }));
    const latest = stats[stats.length - 1].m;

    // 5. How enquiries arrive
    const splitRows = stats.map((s) => ({ label: s.p.label, parts: [{ name: 'Email', value: s.m.count - s.m.viaForm, cls: 'before' }, { name: 'Website form', value: s.m.viaForm, cls: 'after' }] }));

    return `<div class="charts-grid">
      ${C.hbar({ title: 'How quickly did enquiries get a reply?', takeaway: speedTake, rows: speedRows, series })}
      ${C.vbar({ title: 'Which days do enquiries arrive?', takeaway: topDay ? `<b>${esc(topDay.label)}</b> is the busiest day.` : '', rows: dayRows, series, shadeLabel: 'Shaded = days you\'re open' })}
      ${C.vbar({ title: 'How many enquiries came in each week?', takeaway: busiestWeek && busiestWeek.values[0] ? `The busiest was <b>the ${esc(busiestWeek.label.replace(/^Week/, 'week'))}</b>, with ${busiestWeek.values[0]} enquiries.` : '', rows: weekRows, series: [{ name: 'Enquiries', cls: 'after' }], legendSeries: compare ? series : [], wide: true })}
      ${C.vbar({ title: 'What time do enquiries arrive?', takeaway: latest.count ? `<b>${Math.round((latest.outOfHours / latest.count) * 10)} in 10</b> arrive when you're closed${compare ? ' (after)' : ''}.` : '', rows: hourRows, series, labelEvery: 3, shadeLabel: `Shaded = opening hours (${w.workStart}–${w.workEnd})`, wide: true })}
      ${C.split({ title: 'How do enquiries arrive?', takeaway: `${pctOf(latest.viaForm, latest.count)} came through the website form${compare ? ' (after)' : ''}; the rest were emailed directly.`, rows: splitRows, wide: true })}
    </div>`;
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
      if (label.startsWith('Replied') || label === 'No reply found') {
        const d = Math.abs(y - x) * 100;
        txt = d < 2 ? (better ? 'about the same' : 'about the same') : `${d >= 20 ? 'much ' : ''}${better ? 'better' : 'worse'}`;
        if (d < 2) return '<span class="same">about the same</span>';
      } else if (label === 'Time spent a month') txt = `${num(Math.abs(x - y), 1)} hrs ${y < x ? 'less' : 'more'}`;
      else if (lowerIsBetter && y < 0.05) txt = 'almost instant now';
      else if (lowerIsBetter && y > 0 && x / y >= 2) txt = `${num(x / y, x / y >= 10 ? 0 : 1)}× faster`;
      else txt = `${Math.round(Math.abs(1 - y / (x || 1)) * 100)}% ${y < x ? (lowerIsBetter ? 'faster' : 'lower') : (lowerIsBetter ? 'slower' : 'higher')}`;
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

  EnquiryCharts.initTooltips();
  initForm();
}());
