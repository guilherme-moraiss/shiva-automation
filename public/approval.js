// Aprovação: finished videos one at a time. Normal (every chosen account of the model, at one common time), Trial
// (a trial reel on her Instagram accounts that take them), Saltar (back of the queue) or Rejeitar. Each choice books
// the next free slot of each account; the times are shown before you choose.
import { icon, stripEmoji } from './icons.js';
import { zonedToEpoch, partsIn, dayStart, nextDay, prevDay, fmtDayTitle, fmtHour as fmtHourIn, fmtWhen as fmtWhenIn, TZ_LABEL } from './agenda-time.js';
import { dayGridHtml, scrollGridTo, timeAt } from './agenda-grid.js';

let h; // { $, $$, esc, api, toast, ago, PF, state }
export function init(helpers) { h = helpers; }

const on = () => /^#\/approval(?:[/?]|$)/.test(location.hash);
const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const ENGINE = { wan3_copy: 'Wan 3.0', wan3: 'Wan 3.0', kling_motion: 'Kling', animate_replace: 'Wan 2.2 Animate', wan27_edit: 'Wan 2.7 Edit', kling_edit: 'Kling Edit', rh_wan_animate: 'WAN Animate', rh_nb_wan_animate: 'NB WanAnimate', rh_ttt_animator: 'TTT Animator', rh_animate_x: 'Animate X' };
const store = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// queue: projects waiting; cur: what is on screen for queue[0]; done: decisions of this session (for "Voltar").
const st = { queue: [], byModel: [], byWorker: [], worker: '', total: 0, model: '', settings: null, cur: null, done: [], seq: 0, keyHandler: null, busy: false, pvSeq: 0, pvTimer: null, ag: { day: null, manual: false, seq: 0 } };
const PLATFORMS = { instagram: 'Instagram', tiktok: 'TikTok', x: 'X', youtube: 'YouTube' };
/** Networks that take a photo / carousel post (the server's PHOTO_PLATFORMS). */
const PHOTO_PLATFORMS = ['instagram', 'tiktok', 'x'];

// The agenda is shown and typed in the time zone chosen here (not the computer's).
const tz = () => st.settings?.tz || 'Europe/Lisbon';
const fmtHour = (ts) => fmtHourIn(ts, tz());
const fmtWhen = (ts) => fmtWhenIn(ts, tz());
const toLocalInput = (ts) => new Date(partsIn(ts * 1000, tz())).toISOString().slice(0, 16);
const nowS = () => Math.floor(Date.now() / 1000);

/** X counts a link as 23 and most emoji / CJK characters as 2; everything else as 1. */
function xLength(text) {
  const noUrls = String(text).replace(/https?:\/\/\S+/g, (u) => 'x'.repeat(23));
  let n = 0;
  for (const ch of noUrls) n += /[\u1100-\uFFFF]/.test(ch) && !/[\u2000-\u206F]/.test(ch) ? 2 : ch.codePointAt(0) > 0xffff ? 2 : 1;
  return n;
}
const LIMITS = [
  { pf: 'x', label: 'X', max: 280, len: xLength },
  { pf: 'youtube', label: 'YouTube (title)', max: 100, len: (t) => [...String(t)].length },
];

function setBadge(n) {
  const b = h.$('#nav-approval');
  if (b) b.textContent = n || '';
  if (h.state?.stats) h.state.stats.approvalPending = n || 0;
}

// ---- page ----------------------------------------------------------------------------------------------------------
export async function renderApproval(params) {
  const seq = ++st.seq;
  clearTimeout(st.pvTimer);
  if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
  st.keyHandler = null;
  h.$('#view').innerHTML = `
    <h2>Approval</h2>
    <p class="sub">Ready videos and photos, one at a time. <b>Normal</b> posts to all of the model's chosen accounts at the same time. <b>Trial</b> is a test reel on Instagram (shown first to non-followers). <b>Skip</b> leaves it for the end. Each choice takes the next free slot of each account.</p>
    <div class="toolbar" id="ap-toolbar"></div>
    <div id="ap-body"><div class="page-loading"><div class="spinner"></div></div></div>`;
  if (params.get('gen')) { st.model = ''; st.worker = ''; } // "Aprovar e agendar" opens that video, whatever filter was left on
  await load(seq, Number(params.get('gen')) || null);
  st.keyHandler = (e) => {
    if (!on() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const act = { n: () => decide('normal'), t: () => decide('trial'), ' ': () => decide('skip'), r: () => decide('reject'), z: undo }[k];
    if (act && st.cur) { e.preventDefault(); e.stopPropagation(); act(); }
  };
  window.addEventListener('keydown', st.keyHandler, true);
}

async function load(seq, firstId = null) {
  const qs = [st.model ? `model=${st.model}` : '', st.worker !== '' ? `worker=${st.worker}` : ''].filter(Boolean).join('&');
  const r = await h.api(`/api/approval/queue${qs ? `?${qs}` : ''}`);
  if (!on() || seq !== st.seq) return;
  st.queue = r.items;
  st.byModel = r.byModel;
  st.byWorker = r.byWorker || [];
  st.total = r.total;
  st.settings = r.settings;
  setBadge(r.total);
  if (firstId) {
    const i = st.queue.findIndex((x) => x.id === firstId);
    if (i > 0) st.queue.unshift(...st.queue.splice(i, 1));
  }
  paintToolbar();
  show(seq);
}

function paintToolbar() {
  const bar = h.$('#ap-toolbar');
  if (!bar) return;
  const s = st.settings;
  const radio = (name, v, cur) => `<label class="ap-radio"><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}>${v} h</label>`;
  bar.innerHTML = `
    <div class="seg" id="ap-models">
      <button data-m="" class="${!st.model ? 'active' : ''}">All <span class="count">${st.total || ''}</span></button>
      ${st.byModel.map((m) => `<button data-m="${m.id}" class="${String(st.model) === String(m.id) ? 'active' : ''}">${h.esc(m.name || 'No model')} <span class="count">${m.n}</span></button>`).join('')}
    </div>
    ${st.byWorker.some((w) => w.id) || st.worker !== '' ? `<div class="seg" id="ap-workers" title="Who made the video"><button data-w="" class="${st.worker === '' ? 'active' : ''}">All people</button>${st.byWorker.map((w) => `<button data-w="${w.id || 0}" class="${st.worker === String(w.id || 0) ? 'active' : ''}">${h.esc(w.name || 'No person')} <span class="count">${w.n}</span></button>`).join('')}</div>` : ''}
    <span class="grow"></span>
    <div class="ap-set">
      <span>Normal every ${radio('ap-ng', 2, s.normalGap)}${radio('ap-ng', 3, s.normalGap)}</span>
      <span>Trial every ${radio('ap-tg', 2, s.trialGap)}${radio('ap-tg', 3, s.trialGap)}</span>
      <select class="input" id="ap-tz" aria-label="Schedule time zone" title="Time zone in which the schedule is shown and entered">${s.tzs.map((z) => `<option value="${z}" ${z === s.tz ? 'selected' : ''}>${TZ_LABEL[z] || z}</option>`).join('')}</select>
    </div>`;
  h.$$('#ap-models button').forEach((b) => (b.onclick = () => { st.model = b.dataset.m; load(st.seq); }));
  h.$$('#ap-workers button').forEach((b) => (b.onclick = () => { st.worker = b.dataset.w; load(st.seq); }));
  const save = async (body) => {
    try { st.settings = await h.api('/api/approval/settings', { method: 'PUT', body }); schedulePreview(); } catch (e) { h.toast(e.message, true); }
  };
  h.$$('input[name=ap-ng]').forEach((r) => (r.onchange = () => save({ normalGap: Number(r.value) })));
  h.$$('input[name=ap-tg]').forEach((r) => (r.onchange = () => save({ trialGap: Number(r.value) })));
  h.$('#ap-tz').onchange = (e) => save({ tz: e.target.value }).then(() => show(st.seq, true));
}

function show(seq, keepState = false) {
  const body = h.$('#ap-body');
  if (!body || !on() || seq !== st.seq) return;
  const it = st.queue[0];
  if (!it) {
    st.cur = null;
    const filtered = (st.model || st.worker !== '') && st.total > 0;
    body.innerHTML = `<div class="empty">${icon('check-circle', { size: 28 })}<h3>${filtered ? 'Nothing waiting with this filter' : 'Nothing waiting for approval'}</h3>
      <p>${filtered ? `There ${st.total === 1 ? 'is 1 video' : `are ${st.total} videos`} waiting outside this filter.` : 'Videos ready for review appear here. You can also approve them inside each project.'}</p>
      <div class="row" style="justify-content:center">${filtered ? '<button class="btn primary" id="ap-all">See all</button>' : ''}${st.done.length ? `<button class="btn" id="ap-undo">${icon('rotate-ccw')}Back to the last decision</button>` : ''}<a class="btn" href="#/projects">${icon('layers')}See projects</a></div></div>`;
    if (h.$('#ap-undo')) h.$('#ap-undo').onclick = undo;
    if (h.$('#ap-all')) h.$('#ap-all').onclick = () => { st.model = ''; st.worker = ''; load(st.seq); };
    return;
  }
  const prev = keepState && st.cur?.id === it.id ? st.cur : null;
  st.cur = prev || { id: it.id, caption: '', captionId: null, original: '', accounts: [], selected: new Set(), at: null, ctxLoaded: false };
  const muted = store.get('rr.approval.muted') === '1';
  const qa = it.qa;
  body.innerHTML = `
    <div class="rv">
      ${it.kind === 'video' ? `<div class="rv-player"><video id="ap-video" src="/api/generations/${it.id}/video?v=${encodeURIComponent(it.video_path)}" autoplay loop playsinline controls ${muted ? 'muted' : ''}></video></div>`
        : `<div class="ap-photos"><div class="row between"><b>Photos to publish</b><span class="dim" style="font-size:12px">click to add or remove; the order follows the numbers</span></div><div class="ap-photo-grid" id="ap-photo-grid"></div></div>`}
      <aside class="card rv-side ap-side">
        <div class="rv-progress"><b>1</b> of <b>${st.queue.length}</b> to approve${st.done.length ? ` <span class="dim">· ${st.done.length} decided just now</span>` : ''}</div>
        <div class="ap-who">
          ${it.model_name ? `<span class="avatar-letter" style="--c:${h.esc(it.model_color || '#b15cff')};width:24px;height:24px;font-size:11px">${h.esc(it.model_name[0])}</span><b>${h.esc(it.model_name)}</b>` : ''}
          <a class="dim" href="#/projects/${it.id}" title="Open the project">#${it.id}</a>
          ${it.engine ? `<span class="status new">${h.esc(ENGINE[it.engine] || it.engine)}</span>` : ''}
          ${it.trimmed ? '<span class="status ok">Trimmed</span>' : ''}
        </div>
        <div class="dim" style="font-size:12.5px">Remake of <span class="pf ${it.platform}">${h.PF[it.platform]}</span> <a href="${h.esc(it.url || '#')}" target="_blank" rel="noopener">@${h.esc(it.handle)}</a>${it.views != null ? ` · ${h.fmt ? h.fmt(it.views) : it.views} views` : ''}${it.worker_name ? ` · made by <b style="color:var(--text)">${h.esc(it.worker_name)}</b>` : ''}</div>
        ${it.reel_caption ? `<details class="ap-src-cap"><summary>Original reel caption</summary><div>${h.esc(stripEmoji(it.reel_caption))}</div></details>` : ''}
        ${qa ? `<div class="ap-qa ${qa.ok ? 'ok' : 'bad'}">${icon(qa.ok ? 'check-circle' : 'alert-triangle')}${qa.ok ? `Quality check OK (face ${qa.same ?? '?'}/10)` : h.esc(stripEmoji([].concat(qa.issues || []).slice(0, 2).join(' · ')))}</div>` : ''}
        <div class="field" style="gap:4px">
          <div class="row between"><span class="label">Caption <span class="dim" id="ap-len"></span></span>
            <span class="row" style="gap:4px"><button class="btn sm ghost" id="ap-cap-other" title="Another random caption from her list">${icon('refresh')}Another</button><button class="btn sm ghost" id="ap-cap-reset" title="Goes back to the caption chosen when this opened">${icon('rotate-ccw')}Reset</button></span></div>
          <textarea class="input" id="ap-caption" rows="3" maxlength="2200" placeholder="No captions in Profiles: write the caption here"></textarea>
          <div class="ap-capwarn" id="ap-capwarn" hidden></div>
        </div>
        <div class="field" style="gap:6px">
          <span class="label">Publish to</span>
          <div class="ap-chips" id="ap-chips"><span class="dim" style="font-size:12px">Loading the accounts…</span></div>
        </div>
        <div class="ap-preview" id="ap-preview"></div>
        <div class="ap-at">
          <label class="field" style="gap:4px"><span class="label">Exact time <span class="dim">(optional, ${h.esc(TZ_LABEL[tz()] || tz())})</span></span>
            <div class="row" style="flex-wrap:nowrap"><input class="input" type="datetime-local" id="ap-at"><button class="btn sm ghost" id="ap-at-clear">Clear</button></div></label>
          <small class="dim">Empty = the next free slot of each account.</small>
        </div>
        <div class="ap-actions">
          <button class="btn ap-trial" id="ap-trial">${icon('pen-tool')}Trial<kbd>T</kbd></button>
          <button class="btn ap-skip" id="ap-skip">Skip<kbd>Space</kbd></button>
          <button class="btn ap-normal" id="ap-normal">${icon('check')}Normal<kbd>N</kbd></button>
        </div>
        <div class="rv-tools">
          <button class="btn sm ghost" id="ap-undo" ${st.done.length ? '' : 'disabled'}>${icon('rotate-ccw')}Back<kbd>Z</kbd></button>
          <button class="btn sm ghost danger" id="ap-reject" title="The video is no good: it leaves approval (it stays in the Projects archive)">${icon('x')}Reject<kbd>R</kbd></button>
          <button class="btn sm ghost" id="ap-sound">${icon(muted ? 'x-circle' : 'music')}${muted ? 'Sound off' : 'Sound on'}</button>
        </div>
      </aside>
    </div>
    <section class="ap-agenda" id="ap-agenda">
      <div class="row between ap-ag-bar">
        <div class="row" style="gap:6px">
          <button class="btn sm icon-only" id="ap-ag-prev" title="Previous day" aria-label="Previous day">${icon('chevron-left')}</button>
          <b class="cal-day" id="ap-ag-day"></b>
          <button class="btn sm icon-only" id="ap-ag-next" title="Next day" aria-label="Next day">${icon('chevron-right')}</button>
          <button class="btn sm" id="ap-ag-today">Today</button>
        </div>
        <span class="dim ap-ag-hint">Schedule for ${h.esc(it.model_name || 'the model')} · dashed: where it goes if you choose Normal or Trial · click a column to choose that time</span>
      </div>
      <div id="ap-ag-grid"><div class="page-loading" style="min-height:80px"><div class="spinner"></div></div></div>
    </section>`;
  if (!prev) st.ag = { day: null, manual: false, seq: st.ag.seq };
  h.$('#ap-ag-prev').onclick = () => { st.ag.manual = true; st.ag.day = prevDay(st.ag.day || dayStart(nowS(), tz()), tz()); loadAgenda(); };
  h.$('#ap-ag-next').onclick = () => { st.ag.manual = true; st.ag.day = nextDay(st.ag.day || dayStart(nowS(), tz()), tz()); loadAgenda(); };
  h.$('#ap-ag-today').onclick = () => { st.ag.manual = true; st.ag.day = dayStart(nowS(), tz()); loadAgenda(); };
  const v = h.$('#ap-video');
  if (v) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  if (it.kind !== 'video') {
    // Photos: which ones go, in order (the first version of each slide unless you change it). Trial does not apply.
    if (!st.cur.media) st.cur.media = [...(it.media || [])];
    const paintPhotos = () => {
      const grid = h.$('#ap-photo-grid');
      if (!grid) return;
      grid.innerHTML = (it.photos || []).map((p) => { const n = st.cur.media.indexOf(p.path); return `<button type="button" class="ap-photo ${n >= 0 ? 'on' : ''}" data-photo="${h.esc(p.path)}" aria-pressed="${n >= 0}" title="${h.esc(p.label || '')}"><img src="/media/${h.esc(p.path)}" alt="">${n >= 0 ? `<span>${n + 1}</span>` : ''}</button>`; }).join('');
      h.$$('[data-photo]', grid).forEach((b) => (b.onclick = () => {
        const i = st.cur.media.indexOf(b.dataset.photo);
        if (i >= 0) st.cur.media.splice(i, 1); else if (st.cur.media.length < 20) st.cur.media.push(b.dataset.photo); else h.toast('At most 20 photos per post', true);
        paintPhotos();
        paintCapWarn();
      }));
    };
    paintPhotos();
    const tr = h.$('#ap-trial');
    if (tr) { tr.disabled = true; tr.title = 'Trial is for reels only'; }
  }
  if (h.$('#ap-sound') && it.kind !== 'video') h.$('#ap-sound').hidden = true;
  h.$('#ap-sound').onclick = () => {
    const m = !(store.get('rr.approval.muted') === '1');
    store.set('rr.approval.muted', m ? '1' : '0');
    v.muted = m;
    if (!m) v.play().catch(() => {});
    h.$('#ap-sound').innerHTML = `${icon(m ? 'x-circle' : 'music')}${m ? 'Sound off' : 'Sound on'}`;
  };
  h.$('#ap-normal').onclick = () => decide('normal');
  h.$('#ap-trial').onclick = () => decide('trial');
  h.$('#ap-skip').onclick = () => decide('skip');
  h.$('#ap-reject').onclick = () => decide('reject');
  h.$('#ap-undo').onclick = undo;
  const cap = h.$('#ap-caption');
  const len = () => {
    h.$('#ap-len').textContent = `${cap.value.length}/2200`;
    paintCapWarn();
  };
  cap.oninput = () => { st.cur.caption = cap.value; len(); };
  h.$('#ap-cap-reset').onclick = () => { cap.value = st.cur.original; st.cur.caption = cap.value; len(); };
  h.$('#ap-cap-other').onclick = async () => {
    try {
      const c = await h.api(`/api/approval/${it.id}/context${st.cur.captionId ? `?exclude=${st.cur.captionId}` : ''}`);
      if (!c.caption) return h.toast('There are no captions in Profiles for this model', true);
      cap.value = c.caption.text; st.cur.caption = c.caption.text; st.cur.captionId = c.caption.id; len();
    } catch (e) { h.toast(e.message, true); }
  };
  const atIn = h.$('#ap-at');
  atIn.onchange = () => { st.cur.at = atIn.value ? zonedToEpoch(atIn.value, tz()) : null; schedulePreview(); };
  if (st.cur.at) atIn.value = toLocalInput(st.cur.at);
  h.$('#ap-at-clear').onclick = () => { atIn.value = ''; st.cur.at = null; schedulePreview(); };
  if (prev) {
    cap.value = st.cur.caption; len();
    paintChips();
    schedulePreview();
    return;
  }
  // Accounts and a caption from her pool, then the times each choice would take.
  h.api(`/api/approval/${it.id}/context`).then((c) => {
    if (!on() || st.cur?.id !== it.id) return;
    st.cur.accounts = c.accounts;
    st.cur.others = c.others || [];
    st.cur.selected = new Set(c.accounts.filter((a) => a.active).map((a) => a.id));
    st.cur.caption = c.caption?.text || '';
    st.cur.original = st.cur.caption;
    st.cur.captionId = c.caption?.id || null;
    st.cur.ctxLoaded = true;
    cap.value = st.cur.caption; len();
    paintChips();
    paintCapWarn();
    schedulePreview();
  }).catch((e) => { if (on()) h.$('#ap-chips').innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`; });
  // The next video loads while this one plays.
  const next = st.queue[1];
  if (next) { const pre = document.createElement('link'); pre.rel = 'prefetch'; pre.href = `/api/generations/${next.id}/video?v=${encodeURIComponent(next.video_path)}`; document.head.appendChild(pre); setTimeout(() => pre.remove(), 30000); }
}

/** Empty caption, or too long for one of the chosen networks: a warning (it is still allowed). */
function paintCapWarn() {
  const box = h.$('#ap-capwarn');
  const cap = h.$('#ap-caption');
  if (!box || !cap || !st.cur) return;
  const photo = st.queue[0]?.kind !== 'video';
  const chosen = new Set([...st.cur.accounts, ...(st.cur.others || [])].filter((a) => st.cur.selected.has(a.id) && (!photo || PHOTO_PLATFORMS.includes(a.platform))).map((a) => a.platform));
  const text = cap.value.trim();
  const warns = [];
  if (!text) warns.push('No caption: the post goes out without text.');
  for (const l of LIMITS) {
    if (!chosen.has(l.pf)) continue;
    const n = l.len(text);
    if (n > l.max) warns.push(`${l.label}: ${n}/${l.max} characters. Shorten the caption or remove that account.`);
  }
  if (photo && chosen.has('x') && (st.cur.media?.length || 0) > 4) warns.push(`X: at most 4 photos per post (you chose ${st.cur.media.length}). Choose up to 4 photos or remove the X account.`);
  box.innerHTML = warns.map((w) => `<div>${icon('alert-triangle')}${h.esc(w)}</div>`).join('');
  box.hidden = !warns.length;
}

function paintChips() {
  const box = h.$('#ap-chips');
  if (!box || !st.cur) return;
  const acc = st.cur.accounts.filter((a) => a.active);
  if (!acc.length) {
    const it = st.queue[0];
    box.innerHTML = `<div class="ap-noacc"><span class="msg warn">${icon('alert-triangle')}This model has no active accounts yet. Add one here (or all of them in <a href="#/profiles">Profiles</a>).</span>
      <form class="ap-addacc" id="ap-addacc" autocomplete="off">
        <select class="input" name="platform" aria-label="Platform">${Object.entries(PLATFORMS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <input class="input" name="handle" placeholder="@account or profile link" aria-label="Account" spellcheck="false" required>
        <button class="btn sm primary">${icon('plus')}Add</button>
      </form></div>`;
    const f = h.$('#ap-addacc');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = h.$('button', f);
      btn.disabled = true;
      try {
        const a = await h.api(`/api/models/${it.model_id}/accounts`, { method: 'POST', body: { platform: f.platform.value, handle: f.handle.value } });
        h.toast(`${PLATFORMS[a.platform]} account @${a.handle} added to ${it.model_name || 'this model'}`);
        const c = await h.api(`/api/approval/${it.id}/context`);
        if (st.cur?.id !== it.id) return;
        st.cur.accounts = c.accounts;
        st.cur.selected = new Set(c.accounts.filter((x) => x.active).map((x) => x.id));
        paintChips();
        paintCapWarn();
        schedulePreview();
      } catch (err) { h.toast(stripEmoji(err.message), true); btn.disabled = false; }
    };
    return;
  }
  // A photo post only goes to the networks that take photos: the others stay visible but cannot be chosen.
  const photo = st.queue[0]?.kind !== 'video';
  const takes = (a) => !photo || PHOTO_PLATFORMS.includes(a.platform);
  const chip = (a) => `<button class="ap-chip ${takes(a) && st.cur.selected.has(a.id) ? 'on' : ''}" data-acc="${a.id}" aria-pressed="${takes(a) && st.cur.selected.has(a.id)}" ${takes(a) ? '' : 'disabled'} title="${takes(a) ? (a.trial ? 'Receives Trial' : '') : `${PLATFORMS[a.platform]} does not take photo posts`}">
      <span class="pf-plat ${a.platform}">${PF_SHORT[a.platform]}</span>@${h.esc(a.handle)}${a.label ? `<span class="dim"> · ${h.esc(a.label)}</span>` : ''}${a.trial ? '<span class="ap-trial-tag">Trial</span>' : ''}</button>`;
  // Other models' accounts (e.g. her backup profile): folded, not chosen unless you switch them on.
  const others = st.cur.others || [];
  const byModel = [...new Set(others.map((a) => a.model_name))];
  const onOthers = others.filter((a) => st.cur.selected.has(a.id)).length;
  box.innerHTML = acc.map(chip).join('') + (others.length ? `<details class="ap-others" ${onOthers || st.cur.othersOpen ? 'open' : ''}><summary>Other accounts (${others.length})${onOthers ? ` · ${onOthers} chosen` : ''}</summary>${byModel.map((n) => `<div class="ap-others-row"><span class="dim">${h.esc(n)}</span>${others.filter((a) => a.model_name === n).map(chip).join('')}</div>`).join('')}</details>` : '');
  const det = h.$('.ap-others', box);
  if (det) det.ontoggle = () => { st.cur.othersOpen = det.open; };
  h.$$('[data-acc]', box).forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.acc);
    st.cur.selected.has(id) ? st.cur.selected.delete(id) : st.cur.selected.add(id);
    paintChips();
    paintCapWarn();
    schedulePreview();
  }));
}

function schedulePreview() {
  clearTimeout(st.pvTimer);
  st.pvTimer = setTimeout(preview, 120);
}

async function preview() {
  const box = h.$('#ap-preview');
  if (!box || !st.cur?.ctxLoaded) return;
  const id = st.cur.id;
  const seq = ++st.pvSeq;
  let r;
  try {
    r = await h.api(`/api/approval/${id}/preview`, { method: 'POST', body: { accounts: [...st.cur.selected], at: st.cur.at } });
  } catch (e) { if (seq === st.pvSeq) box.innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`; return; }
  if (seq !== st.pvSeq || st.cur?.id !== id || !h.$('#ap-preview')) return;
  st.cur.plan = r;
  const line = (x) => `<div><span class="pf-plat ${x.platform}">${PF_SHORT[x.platform]}</span> @${h.esc(x.handle)} → <b>${fmtWhen(x.at)}</b>${x.override ? (x.conflict ? ' <span class="ap-warn">close to another post on this account</span>' : ' <span class="dim">· chosen time</span>') : ''}${x.solo ? ` <span class="dim">· synced with the other accounts (on its own it would be ${fmtHour(x.solo)})</span>` : ''}${x.hole ? ' <span class="dim">· fills a free gap</span>' : ''}</div>`;
  box.innerHTML = `
    <div class="ap-pv-n"><span class="label">If you choose Normal</span>${r.normal.length ? r.normal.map(line).join('') : `<div class="dim">${st.queue[0]?.kind !== 'video' ? 'None of the chosen accounts takes photos (Instagram, TikTok, X).' : 'No account chosen.'}</div>`}</div>
    <div class="ap-pv-t"><span class="label">If you choose Trial</span>${r.trial.length ? r.trial.map(line).join('') : `<div class="dim">${st.queue[0]?.kind !== 'video' ? 'Trial is for reels only: photos go out as Normal.' : 'None of the chosen accounts is an Instagram account with Trial on.'}</div>`}</div>`;
  h.$('#ap-normal').disabled = !r.normal.length;
  h.$('#ap-trial').disabled = !r.trial.length || st.queue[0]?.kind !== 'video';
  if (!st.ag.manual) st.ag.day = dayStart(r.normal[0]?.at || r.trial[0]?.at || nowS(), tz());
  loadAgenda();
}

// ---- the day grid under the video ----------------------------------------------------------------------------------
async function loadAgenda() {
  const box = h.$('#ap-ag-grid');
  const it = st.queue[0];
  if (!box || !it || !st.cur) return;
  const seq = ++st.ag.seq;
  const from = st.ag.day || dayStart(nowS(), tz());
  const to = nextDay(from, tz());
  h.$('#ap-ag-day').textContent = fmtDayTitle(from + 3600, tz());
  let d;
  try { d = await h.api(`/api/schedule?from=${from}&to=${to}&model=${it.model_id}`); } catch (e) {
    if (seq === st.ag.seq) box.innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`;
    return;
  }
  if (seq !== st.ag.seq || !h.$('#ap-ag-grid') || st.queue[0]?.id !== it.id) return;
  const plan = st.cur.plan || { normal: [], trial: [] };
  const ghosts = [
    ...plan.normal.filter((x) => x.at >= from && x.at < to).map((x) => ({ account_id: x.accountId, at: x.at, kind: 'normal', label: 'Normal', title: `If you choose Normal: ${fmtWhen(x.at)}` })),
    ...plan.trial.filter((x) => x.at >= from && x.at < to).map((x) => ({ account_id: x.accountId, at: x.at, kind: 'trial', label: 'Trial', title: `If you choose Trial: ${fmtWhen(x.at)}` })),
  ];
  box.innerHTML = dayGridHtml({ from, to, tz: tz(), accounts: d.accounts, posts: d.posts, noAccounts: d.noAccounts, ghosts, pickable: true });
  const first = ghosts[0]?.at;
  const picked = st.cur.at >= from && st.cur.at < to ? st.cur.at : null; // keep the time just chosen (grid click or typed) in view
  scrollGridTo(box, from, to, picked || (first && !st.ag.manual ? first : nowS()));
  h.$$('.cal-col[data-acc]', box).forEach((col) => (col.onclick = (e) => {
    if (e.target.closest('.cal-post')) return;
    const at = timeAt(col, e.clientY, from);
    if (at < nowS() - 60) return h.toast('That time has already passed', true);
    st.cur.at = at;
    const atIn = h.$('#ap-at');
    if (atIn) atIn.value = toLocalInput(at);
    st.ag.manual = true;
    h.toast(`Time chosen: ${fmtWhen(at)}`);
    schedulePreview();
  }));
  h.$$('.cal-post', box).forEach((el) => {
    const p = d.posts.find((x) => x.id === Number(el.dataset.post));
    if (!p) return;
    const open = () => window.open(`#/projects/${p.generation_id}`, '_blank');
    el.onclick = open; // a new tab: the caption, accounts and time chosen here stay as they are
    el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } };
    el.title = `${el.title ? `${el.title}\n` : ''}Opens the project in another tab`;
  });
}

async function decide(action) {
  if (st.busy || !st.cur) return;
  const it = st.queue[0];
  if (!it || it.id !== st.cur.id) return;
  if ((action === 'normal' || action === 'trial') && !st.cur.ctxLoaded) return h.toast('Wait: loading the accounts for this model', true);
  if (action === 'reject' && !confirm(`Reject project #${it.id}? It leaves approval and stays in the Projects archive (you can undo this).`)) return;
  if (it.kind !== 'video' && action === 'trial') return h.toast('Trial is for reels only: choose Normal', true);
  if (it.kind !== 'video' && action === 'normal' && !st.cur.media?.length) return h.toast('Choose at least one photo', true);
  st.busy = true;
  h.$$('.ap-actions .btn, #ap-reject').forEach((b) => (b.disabled = true));
  try {
    const r = await h.api(`/api/approval/${it.id}/decide`, { method: 'POST', body: { action, accounts: [...st.cur.selected], caption: h.$('#ap-caption')?.value ?? st.cur.caption, at: st.cur.at, media: it.kind !== 'video' ? st.cur.media : undefined } });
    st.done.push({ id: it.id, action, item: it });
    st.queue.shift();
    if (action === 'skip') st.queue.push(it);
    if (action === 'normal' || action === 'trial') {
      const first = r.posts[0];
      h.toast(`${action === 'trial' ? 'Trial' : 'Normal'} scheduled: ${r.posts.map((p) => PF_SHORT[p.platform]).join(', ')} · ${fmtWhen(first.at)}`);
    } else if (action === 'reject') h.toast(`Project #${it.id} rejected`);
    if (action !== 'skip') { // it left the queue
      st.total = Math.max(0, st.total - 1);
      st.byModel = st.byModel.map((m) => (m.id === it.model_id ? { ...m, n: Math.max(0, m.n - 1) } : m));
      st.byWorker = (st.byWorker || []).map((w) => ((w.id ?? null) === (it.worker_id ?? null) ? { ...w, n: Math.max(0, w.n - 1) } : w));
      setBadge(st.total);
    }
    paintToolbar();
    show(st.seq);
  } catch (e) {
    h.toast(e.message, true);
    h.$$('.ap-actions .btn, #ap-reject').forEach((b) => (b.disabled = false));
    if (/já foi agendado|já não está|already been scheduled|no longer waiting/.test(e.message)) load(st.seq);
  } finally { st.busy = false; }
}

async function undo() {
  if (st.busy) return;
  const last = st.done[st.done.length - 1];
  if (!last) return;
  st.busy = true;
  try {
    await h.api(`/api/approval/${last.id}/undo`, { method: 'POST' });
    st.done.pop();
    h.toast(`Decision undone: project #${last.id} is back`);
    await load(st.seq, last.id);
  } catch (e) { h.toast(e.message, true); }
  finally { st.busy = false; }
}
