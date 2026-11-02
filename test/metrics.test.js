const test = require('node:test');
const assert = require('node:assert');
const M = require('../public/metrics');

const H = 3600000;
const w = { tz: 'Europe/London', workStart: '09:00', workEnd: '17:30', workDays: [1, 2, 3, 4, 5] };
const london = (y, m, d, h, mi = 0) => M.localToUtc(y, m, d, h, mi, 'Europe/London');

test('local time conversion handles summer time', () => {
  assert.strictEqual(london(2026, 7, 1, 9), Date.UTC(2026, 6, 1, 8));
  assert.strictEqual(london(2026, 12, 1, 9), Date.UTC(2026, 11, 1, 9));
});

test('working time skips evenings and weekends', () => {
  // Fri 16:30 → Mon 10:00 = 1h Friday + 1h Monday
  assert.strictEqual(M.workingMs(london(2026, 10, 30, 16, 30), london(2026, 11, 2, 10), w), 2 * H);
  // Saturday enquiry answered Saturday: no working time
  assert.strictEqual(M.workingMs(london(2026, 10, 31, 10), london(2026, 10, 31, 12), w), 0);
  // Across the clocks going back (Sun 25 Oct 2026)
  assert.strictEqual(M.workingMs(london(2026, 10, 23, 17), london(2026, 10, 26, 9, 30), w), 1 * H);
});

test('compute works out medians, rates and time spent', () => {
  const from = london(2026, 10, 1, 0);
  const to = from + 30 * 24 * H;
  const e = (start, replyH, extra = {}) => ({ receivedAt: start, firstReplyAt: replyH == null ? null : start + replyH * H, inboundCount: 1, outboundCount: replyH == null ? 0 : 1, mailboxes: ['a@x.com'], ...extra });
  const list = [
    e(london(2026, 10, 5, 10), 0.5),
    e(london(2026, 10, 6, 10), 2),
    e(london(2026, 10, 7, 20), 14),
    e(london(2026, 10, 10, 11), null, { viaForm: true }),
  ];
  const m = M.compute(list, { ...w, from, to, minutesPerEnquiry: 12 });
  assert.strictEqual(m.count, 4);
  assert.strictEqual(m.replied, 3);
  assert.strictEqual(m.unreplied, 1);
  assert.strictEqual(m.medianReplyHours, 2);
  assert.strictEqual(m.within1h, 0.25);
  assert.strictEqual(m.within24h, 0.75);
  assert.strictEqual(m.outOfHours, 2); // Wed 20:00 and Saturday
  assert.strictEqual(m.viaForm, 1);
  assert.strictEqual(m.hoursPerMonth, 0.8); // 4 enquiries × 12 min
  assert.strictEqual(M.duration(0.5), '30 min');
  assert.strictEqual(M.duration(3), '3 hrs');
});

test('reply buckets and weekly counts', () => {
  const t = london(2026, 10, 5, 10); // Monday
  const e = (start, h) => ({ receivedAt: start, firstReplyAt: h == null ? null : start + h * H });
  const b = M.replyBuckets([e(t, 0.5), e(t, 3), e(t, 30), e(t, 100), e(t, null), { receivedAt: t, replyMatchable: false }]);
  assert.deepStrictEqual(b.map((x) => x.count), [1, 1, 0, 1, 1, 1]);
  const w = M.weekly([e(t, 1), e(t + 24 * H, 1), e(t + 8 * 24 * H, 1)], london(2026, 10, 1, 0), london(2026, 10, 15, 0), 'Europe/London');
  assert.deepStrictEqual(w.map((x) => x.count), [0, 2, 1]); // weeks of 28 Sep, 5 Oct, 12 Oct
});
