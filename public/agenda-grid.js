// The day grid (one column per account, one row per hour) shared by the Calendário, the Aprovação and the project
// page. It only draws: each page binds its own clicks and drags.
import { fmtHour } from './agenda-time.js';

export const HOUR_PX = 44;
export const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Posts closer than one block apart go side by side instead of on top of each other. */
export function lanes(list) {
  const out = [];
  const ends = [];
  for (const p of [...list].sort((a, b) => a.at - b.at)) {
    let lane = ends.findIndex((e) => p.at >= e);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = p.at + 1800;
    out.push({ ...p, lane });
  }
  return out;
}

function blockHtml(p, from, lane, lanesN, tz) {
  const top = ((p.scheduled_at - from) / 3600) * HOUR_PX;
  const cls = p.status === 'posted' ? 'posted' : p.kind;
  const w = 92 / lanesN;
  return `<div class="cal-post ${cls}${p.mine ? ' mine' : ''}" data-post="${p.id}" style="top:${top}px;left:${4 + lane * w}%;width:${w - 1}%" title="${escape(`${fmtHour(p.scheduled_at, tz)} · ${p.media ? 'Photos' : p.kind === 'trial' ? 'Trial' : 'Normal'} · #${p.generation_id}${p.status === 'posted' ? ' · posted' : ''}${p.caption ? `\n${p.caption}` : ''}`)}" tabindex="0" role="button">
    ${p.chosen_image ? `<img src="/media/${escape(p.chosen_image)}" alt="">` : ''}<span>${fmtHour(p.scheduled_at, tz)}</span><small>#${p.generation_id}</small></div>`;
}

function ghostHtml(g, from, lane, lanesN, tz) {
  const top = ((g.at - from) / 3600) * HOUR_PX;
  const w = 92 / lanesN;
  return `<div class="cal-ghost ${g.kind}" style="top:${top}px;left:${4 + lane * w}%;width:${w - 1}%" title="${escape(g.title || '')}"><span>${fmtHour(g.at, tz)}</span><small>${escape(g.label || '')}</small></div>`;
}

/**
 * accounts: [{ id, platform, handle, model_id, model_name, active, trial }]; posts: rows of /api/schedule;
 * noAccounts: models without an active account (an empty column that links to Perfis);
 * ghosts: [{ account_id, at, kind: 'normal'|'trial', label, title }] — slots a choice would take (dashed).
 */
export function dayGridHtml({ from, to, tz, accounts = [], posts = [], noAccounts = [], ghosts = [], pickable = false }) {
  const hours = (to - from) / 3600; // 23–25 on clock-change days
  const height = Math.round(hours * HOUR_PX);
  const t = Math.floor(Date.now() / 1000);
  const nowLine = t >= from && t < to ? `<div class="cal-now" style="top:${((t - from) / 3600) * HOUR_PX}px"></div>` : '';
  // A model already drawn through a switched-off account (it has posts that day) needs no empty column too.
  const drawn = new Set(accounts.map((a) => a.model_id));
  const empties = noAccounts.filter((m) => !drawn.has(m.id));
  const many = new Set([...drawn, ...empties.map((m) => m.id)]).size > 1;
  const n = accounts.length + empties.length;
  const dayCount = (id) => posts.filter((p) => p.account_id === id && p.status !== 'pulled').length;
  const col = (a) => {
    const items = [
      ...posts.filter((p) => p.account_id === a.id).map((p) => ({ type: 'post', at: p.scheduled_at, p })),
      ...ghosts.filter((g) => g.account_id === a.id).map((g) => ({ type: 'ghost', at: g.at, g })),
    ];
    const L = lanes(items);
    const lanesN = Math.max(1, ...L.map((x) => x.lane + 1));
    return `<div class="cal-col${pickable ? ' pickable' : ''}" data-acc="${a.id}">${nowLine}${L.map((x) => (x.type === 'post' ? blockHtml(x.p, from, x.lane, lanesN, tz) : ghostHtml(x.g, from, x.lane, lanesN, tz))).join('')}</div>`;
  };
  return `
    <div class="card cal-card" style="--n:${Math.max(1, n)};--hp:${HOUR_PX}px">
     <div class="cal-inner">
      <div class="cal-heads"><div></div>${accounts.map((a) => `<div class="cal-head${a.active === 0 ? ' off' : ''}"><span class="pf-plat ${a.platform}">${PF_SHORT[a.platform]}</span><b>@${escape(a.handle)}</b>${many ? `<small>${escape(a.model_name || '')}</small>` : ''}${a.trial ? '<small class="ap-trial-tag">Trial</small>' : ''}${a.active === 0 ? '<small class="cal-off-tag">off</small>' : ''}<small class="cal-count">${dayCount(a.id) || ''}</small></div>`).join('')}${empties.map((m) => `<div class="cal-head empty"><b>${escape(m.name)}</b><small>no active accounts</small></div>`).join('')}</div>
      <div class="cal-scroll">
        <div class="cal-grid" style="height:${height}px">
          <div class="cal-hours">${Array.from({ length: Math.ceil(hours) }, (_, i) => `<span style="top:${i * HOUR_PX}px">${fmtHour(from + i * 3600, tz)}</span>`).join('')}</div>
          <div class="cal-cols">${accounts.map(col).join('')}${empties.map((m) => `<div class="cal-col empty">${nowLine}<a class="cal-empty-link" href="#/profiles">Turn on or add ${escape(m.name)}'s accounts in Profiles</a></div>`).join('')}</div>
        </div>
      </div>
     </div>
    </div>`;
}

/** Scrolls the grid so `t` (or 08:00 when `t` is another day) is near the top. */
export function scrollGridTo(box, from, to, t) {
  const grid = box?.querySelector('.cal-scroll');
  if (!grid) return;
  const y = t >= from && t < to ? ((t - from) / 3600) * HOUR_PX : 8 * HOUR_PX;
  grid.scrollTop = Math.max(0, y - 120);
}

/** The time under a click in a column, rounded to 5 minutes. */
export function timeAt(colEl, clientY, from) {
  const r = colEl.getBoundingClientRect();
  const secs = ((clientY - r.top) / HOUR_PX) * 3600;
  return from + Math.round(secs / 300) * 300;
}
