// Projetos: the front page. On the left, every project (one remake run) with the step it is at; on the right, a new
// project from a reel link, or the project picked in the list. "Foco" takes you to the next project that needs you
// and, once you act on it (pick the image, approve…), straight to the one after.
import { icon, stripEmoji } from './icons.js';
import { patchGenList, studioBadge, videoStep, pipelineStatus, pipelineWarnings } from './pipeline.js';
import { fmtWhen } from './agenda-time.js';

let h; // { $, $$, esc, api, toast, ago }
export function init(helpers) {
  h = helpers;
  addEventListener('workerchange', () => paintFocusBtn()); // "Só os meus" only makes sense with a person
}

const onProjects = () => /^#\/projects(?:[/?]|$)/.test(location.hash) || !location.hash || location.hash === '#/';
const openId = () => Number((location.hash.match(/^#\/projects\/(\d+)/) || [])[1]) || null;
const media = (p) => `/media/${h.esc(p)}`;
const EDITABLE = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=file]), select';
// Never pull the page away while you type a prompt or have a link waiting in "Novo projeto".
const typing = () => !!document.activeElement?.matches?.(EDITABLE) || !!h.$('#np-url')?.value.trim();

const TODO = ['awaiting_approval', 'review', 'failed'];
const RUNNING = ['queued', 'imaging', 'animating'];
const VIEWS = [['open', 'Open'], ['todo', 'Needs you'], ['active', 'Running'], ['ready', 'Ready'], ['scheduled', 'Scheduled'], ['archived', 'Archive']];
const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
// 1 → "1st", 2 → "2nd", 11 → "11th": a place in the queue.
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// focus: Foco on; waiting: Foco found nothing and keeps looking; auto: the project Foco itself opened last.
const st = { view: 'open', q: '', model: '', worker: '', mine: false, focus: false, waiting: false, auto: null, skip: new Set() };
try { st.focus = sessionStorage.getItem('pj-focus') === '1'; st.mine = sessionStorage.getItem('pj-mine') === '1'; } catch {}
const hasWorker = () => (h.getWorker?.() || 0) > 0;

let listTimer = null;
let projTimer = null;
let waitTimer = null;
let listSeq = 0;
let projSeq = 0;
let listSig = '';
const seenStage = new Map(); // project id -> stage last shown, to notice that you have just acted on it

// ---- steps -------------------------------------------------------------------------------
const STEPS = { video: ['Source', 'Swap', 'Enlargement', 'Video', 'Review', 'Final', 'Publish'], photo: ['Post', 'Photos', 'Review', 'Publish'] };
/** Waiting for a person right now (not while its enlargement, Topaz or video runs by itself). */
const waits = (p) => TODO.includes(p.stage) && !p.busy;

/** Where a project is: { n: step (1-based) | null, label, tone }. A failure sits on the step where it stopped. */
function where(p) {
  const video = p.kind === 'video';
  const chosen = p.chosen ?? !!p.chosen_image;
  const images = p.images ?? (p.candidates || []).length;
  const hasVideo = p.has_video ?? !!p.video_path;
  const step = p.step ?? p.config?.step ?? null;
  if (p.publish && p.stage === 'approved') return { n: video ? 7 : 4, label: p.publish === 'trial' ? 'Scheduled (Trial)' : 'Scheduled', tone: 'ok', scheduled: true };
  if (video) {
    // The 7 steps of a video project (the same rule as the steps on its page).
    switch (p.stage) {
      case 'queued': return { n: 1, label: 'Queued', tone: 'run' };
      case 'imaging': return { n: 2, label: 'Generating images', tone: 'run' };
      case 'awaiting_approval':
        if (step === 'enlarge') return p.busy ? { n: 3, label: 'Enlarging', tone: 'run' } : { n: 3, label: 'Choose the enlargement', tone: 'act' };
        if (step === 'video') return { n: 4, label: 'Generate the video', tone: 'act' };
        return { n: 2, label: 'Pick the swap', tone: 'act' };
      case 'animating': return { n: 4, label: 'Generating video', tone: 'run' };
      case 'review': return p.busy ? { n: 5, label: 'Working', tone: 'run' } : { n: 5, label: 'Review video', tone: 'act' };
      case 'approved': return p.busy ? { n: 6, label: 'Topaz working', tone: 'run' } : { n: 7, label: 'Ready to publish', tone: 'ok' };
      case 'failed': {
        const n = hasVideo ? 5 : chosen ? 4 : step === 'enlarge' ? 3 : images ? 2 : 1;
        return { n, label: `Failed ${{ 1: 'at the start', 2: 'on the images', 3: 'on the enlargement', 4: 'on the video', 5: 'in review' }[n]}`, tone: 'bad', failed: true };
      }
      default: break;
    }
  }
  switch (p.stage) {
    case 'queued': return { n: 1, label: 'Queued', tone: 'run' };
    case 'imaging': return { n: 2, label: video ? 'Generating images' : 'Generating photos', tone: 'run' };
    case 'awaiting_approval': return { n: 2, label: 'Choose an image', tone: 'act' };
    case 'animating': return { n: 3, label: 'Generating video', tone: 'run' };
    case 'review': return { n: video ? 4 : 3, label: video ? 'Review video' : 'Review photos', tone: 'act' };
    case 'approved': return { n: video ? 5 : 4, label: 'Ready to publish', tone: 'ok' };
    case 'failed': {
      const n = !video ? 2 : hasVideo ? 4 : chosen && images ? 3 : 2;
      return { n, label: `Failed ${{ 2: video ? 'on the images' : 'on the photos', 3: 'on the video', 4: 'in review' }[n]}`, tone: 'bad', failed: true };
    }
    case 'rejected': return { n: null, label: 'Rejected', tone: 'off' };
    case 'cancelled': return { n: null, label: 'Canceled', tone: 'off' };
    default: return { n: null, label: String(p.stage || ''), tone: 'off' };
  }
}

function stepperHtml(p) {
  const w = where(p);
  const video = p.kind === 'video';
  const names = video ? STEPS.video : STEPS.photo;
  const at = video && p.config ? videoStep(p) : w.n; // the full project knows its steps exactly
  const cfg = p.config || {};
  return `<ol class="pj-steps" aria-label="Project steps">${names.map((name, i) => {
    const n = i + 1;
    // Steps passed without being used: the enlargement skipped, the optional Topaz not run.
    const skipped = video && n < at && ((n === 3 && cfg.skipEnlarge) || (n === 6 && !cfg.upscaled));
    const cls = !at ? '' : n < at ? (skipped ? 'skip' : 'done') : n === at ? (w.failed ? 'fail' : 'cur') : '';
    const label = `<span class="n">${cls === 'done' ? icon('check') : n}</span>${name}`;
    return `${i ? '<li class="sep" aria-hidden="true"></li>' : ''}<li class="${cls}" ${cls === 'cur' || cls === 'fail' ? 'aria-current="step"' : ''}>${video ? `<button type="button" data-goto="${n}" title="Go to step ${n}">${label}</button>` : label}</li>`;
  }).join('')}</ol>`;
}

// ---- shell -------------------------------------------------------------------------------
export async function renderProjects(params) {
  clearTimeout(projTimer);
  const id = Number(params.get('id')) || null;
  // #/projects?view=active (the 'A correr' chip at the top): open that list.
  const wantView = params.get('view');
  if (wantView && VIEWS.some(([v]) => v === wantView) && wantView !== st.view) { st.view = wantView; listSig = ''; }
  // Anything Foco did not open itself is you taking over: stop waiting for the next one.
  if (id !== st.auto) { st.waiting = false; clearTimeout(waitTimer); }
  st.auto = null;
  if (!h.$('#pj-shell')) {
    h.$('#view').innerHTML = `
      <div class="pj" id="pj-shell">
        <aside class="pj-list" aria-label="Projects">
          <div class="pj-list-head">
            <div class="row between"><b>Projects</b><a class="btn sm primary" href="#/projects">${icon('plus')}New</a></div>
            <div class="pj-tools">
              <button class="btn sm pj-focus" id="pj-focus" title="Takes you to the next project that needs you and, once you act on it, to the one after">${icon('target')}Focus</button>
              <label class="check pj-mine" id="pj-mine-box" title="Focus only takes you to your own projects (the name in “Working as”)" hidden><input type="checkbox" id="pj-mine">Only mine</label>
              <input class="input" id="pj-q" type="search" placeholder="No. or @creator" aria-label="Search projects by number or creator" autocomplete="off" spellcheck="false">
            </div>
            <div class="pj-tabs" id="pj-tabs" role="tablist" aria-label="Project lists"></div>
            <div class="pj-facets" id="pj-facets"></div>
          </div>
          <div class="pj-items" id="pj-items"><div class="page-loading" style="min-height:120px"><div class="spinner"></div></div></div>
        </aside>
        <section class="pj-main" id="pj-main"></section>
      </div>`;
    bindShell();
    listSig = '';
  }
  paintFocusBtn();
  h.$('#page-title').textContent = id ? `Project #${id}` : 'Projects';
  markSelected();
  h.$('.main').scrollTop = 0;
  loadList();
  if (id) await loadProject(id, true);
  else renderNew();
}

function bindShell() {
  h.$('#pj-focus').onclick = () => setFocus(!st.focus);
  const mine = h.$('#pj-mine');
  mine.checked = st.mine;
  mine.onchange = () => { st.mine = mine.checked; try { sessionStorage.setItem('pj-mine', st.mine ? '1' : '0'); } catch {} st.skip.clear(); if (st.focus) goNext({ manual: true }); };
  const q = h.$('#pj-q');
  q.value = st.q;
  let t = null;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = q.value.trim(); listSig = ''; loadList(); }, 250); };
  q.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const n = q.value.trim().replace(/^#/, '');
    if (/^\d+$/.test(n)) { e.preventDefault(); location.hash = `#/projects/${n}`; }
  };
}

function paintTabs(counts) {
  const box = h.$('#pj-tabs');
  if (!box) return;
  box.innerHTML = VIEWS.map(([v, l]) => `<button class="pj-tab ${st.view === v ? 'active' : ''}" role="tab" aria-selected="${st.view === v}" data-v="${v}">${l}${v !== 'archived' ? ` <b>${counts?.[v] ?? 0}</b>` : ''}</button>`).join('');
  h.$$('button', box).forEach((b) => (b.onclick = () => { st.view = b.dataset.v; listSig = ''; loadList(); }));
}

const facetNames = new Map(); // 'm3' / 'w5' → the name seen in an earlier list
/** Model and person chips (only when there is a choice to make). */
function paintFacets(f) {
  const box = h.$('#pj-facets');
  if (!box || !f) return;
  f.models.forEach((m) => facetNames.set(`m${m.id}`, m.name));
  f.workers.forEach((w) => facetNames.set(`w${w.id || 0}`, w.name));
  const chip = (kind, id, label, n, on) => `<button class="chip ${on ? 'active' : ''}" data-${kind}="${id}">${h.esc(label)}${n != null ? ` <b>${n}</b>` : ''}</button>`;
  const models = f.models.filter((m) => m.id);
  const people = [...f.workers];
  // What you picked stays visible (with 0) in a list that has none of it.
  if (st.model && !models.some((m) => String(m.id) === String(st.model))) models.push({ id: st.model, name: facetNames.get(`m${st.model}`), n: 0 });
  if (st.worker !== '' && !people.some((w) => String(w.id || 0) === st.worker)) people.push({ id: Number(st.worker) || null, name: facetNames.get(`w${st.worker}`), n: 0 });
  const showModels = models.length > 1 || st.model;
  const showPeople = people.some((w) => w.id) || st.worker !== '';
  box.innerHTML = `${showModels ? `<div class="pj-chips">${chip('model', '', 'All models', null, !st.model)}${models.map((m) => chip('model', m.id, m.name || 'No model', m.n, String(st.model) === String(m.id))).join('')}</div>` : ''}
    ${showPeople ? `<div class="pj-chips">${chip('worker', '', 'All people', null, st.worker === '')}${people.map((w) => chip('worker', w.id || 0, w.name || 'No person', w.n, st.worker === String(w.id || 0))).join('')}</div>` : ''}`;
  h.$$('[data-model]', box).forEach((b) => (b.onclick = () => { st.model = b.dataset.model; listSig = ''; loadList(); }));
  h.$$('[data-worker]', box).forEach((b) => (b.onclick = () => { st.worker = b.dataset.worker; listSig = ''; loadList(); }));
}

// ---- list --------------------------------------------------------------------------------
async function loadList() {
  clearTimeout(listTimer);
  if (!h.$('#pj-items')) return;
  const seq = ++listSeq;
  let d;
  try {
    d = await h.api(`/api/projects?view=${st.view}${st.q ? `&q=${encodeURIComponent(st.q)}` : ''}${st.model ? `&model=${st.model}` : ''}${st.worker !== '' ? `&worker=${st.worker}` : ''}`);
  } catch (e) {
    if (seq !== listSeq || !onProjects()) return;
    const box = h.$('#pj-items');
    if (box && !box.querySelector('.pj-item')) box.innerHTML = `<div class="pj-empty">${h.esc(stripEmoji(e.message))}</div>`;
    listTimer = setTimeout(loadList, 5000);
    return;
  }
  if (seq !== listSeq || !onProjects()) return;
  const box = h.$('#pj-items');
  if (!box) return;
  paintTabs(d.counts);
  paintFacets(d.facets);
  const badge = h.$('#nav-projects');
  if (badge) badge.textContent = d.counts.todo || '';
  const sig = JSON.stringify([st.view, st.q, d.items.map((p) => [p.id, p.stage, p.step, p.thumb, p.busy, p.archived, p.updated_at, p.model_name, p.worker_name, p.queuePos, p.publish])]);
  if (sig !== listSig) {
    listSig = sig;
    box.innerHTML = d.items.length ? d.items.map(itemHtml).join('') : `<div class="pj-empty">${emptyText()}</div>`;
    h.$$('[data-archive]', box).forEach((b) => (b.onclick = (e) => { e.preventDefault(); archive(Number(b.dataset.archive), b.dataset.archived !== '1'); }));
    markSelected();
  }
  // Running projects refresh every few seconds; otherwise a slow refresh picks up projects started elsewhere.
  listTimer = setTimeout(loadList, d.items.some((p) => RUNNING.includes(p.stage) || p.busy) ? 4000 : 15000);
}

const emptyText = () => (st.q ? 'No projects match this search.'
  : st.model || st.worker !== '' ? 'No projects in this list match these filters.'
  : { open: 'No projects yet. Paste a reel link to start.', todo: 'Nothing is waiting for you here. Ready videos are in <a href="#/approval">Approval</a>.', active: 'Nothing is generating right now.', ready: 'No projects are ready to publish.', scheduled: 'Nothing scheduled. Schedule the ready videos in Approval.', archived: 'The archive is empty.' }[st.view]);

function itemHtml(p) {
  const w = where(p);
  const step = w.n ? `Step ${w.n} · ${w.label}` : w.label;
  // Arquivar while it is open; Reabrir once archived. Rejected / cancelled ones go back to review from their card.
  const btn = RUNNING.includes(p.stage) || p.busy ? ''
    : p.archived ? `<button class="pj-x" data-archive="${p.id}" data-archived="1" title="Reopen project #${p.id}" aria-label="Reopen project #${p.id}">${icon('rotate-ccw')}</button>`
    : ['rejected', 'cancelled'].includes(p.stage) ? ''
    : `<button class="pj-x" data-archive="${p.id}" data-archived="0" title="Archive project #${p.id} (it leaves the list, nothing is deleted)" aria-label="Archive project #${p.id}">${icon('archive')}</button>`;
  return `
    <div class="pj-item ${w.tone}" data-id="${p.id}">
      <a class="pj-link" href="#/projects/${p.id}">
        <span class="pj-thumb" style="${p.thumb ? `background-image:url('${media(p.thumb)}')` : ''}"></span>
        <span class="pj-info">
          <span class="pj-top"><b>@${h.esc(p.handle)}</b><span class="pj-id">#${p.id}</span></span>
          <span class="stage ${w.tone}">${h.esc(step)}${p.queuePos ? ` · ${ord(p.queuePos)} in queue` : ''}</span>
          <span class="pj-sub">${p.model_name ? `${h.esc(p.model_name)} · ` : ''}${p.kind === 'video' ? 'video' : 'photos'}${p.worker_name ? ` · by ${h.esc(p.worker_name)}` : ''} · ${h.ago(p.updated_at)} ago</span>
        </span>
      </a>
      ${btn}
    </div>`;
}

function markSelected() {
  const id = openId();
  h.$$('#pj-items .pj-item').forEach((el) => {
    const sel = Number(el.dataset.id) === id;
    el.classList.toggle('sel', sel);
    const a = el.querySelector('.pj-link');
    if (sel) a?.setAttribute('aria-current', 'page'); else a?.removeAttribute('aria-current');
  });
}

async function archive(id, archived) {
  try {
    await h.api(`/api/projects/${id}/archive`, { method: 'POST', body: { archived } });
    h.toast(archived ? `Project #${id} archived` : `Project #${id} reopened`);
    listSig = '';
    loadList();
    if (openId() === id) loadProject(id);
  } catch (e) { h.toast(e.message, true); }
}

// ---- A correr agora (under "Novo projeto") -------------------------------------------------------------------------
let runTimer = null;
async function loadRunning() {
  clearTimeout(runTimer);
  const box = h.$('#pj-running');
  if (!box || openId()) return;
  let d;
  try { d = await h.api('/api/running'); } catch { runTimer = setTimeout(loadRunning, 15000); return; }
  if (!h.$('#pj-running') || openId()) return;
  const n = d.projects.length + d.other.length;
  box.hidden = false;
  const rowP = (p) => `<a class="pj-run-row" href="#/projects/${p.id}"><span class="pj-run-state">${p.busy ? '<span class="spinner inline"></span>' : p.queuePos ? `${ord(p.queuePos)} in queue` : 'starting'}</span><b>#${p.id}</b><span class="dim">@${h.esc(p.handle)}${p.model_name ? ` · ${h.esc(p.model_name)}` : ''}</span><span class="grow"></span><span class="pj-run-step">${h.esc(stripEmoji(p.step_status || where(p).label))}</span></a>`;
  const rowJ = (j) => `<a class="pj-run-row" href="${j.href}"><span class="pj-run-state">${j.stage === 'queued' ? 'queued' : '<span class="spinner inline"></span>'}</span><b>${h.esc(j.label)}</b><span class="dim">#${j.id}</span><span class="grow"></span><span class="pj-run-step">${h.esc(stripEmoji(j.step_status || ''))}</span></a>`;
  box.innerHTML = `
    <div class="row between" style="gap:10px;flex-wrap:wrap"><h3 style="margin:0">Running now${n ? ` <span class="dim">(${n})</span>` : ''}</h3>
      <div class="pj-par" role="group" aria-label="Projects in parallel" title="How many projects generate at the same time. More in parallel finishes sooner, but spends credits faster.">In parallel
        <span class="seg">${[1, 2, 3, 4].map((k) => `<button type="button" data-par="${k}" class="${k === d.parallel ? 'active' : ''}" aria-pressed="${k === d.parallel}">${k}</button>`).join('')}</span></div></div>
    ${n ? `<div class="pj-run-list">${d.projects.map(rowP).join('')}${d.other.map(rowJ).join('')}</div>` : '<div class="dim" style="font-size:13px;margin-top:8px">Nothing is generating right now.</div>'}`;
  h.$$('[data-par]', box).forEach((b) => (b.onclick = async () => {
    if (Number(b.dataset.par) === d.parallel) return;
    try { await h.api('/api/running/parallel', { method: 'PUT', body: { parallel: Number(b.dataset.par) } }); h.toast(`${b.dataset.par} project(s) in parallel`); loadRunning(); } catch (e) { h.toast(e.message, true); }
  }));
  runTimer = setTimeout(loadRunning, n ? 4000 : 20000);
}

// ---- new project -------------------------------------------------------------------------
function renderNew() {
  const main = h.$('#pj-main');
  if (!main) return;
  delete main.dataset.id;
  main.innerHTML = `
    <div id="pj-focus-note"></div>
    <div class="card stack np-card">
      <h3 style="margin:0">${icon('plus-square')}New project</h3>
      <label class="field"><span>Reel link</span>
        <div class="np-row">
          <input class="input" id="np-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.tiktok.com/@…/video/…  or  https://www.instagram.com/reel/…">
          <button class="btn primary" id="np-go">${icon('arrow-right')}Open project</button>
        </div>
        <small>The app downloads the reel and opens it. There you choose the moment in the video and the model, then generate.</small></label>
      <div id="np-msg" aria-live="polite"></div>
    </div>
    <div id="pj-warn"></div>
    <div class="card pj-running" id="pj-running" hidden></div>`;
  loadRunning();
  pipelineStatus().then((st) => { const w = h.$('#pj-warn'); if (w && !openId()) w.innerHTML = pipelineWarnings(st); }).catch(() => {});
  const input = h.$('#np-url');
  const go = h.$('#np-go');
  const msg = h.$('#np-msg');
  input.focus({ preventScroll: true }); // on a narrow screen the list sits above: never scroll past it
  const open = async () => {
    const url = input.value.trim();
    if (!url) { input.focus(); return h.toast('Paste a reel link', true); }
    go.disabled = true;
    input.disabled = true;
    msg.innerHTML = `<div class="msg"><span class="spinner inline"></span>Fetching the reel and downloading the video… this can take up to a minute.</div>`;
    try {
      const r = await h.api('/api/projects/from-link', { method: 'POST', body: { url } });
      if (!onProjects() || openId()) return;
      location.hash = `#/remake/${r.reelId}`;
    } catch (e) {
      if (!onProjects() || openId()) return;
      msg.innerHTML = `<div class="callout warn">${icon('alert-triangle')}<div>${h.esc(stripEmoji(e.message))}</div></div>`;
      go.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };
  go.onclick = open;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } };
  if (st.focus) paintFocusNote(null);
}

// ---- one project -------------------------------------------------------------------------
async function loadProject(id, first = false) {
  clearTimeout(projTimer);
  const seq = ++projSeq;
  const main = h.$('#pj-main');
  if (!main) return;
  if (first) { delete main.dataset.id; main.innerHTML = '<div class="page-loading" style="min-height:240px"><div class="spinner"></div></div>'; }
  let g;
  try {
    g = await h.api(`/api/generations/${id}`);
  } catch (e) {
    if (seq !== projSeq || openId() !== id) return;
    if (/não existe|does not exist|not found/i.test(e.message)) {
      seenStage.delete(id);
      delete main.dataset.id;
      main.innerHTML = `<div id="pj-focus-note"></div><div class="empty">${icon('alert-circle', { size: 28 })}<h3>Project #${id} does not exist</h3><p>It may have been deleted.</p><div class="row" style="justify-content:center"><a class="btn" href="#/projects">New project</a></div></div>`;
      if (st.focus) goNext({});
      return;
    }
    if (first) main.innerHTML = `<div class="empty">${icon('alert-circle', { size: 28 })}<h3>Could not open project #${id}</h3><p>${h.esc(stripEmoji(e.message))}</p></div>`;
    projTimer = setTimeout(() => loadProject(id), 5000);
    return;
  }
  if (seq !== projSeq || openId() !== id) return;
  const before = seenStage.get(id);
  seenStage.set(id, waits(g) ? 'waits' : g.stage);
  paintProject(g);
  if (st.focus) {
    // You have just acted on it (it no longer waits for you): Foco opens the next one that does.
    if (before === 'waits' && !waits(g)) goNext({ skipCurrent: true }); // e.g. the enlargement or the video started
    else if (!st.waiting) paintFocusNote(g);
  }
  projTimer = setTimeout(() => loadProject(id), RUNNING.includes(g.stage) || g.busy ? 3000 : 12000);
}

function paintProject(g) {
  const main = h.$('#pj-main');
  if (!main) return;
  if (!h.$('#pj-gen') || Number(main.dataset.id) !== g.id) {
    main.dataset.id = g.id;
    main.innerHTML = `
      <div class="pj-bar">
        <div id="pj-steps"></div>
        <div class="row" id="pj-actions"></div>
      </div>
      <div id="pj-focus-note"></div>
      <div id="pj-gen" class="stack"></div>
      <div id="pj-posts"></div>`;
  }
  h.$('#pj-steps').innerHTML = stepperHtml(g);
  h.$$('#pj-steps [data-goto]').forEach((b) => (b.onclick = () => {
    const sec = h.$(`#pj-gen .gstep[data-step="${b.dataset.goto}"]`);
    if (!sec) return;
    if (sec.tagName === 'DETAILS') sec.open = true;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const running = RUNNING.includes(g.stage) || g.busy;
  const acts = `
    ${st.focus ? `<button class="btn sm" id="pj-next" title="Leave this one for later and open the next one that needs you">${icon('skip-forward')}Next</button>` : ''}
    <a class="btn sm" href="#/remake/${g.reel_id}?gen=${g.id}" title="This reel's Remake page: step 1 at the top and this project's steps below (also to generate another version)">${icon('repeat')}Open in Remake</a>
    ${g.url ? `<a class="btn sm ghost" href="${h.esc(g.url)}" target="_blank" rel="noopener">${icon('external-link')}Original reel</a>` : ''}
    <button class="btn sm ghost" id="pj-launch" title="Saves this reel to Launch links, to launch it on new models">${icon('link')}Save as link</button>
    ${running ? '' : `<button class="btn sm ghost" id="pj-arch" title="${g.archived ? 'Puts the project back in the list' : 'Takes the project out of the list (nothing is deleted)'}">${icon(g.archived ? 'rotate-ccw' : 'archive')}${g.archived ? 'Reopen' : 'Archive'}</button>`}`;
  const box = h.$('#pj-actions');
  if (box.dataset.sig !== acts) {
    box.dataset.sig = acts;
    box.innerHTML = acts;
    const next = h.$('#pj-next');
    if (next) next.onclick = () => { st.skip.add(g.id); goNext({ skipCurrent: true, manual: true }); };
    const arch = h.$('#pj-arch');
    if (arch) arch.onclick = () => archive(g.id, !g.archived);
    h.$('#pj-launch').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await h.api('/api/launch-links', { method: 'POST', body: { reelId: g.reel_id } });
        h.toast(r.existed ? 'This reel is already in Launch links' : 'Saved to Launch links');
      } catch (err) { h.toast(err.message, true); }
      e.currentTarget.disabled = false;
    };
  }
  patchGenList(h.$('#pj-gen'), [g], () => { loadProject(g.id); listSig = ''; loadList(); studioBadge(); });
  if (g.publish) loadPosts(g);
  else { const pb = h.$('#pj-posts'); if (pb) { pb.innerHTML = ''; delete pb.dataset.sig; } }
}

// ---- its posts (once scheduled in Aprovação) ----------------------------------------------------------------------
let tzCache = null;
async function loadPosts(g) {
  let rows;
  try {
    tzCache ||= (await h.api('/api/approval/settings')).tz;
    rows = await h.api(`/api/projects/${g.id}/posts`);
  } catch { return; }
  const box = h.$('#pj-posts');
  if (!box || Number(h.$('#pj-main')?.dataset.id) !== g.id) return;
  const sig = JSON.stringify(rows.map((p) => [p.id, p.status, p.scheduled_at]));
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const when = (ts) => fmtWhen(ts, tzCache);
  const out = rows.some((p) => p.status !== 'scheduled');
  box.innerHTML = `
    <div class="card pj-posts">
      <div class="row between"><h3 style="margin:0">${icon('send')}Posts ${g.publish === 'trial' ? '(Trial)' : '(Normal)'}</h3>
        ${out ? '' : `<button class="btn sm ghost" data-unschedule title="Deletes these posts and the video goes back to Approval">${icon('rotate-ccw')}Undo scheduling</button>`}</div>
      <div class="pj-post-list">${rows.map((p) => `
        <div class="pj-post"><span class="pf-plat ${p.platform}">${PF_SHORT[p.platform]}</span><b>@${h.esc(p.handle)}</b><span class="dim">${when(p.scheduled_at)}</span>
          <span class="stage ${p.status === 'posted' ? 'ok' : p.status === 'failed' ? 'bad' : 'run'}">${{ posted: 'Posted', failed: 'Failed', pulled: 'Pulled' }[p.status] || 'Scheduled'}</span></div>`).join('')}</div>
      ${rows[0]?.caption ? `<div class="pj-post-cap"><span class="label">Caption</span>${h.esc(rows[0].caption)}</div>` : ''}
    </div>`;
  const un = h.$('[data-unschedule]', box);
  if (un) {
    un.onclick = async () => {
      if (!confirm(`Undo the scheduling of project #${g.id}? The posts are deleted and the video goes back to Approval.`)) return;
      un.disabled = true;
      try {
        await h.api(`/api/approval/${g.id}/undo`, { method: 'POST' });
        h.toast('Scheduling undone: the video is back in Approval');
        listSig = '';
        loadList();
        loadProject(g.id);
      } catch (e) { h.toast(e.message, true); un.disabled = false; }
    };
  }
}

// ---- Foco --------------------------------------------------------------------------------
function setFocus(on) {
  st.focus = on;
  try { sessionStorage.setItem('pj-focus', on ? '1' : '0'); } catch {}
  st.skip.clear();
  st.waiting = false;
  clearTimeout(waitTimer);
  paintFocusBtn();
  const id = openId();
  if (!on) {
    const note = h.$('#pj-focus-note');
    if (note) note.innerHTML = '';
    if (id) loadProject(id);
    return;
  }
  const cur = id && seenStage.get(id);
  if (cur === 'waits') {
    h.toast('Focus is on: once you handle this one, the next one opens');
    loadProject(id);
    return;
  }
  goNext({});
}

function paintFocusBtn() {
  const b = h.$('#pj-focus');
  if (!b) return;
  b.classList.toggle('on', st.focus);
  b.setAttribute('aria-pressed', String(st.focus));
  b.innerHTML = `${icon('target')}${st.focus ? 'Focus: on' : 'Focus'}`;
  const mineBox = h.$('#pj-mine-box');
  if (mineBox) mineBox.hidden = !hasWorker() || !st.focus; // it only steers Foco
}

/** Opens the project that has waited longest for you. With nothing waiting, keeps looking while Foco is on. */
async function goNext({ skipCurrent = false, manual = false } = {}) {
  clearTimeout(waitTimer);
  if (!st.focus || !onProjects()) return;
  const cur = openId();
  const skip = new Set(st.skip);
  if (skipCurrent && cur) skip.add(cur);
  let r = null;
  const qs = [skip.size ? `skip=${[...skip].join(',')}` : '', st.mine && hasWorker() ? 'mine=1' : ''].filter(Boolean).join('&');
  try { r = await h.api(`/api/projects/next${qs ? `?${qs}` : ''}`); } catch {}
  if (!st.focus || !onProjects() || openId() !== cur) return;
  if (r?.id) {
    if (typing() && !manual) { st.waiting = true; paintFocusNote(null, 'typing'); waitTimer = setTimeout(() => goNext({ skipCurrent }), 3000); return; }
    st.waiting = false;
    st.auto = r.id;
    location.hash = `#/projects/${r.id}`;
    return;
  }
  // Everything else was skipped with "Seguinte": start the round again.
  if (manual && st.skip.size) { st.skip.clear(); return goNext({ skipCurrent: true }); }
  st.waiting = true;
  paintFocusNote(null, r ? 'none' : 'error');
  waitTimer = setTimeout(() => goNext({ skipCurrent }), 5000);
}

function paintFocusNote(g, why) {
  const note = h.$('#pj-focus-note');
  if (!note || !st.focus) return;
  const running = g && (RUNNING.includes(g.stage) || g.busy);
  const text = why === 'none' ? 'Nothing is waiting for you here. The next one opens on its own when there is an image to choose, photos to review or a failure; ready videos go to <a href="#/approval">Approval</a>.'
    : why === 'error' ? 'Could not check the queue just now. Trying again shortly.'
    : why === 'typing' ? 'A project is waiting for you: it opens as soon as you finish typing.'
    : g && TODO.includes(g.stage) ? 'Once you handle this project, the next one that needs you opens.'
    : running ? 'This project is generating.'
    : 'Press Focus again to go to the next one that needs you.';
  note.innerHTML = `<div class="pj-focus-note">${icon('target')}<div><b>Focus is on.</b> ${text}</div>
    ${g && !TODO.includes(g.stage) && !st.waiting ? '<button class="btn sm" data-focus-next>Go to the next one</button>' : ''}
    <button class="btn sm ghost" data-focus-off>Turn off</button></div>`;
  const off = h.$('[data-focus-off]', note);
  if (off) off.onclick = () => setFocus(false);
  const nx = h.$('[data-focus-next]', note);
  if (nx) nx.onclick = () => goNext({ skipCurrent: true, manual: true });
}
