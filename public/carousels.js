// Carrosséis: an Instagram profile's photo posts and carousels, remade with her (every slide), as photo projects.
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, toast, fmt, ago, state }
export function init(helpers) { h = helpers; }

const on = () => /^#\/carousels(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const STAGE = { queued: 'queued', imaging: 'generating', review: 'ready to review', approved: 'approved', failed: 'failed', cancelled: 'canceled', rejected: 'rejected' };
const st = { profiles: [], cur: null, posts: [], sel: new Set(), model: null, variants: 1, engine: 'nano', settings: null, seq: 0, busy: false };

/** Price of one slide remade with her (her photos + the slide), as the Remake page estimates it. */
const perSlide = () => {
  // The same table as the server's (WaveSpeed prices, 27/09).
  const s = st.settings || {};
  const nb = (s.image_engine === 'gemini' ? s.nb_model_gemini : s.nb_model_comfy) || '';
  const res = String(s.nb_resolution || '1K').toUpperCase();
  const nano = /pro/i.test(nb) ? (res === '4K' ? 0.24 : 0.14) : ({ '2K': 0.105, '4K': 0.14 }[res] ?? 0.07);
  return { nano, flux: 0.06, seedream: 0.045 + 0.003 * 5, wan27: 0.03, wan27pro: 0.075 }[st.engine] ?? nano;
};

export async function renderCarousels(params) {
  const seq = ++st.seq;
  const [d, s] = await Promise.all([h.api('/api/carousels'), h.api('/api/settings')]);
  if (!on() || seq !== st.seq) return;
  st.profiles = d.profiles;
  st.settings = s;
  const models = h.state.models || [];
  if (!st.model || !models.some((m) => m.id === st.model)) st.model = models.find((m) => m.ref_images?.length)?.id || models[0]?.id || null;
  if (params.get('id')) st.cur = Number(params.get('id'));
  if (!st.profiles.some((p) => p.creator_id === st.cur)) st.cur = st.profiles[0]?.creator_id || null;
  h.$('#view').innerHTML = `
    <h2>Carousels</h2>
    <p class="sub">An Instagram profile's photo posts and carousels, remade with your model: every slide with her, in the same pose, outfit and setting. Each post becomes a photo project in Projects. Reading the profile is free; you only pay when you press <b>Remake</b>.</p>
    <div class="cr">
      <aside class="card cr-list">
        <form id="cr-add" class="stack" style="gap:6px" autocomplete="off">
          <label class="field"><span>Instagram profile</span><input class="input" name="handle" placeholder="@profile or link" spellcheck="false" required></label>
          <button class="btn primary sm">${icon('search')}Fetch the posts</button>
          <div id="cr-msg" aria-live="polite"></div>
        </form>
        <label class="btn sm ghost cr-upload" title="Your own photos (up to 20) as a carousel, to remake with her">${icon('upload')}Upload carousel<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden id="cr-upload"></label>
        <div class="cr-profiles" id="cr-profiles">${profilesHtml()}</div>
        ${d.provider === 'native' && !s.instagram_cookie_set ? `<div class="dim" style="font-size:11.5px;margin-top:8px">Without the Instagram session (Settings), Instagram only shows some of the posts. With the session, all carousels are read.</div>` : ''}
      </aside>
      <section class="cr-main" id="cr-main"></section>
    </div>`;
  bindAdd();
  paintProfiles();
  await loadPosts();
}

function profilesHtml() {
  if (!st.profiles.length) return '<div class="dim" style="font-size:12.5px;padding:10px 2px">No profiles yet.</div>';
  return st.profiles.map((p) => `
    <div class="cr-prof-row"><button class="cr-prof ${p.creator_id === st.cur ? 'sel' : ''}" data-id="${p.creator_id}">
      ${p.avatar_path ? `<img src="${media(p.avatar_path)}" alt="">` : `<span class="avatar-letter" style="width:30px;height:30px">${h.esc(p.handle[0].toUpperCase())}</span>`}
      <span class="cr-prof-main"><b>${p.uploads ? 'Uploaded by you' : `@${h.esc(p.handle)}`}</b><small>${p.posts} photo post(s)${p.model_name ? ` · ${h.esc(p.model_name)}` : ''}${p.last_error ? ' · read error' : ''}</small></span>
    </button><button class="icon-btn cr-star ${p.starred ? 'on' : ''}" data-star="${p.creator_id}" title="${p.starred ? 'Remove from favorites' : 'Favorite: stays at the top'}" aria-pressed="${!!p.starred}" aria-label="Favorite">${icon(p.starred ? 'star-filled' : 'star')}</button></div>`).join('');
}

function paintProfiles() {
  const box = h.$('#cr-profiles');
  if (!box) return;
  box.innerHTML = profilesHtml();
  h.$$('.cr-prof', box).forEach((b) => (b.onclick = () => {
    st.cur = Number(b.dataset.id);
    st.sel.clear();
    const p = st.profiles.find((x) => x.creator_id === st.cur);
    if (p?.model_id && (h.state.models || []).some((m) => m.id === p.model_id)) st.model = p.model_id; // the model used last time with this profile
    paintProfiles();
    loadPosts();
  }));
  h.$$('[data-star]', box).forEach((b) => (b.onclick = async () => {
    const p = st.profiles.find((x) => x.creator_id === Number(b.dataset.star));
    try { await h.api(`/api/carousels/${p.creator_id}`, { method: 'PATCH', body: { starred: !p.starred } }); st.profiles = (await h.api('/api/carousels')).profiles; paintProfiles(); } catch (e) { h.toast(e.message, true); }
  }));
}

function bindAdd() {
  const up = h.$('#cr-upload');
  if (up) up.onchange = async (e) => {
    const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/')).slice(0, 20);
    e.target.value = '';
    if (!files.length) return;
    try {
      const images = await Promise.all(files.map((f) => fileToDataUrl(f)));
      const r = await h.api('/api/carousels/upload', { method: 'POST', body: { images } });
      h.toast(`Carousel of ${images.length} photo(s) uploaded: select it and press Remake`);
      st.profiles = (await h.api('/api/carousels')).profiles;
      st.cur = r.profile.creator_id;
      st.sel = new Set([r.reelId]);
      paintProfiles();
      loadPosts();
    } catch (err) { h.toast(err.message, true); }
  };
  const form = h.$('#cr-add');
  const msg = h.$('#cr-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = h.$('button', form);
    btn.disabled = true;
    msg.innerHTML = '<div class="msg" style="font-size:12px"><span class="spinner inline"></span>Reading the profile…</div>';
    try {
      const r = await h.api('/api/carousels', { method: 'POST', body: { handle: form.handle.value } });
      if (!on()) return;
      form.handle.value = '';
      msg.innerHTML = r.note ? `<div class="dim" style="font-size:12px">${h.esc(stripEmoji(r.note))}</div>` : '';
      st.cur = r.profile.creator_id;
      st.profiles = (await h.api('/api/carousels')).profiles;
      paintProfiles();
      loadPosts();
    } catch (err) {
      if (on()) msg.innerHTML = `<div class="callout warn" style="font-size:12px">${icon('alert-triangle')}<div>${h.esc(stripEmoji(err.message))}</div></div>`;
    }
    btn.disabled = false;
  };
}

async function loadPosts() {
  const main = h.$('#cr-main');
  if (!main) return;
  const p = st.profiles.find((x) => x.creator_id === st.cur);
  if (!p) {
    main.innerHTML = `<div class="empty">${icon('images', { size: 28 })}<h3>Choose a profile</h3><p>Enter the @ of an Instagram profile on the left to see its photo posts and carousels.</p></div>`;
    return;
  }
  const seq = st.seq;
  main.innerHTML = '<div class="page-loading" style="min-height:200px"><div class="spinner"></div></div>';
  let posts;
  try { posts = await h.api(`/api/carousels/${p.creator_id}/posts${st.model ? `?model=${st.model}` : ''}`); } catch (e) {
    if (on() && seq === st.seq) main.innerHTML = `<div class="empty">${h.esc(stripEmoji(e.message))}</div>`;
    return;
  }
  if (!on() || seq !== st.seq || st.cur !== p.creator_id) return;
  st.posts = posts;
  const models = h.state.models || [];
  main.innerHTML = `
    <div class="card cr-head">
      <div class="row between">
        <div class="row">${p.avatar_path ? `<img class="cr-avatar" src="${media(p.avatar_path)}" alt="">` : ''}<div><b style="font-size:15px">@${h.esc(p.handle)}</b>
          <div class="dim" style="font-size:12px">${p.followers != null ? `${h.fmt(p.followers)} followers · ` : ''}${posts.length} photo post(s)${p.last_scan_at ? ` · read ${h.ago(p.last_scan_at)} ago` : ''}</div></div></div>
        <div class="row">${p.uploads ? '' : `<a class="btn sm ghost" href="https://www.instagram.com/${h.esc(p.handle)}/" target="_blank" rel="noopener">${icon('external-link')}Instagram</a>
          <button class="btn sm" id="cr-rescan">${icon('refresh')}Read again</button>`}<button class="btn sm ghost danger" id="cr-remove">Remove from list</button></div>
      </div>
      ${p.last_error ? `<div class="callout warn" style="margin-top:10px;font-size:12.5px">${icon('alert-triangle')}<div>${h.esc(stripEmoji(p.last_error))}</div></div>` : ''}
      <div class="cr-bar">
        <label class="field"><span>Model</span><select class="input" id="cr-model">${models.map((m) => `<option value="${m.id}" ${m.id === st.model ? 'selected' : ''} ${m.ref_images?.length ? '' : 'disabled'}>${h.esc(m.name)}${m.ref_images?.length ? '' : ' (no photos)'}</option>`).join('')}</select></label>
        <label class="field"><span>Her image</span><select class="input" id="cr-engine"><option value="nano">Nano Banana</option><option value="seedream">Seedream 5.0 Pro</option><option value="flux">Flux.2 [pro]</option></select></label>
        <label class="field"><span>Variants per slide</span><select class="input" id="cr-var"><option value="1">1</option><option value="2">2</option></select></label>
        <span class="grow"></span>
        <button class="btn sm ghost" id="cr-all">Select all</button>
        <span class="dim cr-cost" id="cr-cost"></span>
        <button class="btn primary" id="cr-go" disabled>${icon('play-circle')}Remake</button>
      </div>
    </div>
    ${posts.length ? `<div class="cr-grid">${posts.map(postHtml).join('')}</div>` : `<div class="empty">${icon('images', { size: 28 })}<h3>No photo posts</h3><p>This profile has no photos or carousels in the posts read${p.last_error ? '' : ' (reels only)'}.</p></div>`}`;
  h.$('#cr-engine').value = st.engine;
  h.$('#cr-var').value = String(st.variants);
  bindPosts(p);
  paintCost();
}

function postHtml(x) {
  const cover = x.slides[0] || x.thumb_path;
  const made = x.made;
  return `<div class="cr-post ${st.sel.has(x.id) ? 'sel' : ''} ${x.slides.length ? '' : 'off'}" data-id="${x.id}" role="button" tabindex="0" aria-pressed="${st.sel.has(x.id)}" title="${x.slides.length ? 'Select this post' : 'The slides of this post are not in the app yet: press Read again'}">
    ${cover ? `<img src="${media(cover)}" alt="" loading="lazy">` : '<div class="cr-noimg"></div>'}
    <span class="cr-kind">${x.media_type === 'carousel' ? `${icon('images')}${x.total}` : 'photo'}</span>
    <span class="cr-check">${icon('check')}</span>
    <div class="cr-meta">${x.likes != null ? `${h.fmt(x.likes)} likes · ` : ''}${x.posted_at ? `${h.ago(x.posted_at)} ago` : ''}</div>
    ${made ? `<a class="cr-made status ${made.stage === 'approved' ? 'ok' : made.stage === 'failed' ? 'error' : 'new'}" href="#/projects/${made.id}" title="Open project #${made.id}">#${made.id} · ${STAGE[made.stage] || made.stage}</a>` : ''}
  </div>`;
}

function paintCost() {
  const chosen = st.posts.filter((x) => st.sel.has(x.id));
  const slides = chosen.reduce((a, x) => a + x.slides.length, 0);
  const go = h.$('#cr-go');
  const cost = h.$('#cr-cost');
  if (!go || !cost) return;
  go.disabled = !chosen.length || !st.model || st.busy;
  go.innerHTML = `${icon('play-circle')}Remake ${chosen.length ? `${chosen.length} post(s)` : ''}`;
  cost.textContent = chosen.length ? `${slides} slide(s) · ~${usd(slides * st.variants * perSlide())}` : 'Select the posts';
}

function bindPosts(p) {
  h.$$('.cr-post').forEach((el) => {
    const id = Number(el.dataset.id);
    const x = st.posts.find((y) => y.id === id);
    const toggle = (e) => {
      if (e.target.closest('a')) return;
      if (!x.slides.length) return h.toast('The slides of this post are not in the app yet: press Read again', true);
      st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
      el.classList.toggle('sel', st.sel.has(id));
      el.setAttribute('aria-pressed', String(st.sel.has(id)));
      paintCost();
    };
    el.onclick = toggle;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } };
  });
  h.$('#cr-all').onclick = () => {
    const usable = st.posts.filter((x) => x.slides.length);
    const all = usable.every((x) => st.sel.has(x.id));
    usable.forEach((x) => (all ? st.sel.delete(x.id) : st.sel.add(x.id)));
    h.$$('.cr-post').forEach((el) => { const on = st.sel.has(Number(el.dataset.id)); el.classList.toggle('sel', on); el.setAttribute('aria-pressed', String(on)); });
    paintCost();
  };
  h.$('#cr-model').onchange = (e) => {
    st.model = Number(e.target.value);
    h.api(`/api/carousels/${p.creator_id}`, { method: 'PATCH', body: { modelId: st.model } }).then((r) => { const i = st.profiles.findIndex((x) => x.creator_id === p.creator_id); if (i >= 0 && r.profile) st.profiles[i] = r.profile; paintProfiles(); }).catch(() => {});
    loadPosts();
  };
  h.$('#cr-engine').onchange = (e) => { st.engine = e.target.value; paintCost(); };
  h.$('#cr-var').onchange = (e) => { st.variants = Number(e.target.value); paintCost(); };
  if (h.$('#cr-rescan')) h.$('#cr-rescan').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      await h.api(`/api/carousels/${p.creator_id}/scan`, { method: 'POST' });
      st.profiles = (await h.api('/api/carousels')).profiles;
      paintProfiles();
      loadPosts();
    } catch (err) { h.toast(err.message, true); e.currentTarget.disabled = false; }
  };
  h.$('#cr-remove').onclick = async () => {
    if (!confirm(`Remove @${p.handle} from Carousels? The projects already made stay.`)) return;
    await h.api(`/api/carousels/${p.creator_id}`, { method: 'DELETE' }).catch((err) => h.toast(err.message, true));
    st.cur = null;
    renderCarousels(new URLSearchParams());
  };
  h.$('#cr-go').onclick = () => remake();
}

async function remake() {
  const chosen = st.posts.filter((x) => st.sel.has(x.id));
  if (!chosen.length || st.busy) return;
  const model = (h.state.models || []).find((m) => m.id === st.model);
  const slides = chosen.reduce((a, x) => a + x.slides.length, 0);
  if (!confirm(`Remake ${chosen.length} post(s) (${slides} slide(s)) with ${model?.name || 'the model'}?\nEstimated cost: ~${usd(slides * st.variants * perSlide())}.`)) return;
  st.busy = true;
  paintCost();
  let ok = 0;
  const errors = [];
  for (const x of chosen) {
    h.$('#cr-cost').textContent = `Creating ${ok + errors.length + 1} of ${chosen.length}…`;
    try {
      await h.api(`/api/reels/${x.id}/remake`, {
        method: 'POST',
        body: { kind: 'photo', modelId: st.model, prompt: '', config: { slides: x.slides.map((_, i) => i), variants: st.variants, keepOutfit: true, poses: [], customPose: '', frameEngine: st.engine } },
      });
      ok++;
      st.sel.delete(x.id);
    } catch (e) { errors.push(`${e.message}`); if (/API key|saldo|balance|fotos|photos/i.test(e.message)) break; }
  }
  st.busy = false;
  h.toast(errors.length ? `${ok} post(s) being remade; ${errors.length} with errors: ${stripEmoji(errors[0])}` : `${ok} post(s) being remade: follow them in Projects`, !!errors.length);
  loadPosts();
}

/** A picked photo, scaled to at most 2048 px, as a JPEG data URL. */
function fileToDataUrl(file, max = 2048) {
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
