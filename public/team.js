// Equipa: who works on the operation, for how long and what they did. Also "A trabalhar como" (sidebar) and the
// presence ping that counts work time.
import { icon, stripEmoji } from './icons.js';
import { fmtHour, fmtWhen, fmtDate, PERIODS, presetRange } from './agenda-time.js';

let h; // { $, $$, esc, api, toast, showModal, closeModal, state, loadShared, titles, getWorker, setWorker, currentView, COLORS }
export function init(helpers) { h = helpers; }

const on = () => /^#\/team(?:[/?]|$)/.test(location.hash);
const RANGES = [...PERIODS, ['all', 'All time']]; // the same periods as Custos, plus everything
const ROLES = { admin: 'Administrator', va: 'Assistant' };
const st = { range: 'today', tz: 'Europe/Lisbon', open: new Set(), who: '', seq: 0, timer: null };
const nowS = () => Math.floor(Date.now() / 1000);
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`);
const colorOf = (p) => p.color || h.COLORS[p.id % h.COLORS.length];
const letter = (p, cls = '') => `<span class="avatar-letter ${cls}" style="--c:${h.esc(colorOf(p))}">${h.esc((p.name || '?')[0].toUpperCase())}</span>`;

// What each logged action counts as (the chips of a person), in this order.
const CHIPS = [
  ['projects', ['project']],
  ['images chosen', ['image', 'enlarge_pick']],
  ['images edited', ['image_edit']],
  ['redone', ['redo', 'variants']],
  ['videos generated', ['video_start']],
  ['Topaz finals', ['topaz']],
  ['videos approved', ['video_ok']],
  ['scheduled as Normal', ['normal']],
  ['scheduled as Trial', ['trial']],
  ['skipped', ['skip']],
  ['rejected', ['reject', 'cancel']],
  ['reviewed on the schedule', ['keep', 'pull', 'to_trial', 'reschedule', 'unschedule']],
  ['posted', ['posted']],
  ['reels in Discover', ['discover_keep', 'discover_pass']],
  ['reels in Review', ['review_keep', 'review_push']],
  ['submissions to Review', ['review_submit']],
  ['faces rated', ['face_verdict']],
  ['content generations', ['creation', 'creation_again', 'adult', 'redo_adult', 'faces_job', 'train']],
  ['undone', ['undo']],
];
const CHIPPED = new Set(CHIPS.flatMap(([, a]) => a));

/** One line of the activity list: "agendou o #12 (Normal, 3 contas)". */
function says(a) {
  const g = a.generation_id ? `<a href="#/projects/${a.generation_id}">#${a.generation_id}</a>` : '';
  const m = a.meta || {};
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const T = {
    project: `created project ${g}`,
    variants: `requested variants of ${g}`,
    image: m.enlarge ? `chose the swap for ${g} (${n(m.enlarge, 'enlargement requested', 'enlargements requested')})` : `chose the image for ${g}`,
    enlarge_pick: `chose the video image for ${g}`,
    video_start: `generated the video for ${g}`,
    topaz: `enhanced the video for ${g} with Topaz`,
    image_edit: m.preset === 'bust' ? `enlarged the bust in an image from ${g}` : `edited an image from ${g}`,
    redo: m.from === 'animating' ? `redid the video for ${g}` : m.from === 'imaging' ? `redid the images for ${g}` : `restarted ${g}`,
    video_ok: `approved the video for ${g}`,
    reject: `rejected ${g}`,
    cancel: `canceled ${g}`,
    reopen: `put ${g} back into review`,
    delete: `deleted ${g}`,
    archive: `archived ${g}`,
    unarchive: `reopened ${g}`,
    trim: `trimmed the video for ${g}`,
    trim_reset: `restored the full video for ${g}`,
    normal: `scheduled ${g} (Normal${m.posts ? `, ${n(m.posts, 'account', 'accounts')}` : ''})`,
    trial: `scheduled ${g} (Trial${m.posts ? `, ${n(m.posts, 'account', 'accounts')}` : ''})`,
    skip: `skipped ${g}`,
    undo: a.target?.startsWith('post:') ? `set a post for ${g} back to not posted`
      : a.target?.startsWith('reel:') ? 'undid a decision in Discover'
      : a.target?.startsWith('review:') ? 'undid a decision in Review'
      : g ? `undid the last decision on ${g}` : 'undid a decision',
    keep: `confirmed the schedule for ${g}`,
    pull: `removed ${g} from the schedule`,
    to_trial: `moved ${g} to Trial`,
    reschedule: `edited a post for ${g}`,
    unschedule: `unscheduled a post for ${g}`,
    posted: `marked a post for ${g} as posted`,
    discover_keep: 'saved a reel in Discover',
    discover_pass: 'passed on a reel in Discover',
    review_submit: m.n ? `sent ${n(m.n, 'link', 'links')} to Review` : 'sent links that were already in Review',
    review_keep: 'chose Keep for a reel in Review',
    review_push: 'chose Push for a reel in Review',
    link_saved: 'saved a launch link',
    launch: m.n ? `launched ${n(m.n, 'link', 'links')} to the Remake queue` : 'launched links that were already in the Remake queue',
    carousel_added: 'added a profile in Carousels',
    creation: 'generated content in Create content',
    creation_again: 'generated content again in Create content',
    adult: 'generated 18+ content',
    redo_adult: 'redid an 18+ job',
    train: 'trained a LoRA',
    faces_job: 'generated new faces',
    face_verdict: 'rated a face',
    model_created: `created the model ${h.esc(m.name || '')}`,
    accounts: 'changed the accounts in Profiles',
    captions: 'changed the captions in Profiles',
  };
  return T[a.action] || h.esc(a.action);
}

// ---- "A trabalhar como" (sidebar) ---------------------------------------------------------------------------------
export function renderWhoami() {
  const box = h.$('#whoami');
  if (!box) return;
  const people = h.state.workers || [];
  if (!people.length) { box.hidden = true; box.innerHTML = ''; return; }
  const cur = h.getWorker(); // id, 0 = "ninguém" chosen on purpose, null = never chosen
  box.hidden = false;
  box.classList.toggle('unset', cur === null);
  box.innerHTML = `<label for="whoami-sel">Working as</label>
    <select class="input" id="whoami-sel">
      ${cur === null ? '<option value="" selected disabled>Choose your name</option>' : ''}
      ${people.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${h.esc(p.name)}</option>`).join('')}
      <option value="0" ${cur === 0 ? 'selected' : ''}>No one (do not log)</option>
    </select>`;
  h.$('#whoami-sel').onchange = (e) => {
    const id = Number(e.target.value) || 0;
    h.setWorker(id);
    renderWhoami();
    const p = people.find((x) => x.id === id);
    h.toast(p ? `Working as ${p.name}` : 'What you do is no longer logged in Team');
    lastInput = Date.now();
    ping(true);
    if (on()) renderTeam();
  };
}

// ---- work time: one ping a minute while the app is visible and in use ----------------------------------------------
const IDLE_MS = 3 * 60 * 1000;
let lastInput = Date.now();
let lastPing = { at: 0, view: '' };
function ping(force = false) {
  if (!(h.getWorker() > 0) || document.visibilityState !== 'visible') return;
  if (!force && Date.now() - lastInput > IDLE_MS) return;
  const view = h.currentView();
  if (!force && view === lastPing.view && Date.now() - lastPing.at < 50000) return;
  lastPing = { at: Date.now(), view };
  h.api('/api/team/ping', { method: 'POST', body: { view } }).catch(() => {});
}
export function startPresence() {
  const mark = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']) addEventListener(ev, mark, { passive: true, capture: true });
  setInterval(() => { lastPing.at = 0; ping(); }, 60000);
  document.addEventListener('visibilitychange', () => ping());
  addEventListener('hashchange', () => ping());
  ping();
}

// ---- page ---------------------------------------------------------------------------------------------------------
function rangeOf(key) {
  if (key === 'all') return [0, nowS() + 60];
  const [from, to] = presetRange(key, st.tz);
  return [from, to >= nowS() ? nowS() + 60 : to];
}

export async function renderTeam() {
  const seq = ++st.seq;
  const s = await h.api('/api/approval/settings').catch(() => ({ tz: st.tz }));
  if (!on() || seq !== st.seq) return;
  st.tz = s.tz || st.tz;
  h.$('#topbar-actions').innerHTML = `<button class="btn primary sm" id="tm-add">${icon('plus')}Add person</button>`;
  h.$('#tm-add').onclick = () => editPerson(null);
  h.$('#view').innerHTML = `
    <h2>Team</h2>
    <p class="sub">Who works on the operation, for how long and what they did. Each person picks their name in <b>Working as</b>, at the top of the sidebar: from then on, their actions and spending are recorded under them. Time only counts while the app is open and in use (after 3 minutes without activity, it stops counting).</p>
    <div class="card"><h3>People</h3><div id="tm-people"><div class="page-loading" style="min-height:80px"><div class="spinner"></div></div></div></div>
    <div class="card">
      <div class="row between tm-loghead">
        <div><h3 style="margin:0">Work log</h3><div class="dim" style="font-size:12.5px">When each person worked and what they did.</div></div>
        <div class="seg" id="tm-range">${RANGES.map(([k, l]) => `<button data-r="${k}" class="${st.range === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div id="tm-log"></div>
    </div>
    <div class="card">
      <div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Recent activity</h3><select class="input" id="tm-who" aria-label="Person"></select></div>
      <div id="tm-feed"></div>
    </div>`;
  h.$$('#tm-range button').forEach((b) => (b.onclick = () => {
    st.range = b.dataset.r;
    h.$$('#tm-range button').forEach((x) => x.classList.toggle('active', x === b));
    loadStats();
  }));
  await loadStats();
  loadFeed();
  clearInterval(st.timer);
  st.timer = setInterval(() => { if (!on()) return clearInterval(st.timer); if (!h.$('#modal').classList.contains('hidden')) return; loadStats(); }, 60000);
}

async function loadStats() {
  const seq = ++st.seq;
  const [from, to] = rangeOf(st.range);
  let d;
  try { d = await h.api(`/api/team?from=${from}&to=${to}`); } catch (e) {
    if (on() && seq === st.seq) h.$('#tm-log').innerHTML = `<div class="dim">Could not load: ${h.esc(stripEmoji(e.message))}</div>`;
    return;
  }
  if (!on() || seq !== st.seq) return;
  paintPeople(d);
  paintLog(d);
  paintWhoFilter(d);
}

function paintPeople(d) {
  const box = h.$('#tm-people');
  const people = d.people.filter((p) => p.active);
  const cur = h.getWorker();
  if (!people.length) {
    box.innerHTML = `<div class="tm-empty">${icon('briefcase', { size: 22 })}<div><b>No one on the team yet.</b><div class="dim">Add the people who work with you (assistants, editors). There are no passwords: this app only opens on this computer.</div></div>
      <button class="btn primary sm" id="tm-add2">${icon('plus')}Add person</button></div>`;
    h.$('#tm-add2').onclick = () => editPerson(null);
    return;
  }
  box.innerHTML = people.map((p) => `
    <div class="tm-row" data-id="${p.id}">
      ${letter(p)}
      <div class="tm-who">
        <div class="tm-name"><b>${h.esc(p.name)}</b><span class="tm-role">${ROLES[p.role] || h.esc(p.role)}</span>${p.id === cur ? '<span class="tm-me">you</span>' : ''}</div>
        <div class="dim tm-line">${p.working ? '<span class="tm-live">working now</span>' : p.lastSeen ? `last seen ${fmtWhen(p.lastSeen, st.tz)}` : 'no activity yet'}</div>
      </div>
      <div class="tm-acts">
        ${p.id !== cur ? `<button class="btn sm ghost" data-me>This is me</button>` : ''}
        <button class="btn sm ghost icon-only" data-edit title="Edit" aria-label="Edit">${icon('edit')}</button>
        <button class="btn sm ghost danger icon-only" data-del title="Remove" aria-label="Remove">${icon('trash')}</button>
      </div>
    </div>`).join('');
  h.$$('.tm-row', box).forEach((row) => {
    const p = people.find((x) => x.id === Number(row.dataset.id));
    if (h.$('[data-me]', row)) h.$('[data-me]', row).onclick = () => {
      h.setWorker(p.id);
      renderWhoami();
      h.toast(`Working as ${p.name}`);
      lastInput = Date.now();
      ping(true);
      loadStats();
    };
    h.$('[data-edit]', row).onclick = () => editPerson(p);
    h.$('[data-del]', row).onclick = async () => {
      if (!confirm(`Remove ${p.name} from the team? Their work log is kept.`)) return;
      try {
        await h.api(`/api/team/people/${p.id}`, { method: 'DELETE' });
        if (h.getWorker() === p.id) h.setWorker(null);
        h.toast(`${p.name} left the team`);
        await h.loadShared();
        loadStats();
      } catch (e) { h.toast(e.message, true); }
    };
  });
}

function editPerson(p) {
  const color = p ? colorOf(p) : h.COLORS[(h.state.workers || []).length % h.COLORS.length];
  h.showModal(`
    <div class="modal-box small">
      <h3 style="margin:0 0 4px">${p ? 'Edit person' : 'Add person'}</h3>
      <p class="sub">${p ? '' : 'Then that person picks their name in “Working as”.'}</p>
      <form class="stack" id="tm-form">
        <label class="field"><span>Name</span><input class="input" name="name" required maxlength="40" value="${h.esc(p?.name || '')}" autofocus></label>
        <label class="field"><span>Role</span><select class="input" name="role">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${(p?.role || 'va') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Color</span><input class="input" name="color" type="color" value="${h.esc(color)}" style="height:38px;padding:4px"></label>
        ${p ? `<label class="field"><span>Daily budget ($)</span><input class="input" name="dailyBudget" type="number" min="0" step="0.5" value="${Number(p.dailyBudget) || ''}" placeholder="No limit"><small>In Costs, days over this amount show in red. Nothing is blocked.</small></label>` : ''}
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${p ? 'Save' : 'Add'}</button></div>
      </form>
    </div>`);
  h.$('#tm-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.submitter || h.$('#tm-form .btn.primary');
    btn.disabled = true;
    try {
      const r = p
        ? await h.api(`/api/team/people/${p.id}`, { method: 'PATCH', body: f })
        : await h.api('/api/team/people', { method: 'POST', body: f });
      h.closeModal();
      h.toast(p ? 'Saved' : r.restored ? `${f.name.trim()} is back on the team, with their previous log` : `${f.name.trim()} is now on the team`);
      await h.loadShared();
      if (on()) loadStats();
    } catch (err) { h.toast(err.message, true); btn.disabled = false; }
  };
}

function chipsOf(p) {
  const out = CHIPS.map(([label, acts]) => [label, acts.reduce((a, k) => a + (p.counts[k] || 0), 0)]).filter(([, n]) => n);
  const other = Object.entries(p.counts).filter(([k]) => !CHIPPED.has(k)).reduce((a, [, n]) => a + n, 0);
  if (other) out.push(['other', other]);
  return out.map(([label, n]) => `<span class="tm-chip"><b>${n}</b> ${label}</span>`).join('');
}

function paintLog(d) {
  const box = h.$('#tm-log');
  const people = d.people;
  if (!people.length) { box.innerHTML = '<div class="dim" style="font-size:13px">Once there are people on the team, the work of each one shows here.</div>'; return; }
  const bars = (list, value, label, fmt) => {
    const max = Math.max(1, ...list.map(value));
    return list.map((x) => `<div class="tm-bar-row"><span class="tm-bar-lbl">${label(x)}</span><span class="tm-bar"><i style="width:${Math.max(2, (value(x) / max) * 100)}%"></i></span><span class="tm-bar-val">${fmt(x)}</span></div>`).join('');
  };
  const t = d.totals;
  box.innerHTML = `
    <div class="tm-totals">Team: <b>${dur(t.minutes)}</b> · <b>${t.actions}</b> ${t.actions === 1 ? 'action' : 'actions'}${t.spent ? ` · <b>${money(t.spent)}</b> spent` : ''}${t.working ? ` · <span class="tm-live">${t.working} working now</span>` : ''}</div>
    ${people.map((p) => {
      const open = st.open.has(p.id);
      const fmtT = ['today', 'yesterday'].includes(st.range) ? fmtHour : fmtDate; // one day: the hours; more: the days
      const [a, b] = p.first ? [fmtT(p.first, st.tz), fmtT(p.last, st.tz)] : [];
      const span = !a ? '' : a === b ? a : `${a} → ${b}`;
      const bits = [span, p.sessions ? `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'}` : '', p.byModel.length ? `${p.byModel.length} ${p.byModel.length === 1 ? 'model' : 'models'}` : ''].filter(Boolean);
      const idle = !p.minutes && !p.actions;
      return `
      <div class="tm-person ${idle ? 'idle' : ''}" data-id="${p.id}">
        <button class="tm-head" aria-expanded="${open}" ${idle ? 'disabled' : ''}>
          ${letter(p)}
          <span class="tm-who">
            <span class="tm-name"><b>${h.esc(p.name)}</b>${p.working ? '<span class="tm-live">working now</span>' : ''}${p.active ? '' : '<span class="tm-role">left the team</span>'}</span>
            <span class="dim tm-line">${idle ? 'No work in this period' : h.esc(bits.join(' · '))}</span>
          </span>
          <span class="tm-sum"><b>${dur(p.minutes)}</b><span class="dim">${p.actions} ${p.actions === 1 ? 'action' : 'actions'}${p.spent ? ` · ${money(p.spent)}` : ''}</span></span>
          ${idle ? '' : `<span class="tm-chev">${icon('chevron-down')}</span>`}
        </button>
        ${idle ? '' : `<div class="tm-chips">${chipsOf(p) || '<span class="dim" style="font-size:12.5px">Only time with the app open, no actions logged.</span>'}</div>`}
        <div class="tm-more" ${open && !idle ? '' : 'hidden'}>
          <div class="grid-2">
            <div><div class="tm-sub">Time per page</div>${p.byView.length ? bars(p.byView, (x) => x.minutes, (x) => h.esc(h.titles[x.view] || 'Other pages'), (x) => dur(x.minutes)) : '<div class="dim" style="font-size:12.5px">No time logged.</div>'}</div>
            <div><div class="tm-sub">By model</div>${p.byModel.length ? bars(p.byModel, (x) => x.actions, (x) => `${letter({ id: x.id, name: x.name, color: x.color }, 'xs')}${h.esc(x.name)}`, (x) => `${x.actions} ${x.actions === 1 ? 'action' : 'actions'}${x.projects ? ` · ${x.projects} ${x.projects === 1 ? 'project' : 'projects'}` : ''}`) : '<div class="dim" style="font-size:12.5px">No actions linked to a model.</div>'}</div>
          </div>
          ${p.days.length ? `<div class="tm-sub" style="margin-top:14px">By day</div>
          <div class="tm-days"><table><thead><tr><th>Day</th><th>In</th><th>Out</th><th>Hours</th><th>Sessions</th><th>Actions</th><th>Spent</th></tr></thead><tbody>${p.days.map((x) => `<tr><td>${h.esc(x.day.slice(8, 10))}/${h.esc(x.day.slice(5, 7))}</td><td>${x.first ? fmtHour(x.first, st.tz) : '—'}</td><td>${x.last ? fmtHour(x.last, st.tz) : '—'}</td><td>${dur(x.minutes)}</td><td>${x.sessions || '—'}</td><td>${x.actions || '—'}</td><td>${x.spent ? money(x.spent) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
        </div>
      </div>`;
    }).join('')}`;
  h.$$('.tm-person', box).forEach((el) => {
    const id = Number(el.dataset.id);
    const head = h.$('.tm-head', el);
    head.onclick = () => {
      const open = !st.open.has(id);
      if (open) st.open.add(id); else st.open.delete(id);
      head.setAttribute('aria-expanded', String(open));
      h.$('.tm-more', el).hidden = !open;
    };
  });
}

function paintWhoFilter(d) {
  const sel = h.$('#tm-who');
  if (!sel) return;
  const all = d.people;
  if (st.who && !all.some((p) => String(p.id) === st.who)) st.who = '';
  sel.innerHTML = `<option value="">Everyone</option>${all.map((p) => `<option value="${p.id}" ${String(p.id) === st.who ? 'selected' : ''}>${h.esc(p.name)}</option>`).join('')}`;
  sel.onchange = () => { st.who = sel.value; loadFeed(); };
}

async function loadFeed(before = null) {
  const box = h.$('#tm-feed');
  if (!box) return;
  const q = new URLSearchParams({ limit: '40' });
  if (st.who) q.set('worker', st.who);
  if (before) q.set('before', before);
  let d;
  try { d = await h.api(`/api/team/activity?${q}`); } catch (e) {
    box.innerHTML = `<div class="dim">Could not load: ${h.esc(stripEmoji(e.message))}</div>`;
    return;
  }
  if (!on()) return;
  const rows = d.items.map((a) => `
    <div class="tm-act ${a.undone ? 'undone' : ''}">
      <span class="tm-at dim">${fmtWhen(a.at, st.tz)}</span>
      ${letter({ id: a.worker_id, name: a.worker, color: a.worker_color }, 'xs')}
      <span class="tm-text"><b>${h.esc(a.worker)}</b> ${says(a)}${a.undone ? ' <span class="dim">(undone)</span>' : ''}</span>
      ${a.model_name ? `<span class="tm-model">${h.esc(a.model_name)}</span>` : ''}
    </div>`).join('');
  h.$('#tm-more-feed')?.remove();
  if (before) box.insertAdjacentHTML('beforeend', rows);
  else box.innerHTML = rows || '<div class="dim" style="font-size:13px">No activity yet. Actions show here when someone works with a name chosen in “Working as”.</div>';
  if (d.more) {
    box.insertAdjacentHTML('beforeend', '<button class="btn sm ghost" id="tm-more-feed" style="margin-top:8px">Show more</button>');
    h.$('#tm-more-feed').onclick = () => loadFeed(d.items[d.items.length - 1].id);
  }
}
