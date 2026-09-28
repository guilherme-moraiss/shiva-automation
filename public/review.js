// Revisão: the team sends reel links; the owner watches them one by one and decides Keep (goes to the Galeria, to be
// remade with her AI model) or Push (not approved).
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, fmt, ago, dateTime, toast, showModal, closeModal, state, loadShared, PF, shown }
export function init(helpers) { h = helpers; }

const on = () => /^#\/review(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const TABS = [['rever', 'Review'], ['enviar', 'Send reels'], ['galeria', 'Gallery'], ['enviados', 'Sent']];
const STATUS = {
  processing: ['run', 'Downloading'], pending: ['act', 'To review'], keep: ['ok', 'Keep'], push: ['off', 'Push'],
  error: ['bad', 'Error'], duplicate: ['off', 'Duplicate'],
};
const st = { tab: 'rever', queue: [], last: null, counts: {}, poll: null, seq: 0, keyHandler: null, filter: 'all', by: '' };
const store = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const statusChip = (s) => { const [tone, label] = STATUS[s] || ['off', s]; return `<span class="stage ${tone}">${label}</span>`; };
const stats = (it) => [it.views != null && `${h.fmt(it.views)} views`, it.likes != null && `${h.fmt(it.likes)} likes`, it.comments != null && `${h.fmt(it.comments)} comments`, it.duration && `${Math.round(it.duration)} s`].filter(Boolean).join(' · ');
const who = (it) => `${it.handle && it.handle !== 'desconhecida' ? `@${h.esc(it.handle)}` : 'Unknown creator'} <span class="pf ${it.platform}">${h.PF[it.platform]}</span>`;

function setBadge(counts) {
  if (!counts) return;
  st.counts = counts;
  const b = h.$('#nav-review');
  if (b) b.textContent = counts.pending || '';
  if (h.state.stats) h.state.stats.reviewPending = counts.pending || 0;
}

export async function renderReview(params) {
  clearTimeout(st.poll);
  const seq = ++st.seq;
  st.tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : st.tab;
  const tabs = () => `<div class="seg" id="rv-tabs">${TABS.map(([k, l]) => {
    const n = k === 'rever' ? st.counts.pending : k === 'galeria' ? st.counts.keep : null;
    return `<button data-tab="${k}" class="${st.tab === k ? 'active' : ''}">${l}${n ? ` <span class="count">${n}</span>` : ''}</button>`;
  }).join('')}</div>`;
  h.$('#view').innerHTML = `
    <h2>Review</h2>
    <p class="sub">The team sends reel links. You watch them one by one and decide: <b>Keep</b> goes to the Gallery, to be remade with your model; <b>Push</b> is left out.</p>
    <div class="toolbar" id="rv-toolbar">${tabs()}</div>
    <div id="rv-body"><div class="page-loading"><div class="spinner"></div></div></div>`;
  h.$$('#rv-tabs button').forEach((b) => (b.onclick = () => { location.hash = `#/review?tab=${b.dataset.tab}`; }));
  const refreshTabs = () => { const t = h.$('#rv-toolbar'); if (t) { t.innerHTML = tabs(); h.$$('#rv-tabs button').forEach((b) => (b.onclick = () => { location.hash = `#/review?tab=${b.dataset.tab}`; })); } };
  st.refreshTabs = refreshTabs;
  if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
  st.keyHandler = null;
  try {
    if (st.tab === 'rever') await renderQueue(seq);
    else if (st.tab === 'enviar') await renderSend(seq);
    else if (st.tab === 'galeria') await renderGallery(seq);
    else await renderSent(seq);
  } catch (e) {
    if (on() && seq === st.seq) h.$('#rv-body').innerHTML = `<div class="empty">${icon('alert-circle', { size: 28 })}<h3>Could not load</h3><p>${h.esc(stripEmoji(e.message))}</p></div>`;
  }
  refreshTabs();
}

// ---- Rever: one reel at a time -------------------------------------------------------------------------------------

async function renderQueue(seq) {
  const r = await h.api('/api/review/queue');
  if (!on() || seq !== st.seq) return;
  setBadge(r.counts);
  st.queue = r.items;
  showCurrent(seq);
  st.keyHandler = (e) => {
    if (!on() || st.tab !== 'rever' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const act = { k: () => decide('keep'), p: () => decide('push'), arrowright: () => decide('keep'), arrowleft: () => decide('push'), z: undo }[k]; // the same arrows as Descoberta
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
    else if (k === ' ' && e.target === document.body) { e.preventDefault(); const v = h.$('#rv-video'); if (v) (v.paused ? v.play() : v.pause()); }
  };
  // Capture phase: the keys work even when the video player has focus (its controls would swallow them).
  window.addEventListener('keydown', st.keyHandler, true);
}

function showCurrent(seq) {
  const body = h.$('#rv-body');
  if (!body || !on() || seq !== st.seq) return;
  const it = st.queue[0];
  if (!it) {
    const busy = st.counts.processing || 0;
    body.innerHTML = `<div class="empty">${icon('check-circle', { size: 28 })}<h3>No reels to review</h3>
      <p>${busy ? `${busy} reel(s) downloading: they will appear here on their own.` : 'When the team sends reels, they appear here.'}</p>
      <div class="row" style="justify-content:center">${st.last ? `<button class="btn" id="rv-undo">${icon('rotate-ccw')}Undo the last decision</button>` : ''}
        <a class="btn" href="#/review?tab=galeria">${icon('images')}View gallery</a><a class="btn ghost" href="#/review?tab=enviar">${icon('send')}Send reels</a></div></div>`;
    if (h.$('#rv-undo')) h.$('#rv-undo').onclick = undo;
    st.poll = setTimeout(() => refill(seq), busy ? 4000 : 10000);
    return;
  }
  const next = st.queue[1];
  const muted = store.get('rr.review.muted') === '1';
  body.innerHTML = `
    <div class="rv">
      <div class="rv-player"><video id="rv-video" src="${media(it.video_path)}" ${it.thumb_path ? `poster="${media(it.thumb_path)}"` : ''} autoplay loop playsinline controls ${muted ? 'muted' : ''}></video></div>
      <aside class="card rv-side">
        <div class="rv-progress"><b>${1}</b> of <b>${st.queue.length}</b> to review${st.counts.processing ? ` <span class="dim">· ${st.counts.processing} downloading</span>` : ''}</div>
        <div class="rv-who">${who(it)}</div>
        ${stats(it) ? `<div class="dim rv-stats">${stats(it)}</div>` : ''}
        ${it.caption ? `<div class="rv-caption">${h.esc(it.caption)}</div>` : ''}
        <div class="dim rv-meta">Sent by <b>${h.esc(h.shown(it.submitted_by || '—'))}</b> · ${h.ago(it.created_at)} ago${it.posted_at ? ` · posted ${h.ago(it.posted_at)} ago` : ''}</div>
        ${it.note ? `<div class="rv-note">${icon('info')}<span>${h.esc(it.note)}</span></div>` : ''}
        <a class="rv-open" href="${h.esc(it.url)}" target="_blank" rel="noopener">${icon('external-link', { size: 13 })}Open on ${it.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</a>
        <div class="rv-actions">
          <button class="btn rv-push" id="rv-push">${icon('x')}Push<kbd>P</kbd></button>
          <button class="btn rv-keep" id="rv-keep">${icon('check')}Keep<kbd>K</kbd></button>
        </div>
        <div class="rv-tools">
          <button class="btn sm ghost" id="rv-undo" ${st.last ? '' : 'disabled'}>${icon('rotate-ccw')}Undo last<kbd>Z</kbd></button>
          <button class="btn sm ghost" id="rv-sound">${icon(muted ? 'x-circle' : 'music')}${muted ? 'Sound off' : 'Sound on'}</button>
        </div>
      </aside>
    </div>
    ${next?.video_path ? `<video id="rv-next" src="${media(next.video_path)}" preload="auto" muted playsinline hidden></video>` : ''}`;
  const v = h.$('#rv-video');
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  h.$('#rv-keep').onclick = () => decide('keep');
  h.$('#rv-push').onclick = () => decide('push');
  h.$('#rv-undo').onclick = undo;
  h.$('#rv-sound').onclick = () => {
    const m = !(store.get('rr.review.muted') === '1');
    store.set('rr.review.muted', m ? '1' : '0');
    v.muted = m;
    if (!m) v.play().catch(() => {});
    h.$('#rv-sound').innerHTML = `${icon(m ? 'x-circle' : 'music')}${m ? 'Sound off' : 'Sound on'}`;
  };
  // New reels sent while reviewing join the end of the queue.
  st.poll = setTimeout(() => refill(seq), 15000);
}

async function refill(seq) {
  if (!on() || seq !== st.seq || st.tab !== 'rever') return;
  let r;
  try { r = await h.api('/api/review/queue'); } catch { st.poll = setTimeout(() => refill(seq), 10000); return; }
  if (!on() || seq !== st.seq) return;
  setBadge(r.counts);
  st.refreshTabs?.();
  const known = new Set(st.queue.map((x) => x.id));
  const fresh = r.items.filter((x) => !known.has(x.id));
  const wasEmpty = !st.queue.length;
  st.queue.push(...fresh);
  if (wasEmpty) showCurrent(seq);
  else {
    const p = h.$('.rv-progress');
    if (p) p.innerHTML = `<b>1</b> of <b>${st.queue.length}</b> to review${r.counts.processing ? ` <span class="dim">· ${r.counts.processing} downloading</span>` : ''}`;
    st.poll = setTimeout(() => refill(seq), 15000);
  }
}

let deciding = false;
async function decide(decision) {
  const it = st.queue[0];
  if (!it || deciding) return;
  deciding = true;
  h.$$('.rv-actions .btn').forEach((b) => (b.disabled = true));
  try {
    const r = await h.api(`/api/review/${it.id}/decide`, { method: 'POST', body: { decision } });
    st.queue.shift();
    st.last = { id: it.id, decision };
    setBadge(r.counts);
    st.refreshTabs?.();
    h.toast(decision === 'keep' ? 'Keep: sent to the gallery' : 'Push: not approved');
    clearTimeout(st.poll);
    showCurrent(st.seq);
  } catch (e) {
    h.toast(e.message, true);
    h.$$('.rv-actions .btn').forEach((b) => (b.disabled = false));
    if (/já foi decidido|já não existe|already (been )?decided|no longer exists/.test(e.message)) { st.queue.shift(); showCurrent(st.seq); }
  }
  deciding = false;
}

async function undo() {
  if (!st.last || deciding) return;
  deciding = true;
  try {
    const r = await h.api(`/api/review/${st.last.id}/undo`, { method: 'POST' });
    st.queue.unshift(r.item);
    st.last = null;
    setBadge(r.counts);
    st.refreshTabs?.();
    h.toast('Decision undone: the reel is back in review');
    clearTimeout(st.poll);
    showCurrent(st.seq);
  } catch (e) { h.toast(e.message, true); }
  deciding = false;
}

// ---- Enviar reels (the team) ----------------------------------------------------------------------------------------

async function renderSend(seq) {
  const by = store.get('rr.review.by');
  h.$('#rv-body').innerHTML = `
    <div class="grid-2">
      <div class="card stack">
        <h3 style="margin:0">Send reels for review</h3>
        <label class="field"><span>Your name</span><input class="input" id="rv-by" maxlength="40" value="${h.esc(by)}" placeholder="e.g. Ana" autocomplete="name"></label>
        <label class="field"><span>Reel links</span><textarea class="input" id="rv-links" rows="6" placeholder="One or more links, one per line"></textarea>
          <small>TikTok (tiktok.com/@…/video/… or vm.tiktok.com/…) and Instagram (instagram.com/reel/… or /p/…). A reel that was already sent is not added twice.</small></label>
        <label class="field"><span>Note (optional)</span><input class="input" id="rv-note" maxlength="300" placeholder="e.g. rising trend, good for Maddy"></label>
        <div class="row"><button class="btn primary" id="rv-send">${icon('send')}Send for review</button><span class="dim" id="rv-send-msg" style="font-size:12.5px"></span></div>
      </div>
      <div class="card stack">
        <div class="row between"><h3 style="margin:0">Your submissions</h3><span class="dim" style="font-size:12.5px" id="rv-mine-count"></span></div>
        <div id="rv-mine" class="stack" style="gap:8px"></div>
      </div>
    </div>`;
  const loadMine = async () => {
    clearTimeout(st.poll);
    if (!on() || seq !== st.seq || st.tab !== 'enviar') return;
    const name = h.$('#rv-by')?.value.trim();
    const box = h.$('#rv-mine');
    if (!box) return;
    if (!name) { box.innerHTML = '<div class="dim" style="font-size:13px">Enter your name to see your submissions.</div>'; return; }
    let r;
    try { r = await h.api(`/api/review/items?by=${encodeURIComponent(name)}&limit=40`); } catch { st.poll = setTimeout(loadMine, 8000); return; }
    if (!on() || seq !== st.seq || !h.$('#rv-mine')) return;
    setBadge(r.counts);
    h.$('#rv-mine-count').textContent = r.items.length ? `${r.items.length} recent` : '';
    box.innerHTML = r.items.length ? r.items.map(rowHtml).join('') : '<div class="dim" style="font-size:13px">You have not sent any reels yet.</div>';
    bindRows(box, loadMine);
    if (r.items.some((x) => x.status === 'processing')) st.poll = setTimeout(loadMine, 4000);
  };
  h.$('#rv-by').onchange = () => { store.set('rr.review.by', h.$('#rv-by').value.trim()); loadMine(); };
  h.$('#rv-send').onclick = async () => {
    const byName = h.$('#rv-by').value.trim();
    const btn = h.$('#rv-send');
    if (!byName) { h.$('#rv-by').focus(); return h.toast('Enter your name', true); }
    store.set('rr.review.by', byName);
    btn.disabled = true;
    try {
      const r = await h.api('/api/review/submit', { method: 'POST', body: { by: byName, text: h.$('#rv-links').value, note: h.$('#rv-note').value } });
      setBadge(r.counts);
      st.refreshTabs?.();
      const parts = [r.added && `${r.added} sent`, r.duplicates.length && `${r.duplicates.length} already sent before`, r.invalid.length && `${r.invalid.length} link(s) not recognized`].filter(Boolean);
      h.$('#rv-send-msg').textContent = parts.join(' · ');
      if (r.added) { h.$('#rv-links').value = ''; h.$('#rv-note').value = ''; h.toast(`${r.added} reel(s) sent for review`); }
      else h.toast(parts.join(' · ') || 'Nothing sent', true);
      clearTimeout(st.poll);
      loadMine();
    } catch (e) { h.toast(e.message, true); }
    btn.disabled = false;
  };
  loadMine();
}

// ---- Galeria (Keep) ------------------------------------------------------------------------------------------------

async function renderGallery(seq) {
  const r = await h.api('/api/review/items?status=keep&limit=500');
  if (!on() || seq !== st.seq) return;
  setBadge(r.counts);
  const body = h.$('#rv-body');
  const models = h.state?.models || [];
  const toQueue = r.items.filter((it) => it.reel_id).length;
  body.innerHTML = r.items.length ? `${toQueue && models.length ? `<div class="toolbar rv-gal-bar"><span class="dim" style="font-size:12.5px">Put the ${toQueue} Gallery reels in the Remake queue of</span><select class="input sm" id="rv-gal-model">${models.map((m) => `<option value="${m.id}">${h.esc(m.name)}</option>`).join('')}</select><button class="btn sm primary" id="rv-gal-queue" title="Free: it only queues them. Then “Generate all” in the Remake queue generates them">${icon('plus')}Queue all</button></div>` : ''}<div class="lib-grid">${r.items.map((it) => `
    <div class="lib-item" data-id="${it.id}">
      <video src="${it.video_path ? media(it.video_path) : it.reel_id ? `/api/reels/${it.reel_id}/video` : ''}" muted loop playsinline preload="none" ${it.thumb_path ? `poster="${media(it.thumb_path)}"` : ''}></video>
      <div class="lib-meta"><b>${who(it)}</b>${it.approved ? ' <span class="stage ok">Remake ready</span>' : it.remakes ? ` <span class="stage act">${it.remakes} remake(s)</span>` : ''}
        <div class="dim">${stats(it) || '—'}</div><div class="dim">Keep ${h.ago(it.decided_at)} ago · sent by ${h.esc(h.shown(it.submitted_by || '—'))}</div></div>
      <div class="row">
        ${it.reel_id ? `<a class="btn sm primary" href="#/remake/${it.reel_id}">${icon('repeat')}Make a remake</a>` : ''}
        <a class="btn sm ghost icon-only" href="${h.esc(it.url)}" target="_blank" rel="noopener" title="Open the original" aria-label="Open the original">${icon('external-link')}</a>
        <button class="btn sm ghost danger icon-only" data-act="unkeep" title="Remove from the gallery (Push)" aria-label="Remove from the gallery">${icon('x')}</button>
      </div>
    </div>`).join('')}</div>`
    : `<div class="empty">${icon('images', { size: 28 })}<h3>The gallery is empty</h3><p>Reels you Keep in review appear here, ready to be remade with your model.</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/review?tab=rever">${icon('eye')}Review reels</a></div></div>`;
  h.$$('.lib-item video', body).forEach((v) => {
    v.parentElement.onmouseenter = () => v.play().catch(() => {});
    v.parentElement.onmouseleave = () => v.pause();
  });
  const qb = h.$('#rv-gal-queue');
  if (qb) qb.onclick = async () => {
    const sel = h.$('#rv-gal-model');
    const name = sel.options[sel.selectedIndex]?.text || 'the model';
    qb.disabled = true;
    try {
      const x = await h.api('/api/review/gallery/queue', { method: 'POST', body: { modelId: Number(sel.value) } });
      h.toast(`${x.added} remake(s) queued for ${name}${x.skipped ? ` · ${x.skipped} were already there` : ''}. In the Remake queue, “Generate all” generates them.`);
      h.loadShared?.().catch(() => {});
    } catch (e) { h.toast(e.message, true); }
    qb.disabled = false;
  };
  h.$$('[data-act=unkeep]', body).forEach((b) => (b.onclick = async () => {
    const id = b.closest('[data-id]').dataset.id;
    if (!confirm('Remove this reel from the gallery? It becomes Push (not approved).')) return;
    b.disabled = true;
    try {
      const x = await h.api(`/api/review/${id}/decide`, { method: 'POST', body: { decision: 'push' } });
      setBadge(x.counts);
      b.closest('.lib-item').remove();
      st.refreshTabs?.();
    } catch (e) { h.toast(e.message, true); b.disabled = false; }
  }));
}

// ---- Enviados (history) -------------------------------------------------------------------------------------------

function rowHtml(it) {
  return `<div class="rv-row" data-id="${it.id}">
    <div class="rv-thumb" style="${it.thumb_path ? `background-image:url('${media(it.thumb_path)}')` : ''}">${it.thumb_path ? '' : icon(it.status === 'processing' ? 'clock' : 'video')}</div>
    <div style="flex:1;min-width:0">
      <div class="row" style="gap:8px">${statusChip(it.status)}<b>${who(it)}</b></div>
      <div class="dim" style="font-size:12px;margin-top:2px">by ${h.esc(h.shown(it.submitted_by || '—'))} · ${h.ago(it.created_at)} ago${stats(it) ? ` · ${stats(it)}` : ''}</div>
      ${it.note ? `<div class="dim" style="font-size:12px">“${h.esc(it.note)}”</div>` : ''}
      ${it.error ? `<div class="msg bad" style="font-size:12px">${icon('x-circle')}${h.esc(stripEmoji(it.error))}</div>` : ''}
    </div>
    <div class="row" style="gap:4px">
      ${it.status === 'error' ? `<button class="btn sm" data-act="retry">${icon('refresh')}Try again</button>` : ''}
      ${it.status === 'keep' && it.reel_id ? `<a class="btn sm" href="#/remake/${it.reel_id}">${icon('repeat')}Remake</a>` : ''}
      <a class="btn sm ghost icon-only" href="${h.esc(it.url)}" target="_blank" rel="noopener" title="Open the original" aria-label="Open the original">${icon('external-link')}</a>
      ${it.status !== 'keep' ? `<button class="btn sm ghost danger icon-only" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>` : ''}
    </div>
  </div>`;
}

function bindRows(root, reload) {
  h.$$('.rv-row', root).forEach((row) => {
    const id = row.dataset.id;
    const retry = h.$('[data-act=retry]', row);
    if (retry) retry.onclick = async () => { retry.disabled = true; try { await h.api(`/api/review/${id}/retry`, { method: 'POST' }); } catch (e) { h.toast(e.message, true); } reload(); };
    const del = h.$('[data-act=delete]', row);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this submission?')) return;
      del.disabled = true;
      try { const r = await h.api(`/api/review/${id}`, { method: 'DELETE' }); setBadge(r.counts); st.refreshTabs?.(); row.remove(); } catch (e) { h.toast(e.message, true); del.disabled = false; }
    };
  });
}

async function renderSent(seq) {
  clearTimeout(st.poll);
  const q = new URLSearchParams({ limit: '300' });
  if (st.filter !== 'all') q.set('status', st.filter);
  if (st.by) q.set('by', st.by);
  const r = await h.api(`/api/review/items?${q}`);
  if (!on() || seq !== st.seq) return;
  setBadge(r.counts);
  const filters = [['all', 'All'], ['processing', 'Downloading'], ['pending', 'To review'], ['keep', 'Keep'], ['push', 'Push'], ['error', 'Error']];
  h.$('#rv-body').innerHTML = `
    <div class="toolbar">
      <div class="seg" id="rv-filter">${filters.map(([k, l]) => `<button data-f="${k}" class="${st.filter === k ? 'active' : ''}">${l}${k !== 'all' && r.counts[k] ? ` <span class="count">${r.counts[k]}</span>` : ''}</button>`).join('')}</div>
      <select class="input" id="rv-by-filter" style="width:auto"><option value="">Whole team</option>${r.submitters.map((s) => `<option value="${h.esc(s.name)}" ${st.by === s.name ? 'selected' : ''}>${h.esc(h.shown(s.name))} (${s.n})</option>`).join('')}</select>
    </div>
    <div class="stack" style="gap:8px" id="rv-sent">${r.items.length ? r.items.map(rowHtml).join('') : '<div class="empty" style="padding:30px">Nothing here.</div>'}</div>`;
  h.$$('#rv-filter button').forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; renderSent(seq); }));
  h.$('#rv-by-filter').onchange = (e) => { st.by = e.target.value; renderSent(seq); };
  bindRows(h.$('#rv-sent'), () => renderSent(seq));
  if (r.items.some((x) => x.status === 'processing')) st.poll = setTimeout(() => { if (on() && seq === st.seq && st.tab === 'enviados') renderSent(seq); }, 5000);
}
