// Studio (generation pipeline), Models and Comfy pages.
// Shared helpers are injected from app.js via init().
import { icon, stripEmoji } from './icons.js';
import { mountPublish } from './publish-step.js';

let h; // { $, $$, esc, api, fmt, ago, dateTime, toast, showModal, closeModal, state, loadShared, COLORS, PF, ratio }
export function init(helpers) { h = helpers; }
// Async renders must not paint over a page the user already navigated to.
const on = (view) => new RegExp(`^#/${view}(?:[/?]|$)`).test(location.hash) || (view === 'projects' && !location.hash);
const onReel = (id) => new RegExp(`^#/remake/${id}(?:[?]|$)`).test(location.hash);
// Fields whose content the user is typing: polling must never replace the card that holds them.
const EDITABLE = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=file]), select';
const editingEl = () => { const ae = document.activeElement; return ae && ae.matches?.(EDITABLE) ? ae : null; };

const STAGES = {
  queued: { label: 'Queued', tone: 'run' },
  imaging: { label: 'Generating image', tone: 'run' },
  awaiting_approval: { label: 'Choose image', tone: 'act' },
  animating: { label: 'Generating video', tone: 'run' },
  review: { label: 'Review the video', tone: 'act' },
  approved: { label: 'Ready', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'off' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Canceled', tone: 'off' },
};
const ACTIVE = ['queued', 'imaging', 'animating'];
const MODE_LABEL = { api: 'Comfy API', cloud: 'Comfy Cloud', local: 'Local ComfyUI' };
// The user's own workflows on RunningHub (server/pipeline/rhworkflows.js): video engines and who makes her image.
const RH_ENGINE_NAME = { rh_wan_animate: 'WAN Animate', rh_nb_wan_animate: 'NB WanAnimate', rh_ttt_animator: 'TTT Animator', rh_animate_x: 'Animate X' };
const FRAME_NAME = { flux: 'Flux.2 [pro]', seedream: 'Seedream 5.0 Pro', wan27: 'Wan 2.7 Image', wan27pro: 'Wan 2.7 Image Pro', sky: 'Z-Image SKY', faceswap: 'INSTARAW Faceswap' };
/** Her image made on RunningHub (her own workflows) rather than on WaveSpeed. */
const RH_FRAME = ['sky', 'faceswap'];
/** Image editors on WaveSpeed: price per image with the scene + 3 photos of her (WaveSpeed's prices, 27/09). */
const EDITOR_COST = { flux: 0.06, seedream: 0.054, wan27: 0.03, wan27pro: 0.075 };
const ENL_COST = { flux: 0.06, seedream: 0.045, wan: 0.035, wan27: 0.03, wan27pro: 0.075 }; // one image in: the server's edit price
/** A RunningHub workflow is usable when the key and its workflow id are saved. */
const rhOn = (s, wf) => !!(s.rh_api_key_set && s[`rh_wf_${wf}`]);
/** Options for "Imagem dela": Nano Banana always, her RunningHub workflows when configured. */
const frameOptions = (s) => [
  ['nanopro', 'Nano Banana Pro (Google), as in the reference'], ['nano', 'Nano Banana 2 (Google)'], ['seedream', 'Seedream 5.0 Pro (ByteDance)'], ['flux', 'Flux.2 [pro] (Black Forest Labs)'],
  ['wan27', 'Wan 2.7 Image (Alibaba)'], ['wan27pro', 'Wan 2.7 Image Pro (Alibaba)'],
  ...(rhOn(s, 'sky') ? [['sky', 'Z-Image SKY (your workflow)']] : []), ...(rhOn(s, 'faceswap') ? [['faceswap', 'INSTARAW Faceswap (your workflow)']] : []),
];
/** The first-frame makers as "1.º frame" names them. */
const FIRST_FRAME_NAME = { nanopro: 'Nano Banana Pro', nano: 'Nano Banana 2', wan27: 'Wan 2.7 Image', wan27pro: 'Wan 2.7 Image Pro', seedream: 'Seedream 5.0', flux: 'Flux.2', sky: 'Z-Image SKY (your workflow)', faceswap: 'INSTARAW Faceswap (your workflow)' };
// The engine chosen in Definições, else Nano Banana Pro (the reference's swap, with its own prompt).
const frameDefault = (s) => (s.frame_engine && frameOptions(s).some(([v]) => v === s.frame_engine) ? s.frame_engine : 'nanopro');
const engineLabel = (cfg) => ({
  wan3_copy: `Exact copy (Wan 3.0 ${cfg.wanResolution || ''})${cfg.firstFrame === 'direct' ? ' · direct' : ''}${cfg.keepSound !== false ? ' · original music' : ''}`,
  kling_motion: `Exact copy (Kling Motion ${cfg.klingMode || 'std'})${cfg.keepSound !== false ? ' · original audio' : ''}`,
  wan27_edit: `Swap the person (Wan 2.7 Edit)${cfg.keepSound !== false ? ' · original audio' : ''}`,
  kling_edit: `Swap the person (Kling Omni Edit)${cfg.keepSound !== false ? ' · original audio' : ''}`,
  animate_replace: `Swap the person (Wan 2.2 Animate ${cfg.wanResolution === '480P' ? '480p' : '720p'})${cfg.keepSound !== false ? ' · original audio' : ''}`,
}[cfg.videoEngine] || (RH_ENGINE_NAME[cfg.videoEngine]
  ? `${RH_ENGINE_NAME[cfg.videoEngine]} · RunningHub${FRAME_NAME[cfg.frameEngine] ? ` · image ${FRAME_NAME[cfg.frameEngine]}` : ''}${cfg.keepSound !== false ? ' · original audio' : ''}`
  : FRAME_NAME[cfg.frameEngine] && cfg.videoEngine === 'wan3_copy' && cfg.firstFrame !== 'direct'
    ? `Exact copy (Wan 3.0 ${cfg.wanResolution || ''}) · image ${FRAME_NAME[cfg.frameEngine]}${cfg.keepSound !== false ? ' · original music' : ''}`
  : `Wan 3.0 ${String(cfg.wanMode || '').toUpperCase()} · ${cfg.wanResolution || ''}`));
const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const media = (p) => `/media/${h.esc(p)}`;
const fileSafe = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
const errorState = (e) => `<div class="empty">${icon('alert-circle', { size: 28 })}<h3>This page could not be loaded</h3><p>${h.esc(stripEmoji(e?.message || 'Unknown error'))}</p></div>`;
const warnCallout = (html) => `<div class="callout warn">${icon('alert-triangle')}<div>${html}</div></div>`;
// URLs that end in a real .mp4 name, so the browser always saves e.g. remake_maddy_sophieraiin_4.mp4
export const reelVideoUrl = (r, dl = false) => `/api/reels/${r.reel_id ?? r.id}/video/${fileSafe(r.handle)}_original_${fileSafe(r.external_id || r.reel_id || r.id)}.mp4${dl ? '?download=1' : ''}`;
export const genVideoUrl = (g, dl = false) => `/api/generations/${g.id}/video/remake_${fileSafe((g.model_name || 'modelo').toLowerCase())}_${fileSafe(g.handle)}_${g.id}.mp4${dl ? '?download=1' : ''}`;

// Pipeline status (the WaveSpeed key + balance). The server asks WaveSpeed for the balance (~1 s),
// so pages paint first and fill this in later; a short cache avoids repeating the call on every page.
let stCache = null;
export function pipelineStatus(force = false) {
  if (!force && stCache && Date.now() - stCache.at < 30000) return stCache.p;
  const p = h.api('/api/pipeline/status');
  stCache = { at: Date.now(), p };
  p.catch(() => { if (stCache?.p === p) stCache = null; });
  return p;
}
// Can the remake be started? Decided from saved settings only (the server validates the key on POST).
const keysOk = (s) => !!s.wavespeed_api_key_set; // WaveSpeed: the images, the enlargement and the video

// =================================================================================
// Generate action (used from Reels, Remakes and the reel modal)
// =================================================================================
export async function generateRemake(remakeId, config = {}) {
  try {
    const g = await h.api(`/api/remakes/${remakeId}/generate`, { method: 'POST', body: { config } });
    h.toast(`Project #${g.id} started`);
    studioBadge();
    return g;
  } catch (e) {
    h.toast(e.message, true);
    if (/fotos de referência|reference photos/.test(e.message)) location.hash = '#/models';
    return false;
  }
}

/** The Projetos and Aprovação badges, from the server's counts (each video is counted in one badge only). */
export async function studioBadge() {
  try {
    const s = await h.api('/api/stats');
    for (const [sel, n] of [['#nav-projects', s.projectsTodo], ['#nav-approval', s.approvalPending]]) { const el = h.$(sel); if (el) el.textContent = n || ''; }
  } catch {}
}

// =================================================================================
// STUDIO
// =================================================================================
let studioTimer = null;
let studioSeq = 0;
const studio = { filter: 'all', open: new Set() };
const trimOpen = new Set(); // generation ids whose "Cortar o vídeo" panel is open (kept when a card is rebuilt)
const promptOpen = new Set(); // … and whose "Prompts" panel is open
const VIDEO_NAME = { wan3_copy: 'Wan 3.0', wan3: 'Wan 3.0', kling_motion: 'Kling Motion', wan27_edit: 'Wan 2.7 Edit', kling_edit: 'Kling Omni Edit', animate_replace: 'Wan 2.2 Animate' };
const fmtS = (x) => (Math.round(x * 100) / 100).toFixed(2);

export async function renderStudio(params) {
  clearTimeout(studioTimer);
  if (params.get('gen')) studio.open.add(Number(params.get('gen')));
  h.$('#topbar-actions').innerHTML = '<span class="muted" id="st-spent" style="font-size:12px"></span>';
  h.$('#view').innerHTML = `
    <h2>Studio</h2>
    <p class="sub">Remake pipeline: your model is placed in the reel frame (Nano Banana), quality check, video (Wan 3.0) and review before publishing.</p>
    <div id="st-warn"></div>
    <div class="flow">
      ${['Reel', 'Person swap (Nano Banana)', 'Quality check', 'Wan 3.0', 'Review', 'Publish (coming soon)'].map((s, i) => `<div class="flow-step ${i === 5 ? 'soon' : ''}"><span>${i + 1}</span>${s}</div>`).join(`<div class="flow-arrow">${icon('chevron-right')}</div>`)}
    </div>
    <div class="toolbar">
      <div class="seg" id="st-filter">
        ${[['all', 'All'], ['todo', 'Needs you'], ['active', 'Running'], ['approved', 'Ready'], ['failed', 'Failed']].map(([v, l]) => `<button data-v="${v}" class="${studio.filter === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <span class="grow"></span>
      <a class="btn sm" href="#/remakes">${icon('plus')}Generate from the queue</a>
    </div>
    <div id="gen-list" class="stack"></div>`;
  h.$$('#st-filter button').forEach((b) => (b.onclick = () => { studio.filter = b.dataset.v; h.$$('#st-filter button').forEach((x) => x.classList.toggle('active', x === b)); loadStudio(); }));
  loadStudio();
  // Spend and connection warnings arrive later; the page never waits for them.
  pipelineStatus().then((st) => {
    if (!on('studio') || !st) return;
    const sp = h.$('#st-spent');
    if (sp) sp.innerHTML = `Estimated spend: <b style="color:var(--text)">${usd(st.spentUsd || 0)}</b>`;
    const w = h.$('#st-warn');
    if (w) w.innerHTML = pipelineWarnings(st);
  }).catch(() => {});
}

export function pipelineWarnings(st) {
  if (!st) return '';
  const w = [];
  const c = st.wavespeed || {};
  if (!c.apiKey) w.push('The <b>WaveSpeed API key</b> is missing: it makes the images, the enlargement and the video. <a href="#/setup">Settings → Pipeline</a>.');
  else if (!c.ok) w.push(`Could not confirm the WaveSpeed balance: ${h.esc(stripEmoji(c.error || 'no response'))}.`);
  if (c.balanceUsd != null && c.balanceUsd < (st?.lowThreshold ?? 5)) w.push(`Low WaveSpeed balance: <b>$${c.balanceUsd.toFixed(2)}</b> (below $${(st?.lowThreshold ?? 5).toFixed(2)}). <a href="https://wavespeed.ai/top-up" target="_blank" rel="noopener">Top up</a> before generating more.`);
  return w.length ? `<div class="card warn-card">${w.map((x) => `<div>${icon('alert-triangle')}${x}</div>`).join('')}</div>` : '';
}

async function loadStudio(fromPoll = false) {
  clearTimeout(studioTimer);
  if (!h.$('#gen-list')) return;
  const seq = ++studioSeq;
  const filter = studio.filter;
  const q = { all: '', todo: 'awaiting_approval,review', active: ACTIVE.join(','), approved: 'approved', failed: 'failed,cancelled,rejected' }[filter];
  let rows;
  try { rows = await h.api('/api/generations' + (q ? `?stage=${q}` : '')); }
  catch (e) {
    if (seq !== studioSeq || !on('studio')) return;
    const list = h.$('#gen-list');
    // A failed poll keeps what is on screen and tries again; only a first load shows the error.
    if (list && !list.querySelector('.gen')) list.innerHTML = `<div class="empty">${h.esc(stripEmoji(e.message))}</div>`;
    studioTimer = setTimeout(() => loadStudio(true), 5000);
    return;
  }
  if (seq !== studioSeq || !on('studio')) return;
  const list = h.$('#gen-list');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${icon('film', { size: 28 })}<h3>No generations yet</h3><p>In <a href="#/reels">Reels</a>, open a reel and press Remake, or in <a href="#/remakes">Remakes</a> press “Generate”.</p></div>`;
  } else patchGenList(list, rows, () => loadStudio());
  if (!fromPoll) studioBadge();
  if (rows.some((g) => ACTIVE.includes(g.stage))) studioTimer = setTimeout(() => loadStudio(true), 3000);
}

// A card is rebuilt only when something it shows changed; finished cards (and a video that is playing) stay untouched.
const genSig = (g) => {
  const open = studio.open.has(g.id);
  return [g.kind, g.stage, g.publish, g.step_status, g.updated_at, g.video_path, g.chosen_image, g.candidates.length, JSON.stringify(g.candidates).length,
    g.qa ? 1 : 0, g.busy ? 1 : 0, g.error, g.cost_usd, JSON.stringify({ ...(g.config || {}), videoInfo: undefined }), open ? 1 : 0, open ? g.log.length : ''].join('|');
};

function buildGenCard(g, root, reload) {
  const tpl = document.createElement('template');
  tpl.innerHTML = genCard(g, root?._opts).trim();
  const el = tpl.content.firstElementChild;
  el.dataset.sig = genSig(g);
  bindGenCard(el, g, root, reload);
  return el;
}

/** Keyed update of a list of generation cards (Studio, the remake page and a project in Projetos). */
export function patchGenList(box, rows, reload) {
  box._gens = new Map(rows.map((g) => [g.id, g]));
  [...box.children].forEach((el) => { if (!el.matches('article.gen[data-id]')) el.remove(); });
  const editing = editingEl();
  const els = new Map([...box.children].map((el) => [Number(el.dataset.id), el]));
  els.forEach((el, id) => { if (!box._gens.has(id)) { el.remove(); els.delete(id); } });
  let prev = null;
  for (const g of rows) {
    let el = els.get(g.id);
    if (!el || (el.dataset.sig !== genSig(g) && !(editing && el.contains(editing)))) {
      const fresh = buildGenCard(g, box, reload);
      if (el) {
        // Text typed and not sent yet (the prompts, step 3's prompt, step 4's extras) survives the redraw.
        h.$$('textarea[data-prompt], textarea[data-enl-text], input[data-vx], input[data-vn]', el).forEach((x) => {
          if (x.value === x.defaultValue) return;
          const y = fresh.querySelector(x.dataset.prompt ? `[data-prompt="${x.dataset.prompt}"]` : x.hasAttribute('data-enl-text') ? '[data-enl-text]' : x.hasAttribute('data-vx') ? '[data-vx]' : '[data-vn]');
          if (y && !y.disabled && y.value === y.defaultValue) { y.value = x.value; y.dispatchEvent(new Event('input')); }
        });
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    const want = prev ? prev.nextElementSibling : box.firstElementChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
  }
}

/** What "Refazer imagens" / "Gerar de novo" pays: the swap images of a video project, or the photos and poses of a photo project. */
const redoImagesCost = (g) => { const c = g.config || {}; return g.kind === 'video' ? (c.variants || 2) * swapCost(swapKey(c), c) : (g.kind === 'photo' ? (Array.isArray(c.slides) ? c.slides.length : 1) * (c.variants || 1) * perImageCost(g) : 0) + ((c.poses || []).length + (c.customPose ? 1 : 0)) * COSTS.image(c.nbModel, c.nbResolution); };

/** Price of one more image of the person swap, with the project's own editor. */
const perImageCost = (g) => { const k = g.config?.frameEngine; return EDITOR_COST[k] ?? (g.edit?.engines?.find((x) => x.key === 'nano')?.cost || 0.0835); };

/** "Editar imagem" is offered once the images exist and nothing is running or scheduled on the project. */
const canEditImage = (g, refused) => !!g.edit && !refused && !g.publish && !g.busy && ['awaiting_approval', 'review', 'approved', 'failed'].includes(g.stage);

// =================================================================================
// THE PROJECT IN STEPS (the reference app's page): 1 Origem · 2 Troca · 3 Aumento · 4 Vídeo · 5 Rever · 6 Final · 7 Publicar
// Each step shows what went in, what came out and the one action it waits for. Nothing paid starts by itself unless the
// button says so (with the price): choosing the swap starts the enlargement, "Gerar vídeo" starts the video.
// =================================================================================
export const STEP_NAMES = ['Source', 'Pick the swap', 'Enlargement', 'Video', 'Review the video', 'Final 2× · 60 fps', 'Publish'];
const NB_PRO = 'Nano Banana Pro (Gemini 3 Pro Image)';
const NB_2 = 'Nano Banana 2 (Gemini 3.1 Flash Image)';
const originOpen = new Map(); // generation id → step 1 opened / closed by hand
const EDIT_VIDEO = ['wan27_edit', 'kling_edit']; // these edit the reel itself: no image steps
/** Who makes her images in this project: Nano Banana (2 or Pro, by the project's model), another editor or her workflow. */
const imageMaker = (cfg) => (!cfg.frameEngine || cfg.frameEngine === 'nano' ? (/pro/i.test(cfg.nbModel || '') ? 'Nano Banana Pro' : 'Nano Banana 2') : FIRST_FRAME_NAME[cfg.frameEngine] || FRAME_NAME[cfg.frameEngine] || 'the chosen editor');
/** Under the spinner while a project starts: what is being made NOW (the video waits for step 4, unless Automático). */
const runNote = (cfg) => {
  const video = VIDEO_NAME[cfg.videoEngine] || RH_ENGINE_NAME[cfg.videoEngine] || 'the video';
  if (EDIT_VIDEO.includes(cfg.videoEngine) || (cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct')) return `Preparing the video (${video}), no images`;
  if (cfg.ownImage) return 'Your image: nothing is generated now';
  if (cfg.autoApprove) return `Automatic: first the images with ${imageMaker(cfg)}, then the video (${video})`;
  return `Now: the swap images with ${imageMaker(cfg)}. The video starts only at step 4, when you press “Generate video”.`;
};

/** Which step (1–7) a video project is at; 0 = closed (rejected / cancelled). The list on the left uses the same rule. */
export function videoStep(g) {
  const cfg = g.config || {};
  // On a finished video a new choice reopens step 3 (enlarging) or 4 (a new image waits for "Gerar vídeo").
  const again = cfg.step === 'enlarge' ? 3 : cfg.step === 'pick' ? 2 : cfg.final && g.chosen_image && cfg.final !== g.chosen_image ? 4 : 0;
  if (g.publish) return 7;
  switch (g.stage) {
    case 'queued': return 1;
    case 'imaging': return 2;
    case 'awaiting_approval': return cfg.step === 'video' ? 4 : cfg.step === 'enlarge' ? 3 : 2;
    case 'animating': return 4;
    case 'review': return again || (g.busy && cfg.topazRun ? 6 : 5);
    case 'approved': return again || (g.busy && cfg.topazRun ? 6 : 7);
    case 'failed':
      if (g.video_path) return again || 5;
      if (g.chosen_image) return 4;
      return cfg.step === 'enlarge' ? 3 : cfg.step === 'video' && cfg.final ? 4 : g.candidates?.length ? 2 : 1;
    default: return 0;
  }
}

/** The person-swap engine of a project, as the step 1 select shows it. */
const swapKey = (cfg) => (cfg.frameEngine === 'nano' || !cfg.frameEngine ? (/pro/i.test(cfg.nbModel || '') ? 'nanopro' : 'nano') : cfg.frameEngine);
const swapName = (cfg) => ({ nano: 'Nano Banana 2', nanopro: 'Nano Banana Pro' }[swapKey(cfg)] || FRAME_NAME[cfg.frameEngine] || 'Nano Banana');
const swapCost = (key, cfg) => (key === 'nanopro' ? COSTS.image(NB_PRO, cfg.nbResolution) : key === 'nano' ? COSTS.image(/pro/i.test(cfg.nbModel || '') ? NB_2 : cfg.nbModel || NB_2, cfg.nbResolution) : EDITOR_COST[key] ?? 0.0835);
const TOP_COLOR_PT = [['', "Don't change"], ['black', 'Black'], ['white', 'White'], ['grey', 'Gray'], ['beige', 'Beige'], ['brown', 'Brown'], ['pink', 'Pink'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['light blue', 'Light blue'], ['blue', 'Blue'], ['purple', 'Purple']];

/** Step 4's Wan 2.2 Animate (the open model WaveSpeed runs itself; the reference's "run animate · on pod"). */
const ANIMATE_ENGINES = ['animate_replace'];
/** The video models of step 4 (the reference's "run motion (Wan 3.0 720p)"): model id, resolution, name. */
const VIDEO_MODELS = [['wan3.0-video', '720P', 'Wan 3.0 (Alibaba) · 720p'], ['wan3.0-video', '1080P', 'Wan 3.0 (Alibaba) · 1080p'], ['wan3.0-video-prime', '720P', 'Wan 3.0 Prime (Alibaba) · 720p, more faithful'], ['wan3.0-video-prime', '1080P', 'Wan 3.0 Prime (Alibaba) · 1080p']];

/** Seconds of video and its estimated price for "Gerar vídeo" (same rules as the Remake page). */
function videoEstimate(g) {
  const cfg = g.config || {};
  const reel = Math.round(g.duration || 10);
  const e = cfg.videoEngine;
  if (RH_ENGINE_NAME[e]) return { secs: reel, usd: 0, rh: true };
  if (e === 'kling_motion') return { secs: reel, usd: (cfg.klingMode === 'pro' ? 0.168 : 0.126) * reel };
  if (e === 'animate_replace') { const s = Math.min(ANIMATE.maxSecs, Math.max(1, reel)); return { secs: s, usd: animateUsd(s, cfg.wanResolution) }; }
  if (e === 'kling_edit') return { secs: reel, usd: (cfg.wanResolution === '1080P' ? 0.168 : 0.126) * reel };
  if (e === 'wan27_edit') return { secs: reel, usd: (cfg.wanResolution === '1080P' ? 0.15 : 0.1) * reel * 2 };
  if (e === 'wan3_copy') { const s = Math.min(15, Math.max(2, reel)); return { secs: s, usd: COSTS.video(cfg.wanModel, cfg.wanResolution, s) }; }
  const s = cfg.wanDuration === 'auto' || !cfg.wanDuration ? Math.min(15, Math.max(5, reel)) : Number(cfg.wanDuration);
  return { secs: s, usd: COSTS.video(cfg.wanModel, cfg.wanResolution, s) };
}

function candBadges(g, c, refused) {
  const issues = [].concat(c.qa?.issues || []).map((x) => stripEmoji(String(x)));
  return `${c.uploaded && !refused ? `<span class="badge own-badge" title="Image uploaded by you: not generated">${icon('upload')}Your image</span>` : ''}
    ${c.edited && !c.enlarge && !refused ? `<span class="badge own-badge" title="${h.esc(stripEmoji(`Edited: ${c.edit || ''}`))}">${icon('wand')}Edited</span>` : ''}
    ${refused ? `<span class="badge refused-badge" title="Wan refused this image in its content filter">${icon('ban')}Refused by Wan</span>` : ''}
    ${c.outfitOk === true ? `<span class="badge outfit-badge ok" title="Checked: she is wearing the chosen outfit">${icon('shirt')}Right outfit</span>`
      : c.outfitOk === false ? `<span class="badge outfit-badge bad" title="${h.esc(stripEmoji(c.outfitWorn || ''))}">${icon('alert-triangle')}Different outfit</span>` : ''}
    ${c.qa ? (c.qa.ok ? `<span class="badge qa-badge ok" title="Quality check: face ${c.qa.same ?? '?'}/10, no tattoos, piercings or garbled text">${icon('check')}QA</span>`
      : `<span class="badge qa-badge bad" title="${h.esc(issues.join(' · '))}">${icon('alert-triangle')}${h.esc(issues[0] || 'QA')}</span>`) : ''}`;
}

/** One image tile. kind: 'swap' (step 2) | 'enlarge' (step 3) | 'asis' (step 3, the pick without enlargement). */
function stepTile(g, c, kind, n, { canAct, zoom }) {
  const cfg = g.config || {};
  const refused = (cfg.refusedImages || []).includes(c.path);
  const picked = kind === 'swap' ? cfg.pick === c.path : cfg.final === c.path;
  const animated = g.chosen_image === c.path && g.video_path;
  let acts = '';
  if (refused) acts = '<button class="btn sm" disabled>Refused</button>';
  else if (canAct && kind === 'swap') {
    acts = `${picked ? '<span class="badge fresh">Chosen</span>' : `<button class="btn sm primary" data-pick="${h.esc(c.path)}" title="${c.uploaded || cfg.ownImage ? 'Goes on to the video (step 4)' : 'Goes on to step 3: there you choose the enlargement AI and press Generate. Nothing starts by itself.'}">${icon('arrow-right')}Continue</button>`}
      ${canEditImage(g, refused) && !c.uploaded ? `<button class="btn sm ghost" data-edit-img="${h.esc(c.path)}" title="Changes just one thing in this image (outfit, hair, details, bust). The edited ones appear next to it.">${icon('wand')}Edit</button>` : ''}`;
  } else if (canAct) {
    acts = `<button class="btn sm ${picked ? '' : 'primary'}" data-final="${h.esc(c.path)}">${icon(picked ? 'check' : 'arrow-right')}${picked ? 'Chosen' : 'Continue'}</button>`;
  } else if (picked) acts = '<span class="badge fresh">Chosen</span>';
  return `
    <div class="cand ${picked && !refused ? 'chosen' : ''} ${refused ? 'refused' : ''} ${kind === 'asis' ? 'asis' : ''}">
      <img src="${media(c.path)}" data-zoom-step="${zoom}" loading="lazy" alt="">
      <span class="cand-n">${kind === 'asis' ? 'No enlargement' : n}</span>
      ${candBadges(g, c, refused)}
      ${animated && !picked ? '<span class="badge fresh cand-anim">In the video</span>' : ''}
      ${acts}
    </div>`;
}

const hint = (txt) => `<div class="gs-hint">${icon('info')}${txt}</div>`;

function stepSection(n, state, title, sub, body) {
  return `<section class="gstep ${state}" data-step="${n}" ${state === 'cur' ? 'aria-current="step"' : ''}>
    <div class="gs-head"><span class="gs-n">${state === 'done' ? icon('check') : n}</span><b>${title}</b>${sub ? `<span class="gs-sub">${sub}</span>` : ''}</div>
    ${body ? `<div class="gs-body">${body}</div>` : ''}
  </section>`;
}

/** What "Tentar de novo" redoes on a failed project, and what it costs. */
function retryText(g) {
  const cfg = g.config || {};
  const vid = videoEstimate(g);
  const img = (cfg.variants || 2) * swapCost(swapKey(cfg), cfg);
  // It re-animates the chosen image (also after a failed "Refazer o vídeo"), unless the image step is what failed;
  // Direto and the Edit types go straight to the video.
  const imgFailed = ['queued', 'imaging'].includes(cfg.failedAt);
  const noImage = EDIT_VIDEO.includes(cfg.videoEngine) || (cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct' && !g.candidates.length);
  if ((g.chosen_image && !imgFailed) || noImage) return `Try the video again${vid.rh ? '' : ` · ~${usd(vid.usd)}`}`;
  if (!g.candidates.length) return cfg.autoApprove ? `Try again (images and video, Automatic) · ~${usd(img + vid.usd)}` : `Try again (images) · ~${usd(img)}`;
  return 'Try again';
}

/** The error of a failed project, with the ways out, shown in the step where it stopped. */
function failBox(g) {
  const cfg = g.config || {};
  const err = g.error || '';
  const wanBlocked = /Green net|controlo de conteúdo|filtro automático de conteúdo|DataInspection|content filter of Wan(?! 2\.)|automatic content filter/.test(err);
  const nbBlocked = !wanBlocked && /filtro de segurança|IMAGE_SAFETY|safety filter/.test(err);
  const blocked = wanBlocked || nbBlocked;
  const direct = cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct';
  const vid = videoEstimate(g);
  const vidP = vid.rh ? '' : ` · ~${usd(vid.usd)}`;
  const imgP = ` · ~${usd(redoImagesCost(g))}`;
  const animP = ` · ~${usd(animateUsd(g.duration || 10, cfg.wanResolution))}`;
  return `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(err || 'Error'))}</div>
    <div class="row">
      ${wanBlocked && g.wsReady && cfg.videoEngine !== 'animate_replace' && g.chosen_image ? `<button class="btn primary sm" data-act="animate-fal" title="The open model, on WaveSpeed: uses this image and swaps only the person in the original video, without going through Alibaba">${icon('user-check')}Make it with Wan 2.2 Animate${animP}</button>` : ''}
      <button class="btn ${wanBlocked ? '' : 'primary '}sm" data-act="${nbBlocked ? 'redo-images' : 'retry'}">${icon('refresh')}${nbBlocked ? `Try again (images)${imgP}` : retryText(g)}</button>
      ${blocked && !cfg.ownImage ? `<button class="btn sm" data-act="redo-covered" title="${cfg.outfitId ? 'Stops using the chosen garment and asks for a more covered version of the outfit in the video' : 'Asks for a version of the outfit in the video with a higher neckline'}">${icon('shirt')}${cfg.outfitId ? 'Redo without the chosen outfit' : 'Redo with a higher neckline'}${direct ? vidP : imgP}</button>` : ''}
      ${g.candidates.length && !nbBlocked && !cfg.ownImage ? `<button class="btn sm" data-act="redo-images">Redo images${imgP}</button>` : ''}
      ${blocked && cfg.videoEngine === 'wan3_copy' && !direct ? `<button class="btn sm" data-act="redo-direct" title="Her photos go straight to Wan 3.0, without going through the frame image">Try in Direct mode${vidP}</button>` : ''}
    </div>
    ${wanBlocked ? '<div class="dim gs-note">The refusal comes from the Alibaba filter (Alibaba makes Wan): Wan 3.0 is a closed model, so every site, WaveSpeed included, sends it to Alibaba. Wan 2.2 Animate is the open model that WaveSpeed runs on its own servers, without that filter.</div>' : ''}`;
}

function genStepsCard(g, view = null) {
  const cfg = g.config || {};
  const open = studio.open.has(g.id);
  const s = STAGES[g.stage] || { label: g.stage, tone: 'off' };
  const cur = videoStep(g);
  const running = ACTIVE.includes(g.stage);
  const busy = !!g.busy;
  const locked = !!g.publish;
  const failedHere = g.stage === 'failed' ? cur : 0;
  const state = (n) => (cur === 0 ? '' : n < cur ? 'done' : n === cur ? (failedHere === n ? 'fail' : 'cur') : 'todo');
  const noImage = EDIT_VIDEO.includes(cfg.videoEngine) || (cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct' && !g.candidates.length);
  const canAct = !running && !busy && !locked && ['awaiting_approval', 'failed', 'cancelled', 'review', 'approved'].includes(g.stage);
  const scene = cfg.sceneUsed || g.frame_path || null;
  const refs = cfg.refsUsed || [];
  const pe = g.promptEdited || {};
  const enl = g.enlarge || null;
  const rhFrame = RH_FRAME.includes(cfg.frameEngine);

  // ---- 1 · Origem ----------------------------------------------------------------------------------------------
  const inputs = `<div class="gp-inputs">
      ${scene ? `<figure><img src="${media(scene)}" data-zoom-src="${media(scene)}" alt=""><figcaption>video frame</figcaption></figure>` : ''}
      ${refs.map((p, i) => `<figure><img src="${media(p)}" data-zoom-src="${media(p)}" alt=""><figcaption>her photo ${i + 1}</figcaption></figure>`).join('')}
      ${!scene && !refs.length ? '<span class="dim" style="font-size:12.5px">The frame and the photos appear here once the image is generated.</span>' : ''}</div>`;
  const opts = cfg.swapOptions || {};
  const sk = swapKey(cfg);
  const nOpts = [1, 2, 3, 4, 6, 8];
  const wantN = cfg.variants || 2;
  const origin = noImage
    ? hint('This video type edits the reel directly: there is no image to swap or to enlarge.')
    : cfg.ownImage ? hint('Your image: uploaded by you, no image is generated.')
    : `${inputs}
      ${rhFrame ? hint(`The image is made by your ${h.esc(FRAME_NAME[cfg.frameEngine] || '')} workflow on RunningHub: it does not use a text prompt from here.`) : `
      <div class="field"><div class="row between"><label for="gs-img-${g.id}">Swap prompt · ${h.esc(swapName(cfg))} <span class="ed-tag">${pe.image ? 'edited' : 'default'}</span></label>${pe.image && !locked ? '<button type="button" class="link-btn" data-act="reset-image-prompt">Reset to default</button>' : ''}</div>
        <textarea class="input" rows="6" id="gs-img-${g.id}" data-prompt="image_prompt" ${locked ? 'disabled' : ''} placeholder="The prompt appears here after the first generation.">${h.esc(g.image_prompt || '')}</textarea>
        <small>${pe.image ? 'Edited by you: it goes as it is (the options below do not change the text).' : 'Made by the app from her photos, the frame and the options below. If you edit it, it goes exactly as you write it.'}</small></div>
      <div class="gs-opts">
        <label class="check"><input type="checkbox" data-swapopt="noHairclips" ${opts.noHairclips ? 'checked' : ''} ${locked ? 'disabled' : ''}>No hair clips</label>
        <label class="check"><input type="checkbox" data-swapopt="noTattoos" ${opts.noTattoos ? 'checked' : ''} ${locked ? 'disabled' : ''}>No tattoos</label>
        <label class="field inline"><span>Top color</span><select class="input" data-swapopt="topColor" ${locked ? 'disabled' : ''}>${TOP_COLOR_PT.map(([v, l]) => `<option value="${v}" ${(opts.topColor || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="gs-run">
        <label class="field inline"><span>Engine</span><select class="input" data-swap-engine ${locked ? 'disabled' : ''}>${[['nanopro', 'Nano Banana Pro'], ['nano', 'Nano Banana 2'], ['seedream', 'Seedream 5.0 Pro'], ['flux', 'Flux.2 [pro]'], ['wan27', 'Wan 2.7 Image'], ['wan27pro', 'Wan 2.7 Image Pro']].map(([v, l]) => `<option value="${v}" ${sk === v ? 'selected' : ''}>${l} · ${usd(swapCost(v, cfg))}</option>`).join('')}</select></label>
        <label class="field inline"><span>Images</span><select class="input" data-swap-n ${locked ? 'disabled' : ''}>${nOpts.map((k) => `<option ${k === wantN ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        ${!locked && !running && !busy ? `<button class="btn sm primary" data-act="swap-go">${icon('refresh')}Generate</button>` : ''}
        ${!locked ? '<button class="btn sm ghost" data-act="save-prompts" title="Saves the prompt and the options without generating anything">Save</button>' : ''}
      </div>`}`;
  const s1Open = originOpen.has(g.id) ? originOpen.get(g.id) : cur <= 1 || (cur === 2 && !g.candidates.length);
  const s1Sub = noImage ? 'no image' : cfg.ownImage ? 'your image' : `${scene ? 'video frame' : 'no frame'} + ${refs.length || '…'} of her photos · ${h.esc(swapName(cfg))} · ${pe.image ? 'edited' : 'default'} prompt`;
  const step1 = `<details class="gstep ${state(1)}" data-step="1" data-origin ${s1Open ? 'open' : ''}>
      <summary class="gs-head"><span class="gs-n">${state(1) === 'done' ? icon('check') : 1}</span><b>Source</b><span class="gs-sub">${s1Sub}</span><span class="pp-chev">${icon('chevron-down')}</span></summary>
      <div class="gs-body">${origin}${failedHere === 1 ? failBox(g) : ''}</div>
    </details>`;

  // ---- 2 · Escolher a troca --------------------------------------------------------------------------------------
  const swaps = g.candidates.filter((c) => !c.enlarge);
  let body2 = '';
  if (noImage) body2 = hint('Does not apply to this video type.');
  else if (!swaps.length) body2 = g.stage === 'imaging' || g.stage === 'queued' ? '' : hint('The images appear here.');
  else {
    body2 = `<div class="gs-row">
        ${scene ? `<figure class="gs-src"><img src="${media(scene)}" data-zoom-src="${media(scene)}" alt=""><figcaption>Video frame</figcaption></figure>` : ''}
        <div class="cands">${swaps.map((c, i) => stepTile(g, c, 'swap', i + 1, { canAct, zoom: `2:${i}` })).join('')}
          ${canAct && !cfg.ownImage && g.edit ? `<div class="cand more"><span>${icon('plus')}Don't like them? More from this frame</span><button class="btn sm" data-act="more-4">+4 · ~${usd(4 * perImageCost(g))}</button><button class="btn sm" data-act="more-8">+8 · ~${usd(8 * perImageCost(g))}</button></div>` : ''}
        </div></div>
      ${cur === 2 && canAct && !cfg.ownImage ? hint('Choose an image and press “Continue”. At step 3 you choose the enlargement AI and press “Generate”, or go on without enlargement. Nothing starts by itself.') : ''}`;
  }
  if (failedHere === 2) body2 += failBox(g);
  const step2 = stepSection(2, noImage ? 'skip' : state(2), 'Pick the swap', noImage ? '' : `${h.esc(swapName(cfg))}${swaps.length ? ` · ${swaps.length} image(s)` : ''}`, body2);

  // ---- 3 · Aumento -----------------------------------------------------------------------------------------------
  const pick = cfg.pick && g.candidates.find((c) => c.path === cfg.pick);
  const enlarged = pick ? g.candidates.filter((c) => c.enlarge && c.editOf === pick.path) : [];
  const enlarging = busy && !!cfg.enlargeRun;
  let body3 = '';
  if (noImage || cfg.ownImage) body3 = hint(noImage ? 'Does not apply to this video type.' : 'Your image is not edited.');
  else if (!pick) body3 = hint('Choose an image at step 2.');
  else {
    const e = enl || { prompt: '', engine: 'seedream', n: 2, edited: false, defaultPrompt: '' };
    const presets = g.edit?.presets || [];
    const presetKey = presets.find((p) => p.text.trim() === e.prompt.trim())?.key || '';
    const engines = g.edit?.engines || [];
    const tiles = [stepTile(g, pick, 'asis', 0, { canAct, zoom: '3:0' }), ...enlarged.map((c, i) => stepTile(g, c, 'enlarge', i + 1, { canAct, zoom: `3:${i + 1}` }))];
    if (enlarging) tiles.push(`<div class="cand more busy"><span class="spinner"></span><span>${h.esc(stripEmoji(g.step_status || 'Enlarging…'))}</span></div>`);
    body3 = `<div class="gs-row">
        <figure class="gs-src"><img src="${media(pick.path)}" data-zoom-src="${media(pick.path)}" alt=""><figcaption>Your pick</figcaption></figure>
        <div class="cands">${tiles.join('')}</div></div>
      ${cfg.enlargeError && !enlarging ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(cfg.enlargeError))}</div>` : ''}
      ${cfg.enlargeRun && !busy && !enlarged.length && !cfg.enlargeError ? hint('The enlargement was interrupted (the app restarted). Press “Generate” again.') : ''}
      ${cur === 3 && canAct && !enlarged.length && !enlarging && !cfg.enlargeRun ? hint('Choose the enlargement AI (Engine) and how many images, and press “Generate”. Or press “Continue” on the “No enlargement” image to use it as it is.') : ''}
      <div class="gs-prompt">
        <div class="row between" style="gap:8px"><label for="gs-enl-${g.id}">Enlargement prompt · ${h.esc(editName(e.engine))}</label>
          <span class="row" style="gap:6px"><select class="input sm" data-enl-preset aria-label="Preset prompt" ${locked ? 'disabled' : ''}>${presets.map((p) => `<option value="${h.esc(p.key)}" ${p.key === presetKey ? 'selected' : ''}>${h.esc(p.label)}</option>`).join('')}<option value="" ${presetKey ? '' : 'selected'}>Custom</option></select>
          <span class="ed-tag" data-enl-tag>${e.edited ? 'edited' : 'default'}</span>${!locked ? `<button type="button" class="link-btn" data-act="enl-reset" ${e.edited ? '' : 'hidden'}>Reset to default</button>` : ''}</span></div>
        <textarea class="input" rows="2" id="gs-enl-${g.id}" data-enl-text maxlength="1500" ${locked ? 'disabled' : ''}>${h.esc(e.prompt)}</textarea>
        <div class="gs-run">
          <label class="field inline"><span>Engine</span><select class="input" data-enl-engine ${locked ? 'disabled' : ''}>${engines.map((x) => `<option value="${h.esc(x.key)}" ${x.key === e.engine ? 'selected' : ''}>${h.esc(x.label)} · ${usd(x.cost)}</option>`).join('')}</select></label>
          <label class="field inline"><span>Images</span><select class="input" data-enl-n ${locked ? 'disabled' : ''}>${[1, 2, 3, 4].map((k) => `<option ${k === e.n ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
          ${canAct ? `<button class="btn sm primary" data-act="enl-go">${icon('wand')}<span data-enl-label>Generate · ~${usd(e.n * editUnit(g, e.engine))}</span></button>
            ${enlarged.length ? `<span class="dim" style="font-size:12.5px">Don't like them?</span><button class="btn sm" data-act="enl-more" data-more="2">+2 · ~${usd(2 * editUnit(g, e.engine))}</button><button class="btn sm" data-act="enl-more" data-more="4">+4 · ~${usd(4 * editUnit(g, e.engine))}</button>` : ''}` : ''}
        </div>
        <small>The default comes from the model (Profiles → Edit image). The outfit always stays on. Only the chosen image goes to the editor.</small>
      </div>
      ${cur === 3 && canAct && enlarged.length ? hint('Choose the image for the video and press “Continue” (“No enlargement” uses the image as it is).') : ''}`;
  }
  const step3Skip = noImage || cfg.ownImage;
  const step3 = stepSection(3, step3Skip ? 'skip' : state(3), 'Enlargement', step3Skip ? '' : enlarging ? 'enlarging…' : cfg.skipEnlarge && cfg.final ? 'skipped' : enlarged.length ? `${enlarged.length} image(s)` : '', body3 + (failedHere === 3 ? failBox(g) : ''));

  // ---- 4 · Vídeo ---------------------------------------------------------------------------------------------------
  const finalImg = cfg.final && g.candidates.find((c) => c.path === cfg.final);
  const vidName = VIDEO_NAME[cfg.videoEngine] || RH_ENGINE_NAME[cfg.videoEngine] || 'Wan 3.0';
  const vidCopies = !!RH_ENGINE_NAME[cfg.videoEngine] || cfg.videoEngine === 'animate_replace';
  const vidIgnored = vidCopies || ['kling_motion', ...EDIT_VIDEO].includes(cfg.videoEngine); // these do not take the extras
  const vidLock = locked || g.stage === 'animating'; // a running video is found again after a restart by its prompt and extras
  const wanVid = ['wan3', 'wan3_copy', ...ANIMATE_ENGINES].includes(cfg.videoEngine); // the video model is chosen here
  const est = videoEstimate(g);
  const w3s = ['wan3', 'wan3_copy'].includes(cfg.videoEngine) ? est.secs : Math.min(15, Math.max(2, Math.round(g.duration || 10))); // Wan 3.0 copies at most 15 s
  const animUsd = animateUsd(g.duration || 10, cfg.wanResolution);
  const vOpts = [
    ...VIDEO_MODELS.map(([m, r, l]) => ({ v: `${m}|${r}`, l: `${l} · ~${usd(COSTS.video(m, r, w3s))}`, usd: COSTS.video(m, r, w3s), on: true, sel: !ANIMATE_ENGINES.includes(cfg.videoEngine) && m === cfg.wanModel && r === cfg.wanResolution })),
    { v: 'engine:animate_replace', l: `Wan 2.2 Animate · open model, no Alibaba filter · ~${usd(animUsd)}`, usd: animUsd, on: !!g.wsReady, sel: cfg.videoEngine === 'animate_replace' },
  ];
  const readyImg = noImage || !!finalImg;
  const again = g.video_path && (noImage || (finalImg && g.chosen_image === finalImg.path));
  let body4;
  if (!readyImg) body4 = hint('Choose the video image at step 3 (“Continue”) to enable this step. Then you choose the model and press “Generate”.');
  else {
    body4 = `<div class="gs-row">
        ${finalImg ? `<figure class="gs-src"><img src="${media(finalImg.path)}" data-zoom-src="${media(finalImg.path)}" alt=""><figcaption>${finalImg.enlarge ? 'Enlarged' : 'Video image'}</figcaption></figure>` : ''}
        <div class="stack gs-vid">
          ${wanVid ? `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end"><label class="field inline"><span>Model</span><select class="input" data-vmodel ${vidLock ? 'disabled' : ''}>${vOpts.map((o) => `<option value="${o.v}" data-usd="${o.usd}" ${o.rh ? 'data-rh' : ''} ${o.sel ? 'selected' : ''} ${o.on ? '' : 'disabled'}>${h.esc(o.l)}</option>`).join('')}</select></label>
            <span class="dim" style="font-size:12.5px">copies the motion of the reel with the image beside it · ${cfg.keepSound !== false ? 'original music' : 'generated audio'} · ~${est.secs} s</span></div>`
            : `<div class="dim" style="font-size:12.5px">${h.esc(engineLabel(cfg))} · ${est.rh ? 'paid by GPU time on RunningHub' : `~${est.secs} s · ~${usd(est.usd)}`}</div>`}
          ${vidIgnored ? hint(vidCopies ? `${h.esc(vidName)} does not use text: it copies the motion of the reel.` : `${h.esc(vidName)} does not use the text extras.`) : `
          <label class="field"><span>Positive extra <small class="dim">(optional · added to the video prompt, does not replace it)</small></span>
            <input class="input" data-vx value="${h.esc(cfg.videoExtra || '')}" maxlength="1000" placeholder="e.g. natural light, camera slowly moving closer" ${vidLock ? 'disabled' : ''}></label>
          <label class="field"><span>Negative extra <small class="dim">(optional · what must not appear)</small></span>
            <input class="input" data-vn value="${h.esc(cfg.videoNegative || '')}" maxlength="500" placeholder="e.g. extra hands, deformed face, watermark" ${vidLock ? 'disabled' : ''}></label>`}
          ${canAct ? `<div class="row"><button class="btn primary" data-act="video-go">${icon('film')}Generate<span data-vprice>${est.rh ? '' : ` · ~${usd(est.usd)}`}</span></button></div>` : ''}
          ${g.stage === 'animating' ? `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(g.step_status || 'Generating the video…'))}</b></div></div>` : ''}
        </div></div>`;
  }
  const step4 = stepSection(4, state(4), 'Video', h.esc(vidName), body4 + (failedHere === 4 ? failBox(g) : ''));

  // ---- 5 · Rever o vídeo -------------------------------------------------------------------------------------------
  let body5 = '';
  if (g.video_path) {
    const qaIssues = [].concat(g.qa?.issues || []).map((x) => stripEmoji(String(x)));
    body5 = `<div class="compare">
        <div><div class="label">Original</div><video src="${reelVideoUrl(g)}" muted loop playsinline controls preload="none" poster="${g.thumb_path ? media(g.thumb_path) : ''}"></video></div>
        <div><div class="label">Remake · ${h.esc(g.model_name || '')}</div><video src="${genVideoUrl(g)}" loop playsinline controls preload="none" poster="${g.chosen_image ? media(g.chosen_image) : g.frame_path ? media(g.frame_path) : ''}"></video></div>
      </div>
      ${g.qa ? `<div class="qa-box ${g.qa.ok ? 'ok' : 'bad'}">${g.qa.ok
        ? `${icon('check-circle')}<b>Video quality check:</b> it is ${h.esc(g.model_name || 'the model')} in every checked frame (face ${g.qa.same ?? '?'}/10 at worst), no tattoos, piercings or garbled text${g.qa.outfit ? ', outfit confirmed' : ''}.`
        : `${icon('alert-triangle')}<b>Video quality check, review before approving:</b><ul>${qaIssues.map((x) => `<li>${h.esc(x)}</li>`).join('')}</ul>`}</div>` : ''}
      ${['review', 'approved'].includes(g.stage) && !locked ? trimPanel(g) : ''}
      <div class="row" style="margin-top:10px">
        ${g.stage === 'review' && canAct ? `<button class="btn" data-act="redo-video">${icon('refresh')}Redo video${est.rh ? '' : ` · ~${usd(est.usd)}`}</button><button class="btn ghost danger" data-act="reject">Reject</button>` : ''}
        ${['cancelled', 'rejected'].includes(g.stage) || (g.stage === 'failed' && g.video_path) ? `<button class="btn" data-act="back-to-review">${icon('rotate-ccw')}Back to review</button>` : ''}
        <a class="btn ghost" href="${genVideoUrl(g, true)}" download>${icon('download')}Download MP4</a>
      </div>`;
  } else body5 = cur < 5 ? '' : hint('No video yet.');
  const step5 = stepSection(5, state(5), 'Review the video', g.qa ? (g.qa.ok ? 'quality check OK' : 'review the warnings') : '', body5 + (failedHere === 5 ? failBox(g) : ''));

  // ---- 6 · Final 2× + 60 fps (WaveSpeed: upscaler + frame rate) ----------------------------------------------------
  const st6 = cfg.upscaled ? 'done' : busy && cfg.topazRun ? 'cur' : g.video_path ? 'opt' : 'todo';
  const step6 = stepSection(6, st6, 'Final 2× · 60 fps', cfg.upscaled ? h.esc(`${cfg.upscaled.size} · ${cfg.upscaled.fps} fps`) : 'optional', g.video_path ? topazBody(g, canAct) : '');

  // ---- 7 · Publicar ------------------------------------------------------------------------------------------------
  let body7 = '';
  if (locked) body7 = `<div class="row"><span class="status ok">${icon('send')}Scheduled${g.publish === 'trial' ? ' (Trial)' : ''}</span><span class="dim" style="font-size:12.5px">The posts are below. To change the image or the video, undo the scheduling in Approval.</span></div>`;
  else if (['review', 'approved'].includes(g.stage) && g.video_path) {
    // The reference's "post" step: her accounts, a caption, the time and the day grid, right here (same rules as Aprovação).
    body7 = `<div data-publish></div>${g.stage === 'review' ? `<div class="row"><button class="btn sm ghost" data-act="approve" title="Approves without scheduling: it stays in Ready">${icon('check')}Just approve, schedule later</button></div>` : ''}`;
  }
  const step7 = stepSection(7, state(7), 'Publish', locked ? 'scheduled' : g.stage === 'approved' ? 'approved' : '', body7);

  return `
  <article class="gen card gen-steps" data-id="${g.id}">
    <div class="gen-head">
      <div class="gen-src" style="${g.frame_path || g.thumb_path ? `background-image:url('${media(g.frame_path || g.thumb_path)}')` : ''}"></div>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:8px">
          <span class="stage ${s.tone}">${cur ? `Step ${cur} · ` : ''}${h.esc(stepLabel(g, cur, s))}</span>
          ${g.model_name ? `<span class="avatar-letter" style="--c:${h.esc(g.model_color || '#b15cff')};width:22px;height:22px;font-size:10px">${h.esc(g.model_name[0])}</span><b>${h.esc(g.model_name)}</b>` : ''}
          <span class="dim">remake of <span class="pf ${g.platform}">${h.PF[g.platform]}</span> @${h.esc(g.handle)} · ${h.fmt(g.views)} views</span>
        </div>
        <div class="dim" style="font-size:12px;margin-top:3px">#${g.id} · ${h.dateTime(g.created_at)} · ${usd(g.cost_usd || 0)}${cfg.autoApprove ? ' · Automatic' : ''}${g.instructions ? ` · “${h.esc(g.instructions.slice(0, 90))}”` : ''}</div>
      </div>
      <button class="btn sm ghost" data-act="toggle">${open ? 'Less' : 'Details'}</button>
      <button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>
    </div>
    ${running && g.stage !== 'animating' ? `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(g.step_status || 'Processing…'))}</b><div class="dim" style="font-size:12px">${h.esc(runNote(cfg))}</div></div><button class="btn sm ghost danger" data-act="cancel">Cancel</button></div>` : ''}
    ${g.stage === 'animating' ? '<div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn sm ghost danger" data-act="cancel">Cancel the video</button></div>' : ''}
    ${locked ? `<div class="dim gen-locked">${icon('lock')}Scheduled: to change the image or the video, undo the scheduling in Approval.</div>` : ''}
    <div class="gsteps">${view?.hideOrigin ? (failedHere === 1 ? stepSection(1, 'fail', 'Source', 'failed', failBox(g)) : '') : step1}${step2}${step3}${step4}${step5}${step6}${step7}</div>
    ${open ? genDetails(g) : ''}
  </article>`;
}

/** The word on the card and in the list for where the project is. */
export function stepLabel(g, cur, s = STAGES[g.stage] || { label: g.stage }) {
  if (g.stage === 'failed') return s.label;
  if (g.publish) return g.publish === 'trial' ? 'Scheduled (Trial)' : 'Scheduled';
  if (g.busy && g.config?.enlargeRun) return 'Enlarging';
  if (g.busy && g.config?.topazRun) return 'Enhancing the video';
  return { 1: g.stage === 'queued' ? 'Queued' : 'Source', 2: g.stage === 'imaging' ? 'Generating images' : 'Pick the swap', 3: 'Choose the enlargement', 4: g.stage === 'animating' ? 'Generating video' : 'Generate the video', 5: 'Review the video', 6: 'Final', 7: g.stage === 'approved' ? 'Ready to publish' : 'Publish' }[cur] || s.label;
}

const editName = (k) => ({ nano: 'Nano Banana', seedream: 'Seedream 5.0 Pro', flux: 'Flux.2 [pro]', wan: 'Wan 2.5', wan27: 'Wan 2.7 Image', wan27pro: 'Wan 2.7 Image Pro' }[k] || k);
const editUnit = (g, k) => g.edit?.engines?.find((x) => x.key === k)?.cost || 0.045;
/** What "Escolher" pays right away: the enlargement of that image, unless it is her own upload or already has one. */
const pickEnlargeUsd = (g, c) => (!c.uploaded && !g.config?.ownImage && g.enlarge && !g.candidates.some((x) => x.enlarge && x.editOf === c.path) ? g.enlarge.n * editUnit(g, g.enlarge.engine) : 0);

/** Step 6: the price comes from the video's frames (read when the step is shown); the run goes on in the background. */
function topazBody(g, canAct) {
  const cfg = g.config || {};
  const u = cfg.upscaled;
  if (u) {
    return `<div class="row"><span class="status ok">${icon('check')}Final ${h.esc(u.size)} · ${u.fps} fps</span>${canAct ? '<button class="btn sm ghost" data-act="topaz-undo">Undo</button>' : ''}</div>
      <div class="dim gs-note">The video in step 5 is already the final one: download it or schedule it at step 7.</div>`;
  }
  if (g.busy && cfg.topazRun) {
    return `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(g.step_status || 'Enhancing the video…'))}</b><div class="dim" style="font-size:12px">You can move on to another project: it keeps going by itself.</div></div></div>`;
  }
  const pending = cfg.topazRun?.uploaded; // jobs already at WaveSpeed (paid there)
  return `${cfg.topazError ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(cfg.topazError))}</div>` : ''}
    ${pending && !cfg.topazError ? hint('The final was interrupted. “Resume” continues with what is already on WaveSpeed, without paying again.') : ''}
    <div class="row">${canAct && ['review', 'approved'].includes(g.stage) ? (pending ? `<button class="btn sm primary" data-act="topaz-resume">${icon('refresh')}Resume (without paying again)</button>` : `<button class="btn sm" data-act="topaz-go" data-topaz disabled>${icon('zoom-in')}<span>Generate · working out the price…</span></button>`) : ''}
      <span class="dim gs-note">Twice the resolution and 60 fps, on WaveSpeed (upscaler + more frames; WaveSpeed does not have Topaz). Optional: the video in step 5 can already be published.</span></div>`;
}

export function genCard(g, opts = null) {
  const s = STAGES[g.stage] || { label: g.stage, tone: 'off' };
  if (g.kind === 'photo' || g.kind === 'poses') return photoGenCard(g, s, studio.open.has(g.id));
  return genStepsCard(g, opts); // opts.hideOrigin: the Remake page is step 1 itself
}

function genDetails(g) {
  const a = g.analysis;
  return `<div class="gen-details">
    ${a ? `<div><div class="label">Reel analysis</div>
      <div class="kv-list">${[['Format', a.format], ['Hook', a.hook], ['Setting', a.setting], ['Lighting', a.lighting], ['Camera', a.camera], ['Outfit', a.outfit], ['Audio', a.audio], ['Why it works', a.why_it_works]]
        .filter(([, v]) => v).map(([k, v]) => `<div><span>${k}</span>${h.esc(stripEmoji(v))}</div>`).join('')}
        ${Array.isArray(a.timeline) && a.timeline.length ? `<div><span>Timeline</span>${a.timeline.map((t) => `${h.esc(t.t)}: ${h.esc(t.action)}`).join('<br>')}</div>` : ''}</div></div>` : ''}
    ${g.publish ? '' : `<div class="row">${g.config?.ownImage ? '' : `<button class="btn sm" data-act="redo-images">${icon('refresh')}Redo images · ~${usd(redoImagesCost(g))}</button>`}${g.chosen_image ? `<button class="btn sm" data-act="redo-video">${icon('refresh')}Redo video${videoEstimate(g).rh ? '' : ` · ~${usd(videoEstimate(g).usd)}`}</button>` : ''}</div>`}
    <div class="label">Configuration</div><pre class="out">${h.esc(JSON.stringify(g.config, null, 2))}</pre>
    <div class="label">Log</div><div class="gen-log">${g.log.slice().reverse().map((l) => `<div><span class="dim">${new Date(l.at * 1000).toLocaleTimeString('en-GB')}</span> ${h.esc(stripEmoji(l.msg))}</div>`).join('')}</div>
  </div>`;
}

// ---- Cortar o vídeo (optional): start/end of the finished video, cut on the server from the whole video ----
function trimPanel(g) {
  const t = g.config?.trim;
  const open = trimOpen.has(g.id);
  return `<details class="pp trim" data-trim ${open ? 'open' : ''}>
    <summary>${icon('scissors')}<b>Trim the video</b><span class="dim pp-sum">optional · removes seconds from the start or the end</span>${t ? `<span class="status ok">Trimmed: ${fmtS(t.start)} s to ${fmtS(t.end)} s</span>` : ''}<span class="pp-chev">${icon('chevron-down')}</span></summary>
    <div class="trim-body">${open ? trimInner(g) : ''}</div>
  </details>`;
}

const trimInner = (g) => `
  <video class="trim-video" src="/api/projects/${g.id}/source-video?v=${encodeURIComponent(g.config?.untrimmedVideo || g.video_path || '')}" preload="metadata" playsinline controls muted></video>
  <div class="trim-bar"><div class="trim-sel"></div>
    <input type="range" class="trim-a" min="0" max="1" step="0.01" value="0" aria-label="Trim start (seconds)" disabled>
    <input type="range" class="trim-b" min="0" max="1" step="0.01" value="1" aria-label="Trim end (seconds)" disabled>
  </div>
  <div class="trim-info"><span>Start <b data-t="a">…</b></span><span>Keeps <b data-t="len">…</b></span><span>End <b data-t="b">…</b></span></div>
  <div class="row">
    <button class="btn sm primary" data-trim-apply disabled>${icon('scissors')}Apply trim</button>
    ${g.config?.trim ? `<button class="btn sm" data-trim-reset>${icon('rotate-ccw')}Restore the whole video</button>` : ''}
    <button class="btn sm ghost" data-frame-save title="Downloads the frame shown in the player above as a PNG">${icon('camera')}Save this frame</button>
  </div>`;

function bindTrim(card, g, reload) {
  const det = card.querySelector('[data-trim]');
  if (!det) return;
  const MIN = 0.5; // shortest cut the server accepts
  const mount = () => {
    const body = det.querySelector('.trim-body');
    if (!body.firstElementChild) body.innerHTML = trimInner(g);
    const v = body.querySelector('.trim-video');
    const a = body.querySelector('.trim-a');
    const b = body.querySelector('.trim-b');
    const sel = body.querySelector('.trim-sel');
    const apply = body.querySelector('[data-trim-apply]');
    let dur = 0;
    const paint = () => {
      if (!dur) return;
      const A = Number(a.value); const B = Number(b.value);
      sel.style.left = `${(A / dur) * 100}%`;
      sel.style.width = `${((B - A) / dur) * 100}%`;
      body.querySelector('[data-t="a"]').textContent = `${fmtS(A)} s`;
      body.querySelector('[data-t="b"]').textContent = `${fmtS(B)} s`;
      body.querySelector('[data-t="len"]').textContent = `${fmtS(B - A)} s of ${fmtS(dur)} s`;
      const t = g.config?.trim;
      apply.disabled = t ? Math.abs(A - t.start) < 0.01 && Math.abs(B - t.end) < 0.01 : A < 0.05 && B > dur - 0.05;
    };
    const ready = () => {
      if (!Number.isFinite(v.duration) || !v.duration) return;
      dur = v.duration;
      for (const r of [a, b]) { r.max = dur.toFixed(2); r.disabled = false; }
      const t = g.config?.trim;
      a.value = t ? t.start : 0;
      b.value = t ? Math.min(t.end, dur) : dur;
      v.currentTime = Math.max(0.01, Number(a.value)); // shows the first kept frame instead of a black box
      paint();
    };
    if (v.readyState >= 1) ready(); else v.addEventListener('loadedmetadata', ready, { once: true });
    a.oninput = () => { if (Number(a.value) > Number(b.value) - MIN) a.value = Math.max(0, Number(b.value) - MIN); v.pause(); v.currentTime = Number(a.value); paint(); };
    b.oninput = () => { if (Number(b.value) < Number(a.value) + MIN) b.value = Math.min(dur, Number(a.value) + MIN); v.pause(); v.currentTime = Math.max(0, Number(b.value) - 0.04); paint(); };
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const r = await h.api(`/api/projects/${g.id}/trim`, { method: 'POST', body: { start: Number(a.value), end: Number(b.value) } });
        h.toast(r.trim ? `Video trimmed to ${fmtS(r.duration)} s` : 'The whole video is kept');
        reload();
      } catch (e) { h.toast(e.message, true); apply.disabled = false; }
    };
    const reset = body.querySelector('[data-trim-reset]');
    if (reset) {
      reset.onclick = async () => {
        reset.disabled = true;
        try { await h.api(`/api/projects/${g.id}/trim/reset`, { method: 'POST' }); h.toast('Whole video restored'); reload(); } catch (e) { h.toast(e.message, true); reset.disabled = false; }
      };
    }
    body.querySelector('[data-frame-save]').onclick = () => {
      if (v.readyState < 2 || !v.videoWidth) return h.toast('Wait for the video to load', true);
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob((blob) => {
        if (!blob) return h.toast('Could not save the frame', true);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `remake_${fileSafe((g.model_name || 'modelo').toLowerCase())}_${fileSafe(g.handle)}_${g.id}_frame_${fmtS(v.currentTime).replace('.', '-')}s.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      }, 'image/png');
    };
  };
  det.addEventListener('toggle', () => { if (det.open) { trimOpen.add(g.id); mount(); } else trimOpen.delete(g.id); });
  if (det.open) mount();
}

/** Binds every card in root (kept for callers that render the whole list themselves). */
export function bindGenCards(root, rows, reload = () => loadStudio()) {
  root._gens = new Map(rows.map((g) => [g.id, g]));
  h.$$('.gen', root).forEach((card) => {
    const g = root._gens.get(Number(card.dataset.id));
    if (g) bindGenCard(card, g, root, reload);
  });
}

function bindGenCard(card, g, root, reload) {
  const id = g.id;
  const origin = card.querySelector('[data-origin]');
  if (origin) origin.addEventListener('toggle', () => originOpen.set(id, origin.open));
  h.$$('[data-zoom-src]', card).forEach((img) => (img.onclick = () => h.showModal(`<div class="modal-box small" style="max-width:520px;padding:0;background:black"><img src="${img.dataset.zoomSrc}" style="width:100%;display:block" data-close alt=""></div>`)));
  h.$$('.photo-grid [data-zoom]', card).forEach((img) => (img.onclick = () => h.showModal(`<div class="modal-box small" style="max-width:560px;padding:0;background:black"><img src="${img.dataset.zoom}" style="width:100%;display:block" data-close alt=""></div>`)));
  const cur = () => root._gens?.get(id) || g;
  // Resolves true on success; errors become a toast (never a silent failure).
  const post = (url, body) => h.api(url, { method: 'POST', body }).then(() => { reload(); return true; }).catch((e) => { h.toast(e.message, true); return false; });
  const patch = (body) => h.api(`/api/generations/${id}`, { method: 'PATCH', body });
  // One click = one paid run: the button stays off until the page redraws.
  const once = async (b, fn) => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); } catch (e) { h.toast(e.message, true); if (b.isConnected) b.disabled = false; }
  };

  // ---- step 2: the swap image, or straight to the video without enlarging ----
  h.$$('[data-pick]', card).forEach((b) => (b.onclick = () => once(b, async () => {
    const r = await h.api(`/api/generations/${id}/pick`, { method: 'POST', body: { path: b.dataset.pick } });
    h.toast(r.enlarging ? `The enlargement started (${r.enlarging.n} image(s))` : cur().config?.ownImage ? 'Image chosen: ready for the video (step 4)' : 'Step 3: choose the enlargement AI and press “Generate” (or “Continue” on the image without enlargement)');
    reload();
  })));
  h.$$('[data-skip]', card).forEach((b) => (b.onclick = () => once(b, async () => {
    await h.api(`/api/generations/${id}/pick`, { method: 'POST', body: { path: b.dataset.skip, skipEnlarge: true } });
    h.toast('No enlargement: ready for the video (step 4)');
    reload();
  })));
  // ---- step 3: the image the video starts from ----
  h.$$('[data-final]', card).forEach((b) => (b.onclick = () => once(b, async () => {
    await h.api(`/api/generations/${id}/final`, { method: 'POST', body: { path: b.dataset.final } });
    h.toast('Ready for the video (step 4)');
    reload();
  })));
  h.$$('[data-edit-img]', card).forEach((b) => (b.onclick = () => openImageEdit(cur(), b.dataset.editImg, reload)));
  // Zoom: the images of that step, next to what they came from (the video frame, or the pick without enlargement).
  h.$$('[data-zoom-step]', card).forEach((img) => (img.onclick = () => {
    const [step, idx] = img.dataset.zoomStep.split(':').map(Number);
    const g1 = cur();
    const c1 = g1.config || {};
    const pick = g1.candidates.find((c) => c.path === c1.pick);
    const items = step === 2
      ? g1.candidates.filter((c) => !c.enlarge).map((c) => ({ c, kind: 'swap' }))
      : [pick && { c: pick, kind: 'asis' }, ...g1.candidates.filter((c) => c.enlarge && c.editOf === c1.pick).map((c) => ({ c, kind: 'enlarge' }))].filter(Boolean);
    const compare = step === 2 ? { path: c1.sceneUsed || g1.frame_path, label: 'Video frame' } : { path: c1.pick, label: 'Your pick, without enlargement' };
    openZoom(g1, items, idx, reload, compare);
  }));

  // ---- step 3: the enlargement prompt (presets, padrão / editado) and its price on the button ----
  const enlText = h.$('[data-enl-text]', card);
  const enlEng = h.$('[data-enl-engine]', card);
  const enlN = h.$('[data-enl-n]', card);
  const enlPaint = () => {
    if (!enlText) return;
    const g1 = cur();
    const e = g1.enlarge || {};
    const t = enlText.value.trim();
    const edited = t !== String(e.defaultPrompt || '').trim();
    const tag = h.$('[data-enl-tag]', card);
    if (tag) tag.textContent = edited ? 'edited' : 'default';
    const reset = h.$('[data-act="enl-reset"]', card);
    if (reset) reset.hidden = !edited;
    const sel = h.$('[data-enl-preset]', card);
    if (sel) sel.value = (g1.edit?.presets || []).find((p) => p.text.trim() === t)?.key || '';
    const label = h.$('[data-enl-label]', card);
    if (label && enlEng && enlN) {
      const unit = g1.edit?.engines?.find((x) => x.key === enlEng.value)?.cost || 0;
      label.textContent = `Generate · ~${usd(unit * Number(enlN.value))}`;
      h.$$('[data-act="enl-more"]', card).forEach((x) => { x.textContent = `+${x.dataset.more} · ~${usd(unit * Number(x.dataset.more))}`; });
    }
  };
  if (enlText) {
    enlText.oninput = enlPaint;
    if (enlEng) enlEng.onchange = enlPaint;
    if (enlN) enlN.onchange = enlPaint;
    const sel = h.$('[data-enl-preset]', card);
    if (sel) sel.onchange = () => {
      const p = (cur().edit?.presets || []).find((x) => x.key === sel.value);
      if (p) enlText.value = p.text;
      enlPaint();
      if (!p) enlText.focus();
    };
    enlPaint();
  }
  // ---- step 4: the video model (and the price on the button) ----
  const vModel = h.$('[data-vmodel]', card);
  if (vModel) vModel.onchange = () => {
    const opt = vModel.selectedOptions[0];
    const usdNow = Number(opt?.dataset.usd);
    const pr = h.$('[data-vprice]', card);
    if (pr) pr.textContent = opt?.hasAttribute('data-rh') ? ' · GPU time on RunningHub' : Number.isFinite(usdNow) ? ` · ~${usd(usdNow)}` : '';
  };
  const saveVideoModel = async () => {
    if (!vModel) return;
    const c0 = cur().config || {};
    if (vModel.value.startsWith('engine:')) {
      const videoEngine = vModel.value.slice(7);
      if (videoEngine !== c0.videoEngine) await patch({ config: { videoEngine } });
      return;
    }
    const [wanModel, wanResolution] = vModel.value.split('|');
    const videoEngine = ANIMATE_ENGINES.includes(c0.videoEngine) ? 'wan3_copy' : c0.videoEngine; // back from Wan 2.2 Animate: the exact copy
    if (wanModel !== c0.wanModel || wanResolution !== c0.wanResolution || videoEngine !== c0.videoEngine) await patch({ config: { wanModel, wanResolution, videoEngine } });
  };
  // ---- step 6: the price, read from the video ----
  const tz = h.$('[data-topaz]', card);
  if (tz) {
    h.api(`/api/generations/${id}/topaz`).then((e) => {
      if (!tz.isConnected) return;
      tz.dataset.usd = e.usd;
      tz.disabled = false; // only now: the confirm always has the price
      tz.querySelector('span').textContent = `Generate · ${e.target.w}×${e.target.h}, ${e.fps} fps · ~${usd(e.usd)}`;
    }).catch((err) => { if (tz.isConnected) tz.querySelector('span').textContent = `Unavailable: ${stripEmoji(err.message)}`; });
  }

  const readSwapOpts = () => {
    const o = {};
    h.$$('[data-swapopt]', card).forEach((x) => { if (x.type === 'checkbox') { if (x.checked) o[x.dataset.swapopt] = true; } else if (x.value) o[x.dataset.swapopt] = x.value; });
    return Object.keys(o).length ? o : null;
  };
  /** Everything typed on the card (prompts, step-1 options, enlargement prompt, video extras), saved without generating. */
  const cardEdits = () => {
    const body = {};
    const conf = {};
    h.$$('[data-prompt]', card).forEach((t) => {
      if (t.value === t.defaultValue) return;
      body[t.dataset.prompt] = t.value;
      if (t.value.trim()) conf[t.dataset.prompt === 'image_prompt' ? 'imagePromptEdited' : 'videoPromptEdited'] = true; // goes as written
    });
    if (h.$('[data-swapopt]', card)) conf.swapOptions = readSwapOpts();
    if (enlText) {
      const t = enlText.value.trim();
      conf.enlargePrompt = t && t !== String(cur().enlarge?.defaultPrompt || '').trim() ? t : null;
      if (enlEng) conf.enlargeEngine = enlEng.value;
      if (enlN) conf.enlargeN = Number(enlN.value);
    }
    const vx = h.$('[data-vx]', card);
    const vn = h.$('[data-vn]', card);
    if (vx) conf.videoExtra = vx.value.trim() || null;
    if (vn) conf.videoNegative = vn.value.trim() || null;
    if (Object.keys(conf).length) body.config = conf;
    return body;
  };

  h.$$('[data-act]', card).forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'poses') return openPoseModal(id, b.dataset.img, reload);
    if (act === 'toggle') {
      studio.open.has(id) ? studio.open.delete(id) : studio.open.add(id);
      card.replaceWith(buildGenCard(cur(), root, reload));
      return;
    }
    const spends = ['retry', 'more-images', 'more-4', 'more-8', 'redo-images', 'redo-covered', 'redo-direct', 'redo-video', 'animate-fal', 'swap-go', 'enl-go', 'enl-more', 'video-go', 'topaz-go'].includes(act);
    if (spends) b.disabled = true; // avoid paying twice for a double click
    try {
      if (act === 'cancel') return await post(`/api/generations/${id}/stage`, { stage: 'cancelled' });
      if (act === 'approve') { if (await post(`/api/generations/${id}/stage`, { stage: 'approved' })) h.toast('Approved. Ready to publish'); return; }
      if (act === 'reject') return await post(`/api/generations/${id}/stage`, { stage: 'rejected' });
      if (act === 'back-to-review') return await post(`/api/generations/${id}/stage`, { stage: 'review' });
      if (act === 'retry') return await post(`/api/generations/${id}/retry`, {});
      // Images only, chosen by hand: the project goes step by step (never on to the paid video by itself).
      if (act === 'more-images' || act === 'redo-images') { await patch({ config: { autoApprove: false } }); return await post(`/api/generations/${id}/retry`, { from: 'imaging' }); }
      if (act === 'more-4' || act === 'more-8') {
        await patch({ config: { variantsOnce: act === 'more-4' ? 4 : 8, autoApprove: false } });
        return await post(`/api/generations/${id}/retry`, { from: 'imaging' });
      }
      if (act === 'swap-go') {
        // Step 1: this engine, this many images and these options, from the prompt as it is on the card.
        const c = cur().config || {};
        const eng = h.$('[data-swap-engine]', card)?.value || 'nano';
        const body = cardEdits();
        body.config = { ...(body.config || {}), variantsOnce: Number(h.$('[data-swap-n]', card)?.value) || 2, frameEngine: eng === 'nanopro' ? 'nano' : eng, autoApprove: false };
        if (eng === 'nanopro') body.config.nbModel = NB_PRO;
        else if (eng === 'nano' && /pro/i.test(c.nbModel || '')) body.config.nbModel = NB_2;
        await patch(body);
        return await post(`/api/generations/${id}/retry`, { from: 'imaging' });
      }
      if (act === 'enl-reset') {
        if (enlText) enlText.value = cur().enlarge?.defaultPrompt || '';
        enlPaint();
        await patch({ config: { enlargePrompt: null } });
        return h.toast("Back to the model's prompt (nothing was generated)");
      }
      if (act === 'enl-go' || act === 'enl-more') {
        const body = { prompt: enlText?.value.trim() || '', engine: enlEng?.value, n: Number(enlN?.value) || undefined };
        if (act === 'enl-more') body.more = Number(b.dataset.more) || 2;
        const r = await h.api(`/api/generations/${id}/enlarge`, { method: 'POST', body });
        h.toast(`Generating the enlargement: ${r.n} image(s). You can move on to another project`);
        return reload();
      }
      if (act === 'video-go') {
        const edits = cardEdits(); // what is typed on the card goes with this video, as "Guardar" would save it
        if (Object.keys(edits).length) await patch(edits);
        await saveVideoModel();
        await h.api(`/api/generations/${id}/video`, { method: 'POST', body: { extra: h.$('[data-vx]', card)?.value || '', negative: h.$('[data-vn]', card)?.value || '' } });
        h.toast('Generating the video (step 4). You can move on to another project');
        return reload();
      }
      if (act === 'topaz-go') {
        const price = Number(h.$('[data-topaz]', card)?.dataset.usd);
        if (!Number.isFinite(price) || !price) return h.toast('Wait for the price: it has not been worked out yet', true);
        if (!confirm(`Enhance the video (twice the resolution, 60 fps)? It costs about ${usd(price)} on WaveSpeed. The current video is kept.`)) return;
        await h.api(`/api/generations/${id}/topaz`, { method: 'POST' });
        h.toast('Enhancing the video (step 6). You can move on to another project');
        return reload();
      }
      if (act === 'topaz-resume') {
        await h.api(`/api/generations/${id}/topaz/resume`, { method: 'POST' });
        h.toast('Resuming step 6 (without paying again). You can move on to another project');
        return reload();
      }
      if (act === 'topaz-undo') {
        if (!confirm('Go back to the video from before step 6? The enhanced video is deleted.')) return;
        return await post(`/api/generations/${id}/topaz/undo`, {});
      }
      if (act === 'redo-covered') {
        // Drop the chosen outfit too: otherwise the same garment is applied again and refused again.
        const c = cur().config || {};
        const direct = c.videoEngine === 'wan3_copy' && c.firstFrame === 'direct';
        await patch({ config: { keepOutfit: 'covered', outfitId: null, ...(direct ? {} : { autoApprove: false }) }, image_prompt: '', video_prompt: '' });
        return await post(`/api/generations/${id}/retry`, { from: direct ? 'animating' : 'imaging' });
      }
      if (act === 'redo-direct') {
        await patch({ config: { firstFrame: 'direct' }, video_prompt: '' });
        return await post(`/api/generations/${id}/retry`, { from: 'animating' });
      }
      if (act === 'redo-video') {
        const edits = cardEdits();
        if (Object.keys(edits).length) await patch(edits);
        await saveVideoModel();
        return await post(`/api/generations/${id}/retry`, { from: 'animating' });
      }
      if (act === 'animate-fal') {
        await patch({ config: { videoEngine: 'animate_replace' }, video_prompt: '' });
        return await post(`/api/generations/${id}/retry`, { from: 'animating' });
      }
      if (act === 'reset-image-prompt' || act === 'reset-video-prompt') {
        const k = act === 'reset-image-prompt' ? 'image_prompt' : 'video_prompt';
        await patch({ [k]: null });
        h.toast("Back to the app's prompt: it is rebuilt on the next generation (nothing was generated now)");
        return reload();
      }
      if (act === 'save-prompts') {
        await patch(cardEdits());
        h.$$('[data-prompt]', card).forEach((t) => (t.defaultValue = t.value));
        h.toast('Saved (nothing was generated)');
        return reload();
      }
      if (act === 'delete') {
        if (!confirm('Delete this generation and the generated files?')) return;
        await h.api(`/api/generations/${id}`, { method: 'DELETE' });
        card.remove();
        reload();
      }
    } catch (e) {
      h.toast(e.message, true);
    } finally {
      if (spends && b.isConnected) b.disabled = false;
    }
  }));
  bindTrim(card, g, reload);
  const pub = h.$('[data-publish]', card);
  if (pub) mountPublish(pub, cur(), reload, h);
}

// =================================================================================
// MODELS: each model has a folder with photos organised by angle
// =================================================================================
let kindsCache = null;
let modelsTimer = null;
let modelsGen = 0;

const refsSig = (m) => JSON.stringify([m.name, m.color, m.remakes, m.approved, m.ref_images.map((r) => [r.path, r.kind, r.generated ? 1 : 0])]);
const taskSig = (m) => JSON.stringify(m.task || null);
const taskHtml = (task) => (!task ? '' : `<div class="gen-running" style="margin:0 0 12px">${task.state === 'running' ? '<div class="spinner"></div>' : task.errors.length && !task.done ? icon('x-circle', { cls: 'bad' }) : icon('check-circle', { cls: 'ok' })}<div><b>${task.state === 'running' ? `Generating ${task.done}/${task.total}${task.current ? ` · ${h.esc(stripEmoji(task.current))}` : ''}` : `Generated: ${task.done}/${task.total}`}</b>${task.errors.length ? `<div class="err-box" style="margin:6px 0 0">${task.errors.map((e) => h.esc(stripEmoji(e))).join('<br>')}</div>` : ''}</div></div>`);
const draftKey = (t) => (t.hasAttribute('data-body') ? 'body' : t.hasAttribute('data-persona') ? 'persona' : t.hasAttribute('data-notes') ? 'notes' : null);
/** Is the user working inside this card (focus in a field, or text typed and not saved yet)? */
const cardEditing = (card) => {
  const ae = editingEl();
  if (ae && card.contains(ae)) return true;
  return h.$$('textarea', card).some((t) => t.value !== t.defaultValue);
};

/** Models page. `arg` is the route params, or an already fetched model list (skips a second request). */
export async function renderModels(arg) {
  clearTimeout(modelsTimer);
  const gen = ++modelsGen;
  let models; let kinds;
  try {
    [models, kinds] = await Promise.all([Array.isArray(arg) ? arg : h.api('/api/models'), kindsCache || h.api('/api/models/kinds')]);
  } catch (e) {
    if (on('models') && gen === modelsGen) h.$('#view').innerHTML = errorState(e);
    return;
  }
  kindsCache = kinds;
  if (!on('models') || gen !== modelsGen) return;
  // Keep typed-but-unsaved text and the scroll position across a re-render.
  const drafts = new Map();
  h.$$('.model-card').forEach((c) => {
    const d = {};
    h.$$('textarea', c).forEach((t) => { const k = draftKey(t); if (k && t.value !== t.defaultValue) d[k] = t.value; });
    if (Object.keys(d).length) drafts.set(c.dataset.id, d);
  });
  const main = h.$('.main');
  const top = main ? main.scrollTop : 0;
  h.$('#topbar-actions').innerHTML = `<button class="btn primary sm" id="m-new">${icon('plus')}New model</button>`;
  h.$('#m-new').onclick = () => h.openModelDialog();
  h.$('#view').innerHTML = `
    <h2>Models</h2>
    <p class="sub">Each model has a <b>folder</b> with photos by angle. The <b>faces</b> (front, 3/4, profile, smile) lock in the identity and the <b>body</b> (front, side, back) locks in the proportions. The more complete the folder, the more consistent the automatic generations.</p>
    <div class="card tips">
      <b>Photo tips</b>
      <ul>
        <li>Sharp, in natural light, with no filters and no sunglasses. Only one person in each photo.</li>
        <li>Faces: the face fills most of the image. Body: head to toe, in fitted or normal clothes.</li>
        <li>You can drag photos onto each square or copy them into the folder. If the file name starts with the angle (<code>face_front</code>, <code>face_left</code>, <code>face_right</code>, <code>face_profile</code>, <code>face_smile</code>, <code>body_front</code>, <code>body_side</code>, <code>body_back</code>, <code>body_half</code>), the app sorts it by itself.</li>
        <li>Only have one good photo of the face? Press <b>Generate missing angles</b> and Nano Banana creates the others from it. Review them before using them.</li>
      </ul>
    </div>
    <div class="stack">${models.length ? models.map((m) => modelCard(m, kinds)).join('') : `<div class="empty">${icon('user', { size: 28 })}<h3>No models</h3><p>Create the first model to start generating.</p></div>`}</div>`;
  h.$$('.model-card').forEach((card) => bindModelCard(card, models.find((m) => m.id === Number(card.dataset.id))));
  drafts.forEach((d, id) => {
    const card = h.$(`.model-card[data-id="${id}"]`);
    if (card) h.$$('textarea', card).forEach((t) => { const k = draftKey(t); if (k && d[k] !== undefined) t.value = d[k]; });
  });
  if (main && top) main.scrollTop = top;
  if (models.some((m) => m.task?.state === 'running')) modelsTimer = setTimeout(() => pollModels(gen), 3000);
}

/** After an upload or delete: one /api/models request refreshes both the sidebar and this page. */
async function refreshModels() {
  try {
    if (typeof h.renderSidebar === 'function') {
      h.state.models = await h.api('/api/models');
      h.renderSidebar();
    } else await h.loadShared(); // fetches /api/models once and redraws the sidebar
    return renderModels(h.state.models);
  } catch (e) { h.toast(e.message, true); return renderModels(); }
}

/** While an angle/photo task runs: patch only the task box of each card, never the whole page. */
async function pollModels(gen) {
  if (!on('models') || gen !== modelsGen) return;
  let models;
  try { models = await h.api('/api/models'); } catch {
    if (on('models') && gen === modelsGen) modelsTimer = setTimeout(() => pollModels(gen), 5000);
    return;
  }
  if (!on('models') || gen !== modelsGen) return;
  const cards = new Map(h.$$('.model-card').map((c) => [Number(c.dataset.id), c]));
  const structural = models.length !== cards.size || models.some((m) => !cards.has(m.id));
  if (structural && !h.$$('.model-card').some(cardEditing)) return renderModels(models);
  let pending = structural;
  for (const m of models) {
    const card = cards.get(m.id);
    if (!card) continue;
    const refsChanged = card.dataset.refsSig !== refsSig(m);
    if (refsChanged && !cardEditing(card)) {
      // New photos arrived (or the task ended): redraw this one card only.
      const tpl = document.createElement('template');
      tpl.innerHTML = modelCard(m, kindsCache || []).trim();
      const fresh = tpl.content.firstElementChild;
      card.replaceWith(fresh);
      bindModelCard(fresh, m);
      continue;
    }
    if (refsChanged) pending = true;
    if (card.dataset.taskSig !== taskSig(m)) {
      const box = h.$('[data-task-box]', card);
      if (box) box.innerHTML = taskHtml(m.task);
      card.dataset.taskSig = taskSig(m);
      const running = m.task?.state === 'running';
      h.$$('[data-prompt-photo], [data-fill]', card).forEach((b) => (b.disabled = running));
      if (card._m) card._m.task = m.task;
    }
  }
  if (models.some((m) => m.task?.state === 'running') || pending) modelsTimer = setTimeout(() => pollModels(gen), 3000);
}

function modelCard(m, kinds) {
  const r = m.readiness;
  const running = m.task?.state === 'running';
  const slot = (k) => {
    const photo = m.ref_images.find((x) => x.kind === k.key);
    return `<div class="slot ${photo ? 'filled' : ''} ${k.required ? 'req' : ''}" data-kind="${k.key}" title="${h.esc(k.hint)}">
      ${photo ? `<img src="${media(photo.path)}" data-zoom="${media(photo.path)}" loading="lazy" alt="">${photo.generated ? `<span class="badge gen-badge">AI</span><button class="icon-btn regen" data-regen="${k.key}" title="Generate this angle again (uses the real photos and the body description)" aria-label="Generate this angle again">${icon('refresh')}</button><button class="icon-btn enl" data-enlarge="${h.esc(photo.path)}" title="Enlarge the bust (or make another change) in this photo" aria-label="Enlarge the bust in this photo">${icon('wand')}</button>` : ''}<button class="icon-btn" data-rm="${h.esc(photo.path)}" title="Remove photo" aria-label="Remove photo">${icon('x')}</button>`
        : `<div class="slot-empty">${icon('plus')}<small>${k.required ? 'Required' : 'Drag or click'}</small></div>`}
      <div class="slot-label">${h.esc(k.label)}</div>
      <input type="file" accept="image/*" hidden data-slot-input="${k.key}">
    </div>`;
  };
  const extras = m.ref_images.filter((x) => x.kind === 'extra');
  return `
  <article class="card model-card" data-id="${m.id}">
    <div class="row between">
      <div class="row"><span class="avatar-letter" style="--c:${h.esc(m.color || '#b15cff')}">${h.esc(m.name[0])}</span>
        <div><b style="font-size:17px">${h.esc(m.name)}</b><div class="dim" style="font-size:12px">${m.remakes} remakes · ${m.approved} approved · ${m.ref_images.length} photos</div></div></div>
      <div class="row">
        <button class="btn sm" data-open-folder title="${h.esc(m.folder)}">${icon('folder')}Open folder</button>
        <button class="btn sm" data-prompt-photo ${running ? 'disabled' : ''}>${icon('pen-tool')}Create photo from prompt</button>
        <button class="btn sm" data-dup title="Creates “Backup ${h.esc(m.name)}” with the same photos, texts and captions, without accounts (add the backup accounts there)">${icon('copy')}Duplicate as backup</button>
        <button class="btn sm" data-fill ${running ? 'disabled' : ''}>${icon('plus-square')}Generate missing angles</button>
        <button class="btn sm ghost danger" data-del>Remove</button>
      </div>
    </div>
    <div class="ready-bar"><i style="width:${r.score}%;background:${r.complete ? 'var(--good)' : r.ready ? 'var(--warn)' : 'var(--bad)'}"></i></div>
    <div class="dim" style="font-size:12.5px;margin-bottom:10px">
      ${r.complete ? `<span class="msg ok">${icon('check-circle')}Ready to generate</span>` : r.ready ? `<span class="msg warn">${icon('alert-triangle')}Can generate, but required photos are missing</span>` : `<span class="msg bad">${icon('x-circle')}Cannot generate yet</span>`}
      · ${r.faces} face(s), ${r.bodies} body photo(s)${r.missingRequired.length ? ` · missing: <b>${r.missingRequired.map(h.esc).join(', ')}</b>` : ''}${r.missingRecommended.length ? ` · recommended: ${r.missingRecommended.map(h.esc).join(', ')}` : ''}
    </div>
    <div data-task-box>${taskHtml(m.task)}</div>
    <div class="label">Face</div>
    <div class="slots">${kinds.filter((k) => k.group === 'face').map(slot).join('')}</div>
    <div class="label" style="margin-top:12px">Body</div>
    <div class="slots">${kinds.filter((k) => k.group === 'body').map(slot).join('')}</div>
    <div class="label" style="margin-top:12px">Style and outfit (${extras.length})</div>
    <div class="slots">
      ${extras.map((x) => `<div class="slot filled"><img src="${media(x.path)}" data-zoom="${media(x.path)}" loading="lazy" alt=""><button class="icon-btn" data-rm="${h.esc(x.path)}" title="Remove photo" aria-label="Remove photo">${icon('x')}</button>${x.generated ? `<button class="icon-btn enl" data-enlarge="${h.esc(x.path)}" title="Enlarge the bust (or make another change) in this photo" aria-label="Enlarge the bust in this photo">${icon('wand')}</button>` : ''}
        <select class="input slot-kind" data-move="${h.esc(x.path)}"><option value="">Move to…</option>${kinds.filter((k) => !k.multi).map((k) => `<option value="${k.key}">${h.esc(k.label)}</option>`).join('')}</select></div>`).join('')}
      <label class="slot add-many"><div class="slot-empty">${icon('plus')}<small>Several photos</small></div><input type="file" accept="image/*" multiple hidden data-many></label>
    </div>
    <label class="field body-field ${m.body ? '' : 'empty'}" style="margin-top:14px"><span>Body: proportions <b style="color:var(--warn)">(important)</b>. Goes into every prompt so the AI does not change her figure.
        <button class="btn sm" data-describe-body style="margin-left:8px">${icon('ruler')}Suggest from the photo</button><span class="dim" data-body-saved style="font-size:11.5px"></span></span>
      <textarea class="input" rows="3" data-body placeholder="Write it yourself (English works best), e.g. curvy hourglass figure, extremely large natural bust (much bigger than average), very narrow waist, wide hips, large round glutes, thick thighs">${h.esc(m.body || '')}</textarea>
      <small class="dim">Describe the body you want. This text goes first into every generation (photos, poses, videos) and saves by itself. Be specific about sizes (“extremely large”, “much bigger than average”).</small></label>
    <div class="grid-2" style="margin-top:12px;gap:12px">
      <label class="field"><span>Persona (appearance, goes into the prompts)</span><textarea class="input" rows="2" data-persona placeholder="e.g. 22 years old, long wavy brown hair, green eyes, light freckles, casual girl-next-door style">${h.esc(m.persona || '')}</textarea></label>
      <label class="field"><span>Internal notes</span><textarea class="input" rows="2" data-notes>${h.esc(m.notes || '')}</textarea></label>
    </div>
    <div class="row" style="margin-top:10px"><button class="btn sm" data-save>Save</button><span class="dim" style="font-size:11.5px">Folder: <code>${h.esc(m.folder)}</code></span></div>
  </article>`;
}

function bindModelCard(card, m) {
  if (!m) return;
  card._m = m;
  card.dataset.refsSig = refsSig(m);
  card.dataset.taskSig = taskSig(m);
  const M = () => card._m || m;
  const upload = async (items) => {
    if (!items.length) return;
    h.toast(`Uploading ${items.length} photo(s)…`);
    try {
      const images = await Promise.all(items.map(async ({ file, kind }) => ({ data: await resizeImage(file, 2048), kind })));
      await h.api(`/api/models/${m.id}/images`, { method: 'POST', body: { images } });
      await refreshModels();
    } catch (e) { h.toast(e.message, true); }
  };
  const guessKind = (name) => {
    const n = name.toLowerCase();
    const k = (kindsCache || []).flatMap((k) => k.alias.map((a) => [a, k.key])).sort((a, b) => b[0].length - a[0].length).find(([a]) => n.startsWith(a));
    return k ? k[1] : 'extra';
  };
  h.$$('[data-kind]', card).forEach((slot) => {
    const input = h.$('[data-slot-input]', slot);
    slot.onclick = (e) => { if (!e.target.closest('[data-rm],[data-zoom],[data-regen],[data-enlarge]')) input.click(); };
    input.onchange = () => upload([...input.files].slice(0, 1).map((file) => ({ file, kind: slot.dataset.kind })));
    slot.ondragover = (e) => { e.preventDefault(); slot.classList.add('drag'); };
    slot.ondragleave = () => slot.classList.remove('drag');
    slot.ondrop = (e) => { e.preventDefault(); slot.classList.remove('drag'); upload([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')).slice(0, 1).map((file) => ({ file, kind: slot.dataset.kind }))); };
  });
  const many = h.$('[data-many]', card);
  many.onchange = () => upload([...many.files].map((file) => ({ file, kind: guessKind(file.name) })));
  const addMany = h.$('.add-many', card);
  addMany.ondragover = (e) => { e.preventDefault(); addMany.classList.add('drag'); };
  addMany.ondragleave = () => addMany.classList.remove('drag');
  addMany.ondrop = (e) => { e.preventDefault(); addMany.classList.remove('drag'); upload([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')).map((file) => ({ file, kind: guessKind(file.name) }))); };
  h.$$('[data-zoom]', card).forEach((img) => (img.onclick = (e) => { e.stopPropagation(); h.showModal(`<div class="modal-box small" style="max-width:520px;padding:0;background:black"><img src="${img.dataset.zoom}" style="width:100%;display:block" data-close alt=""></div>`); }));
  h.$$('[data-rm]', card).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    try {
      await h.api(`/api/models/${m.id}/images?path=${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' });
      await refreshModels();
    } catch (err) { h.toast(err.message, true); }
  }));
  h.$$('[data-move]', card).forEach((sel) => (sel.onchange = async () => {
    if (!sel.value) return;
    try {
      await h.api(`/api/models/${m.id}/images`, { method: 'PATCH', body: { path: sel.dataset.move, kind: sel.value } });
      sel.blur();
      renderModels();
    } catch (err) { h.toast(err.message, true); }
  }));
  h.$('[data-open-folder]', card).onclick = async () => {
    try {
      await h.api(`/api/models/${m.id}/open-folder`, { method: 'POST' });
      h.toast('Folder opened. After copying photos, come back here (the app syncs by itself)');
    } catch (err) { h.toast(err.message, true); }
  };
  h.$('[data-prompt-photo]', card).onclick = () => {
    const mm = M();
    h.showModal(`<div class="modal-box small">
      <h3 style="margin:0 0 4px">Create a photo of ${h.esc(mm.name)} from a prompt</h3>
      <p class="sub" style="font-size:12.5px">Generated with Nano Banana and saved in her folder. LoRA trigger words (e.g. <code>KAY3LE BA3YLQ1</code>) only work in workflows with that LoRA; here what counts is the description.</p>
      <form class="stack" id="pp-form">
        <textarea class="input" name="prompt" rows="6" required placeholder="close-up portrait, woman with long black hair, green eyes, freckles…">${h.esc(mm.persona || '')}</textarea>
        <div class="grid-2" style="gap:10px">
          <label class="field"><span>Save as</span><select class="input" name="kind">${(kindsCache || []).map((k) => `<option value="${k.key}" ${k.key === 'face_front' ? 'selected' : ''}>${h.esc(k.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Variants</span><select class="input" name="n"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
        </div>
        ${mm.ref_images.length ? '<label class="check"><input type="checkbox" name="useRefs" checked> Use the photos already in the folder to keep the same face</label>' : ''}
        <div class="dim" style="font-size:12px">Cost: ~$0.08 per image (1K).</div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${icon('play-circle')}Generate</button></div>
      </form></div>`);
    h.$('#pp-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.submitter || h.$('#pp-form .btn.primary');
      if (btn) btn.disabled = true;
      const f = new FormData(e.target);
      try {
        await h.api(`/api/models/${m.id}/generate-photo`, { method: 'POST', body: { prompt: f.get('prompt'), kind: f.get('kind'), n: Number(f.get('n')), useRefs: f.has('useRefs') } });
        h.closeModal(); h.toast('Generating the photo'); renderModels();
      } catch (err) { h.toast(err.message, true); if (btn) btn.disabled = false; }
    };
  };
  const describeLabel = () => `${icon('ruler')}Suggest from the photo`;
  h.$('[data-describe-body]', card).onclick = async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    const ta = h.$('[data-body]', card);
    if (ta.value.trim() && !confirm('You already have a description written. Replace it with the AI suggestion?')) return;
    btn.disabled = true; btn.textContent = 'Analyzing the photo…';
    try {
      const r = await h.api(`/api/models/${m.id}/describe-body`, { method: 'POST' });
      ta.value = r.body;
      ta.focus();
      h.toast('Suggestion placed in the field. Adjust it as you like; it saves by itself when you leave the field');
    } catch (err) { h.toast(err.message, true); }
    btn.disabled = false; btn.innerHTML = describeLabel();
  };
  const bodyTa = h.$('[data-body]', card);
  let bodyTimer;
  const saveBody = async () => {
    clearTimeout(bodyTimer);
    const v = bodyTa.value;
    if (v === bodyTa.defaultValue) return;
    try {
      await h.api(`/api/models/${m.id}`, { method: 'PATCH', body: { body: v } });
      M().body = v;
      bodyTa.defaultValue = v;
      const el = h.$('[data-body-saved]', card);
      if (el) { el.textContent = 'Saved'; setTimeout(() => (el.textContent = ''), 2000); }
    } catch (err) { h.toast(err.message, true); }
  };
  bodyTa.onblur = saveBody;
  bodyTa.oninput = () => { clearTimeout(bodyTimer); bodyTimer = setTimeout(saveBody, 1200); };
  h.$$('[data-enlarge]', card).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openRefEdit(M(), b.dataset.enlarge, () => refreshModels()); }));
  h.$$('[data-regen]', card).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    if (!M().body && !confirm('There is no body description yet, so the result may come out different. Continue?')) return;
    b.disabled = true;
    try { await h.api(`/api/models/${m.id}/fill-angles`, { method: 'POST', body: { kinds: [b.dataset.regen] } }); renderModels(); } catch (err) { h.toast(err.message, true); b.disabled = false; }
  }));
  h.$('[data-fill]', card).onclick = async (e) => {
    const btn = e.currentTarget;
    const rd = M().readiness;
    const missing = rd.missingRequired.length + rd.missingRecommended.length;
    if (!missing) return h.toast('The folder already has all the angles');
    if (!confirm(`Generate ${missing} missing angle(s) with Nano Banana from the existing photos? (cost ~$${(missing * 0.084).toFixed(2)})`)) return;
    btn.disabled = true;
    try { await h.api(`/api/models/${m.id}/fill-angles`, { method: 'POST', body: {} }); renderModels(); } catch (err) { h.toast(err.message, true); btn.disabled = false; }
  };
  h.$('[data-save]', card).onclick = async () => {
    const fields = { persona: h.$('[data-persona]', card), notes: h.$('[data-notes]', card), body: bodyTa };
    const body = Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, t.value]));
    try {
      await h.api(`/api/models/${m.id}`, { method: 'PATCH', body });
      Object.entries(fields).forEach(([k, t]) => { t.defaultValue = body[k]; M()[k] = body[k]; });
      h.toast('Model saved');
    } catch (err) { h.toast(err.message, true); }
  };
  h.$('[data-dup]', card).onclick = async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Create “Backup ${M().name}” with the same photos, texts and captions? It has no accounts: add the backup accounts in Profiles.`)) return;
    btn.disabled = true;
    try {
      const b = await h.api(`/api/models/${M().id}/duplicate`, { method: 'POST' });
      h.toast(`${b.name} created: add her accounts in Profiles`);
      refreshModels();
    } catch (err) { h.toast(err.message, true); btn.disabled = false; }
  };
  h.$('[data-del]', card).onclick = async () => {
    if (!confirm(`Remove ${M().name}? This deletes the folder, the photos, the accounts in Profiles, the captions and the Studio creations; the remakes are left without a model.`)) return;
    try {
      await h.api(`/api/models/${m.id}`, { method: 'DELETE' });
      await refreshModels();
    } catch (err) { h.toast(err.message, true); }
  };
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.93));
    };
    img.onerror = () => reject(new Error(`Could not read ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

// =================================================================================
// COMFY: connect account, import workflows, how it works
// =================================================================================
export async function renderComfy() {
  let wf; let s;
  try {
    [wf, s] = await Promise.all([h.api('/api/pipeline/workflows'), h.api('/api/settings')]);
  } catch (e) {
    if (on('comfy')) h.$('#view').innerHTML = errorState(e);
    return;
  }
  if (!on('comfy')) return;
  h.$('#view').innerHTML = `
    <h2>Comfy</h2>
    <p class="sub">The engine that generates the images (Nano Banana 2) and the videos (Wan 3.0). Connect your account once and the app handles the rest.</p>

    <div class="card connect">
      <div class="row between"><h3 style="margin:0">1 · Connect your Comfy account</h3>
        <span class="status new" id="c-conn-pill">Checking…</span></div>
      <div id="c-conn-balance"></div>
      <div class="mode-pick">
        <label class="mode ${s.comfy_mode === 'api' ? 'active' : ''}"><input type="radio" name="cmode" value="api" ${s.comfy_mode === 'api' ? 'checked' : ''}>
          <b>${icon('cpu')}Comfy API in the cloud <span class="status ok">Recommended</span></b><span>The app talks directly to the Comfy API, the same one the Wan 3.0 and Nano Banana nodes use. You install nothing and need no subscription, only credits. Works with a Free account.</span></label>
        <label class="mode ${s.comfy_mode === 'cloud' ? 'active' : ''}"><input type="radio" name="cmode" value="cloud" ${s.comfy_mode === 'cloud' ? 'checked' : ''}>
          <b>${icon('cloud')}Comfy Cloud (workflows)</b><span>Runs full workflows on cloud.comfy.org, including custom workflows. Needs a paid Cloud plan; on the Free plan the API is blocked.</span></label>
        <label class="mode ${s.comfy_mode === 'local' ? 'active' : ''}"><input type="radio" name="cmode" value="local" ${s.comfy_mode === 'local' ? 'checked' : ''}>
          <b>${icon('laptop')}ComfyUI on this computer</b><span>The free ComfyUI Desktop app, open on this computer. It also accepts custom workflows. You only pay for credits.</span></label>
      </div>
      <div class="grid-2" style="gap:12px;margin-top:12px">
        <label class="field"><span>comfy.org API key ${s.comfy_api_key_set ? '<span class="status ok">Saved</span>' : ''}</span>
          <input class="input" id="c-key" type="password" autocomplete="off" placeholder="${s.comfy_api_key_set ? '•••••• (leave empty to keep)' : 'comfyui-…'}">
          <small>In <a href="https://platform.comfy.org/profile/api-keys" target="_blank" rel="noopener" style="color:var(--accent)">platform.comfy.org → API Keys</a>, click “+ New”, give it a name (e.g. Reels Radar), copy the key and paste it here. The same key works for Cloud and for the credits.</small></label>
        <label class="field ${s.comfy_mode !== 'local' ? 'hidden' : ''}" id="c-url-wrap"><span>Local ComfyUI address</span><input class="input" id="c-url" value="${h.esc(s.comfy_url)}"><small>ComfyUI Desktop: <code>http://127.0.0.1:8000</code> · manual install: <code>:8188</code></small></label>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn" id="c-test">Test connection</button><button class="btn primary" id="c-save">Save and connect</button>
        <span id="c-smoke-slot" style="display:contents"></span><span id="c-result" class="dim" style="font-size:12.5px"></span></div>
      <div id="c-conn-status" style="margin-top:12px"><span class="dim" style="font-size:12.5px"><span class="spinner inline"></span> Checking the connection…</span></div>
    </div>

    <div class="card">
      <div class="row between"><h3 style="margin:0">2 · Workflows</h3>
        <div class="row"><a class="btn sm" href="/workflows/reels-radar-remake.json" download="reels-radar-remake.json">${icon('download')}Remake workflow (video)</a>
        <a class="btn sm" href="/workflows/zimage-sfw.json" download="ZImage_SFW_organizado.json">${icon('download')}Z-Image SFW workflow (photos + LoRA)</a></div></div>
      <p class="dim" style="font-size:12.5px;margin:6px 0 12px">The ready-made workflow uses the 3 photos (face, body and reel frame) in Nano Banana 2 and animates the result with Wan 3.0. Drag the file onto cloud.comfy.org to view it and run it by hand. The app already does the same by itself in Comfy API mode.</p>
      <h3 style="font-size:14px">Import your own workflow (Comfy Cloud link)</h3>
      <p class="muted" style="margin:0 0 10px;font-size:13px">Paste the share link (<code>https://cloud.comfy.org/?share=…</code>) or upload a .json file exported from ComfyUI. The app converts it and detects the inputs by itself: model photos, frame, video, prompt and seed.</p>
      <div class="row"><input class="input" id="share-link" placeholder="https://cloud.comfy.org/?share=…" style="flex:1;min-width:260px"><button class="btn primary" id="share-import">Import</button>
        <label class="btn">${icon('upload')}Upload .json<input type="file" accept=".json" hidden id="json-import"></label></div>
      <div id="imported" class="stack" style="margin-top:14px">${wf.imported.map((w) => importedCard(w, wf)).join('') || '<span class="dim" style="font-size:13px">No workflow imported. Without your own workflow, the app uses the included workflows (below).</span>'}</div>
    </div>

    <div class="grid-2">
      ${['image', 'video'].map((kind) => `
      <div class="card">
        <h3>${kind === 'image' ? 'Image stage' : 'Video stage'}: ${wf.custom[kind] ? `<span class="status ok">${h.esc(wf.custom[kind].name)}</span>` : `<span class="status new">Included (${kind === 'image' ? 'Nano Banana 2' : 'Wan 3.0'})</span>`}</h3>
        ${wf.custom[kind] ? `${mappingEditor(kind, wf.custom[kind].inputs, wf.custom[kind].mapping, wf.variables[kind])}
          <div class="row" style="margin-top:10px"><button class="btn sm" data-save-map="${kind}">Save mappings</button><button class="btn sm ghost danger" data-wf-clear="${kind}">Back to the included one</button></div>`
          : `<p class="dim" style="font-size:12.5px;margin:0">${kind === 'image' ? 'The model photos and the reel frame go into Nano Banana 2, which generates the first frame.' : 'The approved frame is animated by Wan 3.0 (I2V), or used with the original reel as the motion reference (R2V).'}</p>`}
      </div>`).join('')}
    </div>

    <details class="card"><summary><b>How the app uses Comfy</b> <span class="dim">(technical)</span></summary>
      <ol class="steps" style="margin-top:12px">
        <li><b>Upload</b>: the model photos, the frame and the reel go to the Comfy <code>input</code> folder.</li>
        <li><b>Graph</b>: the app builds the workflow in API format (<code>{ id: { class_type, inputs } }</code>) and fills in the mapped inputs.</li>
        <li><b>Queue</b>: sends <code>POST /prompt</code> with your API key in <code>extra_data.api_key_comfy_org</code>. This pays for the partner nodes.</li>
        <li><b>Wait</b>: on Cloud it follows the progress over WebSocket; on local ComfyUI it polls <code>/history</code>.</li>
        <li><b>Result</b>: downloads with <code>/view</code> into the app Library.</li>
      </ol>
      ${[['nano_banana', 'Nano Banana 2: first frame'], ['wan3_i2v', 'Wan 3.0 Image to Video'], ['wan3_r2v', 'Wan 3.0 Reference to Video']]
        .map(([k, t]) => `<div style="margin-top:14px"><div class="row between"><b>${t}</b><button class="btn sm" data-wf-download="${k}">${icon('download')}Download JSON</button></div>${graphHtml(wf.builtin[k].graph)}</div>`).join('')}
    </details>

    <div class="card">
      <h3>Costs (comfy.org credits)</h3>
      <table class="mini"><tr><th>Stage</th><th>Price</th></tr>
        <tr><td>Nano Banana 2 (1K / 2K / 4K)</td><td>$0.084 / $0.122 / $0.185 per image</td></tr>
        <tr><td>Wan 3.0 (480P / 720P / 1080P)</td><td>$0.072 / $0.143 / $0.286 per second</td></tr>
        <tr><td>Wan 3.0 Prime (480P / 720P / 1080P)</td><td>$0.097 / $0.200 / $0.400 per second</td></tr>
      </table>
      <p class="dim" style="font-size:12px;margin:8px 0 0">A typical remake, with 2 variants at 1K and 10 s of video at 720P, costs about $1.60.</p>
    </div>`;

  // connection status (filled in when the balance check answers)
  const paintConn = (st) => {
    if (!on('comfy')) return;
    const card = h.$('.card.connect');
    if (!card) return;
    const c = st?.comfy;
    const ok = !!(c?.ok && c?.apiKey);
    card.classList.toggle('ok', ok);
    const pill = h.$('#c-conn-pill');
    pill.className = `status ${ok ? 'ok' : 'error'}`;
    pill.textContent = !st ? 'No response' : ok ? `Connected · ${MODE_LABEL[c.mode] || c.mode}` : 'Not connected';
    h.$('#c-conn-balance').innerHTML = c?.balanceUsd != null
      ? `<div class="balance ${c.balanceUsd < (st?.lowThreshold ?? 5) ? 'low' : ''}">Credit balance: <b>$${c.balanceUsd.toFixed(2)}</b>${c.balanceUsd < (st?.lowThreshold ?? 5) ? ` · <a href="https://platform.comfy.org/profile/billing" target="_blank" rel="noopener">buy credits ${icon('external-link', { size: 12 })}</a> (each remake costs ~$0.40–$1.60)` : ''}</div>` : '';
    h.$('#c-smoke-slot').innerHTML = c?.ok ? '<button class="btn" id="c-smoke" title="Runs a minimal workflow (upload and save one image) with no paid nodes">Full test (free)</button>' : '';
    const nodes = Object.entries(c?.nodes || {});
    h.$('#c-conn-status').innerHTML = !st
      ? `<div class="err-box">${icon('x-circle')}Could not check the connection. Press “Test connection”.</div>`
      : c.ok ? (nodes.length ? `<div class="chips">${nodes.map(([k, v]) => `<span class="chip ${v ? 'active' : ''}" style="cursor:default">${v ? icon('check') : icon('x')}${h.esc(k)}</span>`).join('')}</div>` : '')
        : c.error ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(c.error))}</div>` : '';
    const smoke = h.$('#c-smoke');
    if (smoke) smoke.onclick = async () => {
      const out = h.$('#c-result');
      out.textContent = 'Running a test workflow on Comfy…';
      smoke.disabled = true;
      const r = await h.api('/api/pipeline/smoke-test', { method: 'POST' }).catch((e) => ({ ok: false, error: e.message, steps: [] }));
      if (!out.isConnected) return;
      const steps = [].concat(r.steps || []).map((x) => stripEmoji(x));
      out.innerHTML = r.ok
        ? `<span class="msg ok">${icon('check-circle')}Pipeline OK in ${(r.ms / 1000).toFixed(1)} s</span> · ${h.esc(steps.join(' → '))}`
        : `<span class="msg bad">${icon('x-circle')}${h.esc(stripEmoji(r.error))}</span>${steps.length ? ` · ${h.esc(steps.join(' → '))}` : ''}`;
      smoke.disabled = false;
    };
  };
  pipelineStatus().then(paintConn).catch(() => paintConn(null));

  // connect
  h.$$('input[name=cmode]').forEach((r) => (r.onchange = () => {
    h.$$('.mode').forEach((m) => m.classList.toggle('active', m.contains(r) && r.checked));
    h.$('#c-url-wrap').classList.toggle('hidden', r.value !== 'local');
  }));
  const connBody = () => ({ mode: h.$('input[name=cmode]:checked')?.value || s.comfy_mode, apiKey: h.$('#c-key').value.trim(), url: h.$('#c-url').value.trim() });
  h.$('#c-test').onclick = async () => {
    const out = h.$('#c-result');
    const btn = h.$('#c-test');
    out.textContent = 'Testing…';
    btn.disabled = true;
    const r = await h.api('/api/pipeline/test-comfy', { method: 'POST', body: connBody() }).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!out.isConnected) return;
    const missing = Object.entries(r.nodes || {}).filter(([, v]) => !v).map(([k]) => k);
    out.innerHTML = r.ok
      ? `<span class="msg ok">${icon('check-circle')}Connected to ${h.esc(MODE_LABEL[r.mode] && r.mode !== 'local' ? MODE_LABEL[r.mode] : r.url)}</span>${r.balanceUsd != null ? ` · balance $${r.balanceUsd.toFixed(2)}` : missing.length ? ` · missing nodes: ${h.esc(missing.join(', '))}` : ' · all nodes OK'}${r.warning ? ` · <span class="msg warn">${icon('alert-triangle')}${h.esc(stripEmoji(r.warning))}</span>` : ''}${r.apiKey ? '' : ` · <span class="msg warn">${icon('alert-triangle')}No API key</span>`}`
      : `<span class="msg bad">${icon('x-circle')}${h.esc(stripEmoji(r.error))}</span>`;
  };
  h.$('#c-save').onclick = async () => {
    const b = connBody();
    const btn = h.$('#c-save');
    btn.disabled = true;
    try {
      await h.api('/api/settings', { method: 'PUT', body: { comfy_mode: b.mode, comfy_url: b.url, comfy_api_key: b.apiKey } });
      h.toast('Connection saved');
      pipelineStatus(true).catch(() => {});
      renderComfy();
    } catch (e) { h.toast(e.message, true); btn.disabled = false; }
  };
  // import
  h.$('#share-import').onclick = async () => {
    const link = h.$('#share-link').value.trim();
    if (!link) return h.toast('Paste the share link', true);
    h.$('#share-import').disabled = true;
    try {
      const r = await h.api('/api/pipeline/import-share', { method: 'POST', body: { link } });
      h.toast(`Imported: ${r.name} (${r.nodeCount} nodes)`);
      renderComfy();
    } catch (e) { h.toast(e.message, true); h.$('#share-import').disabled = false; }
  };
  h.$('#json-import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await h.api('/api/pipeline/import-json', { method: 'POST', body: { workflow: await f.text(), name: f.name.replace(/\.json$/, '') } });
      h.toast(`Imported: ${r.name} (${r.nodeCount} nodes)`);
      renderComfy();
    } catch (err) { h.toast(err.message, true); }
  };
  h.$$('[data-use]').forEach((b) => (b.onclick = async () => {
    const [id, kind] = b.dataset.use.split('|');
    try {
      await h.api(`/api/pipeline/workflows/${kind}`, { method: 'PUT', body: { importedId: id } });
      h.toast(`Workflow active in the ${kind === 'image' ? 'image' : 'video'} stage. Review the mappings`);
      renderComfy();
    } catch (e) { h.toast(e.message, true); }
  }));
  h.$$('[data-rm-imported]').forEach((b) => (b.onclick = async () => {
    try { await h.api(`/api/pipeline/imported/${b.dataset.rmImported}`, { method: 'DELETE' }); renderComfy(); } catch (e) { h.toast(e.message, true); }
  }));
  h.$$('[data-toggle-graph]').forEach((b) => (b.onclick = () => b.closest('.imp').querySelector('.graph-wrap').classList.toggle('hidden')));
  h.$$('[data-save-map]').forEach((b) => (b.onclick = async () => {
    const kind = b.dataset.saveMap;
    const mapping = {};
    h.$$(`[data-map-kind="${kind}"]`).forEach((sel) => { if (sel.value) mapping[sel.dataset.key] = sel.value; });
    try {
      await h.api(`/api/pipeline/workflows/${kind}`, { method: 'PUT', body: { mapping } });
      h.toast('Mappings saved');
    } catch (e) { h.toast(e.message, true); }
  }));
  h.$$('[data-wf-clear]').forEach((b) => (b.onclick = async () => {
    try { await h.api(`/api/pipeline/workflows/${b.dataset.wfClear}`, { method: 'DELETE' }); renderComfy(); } catch (e) { h.toast(e.message, true); }
  }));
  h.$$('[data-wf-download]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.wfDownload;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(wf.builtin[k].json, null, 2)], { type: 'application/json' }));
    a.download = `reels-radar_${k}_api.json`; a.click();
  }));
}

function importedCard(w) {
  return `<div class="imp">
    <div class="row between">
      <div><b>${h.esc(w.name)}</b> <span class="dim" style="font-size:12px">· ${w.nodeCount} nodes · ${h.esc(w.source)} · ${h.dateTime(w.created_at)}</span>
        <div class="chips" style="margin-top:6px">${w.classes.map((c) => `<span class="chip" style="cursor:default;padding:3px 9px;font-size:11.5px">${h.esc(c)}</span>`).join('')}</div></div>
      <div class="row">
        <button class="btn sm" data-use="${w.id}|image">Use for the image</button>
        <button class="btn sm primary" data-use="${w.id}|video">Use for the video</button>
        <button class="btn sm ghost" data-toggle-graph>View graph</button>
        <button class="icon-btn" data-rm-imported="${w.id}" title="Remove workflow" aria-label="Remove workflow">${icon('trash')}</button>
      </div>
    </div>
    ${w.warnings.length ? `<div class="err-box" style="margin-top:8px">${w.warnings.map((x) => h.esc(stripEmoji(x))).join('<br>')}</div>` : ''}
    <div class="graph-wrap hidden">${graphHtml(w.graph)}</div>
  </div>`;
}

function mappingEditor(kind, inputs, mapping, variables) {
  const opts = (cur) => `<option value="">Keep the workflow value</option>` + Object.entries(variables).map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${h.esc(l)}</option>`).join('');
  const rows = inputs.filter((i) => mapping[i.key] || /image|video|file|prompt|text|seed|duration/i.test(i.input));
  return `<div class="label" style="margin-bottom:6px">Mappings: what the app writes into each workflow input</div>
    <div class="map-list">${rows.map((i) => `<div class="map-row"><div><b>#${h.esc(i.node)} ${h.esc(i.title)}</b><span class="dim"> · ${h.esc(i.input)}</span><div class="dim map-val">${h.esc(String(i.value))}</div></div>
      <select class="input" data-map-kind="${kind}" data-key="${h.esc(i.key)}">${opts(mapping[i.key])}</select></div>`).join('') || '<span class="dim">No mappable inputs.</span>'}</div>`;
}

/** Render an API workflow as columns by depth (sources on the left). */
function graphHtml(graph) {
  const depth = {};
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const d = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const ins = graph.edges.filter((e) => e.to === id);
    return (depth[id] = ins.length ? 1 + Math.max(...ins.map((e) => d(e.from, seen))) : 0);
  };
  graph.nodes.forEach((n) => d(n.id));
  const cols = [];
  graph.nodes.forEach((n) => (cols[depth[n.id]] ||= []).push(n));
  return `<div class="graph">${cols.map((col) => `<div class="gcol">${col.map((n) => {
    const ins = graph.edges.filter((e) => e.to === n.id);
    return `<div class="gnode" title="${h.esc(n.doc)}">
      <div class="gtitle"><span class="dim">#${h.esc(n.id)}</span> ${h.esc(n.title)}</div>
      <div class="gtype">${h.esc(n.type)}</div>
      ${ins.map((e) => `<div class="gin">${h.esc(e.input)} ${icon('arrow-left')} #${h.esc(e.from)} ${h.esc(byId[e.from]?.title || '')}</div>`).join('')}
      ${Object.entries(n.widgets).slice(0, 8).map(([k, v]) => `<div class="gw"><span>${h.esc(k)}</span> ${h.esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`).join('')}
    </div>`;
  }).join('')}</div>`).join(`<div class="garrow">${icon('arrow-right')}</div>`)}</div>`;
}

// =================================================================================
// REMAKE PAGE: reel, download into the app, generate with AI, all in one place
// =================================================================================
let remakeTimer = null;
let reelGensSeq = 0;
let rmRecalc = null; // recomputes cost + flow text of the open remake page
const ENGINES = [
  { key: 'wan3_copy', icon: 'copy', name: 'Exact copy (Wan 3.0)', badge: 'Recommended', min: 2, max: Infinity,
    desc: 'The same video as the original, but with your model: same choreography, gestures, timing, camera and setting.' },
  { key: 'animate_replace', icon: 'user-check', name: 'Swap the person (Wan 2.2 Animate)', min: 1, max: Infinity,
    desc: 'Keeps the original video (mouth, gestures, camera, setting and lighting) and swaps only the person for your model. The open model, on WaveSpeed.' },
  { key: 'wan3', icon: 'film', name: 'Recreate (Wan 3.0)', min: 0, max: Infinity,
    desc: 'Creates a new video inspired by the reel. Less faithful, good for variations.' },
  { key: 'rh_wan_animate', icon: 'cpu', name: 'WAN Animate (your workflow)', min: 1, max: Infinity, needs: 'rh', wf: 'wan_animate',
    desc: 'Her with the pose, the expressions and the mouth of the reel (Wan 2.2 Animate). Runs on RunningHub.' },
  { key: 'rh_nb_wan_animate', icon: 'cpu', name: 'NB WanAnimate (your workflow)', min: 1, max: Infinity, needs: 'rh', wf: 'nb_wan_animate',
    desc: 'Wan 2.2 Animate with relighting: her lighting follows the scene. Runs on RunningHub.' },
  { key: 'rh_ttt_animator', icon: 'cpu', name: 'TTT Animator (your workflow)', min: 1, max: Infinity, needs: 'rh', wf: 'ttt_animator',
    desc: 'Wan 2.2 Animate with pose and face detection: good for dances and full body. Runs on RunningHub.' },
  { key: 'rh_animate_x', icon: 'cpu', name: 'Animate X (your workflow)', min: 1, max: Infinity, needs: 'rh', wf: 'animate_x',
    desc: 'Wan 2.2 Animate done in chunks: handles longer reels. Runs on RunningHub.' },
];
const RH_KEYS = ENGINES.filter((e) => e.needs === 'rh').map((e) => e.key);
// WaveSpeed's prices (27/09), as the server books them.
const COSTS = {
  image: (model, res) => (/pro/i.test(model || '') ? (res === '4K' ? 0.24 : 0.14) : ({ '2K': 0.105, '4K': 0.14 }[res] ?? 0.07)),
  // Wan 3.0 per second of video AND of the reel sent as the reference: the exact copy pays both.
  video: (model, res, secs) => ((/prime/.test(model) ? { '480P': 0.075, '720P': 0.15, '1080P': 0.3 } : { '480P': 0.05, '720P': 0.1, '1080P': 0.2 })[res] ?? 0.1) * secs * 2,
};
// Wan 2.2 Animate on WaveSpeed: per second of the reel, at least 3 s, at most 120 s.
const ANIMATE = { maxSecs: 120, price: { '480P': 0.04, '720P': 0.08, '1080P': 0.08 } };
const animateUsd = (secs, res) => Math.max(3, Math.min(ANIMATE.maxSecs, Math.ceil(Number(secs) || 10))) * (ANIMATE.price[res] ?? 0.08);
const engineKeeps = (key, { keepSound, wanAudio }) => (key === 'animate_replace' || RH_ENGINE_NAME[key] ? (keepSound ? 'Keeps the original audio' : 'No audio')
  : key === 'wan3_copy' ? (keepSound ? 'Keeps the original music' : 'AI-generated audio') : wanAudio ? 'AI-generated audio' : 'No audio');

/** Low balance / connection problems, shown under the cost line once the status check answers. */
function fillRemakeStatus(st, alive) {
  if (!st || !alive()) return;
  const box = h.$('#rm-status');
  if (!box) return;
  const c = st.wavespeed || {};
  const w = [];
  if (c.balanceUsd != null && c.balanceUsd < (st?.lowThreshold ?? 5)) w.push(`Low WaveSpeed balance: <b>$${c.balanceUsd.toFixed(2)}</b> (below $${(st?.lowThreshold ?? 5).toFixed(2)}). <a href="https://wavespeed.ai/top-up" target="_blank" rel="noopener">Top up</a>.`);
  else if (c.apiKey && c.ok === false) w.push(`Could not confirm the WaveSpeed balance: ${h.esc(stripEmoji(c.error || 'no response'))}.`);
  box.innerHTML = w.map(warnCallout).join('');
}

/** "Voltar": back to the page the project was opened from (Projetos, Reels, Revisão…); Projetos when opened directly. */
function backButton() {
  h.$('#topbar-actions').innerHTML = `<button class="btn sm ghost" id="rm-back">${icon('arrow-left')}Back</button>`;
  h.$('#rm-back').onclick = () => { if (history.length > 1) history.back(); else location.hash = '#/projects'; };
}

// Her assets (places, outfits) per model, shared by the place select and the outfit picker of one page.
const assetsCache = new Map();
const modelAssets = (modelId) => {
  if (!modelId) return Promise.resolve([]);
  if (!assetsCache.has(modelId)) {
    assetsCache.set(modelId, h.api(`/api/models/${modelId}/assets`).catch(() => { assetsCache.delete(modelId); return []; }));
  }
  return assetsCache.get(modelId);
};

export async function renderRemake(params) {
  clearTimeout(remakeTimer);
  rmOutfit = null; // an outfit picked on another reel must never carry over
  rmRecalc = null;
  assetsCache.clear();
  const id = Number(params.get('id'));
  if (!id) { location.hash = '#/reels'; return; }
  if (Number(params.get('gen'))) rmSel.set(id, Number(params.get('gen'))); // that project's steps below
  const alive = () => onReel(id);
  const stP = pipelineStatus().catch(() => null); // never blocks the first paint
  let reel; let models; let s;
  try {
    [reel, models, s] = await Promise.all([h.api(`/api/reels/${id}`), h.api('/api/models'), h.api('/api/settings')]);
  } catch (e) {
    if (alive()) h.$('#view').innerHTML = errorState(e);
    return;
  }
  if (!alive()) return;
  if (reel.media_type && reel.media_type !== 'video') return renderPhotoRemake(reel, models, s, params, alive, stP);
  const engineOk = keysOk(s);
  // Her RunningHub video workflows appear only once configured; the others are always listed.
  const engines = ENGINES.filter((e) => e.needs !== 'rh' || rhOn(s, e.wf));
  const rhHidden = ENGINES.some((e) => e.needs === 'rh' && !rhOn(s, e.wf));
  const frames = frameOptions(s);
  const withImage = 'kling_motion wan3 wan3_copy animate_replace ' + RH_KEYS.join(' ');
  const first = models.find((m) => m.readiness.ready) || models[0];
  h.$('#page-title').textContent = 'Create remake';
  backButton();
  const sel = (name, list, cur) => `<select class="input" data-opt="${name}">${list.map(([v, l]) => `<option value="${h.esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${h.esc(l)}</option>`).join('')}</select>`;
  const audio0 = { keepSound: s.keep_original_sound !== '0', wanAudio: s.wan_audio === '1' };
  h.$('#view').innerHTML = `
    <div class="rm-step-head"><span class="gs-n">1</span><b>Source</b><span class="dim">choose the video frame and generate her images. Then steps 2 to 7 continue down here.</span></div>
    <div class="remake-grid">
      <section class="card">
        <div class="row between"><h3 style="margin:0">Original reel</h3><a class="btn sm ghost" href="${h.esc(reel.url)}" target="_blank" rel="noopener">${icon('external-link')}Open in ${reel.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</a></div>
        <div class="creator-cell" style="margin:10px 0"><div><div class="h">@${h.esc(reel.handle)} <span class="pf ${reel.platform}">${h.PF[reel.platform]}</span></div>
          <div class="d">${h.fmt(reel.views)} views · ${h.fmt(reel.likes)} likes${reel.ftvr != null ? ` · ${h.ratio(reel.ftvr)} FTVR` : ''} · ${h.ago(reel.posted_at)} ago</div></div></div>
        <div class="rm-player" id="rm-player"><div class="loading"><div class="spinner"></div>${reel.video_path ? 'Loading…' : 'Downloading the reel into the app…'}</div></div>
        <div class="fr-bar" id="rm-fbar" hidden>
          <input type="range" id="rm-fslider" min="1" max="1" step="1" value="1" aria-label="Choose the video frame">
          <div class="fr-info">
            <button class="btn sm ghost icon-only" id="rm-fprev" title="Previous frame" aria-label="Previous frame">${icon('chevron-left')}</button>
            <span id="rm-fnum">Frame 1</span>
            <button class="btn sm ghost icon-only" id="rm-fnext" title="Next frame" aria-label="Next frame">${icon('chevron-right')}</button>
            <span class="dim" id="rm-ftime"></span>
          </div>
        </div>
        <div class="frame-pick" style="margin-top:10px">
          <div class="frame-thumb" id="rm-frame" style="${reel.frame_path || reel.thumb_path ? `background-image:url('${media(reel.frame_path || reel.thumb_path)}')` : ''}"></div>
          <div style="flex:1"><b style="font-size:13px">Reference frame <span id="rm-frame-tag">${frameTag(reel.frame_path)}</span></b>
            <div class="dim" style="font-size:12px">Your model is placed in this frame. By default it is the start of the video; for another one, drag the bar under the video to the frame you want and press “Use this frame”.</div>
            <button class="btn sm" id="rm-grab" style="margin-top:6px">${icon('camera')}Use this frame</button></div>
        </div>
        ${reel.caption ? `<div class="dim" style="font-size:12px;margin-top:10px;max-height:60px;overflow:auto">${h.esc(reel.caption)}</div>` : ''}
      </section>

      <section class="card stack">
        <div class="preflight" id="rm-preflight"><span class="dim"><span class="spinner inline"></span> Analyzing the reel before spending credits…</span></div>
        <h3 style="margin:0">Model</h3>
        ${models.length ? `<div class="model-pick">${models.map((m) => {
          const cover = m.ref_images.find((r) => r.kind === 'face_front') || m.ref_images[0];
          return `<label class="mp ${m.id === first?.id ? 'active' : ''} ${m.readiness.ready ? '' : 'off'}">
            <input type="radio" name="rm-model" value="${m.id}" ${m.id === first?.id ? 'checked' : ''} ${m.readiness.ready ? '' : 'disabled'}>
            <div class="mp-img" style="${cover ? `background-image:url('${media(cover.path)}')` : ''}">${cover ? '' : h.esc(m.name[0])}</div>
            <div><b>${h.esc(m.name)}</b><div class="dim" style="font-size:11.5px">${m.readiness.ready ? `${m.ref_images.length} photos · ${m.readiness.score}%` : 'Empty folder'}</div></div>
          </label>`;
        }).join('')}</div>` : warnCallout('No models yet. <a href="#/models">Create one and upload the photos</a>.')}
        <div class="rm-go-opts">
          <label class="field" data-for="wan3_copy"><span>Images with</span>${sel('firstFrameSel', [...frames.map(([v, l]) => [v, `${FIRST_FRAME_NAME[v] || l}: her in the video frame`]), ['own', 'My image (upload)']], frameDefault(s))}</label>
          <label class="field" data-for="${withImage}" data-noedit><span>How many images</span>${sel('variants', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], s.nb_variants)}</label>
        </div>
        <div class="gs-opts" id="rm-swapopts">
          <label class="check"><input type="checkbox" data-swapopt="noHairclips">No hair clips</label>
          <label class="check"><input type="checkbox" data-swapopt="noTattoos">No tattoos</label>
          <label class="field inline"><span>Top color</span><select class="input" data-swapopt="topColor">${TOP_COLOR_PT.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        </div>
        <div class="own-img hidden" id="rm-own">
          <div class="own-prev" id="rm-own-prev">${icon('image')}</div>
          <div class="stack" style="gap:6px;flex:1;min-width:0">
            <b style="font-size:13px">Your image</b>
            <span class="dim" style="font-size:12px">An image of her already made (for example in another tool). No image is generated: this one goes on to step 4, with the same quality check.</span>
            <div class="row"><label class="btn sm">${icon('upload')}Choose image<input type="file" id="rm-own-file" accept="image/png,image/jpeg,image/webp" hidden></label><span class="dim" id="rm-own-name" style="font-size:12px">None chosen</span></div>
          </div>
        </div>
        <details class="pp" id="rm-pp" open hidden>
          <summary>${icon('edit')}<b>Image prompt</b><span class="status new hidden" id="rm-pp-tag">Edited</span><span class="dim pp-sum">what will be requested; you can edit it before generating</span><span class="pp-chev">${icon('chevron-down')}</span></summary>
          <textarea class="input" id="rm-pp-text" rows="6" spellcheck="false" data-prompt aria-label="Image prompt"></textarea>
          <div class="row between"><span class="dim" id="rm-pp-note" style="font-size:12px"></span><button class="btn sm ghost" id="rm-pp-reset" disabled>${icon('rotate-ccw')}Reset to default</button></div>
        </details>
        <div class="dim" style="font-size:12.5px" id="rm-cost"></div>
        <div id="rm-status" class="stack" style="gap:8px"></div>
        ${!engineOk ? `<div id="rm-keys">${warnCallout('First paste the WaveSpeed API key in <a href="#/setup">Settings → Pipeline</a>: it makes the images, the enlargement and the video.')}</div>` : ''}
        <button class="btn primary big" id="rm-go" ${engineOk && models.some((m) => m.readiness.ready) ? '' : 'disabled'}>${icon('play-circle')}Generate</button>
      </section>
    </div>
    <div id="rm-gens" class="rm-steps"></div>`;

  // model radio styling
  h.$$('input[name=rm-model]').forEach((r) => (r.onchange = () => { h.$$('.mp').forEach((l) => l.classList.toggle('active', l.contains(r) && r.checked)); loadUniverseSelects(); }));
  loadUniverseSelects();
  // cost + flow
  const engine = () => 'wan3_copy'; // the reference's flow: an exact copy of the reel (Wan 3.0), step by step
  const cfg = () => {
    const c = { videoEngine: engine() };
    h.$$('[data-opt]').forEach((x) => (c[x.dataset.opt] = x.value === 'true' ? true : x.value === 'false' ? false : x.dataset.opt === 'variants' ? Number(x.value) : x.value));
    const o = {};
    h.$$('#rm-swapopts [data-swapopt]').forEach((x) => { if (x.type === 'checkbox') { if (x.checked) o[x.dataset.swapopt] = true; } else if (x.value) o[x.dataset.swapopt] = x.value; });
    if (Object.keys(o).length) c.swapOptions = o; // step 1: no hair clips / no tattoos / top colour
    // Cópia exata: "1.º frame" says who makes her first frame (Nano Banana 2 / Pro, Seedream 5.0, Flux.2, your image) or Direto.
    const ff = c.firstFrameSel;
    delete c.firstFrameSel;
    if (c.videoEngine === 'wan3_copy' && ff) { if (ff === 'direct') c.firstFrame = 'direct'; else { c.firstFrame = 'nano'; c.frameEngine = ff; } }
    // Fixed, as in the reference: step by step, the reel's music and outfit; the video model is chosen in step 4.
    Object.assign(c, { videoEngine: 'wan3_copy', autoApprove: false, keepSound: true, keepOutfit: true, wanModel: s.wan_model, wanResolution: s.wan_resolution });
    // "Nano Banana 2" is NB 2 even when Definições use Pro (as the card's own engine select does).
    if (c.frameEngine === 'nano' && /pro/i.test(s.nb_model_comfy || '')) c.nbModel = NB_2;
    return c;
  };
  const cost = () => {
    if (!alive() || !h.$('#rm-cost')) return;
    const c = cfg();
    const direct = c.videoEngine === 'wan3_copy' && c.firstFrame === 'direct';
    const isEdit = ['wan27_edit', 'kling_edit'].includes(c.videoEngine) || direct;
    // show only the options that this engine really uses
    h.$$('[data-for]').forEach((el) => {
      const f = el.dataset.for.split(' ');
      const applies = f.includes(c.videoEngine) || (isEdit && f.includes('edit'));
      el.classList.toggle('hidden', !applies || (isEdit && el.hasAttribute('data-noedit')));
    });
    h.$$('.eng').forEach((l) => l.classList.toggle('active', l.querySelector('input').checked));
    for (const k of ['wan3_copy', 'animate_replace', ...RH_KEYS]) {
      const el = h.$(`[data-keeps="${k}"]`);
      if (el) el.textContent = engineKeeps(k, { keepSound: c.keepSound !== false });
    }
    const nb = s.image_engine === 'gemini' ? s.nb_model_gemini : s.nb_model_comfy;
    const reelSecs = Math.round(reel.duration || 10);
    const rhVid = !!RH_ENGINE_NAME[c.videoEngine];
    const ownImg = !isEdit && c.frameEngine === 'own'; // "A minha imagem": no image is generated (nor paid for)
    h.$('#rm-own').classList.toggle('hidden', !ownImg);
    if (ownImg) ['variants', 'imageFinish'].forEach((k) => h.$(`[data-opt="${k}"]`)?.closest('.field')?.classList.add('hidden'));
    const frameKey = isEdit ? 'nano' : c.frameEngine || 'nano';
    const rhImg = RH_FRAME.includes(frameKey);
    const finish = !isEdit && !ownImg && c.imageFinish === 'instagirl';
    // Per image: Nano Banana, Seedream, Flux.2 or Wan 2.7 on WaveSpeed; her RunningHub workflow is paid there. A chosen
    // outfit adds a Nano Banana try-on edit.
    const perImage = rhImg || ownImg ? 0 : frameKey === 'nanopro' ? COSTS.image(NB_PRO, s.nb_resolution) : EDITOR_COST[frameKey] ?? COSTS.image(c.nbModel || nb, s.nb_resolution);
    const imgCost = isEdit || ownImg ? 0 : (perImage + (rmOutfit ? COSTS.image(nb, s.nb_resolution) : 0)) * c.variants;
    // Her model's "Aumento automático" (Perfis): with Automático the chosen image is edited before the video. Same engine
    // rule as the server: her editor, else the person-swap editor when it is Flux.2 or Seedream, else Nano Banana.
    const md = models.find((m) => m.id === Number(h.$('input[name=rm-model]:checked')?.value));
    const enlN = !isEdit && !ownImg && c.autoApprove === true && md?.edit_auto ? Math.max(1, Math.min(4, Number(md.edit_n) || 1)) : 0;
    const enlKey = md?.edit_engine || (s.wavespeed_api_key_set ? 'wan27' : 'seedream'); // Wan 2.7 (the reference's) unless her model has another editor
    const manual = c.autoApprove !== true && !isEdit; // her own image too: it stops at step 4
    const enlLater = manual && !ownImg ? Math.max(1, Math.min(4, Number(md?.edit_n) || 2)) : 0; // step 3, when you choose the swap
    const enlCost = enlN * (ENL_COST[enlKey] ?? COSTS.image(nb, s.nb_resolution));
    // No WaveSpeed needed when both steps run on her RunningHub workflows and no outfit is put on.
    const needWs = !(((rhImg && !rmOutfit) || ownImg) && rhVid);
    const goBtn = h.$('#rm-go');
    if (goBtn && !goBtn.dataset.busy) goBtn.disabled = !(models.some((m) => m.readiness.ready) && (engineOk || !needWs));
    h.$('#rm-keys')?.classList.toggle('hidden', !needWs);
    let vidCost; let secs = reelSecs;
    if (rhVid) { secs = Math.min(Number(s.rh_max_secs) || 30, Math.max(1, reelSecs)); vidCost = 0; }
    else if (c.videoEngine === 'kling_motion') vidCost = (c.klingMode === 'pro' ? 0.168 : 0.126) * secs;
    else if (c.videoEngine === 'kling_edit') vidCost = (c.wanResolution === '1080P' ? 0.168 : 0.126) * secs;
    else if (c.videoEngine === 'wan27_edit') vidCost = (c.wanResolution === '1080P' ? 0.15 : 0.1) * secs * 2;
    else if (c.videoEngine === 'animate_replace') { secs = Math.min(ANIMATE.maxSecs, Math.max(1, reelSecs)); vidCost = animateUsd(secs, c.wanResolution); }
    else if (c.videoEngine === 'wan3_copy') { secs = Math.min(15, Math.max(2, reelSecs)); vidCost = COSTS.video(c.wanModel, c.wanResolution, secs); }
    else { secs = c.wanDuration === 'auto' ? Math.min(15, Math.max(5, reelSecs)) : Number(c.wanDuration); vidCost = COSTS.video(c.wanModel, c.wanResolution, secs); }
    const rhPart = rhVid || rhImg || finish;
    const rhWhat = [rhImg && `${c.variants} image(s)`, finish && 'realism', rhVid && `~${secs} s of video`].filter(Boolean).join(' + ');
    const enlLaterCost = enlLater * (ENL_COST[enlKey] ?? COSTS.image(nb, s.nb_resolution));
    const imgName = FIRST_FRAME_NAME[frameKey] || 'AI';
    if (goBtn && !goBtn.dataset.busy) goBtn.innerHTML = `${icon('play-circle')}${manual ? (ownImg ? 'Continue · your image, no cost now' : `Generate · ${h.esc(imgName)} · ~${usd(imgCost)}`) : `Generate · everything · ~${usd(imgCost + enlCost + vidCost)}`}`;
    h.$('#rm-cost').innerHTML = manual && ownImg
      ? `Now: <b style="color:var(--text)">nothing is paid</b> (your image is not generated). Later, at step 4, only when you press “Generate video”: ${rhVid ? 'video paid by GPU time on RunningHub' : `video ~${usd(vidCost)} (~${secs} s)`}.`
      : manual && !rhPart
      ? `Now: <b style="color:var(--text)">~${usd(imgCost)}</b> (${c.variants} swap image(s)). Later, in the steps down here, only when you press: enlargement ~${usd(enlLaterCost)} (${enlLater} image(s)) and video ~${usd(vidCost)} (~${secs} s).`
      : rhPart
      ? (imgCost + enlCost + vidCost > 0
        ? `Estimated cost: <b style="color:var(--text)">~${usd(imgCost + enlCost + vidCost)}</b> + GPU time on RunningHub (${rhWhat}), charged to your RunningHub account`
        : `Cost: <b style="color:var(--text)">GPU time on RunningHub</b> (${rhWhat}), charged to your RunningHub account`)
      : `Estimated cost: <b style="color:var(--text)">~${usd(imgCost + enlCost + vidCost)}</b> (${isEdit || ownImg ? '' : `${c.variants} image(s) + `}${enlN ? `${enlN} edit(s) + ` : ''}~${secs} s of video)`;
    // What will really happen, built from the options that are selected right now.
    const ownPlace = !!Number(h.$('#rm-place')?.value);
    const outfit = ownImg ? 'outfit from your image' : rmOutfit ? 'chosen outfit' : c.keepOutfit === 'covered' ? 'more covered outfit' : c.keepOutfit === false ? 'outfit from her photos' : 'outfit from the video';
    const place = ownImg ? 'setting from your image' : ownPlace && !direct ? 'her setting' : 'setting from the video';
    const lines = [];
    const who = ownImg ? 'Your image goes on without generating any image' : {
      wan27: 'Wan 2.7 places your model in the video frame', wan27pro: 'Wan 2.7 Pro places your model in the video frame',
      nano: 'Nano Banana 2 places your model in the video frame', nanopro: 'Nano Banana Pro places your model in the video frame', flux: 'Flux.2 places your model in the video frame', seedream: 'Seedream places your model in the video frame',
      sky: 'Your Z-Image SKY workflow redoes the video frame with her (her LoRA)', faceswap: 'Your INSTARAW Faceswap workflow swaps the face and hair in the video frame for hers',
    }[frameKey]
      + (finish ? ', WAN 2.2 Instagirl refines the skin and lighting of that image' : '');
    if (rhVid) {
      lines.push(`${who}, and your ${RH_ENGINE_NAME[c.videoEngine]} workflow on RunningHub gives her the pose, the expressions and the mouth of the reel (${secs} s). Result: ${outfit}, setting from the video, ${c.keepSound !== false ? 'original audio' : 'no audio'}.`);
    } else if (c.videoEngine === 'wan3_copy') {
      lines.push(`${direct ? 'Her photos go straight to Wan 3.0, which copies the reel' : `${who}, and Wan 3.0 copies the reel with her`}. Result: ${outfit}, ${place}, ${c.keepSound !== false ? 'original music' : 'generated audio'}.`);
    } else if (c.videoEngine === 'animate_replace') {
      lines.push(`${who}, and Wan 2.2 Animate swaps the person in the whole original video for her: the mouth, gestures, camera, setting and lighting are those of the video. Result: ${outfit}, ${c.keepSound !== false ? 'original audio' : 'no audio'}.`);
    } else {
      lines.push(`${who}, and Wan 3.0 ${c.wanMode === 'r2v' ? 'follows the motion of the reel (R2V, up to 15 s)' : 'animates that frame (I2V)'}. Result: ${outfit}, ${place}, ${s.wan_audio === '1' ? 'generated audio' : 'no audio'}.`);
    }
    if (manual && ownImg) lines.push('Step by step: your image is ready at step 4 and the video is generated only when you press “Generate video”.');
    if (manual && !ownImg) lines.push(`Step by step: 2) you choose one of the ${c.variants} images; 3) the enlargement makes ${enlLater} version(s) with a bigger bust (${h.esc(editName(enlKey))}) and you choose one, or none; 4) the video is generated only when you press “Generate video”.`);
    if (enlN) lines.push(`Automatic enlargement (${h.esc(md.name)} in Profiles): before the video, the chosen image is edited (${enlN} variant(s), ~${usd(enlCost)}) and the video starts from the best edit; if the editor refuses, the original goes on.`);
    if (frameKey === 'sky') lines.push('SKY uses her Z-Image LoRA entered in Settings → RunningHub: without it the generation stops before spending.');
    if (ownImg && (rmOutfit || ownPlace)) lines.push('With your image, the outfit and setting chosen above do not apply: everything stays as it is in the image.');
    if (rmOutfit && !ownImg) {
      lines.push(direct
        ? 'Chosen outfit: the garment goes in as a reference for Wan 3.0.'
        : 'Chosen outfit: the garment is isolated (only the first time), the model is placed in the scene and the outfit is checked; if it does not match, only the outfit is swapped and checked again. The video starts only once the outfit is confirmed; if that fails, it stops before the video and you spend no video credits.');
    }
    if (direct && ownPlace) lines.push('Her setting only applies with the Nano Banana 1st frame.');
    const warn = c.videoEngine === 'wan3_copy' && reelSecs > 15
      ? `<div><span class="msg warn">${icon('alert-triangle')}The reel is ${reelSecs} s long: Wan 3.0 accepts up to 15 s of reference, so the copy keeps the first 15 s${c.keepSound !== false ? ' (and the music of those 15 s)' : ''}.</span></div>`
      : rhVid && reelSecs > secs
        ? `<div><span class="msg warn">${icon('alert-triangle')}The reel is ${reelSecs} s long: the workflow uses the first ${secs} s (change the maximum in Settings → RunningHub).</span></div>` : '';
    if (h.$('#rm-flow')) h.$('#rm-flow').innerHTML = lines.map((l, i) => `<div>${i === 0 ? '<b>Flow:</b> ' : ''}${l}</div>`).join('') + warn + (c.videoEngine === 'animate_replace' && reelSecs > ANIMATE.maxSecs
      ? `<div><span class="msg warn">${icon('alert-triangle')}The reel is ${reelSecs} s long: the swap uses the first ${ANIMATE.maxSecs} s.</span></div>` : '');
    loadPP();
  };

  // Image prompt: built by the server from the choices above (the same text the image step would send) and shown
  // before anything is paid. Once edited it is yours: option changes no longer overwrite it, and it goes as written.
  const pp = { def: '', edited: false, seq: 0, timer: null };
  const ppText = h.$('#rm-pp-text');
  const paintPP = () => {
    h.$('#rm-pp-tag').classList.toggle('hidden', !pp.edited);
    h.$('#rm-pp-reset').disabled = !pp.edited;
  };
  function loadPP() {
    clearTimeout(pp.timer);
    pp.timer = setTimeout(async () => {
      const modelId = Number(h.$('input[name=rm-model]:checked')?.value);
      if (!alive() || !modelId || !h.$('#rm-pp')) return;
      const seq = ++pp.seq;
      if (cfg().frameEngine === 'own') { h.$('#rm-pp').hidden = true; return; } // her own image: nothing is generated
      let r;
      try {
        r = await h.api(`/api/reels/${id}/image-prompt`, { method: 'POST', body: { modelId, prompt: h.$('#rm-prompt')?.value || '', config: { ...cfg(), ...universeCfg() } } });
      } catch (e) {
        if (seq === pp.seq && alive() && h.$('#rm-pp-note')) h.$('#rm-pp-note').textContent = `Could not build the prompt: ${stripEmoji(e.message)}`;
        return;
      }
      const box = h.$('#rm-pp');
      if (seq !== pp.seq || !alive() || !box) return;
      box.hidden = !r.prompt; // her RunningHub workflow, or a remake type without an image step: no prompt to show
      if (!r.prompt) return;
      pp.def = r.prompt;
      if (!pp.edited) ppText.value = r.prompt;
      h.$('#rm-pp-note').textContent = pp.edited
        ? 'Edited by you: it goes as it is. “Reset to default” goes back to the app prompt.'
        : r.refLayout ? `Image 1 = her photo; image 2 = reel frame${r.images > 2 ? '; the next ones = the chosen outfit or setting' : ''} (as in the reference app).`
        : `Image 1 = reel frame; images 2 to ${r.images} = her photos${r.images > 4 ? ' and the chosen outfit or setting' : ''}.`;
    }, 350);
  }
  ppText.oninput = () => {
    pp.edited = ppText.value.trim() !== pp.def.trim();
    paintPP();
    h.$('#rm-pp-note').textContent = pp.edited ? 'Edited by you: it goes as it is. “Reset to default” goes back to the app prompt.' : '';
  };
  h.$('#rm-pp-reset').onclick = () => { pp.edited = false; ppText.value = pp.def; paintPP(); loadPP(); };
  h.$('#rm-prompt')?.addEventListener('input', () => loadPP());

  // "A minha imagem": read (and scaled to at most 2048 px) as soon as it is picked, sent with "Gerar remake".
  let ownData = null;
  h.$('#rm-own-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      ownData = await imageFileToDataUrl(file, 2048);
      h.$('#rm-own-prev').innerHTML = `<img src="${ownData}" alt="">`;
      h.$('#rm-own-name').textContent = file.name;
    } catch (err) { ownData = null; h.toast(err.message, true); }
    e.target.value = '';
  };

  rmRecalc = cost;
  h.$$('[data-opt], input[name=rm-engine], #rm-swapopts [data-swapopt]').forEach((x) => (x.onchange = cost));
  if (h.$('#rm-place')) h.$('#rm-place').onchange = cost;
  if (!h.$('input[name=rm-engine]:checked')) { const firstEng = h.$('input[name=rm-engine]:not([disabled])'); if (firstEng) firstEng.checked = true; }
  cost();
  stP.then((st) => fillRemakeStatus(st, alive));

  // download + player
  const setFrame = (frame_path) => {
    if (!alive() || !frame_path || !h.$('#rm-frame')) return;
    reel.frame_path = frame_path;
    h.$('#rm-frame').style.backgroundImage = `url('${media(frame_path)}')`;
    const tag = h.$('#rm-frame-tag');
    if (tag) tag.innerHTML = frameTag(frame_path);
  };
  // Frame picker: a bar with one step per frame of the reel (fps read by the server), like scrubbing a timeline.
  const fr = { fps: 30, frames: 0 };
  const frameOf = (v) => Math.min(fr.frames, Math.floor(v.currentTime * fr.fps + 1e-3) + 1);
  const setupFrameBar = async (v) => {
    let meta = null;
    try { meta = await h.api(`/api/reels/${id}/meta`); } catch {}
    const bar = h.$('#rm-fbar');
    if (!alive() || !bar || !v.isConnected) return;
    const start = () => {
      fr.fps = meta?.fps || 30;
      fr.frames = Math.max(1, meta?.frames || Math.round((v.duration || 0) * fr.fps));
      if (!fr.frames || !Number.isFinite(v.duration)) return;
      const slider = h.$('#rm-fslider');
      slider.max = String(fr.frames);
      const paint = () => {
        const n = frameOf(v);
        if (document.activeElement !== slider) slider.value = String(n);
        h.$('#rm-fnum').textContent = `Frame ${n} / ${fr.frames}`;
        h.$('#rm-ftime').textContent = `${fmtS(v.currentTime)} s · ${String(Math.round(fr.fps * 100) / 100)} fps`;
      };
      const go = (n) => {
        n = Math.max(1, Math.min(fr.frames, n));
        v.pause();
        v.currentTime = Math.min(v.duration - 0.001, (n - 0.5) / fr.fps); // middle of the frame: never lands on the one before
        slider.value = String(n);
        paint();
      };
      slider.oninput = () => go(Number(slider.value));
      h.$('#rm-fprev').onclick = () => go(frameOf(v) - 1);
      h.$('#rm-fnext').onclick = () => go(frameOf(v) + 1);
      v.addEventListener('timeupdate', paint);
      v.addEventListener('seeked', paint);
      bar.hidden = false;
      paint();
    };
    if (v.readyState >= 1) start(); else v.addEventListener('loadedmetadata', start, { once: true });
  };
  const showVideo = (src) => {
    if (!alive()) return;
    const p = h.$('#rm-player');
    if (!p) return;
    const v = document.createElement('video');
    v.controls = true; v.loop = true; v.playsInline = true; v.muted = true; v.src = src;
    v.onerror = () => { if (p.isConnected) p.innerHTML = `<div class="loading">Could not play the video. <a href="${h.esc(reel.url)}" target="_blank" rel="noopener" style="color:var(--accent)">View the original</a></div>`; const bar = h.$('#rm-fbar'); if (bar) bar.hidden = true; };
    p.innerHTML = '';
    p.appendChild(v);
    setupFrameBar(v);
  };
  // Preflight: is this reel a good fit for an exact copy? (cached per reel, ~0.1 cêntimo)
  let preflight = null;
  try { preflight = reel.preflight ? JSON.parse(reel.preflight) : null; } catch {}
  const paintPreflight = (p, err) => {
    if (!alive()) return;
    const box = h.$('#rm-preflight');
    if (!box) return;
    if (err || !p || typeof p !== 'object') {
      box.className = 'preflight';
      box.innerHTML = `<div class="row between"><span class="dim">Reel analysis unavailable: ${h.esc(stripEmoji(err || 'invalid response'))}</span><button class="btn sm ghost" id="pf-again">${icon('refresh')}Try again</button></div>`;
    } else {
      const reasons = [].concat(p.reasons || []).map((x) => stripEmoji(x));
      const v = { good: ['ok', 'check-circle', 'Good for an exact copy'], risky: ['warn', 'alert-triangle', 'Risky'], bad: ['bad', 'x-circle', 'Not recommended for an exact copy'] }[p.verdict] || ['warn', 'alert-triangle', String(p.verdict || 'No verdict')];
      const flags = [p.outfit_changes && 'outfit change', p.undressing && 'undressing or nudity', p.face_closeup_talking && 'talking close-up (the original face tends to come through)', p.multiple_people && 'several people', p.text_on_clothes && 'text on clothes (comes out garbled)', p.revealing_outfit && 'low neckline (the Wan 3.0 filter may refuse)', p.source_piercings && 'creator has piercings', p.source_tattoos && 'creator has tattoos'].filter(Boolean);
      box.className = `preflight ${v[0]}`;
      box.innerHTML = `<div class="row between"><b>${icon(v[1])}Reel analysis: ${h.esc(v[2])}</b><button class="btn sm ghost icon-only" id="pf-again" title="Analyze again" aria-label="Analyze again">${icon('refresh')}</button></div>
        ${reasons.length ? `<div style="font-size:12.5px;margin-top:4px">${reasons.map(h.esc).join(' ')}</div>` : ''}
        ${flags.length ? `<div class="pchips" style="margin-top:6px">${flags.map((f) => `<span class="pchip">${h.esc(f)}</span>`).join('')}</div>` : ''}
        ${p.advice ? `<div style="margin-top:6px;font-size:12px"><span class="msg">${icon('lightbulb')}${h.esc(stripEmoji(p.advice))}</span></div>` : ''}`;
    }
    const again = h.$('#pf-again');
    if (again) again.onclick = () => runPreflight(true);
  };
  const runPreflight = async (force = false) => {
    if (!alive()) return;
    const box = h.$('#rm-preflight');
    if (box) { box.className = 'preflight'; box.innerHTML = '<span class="dim"><span class="spinner inline"></span> Analyzing the reel before spending credits…</span>'; }
    try {
      const r = await h.api(`/api/reels/${id}/preflight`, { method: 'POST', body: { force } });
      if (!alive()) return;
      preflight = r;
      paintPreflight(r);
    } catch (e) { paintPreflight(null, e.message); }
  };
  if (preflight) { try { paintPreflight(preflight); } catch { preflight = null; paintPreflight(null, 'invalid response'); } }
  if (reel.video_path) {
    showVideo(reelVideoUrl(reel));
    if (!reel.frame_path) h.api(`/api/reels/${id}/download`, { method: 'POST' }).then((r) => { if (!reel.frame_path) setFrame(r?.frame_path); }).catch(() => {});
    if (!preflight) runPreflight();
  } else {
    h.api(`/api/reels/${id}/download`, { method: 'POST' })
      .then((r) => {
        if (!alive()) return;
        showVideo(reelVideoUrl(reel));
        h.toast('Reel saved to the Library');
        if (!reel.frame_path) setFrame(r?.frame_path);
        if (!preflight) runPreflight();
      })
      .catch((e) => {
        if (!alive()) return;
        const p = h.$('#rm-player');
        if (p) p.innerHTML = `<div class="loading">${h.esc(stripEmoji(e.message))}<br><br>You can still generate from the reel cover.</div>`;
        const b = h.$('#rm-preflight');
        if (b && !preflight) { b.className = 'preflight'; b.innerHTML = '<span class="dim">Analysis unavailable: the video was not downloaded.</span>'; }
      });
  }
  h.$('#rm-grab').onclick = async () => {
    const v = h.$('#rm-player video');
    if (!v || !v.videoWidth) return h.toast('Wait for the video to load', true);
    if (v.seeking) await new Promise((r) => v.addEventListener('seeked', r, { once: true })); // the frame the bar points at, not the one before
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    try {
      const { frame_path } = await h.api(`/api/reels/${id}/frame`, { method: 'POST', body: { image: c.toDataURL('image/jpeg', 0.93) } });
      setFrame(frame_path);
      h.toast(fr.frames ? `Frame ${frameOf(v)} (${fmtS(v.currentTime)} s) chosen` : `Frame captured at ${v.currentTime.toFixed(1)} s`);
    } catch (e) { h.toast(e.message, true); }
  };
  h.$('#rm-go').onclick = async () => {
    const go = h.$('#rm-go');
    const modelId = Number(h.$('input[name=rm-model]:checked')?.value);
    if (!modelId) return h.toast('Choose the model', true);
    const config = { ...cfg(), ...universeCfg() };
    const own = config.frameEngine === 'own' && !['wan27_edit', 'kling_edit'].includes(config.videoEngine) && !(config.videoEngine === 'wan3_copy' && config.firstFrame === 'direct');
    if (config.frameEngine === 'own') config.frameEngine = frameDefault(s); // not an engine: the server keeps its default
    if (own && !ownData) { h.$('#rm-own')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return h.toast('Choose your image first', true); }
    if (preflight?.verdict === 'bad' && engine() === 'wan3_copy'
      && !confirm(`The analysis says this reel is NOT suitable for an exact copy:\n\n${[].concat(preflight.reasons || []).map((x) => stripEmoji(String(x))).join('\n')}\n\nGenerate anyway (spends credits)?`)) return;
    go.disabled = true;
    go.dataset.busy = '1';
    try {
      const extra = own ? { ownImage: ownData } : pp.edited && !h.$('#rm-pp').hidden ? { imagePrompt: ppText.value } : {};
      const g = await h.api(`/api/reels/${id}/remake`, { method: 'POST', body: { modelId, prompt: h.$('#rm-prompt')?.value || '', config, ...extra } });
      const straight = ['wan27_edit', 'kling_edit'].includes(config.videoEngine) || (config.videoEngine === 'wan3_copy' && config.firstFrame === 'direct');
      h.toast(`Project #${g.id}: ${straight ? 'the video started (step 4, down here)' : own ? (config.autoApprove ? 'your image goes on to the video (step 4, down here)' : 'your image is at step 4, down here') : config.autoApprove ? 'Automatic: the images and the video go on by themselves (down here)' : 'generating the swap images (step 2, down here)'}`);
      studioBadge();
      if (alive()) { rmSel.set(id, g.id); keepGenInUrl(id, g.id); await loadReelGens(id); h.$('#rm-gens')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } catch (e) { h.toast(e.message, true); }
    delete go.dataset.busy;
    if (alive() && go.isConnected) cost();
  };
  loadReelGens(id);
}

/** The project shown under each Remake page (reel id → generation id): the latest, unless you pick another. */
const rmSel = new Map();
/** The address says which project is shown (a reload opens the same one), without redrawing the page. */
const keepGenInUrl = (reelId, genId) => { if (onReel(reelId)) history.replaceState(null, '', `#/remake/${reelId}?gen=${genId}`); };

/**
 * Under the Remake page (step 1), the steps 2–7 of this reel's project, as in the reference app: after "Gerar" you
 * stay here and go on step by step. More than one project of this reel: tabs to switch between them.
 */
async function loadReelGens(reelId) {
  clearTimeout(remakeTimer);
  if (!onReel(reelId) || !h.$('#rm-gens')) return;
  const seq = ++reelGensSeq;
  let rows;
  try { rows = await h.api(`/api/reels/${reelId}/generations`); } catch {
    if (seq !== reelGensSeq || !onReel(reelId)) return;
    const box = h.$('#rm-gens');
    if (box && !box.querySelector('.gen')) box.innerHTML = '<div class="dim" style="font-size:13px">Could not load the projects of this reel. Trying again…</div>';
    remakeTimer = setTimeout(() => loadReelGens(reelId), 5000);
    return;
  }
  if (seq !== reelGensSeq || !onReel(reelId)) return;
  const box = h.$('#rm-gens');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="rm-steps-empty">${icon('info')}<span>After you press “Generate”, the steps continue down here, without leaving this page.</span></div>`;
    return;
  }
  const sel = rows.find((g) => g.id === rmSel.get(reelId)) || rows[0];
  rmSel.set(reelId, sel.id);
  if (!box.querySelector('#rm-gen-card')) box.innerHTML = '<div class="rm-proj-bar" id="rm-proj-bar"></div><div id="rm-gen-card"></div>';
  const bar = h.$('#rm-proj-bar', box);
  const tab = (g) => {
    const s = STAGES[g.stage] || { label: g.stage, tone: 'off' };
    const n = g.kind === 'video' ? videoStep(g) : 0;
    return `<button type="button" class="rm-proj ${g.id === sel.id ? 'active' : ''}" data-rmsel="${g.id}" aria-pressed="${g.id === sel.id}"><b>#${g.id}</b><span class="stage ${s.tone}">${n ? `Step ${n} · ` : ''}${h.esc(g.kind === 'video' ? stepLabel(g, n, s) : s.label)}</span><span class="dim">${h.esc(g.model_name || '')}</span></button>`;
  };
  const barHtml = `<div class="row between" style="gap:8px;flex-wrap:wrap"><h3 style="margin:0">${sel.kind === 'video' ? 'Project steps' : 'Project photos'} #${sel.id}</h3><a class="btn sm ghost" href="#/projects/${sel.id}" title="The same project in Projects, with the list of open ones and Focus">${icon('layers')}View in Projects</a></div>${rows.length > 1 ? `<div class="rm-proj-tabs" role="tablist" aria-label="Projects of this reel">${rows.map(tab).join('')}</div>` : ''}`;
  if (bar.dataset.sig !== barHtml) {
    bar.dataset.sig = barHtml;
    bar.innerHTML = barHtml;
    h.$$('[data-rmsel]', bar).forEach((b) => (b.onclick = () => { rmSel.set(reelId, Number(b.dataset.rmsel)); keepGenInUrl(reelId, Number(b.dataset.rmsel)); loadReelGens(reelId); }));
  }
  const card = h.$('#rm-gen-card', box);
  card._opts = { hideOrigin: true }; // step 1 is the page itself
  patchGenList(card, [sel], () => loadReelGens(reelId));
  // Refreshed while something runs (enlarging, video, step 6), and slowly otherwise (changes made in Projetos).
  remakeTimer = setTimeout(() => loadReelGens(reelId), ACTIVE.includes(sel.stage) || sel.busy ? 3000 : 12000);
}

// =================================================================================
// LIBRARY: originals downloaded into the app + generated videos
// =================================================================================
const LIB_PAGE = 60;
const lib = { tab: 'originals', limit: LIB_PAGE };
const libTabsHtml = () => `<div class="seg" id="lib-tabs">${[['originals', 'Downloaded reels'], ['generated', 'Generated videos'], ['photos', 'Generated photos'], ['approved', 'Ready to publish']].map(([v, l]) => `<button data-v="${v}" class="${lib.tab === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const bindLibTabs = () => h.$$('#lib-tabs button').forEach((b) => (b.onclick = () => { if (lib.tab !== b.dataset.v) lib.limit = LIB_PAGE; lib.tab = b.dataset.v; renderLibrary(); }));

export async function renderLibrary() {
  if (lib.tab === 'comfy') return renderComfyImports();
  const tab = lib.tab;
  let rows;
  try { rows = await h.api(`/api/library?kind=${tab}`); } catch (e) {
    if (on('library')) h.$('#view').innerHTML = errorState(e);
    return;
  }
  if (!on('library') || lib.tab !== tab) return;
  const items = tab === 'photos' ? rows.flatMap((g) => g.candidates.map((c, i) => [g, c, i])) : rows;
  const itemHtml = (x) => (tab === 'photos' ? libPhoto(...x) : tab === 'originals' ? libOriginal(x) : libGenerated(x));
  const empty = { originals: 'No downloaded reels yet. Open a reel and press “Remake”, or wait for the next scan.', photos: 'No generated photos yet.', approved: 'No videos ready to publish yet.' }[tab] || 'No generated videos yet.';
  h.$('#view').innerHTML = `
    <h2>Library</h2>
    <p class="sub">The reels downloaded into the app and everything you generated. Reels with an FTVR (views ÷ followers) above the limit set in Settings are downloaded automatically after each scan.</p>
    <div class="toolbar">${libTabsHtml()}
      <span class="muted" style="font-size:12.5px">${items.length} ${tab === 'photos' ? 'photo(s)' : 'video(s)'}</span></div>
    <div class="lib-grid" id="lib-grid">${items.length ? '' : `<div class="empty" style="grid-column:1/-1">${empty}</div>`}</div>
    <div class="row" id="lib-more" style="justify-content:center;margin-top:16px"></div>`;
  bindLibTabs();
  let shown = 0;
  const append = (end) => {
    const grid = h.$('#lib-grid');
    if (!grid) return;
    grid.insertAdjacentHTML('beforeend', items.slice(shown, end).map(itemHtml).join(''));
    shown = end;
    // Videos load only on hover (preload="none" + poster): opening the tab never fires hundreds of requests.
    h.$$('.lib-item video', grid).forEach((v) => {
      v.parentElement.onmouseenter = () => v.play().catch(() => {});
      v.parentElement.onmouseleave = () => v.pause();
    });
    const more = h.$('#lib-more');
    more.innerHTML = shown < items.length ? `<button class="btn" id="lib-more-btn">Show more (${items.length - shown})</button>` : '';
    if (shown < items.length) h.$('#lib-more-btn').onclick = () => { lib.limit = shown + LIB_PAGE; append(Math.min(items.length, lib.limit)); };
  };
  if (items.length) append(Math.min(items.length, lib.limit));
}

const libOriginal = (r) => `
  <div class="lib-item">
    <video src="${reelVideoUrl(r)}" muted loop playsinline preload="none" poster="${r.thumb_path ? media(r.thumb_path) : ''}"></video>
    <div class="lib-meta"><b>@${h.esc(r.handle)}</b> <span class="pf ${r.platform}">${h.PF[r.platform]}</span>
      <div class="dim">${h.fmt(r.views)} views · ${h.ratio(r.ftvr)} FTVR${r.remake_count ? ` · ${r.remake_count} remake(s)` : ''}</div></div>
    <div class="row"><a class="btn sm primary" href="#/remake/${r.id}">${icon('repeat')}Remake</a><a class="btn sm ghost" href="${reelVideoUrl(r, true)}" download title="Download MP4">${icon('download')}MP4</a></div>
  </div>`;

async function renderComfyImports() {
  let rows; let models;
  try { [rows, models] = await Promise.all([h.api('/api/imports'), h.api('/api/models')]); } catch (e) {
    if (on('library')) h.$('#view').innerHTML = errorState(e);
    return;
  }
  if (!on('library') || lib.tab !== 'comfy') return;
  h.$('#view').innerHTML = `
    <h2>Library</h2>
    <p class="sub">Images and videos from the workflows you run by hand on the Comfy Cloud site (e.g. <b>Z-Image SFW</b> with the LoRA of your model). Press import after each session.</p>
    <div class="toolbar">${libTabsHtml()}
      <button class="btn primary sm" id="ci-import">${icon('download')}Import from Comfy Cloud</button><span class="dim" id="ci-status" style="font-size:12.5px"></span></div>
    <div class="lib-grid">${rows.length ? rows.map((r) => `
      <div class="lib-item" data-id="${r.id}">
        ${/\.(mp4|webm)$/i.test(r.path) ? `<video src="${media(r.path)}" muted loop playsinline preload="metadata" controls></video>` : `<img src="${media(r.path)}" data-zoom="${media(r.path)}" style="width:100%;aspect-ratio:4/5;object-fit:cover;display:block;cursor:zoom-in" loading="lazy" alt="">`}
        <div class="lib-meta"><b>${h.esc(r.filename)}</b><div class="dim">${h.dateTime(r.created_at)}${r.model_name ? ` · in ${h.esc(r.model_name)}'s folder` : ''}</div></div>
        <div class="row">
          ${!/\.(mp4|webm)$/i.test(r.path) && models.length ? `<select class="input" data-to-model style="flex:1;font-size:12px"><option value="">Add to the model's folder…</option>${models.map((m) => `<option value="${m.id}">${h.esc(m.name)}</option>`).join('')}</select>` : ''}
          <a class="btn sm icon-only" href="${media(r.path)}" download title="Download" aria-label="Download">${icon('download')}</a>
          <button class="btn sm ghost danger icon-only" data-del-import title="Remove" aria-label="Remove">${icon('trash')}</button>
        </div>
      </div>`).join('') : '<div class="empty" style="grid-column:1/-1">Nothing imported yet. Run a workflow on the Comfy Cloud site and then press “Import from Comfy Cloud”.</div>'}</div>`;
  bindLibTabs();
  h.$('#ci-import').onclick = async () => {
    const st = h.$('#ci-status');
    h.$('#ci-import').disabled = true; st.textContent = 'Looking for runs on Comfy Cloud…';
    try {
      const r = await h.api('/api/comfy-cloud/import', { method: 'POST', body: {} });
      h.toast(r.added ? `${r.added} file(s) imported` : 'Nothing new to import');
      if (r.errors?.length) h.toast(r.errors[0], true);
      renderComfyImports();
    } catch (e) { st.textContent = ''; h.toast(e.message, true); h.$('#ci-import').disabled = false; }
  };
  h.$$('[data-zoom]').forEach((img) => (img.onclick = () => h.showModal(`<div class="modal-box small" style="max-width:560px;padding:0;background:black"><img src="${img.dataset.zoom}" style="width:100%;display:block" data-close alt=""></div>`)));
  h.$$('.lib-item[data-id]').forEach((el) => {
    const id = el.dataset.id;
    const sel = h.$('[data-to-model]', el);
    if (sel) sel.onchange = async () => {
      if (!sel.value) return;
      try { await h.api(`/api/imports/${id}/to-model`, { method: 'POST', body: { modelId: Number(sel.value) } }); h.toast("Added to the model's folder"); renderComfyImports(); } catch (e) { h.toast(e.message, true); }
    };
    h.$('[data-del-import]', el).onclick = async () => {
      try { await h.api(`/api/imports/${id}`, { method: 'DELETE' }); el.remove(); } catch (e) { h.toast(e.message, true); }
    };
  });
}

const libPhoto = (g, c, i) => `
  <div class="lib-item">
    <img src="${genImageUrl(g, i, c)}" style="width:100%;aspect-ratio:4/5;object-fit:cover;display:block" loading="lazy" alt="">
    <div class="lib-meta"><b>${h.esc(g.model_name || '—')}</b> · ${h.esc(c.label || '')}<div class="dim">from @${h.esc(g.handle)} · ${h.dateTime(g.updated_at)}</div></div>
    <div class="row"><a class="btn sm" href="#/remake/${g.reel_id}?gen=${g.id}">Open</a><a class="btn sm primary" href="${genImageUrl(g, i, c, true)}" download>${icon('download')}Photo</a></div>
  </div>`;

const libGenerated = (g) => `
  <div class="lib-item">
    <video src="${genVideoUrl(g)}" muted loop playsinline preload="none" poster="${g.chosen_image ? media(g.chosen_image) : g.frame_path ? media(g.frame_path) : g.thumb_path ? media(g.thumb_path) : ''}"></video>
    <div class="lib-meta"><b>${h.esc(g.model_name || '—')}</b> <span class="stage ${STAGES[g.stage]?.tone || 'off'}">${STAGES[g.stage]?.label || h.esc(g.stage)}</span>
      <div class="dim">remake of @${h.esc(g.handle)} · ${h.dateTime(g.updated_at)}</div></div>
    <div class="row"><a class="btn sm" href="#/remake/${g.reel_id}?gen=${g.id}">Open</a><a class="btn sm primary" href="${genVideoUrl(g, true)}" download>${icon('download')}MP4</a></div>
  </div>`;

// =================================================================================
// SETUP → Pipeline section
// =================================================================================
/** The pipeline section of Definições: WaveSpeed does the images, the enlargement and the video. */
export function pipelineSetupHtml(s, st) {
  const opt = (name, list, cur) => `<select class="input" name="${name}">${list.map(([v, l]) => `<option value="${h.esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${h.esc(l)}</option>`).join('')}</select>`;
  const secret = (name, set, ph) => `<input class="input" name="${name}" type="password" autocomplete="off" placeholder="${set ? '•••••• (leave empty to keep)' : ph}">${set ? `<label class="check"><input type="checkbox" name="clear_${name}"> Delete saved key</label>` : ''}`;
  const cur = s.nb_model_comfy;
  const nbList = [[NB_2, 'Nano Banana 2'], [NB_PRO, 'Nano Banana Pro'], ...(cur && ![NB_2, NB_PRO].includes(cur) ? [[cur, `${cur} (runs as ${/pro/i.test(cur) ? 'Nano Banana Pro' : 'Nano Banana 2'})`]] : [])];
  return `
  <div class="card stack" id="pipeline-setup">
    <div class="row between"><h3 style="margin:0">Generation pipeline</h3></div>
    <div class="grid-2" style="gap:14px">
      <label class="field"><span>WaveSpeed API key ${s.wavespeed_api_key_set ? '<span class="status ok">Saved</span>' : ''}</span>${secret('wavespeed_api_key', s.wavespeed_api_key_set, 'wsk_live_…')}<small>The provider of the images, the enlargement and the video. Create one at wavespeed.ai/accesskey.</small></label>
      <label class="field"><span>Gemini API key (optional) ${s.gemini_api_key_set ? '<span class="status ok">Saved</span>' : ''}</span>${secret('gemini_api_key', s.gemini_api_key_set, 'AIza…')}<small>Google AI Studio. Not needed: the quality check already runs on WaveSpeed.</small></label>
      <label class="field"><span>fal.ai API key ${s.fal_api_key_set ? '<span class="status ok">Saved</span>' : ''}</span>${secret('fal_api_key', s.fal_api_key_set, 'id:secret')}<small>Only for 18+ content (Wan 2.2 Animate already runs on WaveSpeed). Create one at fal.ai/dashboard/keys.</small></label>
    </div>
    <div class="label" style="margin-top:6px">Image (Nano Banana)</div>
    <div class="grid-3">
      <label class="field"><span>Nano Banana (photos, poses, outfit)</span>${opt('nb_model_comfy', nbList, s.nb_model_comfy)}<small>The Remake person swap uses Nano Banana Pro, as the reference does.</small></label>
      <label class="field"><span>Resolution</span>${opt('nb_resolution', [['1K', '1K'], ['2K', '2K'], ['4K', '4K']], s.nb_resolution)}</label>
      <label class="field"><span>Variants per remake</span>${opt('nb_variants', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], s.nb_variants)}</label>
      <label class="field"><span>Image choice</span>${opt('auto_approve_image', [['0', 'Manual'], ['1', 'Automatic (best image)']], s.auto_approve_image)}</label>
      <label class="field"><span>Realistic video finish</span>${opt('realism_finish', [['1', 'On (recommended)'], ['0', 'Off']], s.realism_finish ?? '1')}<small>Reel resolution, phone camera grain and less saturated red in the skin. Free (done on your PC).</small></label>
    </div>
    <div class="label" style="margin-top:6px">Default remake type</div>
    <div class="grid-3">
      <label class="field"><span>Type</span>${(() => {
        const list = [['wan3_copy', 'Exact copy (Wan 3.0 + original music)'], ['animate_replace', 'Swap the person (Wan 2.2 Animate, open model)'],
          ...ENGINES.filter((e) => e.needs === 'rh' && rhOn(s, e.wf)).map((e) => [e.key, `${RH_ENGINE_NAME[e.key]} (your workflow, RunningHub)`])];
        return opt('video_engine', list, list.some(([v]) => v === s.video_engine) ? s.video_engine : 'wan3_copy');
      })()}</label>
      ${frameOptions(s).length > 1 ? `<label class="field"><span>Her image</span>${opt('frame_engine', frameOptions(s), frameDefault(s))}</label>` : ''}
      <label class="field"><span>Audio</span>${opt('keep_original_sound', [['1', 'Keep the original audio of the reel'], ['0', 'No original audio']], s.keep_original_sound ?? '1')}</label>
    </div>
    <div class="label" style="margin-top:6px">Video (Wan 3.0): default values, changed at step 4</div>
    <div class="grid-3">
      <label class="field"><span>Model</span>${opt('wan_model', [['wan3.0-video', 'Wan 3.0'], ['wan3.0-video-prime', 'Wan 3.0 Prime (more faithful)']], s.wan_model)}</label>
      <label class="field"><span>Resolution</span>${opt('wan_resolution', [['480P', '480P'], ['720P', '720P'], ['1080P', '1080P']], s.wan_resolution)}</label>
      <label class="field"><span>Parallel generations</span>${opt('pipeline_concurrency', [['1', '1'], ['2', '2'], ['3', '3']], s.pipeline_concurrency)}</label>
    </div>
    <div class="dim" style="font-size:12px" id="cost-est"></div>
  </div>`;
}

export async function showEstimate() {
  try {
    const e = await h.api('/api/pipeline/estimate');
    const el = h.$('#cost-est');
    if (el) el.innerHTML = `Estimated cost per remake with these settings: <b style="color:var(--text)">~${usd(e.total)}</b> (images ${usd(e.image)} + video ${e.seconds} s ${usd(e.video)})`;
  } catch {}
}

// =================================================================================
// SETUP → RunningHub: the user's own ComfyUI workflows (ids, her LoRAs, check)
// =================================================================================
const RH_GROUPS = [
  ['reel', 'Reels · her image + the reel → video'],
  ['frame', 'Her image in the reel frame and in the photos'],
  ['finish', 'Extra realism for her images'],
  ['adult', '18+ content · from a photo of her'],
  ['adultTool', '18+ content · tools on an image of her'],
];
const rhStateChip = (w) => (!w.id ? '<span class="status">Not set up</span>'
  : w.verified === true ? `<span class="status ok">${icon('check')}Verified</span>`
    : w.verified === false ? '<span class="status error">Has problems</span>' : '<span class="status private">Not verified</span>');
const defaultTrigger = (m) => `${String(m.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'model'}ofm`;

/** `wf` = GET /api/runninghub/workflows (null when it could not be read: the card still lets the user paste ids). */
export function runningHubSetupHtml(s, wf, models) {
  const opt = (name, list, cur) => `<select class="input" name="${name}">${list.map(([v, l]) => `<option value="${h.esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${h.esc(l)}</option>`).join('')}</select>`;
  const list = wf?.workflows || [];
  const row = (w) => `
    <div class="rh-wf" data-rh="${w.key}">
      <div class="rh-wf-top"><b>${h.esc(w.name)}</b>${w.needs === 'instaraw' ? '<span class="tag">INSTARAW nodes</span>' : ''}<span data-rh-state="${w.key}">${rhStateChip(w)}</span>
        <a class="rh-json" href="/${h.esc(w.file)}" download title="Download the JSON to upload to RunningHub">${icon('download', { size: 13 })}JSON</a></div>
      <div class="dim" style="font-size:12px">${h.esc(w.desc)}</div>
      <input class="input" name="${w.setting}" value="${h.esc(w.id)}" placeholder="RunningHub workflow link or ID" autocomplete="off" spellcheck="false">
      <div class="rh-out" data-rh-out="${w.key}"></div>
    </div>`;
  return `
  <div class="card stack" id="rh-setup">
    <div class="row between"><h3 style="margin:0">RunningHub · your workflows</h3>
      <div class="row"><span class="dim" id="rh-account" style="font-size:12.5px"></span><button type="button" class="btn sm" id="rh-verify">${icon('check-circle')}Save and check</button></div></div>
    <p class="dim" style="margin:0;font-size:12.5px">Your ComfyUI workflows run in the RunningHub cloud exactly as you save them there; the app only gives them the inputs (her photo, the reel, the text, the seed). For each one: upload the JSON to RunningHub, run it once successfully, save it and paste the link or ID here. Payments are made in your RunningHub account, by GPU time.</p>
    <div class="grid-3">
      <label class="field"><span>API key ${s.rh_api_key_set ? '<span class="status ok">Saved</span>' : ''}</span><input class="input" name="rh_api_key" type="password" autocomplete="off" placeholder="${s.rh_api_key_set ? '•••••• (leave empty to keep)' : 'Your RunningHub API key'}">${s.rh_api_key_set ? '<label class="check"><input type="checkbox" name="clear_rh_api_key"> Delete saved key</label>' : ''}<small>runninghub.ai → your account → API. You need a plan with access to the workflow API.</small></label>
      <label class="field"><span>Site</span>${opt('rh_site', [['ai', 'runninghub.ai (international)'], ['cn', 'runninghub.cn (China)']], s.rh_site || 'ai')}</label>
      <label class="field"><span>GPU</span>${opt('rh_instance', [['default', '24 GB'], ['plus', '48 GB (recommended for video)'], ['ultra', '84 GB']], s.rh_instance || 'default')}</label>
      <label class="field"><span>Maximum reel length sent (s)</span><input class="input" type="number" min="3" max="120" name="rh_max_secs" value="${h.esc(s.rh_max_secs || '30')}"><small>Longer reels are cut to this length before they go to the video workflows.</small></label>
    </div>
    ${list.length ? RH_GROUPS.map(([use, title]) => {
      const items = list.filter((w) => w.use === use);
      return items.length ? `<div class="label" style="margin-top:6px">${title}</div><div class="rh-grid">${items.map(row).join('')}</div>` : '';
    }).join('') : `<div class="callout warn">${icon('alert-triangle')}<div>Could not read the workflow list. Reload the page.</div></div>`}
    <div class="label" style="margin-top:6px">Her LoRAs on RunningHub</div>
    ${models.length ? `<div class="rh-models">${models.map((m) => `
      <div class="rh-model" data-model="${m.id}">
        <b>${h.esc(m.name)}</b>
        <label class="field"><span>Z-Image LoRA (SKY)</span><input class="input" data-mfield="rh_lora" value="${h.esc(m.rh_lora || '')}" placeholder="e.g. ${h.esc(defaultTrigger(m))}_zimage.safetensors" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Trigger word</span><input class="input" data-mfield="rh_trigger" value="${h.esc(m.rh_trigger || '')}" placeholder="${h.esc(m.lora_trigger || defaultTrigger(m))}" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>WAN 2.2 LoRA (optional)</span><input class="input" data-mfield="rh_wan_lora" value="${h.esc(m.rh_wan_lora || '')}" placeholder="for Instagirl" autocomplete="off" spellcheck="false"></label>
      </div>`).join('')}</div>` : '<span class="dim">No models yet.</span>'}
    <small class="dim">The file name exactly as it appears on RunningHub. Without her Z-Image LoRA, SKY would make the character of the workflow author, so the app does not run it without one. The WAN 2.2 LoRA is optional: without it, Instagirl turns off the character LoRA of the author and refines with low strength, so the face does not change.</small>
  </div>`;
}

/** Her LoRA names (per model): saved with the settings and before a check. Only the fields that changed. */
export async function saveRunningHubModels() {
  for (const row of h.$$('#rh-setup .rh-model')) {
    const body = {};
    h.$$('[data-mfield]', row).forEach((i) => { if (i.value.trim() !== i.defaultValue.trim()) body[i.dataset.mfield] = i.value.trim(); });
    if (!Object.keys(body).length) continue;
    await h.api(`/api/models/${row.dataset.model}`, { method: 'PATCH', body });
    h.$$('[data-mfield]', row).forEach((i) => { i.defaultValue = i.value.trim(); });
  }
}

function paintRunningHubCheck(r) {
  const acc = h.$('#rh-account');
  if (acc) {
    const a = r.account;
    acc.innerHTML = a ? `${icon('check-circle', { cls: 'ok', size: 13 })} Account connected${a.remainMoney != null ? ` · balance ${h.esc(a.remainMoney)} ${h.esc(a.currency || '')}` : ''}${a.remainCoins != null ? ` · ${h.esc(a.remainCoins)} RH coins` : ''}`
      : `<span class="msg bad">${icon('x-circle')}${h.esc(stripEmoji(r.accountError || 'Account not confirmed'))}</span>`;
  }
  for (const [key, w] of Object.entries(r.workflows || {})) {
    const out = h.$(`[data-rh-out="${key}"]`);
    const chip = h.$(`[data-rh-state="${key}"]`);
    if (!out) continue;
    if (!w.configured) { out.innerHTML = ''; if (chip) chip.innerHTML = '<span class="status">Not set up</span>'; continue; }
    if (chip) chip.innerHTML = w.ok ? `<span class="status ok">${icon('check')}Verified</span>` : '<span class="status error">Has problems</span>';
    out.innerHTML = [
      w.ok ? `<div class="msg ok">${icon('check-circle')}Ready to use${w.nodes ? ` (${w.nodes} nodes)` : ''}</div>` : '',
      ...(w.issues || []).map((x) => `<div class="msg bad">${icon('x-circle')}${h.esc(stripEmoji(x))}</div>`),
      ...(w.notes || []).map((x) => `<div class="msg">${icon('info')}${h.esc(stripEmoji(x))}</div>`),
    ].join('');
  }
}

/** "Guardar e verificar": saves the RunningHub fields and her LoRAs, then reads every saved workflow on RunningHub. */
export function bindRunningHubSetup() {
  const btn = h.$('#rh-verify');
  const form = h.$('#settings-form');
  if (!btn || !form) return;
  btn.onclick = async () => {
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('rh_')) body[k] = v;
    body.clear_rh_api_key = fd.has('clear_rh_api_key');
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = `<span class="spinner inline"></span> Checking…`;
    try {
      await h.api('/api/settings', { method: 'PUT', body });
      await saveRunningHubModels();
      const r = await h.api('/api/runninghub/verify', { method: 'POST' });
      paintRunningHubCheck(r);
      const bad = Object.values(r.workflows || {}).filter((w) => w.configured && !w.ok).length;
      h.toast(bad ? `${bad} workflow(s) with problems: see the details on each one` : 'All verified');
    } catch (e) { h.toast(e.message, true); }
    btn.disabled = false;
    btn.innerHTML = label;
  };
}

// =================================================================================
// PHOTO POSTS: remake a photo/carousel + generate the same scene in other poses
// =================================================================================
let posesCache = null;
const loadPoses = async () => (posesCache ||= await h.api('/api/poses').catch((e) => { posesCache = null; throw e; }));
const PHOTO_COST = 0.0835;

async function renderPhotoRemake(reel, models, s, params, alive, stP) {
  rmOutfit = null;
  rmRecalc = null;
  let poses;
  try { poses = await loadPoses(); } catch { poses = []; }
  if (!alive()) return;
  const slides = (() => { try { return JSON.parse(reel.image_paths || '[]'); } catch { return []; } })();
  const list = slides.length ? slides : reel.thumb_path ? [reel.thumb_path] : [];
  const engineOk = keysOk(s);
  const frames = frameOptions(s);
  const first = models.find((m) => m.readiness.ready) || models[0];
  h.$('#page-title').textContent = 'Photo remake';
  backButton();
  h.$('#view').innerHTML = `
    <div class="rm-step-head"><span class="gs-n">1</span><b>Source</b><span class="dim">the post, the photos to redo, the model and how it turns out. After you generate, the photos appear down here.</span></div>
    <div class="remake-grid">
      <section class="card">
        <div class="row between"><h3 style="margin:0">1 · Original post ${reel.media_type === 'carousel' ? `(carousel · ${list.length})` : ''}</h3><a class="btn sm ghost" href="${h.esc(reel.url)}" target="_blank" rel="noopener">${icon('external-link')}Open</a></div>
        <div class="creator-cell" style="margin:10px 0"><div><div class="h">@${h.esc(reel.handle)} <span class="pf ${reel.platform}">${h.PF[reel.platform]}</span></div>
          <div class="d">${h.fmt(reel.likes)} likes · ${h.fmt(reel.comments)} comments · ${h.ago(reel.posted_at)} ago</div></div></div>
        ${list.length ? `<div class="photo-main"><img id="ph-main" src="${media(list[0])}" alt=""></div>
        <div class="label" style="margin:10px 0 6px">${list.length > 1 ? 'Choose the photos to recreate (hover to view, tick to include):' : 'Photo to recreate:'}</div>
        <div class="slide-pick">${list.map((p, i) => `<label class="sp ${i === 0 ? 'on' : ''}" data-i="${i}"><img src="${media(p)}" alt=""><input type="checkbox" value="${i}" ${i === 0 ? 'checked' : ''}><span>${i + 1}</span></label>`).join('')}</div>`
        : warnCallout('This post has no photos saved in the app yet. Run “Check now” on the creator.')}
        ${reel.caption ? `<div class="dim" style="font-size:12px;margin-top:10px;max-height:60px;overflow:auto">${h.esc(reel.caption)}</div>` : ''}
      </section>

      <section class="card stack">
        <h3 style="margin:0">Model</h3>
        ${models.length ? `<div class="model-pick">${models.map((m) => {
          const cover = m.ref_images.find((r) => r.kind === 'face_front') || m.ref_images[0];
          return `<label class="mp ${m.id === first?.id ? 'active' : ''} ${m.readiness.ready ? '' : 'off'}">
            <input type="radio" name="rm-model" value="${m.id}" ${m.id === first?.id ? 'checked' : ''} ${m.readiness.ready ? '' : 'disabled'}>
            <div class="mp-img" style="${cover ? `background-image:url('${media(cover.path)}')` : ''}">${cover ? '' : h.esc(m.name[0])}</div>
            <div><b>${h.esc(m.name)}</b><div class="dim" style="font-size:11.5px">${m.readiness.ready ? `${m.ref_images.length} photos` : 'Empty folder'}</div></div>
          </label>`;
        }).join('')}</div>` : warnCallout('No models yet. <a href="#/models">Create one and upload the photos</a>.')}
        <h3 style="margin:6px 0 0">What do you want?</h3>
        <textarea class="input" id="rm-prompt" rows="2" placeholder="Optional, e.g. same photo but with a black dress; hair tied up">${h.esc(params.get('q') || '')}</textarea>
        <div class="uni-row">
          <label class="field"><span>Setting</span><select class="input" id="rm-place"><option value="">From the original</option></select></label>
        </div>
        <div class="outfit-pick">
          <div class="label">${icon('shirt')}Outfit for this remake <span class="dim">· choose from her wardrobe or drag in a photo of the garment</span></div>
          <div class="pick-row" id="rm-outfits"><button class="pick active" data-outfit="">From the original<small>(reel/post)</small></button></div>
        </div>

        <div class="grid-3" style="gap:10px">
          <label class="field"><span>Variants per photo</span><select class="input" id="ph-var"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></label>
          <label class="field"><span>Outfit</span><select class="input" id="ph-outfit"><option value="true">Same as in the post</option><option value="false">Outfit from her photos</option></select></label>
          <label class="field"><span>Recreate the photo</span><select class="input" id="ph-copy"><option value="true">Yes (same pose)</option><option value="false">No, only new poses</option></select></label>
          ${frames.length > 1 ? `<label class="field"><span>Her image</span><select class="input" id="ph-frame">${frames.map(([v, l]) => `<option value="${v}" ${v === frameDefault(s) ? 'selected' : ''}>${h.esc(l)}</option>`).join('')}</select></label>` : ''}
          ${rhOn(s, 'instagirl') ? `<label class="field"><span>Extra realism</span><select class="input" id="ph-finish"><option value="">No</option><option value="instagirl">WAN 2.2 Instagirl (RunningHub)</option></select></label>` : ''}
        </div>
        <h3 style="margin:6px 0 0">More poses <span class="dim" style="font-size:12px;font-weight:400">(same setting and outfit, your model in other positions)</span></h3>
        <div class="pose-pick">${poses.map((p) => `<label class="chip pose"><input type="checkbox" value="${p.key}" hidden>${h.esc(p.label)}</label>`).join('')}</div>
        <input class="input" id="ph-custom" placeholder="Custom pose (optional), e.g. sitting on the floor leaning against the bed, looking at the phone">
        <div class="dim" style="font-size:12.5px" id="rm-cost"></div>
        <div id="rm-status" class="stack" style="gap:8px"></div>
        ${!engineOk ? `<div id="rm-keys">${warnCallout('First paste the WaveSpeed API key in <a href="#/setup">Settings → Pipeline</a>. With the photo made by one of your RunningHub workflows (no extra poses or chosen outfit), it is not needed.')}</div>` : ''}
        <button class="btn primary big" id="rm-go" ${engineOk && models.some((m) => m.readiness.ready) && list.length ? '' : 'disabled'}>${icon('play-circle')}Generate photos</button>
      </section>
    </div>
    <div id="rm-gens" class="rm-steps"></div>`;

  h.$$('input[name=rm-model]').forEach((r) => (r.onchange = () => { h.$$('.mp').forEach((l) => l.classList.toggle('active', l.contains(r) && r.checked)); loadUniverseSelects(); }));
  loadUniverseSelects();
  const selSlides = () => h.$$('.slide-pick input:checked').map((x) => Number(x.value));
  const selPoses = () => h.$$('.pose-pick input:checked').map((x) => x.value);
  const cost = () => {
    if (!alive() || !h.$('#rm-cost')) return;
    const copy = h.$('#ph-copy').value === 'true';
    const frame = h.$('#ph-frame')?.value || 'nano';
    const finish = h.$('#ph-finish')?.value === 'instagirl';
    const nSlides = copy ? selSlides().length * Number(h.$('#ph-var').value) : 0;
    const nPoses = selPoses().length + (h.$('#ph-custom').value.trim() ? 1 : 0);
    const n = nSlides + nPoses;
    const rhFrame = RH_FRAME.includes(frame);
    // Slides: Nano Banana, Flux.2 or Seedream (Comfy API) or her RunningHub workflow; poses are always Nano Banana.
    const usdCost = (rhFrame ? 0 : nSlides * (EDITOR_COST[frame] ?? PHOTO_COST)) + nPoses * PHOTO_COST;
    const rh = (rhFrame && nSlides) || (finish && n);
    h.$('#rm-cost').innerHTML = `Will generate <b style="color:var(--text)">${n} photo(s)</b> · ${usdCost || !rh
      ? `estimated cost <b style="color:var(--text)">~${usd(usdCost)}</b>${rh ? ' + GPU time on RunningHub (charged there)' : ''}`
      : 'cost: <b style="color:var(--text)">GPU time on RunningHub</b> (charged to your RunningHub account)'}`;
    const needWs = !rhFrame || nPoses > 0 || !!rmOutfit;
    const goBtn = h.$('#rm-go');
    if (goBtn && !goBtn.dataset.busy) goBtn.disabled = !(models.some((m) => m.readiness.ready) && list.length && (engineOk || !needWs));
    h.$('#rm-keys')?.classList.toggle('hidden', !needWs);
    h.$$('.pose-pick .pose').forEach((c) => c.classList.toggle('active', c.querySelector('input').checked));
    h.$$('.slide-pick .sp').forEach((c) => c.classList.toggle('on', c.querySelector('input').checked));
  };
  rmRecalc = cost;
  h.$$('.slide-pick .sp').forEach((l) => l.addEventListener('mouseenter', () => { const main = h.$('#ph-main'); if (main) main.src = media(list[Number(l.dataset.i)]); }));
  h.$$('#ph-var, #ph-copy, #ph-custom, #ph-frame, #ph-finish, .slide-pick input, .pose-pick input').forEach((x) => { x.onchange = cost; x.oninput = cost; });
  cost();
  stP.then((st) => fillRemakeStatus(st, alive));
  h.$('#rm-go').onclick = async () => {
    const go = h.$('#rm-go');
    const modelId = Number(h.$('input[name=rm-model]:checked')?.value);
    if (!modelId) return h.toast('Choose the model', true);
    const copy = h.$('#ph-copy').value === 'true';
    const slidesSel = selSlides();
    const posesSel = selPoses();
    const customPose = h.$('#ph-custom').value.trim();
    if (!copy && !posesSel.length && !customPose) return h.toast('Choose at least one pose', true);
    if (copy && !slidesSel.length) return h.toast('Choose at least one photo', true);
    go.disabled = true;
    go.dataset.busy = '1';
    try {
      const g = await h.api(`/api/reels/${reel.id}/remake`, {
        method: 'POST',
        body: {
          kind: 'photo', modelId, prompt: h.$('#rm-prompt').value,
          config: {
            slides: copy ? slidesSel : [], variants: Number(h.$('#ph-var').value), keepOutfit: h.$('#ph-outfit').value === 'true', poses: posesSel, customPose,
            frameEngine: h.$('#ph-frame')?.value || 'nano', imageFinish: h.$('#ph-finish')?.value || '',
            ...(copy ? {} : { baseImage: list[slidesSel[0] ?? 0] }), ...universeCfg(),
          },
        },
      });
      h.toast(`Project #${g.id}: generating the photos (down here)`);
      if (alive()) { rmSel.set(reel.id, g.id); keepGenInUrl(reel.id, g.id); await loadReelGens(reel.id); h.$('#rm-gens')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } catch (e) { h.toast(e.message, true); }
    delete go.dataset.busy;
    if (alive() && go.isConnected) cost();
  };
  loadReelGens(reel.id);
}

const genImageUrl = (g, i, c, dl = false) => `/api/generations/${g.id}/image/${i}/remake_${fileSafe((g.model_name || 'modelo').toLowerCase())}_${fileSafe(g.handle)}_${g.id}_${fileSafe((c.label || `img${i + 1}`).toLowerCase())}${(c.path.match(/\.\w+$/) || ['.png'])[0]}${dl ? '?download=1' : ''}`;

function photoGenCard(g, s, open) {
  const running = ACTIVE.includes(g.stage);
  const cfg = g.config || {};
  const what = g.kind === 'poses' ? `${(cfg.poses || []).length + (cfg.customPose ? 1 : 0)} pose(s)` : `Remake of ${(cfg.slides || []).length || 0} photo(s)${(cfg.poses || []).length ? ` + ${(cfg.poses || []).length} pose(s)` : ''}`;
  return `
  <article class="gen card" data-id="${g.id}">
    <div class="gen-head">
      <div class="gen-src" style="${g.thumb_path ? `background-image:url('${media(g.thumb_path)}')` : ''}"></div>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:8px">
          <span class="stage ${s.tone}">${g.stage === 'review' ? 'Review photos' : s.label}</span>
          ${g.model_name ? `<span class="avatar-letter" style="--c:${h.esc(g.model_color || '#b15cff')};width:22px;height:22px;font-size:10px">${h.esc(g.model_name[0])}</span><b>${h.esc(g.model_name)}</b>` : ''}
          <span class="dim">${what} · <span class="pf ${g.platform}">${h.PF[g.platform]}</span> @${h.esc(g.handle)}</span>
        </div>
        <div class="dim" style="font-size:12px;margin-top:3px">#${g.id} · ${h.dateTime(g.created_at)} · ${usd(g.cost_usd || 0)}${g.instructions ? ` · “${h.esc(g.instructions.slice(0, 90))}”` : ''}</div>
      </div>
      <button class="btn sm ghost" data-act="toggle">${open ? 'Less' : 'Details'}</button>
      <button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>
    </div>
    ${running ? `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(g.step_status || 'Processing…'))}</b><div class="dim" style="font-size:12px">${FRAME_NAME[cfg.frameEngine] ? `${FRAME_NAME[cfg.frameEngine]}${RH_FRAME.includes(cfg.frameEngine) ? ' · RunningHub' : ''}` : 'Nano Banana'} · photos${cfg.imageFinish === 'instagirl' ? ' · Instagirl realism' : ''}</div></div><button class="btn sm ghost danger" data-act="cancel">Cancel</button></div>` : ''}
    ${g.candidates.length ? `<div class="photo-grid">${g.candidates.map((c, i) => `
      <div class="pg">
        <img src="${genImageUrl(g, i, c)}" data-zoom="${genImageUrl(g, i, c)}" loading="lazy" alt="">
        <div class="pg-label">${h.esc(c.label || `#${i + 1}`)}</div>
        <div class="pg-actions">
          <a class="btn sm icon-only" href="${genImageUrl(g, i, c, true)}" download title="Download" aria-label="Download">${icon('download')}</a>
          <button class="btn sm" data-act="poses" data-img="${h.esc(c.path)}" title="Generate this photo in other poses">${icon('person')}Poses</button>
          ${canEditImage(g, false) && !c.uploaded ? `<button class="btn sm" data-edit-img="${h.esc(c.path)}" title="Changes just one thing in this photo (for example, enlarging the bust). The edited one appears next to it.">${icon('wand')}Edit</button>` : ''}
        </div>
      </div>`).join('')}</div>` : ''}
    ${g.stage === 'failed' ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(g.error || 'Error'))}</div>` : ''}
    ${!running ? `<div class="row" style="margin-top:10px">
      ${['review', 'approved'].includes(g.stage) && !g.publish ? `<a class="btn primary" href="#/approval?gen=${g.id}" title="Choose the photos, the accounts and the time in Approval">${icon('send')}Approve and schedule</a>` : ''}
      ${g.stage === 'review' ? `<button class="btn" data-act="approve">${icon('check')}Just approve</button>` : ''}
      ${g.publish ? `<span class="status ok">${icon('send')}Scheduled</span>` : ''}
      <button class="btn" data-act="redo-images">${icon('refresh')}Generate again · ~${usd(redoImagesCost(g))}</button>
    </div>` : ''}
    ${open ? genDetails(g) : ''}
  </article>`;
}

/**
 * "Editar imagem": the reference app's "enlarge" step. The instruction is shown and editable (her model's default,
 * "Reset to default" goes back to it), with the editor and the number of variants; the button says what it costs.
 * The server sends only this image to the editor and adds the results next to it.
 */
function openImageEdit(g, src, reload) {
  const e = g.edit || {};
  const engines = e.engines || [];
  const presets = e.presets || [];
  const def = e.prompt || presets[0]?.text || '';
  h.showModal(`
    <div class="modal-box small ed-box">
      <div class="row between"><h3 style="margin:0">Edit image</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
      <p class="sub" style="margin:6px 0 14px">Changes only what you ask for: the face, the outfit and the setting stay the same. The original image is kept and the edited ones appear next to it, ready to animate.</p>
      <div class="ed-grid">
        <img src="${media(src)}" alt="">
        <div class="stack">
          <div class="ed-presets">${presets.map((p) => `<button class="chip" data-preset="${h.esc(p.key)}">${icon('wand')}${h.esc(p.label)}</button>`).join('')}</div>
          <div class="field"><div class="row between" style="width:100%"><label for="ed-text">Instruction</label><span><span class="ed-tag" id="ed-tag"></span><button type="button" class="link-btn" id="ed-reset">Reset to default</button></span></div>
            <textarea class="input" id="ed-text" rows="5" maxlength="1500"></textarea>
            <small>In English or Portuguese. The default comes from the model (Profiles). The outfit always stays on.</small></div>
          <div class="ed-row">
            <label class="field"><span>Engine</span><select class="input" id="ed-engine">${engines.map((x) => `<option value="${h.esc(x.key)}" ${x.key === e.engine ? 'selected' : ''}>${h.esc(x.label)} · ${usd(x.cost)}</option>`).join('')}</select></label>
            <label class="field"><span>Variants</span><select class="input" id="ed-n">${[1, 2, 3, 4].map((n) => `<option ${n === (e.n || 1) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <button class="btn primary" id="ed-go">${icon('wand')}Edit</button>
          <div class="ed-status" id="ed-status" role="status" aria-live="polite"></div>
        </div>
      </div>
    </div>`);
  const text = h.$('#ed-text'); const go = h.$('#ed-go'); const st = h.$('#ed-status');
  let running = false;
  const eng = h.$('#ed-engine'); const nSel = h.$('#ed-n'); const tag = h.$('#ed-tag');
  text.value = def;
  const paint = () => {
    const cost = (engines.find((x) => x.key === eng.value)?.cost || 0) * Number(nSel.value);
    go.innerHTML = `${icon('wand')}Edit · ${nSel.value === '1' ? '1 image' : `${nSel.value} images`} · ${usd(cost)}`;
    go.disabled = running || !text.value.trim();
    const p = presets.find((x) => x.text === text.value.trim());
    tag.textContent = text.value.trim() === def.trim() ? 'default' : p ? p.label : 'edited';
    h.$('#ed-reset').hidden = text.value.trim() === def.trim();
  };
  text.oninput = paint; eng.onchange = paint; nSel.onchange = paint;
  h.$('#ed-reset').onclick = () => { if (running) return; text.value = def; paint(); };
  h.$$('[data-preset]').forEach((b) => (b.onclick = () => { if (running) return; text.value = presets.find((x) => x.key === b.dataset.preset)?.text || text.value; paint(); }));
  paint();
  go.onclick = async () => {
    const change = text.value.trim();
    const preset = presets.find((x) => x.text === change)?.key;
    running = true;
    [go, text, eng, nSel].forEach((x) => (x.disabled = true));
    st.className = 'ed-status'; st.innerHTML = '<span class="spinner inline"></span>Editing. It usually takes 15 to 60 seconds.';
    try {
      const r = await h.api(`/api/generations/${g.id}/edit-image`, { method: 'POST', body: { path: src, change, preset, engine: eng.value, n: Number(nSel.value) } });
      if (st.isConnected) h.closeModal();
      const made = r.candidates?.length || 0;
      h.toast(made < (r.asked || 1) ? `${made} of ${r.asked} images edited (the others were refused or failed)` : made > 1 ? `${made} edited images next to the original` : 'Image edited: it is next to the original', made < (r.asked || 1));
      reload();
    } catch (err) {
      if (!st.isConnected) return h.toast(err.message, true);
      st.className = 'ed-status err'; st.textContent = stripEmoji(err.message);
      running = false;
      [text, eng, nSel].forEach((x) => (x.disabled = false));
      paint();
    }
  };
}

/**
 * The images of one step, large, next to what they came from (step 2: the video frame; step 3: the pick without
 * enlargement); ‹ › or the arrow keys go through them, and the step's own action is right there.
 * items: [{ c, kind: 'swap' | 'asis' | 'enlarge' }].
 */
function openZoom(g, items, start, reload, compare) {
  if (!items.length) return;
  const cfg = g.config || {};
  let i = Math.max(0, Math.min(items.length - 1, start));
  const idle = !g.busy && !g.publish && !ACTIVE.includes(g.stage) && ['awaiting_approval', 'failed', 'cancelled', 'review', 'approved'].includes(g.stage);
  const act = async (btn, url, body, msg) => {
    btn.disabled = true;
    try { await h.api(url, { method: 'POST', body }); h.closeModal(); h.toast(msg); reload(); } catch (err) { h.toast(err.message, true); btn.disabled = false; }
  };
  const paint = () => {
    const { c, kind } = items[i];
    const refused = (cfg.refusedImages || []).includes(c.path);
    const picked = kind === 'swap' ? cfg.pick === c.path : cfg.final === c.path;
    const own = c.uploaded || cfg.ownImage;
    const canEdit = kind === 'swap' && canEditImage(g, refused) && !c.uploaded;
    const title = kind === 'swap' ? `Image ${i + 1} of ${items.length}` : kind === 'asis' ? 'No enlargement' : `Enlargement ${i} of ${items.length - 1}`;
    h.showModal(`<div class="modal-box zoom-box">
      <div class="zoom-imgs">
        ${compare?.path && compare.path !== c.path ? `<figure><img src="${media(compare.path)}" alt=""><figcaption>${h.esc(compare.label)}</figcaption></figure>` : ''}
        <figure class="main"><img src="${media(c.path)}" alt=""><figcaption>${title}${c.edited && !c.enlarge ? ' · edited' : ''}${c.uploaded ? ' · yours' : ''}${picked ? ' · chosen' : ''}</figcaption></figure>
      </div>
      <div class="row between zoom-bar">
        <div class="row" style="gap:6px"><button class="btn sm icon-only" id="zm-prev" title="Previous (←)" aria-label="Previous" ${items.length < 2 ? 'disabled' : ''}>${icon('chevron-left')}</button><button class="btn sm icon-only" id="zm-next" title="Next (→)" aria-label="Next" ${items.length < 2 ? 'disabled' : ''}>${icon('chevron-right')}</button></div>
        <div class="row" style="gap:6px">
          ${canEdit ? `<button class="btn sm" id="zm-edit">${icon('wand')}Edit</button>` : ''}
          ${idle && !refused && !picked ? `<button class="btn sm primary" id="zm-go">${icon('arrow-right')}Continue</button>` : ''}
          <button class="btn sm ghost" data-close>Close</button>
        </div>
      </div>
    </div>`);
    h.$('#zm-prev').onclick = () => { i = (i - 1 + items.length) % items.length; paint(); };
    h.$('#zm-next').onclick = () => { i = (i + 1) % items.length; paint(); };
    if (h.$('#zm-edit')) h.$('#zm-edit').onclick = () => openImageEdit(g, c.path, reload);
    if (h.$('#zm-skip')) h.$('#zm-skip').onclick = (e) => act(e.currentTarget, `/api/generations/${g.id}/pick`, { path: c.path, skipEnlarge: true }, 'No enlargement: ready for the video (step 4)');
    if (h.$('#zm-go')) {
      h.$('#zm-go').onclick = (e) => (kind === 'swap'
        ? act(e.currentTarget, `/api/generations/${g.id}/pick`, { path: c.path }, own ? 'Image chosen: ready for the video (step 4)' : 'Step 3: choose the enlargement AI and press “Generate”')
        : act(e.currentTarget, `/api/generations/${g.id}/final`, { path: c.path }, 'Ready for the video (step 4)'));
    }
  };
  const onKey = (e) => {
    const m = h.$('#modal');
    if (!m || m.classList.contains('hidden') || !h.$('.zoom-box', m)) { window.removeEventListener('keydown', onKey, true); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); i = (i + (e.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length; paint(); }
  };
  window.addEventListener('keydown', onKey, true);
  paint();
}

/**
 * Modelos → "Aumentar o peito" on one of her photos (only those the app generated): the same presets and editors as
 * step 3 of a project. The results appear here; the one kept replaces the photo or joins her photos.
 */
let editOptsCache = null;
const refEditResults = new Map(); // `${model id}:${photo}` → paid versions not kept yet
async function openRefEdit(m, src, done) {
  let o;
  try { o = await (editOptsCache ||= h.api('/api/edit-options')); } catch (e) { editOptsCache = null; return h.toast(e.message, true); }
  const presets = o.presets || [];
  const engines = o.engines || [];
  const def = presets[0]?.text || '';
  h.showModal(`
    <div class="modal-box ed-box ref-edit">
      <div class="row between"><h3 style="margin:0">Enlarge the bust · ${h.esc(m.name)}</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
      <p class="sub" style="margin:6px 0 14px">Makes versions of this photo of her with the requested change (the outfit stays on). Then choose one: it replaces this photo or is added to her photos. The original photo does not change until you choose.</p>
      <div class="ed-grid">
        <img src="${media(src)}" alt="">
        <div class="stack">
          <div class="ed-presets">${presets.map((p) => `<button class="chip" data-preset="${h.esc(p.key)}">${icon('wand')}${h.esc(p.label)}</button>`).join('')}</div>
          <div class="field"><label for="re-text">Instruction</label><textarea class="input" id="re-text" rows="3" maxlength="1500">${h.esc(def)}</textarea></div>
          <div class="ed-row">
            <label class="field"><span>Engine</span><select class="input" id="re-engine">${engines.map((x) => `<option value="${h.esc(x.key)}" ${x.key === (o.default || 'seedream') ? 'selected' : ''}>${h.esc(x.label)} · ${usd(x.cost)}</option>`).join('')}</select></label>
            <label class="field"><span>Variants</span><select class="input" id="re-n">${[1, 2, 3, 4].map((n) => `<option ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <button class="btn primary" id="re-go">${icon('wand')}Generate</button>
          <div class="ed-status" id="re-status" role="status" aria-live="polite"></div>
        </div>
      </div>
      <div class="cands ref-results" id="re-results" data-key="${h.esc(`${m.id}:${src}`)}"></div>
    </div>`);
  const text = h.$('#re-text'); const eng = h.$('#re-engine'); const nSel = h.$('#re-n'); const go = h.$('#re-go'); const st = h.$('#re-status');
  let running = false;
  const key = `${m.id}:${src}`;
  const showResults = () => {
    const box = h.$('#re-results');
    if (!box || box.dataset.key !== key) return;
    const list = refEditResults.get(key) || [];
    box.innerHTML = list.map((c) => `<div class="cand"><img src="${media(c.path)}" data-zoom-src="${media(c.path)}" alt="">
      <button class="btn sm primary" data-apply="${h.esc(c.path)}" data-mode="replace">${icon('check')}Replace this photo</button>
      <button class="btn sm" data-apply="${h.esc(c.path)}" data-mode="add">${icon('plus')}Add to her photos</button></div>`).join('');
    h.$$('[data-zoom-src]', box).forEach((img) => (img.onclick = () => window.open(img.dataset.zoomSrc, '_blank')));
    h.$$('[data-apply]', box).forEach((b) => (b.onclick = async () => {
      h.$$('[data-apply]', box).forEach((x) => (x.disabled = true));
      try {
        await h.api(`/api/models/${m.id}/images/apply`, { method: 'POST', body: { path: src, with: b.dataset.apply, mode: b.dataset.mode } });
        if (b.dataset.mode === 'add') refEditResults.set(key, list.filter((x) => x.path !== b.dataset.apply)); else refEditResults.delete(key);
        h.closeModal();
        h.toast(b.dataset.mode === 'add' ? 'Added to her photos (Style and outfit)' : 'Photo replaced: the next projects already use it');
        done?.();
      } catch (err) { h.toast(err.message, true); h.$$('[data-apply]', box).forEach((x) => (x.disabled = false)); }
    }));
  };
  const paint = () => {
    const cost = (engines.find((x) => x.key === eng.value)?.cost || 0) * Number(nSel.value);
    go.innerHTML = `${icon('wand')}Generate ${nSel.value === '1' ? '1 version' : `${nSel.value} versions`} · ${usd(cost)}`;
    go.disabled = running || !text.value.trim();
  };
  text.oninput = paint; eng.onchange = paint; nSel.onchange = paint;
  h.$$('[data-preset]').forEach((b) => (b.onclick = () => { if (running) return; text.value = presets.find((x) => x.key === b.dataset.preset)?.text || text.value; paint(); }));
  paint();
  showResults(); // versions made before (the window was closed, or an earlier "Gerar")
  go.onclick = async () => {
    running = true;
    [go, text, eng, nSel].forEach((x) => (x.disabled = true));
    st.className = 'ed-status'; st.innerHTML = '<span class="spinner inline"></span>Generating. It usually takes 15 to 60 seconds.';
    try {
      const r = await h.api(`/api/models/${m.id}/images/edit`, { method: 'POST', body: { path: src, change: text.value.trim(), preset: presets.find((x) => x.text === text.value.trim())?.key, engine: eng.value, n: Number(nSel.value) } });
      refEditResults.set(key, [...(refEditResults.get(key) || []), ...r.candidates]); // added to the earlier ones, never replacing them
      if (!st.isConnected) { running = false; return h.toast(`${r.candidates.length} version(s) ready: open “Enlarge the bust” on this photo to choose`); }
      st.textContent = r.candidates.length < r.asked ? `${r.candidates.length} of ${r.asked} versions (the others were refused or failed). Choose one:` : 'Choose one:';
      showResults();
    } catch (err) {
      if (!st.isConnected) return h.toast(err.message, true);
      st.className = 'ed-status err'; st.textContent = stripEmoji(err.message);
    }
    running = false;
    [text, eng, nSel].forEach((x) => (x.disabled = false));
    paint();
  };
}

async function openPoseModal(genId, imagePath, reload) {
  let poses;
  try { poses = await loadPoses(); } catch (e) { return h.toast(e.message, true); }
  h.showModal(`<div class="modal-box small" style="max-width:640px">
    <div class="row between"><h3 style="margin:0;display:flex;align-items:center;gap:8px">${icon('person')}Generate in other poses</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
    <div class="row" style="gap:14px;align-items:flex-start;margin-top:12px">
      <img src="/media/${h.esc(imagePath)}" style="width:120px;border-radius:10px" alt="">
      <div style="flex:1"><p class="sub" style="font-size:12.5px;margin:0 0 10px">Same model, same setting, outfit and lighting. Choose the poses you want (≈$0.08 each).</p>
        <div class="pose-pick" id="pm-poses">${poses.map((p) => `<label class="chip pose"><input type="checkbox" value="${p.key}" hidden>${h.esc(p.label)}</label>`).join('')}</div>
        <input class="input" id="pm-custom" style="margin-top:8px;width:100%" placeholder="Custom pose (optional)">
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><span class="dim" id="pm-count" style="font-size:12.5px"></span><button class="btn primary" id="pm-go">Generate poses</button></div>
  </div>`);
  const upd = () => {
    h.$$('#pm-poses .pose').forEach((c) => c.classList.toggle('active', c.querySelector('input').checked));
    const n = h.$$('#pm-poses input:checked').length + (h.$('#pm-custom').value.trim() ? 1 : 0);
    h.$('#pm-count').textContent = n ? `${n} photo(s) · ~${usd(n * PHOTO_COST)}` : '';
  };
  h.$$('#pm-poses input').forEach((x) => (x.onchange = upd));
  h.$('#pm-custom').oninput = upd;
  h.$('#pm-go').onclick = async () => {
    const go = h.$('#pm-go');
    go.disabled = true;
    try {
      await h.api(`/api/generations/${genId}/poses`, { method: 'POST', body: { image: imagePath, poses: h.$$('#pm-poses input:checked').map((x) => x.value), customPose: h.$('#pm-custom').value } });
      h.closeModal(); h.toast('Generating the poses'); reload?.();
    } catch (e) { h.toast(e.message, true); if (go.isConnected) go.disabled = false; }
  };
}


// Her universe (places, outfits) as optional replacements of the original scene in remakes.
async function loadUniverseSelects() {
  const pick = () => Number(h.$('input[name=rm-model]:checked')?.value) || null;
  const modelId = pick();
  const assets = await modelAssets(modelId); // one request per model, shared with the outfit picker
  if (modelId !== pick()) return; // the user switched model meanwhile
  const place = h.$('#rm-place');
  if (place) {
    const places = assets.filter((a) => a.type === 'location' && a.path);
    place.innerHTML = '<option value="">From the original (post/reel)</option>' + places.map((a) => `<option value="${a.id}">${h.esc(a.name)}</option>`).join('');
    h.$('.uni-row')?.classList.toggle('hidden', !places.length);
  }
  loadOutfitPicker(modelId, undefined, assets);
}
let rmOutfit = null;
async function loadOutfitPicker(modelId, select, assets) {
  if (!h.$('#rm-outfits')) return;
  if (select !== undefined) rmOutfit = select;
  const all = assets || await modelAssets(modelId);
  const box = h.$('#rm-outfits'); // looked up after the await: the page may have been redrawn
  if (!box) return;
  const outfits = all.filter((a) => a.type === 'outfit' && a.path);
  if (rmOutfit && !outfits.some((o) => o.id === rmOutfit)) rmOutfit = null;
  box.innerHTML = `<button class="pick ${rmOutfit ? '' : 'active'}" data-outfit="">From the original<small>(reel/post)</small></button>
    ${outfits.map((o) => `<button class="pick img ${rmOutfit === o.id ? 'active' : ''}" data-outfit="${o.id}" title="${h.esc(o.description || o.name)}" style="background-image:url('${media(o.clean_path || o.path)}')"><small>${o.clean_path ? icon('check', { size: 11 }) : ''}${h.esc(o.name)}</small><i data-del-outfit="${o.id}" title="Delete from the wardrobe" aria-label="Delete from the wardrobe">${icon('x')}</i></button>`).join('')}
    ${modelId ? `<label class="pick add" id="rm-outfit-drop" title="Drag or choose a photo of the garment">${icon('plus')}<small>Add garment</small><input type="file" accept="image/*" hidden id="rm-outfit-file"></label>` : ''}`;
  h.$$('[data-outfit]', box).forEach((b) => (b.onclick = (e) => {
    if (e.target.closest('[data-del-outfit]')) return;
    rmOutfit = Number(b.dataset.outfit) || null;
    h.$$('[data-outfit]', box).forEach((x) => x.classList.toggle('active', x === b));
    syncOutfitHint();
  }));
  h.$$('[data-del-outfit]', box).forEach((x) => (x.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this outfit from the model's wardrobe?")) return;
    try {
      await h.api(`/api/assets/${x.dataset.delOutfit}`, { method: 'DELETE' });
    } catch (err) { h.toast(err.message, true); }
    assetsCache.delete(modelId);
    loadOutfitPicker(modelId);
  }));
  const drop = h.$('#rm-outfit-drop', box);
  if (drop) {
    const add = async (file) => {
      if (!file?.type.startsWith('image/')) return h.toast('That is not an image', true);
      drop.innerHTML = '<span class="spinner inline"></span><small>Saving…</small>';
      try {
        const image = await imageFileToDataUrl(file);
        const name = (file.name || 'Outfit').replace(/\.[^.]+$/, '').slice(0, 40) || 'Outfit';
        const a = await h.api(`/api/models/${modelId}/assets`, { method: 'POST', body: { type: 'outfit', name, image } });
        h.toast('Outfit saved to her wardrobe and chosen for this remake');
        assetsCache.delete(modelId);
        loadOutfitPicker(modelId, a.id);
      } catch (err) { h.toast(err.message, true); assetsCache.delete(modelId); loadOutfitPicker(modelId); }
    };
    h.$('#rm-outfit-file', drop).onchange = (e) => add(e.target.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); add([...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))); };
  }
  syncOutfitHint();
}
// A chosen outfit replaces the "Roupa" dropdown (same as video / covered / hers).
function syncOutfitHint() {
  const sel = h.$('[data-opt=keepOutfit]') || h.$('#ph-outfit');
  if (sel) { sel.disabled = !!rmOutfit; sel.title = rmOutfit ? 'You are using the outfit chosen below' : ''; }
  rmRecalc?.();
}
function imageFileToDataUrl(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error(`Could not read ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}
const frameTag = (p) => (!p ? '<span class="status new">Reel cover</span>' : /_auto_/.test(p) ? '<span class="status ok">Start of the video</span>' : '<span class="status ok">Chosen</span>');
const universeCfg = () => ({ placeId: Number(h.$('#rm-place')?.value) || null, outfitId: rmOutfit || null });
