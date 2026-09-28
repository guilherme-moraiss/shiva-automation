// Reels Radar: vanilla SPA (hash routing, no build step).
import { icon, hydrateIcons, stripEmoji } from './icons.js';
import * as P from './pipeline.js';
import * as Studio from './studio.js';
import * as Spicy from './spicy.js';
import * as Review from './review.js';
import * as Projects from './projects.js';
import * as Profiles from './profiles.js';
import * as Approval from './approval.js';
import * as Scheduled from './scheduled.js';
import * as Calendar from './calendar.js';
import * as Usage from './usage.js';
import * as Launch from './launch.js';
import * as Faces from './faces.js';
import * as Carousels from './carousels.js';
import * as Discover from './discover.js';
import * as Team from './team.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Names the app stores in Portuguese (creator groups, who sent a reel): kept as they are in the data, shown in English. */
const SHOWN = { Descoberta: 'Discover', 'Enviados pela equipa': 'Sent by the team', 'Adicionados por link': 'Added by link', 'Carrosséis': 'Carousels', carregados: 'uploads', desconhecida: 'unknown' };
const shown = (v) => SHOWN[v] ?? v;

// Static sidebar icons (index.html [data-icon] placeholders): fill them before anything else renders.
hydrateIcons();

// Equipa: the person picked in "A trabalhar como" (id; 0 = nobody on purpose; null = not chosen yet). Sent with every
// request, so the server knows who did what.
let workerId = (() => { try { const v = localStorage.getItem('workerId'); return v === null ? null : Number(v) || 0; } catch { return null; } })();
const getWorker = () => workerId;
function setWorker(id) {
  workerId = id === null ? null : Number(id) || 0;
  try { if (workerId === null) localStorage.removeItem('workerId'); else localStorage.setItem('workerId', String(workerId)); } catch {}
  dispatchEvent(new Event('workerchange')); // pages that depend on the person (Projetos → Só os meus) repaint
}

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  if (workerId > 0) headers['X-Worker'] = String(workerId);
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---- formatting -------------------------------------------------------------------
const fmt = (n) => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
};
const ratio = (r) => (r === null || r === undefined ? '—' : (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)) + '×');
const pct = (r) => (r === null || r === undefined ? '—' : (r * 100).toFixed(1) + '%');
const ago = (ts) => {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
};
const dateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const PF = { instagram: 'IG', tiktok: 'TT' };
const COLORS = ['#b15cff', '#ff5da2', '#3ee0c5', '#ffb547', '#5d8bff', '#ff7a45'];
const avatar = (c, size = '') =>
  c.avatar_path
    ? `<img src="/media/${esc(c.avatar_path)}" alt="" loading="lazy" ${size}>`
    : `<span class="avatar-letter" style="--c:${COLORS[(c.handle || '?').charCodeAt(0) % COLORS.length]}">${esc((c.handle || '?')[0].toUpperCase())}</span>`;
const profileUrl = (platform, handle) =>
  platform === 'tiktok' ? `https://www.tiktok.com/@${handle}` : `https://www.instagram.com/${handle}/`;

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = stripEmoji(msg);
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 3200);
}

// ---- global state -----------------------------------------------------------------
const state = {
  models: [],
  groups: [],
  stats: null,
  reels: { sort: 'newest', platform: '', window: '', viral: false, group: '', q: '', offset: 0, items: [], total: 0 },
  creators: { q: '', group: '', platform: '', sort: '' },
  // '' = Todos: generating a remake moves it straight to "Em produção", so a "Na fila" default always looked empty.
  remakes: { status: '', model: '' },
};
try {
  const saved = JSON.parse(localStorage.getItem('reelsFilters') || '{}');
  if (!saved.v2) delete saved.window; // v2: default window is now "Tudo" (Fresh hid almost every reel)
  Object.assign(state.reels, saved, { offset: 0, items: [] });
} catch {}
const REELS_PAGE = 50;

async function loadShared() {
  const [models, groups, stats, workers] = await Promise.all([api('/api/models'), api('/api/groups'), api('/api/stats'), api('/api/team/people').catch(() => null)]);
  state.models = models; state.groups = groups; state.stats = stats;
  if (workers) {
    state.workers = workers;
    // The person picked here was removed from the team: ask again.
    if (workerId > 0 && !workers.some((w) => w.id === workerId)) setWorker(null);
  }
  renderSidebar();
}

function renderSidebar() {
  $('#model-list').innerHTML = state.models.length
    ? state.models.map((m) => `
      <a class="model-item" href="#/models" title="${m.ref_images?.length ? m.ref_images.length + ' reference photos' : 'No reference photos'}">
        <span class="avatar-letter" style="--c:${esc(m.color || COLORS[m.id % COLORS.length])}">${esc(m.name[0].toUpperCase())}</span>
        ${esc(m.name)}<span class="n">${m.ref_images?.length ? m.remakes || '' : icon('alert-triangle')}</span></a>`).join('')
    : `<div class="dim" style="padding:4px 10px;font-size:12px">Add your AI models to assign remakes to them.</div>`;
  $('#nav-remakes').textContent = state.stats?.queuedRemakes || '';
  $('#nav-review').textContent = state.stats?.reviewPending || '';
  $('#nav-projects').textContent = state.stats?.projectsTodo || '';
  $('#nav-approval').textContent = state.stats?.approvalPending || '';
  $('#nav-due').textContent = state.stats?.postsDue || '';
  Team.renderWhoami();
}

$('#add-model-btn').onclick = () => openModelDialog();

function openModelDialog() {
  showModal(`
    <div class="modal-box small">
      <h3 style="margin:0 0 4px">New model</h3>
      <p class="sub">AI persona who will star in the remakes (for example, Mia or Elle).</p>
      <form class="stack" id="model-form">
        <label class="field"><span>Name</span><input class="input" name="name" required maxlength="40" autofocus></label>
        <label class="field"><span>Color</span><input class="input" name="color" type="color" value="${COLORS[state.models.length % COLORS.length]}" style="height:38px;padding:4px"></label>
        <label class="field"><span>Persona (appearance, used in the prompts)</span><textarea class="input" name="persona" rows="3" placeholder="e.g. 22 years old, wavy brown hair, green eyes, casual style"></textarea></label>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Create</button></div>
      </form>
    </div>`);
  $('#model-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/models', { method: 'POST', body: f });
      closeModal(); toast(`Model ${f.name} created. Add reference photos`);
      await loadShared();
      if (location.hash === '#/models') route(); else location.hash = '#/models';
    } catch (err) { toast(err.message, true); }
  };
}

// ---- modal ------------------------------------------------------------------------
function showModal(html) {
  const m = $('#modal');
  m.innerHTML = html;
  m.classList.remove('hidden');
  $$('[data-close]', m).forEach((b) => (b.onclick = closeModal));
}
function closeModal() {
  const m = $('#modal');
  $$('video', m).forEach((v) => v.pause());
  m.classList.add('hidden');
  m.innerHTML = '';
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---- router -----------------------------------------------------------------------
const views = { projects: Projects.renderProjects, profiles: Profiles.renderProfiles, approval: Approval.renderApproval, scheduled: Scheduled.renderScheduled, calendar: Calendar.renderCalendar, usage: Usage.renderUsage, team: Team.renderTeam, launch: Launch.renderLaunch, faces: Faces.renderFaces, carousels: Carousels.renderCarousels, discover: Discover.renderDiscover, reels: renderReels, review: Review.renderReview, creators: renderCreators, remakes: renderRemakes, setup: renderSetup, studio: (params) => location.replace(params.get('gen') ? `#/projects/${params.get('gen')}` : '#/projects'), models: P.renderModels, comfy: () => location.replace('#/setup'), remake: P.renderRemake, library: P.renderLibrary, create: Studio.renderCreate, spicy: Spicy.renderSpicy };
const titles = { projects: 'Projects', profiles: 'Profiles', approval: 'Approval', scheduled: 'Scheduled', calendar: 'Calendar', usage: 'Costs', team: 'Team', launch: 'Launch links', faces: 'Face generator', carousels: 'Carousels', discover: 'Discover', reels: 'Reels', review: 'Review', creators: 'Creators', remakes: 'Remake queue', setup: 'Settings', studio: 'Studio', models: 'Models', comfy: 'Comfy', remake: 'Create remake', library: 'Library', create: 'Create content', spicy: '18+ content' };

const PAGE_LOADING = '<div class="page-loading"><div class="spinner"></div></div>';
const currentView = () => {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'projects';
  return views[name] ? name : 'projects';
};

function route() {
  const [, name = 'projects', sub = '', qs = ''] = location.hash.match(/^#\/(\w+)(?:\/([^?]*))?\??(.*)$/) || [];
  const view = views[name] ? name : 'projects';
  const params = new URLSearchParams(qs);
  if (sub) params.set('id', sub);
  // Projetos keeps its list on screen while you move between projects: all of #/projects/… is one page.
  const path = view === 'projects' ? '#/projects' : location.hash.split('?')[0];
  const seq = (route.seq = (route.seq || 0) + 1);
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#page-title').textContent = titles[view];
  $('#topbar-actions').innerHTML = '';
  if (route.last !== path) {
    // New page: never leave the previous page (and its live handlers) under the new title while this one loads.
    $('.main').scrollTop = 0;
    $('#view').innerHTML = PAGE_LOADING;
  }
  route.last = path;
  Promise.resolve()
    .then(() => views[view](params))
    .catch((e) => {
      console.error(e);
      if (seq !== route.seq) return; // the user has already moved on
      $('#view').innerHTML = `
        <div class="empty">${icon('alert-circle', { size: 28 })}
          <h3>This page could not be opened</h3>
          <p>${esc(stripEmoji(e?.message || 'Unexpected error'))}</p>
          <div class="row" style="justify-content:center"><button class="btn" id="route-retry">${icon('refresh')}Try again</button><a class="btn ghost" href="#/reels">Go to Reels</a></div>
        </div>`;
      $('#route-retry').onclick = () => route();
    });
}
window.addEventListener('hashchange', route);

// =================================================================================
// REELS
// =================================================================================
const SORTS = [
  ['newest', 'Newest'], ['views', 'Most viewed'], ['likes', 'Most likes'],
  ['like_rate', 'Like rate'], ['comments', 'Most comments'], ['ftvr', 'FTVR'], ['engagement', 'Engagement'],
];
const WINDOWS = [['fresh', 'Recent'], ['7', '7 days'], ['30', '30 days'], ['', 'All']];

function reelsQuery(extra = {}) {
  const f = state.reels;
  const p = new URLSearchParams({ sort: f.sort, limit: REELS_PAGE, offset: f.offset, ...extra });
  if (f.platform) p.set('platform', f.platform);
  if (f.type) p.set('type', f.type);
  if (f.window === 'fresh') p.set('fresh', '1'); else if (f.window) p.set('days', f.window);
  if (f.viral) p.set('viral', '1');
  if (f.group) p.set('group', f.group);
  if (f.q) p.set('q', f.q);
  if (f.creator) p.set('creator', f.creator);
  return p;
}

async function renderReels(params) {
  const f = state.reels;
  f.creator = params.get('creator') || '';
  const fd = state.stats?.freshDays || 3;
  $('#topbar-actions').innerHTML = `<button class="btn primary sm" id="scan-all">${icon('refresh')}Find new reels</button>`;
  $('#scan-all').onclick = () => startScan();
  $('#view').innerHTML = `
    <div class="row between" style="margin-bottom:14px;align-items:flex-end">
      <div>
        <h2>Reels ${f.creator ? '<span class="muted" id="creator-filter-label"></span>' : ''}</h2>
        <p class="sub" style="margin:0">Public metrics from Instagram and TikTok. <b>FTVR</b> = views ÷ followers. Above 1×, the video reached beyond the creator's audience.</p>
      </div>
      <div class="muted"><b id="reel-total" style="color:var(--text)">…</b> reels</div>
    </div>
    <div class="toolbar">
      <div class="seg" id="type-seg">
        ${[['', 'All'], ['video', `${icon('video')}Reels`], ['photo', `${icon('image')}Photos`]].map(([v, l]) => `<button data-v="${v}" class="${(f.type || '') === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="seg" id="pf-seg">
        ${[['', 'All'], ['instagram', 'Instagram'], ['tiktok', 'TikTok']].map(([v, l]) => `<button data-v="${v}" class="${f.platform === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="seg" id="win-seg">
        ${WINDOWS.map(([v, l]) => `<button data-v="${v}" class="${f.window === v ? 'active' : ''}">${v === 'fresh' ? `Recent (${fd}d)` : l}</button>`).join('')}
      </div>
      <select class="input" id="grp-sel"><option value="">All groups</option>${state.groups.map((g) => `<option value="${esc(g)}" ${g === f.group ? 'selected' : ''}>${esc(shown(g))}</option>`).join('')}</select>
      <input class="input grow" id="reel-q" placeholder="Search @handle or caption…" value="${esc(f.q)}" style="max-width:280px">
    </div>
    <div class="toolbar">
      <span class="label">Sort:</span>
      <div class="chips" id="sort-chips">
        ${SORTS.map(([v, l]) => `<button class="chip ${f.sort === v ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}
        <button class="chip hot ${f.viral ? 'active' : ''}" id="viral-chip" title="Reels with more views than followers (FTVR above 1×) and photos with engagement above 10%">${icon('trending-up')}Views above followers</button>
      </div>
    </div>
    <div class="reels" id="reel-grid"></div>
    <div class="more" id="reel-more"></div>`;

  const reset = () => { f.offset = 0; f.items = []; saveFilters(); };
  const reload = () => { reset(); loadReels(); };
  const rerender = () => { reset(); renderReels(params); };
  $$('#pf-seg button').forEach((b) => (b.onclick = () => { f.platform = b.dataset.v; rerender(); }));
  $$('#type-seg button').forEach((b) => (b.onclick = () => { f.type = b.dataset.v; rerender(); }));
  $$('#win-seg button').forEach((b) => (b.onclick = () => { f.window = b.dataset.v; rerender(); }));
  $$('#sort-chips .chip[data-v]').forEach((b) => (b.onclick = () => { f.sort = b.dataset.v; rerender(); }));
  $('#viral-chip').onclick = () => { f.viral = !f.viral; rerender(); };
  $('#grp-sel').onchange = (e) => { f.group = e.target.value; reload(); };
  let t;
  $('#reel-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); reload(); }, 300); };
  // stale = a scan finished while this list was in use; reload it now instead of interrupting the user then.
  if (!f.items.length || f.stale) { f.stale = false; f.offset = 0; await loadReels(); } else paintReels();
}

function saveFilters() {
  const { sort, platform, window: w, viral, group, type } = state.reels;
  try { localStorage.setItem('reelsFilters', JSON.stringify({ sort, platform, window: w, viral, group, type, v2: true })); } catch {}
}

async function loadReels(append = false) {
  const f = state.reels;
  const seq = (loadReels.seq = (loadReels.seq || 0) + 1);
  try {
    const data = await api('/api/reels?' + reelsQuery());
    if (seq !== loadReels.seq) return; // a newer filter change already replaced this request
    f.total = data.total;
    f.items = append ? f.items.concat(data.items) : data.items;
    f.freshCutoff = data.freshCutoff;
    if (!append) f.stale = false;
    paintReels();
  } catch (e) {
    if (seq !== loadReels.seq) return;
    toast(e.message, true);
    const grid = $('#reel-grid');
    if (append) paintMore();
    else if (grid && !f.items.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon('alert-circle', { size: 28 })}<h3>Could not load the reels</h3><p>${esc(stripEmoji(e.message))}</p></div>`;
    }
  }
}

function paintReels() {
  const f = state.reels;
  const grid = $('#reel-grid');
  if (!grid) return;
  $('#reel-total').textContent = fmt(f.total);
  if (f.creator && f.items[0]) $('#creator-filter-label').innerHTML = `· @${esc(f.items[0].handle)} <a href="#/reels" class="btn sm ghost">${icon('x')}Clear filter</a>`;
  if (!f.items.length) {
    const noCreators = !state.stats?.trackedCreators;
    if (f.creator) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon('video', { size: 28 })}<h3>No reels from this creator ${f.window ? 'in this window' : 'yet'}</h3>
        <p>${f.window ? 'Try “All” in the time window, or check her videos now.' : 'Check her videos now.'}</p>
        <div class="row" style="justify-content:center">${f.window ? '<button class="btn" id="win-all">See all</button>' : ''}<button class="btn primary" id="scan-one">${icon('refresh')}Check now</button></div></div>`;
      $('#reel-more').innerHTML = '';
      if ($('#win-all')) $('#win-all').onclick = () => { f.window = ''; f.items = []; saveFilters(); route(); };
      $('#scan-one').onclick = () => startScan({ creatorIds: [Number(f.creator)] });
      return;
    }
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon(noCreators ? 'users' : 'filter', { size: 28 })}
      <h3>${noCreators ? 'You are not following any creators yet' : 'No reels match these filters'}</h3>
      <p>${noCreators ? 'In <a href="#/creators">Creators</a>, paste a list of Instagram or TikTok @handles and press “Import creators”.' : 'Widen the time window or press “Find new reels”.'}</p></div>`;
    $('#reel-more').innerHTML = '';
    return;
  }
  grid.innerHTML = f.items.map(reelCard).join('');
  paintMore();
  bindReelCards(grid);
}

// "Ver mais": next 50 of this filter; at the end of a time window, widen it to every older reel.
function paintMore() {
  const f = state.reels;
  const box = $('#reel-more');
  if (!box) return;
  const left = f.total - f.items.length;
  const winLabel = f.window === 'fresh' ? `from the last ${state.stats?.freshDays || 3} days` : f.window ? `from the last ${f.window} days` : '';
  box.innerHTML = left > 0
    ? `<button class="btn big" id="more-btn">See more <span class="dim">(${fmt(Math.min(left, REELS_PAGE))} of ${fmt(left)} remaining)</span></button>`
    : f.window ? `<button class="btn big ghost" id="more-all">See older reels <span class="dim">(you have seen every reel ${winLabel})</span></button>` : '';
  if ($('#more-btn')) $('#more-btn').onclick = async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Loading…';
    f.offset = f.items.length;
    await loadReels(true);
  };
  if ($('#more-all')) $('#more-all').onclick = () => { f.window = ''; f.offset = 0; f.items = []; saveFilters(); route(); };
}

function modelOptions(selected) {
  return `<option value="">No model</option>` + state.models.map((m) => `<option value="${m.id}" ${String(selected) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
}

// Cover image as a lazy <img>. Local covers ("thumbs/…") use the downscaled copy in thumbs_sm/ and fall back to
// the full-size file if the small one cannot be served (see the error listener at boot).
let smallThumbs = true; // turned off at runtime if the server cannot serve media/thumbs_sm
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const fallback = img.dataset.fallback;
  delete img.dataset.fallback;
  // Small copy failed but the original loads: the server has no thumbs_sm, so stop asking for it,
  // including on cards already on the page that the lazy loader has not fetched yet.
  img.addEventListener('load', () => {
    if (!smallThumbs) return;
    smallThumbs = false;
    $$('img[data-fallback]').forEach((el) => { const fb = el.dataset.fallback; delete el.dataset.fallback; el.src = fb; });
  }, { once: true });
  img.src = fallback;
}, true);

function coverImg(r, slides = []) {
  const img = (src, fallback = '') =>
    `<img class="thumb-img" src="${esc(src)}"${fallback ? ` data-fallback="${esc(fallback)}"` : ''} loading="lazy" decoding="async" draggable="false" alt="">`;
  if (r.thumb_path) {
    return smallThumbs && r.thumb_path.startsWith('thumbs/')
      ? img(`/media/thumbs_sm/${r.thumb_path.slice(7)}`, `/media/${r.thumb_path}`)
      : img(`/media/${r.thumb_path}`);
  }
  if (slides[0]) return img(`/media/${slides[0]}`);
  if (r.thumb_url) return img(r.thumb_url);
  return '';
}

function reelCard(r) {
  const fresh = r.posted_at && r.posted_at >= state.reels.freshCutoff;
  const isPhoto = r.media_type && r.media_type !== 'video';
  const slides = (() => { try { return JSON.parse(r.image_paths || '[]'); } catch { return []; } })();
  const viral = isPhoto ? r.engagement !== null && r.engagement >= 0.1 : r.ftvr !== null && r.ftvr >= 1;
  const cover = coverImg(r, slides);
  return `
  <article class="reel ${viral ? 'viral' : ''}" data-id="${r.id}">
    <div class="thumb" data-play>
      ${cover || '<div class="noimg">No thumbnail</div>'}
      <div class="tl"><span class="badge ${r.platform === 'tiktok' ? 'tt' : 'ig'}">${PF[r.platform]}</span>${isPhoto ? `<span class="badge">${r.media_type === 'carousel' ? `${icon('images')}${slides.length || ''}` : `${icon('image')}Photo`}</span>` : ''}${fresh ? '<span class="badge fresh">Recent</span>' : ''}</div>
      <div class="tr"><button class="icon-btn" data-hide title="Hide" aria-label="Hide">${icon('x')}</button></div>
      <div class="play">${icon(isPhoto ? 'zoom-in' : 'play')}</div>
      <div class="bl">${r.duration && !isPhoto ? `<span class="badge">${Math.round(r.duration)} s</span>` : '<span></span>'}<span style="display:flex;gap:4px">${r.video_path ? `<span class="badge" title="Already in the Library">${icon('download')}Saved</span>` : ''}${r.remake_count ? `<span class="badge remake">${r.remake_count} ${r.remake_count === 1 ? 'remake' : 'remakes'}</span>` : ''}</span></div>
    </div>
    <div class="metrics">
      ${isPhoto ? `<div><b>${pct(r.engagement)}</b><span>engagement</span></div>` : `<div><b>${fmt(r.views)}</b><span>views</span></div>`}
      <div><b>${fmt(r.likes)}</b><span>likes</span></div>
      <div><b>${fmt(r.comments)}</b><span>comments</span></div>
    </div>
    <div class="pills">
      <div class="pill">${fmt(r.followers)}<small>fol.</small></div>
      ${isPhoto
        ? `<div class="pill ${viral ? 'good' : r.engagement >= 0.03 ? 'mid' : ''}" title="(likes + comments) ÷ followers">${pct(r.engagement)}<small>ER</small></div>`
        : `<div class="pill ${viral ? 'good' : r.ftvr >= 0.3 ? 'mid' : ''}" title="views ÷ followers">${ratio(r.ftvr)}<small>FTVR</small></div>`}
    </div>
    <div class="who"><a href="#/reels?creator=${r.creator_id}">@${esc(r.handle)}</a><span class="dim" title="${esc(dateTime(r.posted_at))}">${ago(r.posted_at)} ago</span></div>
    <div class="cap" title="${esc(stripEmoji(r.caption))}">${esc(stripEmoji(r.caption)) || '&nbsp;'}</div>
    <form class="remake-form">
      <input class="input" name="prompt" placeholder="${isPhoto ? 'What you want in the photo…' : 'What you want to remake…'}">
      <button class="btn primary sm remake-go" title="${isPhoto ? 'Recreate this photo with your model' : 'Remake this reel with your model'}">${icon('repeat')}Remake</button>
    </form>
  </article>`;
}

function bindReelCards(root) {
  $$('.reel', root).forEach((card) => {
    const id = Number(card.dataset.id);
    const reel = () => state.reels.items.find((x) => x.id === id);
    $('[data-play]', card).onclick = (e) => { if (!e.target.closest('[data-hide]')) openReel(reel()); };
    $('[data-hide]', card).onclick = async (e) => {
      e.stopPropagation();
      try { await api(`/api/reels/${id}`, { method: 'PATCH', body: { hidden: true } }); } catch (err) { return toast(err.message, true); }
      state.reels.items = state.reels.items.filter((x) => x.id !== id);
      state.reels.total--;
      card.remove();
      $('#reel-total').textContent = fmt(state.reels.total);
    };
    $('.remake-form', card).onsubmit = (e) => {
      e.preventDefault();
      const q = new FormData(e.target).get('prompt');
      location.hash = `#/remake/${id}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    };
  });
}


function openPhotoPost(r) {
  const slides = (() => { try { return JSON.parse(r.image_paths || '[]'); } catch { return []; } })();
  const list = slides.length ? slides : r.thumb_path ? [r.thumb_path] : [];
  let i = 0;
  showModal(`
    <div class="modal-box">
      <div class="player photo-view"><img id="pv-img" src="/media/${esc(list[0] || '')}" alt="">
        ${list.length > 1 ? `<button class="pv-nav prev" id="pv-prev" title="Previous" aria-label="Previous">${icon('chevron-left')}</button><button class="pv-nav next" id="pv-next" title="Next" aria-label="Next">${icon('chevron-right')}</button><div class="pv-count" id="pv-count"></div>` : ''}</div>
      <div class="modal-side">
        <div class="row between">
          <div class="creator-cell">${avatar(r)}<div><div class="h">@${esc(r.handle)} <span class="pf ${r.platform}">${PF[r.platform]}</span></div><div class="d">${r.media_type === 'carousel' ? `Carousel · ${list.length} photos` : 'Photo'}</div></div></div>
          <button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="kv">
          <div><b>${fmt(r.likes)}</b><span>likes</span></div>
          <div><b>${fmt(r.comments)}</b><span>comments</span></div>
          <div><b>${pct(r.engagement)}</b><span>engagement</span></div>
          <div><b>${fmt(r.followers)}</b><span>followers</span></div>
        </div>
        <div class="caption">${esc(stripEmoji(r.caption)) || '<span class="dim">No caption</span>'}</div>
        <a class="btn primary big" href="#/remake/${r.id}" data-close>${icon('repeat')}Recreate with your model</a>
        <div class="dim" style="font-size:12px;margin-top:-6px">Recreates the photo with your model, with the same pose, setting and outfit. Afterwards you can generate it in other poses.</div>
        <div class="row">
          <a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external-link')}Open in ${r.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</a>
          ${list.length ? `<a class="btn sm ghost" id="pv-dl" href="/media/${esc(list[0])}" download="${esc(r.handle)}_${esc(r.external_id)}_1.jpg">${icon('download')}Download photo</a>` : ''}
        </div>
      </div>
    </div>`);
  const show = () => {
    $('#pv-img').src = `/media/${list[i]}`;
    if ($('#pv-count')) $('#pv-count').textContent = `${i + 1}/${list.length}`;
    if ($('#pv-dl')) { $('#pv-dl').href = `/media/${list[i]}`; $('#pv-dl').download = `${r.handle}_${r.external_id}_${i + 1}.jpg`; }
  };
  if ($('#pv-prev')) { $('#pv-prev').onclick = () => { i = (i - 1 + list.length) % list.length; show(); }; $('#pv-next').onclick = () => { i = (i + 1) % list.length; show(); }; show(); }
}

function openReel(r) {
  if (!r) return;
  if (r.media_type && r.media_type !== 'video') return openPhotoPost(r);
  showModal(`
    <div class="modal-box">
      <div class="player" id="player">
        <div class="loading"><div class="spinner"></div>Loading the video…<br><small class="dim">The first time can take a few seconds.</small></div>
      </div>
      <div class="modal-side">
        <div class="row between">
          <div class="creator-cell">${avatar(r)}<div><div class="h">@${esc(r.handle)} <span class="pf ${r.platform}">${PF[r.platform]}</span></div><div class="d">${esc(r.display_name || '')}</div></div></div>
          <button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="kv">
          <div><b>${fmt(r.views)}</b><span>views</span></div>
          <div><b>${fmt(r.likes)}</b><span>likes</span></div>
          <div><b>${fmt(r.comments)}</b><span>comments</span></div>
          <div><b>${fmt(r.shares)}</b><span>shares</span></div>
          <div><b>${ratio(r.ftvr)}</b><span>FTVR</span></div>
          <div><b>${pct(r.like_rate)}</b><span>like rate</span></div>
          <div><b>${fmt(r.followers)}</b><span>followers</span></div>
          <div><b>${ago(r.posted_at)}</b><span>${esc(dateTime(r.posted_at))}</span></div>
        </div>
        <div class="caption">${esc(stripEmoji(r.caption)) || '<span class="dim">No caption</span>'}</div>
        <div id="growth" class="dim" style="font-size:12px"></div>
        <a class="btn primary big" href="#/remake/${r.id}" data-close>${icon('repeat')}Create remake</a>
        <div class="dim" style="font-size:12px;margin-top:-6px">On the next page you choose the model and the outfit. The video is recreated with her in place of the person, with the same setting, movements and original audio.</div>
        <div class="row">
          <a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external-link')}Open in ${r.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</a>
          <a class="btn sm ghost" href="${P.reelVideoUrl(r, true)}" download>${icon('download')}Download MP4</a>
        </div>
      </div>
    </div>`);

  const v = document.createElement('video');
  v.controls = true; v.autoplay = true; v.loop = true; v.playsInline = true;
  v.src = P.reelVideoUrl(r);
  v.onloadeddata = () => { const p = $('#player'); if (p) { p.innerHTML = ''; p.appendChild(v); } };
  v.onerror = () => {
    const p = $('#player');
    if (p) p.innerHTML = `<div class="loading">Could not get the video.<br><br><a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">${icon('external-link')}View the original</a></div>`;
  };
  v.load();

  api(`/api/reels/${r.id}/history`).then((h) => {
    if (h.length < 2 || !$('#growth')) return;
    const a = h[0], b = h[h.length - 1];
    const hours = Math.max(1, (b.at - a.at) / 3600);
    const dv = (b.views ?? 0) - (a.views ?? 0);
    $('#growth').textContent = `+${fmt(dv)} views over ${hours < 48 ? Math.round(hours) + ' h' : Math.round(hours / 24) + ' days'} of tracking (${fmt(Math.round(dv / hours))}/h) · ${h.length} measurements`;
  }).catch(() => {});
}

// =================================================================================
// CREATORS
// =================================================================================
async function renderCreators() {
  const st = state.stats || (await api('/api/stats'));
  if (!location.hash.startsWith('#/creators')) return;
  const f = state.creators;
  $('#topbar-actions').innerHTML = '';
  $('#view').innerHTML = `
    <h2>Followed creators</h2>
    <p class="sub">Import lists of creators, organize them by group, and mark the ones worth seeing first as priority.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${fmt(st.trackedCreators)}</div><div class="k">Followed creators</div><div class="dim" style="font-size:12px">${st.byPlatform.instagram || 0} Instagram · ${st.byPlatform.tiktok || 0} TikTok</div></div>
      <div class="tile"><div class="v">${fmt(st.postedRecently)}</div><div class="k">Posted in the last ${st.freshDays} days</div></div>
      <div class="tile"><div class="v">${fmt(st.freshReels)}</div><div class="k">Recent reels found</div></div>
      <div class="tile"><div class="v">${fmt(st.totalReels)}</div><div class="k">Reels in the database</div></div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <span class="muted">Handles without a URL are from</span>
        <select class="input" id="imp-pf"><option value="instagram">Instagram</option><option value="tiktok">TikTok</option></select>
        <span class="muted">· put in</span>
        <select class="input" id="imp-group">${state.groups.map((g) => `<option>${esc(g)}</option>`).join('')}<option value="__new">New group…</option></select>
        <label class="check"><input type="checkbox" id="imp-star"> Mark as priority</label>
        <label class="check"><input type="checkbox" id="imp-scan" checked> Scan right after</label>
      </div>
      <textarea class="input" id="imp-text" rows="5" placeholder="Paste hundreds of handles, one per line or separated by spaces/commas
@creator_one
creator.two
https://instagram.com/creator_three/
https://www.tiktok.com/@creator_four
tt:creator_five   (the tt: / ig: prefix forces the platform)"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="imp-btn">Import creators</button>
        <label class="btn">Choose .txt or .csv<input type="file" id="imp-file" accept=".txt,.csv" hidden></label>
        <button class="btn" id="scan-btn">${icon('refresh')}Find new reels</button>
        <select class="input" id="scan-scope">
          <option value="">All</option><option value="starred">Priority only</option>
          <option value="instagram">Instagram only</option><option value="tiktok">TikTok only</option>
          ${state.groups.map((g) => `<option value="group:${esc(g)}">Group: ${esc(g)}</option>`).join('')}
        </select>
        <span class="dim" style="font-size:12px">Duplicates are ignored.</span>
      </div>
    </div>

    <div class="card">
      <div class="row between"><h3 style="margin:0">${icon('star')}Priority</h3><span class="dim" id="prio-count"></span></div>
      <div class="priority" id="prio" style="margin-top:12px"></div>
    </div>

    <div class="toolbar">
      <input class="input grow" id="c-q" placeholder="Search creators…" value="${esc(f.q)}">
      <div class="seg" id="c-pf">${[['', 'All'], ['instagram', 'Instagram'], ['tiktok', 'TikTok']].map(([v, l]) => `<button data-v="${v}" class="${f.platform === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <select class="input" id="c-group"><option value="">All groups</option>${state.groups.map((g) => `<option value="${esc(g)}" ${g === f.group ? 'selected' : ''}>${esc(shown(g))}</option>`).join('')}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th style="width:30px"></th><th data-s="handle">Creator</th><th>Group</th><th data-s="followers">Followers</th>
        <th data-s="ftvr">Best FTVR</th><th data-s="fresh">Recent</th><th>Total</th><th data-s="latest">Latest reel</th>
        <th data-s="checked">Last checked</th><th>Status</th><th></th>
      </tr></thead>
      <tbody id="c-body"><tr><td colspan="11" class="dim">Loading…</td></tr></tbody>
    </table></div>`;

  $('#imp-group').onchange = (e) => {
    if (e.target.value !== '__new') return;
    const name = prompt('Name of the new group:');
    if (name?.trim()) {
      state.groups.push(name.trim());
      e.target.insertAdjacentHTML('afterbegin', `<option selected>${esc(name.trim())}</option>`);
    } else e.target.selectedIndex = 0;
  };
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    // For CSV, keep every cell — the parser ignores anything that isn't a valid handle/URL.
    $('#imp-text').value = ($('#imp-text').value + '\n' + text.replace(/"/g, '')).trim();
    toast(`${file.name} loaded. Review the list and press Import creators`);
  };
  $('#imp-btn').onclick = async () => {
    const text = $('#imp-text').value;
    if (!text.trim()) return toast('Paste at least one handle', true);
    try {
      const r = await api('/api/creators/import', {
        method: 'POST',
        body: { text, platform: $('#imp-pf').value, group: $('#imp-group').value, starred: $('#imp-star').checked, scanNow: $('#imp-scan').checked, regroup: true },
      });
      toast(`${r.added} added · ${r.existing} already existed${r.invalid.length ? ` · ${r.invalid.length} invalid` : ''}`);
      if (r.invalid.length) console.warn('Invalid handles:', r.invalid);
      $('#imp-text').value = r.invalid.join('\n');
      if (r.scan?.queued) toast(`${r.added} added. They join the scan as soon as the current one finishes`);
      if (r.scan?.job) pollJob(true);
      await loadShared(); renderCreators().catch((err) => toast(err.message, true));
    } catch (e) { toast(e.message, true); }
  };
  $('#scan-btn').onclick = () => {
    const v = $('#scan-scope').value;
    const body = v === 'starred' ? { starred: true } : v.startsWith('group:') ? { group: v.slice(6) } : v ? { platform: v } : {};
    startScan(body);
  };

  const reload = () => loadCreators().catch((e) => toast(e.message, true));
  let t;
  $('#c-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); reload(); }, 250); };
  $('#c-group').onchange = (e) => { f.group = e.target.value; reload(); };
  $$('#c-pf button').forEach((b) => (b.onclick = () => { f.platform = b.dataset.v; $$('#c-pf button').forEach((x) => x.classList.toggle('active', x === b)); reload(); }));
  $$('th[data-s]').forEach((th) => (th.onclick = () => { f.sort = f.sort === th.dataset.s ? '' : th.dataset.s; reload(); }));
  reload();
}

async function loadCreators() {
  const f = state.creators;
  const p = new URLSearchParams();
  for (const k of ['q', 'group', 'platform', 'sort']) if (f[k]) p.set(k, f[k]);
  const seq = (loadCreators.seq = (loadCreators.seq || 0) + 1);
  const [rows, starred] = await Promise.all([api('/api/creators?' + p), api('/api/creators?starred=1')]);
  const body = $('#c-body');
  if (!body || seq !== loadCreators.seq) return; // left the page, or a newer search replaced this one
  $$('th[data-s]').forEach((th) => th.classList.toggle('sorted', th.dataset.s === f.sort));

  $('#prio-count').textContent = starred.length;
  $('#prio').innerHTML = starred.length
    ? starred.map((c) => `<a class="p" href="#/reels?creator=${c.id}">${avatar(c)}@${esc(c.handle)} <span class="pf ${c.platform}">${PF[c.platform]}</span>${c.fresh ? `<span class="badge fresh" title="Recent reels">${c.fresh}</span>` : ''}</a>`).join('')
    : '<span class="dim">Use the star in the table to mark the creators to follow closely.</span>';

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="dim" style="text-align:center;padding:30px">${f.q || f.group || f.platform ? 'No creators match these filters.' : 'No creators yet. Import a list above.'}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((c) => `
    <tr data-id="${c.id}">
      <td><button class="star ${c.starred ? 'on' : ''}" data-star title="Priority" aria-label="Priority" aria-pressed="${c.starred ? 'true' : 'false'}">${icon(c.starred ? 'star-filled' : 'star')}</button></td>
      <td><a class="creator-cell" href="#/reels?creator=${c.id}">${avatar(c)}<div><div class="h">@${esc(c.handle)} <span class="pf ${c.platform}">${PF[c.platform]}</span></div><div class="d">${esc(c.display_name || '')}</div></div></a></td>
      <td><select class="input" data-group>${[...new Set([...state.groups, c.group_name])].map((g) => `<option value="${esc(g)}" ${g === c.group_name ? 'selected' : ''}>${esc(shown(g))}</option>`).join('')}</select></td>
      <td>${fmt(c.followers)}</td>
      <td><span class="pill ${c.best_ftvr >= 1 ? 'good' : ''}" style="display:inline-block">${ratio(c.best_ftvr)}</span></td>
      <td>${c.fresh || '0'}</td>
      <td>${c.total}</td>
      <td title="${esc(dateTime(c.latest_reel))}">${c.latest_reel ? ago(c.latest_reel) + ' ago' : '—'}</td>
      <td class="dim">${dateTime(c.last_checked_at)}</td>
      <td><span class="status ${esc(c.status)}" title="${esc(stripEmoji(c.last_error || ''))}">${{ ok: 'Active', new: 'Not checked yet', error: 'Error', not_found: 'Does not exist', private: 'Private' }[c.status] || esc(c.status)}</span></td>
      <td class="row" style="flex-wrap:nowrap;gap:4px">
        <button class="btn sm ghost icon-only" data-scan title="Check now" aria-label="Check now">${icon('refresh')}</button>
        <a class="btn sm ghost icon-only" href="${profileUrl(c.platform, c.handle)}" target="_blank" rel="noopener" title="Open profile" aria-label="Open profile">${icon('external-link')}</a>
        <button class="btn sm ghost danger icon-only" data-del title="Remove" aria-label="Remove">${icon('trash')}</button>
      </td>
    </tr>`).join('');

  $$('tr[data-id]', body).forEach((tr) => {
    const id = Number(tr.dataset.id);
    $('[data-star]', tr).onclick = async (e) => {
      // currentTarget: the click can land on the SVG inside the button.
      const btn = e.currentTarget;
      const on = !btn.classList.contains('on');
      btn.disabled = true;
      try {
        await api(`/api/creators/${id}`, { method: 'PATCH', body: { starred: on } });
        await loadCreators();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    };
    $('[data-group]', tr).onchange = async (e) => {
      try {
        await api(`/api/creators/${id}`, { method: 'PATCH', body: { group: e.target.value } });
        toast('Group updated');
      } catch (err) { toast(err.message, true); }
    };
    $('[data-scan]', tr).onclick = () => startScan({ creatorIds: [id] });
    $('[data-del]', tr).onclick = async () => {
      if (!confirm('Remove this creator and all her saved reels?')) return;
      try {
        try {
          await api(`/api/creators/${id}`, { method: 'DELETE' });
        } catch (err) {
          // Projects made from her reels would go with her: the server says how many. `force`: none published or in the
          // agenda, so they may go too once confirmed. If not, she can stop being followed instead: the projects stay.
          if (err.status !== 409) throw err;
          if (err.data.force && confirm(`${err.message}\n\nRemove anyway?`)) await api(`/api/creators/${id}?force=1`, { method: 'DELETE' });
          else if (confirm(`${err.data.force ? '' : `${err.message}\n\n`}Unfollow this creator instead? She leaves Creators and is no longer checked; the projects stay. To follow her again, import her again.`)) {
            await api(`/api/creators/${id}`, { method: 'PATCH', body: { tracked: false } });
            toast('You unfollowed this creator');
          } else return;
        }
        state.reels.items = [];
        await loadShared(); await loadCreators();
      } catch (err) { toast(err.message, true); }
    };
  });
}

// =================================================================================
// REMAKES
// =================================================================================
// Read from each remake's latest project (the server works it out); only Rejeitar / Repor is done by hand.
const STATUS = { queued: 'Queued', in_progress: 'In production', done: 'Done', failed: 'Failed', rejected: 'Rejected' };
const GEN_STAGE = { queued: 'Queued', imaging: 'Generating images', awaiting_approval: 'Waiting for you (steps 2–4)', animating: 'Generating video', review: 'Review video', approved: 'Ready', rejected: 'Rejected', failed: 'Failed', cancelled: 'Canceled' };

async function renderRemakes(params) {
  const f = state.remakes;
  if (params.has('model')) f.model = params.get('model');
  $('#view').innerHTML = `
    <h2>Remake queue</h2>
    <p class="sub">Every remake created from the reels. Assign a model and press <b>Generate</b> to send it to the pipeline (analysis, image and video). Each generation is a project in <a href="#/projects" style="color:var(--accent-text)">Projects</a>, step by step.</p>
    <div class="toolbar">
      <div class="seg" id="rm-status">${[['', 'All'], ...Object.entries(STATUS)].map(([v, l]) => `<button data-v="${v}" class="${f.status === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <select class="input" id="rm-model"><option value="">All models</option>${state.models.map((m) => `<option value="${m.id}" ${String(m.id) === String(f.model) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <span class="grow"></span>
      <span id="rm-all"></span>
    </div>
    <div class="card" style="padding:0" id="rm-list"><div class="page-loading" style="min-height:120px"><div class="spinner"></div></div></div>`;
  $$('#rm-status button').forEach((b) => (b.onclick = () => { f.status = b.dataset.v; renderRemakes(new URLSearchParams()).catch((e) => toast(e.message, true)); }));
  $('#rm-model').onchange = (e) => { f.model = e.target.value; location.hash = f.model ? `#/remakes?model=${f.model}` : '#/remakes'; };
  // "Gerar todos": the waiting remakes of the chosen model, in one go (reference: "run ALL → model").
  const allBox = $('#rm-all');
  if (f.model) {
    api('/api/remakes/generate-all', { method: 'POST', body: { modelId: Number(f.model), dryRun: true } }).then((d) => {
      if (!allBox.isConnected || !d.count) return;
      const name = state.models.find((m) => String(m.id) === String(f.model))?.name || 'model';
      allBox.innerHTML = `<button class="btn primary" id="rm-all-go" title="${d.manual ? 'Step by step: only the swap images now; the enlargement and the video when you choose them in each project' : 'Automatic: each project goes all the way to the video'}">${icon('play-circle')}Generate all (${d.count}) · ${esc(name)} · ~$${d.estimate.toFixed(2)}</button>`;
      $('#rm-all-go').onclick = async (e) => {
        const btn = e.currentTarget;
        let bal = null;
        try { bal = (await api('/api/status/summary')).wavespeed; } catch {}
        const lines = [
          `Generate the ${d.count} remakes waiting for ${name}?`,
          d.manual ? `Now: ~$${d.estimate.toFixed(2)} (the swap images). Later, in each project, only when you choose them: enlargement and video, ~$${d.later.toFixed(2)} in total.` : `Cost: ~$${d.estimate.toFixed(2)} (images and videos, all automatic).`,
          `${d.parallel} run at a time (In parallel, in Projects).`,
          bal?.usd != null && bal.usd < d.estimate + (d.later || 0) ? `Heads up: the WaveSpeed balance is $${bal.usd.toFixed(2)}, less than the total.` : '',
        ].filter(Boolean);
        if (!confirm(lines.join('\n\n'))) return;
        btn.disabled = true;
        try {
          const r = await api('/api/remakes/generate-all', { method: 'POST', body: { modelId: Number(f.model) } });
          toast(`${r.started.length} project(s) started${r.skipped.length ? ` · ${r.skipped.length} did not start: ${stripEmoji(r.skipped[0].error)}` : ''}`, !!r.skipped.length && !r.started.length);
          loadShared().catch(() => {});
          location.hash = '#/projects?view=active';
        } catch (err) { toast(err.message, true); btn.disabled = false; }
      };
    }).catch(() => {});
  } else allBox.innerHTML = '<span class="dim" style="font-size:12.5px">Choose the model to generate them all at once</span>';

  const p = new URLSearchParams();
  if (f.status) p.set('status', f.status);
  if (f.model) p.set('model', f.model);
  const seq = (renderRemakes.seq = (renderRemakes.seq || 0) + 1);
  const rows = await api('/api/remakes?' + p);
  const list = $('#rm-list');
  if (!list || seq !== renderRemakes.seq) return;
  if (!rows.length) {
    const filtered = f.status || f.model;
    list.innerHTML = `<div class="empty" style="border:none">${icon('repeat', { size: 28 })}
      <h3>${filtered ? 'No remakes match these filters' : 'No remakes yet'}</h3>
      <p>${filtered ? 'Choose “All” to see the full queue.' : 'In <a href="#/reels">Reels</a>, press “Remake” on a reel to create the first remake.'}</p></div>`;
    return;
  }
  list.innerHTML = rows.map((m) => `
    <div class="remake-row" data-id="${m.id}">
      <a class="rt" href="${esc(m.url)}" target="_blank" rel="noopener" title="Open the original reel">${coverImg(m)}</a>
      <div>
        <div class="row" style="gap:8px">
          ${m.model_name ? `<span class="avatar-letter" style="--c:${esc(m.model_color || COLORS[0])};width:22px;height:22px;font-size:10px">${esc(m.model_name[0])}</span><b>${esc(m.model_name)}</b>` : '<span class="dim">No model</span>'}
          <span class="dim">· from <span class="pf ${m.platform}">${PF[m.platform]}</span> @${esc(m.handle)} · ${fmt(m.views)} views · ${ratio(m.followers ? m.views / m.followers : null)} FTVR</span>
        </div>
        <div class="prompt">${esc(m.prompt) || '<span class="dim">No instructions</span>'}</div>
        <div class="dim" style="font-size:12px">Added ${dateTime(m.created_at)}${m.gen_id ? ` · <a href="#/projects/${m.gen_id}" style="color:var(--accent-text)">Project #${m.gen_id} · ${esc(GEN_STAGE[m.gen_stage] || m.gen_stage)}</a>` : ''}</div>
      </div>
      <div class="row" style="flex-wrap:nowrap">
        <select class="input" data-model title="Model" aria-label="Model">${modelOptions(m.model_id)}</select>
        <button class="btn sm primary" data-gen ${m.gen_stage && ['queued', 'imaging', 'animating'].includes(m.gen_stage) ? 'disabled' : ''}>${icon('play-circle')}${m.gen_id ? 'Generate again' : 'Generate'}</button>
        <span class="status rm-state ${m.status}">${STATUS[m.status] || esc(m.status)}</span>
        ${['in_progress', 'done'].includes(m.status) ? '' : `<button class="btn sm ghost" data-reject title="${m.status === 'rejected' ? 'Puts this remake back in the queue' : 'Takes this remake out of the queue without deleting it'}">${m.status === 'rejected' ? 'Restore' : 'Reject'}</button>`}
        <button class="btn sm ghost danger icon-only" data-del title="Delete remake" aria-label="Delete remake">${icon('trash')}</button>
      </div>
    </div>`).join('');
  $$('.remake-row', list).forEach((row) => {
    const id = row.dataset.id;
    const rej = $('[data-reject]', row); // only where a click can change the state (not while its project runs or is done)
    if (rej) rej.onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const m = rows.find((x) => String(x.id) === String(id));
      try {
        await api(`/api/remakes/${id}`, { method: 'PATCH', body: { status: m?.status === 'rejected' ? 'queued' : 'rejected' } });
        toast(m?.status === 'rejected' ? 'Remake back in the queue' : 'Remake rejected');
        loadShared().catch(() => {});
        renderRemakes(new URLSearchParams()).catch((err) => toast(err.message, true));
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    };
    $('[data-del]', row).onclick = async () => {
      if (!confirm('Delete this remake? Its projects (generated images and videos) are deleted too.')) return;
      try {
        await api(`/api/remakes/${id}`, { method: 'DELETE' });
        row.remove(); loadShared().catch(() => {});
      } catch (err) { toast(err.message, true); }
    };
    $('[data-model]', row).onchange = async (e) => {
      const sel = e.currentTarget;
      const modelId = Number(sel.value) || null;
      try {
        await api(`/api/remakes/${id}`, { method: 'PATCH', body: { modelId } });
        if (modelId) return toast('Model assigned');
        // Removing the model depends on the server clearing it: confirm before reporting success.
        const cur = (await api('/api/remakes')).find((x) => String(x.id) === String(id));
        if (cur?.model_id) { sel.value = String(cur.model_id); toast('Could not remove the model from this remake', true); }
        else toast('Model removed');
      } catch (err) { toast(err.message, true); }
    };
    $('[data-gen]', row).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; // avoid a double click starting (and paying for) two generations
      try {
        // It repeats this remake's last run (engine, variants, Automático or not): its price first.
        const e = await api(`/api/remakes/${id}/generate`, { method: 'POST', body: { dryRun: true } });
        if (!confirm(e.manual
          ? `Generate the swap images for this remake? Now: ~$${e.estimate.toFixed(2)}. Later, only when you choose them: enlargement and video ~$${e.later.toFixed(2)}.`
          : `Generate this remake in Automatic (the images and the video continue on their own)? ~$${e.estimate.toFixed(2)}.`)) { btn.disabled = false; return; }
        const g = await P.generateRemake(id);
        const rm = rows.find((x) => String(x.id) === String(id));
        if (g) location.hash = rm?.reel_id ? `#/remake/${rm.reel_id}?gen=${g.id}` : `#/projects/${g.id}`; // the Remake page, with its steps below
        else btn.disabled = false;
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    };
  });
}

// =================================================================================
// SETUP
// =================================================================================
async function renderSetup() {
  const [s, h, pst, rhw] = await Promise.all([api('/api/settings'), api('/api/health'), api('/api/pipeline/status').catch(() => null), api('/api/runninghub/workflows').catch(() => null)]);
  if (!location.hash.startsWith('#/setup')) return;
  $('#view').innerHTML = `
    <h2>Settings</h2>
    <p class="sub">Connections to the scrapers, the generation pipeline and the scan parameters. Everything is stored locally in <code>data/radar.db</code>.</p>

    <div class="card">
      <h3>Status</h3>
      <div class="health">
        <div><span class="dot ${h.ytdlp ? 'on' : ''}"></span><b>yt-dlp</b><div class="dim" style="font-size:12px">${h.ytdlp ? `v${esc(h.ytdlp.version)} · native TikTok available` : 'Missing. Run <code>npm run setup</code>'}</div></div>
        <div><span class="dot ${h.instagramCookie ? 'on' : h.providers.instagram === 'apify' && h.apifyToken ? 'on' : 'mid'}"></span><b>Instagram</b><div class="dim" style="font-size:12px">${h.providers.instagram === 'apify' ? 'Via Apify' : h.instagramCookie ? 'Native with a session' : 'Native, anonymous (limited)'}</div></div>
        <div><span class="dot on"></span><b>TikTok</b><div class="dim" style="font-size:12px">${h.providers.tiktok === 'apify' ? 'Via Apify' : 'Native (profile + yt-dlp)'}</div></div>
        <div><span class="dot ${h.apifyToken ? 'on' : ''}"></span><b>Apify</b><div class="dim" style="font-size:12px">${h.apifyToken ? 'Token set' : 'Optional, no token'}</div></div>
        <div><span class="dot ${h.lastFullScanAt ? 'on' : 'mid'}"></span><b>Last full scan</b><div class="dim" style="font-size:12px">${dateTime(h.lastFullScanAt)}</div></div>
      </div>
    </div>

    <form id="settings-form">
      <div class="grid-2">
        <div class="card stack">
          <h3>Instagram</h3>
          <label class="field"><span>Source</span>
            <select class="input" name="instagram_provider">
              <option value="native" ${s.instagram_provider === 'native' ? 'selected' : ''}>Native (Instagram web API)</option>
              <option value="apify" ${s.instagram_provider === 'apify' ? 'selected' : ''}>Apify (instagram-profile-scraper)</option>
            </select></label>
          <label class="field"><span>Session cookie ${s.instagram_cookie_set ? '<span class="status ok">Saved</span>' : ''}</span>
            <textarea class="input" name="instagram_cookie" rows="3" placeholder="${s.instagram_cookie_set ? '•••••• (leave empty to keep it)' : 'sessionid=…; csrftoken=…  (or just the sessionid value)'}"></textarea>
            <small>Instagram often blocks anonymous requests. Use a <b>secondary account</b>: sign in in the browser, open DevTools → Application → Cookies → instagram.com and copy <code>sessionid</code> (and <code>csrftoken</code>). With a session, the scraper uses the Reels tab (real plays).</small>
            ${s.instagram_cookie_set ? '<label class="check"><input type="checkbox" name="clear_instagram_cookie"> Delete the saved cookie</label>' : ''}
          </label>
        </div>
        <div class="card stack">
          <h3>TikTok</h3>
          <label class="field"><span>Source</span>
            <select class="input" name="tiktok_provider">
              <option value="native" ${s.tiktok_provider === 'native' ? 'selected' : ''}>Native (no account: profile HTML + yt-dlp)</option>
              <option value="apify" ${s.tiktok_provider === 'apify' ? 'selected' : ''}>Apify (clockworks/tiktok-scraper)</option>
            </select></label>
          <h3 style="margin-top:8px">Apify</h3>
          <label class="field"><span>API token ${s.apify_token_set ? '<span class="status ok">Saved</span>' : ''}</span>
            <input class="input" name="apify_token" type="password" autocomplete="off" placeholder="${s.apify_token_set ? '•••••• (leave empty to keep it)' : 'apify_api_…'}">
            <small>Optional. A paid, stable alternative for when the native scrapers get blocked. Create the token at apify.com → Settings → Integrations.</small>
            ${s.apify_token_set ? '<label class="check"><input type="checkbox" name="clear_apify_token"> Delete the saved token</label>' : ''}
          </label>
        </div>
      </div>
      ${P.pipelineSetupHtml(s, pst)}
      ${P.runningHubSetupHtml(s, rhw, state.models)}
      <div class="card">
        <h3>Scan</h3>
        <div class="grid-2" style="gap:14px">
          <label class="field"><span>Recent window (days)</span><input class="input" type="number" min="1" max="30" name="fresh_days" value="${esc(s.fresh_days)}"></label>
          <label class="field"><span>Latest posts per creator</span><input class="input" type="number" min="12" max="500" name="max_reels_per_creator" value="${esc(s.max_reels_per_creator)}"><small>Each scan rereads the latest N posts (reels and photos): it adds the new ones and updates the metrics. Older ones stay saved.</small></label>
          <label class="field"><span>Creators in parallel</span><input class="input" type="number" min="1" max="6" name="concurrency" value="${esc(s.concurrency)}"><small>2 is the safe value. More creators in parallel raise the risk of an Instagram block.</small></label>
          <label class="field"><span>Automatic download to the Library</span><select class="input" name="auto_download_ftvr">${[['0', 'Off'], ['0.5', 'Reels with FTVR ≥ 0.5×'], ['1', 'Reels with FTVR ≥ 1× (more views than followers)'], ['2', 'Reels with FTVR ≥ 2×']].map(([v, l]) => `<option value="${v}" ${String(s.auto_download_ftvr) === v ? 'selected' : ''}>${l}</option>`).join('')}</select><small>After each scan, the viral reels are saved in the app, ready for a remake.</small></label>
          <label class="field"><span>Automatic scan every (hours, 0 = off)</span><input class="input" type="number" min="0" max="168" name="auto_scan_hours" value="${esc(s.auto_scan_hours)}"><small>Only runs while the app is open.</small></label>
        </div>
        <label class="field" style="margin-top:14px"><span>Groups (comma-separated)</span><input class="input" name="groups" value="${esc(s.groups.join(', '))}"></label>
      </div>
      <div class="row" style="margin-bottom:22px"><button class="btn primary">Save settings</button></div>
    </form>

    <div class="grid-2">
      <div class="card stack">
        <h3>Test the scraper</h3>
        <p class="muted" style="margin:0">Runs the scraper on one account without saving anything. Use it to confirm that the session or the token works.</p>
        <div class="row">
          <select class="input" id="t-pf"><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></select>
          <input class="input" id="t-handle" placeholder="@handle" style="flex:1">
          <button class="btn" id="t-btn">Test</button>
        </div>
        <pre class="out hidden" id="t-out"></pre>
      </div>
      <div class="card stack">
        <div class="row between"><h3 style="margin:0">Models</h3><button class="btn sm" id="setup-add-model">${icon('plus')}New model</button></div>
        ${state.models.length ? state.models.map((m) => `
          <div class="row between" style="border-bottom:1px solid var(--line);padding-bottom:8px">
            <div class="row"><span class="avatar-letter" style="--c:${esc(m.color || COLORS[m.id % COLORS.length])}">${esc(m.name[0])}</span><div><b>${esc(m.name)}</b><div class="dim" style="font-size:12px">${esc(m.notes || '')}</div></div></div>
            <button class="btn sm ghost danger" data-del-model="${m.id}">Remove</button>
          </div>`).join('') : '<span class="dim">No models yet.</span>'}
      </div>
    </div>`;

  $('#settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    body.groups = String(body.groups || '').split(',').map((g) => g.trim()).filter(Boolean);
    for (const k of ['instagram_cookie', 'apify_token', 'wavespeed_api_key', 'comfy_api_key', 'gemini_api_key', 'fal_api_key', 'rh_api_key']) body[`clear_${k}`] = fd.has(`clear_${k}`);
    try {
      await api('/api/settings', { method: 'PUT', body });
      await P.saveRunningHubModels();
      toast('Settings saved');
      await loadShared(); await renderSetup();
    } catch (err) { toast(err.message, true); }
  };
  P.showEstimate();
  P.bindRunningHubSetup();
  $('#t-btn').onclick = async () => {
    const out = $('#t-out');
    out.classList.remove('hidden');
    out.textContent = 'Running…';
    $('#t-btn').disabled = true;
    try {
      const r = await api('/api/test-scrape', { method: 'POST', body: { platform: $('#t-pf').value, handle: $('#t-handle').value } });
      out.textContent = r.ok
        ? `Success: @${r.handle} (${r.platform}) in ${(r.ms / 1000).toFixed(1)} s\nName: ${r.profile.displayName}\nFollowers: ${fmt(r.profile.followers)}\nReels found: ${r.reels}${r.note ? `\nNote: ${r.note}` : ''}\n\n` +
          r.sample.map((x) => `${dateTime(x.postedAt)}  ${fmt(x.views)} views  ${fmt(x.likes)} likes  ${x.url}`).join('\n')
        : `Failed: [${r.code}] ${stripEmoji(r.error)}`;
    } catch (e) { out.textContent = 'Failed: ' + stripEmoji(e.message); }
    $('#t-btn').disabled = false;
  };
  $('#setup-add-model').onclick = () => openModelDialog();
  $$('[data-del-model]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this model? Its folder, photos, accounts in Profiles, captions and Studio creations are deleted; the remakes are left without a model.')) return;
    try {
      await api(`/api/models/${b.dataset.delModel}`, { method: 'DELETE' });
      await loadShared(); await renderSetup();
    } catch (err) { toast(err.message, true); }
  }));
}

// =================================================================================
// SCAN JOB
// =================================================================================
async function startScan(body = {}) {
  try {
    const r = await api('/api/scan', { method: 'POST', body });
    toast(r.queued ? 'Waiting. It starts as soon as the current scan finishes' : 'Scan started');
    pollJob(true);
  } catch (e) { toast(e.message, true); }
}

// True while the user is typing, or has text on the page that a repaint would throw away.
function hasUnsavedInput() {
  const a = document.activeElement;
  if (a && $('#view').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  return $$('#view .remake-form input, #view textarea').some((el) => el.value.trim());
}

// Scans the scheduler starts on its own (auto_scan_hours, never-checked creators) run silently in the background.
const BACKGROUND_SCANS = ['auto', 'new'];

let pollTimer = null;
let lastJobState = null;
let dismissedJob = null;
const seenRunning = new Set();
async function pollJob(force = false) {
  clearTimeout(pollTimer);
  let job = null;
  try { job = (await api('/api/job')).job; } catch {}
  const el = $('#job');
  if (job && (force || (job.state === 'running' && !BACKGROUND_SCANS.includes(job.reason)))) seenRunning.add(job.id);
  const visible = job && job.id !== dismissedJob && seenRunning.has(job.id);
  el.classList.toggle('hidden', !visible);
  if (visible) {
    const pctDone = job.total ? Math.round((job.done / job.total) * 100) : 0;
    el.innerHTML = `
      <div class="row between"><b>${job.state === 'running' ? 'Looking for reels…' : job.state === 'cancelled' ? 'Scan canceled' : 'Scan complete'}</b>
        ${job.state === 'running' ? '<button class="btn sm ghost" id="job-cancel">Stop</button>' : `<button class="icon-btn" id="job-close" title="Close" aria-label="Close">${icon('x')}</button>`}</div>
      <div class="bar"><i style="width:${pctDone}%"></i></div>
      <div class="row between muted" style="font-size:12px"><span>${job.done}/${job.total} creators · ${job.failed} ${job.failed === 1 ? 'failure' : 'failures'}</span><span><b style="color:var(--good)">${job.newReels}</b> new reels</span></div>
      ${job.current.length ? `<div class="dim" style="font-size:12px;margin-top:4px">${job.current.map(esc).join(' · ')}</div>` : ''}
      <div class="log">${job.log.slice(-40).reverse().map((l) => `<div>${esc(stripEmoji(l.msg))}</div>`).join('')}</div>`;
    if ($('#job-cancel')) $('#job-cancel').onclick = () => api('/api/job/cancel', { method: 'POST' }).then(() => pollJob(), (e) => toast(e.message, true));
    if ($('#job-close')) $('#job-close').onclick = () => { dismissedJob = job.id; el.classList.add('hidden'); };
  }
  if (lastJobState === 'running' && job && job.state !== 'running') {
    // Finished: refresh the shared data (sidebar, counters), but only repaint the pages that show scan results,
    // and never while the user is watching a reel or typing: that would wipe their input mid-task.
    await loadShared().catch(() => {});
    const cur = currentView();
    const idle = $('#modal').classList.contains('hidden') && !hasUnsavedInput();
    if (cur === 'reels' && !idle) state.reels.stale = true; // keep the visible cards working; reload on the next visit
    else state.reels.items = [];
    if (idle && cur === 'reels') route();
    else if (cur === 'creators') {
      if (idle) route(); else loadCreators().catch(() => {});
    }
  } else if (job?.state === 'running' && location.hash.startsWith('#/creators') && job.done !== pollJob._lastDone) {
    pollJob._lastDone = job.done;
    loadCreators().catch(() => {});
  }
  lastJobState = job?.state || null;
  pollTimer = setTimeout(pollJob, job?.state === 'running' ? 1500 : 15000);
}

// =================================================================================
// STATUS CHIPS (top bar, every page): balances with the days they last, today's spend, what is running
// =================================================================================
async function paintStatus() {
  clearTimeout(paintStatus.t);
  const box = $('#tb-status');
  if (!box) return;
  try {
    const d = await api('/api/status/summary');
    const money = (n, cur = 'USD') => (cur === 'CNY' ? `¥${n.toFixed(2)}` : `$${n.toFixed(2)}`);
    const days = (x) => (x == null ? '' : x < 1 ? ' · less than 1 day' : ` · ~${Math.round(x)} ${Math.round(x) === 1 ? 'day' : 'days'}`);
    const chips = [];
    const bal = (name, b, amount, cur) => {
      if (!b) return;
      if (b.error) { chips.push(`<a class="tb-chip warn" href="#/usage" title="${esc(`Could not read the balance: ${stripEmoji(b.error)}`)}">${name} ?</a>`); return; }
      if (amount == null) return;
      const tip = `${name} balance${b.days != null ? `. At the pace of the last 7 days it lasts ${b.days < 1 ? 'less than 1 day' : `about ${Math.round(b.days)} ${Math.round(b.days) === 1 ? 'day' : 'days'}`}` : ''}${b.low ? `. Below $${d.threshold}: add credits before generating more` : ''}`;
      chips.push(`<a class="tb-chip ${b.low ? 'low' : ''}" href="#/usage" title="${esc(tip)}">${name} ${money(amount, cur)}${days(b.days)}</a>`);
    };
    bal('WaveSpeed', d.wavespeed, d.wavespeed?.usd);
    bal('RunningHub', d.runninghub, d.runninghub?.money, d.runninghub?.currency);
    chips.push(`<a class="tb-chip" href="#/usage" title="${esc(`Spent today${d.today.projects ? ` · ${d.today.projects} new project(s)` : ''}`)}">Today ${money(d.today.spent)}</a>`);
    const running = d.running.projects + d.running.other;
    if (running) chips.push(`<a class="tb-chip run" href="#/projects?view=active" title="${esc(`${d.running.projects} project(s)${d.running.other ? ` and ${d.running.other} Create content, 18+ or face job(s)` : ''} generating or queued`)}"><span class="tb-dot"></span>Running: ${running}</a>`);
    box.innerHTML = chips.join('');
  } catch { /* keep what is on screen; try again later */ }
  paintStatus.t = setTimeout(paintStatus, 60000);
}

// ---- boot ---------------------------------------------------------------------------
P.init({ $, $$, esc, api, fmt, ago, dateTime, ratio, toast, showModal, closeModal, state, loadShared, openModelDialog, COLORS, PF });
Studio.init({ $, $$, esc, api, fmt, ago, dateTime, toast, showModal, closeModal });
Spicy.init({ $, $$, esc, api, fmt, ago, dateTime, toast, showModal, closeModal });
Review.init({ $, $$, esc, api, fmt, ago, dateTime, toast, showModal, closeModal, state, loadShared, PF, shown });
// The read-only demo (Vercel): a thin bar says so, since nothing can be changed or generated there.
api('/api/health').then((d) => { if (d?.demo) { document.body.classList.add('is-demo'); document.body.insertAdjacentHTML('afterbegin', '<div class="demo-bar">Read-only demo · browse everything, nothing can be changed or generated here</div>'); } }).catch(() => {});
Projects.init({ $, $$, esc, api, toast, ago, getWorker, state });
Profiles.init({ $, $$, esc, api, toast, showModal, closeModal });
Approval.init({ $, $$, esc, api, toast, ago, fmt, PF, state });
Scheduled.init({ $, $$, esc, api, toast, PF });
Calendar.init({ $, $$, esc, api, toast, showModal, closeModal, state });
Usage.init({ $, $$, esc, api, toast });
Launch.init({ $, $$, esc, api, toast, fmt, PF, loadShared });
Faces.init({ $, $$, esc, api, toast, showModal, closeModal, state, loadShared });
Carousels.init({ $, $$, esc, api, toast, fmt, ago, state });
Discover.init({ $, $$, esc, api, toast, fmt, ago, PF, state });
Team.init({ $, $$, esc, api, toast, showModal, closeModal, state, loadShared, titles, getWorker, setWorker, currentView, COLORS });
try { await loadShared(); } catch (e) { toast(e.message, true); }
route();
pollJob();
Team.startPresence();
paintStatus();
P.studioBadge();
setInterval(P.studioBadge, 20000);
