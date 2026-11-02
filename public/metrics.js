// Audit numbers, worked out in the browser so ticking an enquiry in or out updates
// everything instantly. Also loaded by the tests (CommonJS).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnquiryMetrics = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const fmtCache = new Map();

  function localParts(t, tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
      fmtCache.set(tz, f);
    }
    const p = {};
    for (const { type, value } of f.formatToParts(new Date(t))) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  }

  function offsetMs(t, tz) {
    const p = localParts(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  }

  /** A wall-clock time in `tz` as epoch ms. */
  function localToUtc(y, m, d, h, mi, tz) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    let t = guess - offsetMs(guess, tz);
    const off2 = offsetMs(t, tz);
    if (guess - off2 !== t) t = guess - off2;
    return t;
  }

  const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return [h || 0, m || 0]; };

  /**
   * Working time between two moments.
   * @param {{tz:string, workStart:'09:00', workEnd:'17:30', workDays:number[] (0=Sun)}} w
   */
  function workingMs(a, b, w) {
    if (!(b > a)) return 0;
    const [sh, sm] = hm(w.workStart);
    const [eh, em] = hm(w.workEnd);
    const p = localParts(a, w.tz);
    let day = Date.UTC(p.y, p.m - 1, p.d);
    let total = 0;
    for (let i = 0; i < 400; i += 1) {
      const dt = new Date(day);
      const y = dt.getUTCFullYear(); const m = dt.getUTCMonth() + 1; const d = dt.getUTCDate();
      const ws = localToUtc(y, m, d, sh, sm, w.tz);
      if (ws > b) break;
      if (w.workDays.includes(dt.getUTCDay())) {
        const we = localToUtc(y, m, d, eh, em, w.tz);
        total += Math.max(0, Math.min(b, we) - Math.max(a, ws));
      }
      day += DAY;
    }
    return total;
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * @param {object[]} enquiries  (already filtered to the period and to include === true)
   * @param {{from:number, to:number, tz, workStart, workEnd, workDays, minutesPerEnquiry?:number}} o
   */
  function compute(enquiries, o) {
    const days = Math.max(1, (o.to - o.from) / DAY);
    const matchable = enquiries.filter((e) => e.replyMatchable !== false);
    const replied = matchable.filter((e) => e.firstReplyAt);
    const replyH = replied.map((e) => (e.firstReplyAt - e.receivedAt) / HOUR).filter((h) => h >= 0);
    const workH = replied.map((e) => workingMs(e.receivedAt, e.firstReplyAt, o) / HOUR);
    const within = (h) => (matchable.length ? replyH.filter((x) => x <= h).length / matchable.length : null);
    const byWeekday = [0, 0, 0, 0, 0, 0, 0];
    const byHour = new Array(24).fill(0);
    let outOfHours = 0;
    for (const e of enquiries) {
      const p = localParts(e.receivedAt, o.tz);
      byWeekday[p.wd] += 1;
      byHour[p.h] += 1;
      const [sh, sm] = hm(o.workStart);
      const [eh, em] = hm(o.workEnd);
      const mins = p.h * 60 + p.mi;
      if (!o.workDays.includes(p.wd) || mins < sh * 60 + sm || mins >= eh * 60 + em) outOfHours += 1;
    }
    const perMailbox = {};
    enquiries.forEach((e) => (e.mailboxes || []).forEach((m) => { perMailbox[m] = (perMailbox[m] || 0) + 1; }));
    const perMonth = (n) => (n * 30) / days;
    // Follow-ups: conversations where the business replied and then heard nothing back.
    const asOf = o.asOf || Date.now();
    let wentQuiet = 0; let chased = 0; let waiting = 0;
    for (const e of replied) {
      const state = conversationState(e, asOf);
      if (state === 'quiet-chased') { wentQuiet += 1; chased += 1; }
      if (state === 'quiet-not-chased') wentQuiet += 1;
      if (state === 'waiting') waiting += 1;
    }
    const won = enquiries.filter((e) => e.outcome === 'won').length;
    // Reply quality (AI checks on the business's first reply, out of 5).
    const scored = enquiries.filter((e) => e.quality && Number.isFinite(e.quality.score));
    const qualityShare = {};
    for (const k of QUALITY_KEYS) qualityShare[k] = scored.length ? scored.filter((e) => e.quality.checks && e.quality.checks[k]).length / scored.length : null;
    const lost = enquiries.filter((e) => e.outcome === 'lost').length;
    const mins = Number(o.minutesPerEnquiry);
    return {
      days,
      count: enquiries.length,
      perMonth: perMonth(enquiries.length),
      perWeek: (enquiries.length * 7) / days,
      replied: replied.length,
      unreplied: matchable.length - replied.length,
      unmatchable: enquiries.length - matchable.length,
      replyRate: matchable.length ? replied.length / matchable.length : null,
      medianReplyHours: median(replyH),
      medianWorkingReplyHours: median(workH),
      within1h: within(1),
      within4h: within(4),
      within24h: within(24),
      slowest: replyH.length ? Math.max(...replyH) : null,
      avgEmails: enquiries.length ? enquiries.reduce((s, e) => s + e.inboundCount + e.outboundCount, 0) / enquiries.length : null,
      viaForm: enquiries.filter((e) => e.viaForm).length,
      outOfHours,
      byWeekday,
      byHour,
      perMailbox,
      wentQuiet,
      chased,
      notChased: wentQuiet - chased,
      customerWaiting: waiting,
      won,
      lost,
      winRate: won + lost ? won / (won + lost) : null,
      existingCustomers: enquiries.filter((e) => e.existing).length,
      misdirected: enquiries.filter((e) => !e.firstReplyAt && e.misdirected && e.misdirected.length).length,
      qualityScored: scored.length,
      avgQuality: scored.length ? scored.reduce((a, e) => a + e.quality.score, 0) / scored.length : null,
      qualityShare,
      minutesPerEnquiry: Number.isFinite(mins) && mins > 0 ? mins : null,
      hoursPerMonth: Number.isFinite(mins) && mins > 0 ? (perMonth(enquiries.length) * mins) / 60 : null,
    };
  }

  const QUALITY_KEYS = ['answered', 'next_step', 'asked_details', 'friendly', 'clear'];
  const QUALITY_LABELS = {
    answered: 'Answered their question',
    next_step: 'Gave a price or clear next step',
    asked_details: 'Asked for what\'s needed or how to book',
    friendly: 'Friendly and professional',
    clear: 'Clear and easy to read',
  };
  const QUIET_DAYS = 3;
  /**
   * Where a conversation stands:
   * 'no-reply' | 'waiting' (customer's latest email unanswered) | 'ongoing' (recent) |
   * 'quiet-chased' / 'quiet-not-chased' (business replied, customer silent 3+ days; chased = 2+ emails since).
   */
  function conversationState(e, asOf = Date.now()) {
    if (e.replyMatchable === false) return 'unknown';
    if (!e.firstReplyAt) return e.misdirected && e.misdirected.length ? 'misdirected' : 'no-reply';
    const lastOut = e.lastOutboundAt || e.firstReplyAt;
    if (e.lastInboundAt > lastOut) return 'waiting';
    if (asOf - lastOut < QUIET_DAYS * DAY) return 'ongoing';
    if (e.outsAfterLastIn == null) return 'unknown'; // audits saved before follow-ups were tracked
    const chased = e.followUps != null ? e.followUps >= 1 : e.outsAfterLastIn >= 2;
    return chased ? 'quiet-chased' : 'quiet-not-chased';
  }
  const STATE_LABELS = {
    'no-reply': 'No reply found',
    misdirected: 'Reply went to your own address',
    waiting: 'Waiting for your reply',
    ongoing: 'In progress',
    'quiet-chased': 'Went quiet: chased',
    'quiet-not-chased': 'Went quiet: not chased',
    unknown: '',
  };

  /** Human-friendly duration from hours. */
  function duration(h) {
    if (h == null || !Number.isFinite(h)) return '–';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${h < 10 ? (Math.round(h * 10) / 10) : Math.round(h)} hr${h >= 1.05 ? 's' : ''}`;
    return `${Math.round(h / 24 * 10) / 10} days`;
  }

  /** How long each enquiry waited for a first reply, in plain-English groups. */
  const BUCKETS = [
    { key: 'h1', label: 'Within an hour', max: 1 },
    { key: 'h4', label: '1 to 4 hours', max: 4 },
    { key: 'd1', label: '4 to 24 hours', max: 24 },
    { key: 'd2', label: '1 to 2 days', max: 48 },
    { key: 'more', label: 'More than 2 days', max: Infinity },
    { key: 'none', label: 'No reply found' },
  ];
  function replyBuckets(enquiries) {
    const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
    for (const e of enquiries) {
      if (e.replyMatchable === false) continue;
      if (!e.firstReplyAt) { counts.none += 1; continue; }
      const h = (e.firstReplyAt - e.receivedAt) / HOUR;
      counts[BUCKETS.find((b) => b.max != null && h <= b.max).key] += 1;
    }
    return BUCKETS.map((b) => ({ ...b, count: counts[b.key] }));
  }

  /** Enquiries per week (weeks start on Monday, in the business's time zone). */
  function weekly(enquiries, from, to, tz) {
    const weekStart = (t) => {
      const p = localParts(t, tz);
      const back = (p.wd + 6) % 7; // days since Monday
      return Date.UTC(p.y, p.m - 1, p.d - back);
    };
    const weeks = [];
    for (let w = weekStart(from); w <= weekStart(to - 1); w += 7 * DAY) weeks.push({ start: w, count: 0 });
    for (const e of enquiries) {
      const w = weeks.find((x) => x.start === weekStart(e.receivedAt));
      if (w) w.count += 1;
    }
    return weeks;
  }

  return { compute, workingMs, localParts, localToUtc, median, duration, replyBuckets, weekly, BUCKETS, conversationState, STATE_LABELS, QUIET_DAYS, QUALITY_KEYS, QUALITY_LABELS };
}));
