// Agendados: the scheduled videos checked once more before they go out, one at a time.
// Manter (it stays), Retirar (all its posts come off; the video goes back to Aprovação), Mudar para Trial, Saltar.
import { icon, stripEmoji } from './icons.js';
import { fmtWhen, fmtHour } from './agenda-time.js';

let h; // { $, $$, esc, api, toast, PF }
export function init(helpers) { h = helpers; }

const on = () => /^#\/scheduled(?:[/?]|$)/.test(location.hash);
const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const store = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const st = { queue: [], counts: {}, byModel: [], model: '', kind: '', tz: 'Europe/Lisbon', done: [], seq: 0, keyHandler: null, busy: false, kept: 0, pulled: 0 };

export async function renderScheduled() {
  const seq = ++st.seq;
  if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
  st.keyHandler = null;
  h.$('#view').innerHTML = `
    <h2>Scheduled</h2>
    <p class="sub">Videos already scheduled, one at a time, before they go out. <b>Keep</b> leaves it as it is, <b>Pull</b> takes it off every account (it goes back to Approval), <b>Switch to Trial</b> replaces the normal posts with a test reel on Instagram.</p>
    <div class="toolbar" id="sc-toolbar"></div>
    <div id="sc-body"><div class="page-loading"><div class="spinner"></div></div></div>`;
  await load(seq);
  st.keyHandler = (e) => {
    if (!on() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const act = { arrowleft: () => decide('pull'), arrowright: () => decide('keep'), ' ': () => decide('skip'), t: () => decide('to-trial'), z: undo }[e.key.toLowerCase()];
    if (act && st.queue.length) { e.preventDefault(); e.stopPropagation(); act(); }
  };
  window.addEventListener('keydown', st.keyHandler, true);
}

async function load(seq) {
  const qs = new URLSearchParams();
  if (st.model) qs.set('model', st.model);
  if (st.kind) qs.set('kind', st.kind);
  const r = await h.api(`/api/scheduled/queue?${qs}`);
  if (!on() || seq !== st.seq) return;
  st.queue = r.items;
  st.counts = r.counts;
  st.byModel = r.byModel;
  st.tz = r.settings.tz;
  paintToolbar();
  show(seq);
}

function paintToolbar() {
  const bar = h.$('#sc-toolbar');
  if (!bar) return;
  const all = (st.counts.normal || 0) + (st.counts.trial || 0);
  bar.innerHTML = `
    <div class="seg" id="sc-models"><button data-m="" class="${!st.model ? 'active' : ''}">All</button>${st.byModel.map((m) => `<button data-m="${m.id}" class="${String(st.model) === String(m.id) ? 'active' : ''}">${h.esc(m.name || 'No model')} <span class="count">${m.n}</span></button>`).join('')}</div>
    <div class="seg" id="sc-kind">${[['', 'All', all], ['normal', 'Normal', st.counts.normal], ['trial', 'Trial', st.counts.trial]].map(([v, l, n]) => `<button data-k="${v}" class="${st.kind === v ? 'active' : ''}">${l}${n ? ` <span class="count">${n}</span>` : ''}</button>`).join('')}</div>
    <span class="grow"></span>
    <span class="dim" style="font-size:12.5px">This session: <b style="color:var(--text)">${st.kept}</b> kept · <b style="color:var(--text)">${st.pulled}</b> pulled</span>
    <a class="btn sm" href="#/calendar">${icon('clock')}Calendar</a>`;
  h.$$('#sc-models button').forEach((b) => (b.onclick = () => { st.model = b.dataset.m; load(st.seq); }));
  h.$$('#sc-kind button').forEach((b) => (b.onclick = () => { st.kind = b.dataset.k; load(st.seq); }));
}

function show(seq) {
  const body = h.$('#sc-body');
  if (!body || !on() || seq !== st.seq) return;
  const it = st.queue[0];
  if (!it) {
    body.innerHTML = `<div class="empty">${icon('check-circle', { size: 28 })}<h3>Nothing scheduled to review</h3>
      <p>The videos and photos you schedule in Approval appear here until they go out.</p>
      <div class="row" style="justify-content:center">${st.done.length ? `<button class="btn" id="sc-undo">${icon('rotate-ccw')}Back to the last one</button>` : ''}<a class="btn" href="#/approval">${icon('check-circle')}Approval</a><a class="btn ghost" href="#/calendar">${icon('clock')}Calendar</a></div></div>`;
    if (h.$('#sc-undo')) h.$('#sc-undo').onclick = undo;
    return;
  }
  const muted = store.get('rr.approval.muted') === '1';
  const trial = it.publish === 'trial';
  const cap = it.posts[0]?.caption || '';
  body.innerHTML = `
    <div class="rv">
      ${it.kind === 'video' || !it.media?.length ? `<div class="rv-player"><video id="sc-video" src="/api/generations/${it.id}/video?v=${encodeURIComponent(it.video_path)}" autoplay loop playsinline controls ${muted ? 'muted' : ''}></video></div>`
        : `<div class="ap-photos"><b>${it.media.length === 1 ? 'Photo' : `Carousel · ${it.media.length} photos`}</b><div class="ap-photo-grid">${it.media.map((p, i) => `<span class="ap-photo on"><img src="/media/${h.esc(p)}" alt=""><span>${i + 1}</span></span>`).join('')}</div></div>`}
      <aside class="card rv-side ap-side">
        <div class="rv-progress"><b>1</b> of <b>${st.queue.length}</b>${it.kept_at ? ' <span class="status ok">already kept</span>' : ''}</div>
        <div class="ap-who">
          <span class="sc-kind ${trial ? 'trial' : 'normal'}">${trial ? 'Trial' : 'Normal'}</span>
          ${it.model_name ? `<b>${h.esc(it.model_name)}</b>` : ''}
          <a class="dim" href="#/projects/${it.id}" title="Open the project">#${it.id}</a>
          ${it.trimmed ? '<span class="status ok">Trimmed</span>' : ''}
        </div>
        <div class="dim" style="font-size:12.5px">Remake of <span class="pf ${it.platform}">${h.PF[it.platform]}</span> <a href="${h.esc(it.url || '#')}" target="_blank" rel="noopener">@${h.esc(it.handle)}</a>${it.worker_name ? ` · made by <b style="color:var(--text)">${h.esc(it.worker_name)}</b>` : ''}${it.scheduled_by ? ` · scheduled by <b style="color:var(--text)">${h.esc(it.scheduled_by)}</b>` : ''}</div>
        <div class="sc-posts">
          <span class="label">${it.posts.length} post(s)</span>
          ${it.posts.map((p) => `<div><span class="pf-plat ${p.platform}">${PF_SHORT[p.platform]}</span> @${h.esc(p.handle)} → <b>${fmtWhen(p.scheduled_at, st.tz)}</b>${p.status === 'posted' ? ' <span class="status ok">posted</span>' : ''}</div>`).join('')}
        </div>
        <div class="field" style="gap:4px"><span class="label">Caption</span><div class="sc-cap">${cap ? h.esc(cap) : '<span class="dim">No caption</span>'}</div><small class="dim">To change the time or the caption for one account, use the Calendar.</small></div>
        <div class="ap-actions sc-actions">
          <button class="btn sc-pull" id="sc-pull" title="Takes it off every account: the project goes back to Approval">${icon('arrow-left')}Pull<kbd>←</kbd></button>
          <button class="btn ap-skip" id="sc-skip">Skip<kbd>Space</kbd></button>
          <button class="btn ap-normal" id="sc-keep">Keep${icon('arrow-right')}<kbd>→</kbd></button>
        </div>
        <div class="rv-tools">
          <button class="btn sm ghost" id="sc-undo" ${st.done.length ? '' : 'disabled'}>${icon('rotate-ccw')}Back<kbd>Z</kbd></button>
          ${trial || it.kind !== 'video' ? '' : `<button class="btn sm ap-trial" id="sc-trial" title="The normal posts come off and a test reel stays on her Instagram">${icon('pen-tool')}Switch to Trial<kbd>T</kbd></button>`}
        </div>
      </aside>
    </div>`;
  const v = h.$('#sc-video'); // photo posts show their images instead
  if (v) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  h.$('#sc-pull').onclick = () => decide('pull');
  h.$('#sc-skip').onclick = () => decide('skip');
  h.$('#sc-keep').onclick = () => decide('keep');
  h.$('#sc-undo').onclick = undo;
  if (h.$('#sc-trial')) h.$('#sc-trial').onclick = () => decide('to-trial');
}

async function decide(action) {
  if (st.busy) return;
  const it = st.queue[0];
  if (!it) return;
  if (action === 'to-trial' && (it.publish === 'trial' || it.kind !== 'video')) return; // Trial is for reels only
  if (action === 'pull' && !confirm(`Pull project #${it.id} from every account? ${it.kind === 'video' ? 'The video' : 'The photo post'} goes back to Approval.`)) return;
  st.busy = true;
  h.$$('.sc-actions .btn, #sc-trial').forEach((b) => (b.disabled = true));
  try {
    if (action === 'keep') { await h.api(`/api/scheduled/${it.id}/keep`, { method: 'POST' }); st.kept++; }
    if (action === 'pull') { await h.api(`/api/scheduled/${it.id}/pull`, { method: 'POST' }); st.pulled++; h.toast(`#${it.id} pulled: back in Approval`); }
    if (action === 'to-trial') {
      const r = await h.api(`/api/scheduled/${it.id}/to-trial`, { method: 'POST' });
      h.toast(`#${it.id} switched to Trial: ${r.posts.map((p) => `@${p.handle} ${fmtHour(p.at, st.tz)}`).join(', ')}`);
    }
    st.done.push({ id: it.id, action });
    st.queue.shift();
    if (action === 'skip' || action === 'keep') st.queue.push({ ...it, kept_at: action === 'keep' ? Date.now() : it.kept_at });
    if (action === 'to-trial' || action === 'pull') await load(st.seq);
    else { paintToolbar(); show(st.seq); }
  } catch (e) {
    h.toast(stripEmoji(e.message), true);
    h.$$('.sc-actions .btn, #sc-trial').forEach((b) => (b.disabled = false));
  } finally { st.busy = false; }
}

// "Voltar": Manter and Saltar are undone here; a Retirar is undone by approving it again in Aprovação.
async function undo() {
  if (st.busy) return;
  const last = st.done[st.done.length - 1];
  if (!last) return;
  if (last.action === 'pull' || last.action === 'to-trial') {
    return h.toast(last.action === 'pull' ? `#${last.id} went back to Approval: schedule it again there` : `To go back to Normal, pull #${last.id} and approve it again as Normal`, true);
  }
  st.busy = true;
  try {
    if (last.action === 'keep') { await h.api(`/api/scheduled/${last.id}/keep`, { method: 'POST', body: { undo: true } }); st.kept = Math.max(0, st.kept - 1); }
    st.done.pop();
    const i = st.queue.findIndex((x) => x.id === last.id);
    if (i >= 0) { const [it] = st.queue.splice(i, 1); st.queue.unshift({ ...it, kept_at: last.action === 'keep' ? null : it.kept_at }); }
    paintToolbar();
    show(st.seq);
  } catch (e) { h.toast(e.message, true); } finally { st.busy = false; }
}
