// Step 7 · Publicar, inside the project (the reference's "post" step): her accounts, a caption from her pool, the time
// (the next free slot, or one picked on the day grid) and Normal / Trial — the same rules and routes as Aprovação.
import { icon, stripEmoji } from './icons.js';
import { zonedToEpoch, partsIn, dayStart, nextDay, prevDay, fmtDayTitle, fmtHour as fmtHourIn, fmtWhen as fmtWhenIn } from './agenda-time.js';
import { dayGridHtml, scrollGridTo, timeAt } from './agenda-grid.js';

const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const nowS = () => Math.floor(Date.now() / 1000);
let tzCache = null;
/** What you chose on each project (kept while its card is redrawn). */
const picks = new Map();

export async function mountPublish(box, g, reload, h) {
  if (!box || box.dataset.mounted) return;
  box.dataset.mounted = '1';
  const s = picks.get(g.id) || { selected: null, caption: null, captionId: null, original: '', at: null, day: null, manual: false, accounts: [], others: [], plan: null };
  picks.set(g.id, s);
  let tz = 'Europe/Lisbon';
  try { tz = (tzCache ||= await h.api('/api/approval/settings')).tz || tz; } catch { tzCache = null; }
  const fmtWhen = (ts) => fmtWhenIn(ts, tz);
  const fmtHour = (ts) => fmtHourIn(ts, tz);
  const toLocal = (ts) => new Date(partsIn(ts * 1000, tz)).toISOString().slice(0, 16);
  box.innerHTML = `
    <div class="pub">
      <div class="pub-form stack">
        <div><div class="label">Accounts</div><div class="ap-chips" data-pub-chips><span class="dim">Loading…</span></div></div>
        <label class="field"><span>Caption <button type="button" class="link-btn" data-pub-other>Another from the list</button></span>
          <textarea class="input" rows="3" data-pub-cap maxlength="2200"></textarea></label>
        <div class="row" style="gap:8px;align-items:flex-end">
          <label class="field"><span>Time (${h.esc(tz)})</span><input class="input" type="datetime-local" data-pub-at></label>
          <button type="button" class="btn sm ghost" data-pub-auto>Next free slot</button>
        </div>
        <div class="pub-pv dim" data-pub-pv></div>
        <div class="row">
          <button class="btn primary" data-pub="normal">${icon('send')}Normal</button>
          <button class="btn" data-pub="trial" title="Test reel on Instagram (shown first to non-followers)">${icon('send')}Trial</button>
          <a class="btn ghost" href="#/approval?gen=${g.id}" title="The same choice on the Approval page">${icon('external-link')}In Approval</a>
        </div>
      </div>
      <div class="pub-cal">
        <div class="row between" style="gap:6px"><div class="row" style="gap:6px">
          <button class="btn sm icon-only" data-pub-prev title="Previous day" aria-label="Previous day">${icon('chevron-left')}</button>
          <b class="cal-day" data-pub-day></b>
          <button class="btn sm icon-only" data-pub-next title="Next day" aria-label="Next day">${icon('chevron-right')}</button></div>
          <span class="dim" style="font-size:12px">dashed: where it goes · click a column to choose the time</span></div>
        <div data-pub-grid><div class="page-loading" style="min-height:120px"><div class="spinner"></div></div></div>
      </div>
    </div>`;
  const $ = (sel) => box.querySelector(sel);
  const cap = $('[data-pub-cap]');
  const atIn = $('[data-pub-at]');
  cap.oninput = () => { s.caption = cap.value; };
  atIn.onchange = () => { s.at = atIn.value ? zonedToEpoch(atIn.value, tz) : null; s.manual = !!s.at; preview(); };
  $('[data-pub-auto]').onclick = () => { s.at = null; s.manual = false; atIn.value = ''; preview(); };
  $('[data-pub-other]').onclick = async () => {
    try {
      const c = await h.api(`/api/approval/${g.id}/context${s.captionId ? `?exclude=${s.captionId}` : ''}`);
      if (!c.caption) return h.toast('There are no captions in Profiles for this model', true);
      cap.value = c.caption.text; s.caption = c.caption.text; s.captionId = c.caption.id;
    } catch (e) { h.toast(e.message, true); }
  };
  const chips = () => {
    const el = $('[data-pub-chips]');
    const acc = s.accounts.filter((a) => a.active);
    if (!acc.length) { el.innerHTML = `<span class="msg warn">${icon('alert-triangle')}This model has no active accounts yet: add them in <a href="#/profiles">Profiles</a>.</span>`; return; }
    const chip = (a) => `<button type="button" class="ap-chip ${s.selected.has(a.id) ? 'on' : ''}" data-acc="${a.id}" aria-pressed="${s.selected.has(a.id)}"><span class="pf-plat ${a.platform}">${PF_SHORT[a.platform]}</span>@${h.esc(a.handle)}${a.trial ? '<span class="ap-trial-tag">Trial</span>' : ''}</button>`;
    const others = s.others || [];
    const onOthers = others.filter((a) => s.selected.has(a.id)).length;
    el.innerHTML = acc.map(chip).join('') + (others.length ? `<details class="ap-others" ${onOthers ? 'open' : ''}><summary>Other accounts (${others.length})</summary>${[...new Set(others.map((a) => a.model_name))].map((n) => `<div class="ap-others-row"><span class="dim">${h.esc(n)}</span>${others.filter((a) => a.model_name === n).map(chip).join('')}</div>`).join('')}</details>` : '');
    el.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => { const id = Number(b.dataset.acc); s.selected.has(id) ? s.selected.delete(id) : s.selected.add(id); chips(); preview(); }));
  };
  let pvSeq = 0;
  const preview = async () => {
    const seq = ++pvSeq;
    let r;
    try { r = await h.api(`/api/approval/${g.id}/preview`, { method: 'POST', body: { accounts: [...s.selected], at: s.at } }); } catch (e) { $('[data-pub-pv]').innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`; return; }
    if (seq !== pvSeq || !box.isConnected) return;
    s.plan = r;
    const one = (list) => (list.length ? `${fmtWhen(list[0].at)}${list.length > 1 ? ` (${list.length} accounts)` : ` · @${h.esc(list[0].handle)}`}` : '—');
    $('[data-pub-pv]').innerHTML = `Normal: <b>${one(r.normal)}</b> · Trial: <b>${one(r.trial)}</b>`;
    $('[data-pub="normal"]').disabled = !r.normal.length;
    $('[data-pub="trial"]').disabled = !r.trial.length;
    if (!s.manual || !s.day) s.day = dayStart(r.normal[0]?.at || r.trial[0]?.at || nowS(), tz);
    grid();
  };
  let gSeq = 0;
  const grid = async () => {
    const seq = ++gSeq;
    const from = s.day || dayStart(nowS(), tz);
    const to = nextDay(from, tz);
    $('[data-pub-day]').textContent = fmtDayTitle(from + 3600, tz);
    let d;
    try { d = await h.api(`/api/schedule?from=${from}&to=${to}&model=${g.model_id}`); } catch (e) { $('[data-pub-grid]').innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`; return; }
    if (seq !== gSeq || !box.isConnected) return;
    const plan = s.plan || { normal: [], trial: [] };
    const ghosts = [
      ...plan.normal.filter((x) => x.at >= from && x.at < to).map((x) => ({ account_id: x.accountId, at: x.at, kind: 'normal', label: 'Normal', title: `If you choose Normal: ${fmtWhen(x.at)}` })),
      ...plan.trial.filter((x) => x.at >= from && x.at < to).map((x) => ({ account_id: x.accountId, at: x.at, kind: 'trial', label: 'Trial', title: `If you choose Trial: ${fmtWhen(x.at)}` })),
    ];
    const el = $('[data-pub-grid]');
    el.innerHTML = dayGridHtml({ from, to, tz, accounts: d.accounts, posts: d.posts, noAccounts: d.noAccounts, ghosts, pickable: true });
    const picked = s.at >= from && s.at < to ? s.at : null;
    scrollGridTo(el, from, to, picked || ghosts[0]?.at || nowS());
    el.querySelectorAll('.cal-col[data-acc]').forEach((col) => (col.onclick = (e) => {
      if (e.target.closest('.cal-post')) return;
      const at = timeAt(col, e.clientY, from);
      if (at < nowS() - 60) return h.toast('That time has already passed', true);
      s.at = at; s.manual = true;
      atIn.value = toLocal(at);
      h.toast(`Time chosen: ${fmtWhen(at)}`);
      preview();
    }));
    el.querySelectorAll('.cal-post').forEach((p) => {
      const post = d.posts.find((x) => x.id === Number(p.dataset.post));
      if (post && post.generation_id !== g.id) p.onclick = () => window.open(`#/projects/${post.generation_id}`, '_blank');
    });
  };
  $('[data-pub-prev]').onclick = () => { s.day = prevDay(s.day || dayStart(nowS(), tz), tz); s.manual = true; grid(); };
  $('[data-pub-next]').onclick = () => { s.day = nextDay(s.day || dayStart(nowS(), tz), tz); s.manual = true; grid(); };
  box.querySelectorAll('[data-pub]').forEach((b) => (b.onclick = async () => {
    const action = b.dataset.pub;
    box.querySelectorAll('[data-pub]').forEach((x) => (x.disabled = true));
    try {
      const r = await h.api(`/api/approval/${g.id}/decide`, { method: 'POST', body: { action, accounts: [...s.selected], caption: cap.value, at: s.at } });
      picks.delete(g.id);
      h.toast(`${action === 'trial' ? 'Trial' : 'Normal'} scheduled: ${r.posts.map((p) => PF_SHORT[p.platform]).join(', ')} · ${fmtWhen(r.posts[0].at)}`);
      reload();
    } catch (e) { h.toast(e.message, true); box.querySelectorAll('[data-pub]').forEach((x) => (x.disabled = false)); preview(); }
  }));
  // Accounts and a caption from her pool (kept if you had already chosen them on this project).
  try {
    const c = await h.api(`/api/approval/${g.id}/context`);
    if (!box.isConnected) return;
    s.accounts = c.accounts;
    s.others = c.others || [];
    if (!s.selected) s.selected = new Set(c.accounts.filter((a) => a.active).map((a) => a.id));
    if (s.caption == null) { s.caption = c.caption?.text || ''; s.captionId = c.caption?.id || null; s.original = s.caption; }
    cap.value = s.caption;
    if (s.at) atIn.value = toLocal(s.at);
    chips();
    preview();
  } catch (e) { $('[data-pub-chips]').innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`; }
}
