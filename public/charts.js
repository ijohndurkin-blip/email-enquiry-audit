// Simple, readable charts in plain HTML (no libraries), so they print cleanly too.
// Every chart: a question as the title, a one-line takeaway, numbers on the bars,
// a hover tooltip on each bar, and a "Show the numbers" table.
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));

  /** series: [{ name, cls }] where cls is 'before' or 'after' (one series = 'after', the brand cyan). */
  function legend(series) {
    if (series.length < 2) return '';
    return `<div class="legend">${series.map((s) => `<span class="key"><i class="sw ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  }

  function numbersTable(head, rows) {
    return `<details class="numbers no-print"><summary>Show the numbers</summary>
      <table class="mini"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num-cell"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
  }

  function frame({ title, takeaway, body, series, table, wide }) {
    return `<figure class="chart card${wide ? ' wide' : ''}">
      <figcaption><h3>${esc(title)}</h3>${takeaway ? `<p class="takeaway">${takeaway}</p>` : ''}</figcaption>
      ${legend(series)}
      ${body}
      ${table}
    </figure>`;
  }

  /**
   * Horizontal bars: one row per category, one bar per series.
   * rows: [{ label, values: [n per series], note? }]
   */
  function hbar({ title, takeaway, rows, series, unit = 'enquiries' }) {
    const max = Math.max(1, ...rows.flatMap((r) => r.values));
    const body = `<div class="hbars">${rows.map((r) => `
      <div class="hrow">
        <div class="hlabel">${esc(r.label)}</div>
        <div class="hbarset">${r.values.map((v, i) => `
          <div class="htrack" tabindex="0" data-tip="${esc(`${r.label}${series.length > 1 ? ` (${series[i].name})` : ''}: ${fmt(v)} ${v === 1 ? unit.replace(/ies$/, 'y').replace(/s$/, '') : unit}`)}">
            <div class="hbar ${series[i].cls}" style="width:${(v / max) * 100}%"></div><span class="hval">${fmt(v)}</span>
          </div>`).join('')}
        </div>
      </div>`).join('')}</div>`;
    const table = numbersTable(['', ...series.map((s) => s.name)], rows.map((r) => [r.label, ...r.values.map(fmt)]));
    return frame({ title, takeaway, body, series, table });
  }

  /**
   * Vertical bars along a sequence (weeks, days, hours).
   * rows: [{ label, short, values: [n per series], shade? }] — shade marks e.g. opening hours.
   */
  function vbar({ title, takeaway, rows, series, legendSeries, unit = 'enquiries', shadeLabel, labelEvery = 1, wide }) {
    const max = Math.max(1, ...rows.flatMap((r) => r.values));
    const nonZero = rows.flatMap((r) => r.values).filter((v) => v > 0).length;
    const labelAll = rows.length * series.length <= 16 || nonZero <= 10;
    const peak = Math.max(...rows.flatMap((r) => r.values));
    const body = `<div class="vchart">
      <div class="vbars" style="--cols:${rows.length}">${rows.map((r, ri) => `
        <div class="vcol${r.shade ? ' shade' : ''}" tabindex="0" data-tip="${esc(`${r.label}: ${r.values.map((v, i) => `${series.length > 1 ? `${series[i].name} ` : ''}${fmt(v)}`).join(', ')} ${unit}`)}">
          <div class="vgroup">${r.values.map((v, i) => `
            <div class="vslot"><span class="vval">${v > 0 && (labelAll || v === peak) ? fmt(v) : ''}</span><div class="vbar ${r.cls || series[i].cls}" style="height:${(v / max) * 100}%"></div></div>`).join('')}
          </div>
          <span class="vlabel">${ri % labelEvery === 0 ? esc(r.short || r.label) : ''}</span>
        </div>`).join('')}
      </div>
      ${shadeLabel ? `<p class="shade-note"><i class="shade-key"></i>${esc(shadeLabel)}</p>` : ''}
    </div>`;
    const table = numbersTable(['', ...series.map((s) => s.name)], rows.map((r) => [r.label, ...r.values.map(fmt)]));
    return frame({ title, takeaway, body, series: legendSeries || series, table, wide });
  }

  /**
   * Part-to-whole: one 100% bar per period, split into named parts.
   * rows: [{ label, parts: [{ name, value, cls }] }]
   */
  function split({ title, takeaway, rows, wide }) {
    const names = rows[0] ? rows[0].parts.map((p) => ({ name: p.name, cls: p.cls })) : [];
    const body = `<div class="splits">${rows.map((r) => {
      const total = r.parts.reduce((s, p) => s + p.value, 0) || 1;
      return `<div class="split-row">
        ${rows.length > 1 ? `<div class="hlabel">${esc(r.label)}</div>` : ''}
        <div class="split-bar">${r.parts.filter((p) => p.value > 0).map((p) => `
          <div class="split-part ${p.cls}" style="flex:${p.value}" tabindex="0" data-tip="${esc(`${p.name}: ${fmt(p.value)} (${Math.round((p.value / total) * 100)}%)`)}"></div>`).join('')}
        </div>
        <div class="split-labels">${r.parts.map((p) => `<span><i class="sw ${p.cls}"></i>${esc(p.name)}: <b>${fmt(p.value)}</b> (${Math.round((p.value / total) * 100)}%)</span>`).join('')}</div>
      </div>`;
    }).join('')}</div>`;
    const table = numbersTable(['', ...names.map((n) => n.name)], rows.map((r) => [r.label, ...r.parts.map((p) => fmt(p.value))]));
    return frame({ title, takeaway, body, series: [], table, wide });
  }

  // One shared tooltip for every chart.
  function initTooltips() {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    const show = (el, x, y) => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
      const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
      tip.style.left = `${left + window.scrollX}px`;
      tip.style.top = `${top + window.scrollY}px`;
    };
    const hide = () => { tip.hidden = true; };
    document.addEventListener('mousemove', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) show(el, e.clientX, e.clientY); else hide();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) return hide();
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    });
    document.addEventListener('scroll', hide, { passive: true });
  }

  root.EnquiryCharts = { hbar, vbar, split, initTooltips };
}(window));
