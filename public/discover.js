// Descoberta: the tracked creators' reels one at a time, best first. Guardar (→ Galeria) or Passar; each choice
// teaches which creators and hashtags you prefer, and the order follows.
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, toast, fmt, ago, PF }
export function init(helpers) { h = helpers; }

const on = () => /^#\/discover(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const store = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const st = { queue: [], signals: { creators: [], hashtags: [], avoid: { creators: [], hashtags: [] } }, sources: { tags: [], tracked: 0 }, counts: {}, done: [], seq: 0, keyHandler: null, busy: false, loading: new Map() };
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const ratio = (r) => (r == null ? '—' : `${r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)}×`);

export async function renderDiscover() {
  const seq = ++st.seq;
  if (st.keyHandler) window.removeEventListener('keydown', st.keyHandler, true);
  st.keyHandler = null;
  h.$('#view').innerHTML = `
    <h2>Discover</h2>
    <p class="sub">Your creators' reels, one at a time, best first. <b>Save</b> (→) sends it to the Gallery (to remake it); <b>Pass</b> (←) skips it; Z undoes. Each choice teaches the app: the creators and hashtags of what you save go up, those of what you pass go down.</p>
    <label class="field inline dc-queue"><span>When saving, also add to the Remake queue of</span><select class="input sm" id="dc-queue"><option value="">No one (Gallery only)</option>${(h.state?.models || []).map((m) => `<option value="${m.id}" ${store.get('rr.discover.queue') === String(m.id) ? 'selected' : ''}>${h.esc(m.name)}</option>`).join('')}</select></label>
    <div id="dc-body"><div class="page-loading"><div class="spinner"></div></div></div>`;
  const q = h.$('#dc-queue');
  if (q) q.onchange = () => store.set('rr.discover.queue', q.value);
  await load(seq);
  st.keyHandler = (e) => {
    if (!on() || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const act = { arrowleft: () => decide('pass'), arrowright: () => decide('keep'), z: undo }[e.key.toLowerCase()];
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
  };
  window.addEventListener('keydown', st.keyHandler, true);
}

async function load(seq) {
  let d;
  try { d = await h.api('/api/discover?limit=15'); } catch (e) {
    if (on() && seq === st.seq) h.$('#dc-body').innerHTML = `<div class="empty">${h.esc(stripEmoji(e.message))}</div>`;
    return;
  }
  if (!on() || seq !== st.seq) return;
  st.queue = d.items;
  st.signals = d.signals;
  st.sources = d.sources || st.sources;
  st.counts = d.counts;
  show(seq);
}

/** The reel's video in the app (downloaded on first view, free); the next one downloads while you watch. */
function ensureVideo(it) {
  if (it.video_path) return Promise.resolve(it.video_path);
  if (!st.loading.has(it.id)) {
    st.loading.set(it.id, h.api(`/api/reels/${it.id}/download`, { method: 'POST' }).then((r) => { it.video_path = r.video_path; return r.video_path; }).finally(() => st.loading.delete(it.id)));
  }
  return st.loading.get(it.id);
}

function show(seq) {
  const body = h.$('#dc-body');
  if (!body || !on() || seq !== st.seq) return;
  const it = st.queue[0];
  if (!it) {
    body.innerHTML = `<div class="empty">${icon('check-circle', { size: 28 })}<h3>No more reels to see</h3><p>When your creators post more, they appear here. ${st.counts.kept ? `You have saved ${st.counts.kept} so far.` : ''}</p>
      <div class="row" style="justify-content:center">${st.done.length ? `<button class="btn" id="dc-undo">${icon('rotate-ccw')}Back to the last one</button>` : ''}<a class="btn" href="#/review?tab=galeria">${icon('images')}Gallery</a><a class="btn ghost" href="#/creators">${icon('users')}Creators</a></div></div>
      ${signalsHtml()}${sourcesHtml()}`;
    if (h.$('#dc-undo')) h.$('#dc-undo').onclick = undo;
    bindSignals();
    bindSources();
    return;
  }
  const muted = store.get('rr.discover.muted', '1') === '1';
  const p = it.parts;
  const why = [
    it.ftvr != null && it.ftvr >= 1 && `${ratio(it.ftvr)} her followers`,
    it.vsUsual != null && it.vsUsual >= 2 && `${ratio(it.vsUsual)} her usual`,
    it.creatorWeight > 0 && 'a creator you like',
    it.creatorWeight < 0 && 'a creator you usually pass',
    Object.values(it.tagWeights).some((w) => w > 0) && 'hashtags you save',
  ].filter(Boolean);
  body.innerHTML = `
    <div class="rv">
      <div class="rv-player" id="dc-player"><div class="loading" style="height:100%;display:grid;place-items:center;color:var(--muted)"><div><div class="spinner"></div><div style="margin-top:8px;font-size:12.5px">Loading the video…</div></div></div></div>
      <aside class="card rv-side ap-side">
        <div class="rv-progress"><b>${st.queue.length}</b> in the list · ${st.counts.kept || 0} saved · ${st.counts.passed || 0} passed</div>
        <div class="rv-who">${it.avatar_path ? `<img src="${media(it.avatar_path)}" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover">` : ''}@${h.esc(it.handle)} <span class="pf ${it.platform}">${h.PF[it.platform]}</span></div>
        <div class="dc-stats">
          <div><span>Views</span><b>${h.fmt(it.views)}</b></div><div><span>Likes</span><b>${h.fmt(it.likes)}</b></div>
          <div><span>Comments</span><b>${h.fmt(it.comments)}</b></div><div><span>Shares</span><b>${h.fmt(it.shares)}</b></div>
          <div><span>Followers</span><b>${h.fmt(it.followers)}</b></div><div><span>FTVR</span><b>${ratio(it.ftvr)}</b></div>
          <div><span>Likes / views</span><b>${pct(it.likeRate)}</b></div><div title="Views of this reel ÷ the median of her last 30 reels"><span>vs. her usual</span><b>${ratio(it.vsUsual)}</b></div>
          <div><span>Duration</span><b>${it.duration ? `${Math.round(it.duration)} s` : '—'}</b></div><div><span>Posted</span><b>${it.posted_at ? `${h.ago(it.posted_at)} ago` : '—'}</b></div>
        </div>
        ${it.caption ? `<div class="rv-caption">${captionHtml(it)}</div>` : ''}
        <div class="dc-score"><b>Score ${it.score}</b>${why.length ? ` <span class="dim">· ${why.join(' · ')}</span>` : ''}
          <div class="dc-parts" title="How the score is calculated">views ${p.views.toFixed(1)} · FTVR ${p.ftvr.toFixed(1)} · creator ${p.creator.toFixed(1)} · hashtags ${p.tags.toFixed(1)} · age ${p.age.toFixed(1)}</div></div>
        <a class="rv-open" href="${h.esc(it.url)}" target="_blank" rel="noopener">${icon('external-link', { size: 13 })}Open on ${it.platform === 'tiktok' ? 'TikTok' : 'Instagram'}</a>
        <div class="rv-actions">
          <button class="btn rv-push" id="dc-pass">${icon('x')}Pass<kbd>←</kbd></button>
          <button class="btn rv-keep" id="dc-keep">${icon('check')}Save<kbd>→</kbd></button>
        </div>
        <div class="rv-tools">
          <button class="btn sm ghost" id="dc-undo" ${st.done.length ? '' : 'disabled'}>${icon('rotate-ccw')}Back<kbd>Z</kbd></button>
          <a class="btn sm ghost" href="#/remake/${it.id}" title="Opens the remake of this reel right away">${icon('play-circle')}Remake now</a>
          <button class="btn sm ghost" id="dc-sound">${icon(muted ? 'x-circle' : 'music')}${muted ? 'Sound off' : 'Sound on'}</button>
        </div>
      </aside>
    </div>
    ${signalsHtml()}${sourcesHtml()}`;
  h.$('#dc-pass').onclick = () => decide('pass');
  h.$('#dc-keep').onclick = () => decide('keep');
  h.$('#dc-undo').onclick = undo;
  h.$('#dc-sound').onclick = () => {
    const m = !(store.get('rr.discover.muted', '1') === '1');
    store.set('rr.discover.muted', m ? '1' : '0');
    const v = h.$('#dc-video');
    if (v) { v.muted = m; if (!m) v.play().catch(() => {}); }
    h.$('#dc-sound').innerHTML = `${icon(m ? 'x-circle' : 'music')}${m ? 'Sound off' : 'Sound on'}`;
  };
  bindSignals();
  bindSources();
  ensureVideo(it).then((rel) => {
    const box = h.$('#dc-player');
    if (!box || st.queue[0]?.id !== it.id) return;
    box.innerHTML = `<video id="dc-video" src="/media/${h.esc(rel)}" ${it.thumb_path ? `poster="${media(it.thumb_path)}"` : ''} autoplay loop playsinline controls ${muted ? 'muted' : ''}></video>`;
    const v = h.$('#dc-video');
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }).catch((e) => {
    const box = h.$('#dc-player');
    if (box && st.queue[0]?.id === it.id) box.innerHTML = `<div style="height:100%;display:grid;place-items:center;padding:20px;text-align:center;color:var(--muted);font-size:13px">${it.thumb_path ? `<img src="${media(it.thumb_path)}" alt="" style="max-width:100%;max-height:60%;border-radius:8px">` : ''}<div>Could not download the video: ${h.esc(stripEmoji(e.message))}</div></div>`;
  });
  if (st.queue[1]) ensureVideo(st.queue[1]).catch(() => {});
}

function captionHtml(it) {
  return h.esc(it.caption).replace(/#([\p{L}\p{N}_]+)/gu, (m, tag) => {
    const w = it.tagWeights[tag.toLowerCase()] || 0;
    return `<span class="dc-tag ${w > 0 ? 'up' : w < 0 ? 'down' : ''}" title="${w ? `weight ${w > 0 ? '+' : ''}${w.toFixed(2)}` : 'no weight yet'}">${m}</span>`;
  });
}

function signalsHtml() {
  const S = st.signals;
  const score = (x) => `${x.score > 0 ? '+' : ''}${x.score.toFixed(1)}`;
  const creatorRow = (x) => `<div class="dc-sig"><a href="#/reels?creator=${x.id}" title="View her reels"><span class="pf ${h.esc(x.platform)}">${h.PF[x.platform] || ''}</span> @${h.esc(x.label)}</a>${x.tracked ? '' : `<button class="btn sm ghost" data-follow="${x.id}" data-handle="${h.esc(x.label)}" data-platform="${h.esc(x.platform)}" title="Follow this creator (her reels come into Discover)">Follow</button>`}<b class="${x.score > 0 ? 'up' : 'down'}">${score(x)}</b></div>`;
  const tagRow = (x) => `<div class="dc-sig"><span>#${h.esc(x.label)}</span><b class="${x.score > 0 ? 'up' : 'down'}">${score(x)}</b></div>`;
  const avoid = (S.avoid?.creators?.length || 0) + (S.avoid?.hashtags?.length || 0);
  return `<div class="card dc-signals">
    <div class="row between"><h3 style="margin:0">Training signals</h3><button class="btn sm ghost" id="dc-reset" title="Forgets what the app learned (reels already seen do not come back; the # in Sources keep their priority)">${icon('rotate-ccw')}Start over</button></div>
    <p class="dim" style="font-size:12.5px;margin:4px 0 10px">What the app learned from what you save in Discover and Review, from remakes and from what goes to Normal in Approval. The higher the score, the higher that creator's reels, or reels with that hashtag, go in the list.</p>
    <div class="grid-2">
      <div><div class="label" style="margin-bottom:6px">@ Creators</div>${S.creators.length ? S.creators.map(creatorRow).join('') : '<div class="dim" style="font-size:12px">Nothing learned yet.</div>'}</div>
      <div><div class="label" style="margin-bottom:6px"># Hashtags</div>${S.hashtags.length ? S.hashtags.map(tagRow).join('') : '<div class="dim" style="font-size:12px">Nothing learned yet.</div>'}</div>
    </div>
    ${avoid ? `<details class="dc-avoid"><summary>To avoid (${avoid})</summary><div class="grid-2" style="margin-top:8px"><div>${(S.avoid.creators || []).map(creatorRow).join('')}</div><div>${(S.avoid.hashtags || []).map(tagRow).join('')}</div></div></details>` : ''}
  </div>`;
}

function bindSignals() {
  const b = h.$('#dc-reset');
  if (b) b.onclick = async () => {
    if (!confirm('Forget what the app learned from your choices?')) return;
    try { st.signals = (await h.api('/api/discover/signals/reset', { method: 'POST' })).signals; load(st.seq); } catch (e) { h.toast(e.message, true); }
  };
  h.$$('[data-follow]').forEach((btn) => (btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await h.api('/api/creators/import', { method: 'POST', body: { text: `${btn.dataset.platform === 'tiktok' ? 'tt:' : 'ig:'}${btn.dataset.handle}`, platform: btn.dataset.platform, group: 'Descoberta', scanNow: true } });
      h.toast(r.added ? `Following @${btn.dataset.handle}: her reels come into Discover after the scan` : `You already followed @${btn.dataset.handle}`);
      load(st.seq);
    } catch (e) { h.toast(e.message, true); btn.disabled = false; }
  }));
}

// ---- Fontes: many @ and # at once ------------------------------------------------------------------------------
function sourcesHtml() {
  const src = st.sources || { tags: [], tracked: 0 };
  return `<div class="card dc-sources">
    <h3 style="margin:0 0 4px">Sources</h3>
    <p class="dim" style="font-size:12.5px;margin:0 0 10px">Discover shows the reels of the creators you follow (<a href="#/creators">${src.tracked} in Creators</a>). Paste several @accounts and #hashtags here at once, one per line or separated by spaces.</p>
    <textarea class="input" id="dc-src-text" rows="3" spellcheck="false" placeholder="@creator_one\nhttps://www.tiktok.com/@creator_two\n#outfitinspo #ootd #blonde">${h.esc(st.srcDraft || '')}</textarea>
    <div class="row" style="margin-top:8px;gap:8px">
      <span class="dim" style="font-size:12.5px">@ handles without a link are on</span>
      <select class="input" id="dc-src-pf" aria-label="Platform of @ handles without a link"><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></select>
      <span class="grow"></span>
      <button class="btn primary sm" id="dc-src-add">${icon('plus')}Add</button>
    </div>
    ${src.tags.length ? `<div class="dc-tags">${src.tags.map((t) => `<span class="dc-src-tag">#${h.esc(t.value)}<button class="icon-btn" data-rm-src="${t.id}" title="Remove #${h.esc(t.value)}" aria-label="Remove #${h.esc(t.value)}">${icon('x')}</button></span>`).join('')}</div>` : ''}
    <small class="dim" style="display:block;margin-top:8px">The @ handles are followed (scanned right after). The # give priority to reels from your creators that use them; to bring in new reels from a # (from accounts you do not follow yet), you need to connect a hashtag reader, which is paid per result.</small>
  </div>`;
}

function bindSources() {
  const add = h.$('#dc-src-add');
  if (!add) return;
  const box = h.$('#dc-src-text');
  box.oninput = () => { st.srcDraft = box.value; }; // a re-render keeps what is typed
  add.onclick = async () => {
    const tokens = box.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!tokens.length) return h.toast('Paste at least one @account or #hashtag', true);
    // Only an explicit @, a profile link or a tt:/ig: prefix follows a creator: a bare word ("ootd") may be a
    // hashtag typed without # and must not become a followed, auto-scanned account.
    const isHandle = (x) => x.startsWith('@') || /(instagram|tiktok)\.com\//i.test(x) || /^(ig|tt|instagram|tiktok):/i.test(x);
    const tags = tokens.filter((x) => x.startsWith('#'));
    const handles = tokens.filter((x) => !x.startsWith('#') && isHandle(x));
    const unclear = tokens.filter((x) => !x.startsWith('#') && !isHandle(x));
    if (!tags.length && !handles.length) return h.toast('Use @ for accounts and # for hashtags', true);
    add.disabled = true;
    const parts = [];
    let leftover = unclear;
    try {
      if (handles.length) {
        const r = await h.api('/api/creators/import', { method: 'POST', body: { text: handles.join('\n'), platform: h.$('#dc-src-pf').value, group: 'Descoberta', scanNow: true } });
        parts.push(`${r.added} new creator(s)${r.existing ? ` · ${r.existing} already followed` : ''}${r.invalid.length ? ` · ${r.invalid.length} invalid` : ''}`);
        leftover = [...r.invalid, ...unclear];
      }
      if (tags.length) {
        const r = await h.api('/api/discover/sources', { method: 'POST', body: { tags } });
        parts.push(`${r.added} new hashtag(s)${r.existing ? ` · ${r.existing} already there` : ''}`);
      }
      if (unclear.length) parts.push(`${unclear.length} without @ or # stayed in the box (use @ for accounts and # for hashtags)`);
      st.srcDraft = leftover.join('\n'); // what could not be read stays, to fix (also after the panel is redrawn)
      box.value = st.srcDraft;
      h.toast(parts.join(' · '));
      load(st.seq);
    } catch (e) { h.toast(e.message, true); }
    add.disabled = false;
  };
  h.$$('[data-rm-src]').forEach((b) => (b.onclick = async () => {
    try { const r = await h.api(`/api/discover/sources/${b.dataset.rmSrc}`, { method: 'DELETE' }); st.sources = r.sources; st.signals = r.signals; load(st.seq); } catch (e) { h.toast(e.message, true); }
  }));
}

async function decide(decision) {
  if (st.busy) return;
  const it = st.queue[0];
  if (!it) return;
  st.busy = true;
  try {
    const queueModel = decision === 'keep' ? Number(h.$('#dc-queue')?.value) || null : null;
    const r = await h.api(`/api/discover/${it.id}/decide`, { method: 'POST', body: { decision, queueModel } });
    st.signals = r.signals;
    st.done.push(it);
    st.queue.shift();
    st.counts[decision === 'keep' ? 'kept' : 'passed'] = (st.counts[decision === 'keep' ? 'kept' : 'passed'] || 0) + 1;
    if (decision === 'keep') h.toast(`@${it.handle}: saved to the Gallery${r.queued ? ` and queued for ${h.esc(h.state?.models?.find((m) => m.id === queueModel)?.name || 'remakes')}` : ''}`);
    // The order changes with what was learnt: fetch it again when the list runs short.
    if (st.queue.length < 4) await load(st.seq);
    else show(st.seq);
  } catch (e) { h.toast(e.message, true); } finally { st.busy = false; }
}

async function undo() {
  if (st.busy) return;
  const last = st.done[st.done.length - 1];
  if (!last) return;
  st.busy = true;
  try {
    const r = await h.api(`/api/discover/${last.id}/undo`, { method: 'POST' });
    st.done.pop();
    st.signals = r.signals;
    st.queue.unshift(last);
    show(st.seq);
  } catch (e) { h.toast(e.message, true); } finally { st.busy = false; }
}
