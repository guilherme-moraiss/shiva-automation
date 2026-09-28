// Custos: what the operation spends, per day and provider, and by AI model, kind of work and project.
import { icon, stripEmoji } from './icons.js';
import { partsIn, zonedToEpoch, nextDay, TZ_LABEL, PERIODS, presetRange as rangeIn } from './agenda-time.js';

let h; // { $, $$, esc, api, toast }
export function init(helpers) { h = helpers; }

const on = () => /^#\/usage(?:[/?]|$)/.test(location.hash);
const RANGES = PERIODS;
const COLORS = { wavespeed: 'var(--accent)', comfy: 'var(--dim)', fal: 'var(--warn)', runninghub: 'var(--good)', gemini: 'var(--tt)' };
const st = { range: '30', from: null, to: null, tz: 'Europe/Lisbon', seq: 0 };
const nowS = () => Math.floor(Date.now() / 1000);
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const ymd = (ts) => new Date(partsIn(ts * 1000, st.tz)).toISOString().slice(0, 10);

/** [from, to) of a preset, in the agenda's time zone (shared with Equipa). */
const presetRange = (key) => rangeIn(key, st.tz);

export async function renderUsage() {
  const seq = ++st.seq;
  const s = await h.api('/api/approval/settings');
  if (!on() || seq !== st.seq) return;
  st.tz = s.tz;
  if (st.range !== 'custom') [st.from, st.to] = presetRange(st.range);
  h.$('#view').innerHTML = `
    <h2>Costs</h2>
    <p class="sub">How much the operation is spending, per day, per provider, per model and per kind of work (days in ${h.esc(TZ_LABEL[st.tz] || st.tz)} time). The WaveSpeed amounts (and, before that, the Comfy API and fal.ai amounts) are the app's <b>estimates</b> from the price table; the RunningHub amounts come from the account itself.</p>
    <div class="toolbar">
      <div class="seg" id="us-range">${RANGES.map(([k, l]) => `<button data-r="${k}" class="${st.range === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="grow"></span>
      <label class="us-date">From <input class="input" type="date" id="us-from"></label>
      <label class="us-date">to <input class="input" type="date" id="us-to"></label>
    </div>
    <div id="us-body"><div class="page-loading"><div class="spinner"></div></div></div>`;
  h.$$('#us-range button').forEach((b) => (b.onclick = () => { st.range = b.dataset.r; renderUsage(); }));
  const fromIn = h.$('#us-from');
  const toIn = h.$('#us-to');
  fromIn.value = ymd(st.from);
  toIn.value = ymd(Math.max(st.from, st.to - 1));
  const custom = () => {
    if (!fromIn.value || !toIn.value) return;
    const f = zonedToEpoch(`${fromIn.value}T00:00`, st.tz);
    const t = nextDay(zonedToEpoch(`${toIn.value}T00:00`, st.tz), st.tz);
    if (!f || !t || t <= f) return h.toast('The end date must be the same as or after the start date', true);
    st.range = 'custom'; st.from = f; st.to = Math.min(t, nowS() + 86400);
    renderUsage();
  };
  fromIn.onchange = custom;
  toIn.onchange = custom;
  load(seq);
}

async function load(seq) {
  let d; let bal = null;
  try {
    [d, bal] = await Promise.all([h.api(`/api/usage?from=${st.from}&to=${st.to}`), h.api('/api/usage/balances').catch(() => null)]);
  } catch (e) {
    if (on() && seq === st.seq) h.$('#us-body').innerHTML = `<div class="empty">${icon('alert-circle', { size: 28 })}<h3>Could not load</h3><p>${h.esc(stripEmoji(e.message))}</p></div>`;
    return;
  }
  if (!on() || seq !== st.seq) return;
  const tile = (k, v, sub = '') => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="dim" style="font-size:12px">${sub}</span>` : ''}</div>`;
  const balTile = (name, b, url) => {
    if (!b) return tile(`${name} balance`, '—', 'no key in Settings');
    if (b.error) return tile(`${name} balance`, '—', h.esc(stripEmoji(b.error).slice(0, 60)));
    const v = b.usd ?? b.money;
    return tile(`${name} balance`, v == null ? `${b.coins ?? '—'} coins` : b.currency === 'CNY' ? `¥${v.toFixed(2)}` : money(v), `${url ? `<a href="${url}" target="_blank" rel="noopener">top up</a>` : ''}${b.coins != null && v != null ? ` · ${b.coins} coins` : ''}`);
  };
  const body = h.$('#us-body');
  body.innerHTML = `
    <div class="tiles">
      ${tile('Total spent', money(d.total), `${d.days.length} day(s)${d.estimatedShare ? ` · ${d.estimatedShare}% estimated` : ''}`)}
      ${tile('Daily average', money(d.perDayAvg))}
      ${tile('Paid jobs', String(d.paidJobs), 'projects, creations and 18+')}
      ${tile('Average cost per project', d.avgPerProject ? money(d.avgPerProject) : '—')}
      ${tile('Actual (balance drop)', d.real?.since ? money(d.real.total) : '—', d.real?.since ? `since ${new Date(d.real.since * 1000).toLocaleDateString('en-GB')} · estimated for the same period ${money(d.days.filter((x) => (d.real.byDay || []).some((r) => r.day === x.day)).reduce((a, x) => a + x.total, 0))}` : 'the app starts measuring from now on (balance readings every 5 min)')}
      ${balTile('WaveSpeed', bal?.wavespeed, 'https://wavespeed.ai/top-up')}
      ${balTile('RunningHub', bal?.runninghub, 'https://www.runninghub.ai')}
    </div>
    <div class="card">
      <div class="row between"><h3 style="margin:0">Spent per day</h3>
        <span class="us-legend">${d.byProvider.map((p) => `<i style="background:${COLORS[p.key] || 'var(--dim)'}"></i>${h.esc(p.label)}`).join('')}</span></div>
      ${chartHtml(d)}
    </div>
    <div class="grid-2">
      ${breakdown('By model', d.byModel, d.total)}
      ${breakdown('By kind of work', d.byCategory, d.total)}
      ${breakdown('By provider', d.byProvider, d.total, (x) => COLORS[x.key])}
      ${breakdown('By person', d.byUser, d.total, null, d.hasTeam
        ? 'Each cost goes to whoever started or redid that work (the name chosen in “Working as”). See <a href="#/team">Team</a>.'
        : 'Add the people who work with you in <a href="#/team">Team</a>: each cost then goes to whoever did it.')}
    </div>
    ${dayByPerson(d)}
    <div class="card">
      <h3>Most expensive projects</h3>
      ${d.topProjects.length ? `<div class="us-top">${d.topProjects.map((p) => `<a class="us-top-row" href="#/projects/${p.key}"><b>#${p.key}</b><span class="dim">${p.handle ? `@${h.esc(p.handle)}` : ''}</span><span class="grow"></span><span>${money(p.amount)}</span><span class="dim">${p.n} payment(s)</span></a>`).join('')}</div>` : '<div class="dim" style="font-size:13px">No paid projects in this period.</div>'}
      ${d.otherCurrencies.length ? `<div class="dim" style="font-size:12.5px;margin-top:10px">${d.otherCurrencies.map((c) => `In ${c.label}: ${c.amount.toFixed(2)} (${c.n} payment(s)), not added to the dollar total.`).join(' ')}</div>` : ''}
    </div>`;
  bindChart(d);
}

function chartHtml(d) {
  const max = Math.max(0.01, ...d.days.map((x) => x.total));
  const every = d.days.length > 45 ? 10 : d.days.length > 20 ? 5 : d.days.length > 10 ? 2 : 1;
  const providers = d.byProvider.map((p) => p.key);
  return `<div class="us-chart">
    <div class="us-axis"><span>${money(max)}</span><span>${money(max / 2)}</span><span>$0</span></div>
    <div class="us-bars">${d.days.map((x, i) => `
      <div class="us-day" data-i="${i}" tabindex="0" aria-label="${h.esc(`${x.day}: ${money(x.total)}`)}">
        <div class="us-stack">${providers.map((p) => (x.byProvider[p] ? `<i style="height:${(x.byProvider[p] / max) * 100}%;background:${COLORS[p] || 'var(--dim)'}"></i>` : '')).join('')}</div>
        <span class="us-lbl">${i % every === 0 ? `${x.day.slice(8, 10)}/${x.day.slice(5, 7)}` : ''}</span>
      </div>`).join('')}</div>
    <div class="us-tip" id="us-tip" hidden></div>
  </div>`;
}

/** Hover or focus a day: its total and the part of each provider. */
function bindChart(d) {
  const tip = h.$('#us-tip');
  if (!tip) return;
  h.$$('.us-day').forEach((el) => {
    const x = d.days[Number(el.dataset.i)];
    const show = () => {
      const parts = Object.entries(x.byProvider).sort((a, b) => b[1] - a[1]);
      const real = (d.real?.byDay || []).find((r) => r.day === x.day);
      tip.innerHTML = `<b>${x.day.slice(8, 10)}/${x.day.slice(5, 7)}/${x.day.slice(0, 4)}</b> · ${money(x.total)} estimated${parts.map(([p, v]) => `<div><i style="background:${COLORS[p] || 'var(--dim)'}"></i>${h.esc(d.providers[p] || p)}: ${money(v)}</div>`).join('')}${real ? `<div>Actual (balance drop): ${money(real.total)}</div>` : ''}`;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const box = el.closest('.us-chart').getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 190, Math.max(40, r.left - box.left - 70))}px`;
    };
    el.onmouseenter = show;
    el.onfocus = show;
    el.onmouseleave = () => { tip.hidden = true; };
    el.onblur = () => { tip.hidden = true; };
  });
}

/** Day by day per person: how many images, edits and videos, and the money; days over the person's budget in red. */
function dayByPerson(d) {
  const rows = d.byUserDay || [];
  if (!rows.length) return '';
  const n = (x) => (x ? String(Math.round(x)) : '—');
  return `<div class="card">
    <h3>Day by day per person</h3>
    <div class="us-table-wrap"><table class="us-table"><thead><tr><th>Day</th><th>Person</th><th>Images</th><th>Edits</th><th>Videos</th><th>Spent</th></tr></thead>
    <tbody>${rows.map((x) => { const over = x.budget > 0 && x.amount > x.budget; return `<tr class="${over ? 'over' : ''}"><td>${x.day.slice(8, 10)}/${x.day.slice(5, 7)}</td><td>${h.esc(x.name)}</td><td>${n(x.images)}</td><td>${n(x.edits)}</td><td>${x.videos ? `${x.videos} (${Math.round(x.seconds)} s)` : '—'}</td><td><b>${money(x.amount)}</b>${x.budget ? ` <span class="dim">/ ${money(x.budget)}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
    <div class="dim" style="font-size:12px;margin-top:8px">The counts start ${d.unitsSince ? `on ${new Date(d.unitsSince * 1000).toLocaleDateString('en-GB')}` : 'with the next costs'} (earlier costs did not record how many images or seconds they were). Each person's daily budget is set in <a href="#/team">Team</a>.</div>
  </div>`;
}

function breakdown(title, list, total, color = null, note = '') {
  return `<div class="card us-break">
    <h3>${title}</h3>
    ${list.length ? list.map((x) => {
      const pct = total ? Math.round((x.amount / total) * 100) : 0;
      return `<div class="us-row"><div class="row between"><span>${h.esc(x.label)}</span><span><b>${money(x.amount)}</b> <span class="dim">· ${pct}%</span></span></div>
        <div class="us-bar"><i style="width:${Math.max(1, pct)}%;${color ? `background:${color(x) || 'var(--accent)'}` : ''}"></i></div></div>`;
    }).join('') : '<div class="dim" style="font-size:13px">No spending in this period.</div>'}
    ${note ? `<div class="dim" style="font-size:12px;margin-top:8px">${note}</div>` : ''}
  </div>`;
}
