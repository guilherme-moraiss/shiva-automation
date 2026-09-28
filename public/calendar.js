// Calendário: every post of a day by account and hour. Drag a post to change its time, click it to edit (time,
// caption, take it off that account, mark it published). "A publicar agora" lists what is due: no posting service is
// connected yet, so the team downloads the video, copies the caption, posts it and marks it here.
import { icon, stripEmoji } from './icons.js';
import { partsIn, zonedToEpoch, dayStart, nextDay, prevDay, fmtDayTitle, fmtHour, TZ_LABEL } from './agenda-time.js';
import { dayGridHtml, scrollGridTo, HOUR_PX } from './agenda-grid.js';

let h; // { $, $$, esc, api, toast, showModal, closeModal, state }
export function init(helpers) { h = helpers; }

const on = () => /^#\/calendar(?:[/?]|$)/.test(location.hash);
const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const SNAP = 5 * 60; // a drag moves in 5-minute steps
const st = { day: null, dayTz: null, model: '', tz: 'Europe/Lisbon', data: null, seq: 0, keyHandler: null, dueTimer: null, dragging: false };

const nowS = () => Math.floor(Date.now() / 1000);
const toLocalInput = (ts) => new Date(partsIn(ts * 1000, st.tz)).toISOString().slice(0, 16);

export async function renderCalendar(params) {
  const seq = ++st.seq;
  clearTimeout(st.dueTimer);
  if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
  const s = await h.api('/api/approval/settings');
  if (!on() || seq !== st.seq) return;
  st.tz = s.tz;
  if (params.get('model') !== null) st.model = params.get('model') || '';
  if (!st.day || st.dayTz !== st.tz) { st.day = dayStart(nowS(), st.tz); st.dayTz = st.tz; }
  h.$('#view').innerHTML = `
    <h2>Calendar</h2>
    <p class="sub">Every post of the day, by account and by hour (${h.esc(TZ_LABEL[st.tz] || st.tz)}). Drag a post to change its time; click it to change the caption, pull it or mark it as posted.</p>
    <div class="card cal-due" id="cal-due"><div class="dim">Loading…</div></div>
    <div class="toolbar cal-bar">
      <div class="row" style="gap:6px">
        <button class="btn sm icon-only" id="cal-prev" title="Previous day" aria-label="Previous day">${icon('chevron-left')}</button>
        <b class="cal-day" id="cal-day"></b>
        <button class="btn sm icon-only" id="cal-next" title="Next day" aria-label="Next day">${icon('chevron-right')}</button>
        <button class="btn sm" id="cal-today">Today</button>
      </div>
      <select class="input" id="cal-model" aria-label="Model"><option value="">All models</option>${(h.state.models || []).map((m) => `<option value="${m.id}" ${String(st.model) === String(m.id) ? 'selected' : ''}>${h.esc(m.name)}</option>`).join('')}</select>
      <span class="grow"></span>
      <span class="cal-legend"><i class="normal"></i>Normal <i class="trial"></i>Trial <i class="posted"></i>Posted</span>
      <a class="btn sm" href="#/scheduled">${icon('list')}Scheduled</a>
    </div>
    <div id="cal-grid"><div class="page-loading"><div class="spinner"></div></div></div>`;
  h.$('#cal-prev').onclick = () => { st.day = prevDay(st.day, st.tz); loadDay(); };
  h.$('#cal-next').onclick = () => { st.day = nextDay(st.day, st.tz); loadDay(); };
  h.$('#cal-today').onclick = () => { st.day = dayStart(nowS(), st.tz); loadDay(true); };
  h.$('#cal-model').onchange = (e) => { st.model = e.target.value; loadDay(); loadDue(); };
  st.keyHandler = (e) => {
    if (!on() || e.ctrlKey || e.metaKey || e.altKey || h.$('#modal:not(.hidden)')) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === '-') { e.preventDefault(); h.$('#cal-prev').click(); }
    if (k === 'ArrowRight' || k === '+' || k === '=') { e.preventDefault(); h.$('#cal-next').click(); }
  };
  window.addEventListener('keydown', st.keyHandler, true);
  loadDue();
  await loadDay(true);
}

// ---- A publicar agora --------------------------------------------------------------------------------------------
async function loadDue() {
  clearTimeout(st.dueTimer);
  if (!on()) return;
  let rows;
  try { rows = await h.api(`/api/posts/due?soon=30${st.model ? `&model=${st.model}` : ''}`); } catch (e) {
    const box = h.$('#cal-due');
    if (box) box.innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`;
    st.dueTimer = setTimeout(loadDue, 30000);
    return;
  }
  const box = h.$('#cal-due');
  if (!box || !on()) return;
  const t = nowS();
  const badge = h.$('#nav-due');
  if (badge) badge.textContent = rows.length || '';
  box.innerHTML = `
    <div class="row between"><h3 style="margin:0">${icon('send')}To post now <span class="dim" style="font-weight:400;font-size:12.5px">· due now or in the next 30 min</span></h3>
      <span class="dim" style="font-size:12px">No service that posts on its own is connected yet: download, post and mark it here.</span></div>
    ${rows.length ? `<div class="due-list">${rows.map((p) => {
      const late = p.scheduled_at < t - 60;
      return `<div class="due-row ${late ? 'late' : ''}" data-post="${p.id}">
        <span class="due-time">${fmtHour(p.scheduled_at, st.tz)}${late ? `<small>${lateText(t - p.scheduled_at)}</small>` : `<small>in ${Math.max(1, Math.round((p.scheduled_at - t) / 60))} min</small>`}</span>
        <span class="pf-plat ${p.platform}">${PF_SHORT[p.platform]}</span>
        <div class="due-main"><b>@${h.esc(p.handle)}</b> <span class="dim">· ${h.esc(p.model_name || '')} · <a href="#/projects/${p.generation_id}">#${p.generation_id}</a>${p.kind === 'trial' ? ' · Trial' : ''}</span>
          <div class="due-cap" title="${h.esc(p.caption)}">${p.caption ? h.esc(p.caption) : '<span class="dim">No caption</span>'}</div></div>
        <div class="row" style="flex-wrap:wrap;justify-content:flex-end;max-width:60%">
          ${(() => { let m = []; try { m = JSON.parse(p.media || '[]'); } catch {} return m.length ? m.map((_, i) => `<a class="btn sm" href="/api/posts/${p.id}/photo/${i}" download title="Download photo ${i + 1}">${icon('download')}${m.length > 1 ? `Photo ${i + 1}` : 'Photo'}</a>`).join('') : `<a class="btn sm" href="/api/posts/${p.id}/video" download title="Download the video for this post">${icon('download')}Video</a>`; })()}
          <button class="btn sm" data-copy title="Copy the caption">${icon('copy')}Caption</button>
          <button class="btn sm primary" data-posted>${icon('check')}Posted</button>
        </div>
      </div>`;
    }).join('')}</div>` : '<div class="dim" style="font-size:13px;margin-top:8px">Nothing to post right now.</div>'}`;
  h.$$('.due-row', box).forEach((row) => {
    const p = rows.find((x) => x.id === Number(row.dataset.post));
    h.$('[data-copy]', row).onclick = async () => {
      try { await navigator.clipboard.writeText(p.caption || ''); h.toast('Caption copied'); } catch { h.toast('Could not copy: select the caption and copy it by hand', true); }
    };
    h.$('[data-posted]', row).onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        await h.api(`/api/posts/${p.id}/posted`, { method: 'POST' });
        h.toast(`@${p.handle}: marked as posted`);
        loadDue();
        loadDay();
      } catch (err) { h.toast(err.message, true); e.currentTarget.disabled = false; }
    };
  });
  st.dueTimer = setTimeout(loadDue, 60000);
}
const lateText = (s) => (s < 3600 ? `${Math.round(s / 60)} min late` : `${Math.round(s / 3600)} h late`);

// ---- the day grid ------------------------------------------------------------------------------------------------
async function loadDay(scrollToNow = false) {
  const seq = st.seq;
  const from = st.day;
  const to = nextDay(from, st.tz);
  h.$('#cal-day').textContent = fmtDayTitle(from + 3600, st.tz);
  let d;
  try { d = await h.api(`/api/schedule?from=${from}&to=${to}${st.model ? `&model=${st.model}` : ''}`); } catch (e) {
    if (on() && seq === st.seq) h.$('#cal-grid').innerHTML = `<div class="empty">${h.esc(stripEmoji(e.message))}</div>`;
    return;
  }
  if (!on() || seq !== st.seq || from !== st.day) return;
  st.data = { ...d, from, to };
  paintGrid();
  if (scrollToNow) scrollGridTo(h.$('#cal-grid'), from, to, nowS());
}

function paintGrid() {
  const { accounts, posts, noAccounts = [], from, to } = st.data;
  const box = h.$('#cal-grid');
  if (!box) return;
  if (!accounts.length && !noAccounts.length) {
    box.innerHTML = `<div class="empty">${icon('user-check', { size: 28 })}<h3>No models</h3><p>Create a model in <a href="#/models">Models</a> and add her accounts in <a href="#/profiles">Profiles</a>.</p></div>`;
    return;
  }
  box.innerHTML = dayGridHtml({ from, to, tz: st.tz, accounts, posts, noAccounts });
  h.$$('.cal-post', box).forEach(bindBlock);
}

function bindBlock(el) {
  const p = st.data.posts.find((x) => x.id === Number(el.dataset.post));
  if (!p) return;
  el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(p); } };
  el.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    const top0 = parseFloat(el.style.top);
    let moved = false;
    const canMove = p.status === 'scheduled';
    try { el.setPointerCapture(e.pointerId); } catch {} // keeps the drag even when the pointer leaves the block
    const move = (ev) => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      if (!canMove) return;
      moved = true;
      st.dragging = true;
      const snapped = Math.round((((top0 + dy) / HOUR_PX) * 3600) / SNAP) * SNAP;
      const at = st.data.from + snapped;
      el.style.top = `${(snapped / 3600) * HOUR_PX}px`;
      el.querySelector('span').textContent = fmtHour(at, st.tz);
      el.classList.add('drag');
    };
    const up = async (ev) => {
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      el.onpointermove = null;
      el.onpointerup = null;
      el.classList.remove('drag');
      st.dragging = false;
      if (!moved) return openPost(p);
      const at = st.data.from + Math.round(((parseFloat(el.style.top) / HOUR_PX) * 3600) / SNAP) * SNAP;
      if (at === p.scheduled_at) return;
      try {
        const r = await h.api(`/api/posts/${p.id}`, { method: 'PATCH', body: { scheduled_at: at } });
        h.toast(r.tooClose ? `Moved to ${fmtHour(at, st.tz)}, but it is close to another post on this account` : `@${p.handle}: now at ${fmtHour(at, st.tz)}`, r.tooClose);
      } catch (err) { h.toast(err.message, true); }
      loadDay();
      loadDue();
    };
    el.onpointermove = move;
    el.onpointerup = up;
  };
}

// ---- one post ----------------------------------------------------------------------------------------------------
function openPost(p) {
  const done = p.status === 'posted';
  let photos = []; // a photo / carousel post: its images, in order
  try { photos = JSON.parse(p.media || '[]'); } catch {}
  h.showModal(`<div class="modal-box small cal-modal">
    <div class="row between"><h3 style="margin:0"><span class="pf-plat ${p.platform}">${PF_SHORT[p.platform]}</span> @${h.esc(p.handle)}</h3>
      <span class="sc-kind ${p.kind}">${p.kind === 'trial' ? 'Trial' : 'Normal'}</span></div>
    <div class="dim" style="font-size:12.5px;margin:4px 0 10px">${h.esc(p.model_name || '')} · <a href="#/projects/${p.generation_id}" data-close>project #${p.generation_id}</a>${done ? ' · <b style="color:var(--good-text)">posted</b>' : ''}</div>
    ${photos.length ? `<div class="ap-photos" style="margin-bottom:10px"><b>${photos.length === 1 ? 'Photo' : `Carousel · ${photos.length} photos`}</b><div class="ap-photo-grid">${photos.map((m, i) => `<a class="ap-photo on" href="/api/posts/${p.id}/photo/${i}" download title="Download photo ${i + 1}"><img src="/media/${h.esc(m)}" alt=""><span>${i + 1}</span></a>`).join('')}</div></div>`
      : `<video src="/api/generations/${p.generation_id}/video" preload="metadata" controls playsinline class="cal-video"></video>`}
    <label class="field"><span>Time (${h.esc(TZ_LABEL[st.tz] || st.tz)})</span><input class="input" type="datetime-local" id="pe-at" value="${toLocalInput(p.scheduled_at)}" ${done ? 'disabled' : ''}></label>
    <label class="field"><span>Caption</span><textarea class="input" id="pe-cap" rows="3" maxlength="2200" ${done ? 'disabled' : ''}>${h.esc(p.caption || '')}</textarea></label>
    <div class="row between" style="margin-top:6px">
      ${done ? '<span></span>' : `<button class="btn ghost danger" id="pe-del">${icon('trash')}Pull from this account</button>`}
      <div class="row">
        ${photos.length ? '' : `<a class="btn" href="/api/posts/${p.id}/video" download>${icon('download')}Video</a>`}
        <button class="btn" id="pe-posted">${icon(done ? 'rotate-ccw' : 'check')}${done ? 'Not posted' : 'Mark as posted'}</button>
        ${done ? '' : `<button class="btn primary" id="pe-save">Save</button>`}
      </div>
    </div>
  </div>`);
  const after = () => { h.closeModal(); loadDay(); loadDue(); };
  h.$('#pe-posted').onclick = async () => {
    try { await h.api(`/api/posts/${p.id}/posted`, { method: 'POST', body: done ? { undo: true } : {} }); h.toast(done ? 'Marked as not posted again' : 'Marked as posted'); after(); } catch (e) { h.toast(e.message, true); }
  };
  if (done) return;
  h.$('#pe-save').onclick = async () => {
    const at = zonedToEpoch(h.$('#pe-at').value, st.tz);
    if (!at) return h.toast('Invalid time', true);
    try {
      const r = await h.api(`/api/posts/${p.id}`, { method: 'PATCH', body: { scheduled_at: at, caption: h.$('#pe-cap').value } });
      h.toast(r.tooClose ? 'Saved, but it is close to another post on this account' : 'Saved', r.tooClose);
      after();
    } catch (e) { h.toast(e.message, true); }
  };
  h.$('#pe-del').onclick = async () => {
    if (!confirm(`Pull this post from @${p.handle}? The other accounts stay; if none are left, ${photos.length ? 'the photos go' : 'the video goes'} back to Approval.`)) return;
    try { await h.api(`/api/posts/${p.id}`, { method: 'DELETE' }); h.toast('Post pulled'); after(); } catch (e) { h.toast(e.message, true); }
  };
}
