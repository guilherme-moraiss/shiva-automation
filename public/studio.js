// "Criar conteúdo": a model's fixed universe (places, phone, wardrobe, identity rules) + scene-based creation.
import { icon, stripEmoji } from './icons.js';

let h;
export function init(helpers) { h = helpers; }

const media = (p) => `/media/${h.esc(p)}`;
const on = () => /^#\/create(?:[/?]|$)/.test(location.hash);
const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const IMG_COST = { '1K': 0.0835, '2K': 0.1217, '4K': 0.1848 };
const st = { modelId: null, scene: null, outfitImage: null, poll: null, seq: 0 };
let meta = null;

function fileToDataUrl(file, max = 1600) {
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
const dropZone = (el, onFile) => {
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag'); };
  el.ondragleave = () => el.classList.remove('drag');
  el.ondrop = (e) => { e.preventDefault(); el.classList.remove('drag'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) onFile(f); };
};

// Icon per scene style (names from icons.js).
const SCENE_ICONS = { mirror_pajamas: 'mirror', bed_morning: 'bed', outfit_check: 'shirt', bed_sitting: 'bed', bathroom_grwm: 'brush', kitchen_coffee: 'coffee', couch_cozy: 'sofa', car_selfie: 'car', gym_mirror: 'dumbbell', window_golden: 'sunset' };
// Small label with a leading icon (the .label class is not a flex container).
const label = (ic, text) => `<div class="label" style="display:flex;align-items:center;gap:6px">${icon(ic, { size: 14 })}${text}</div>`;

function profileChips(p) {
  if (!p) return '';
  const none = (v) => !v || /^none$|^no\b|^n\/a$/i.test(String(v).trim());
  const chips = [
    none(p.tattoos) ? [icon('ban'), 'No tattoos'] : ['', `Tattoos: ${p.tattoos}`],
    none(p.piercings) ? [icon('ban'), 'No piercings'] : ['', `Piercings: ${p.piercings}`],
    !none(p.face_marks) && ['', `Marks: ${p.face_marks}`],
    p.hair && ['', `Hair: ${p.hair}`],
    p.eyes && ['', `Eyes: ${p.eyes}`],
    p.skin && ['', `Skin: ${p.skin}`],
    p.nails && ['', `Nails: ${p.nails}`],
  ].filter(Boolean);
  return chips.map(([ic, text]) => `<span class="pchip">${ic}${h.esc(stripEmoji(text))}</span>`).join('');
}

export async function renderCreate(params) {
  clearTimeout(st.poll);
  const seq = ++st.seq;
  // Meta, the model list and (when the model is already known) its assets load in parallel.
  const guess = Number(params.get('model')) || st.modelId;
  const [m1, models, assetsGuess] = await Promise.all([
    meta || h.api('/api/studio/meta'),
    h.api('/api/models'),
    guess ? h.api(`/api/models/${guess}/assets`).catch(() => null) : null,
  ]);
  meta = m1;
  if (!on() || seq !== st.seq) return;
  if (!models.length) {
    h.$('#view').innerHTML = `<div class="empty">${icon('user', { size: 28 })}<h3>No models yet</h3><p><a href="#/models">Create a model</a> and upload her photos.</p></div>`;
    return;
  }
  st.modelId = guess || (models.find((x) => x.readiness.ready) || models[0]).id;
  const m = models.find((x) => x.id === st.modelId) || models[0];
  st.modelId = m.id;
  const assets = m.id === guess && assetsGuess ? assetsGuess : await h.api(`/api/models/${m.id}/assets`);
  if (!on() || seq !== st.seq) return;
  const places = assets.filter((a) => a.type === 'location');
  const phones = assets.filter((a) => a.type === 'prop');
  const outfits = assets.filter((a) => a.type === 'outfit');
  st.scene ||= meta.scenes[0].key;
  const cover = (x) => (x.ref_images.find((r) => r.kind === 'face_front') || x.ref_images[0])?.path;
  const editBtn = (id) => `<i data-edit="${id}" title="Edit" aria-label="Edit">${icon('edit')}</i>`;

  h.$('#page-title').textContent = 'Create content';
  h.$('#view').innerHTML = `
    <h2>Create content</h2>
    <p class="sub">Original photos of your AI models. Each model always keeps the same face, body and features, read from her photos, and can have fixed locations, a fixed phone and fixed outfits.</p>

    <div class="step"><span class="step-n">1</span><b>Model</b></div>
    <div class="model-cards">${models.map((x) => `
      <a class="mcard ${x.id === m.id ? 'active' : ''} ${x.readiness.ready ? '' : 'off'}" href="#/create?model=${x.id}">
        <div class="mcard-img" style="${cover(x) ? `background-image:url('${media(cover(x))}')` : ''}">${cover(x) ? '' : h.esc(x.name[0])}</div>
        <div><b>${h.esc(x.name)}</b><div class="dim" style="font-size:11.5px">${x.readiness.ready ? `${x.ref_images.length} photos` : 'No photos'}</div></div>
      </a>`).join('')}<a class="mcard add" href="#/models">${icon('plus')}New model</a></div>

    <div class="card profile-card">
      <div class="row between"><b>${h.esc(m.name)}'s profile <span class="dim" style="font-weight:400;font-size:12px">· read from her photos and used in every generation</span></b>
        <button class="btn sm ghost" id="p-refresh" ${m.ref_images.length ? '' : 'disabled'}>${icon('refresh')}Re-read photos</button></div>
      <div class="pchips" id="p-chips">${m.profile ? profileChips(m.profile) : `<span class="dim" style="font-size:12.5px">${m.ref_images.length ? 'Reading the profile from the photos…' : 'Upload photos of the model in Models to create the profile.'}</span>`}</div>
      <details class="adjust"><summary class="dim">Manual adjustments (optional)</summary>
        <textarea class="input" id="u-rules" rows="2" placeholder="Only to force something the photos do not show. E.g. always the same small gold necklace">${h.esc(m.rules || '')}</textarea>
        <span class="dim" id="u-rules-saved" style="font-size:11.5px"></span>
      </details>
    </div>

    <div class="step"><span class="step-n">2</span><b>Style</b></div>
    <div class="scene-cards">${meta.scenes.map((sc) => `<button class="scard ${st.scene === sc.key ? 'active' : ''}" data-scene="${sc.key}"><span>${icon(SCENE_ICONS[sc.key] || 'camera')}</span>${h.esc(sc.label)}</button>`).join('')}</div>

    <div class="step"><span class="step-n">3</span><b>Location, outfit and phone</b> <span class="dim" style="font-size:12px">· saved for this model and reused</span></div>
    <div class="grid-3" style="align-items:start">
      <div>${label('map-pin', 'Location')}
        <div class="pick-row" id="pick-place">
          <button class="pick" data-place="">From the scene<small>(described)</small></button>
          ${places.map((p) => `<button class="pick img" data-place="${p.id}" title="${h.esc(p.description)}" style="${p.path ? `background-image:url('${media(p.path)}')` : ''}"><small>${h.esc(p.name)}</small>${editBtn(p.id)}</button>`).join('')}
          <button class="pick add" data-new="location">${icon('plus')}<small>New location</small></button>
        </div></div>
      <div>${label('shirt', 'Outfit')}
        <div class="pick-row" id="pick-outfit">
          <button class="pick" data-outfit="">From the scene<small>(automatic)</small></button>
          ${outfits.map((o) => `<button class="pick img" data-outfit="${o.id}" title="${h.esc(o.description)}" style="${o.path ? `background-image:url('${media(o.path)}')` : ''}"><small>${h.esc(o.name)}</small>${editBtn(o.id)}</button>`).join('')}
          <label class="pick add" id="outfit-drop" title="Drag a photo or click to choose">${icon('plus')}<small>Add outfit</small><input type="file" accept="image/*" hidden id="outfit-file"></label>
        </div>
        <input class="input" id="c-outfit-text" placeholder="Or describe the outfit, e.g. light pink satin pajamas" style="margin-top:6px"></div>
      <div>${label('smartphone', 'Phone')}
        <div class="pick-row" id="pick-phone">
          ${phones.map((p) => `<button class="pick img active" data-phone="${p.id}" style="${p.path ? `background-image:url('${media(p.path)}')` : ''}"><small>${h.esc(p.name)}</small>${editBtn(p.id)}</button>`).join('')}
          ${phones.length ? '<button class="pick" data-phone="">None<small>no fixed phone</small></button>' : `<button class="pick add" data-new="prop">${icon('plus')}<small>Set phone</small></button>`}
        </div></div>
    </div>

    <div class="step"><span class="step-n">4</span><b>Poses and format</b> <span class="dim" style="font-size:12px">· optional: one photo per pose</span></div>
    <div class="pose-pick">${meta.poses.map((p) => `<label class="chip pose"><input type="checkbox" value="${p.key}" hidden>${h.esc(p.label)}</label>`).join('')}</div>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <input class="input" id="c-extra" style="flex:1;min-width:240px" placeholder="Extra directions (optional), e.g. holding a teddy bear, hair tied up">
      <label class="field"><span>Format</span><select class="input" id="c-aspect"><option value="4:5">4:5 (post)</option><option value="9:16">9:16 (story)</option><option value="1:1">1:1</option><option value="3:4">3:4</option></select></label>
      <label class="field"><span>Quality</span><select class="input" id="c-res"><option>1K</option><option>2K</option><option>4K</option></select></label>
      <label class="field"><span>Variants</span><select class="input" id="c-var"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></label>
    </div>
    <div class="gen-bar"><span id="c-cost" class="dim"></span><button class="btn primary big" id="c-go" ${m.readiness.ready ? '' : 'disabled'}>${icon('play-circle')}Generate</button></div>

    <h3 style="margin:22px 0 10px">${h.esc(m.name)}'s creations</h3>
    <div id="creations" class="stack"></div>`;

  // profile: auto-read when missing/stale
  const readProfile = async () => {
    const box = h.$('#p-chips');
    box.innerHTML = '<span class="dim" style="font-size:12.5px"><span class="spinner inline"></span>Reading the profile from the photos…</span>';
    try { const r = await h.api(`/api/models/${m.id}/analyze-profile`, { method: 'POST' }); if (on() && box.isConnected) box.innerHTML = profileChips(r.profile); }
    catch (e) { if (on() && box.isConnected) box.innerHTML = `<span class="err-box" style="margin:0">${icon('x-circle')}${h.esc(stripEmoji(e.message))}</span>`; }
  };
  h.$('#p-refresh').onclick = readProfile;
  if (m.profileStale && m.ref_images.length) readProfile();
  const rules = h.$('#u-rules');
  let t;
  rules.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        await h.api(`/api/models/${m.id}`, { method: 'PATCH', body: { rules: rules.value } });
        const saved = h.$('#u-rules-saved');
        if (saved) saved.textContent = 'Saved';
      } catch (e) { h.toast(e.message, true); }
    }, 900);
  };

  // selections
  const sel = { place: '', outfit: '', phone: phones[0] ? String(phones[0].id) : '' };
  const markPick = (rowSel, attr, val) => h.$$(`${rowSel} [${attr}]`).forEach((b) => b.classList.toggle('active', b.getAttribute(attr) === val));
  const autoPlace = () => {
    const sc = meta.scenes.find((x) => x.key === st.scene);
    const match = places.find((p) => p.subtype === sc?.location);
    sel.place = match ? String(match.id) : '';
    markPick('#pick-place', 'data-place', sel.place);
  };
  h.$$('[data-scene]').forEach((b) => (b.onclick = () => { st.scene = b.dataset.scene; h.$$('[data-scene]').forEach((x) => x.classList.toggle('active', x === b)); autoPlace(); }));
  autoPlace();
  h.$$('#pick-place [data-place]').forEach((b) => (b.onclick = (e) => { if (e.target.closest('[data-edit]')) return; sel.place = b.dataset.place; markPick('#pick-place', 'data-place', sel.place); }));
  h.$$('#pick-outfit [data-outfit]').forEach((b) => (b.onclick = (e) => { if (e.target.closest('[data-edit]')) return; sel.outfit = b.dataset.outfit; st.outfitImage = null; markPick('#pick-outfit', 'data-outfit', sel.outfit); }));
  markPick('#pick-outfit', 'data-outfit', '');
  h.$$('#pick-phone [data-phone]').forEach((b) => (b.onclick = (e) => { if (e.target.closest('[data-edit]')) return; sel.phone = b.dataset.phone; markPick('#pick-phone', 'data-phone', sel.phone); }));
  h.$$('[data-edit]').forEach((i) => (i.onclick = (e) => { e.stopPropagation(); assetDialog(m, assets.find((a) => a.id === Number(i.dataset.edit))); }));
  h.$$('[data-new]').forEach((b) => (b.onclick = () => assetDialog(m, { type: b.dataset.new })));
  const addOutfit = async (f) => {
    try {
      const a = await h.api(`/api/models/${m.id}/assets`, { method: 'POST', body: { type: 'outfit', name: f.name.replace(/\.\w+$/, '').slice(0, 40), image: await fileToDataUrl(f) } });
      h.toast('Outfit saved and selected');
      st.pendingOutfit = a.id;
      renderCreate(params);
    } catch (e) { h.toast(e.message, true); }
  };
  dropZone(h.$('#outfit-drop'), addOutfit);
  h.$('#outfit-file').onchange = (e) => e.target.files[0] && addOutfit(e.target.files[0]);
  if (st.pendingOutfit) { sel.outfit = String(st.pendingOutfit); markPick('#pick-outfit', 'data-outfit', sel.outfit); st.pendingOutfit = null; }

  const selPoses = () => h.$$('.pose-pick input:checked').map((x) => x.value);
  const cost = () => {
    h.$$('.pose-pick .pose').forEach((c) => c.classList.toggle('active', c.querySelector('input').checked));
    const n = Math.max(1, selPoses().length) * Number(h.$('#c-var').value);
    h.$('#c-cost').textContent = `${n} photo(s) · ~${usd(n * IMG_COST[h.$('#c-res').value])}`;
  };
  h.$$('#c-var, #c-res, .pose-pick input').forEach((x) => (x.onchange = cost));
  cost();
  h.$('#c-go').onclick = async () => {
    const go = h.$('#c-go');
    go.disabled = true;
    try {
      await h.api('/api/creations', {
        method: 'POST',
        body: {
          modelId: m.id, scene: st.scene, placeId: Number(sel.place) || null,
          phoneId: Number(sel.phone) || null, forcePhone: !!Number(sel.phone),
          outfitId: Number(sel.outfit) || null, outfitText: sel.outfit ? '' : h.$('#c-outfit-text').value,
          poses: selPoses(), extra: h.$('#c-extra').value,
          aspect: h.$('#c-aspect').value, resolution: h.$('#c-res').value, variants: Number(h.$('#c-var').value),
        },
      });
      h.toast('Generation started');
      loadCreations(m.id);
      h.$('#creations')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { h.toast(e.message, true); }
    go.disabled = false;
  };
  loadCreations(m.id);
}

function assetCard(a) {
  return `<div class="asset" data-id="${a.id}" title="${h.esc(a.description || '')}">
    ${a.path ? `<img src="${media(a.path)}" loading="lazy">` : '<div class="asset-empty">No image</div>'}
    <div class="asset-name">${h.esc(a.name)}</div></div>`;
}

function assetDialog(m, a) {
  const type = a.type;
  const title = { location: ['New location', 'Edit location'], prop: ['New phone', 'Edit phone'], outfit: ['New outfit', 'Edit outfit'] }[type][a.id ? 1 : 0];
  const hint = {
    location: 'e.g. small cozy bedroom, white walls, beige linen bedding, fairy lights above the bed, full-length mirror with wooden frame next to the wardrobe, plants on the windowsill, warm lamp light',
    prop: 'e.g. iPhone 15 Pro in natural titanium with a light pink silicone case and a small heart keychain',
    outfit: 'e.g. light pink satin pajama set with white piping (short-sleeve top and shorts)',
  }[type];
  const aiLabel = `${icon('image')}Create image with AI`;
  h.showModal(`<div class="modal-box small" style="max-width:560px">
    <div class="row between"><h3 style="margin:0">${title}</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
    <form class="stack" id="asset-form" style="margin-top:12px">
      <div class="row" style="gap:10px">
        <input class="input" name="name" style="flex:1" placeholder="Name" value="${h.esc(a.name || '')}">
        ${type === 'location' ? `<select class="input" name="subtype">${Object.entries(meta.locationTypes).map(([k, l]) => `<option value="${k}" ${a.subtype === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      </div>
      <textarea class="input" name="description" rows="4" placeholder="${h.esc(hint)}">${h.esc(a.description || '')}</textarea>
      <div class="asset-drop" id="asset-drop">${a.path ? `<img src="${media(a.path)}">` : '<span>Drag a photo here (optional)</span>'}</div>
      <div class="dim" style="font-size:12px">${type === 'location' ? 'No photo? Write the description and press “Create image with AI”. The image is created once and always reused as the same place.' : 'With a real photo the result is more faithful. You can also create the image with AI from the description.'}</div>
      <div class="row between">
        <div class="row">${a.id ? '<button type="button" class="btn sm ghost danger" id="asset-del">Delete</button>' : ''}</div>
        <div class="row"><button type="button" class="btn" id="asset-ai">${aiLabel}</button><button class="btn primary">Save</button></div>
      </div>
    </form></div>`);
  let img = null;
  dropZone(h.$('#asset-drop'), async (f) => { img = await fileToDataUrl(f); h.$('#asset-drop').innerHTML = `<img src="${img}">`; });
  const save = async () => {
    const f = new FormData(h.$('#asset-form'));
    const body = { type, name: f.get('name'), subtype: f.get('subtype'), description: f.get('description'), ...(img ? { image: img } : {}) };
    return a.id ? h.api(`/api/assets/${a.id}`, { method: 'PATCH', body }) : h.api(`/api/models/${m.id}/assets`, { method: 'POST', body });
  };
  h.$('#asset-form').onsubmit = async (e) => { e.preventDefault(); try { await save(); h.closeModal(); renderCreate(new URLSearchParams(`model=${m.id}`)); } catch (err) { h.toast(err.message, true); } };
  h.$('#asset-ai').onclick = async () => {
    const btn = h.$('#asset-ai');
    btn.disabled = true; btn.textContent = 'Creating… (~20 s)';
    let ok = false;
    try {
      const saved = await save();
      a = saved; // from here on it is an existing asset: a retry updates it instead of creating a duplicate
      img = null; // the dropped photo is already stored
      const r = await h.api(`/api/assets/${saved.id}/generate`, { method: 'POST' });
      h.$('#asset-drop').innerHTML = `<img src="${media(r.path)}">`;
      a = r;
      ok = true;
      h.toast('Image created and saved. For another version, press Create again');
    } catch (err) { h.toast(err.message, true); }
    btn.disabled = false;
    btn.innerHTML = ok ? `${icon('refresh')}Create again` : aiLabel;
  };
  if (h.$('#asset-del')) h.$('#asset-del').onclick = async () => {
    try { await h.api(`/api/assets/${a.id}`, { method: 'DELETE' }); h.closeModal(); renderCreate(new URLSearchParams(`model=${m.id}`)); }
    catch (err) { h.toast(err.message, true); }
  };
}

async function loadCreations(modelId) {
  clearTimeout(st.poll);
  const box = h.$('#creations');
  if (!box) return;
  let rows;
  try { rows = await h.api(`/api/creations?model=${modelId}`); }
  catch {
    // Server briefly unavailable (e.g. restarting): try again quietly instead of stopping the updates.
    if (on() && box.isConnected) st.poll = setTimeout(() => loadCreations(modelId), 5000);
    return;
  }
  if (!on() || !box.isConnected) return;
  box.innerHTML = rows.length ? rows.map(creationCard).join('') : '<div class="dim" style="font-size:13px">No creations yet.</div>';
  h.$$('.creation', box).forEach((el) => {
    const id = Number(el.dataset.id);
    h.$$('[data-zoom]', el).forEach((img) => (img.onclick = () => h.showModal(`<div class="modal-box small" style="max-width:600px;padding:0;background:black"><img src="${img.dataset.zoom}" style="width:100%;display:block" data-close></div>`)));
    h.$$('[data-act]', el).forEach((b) => (b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'delete' && !confirm('Delete this creation?')) return;
      b.disabled = true; // no double submits (a second "Gerar mais" would pay twice)
      try {
        if (act === 'again') await h.api(`/api/creations/${id}/again`, { method: 'POST' });
        if (act === 'approve') await h.api(`/api/creations/${id}/stage`, { method: 'POST', body: { stage: 'approved' } });
        if (act === 'cancel') await h.api(`/api/creations/${id}/stage`, { method: 'POST', body: { stage: 'cancelled' } });
        if (act === 'delete') await h.api(`/api/creations/${id}`, { method: 'DELETE' });
        if (act === 'folder') { await h.api(`/api/creations/${id}/to-folder`, { method: 'POST', body: { index: Number(b.dataset.i) } }); h.toast('Saved to the model folder (Style)'); }
      } catch (e) { h.toast(e.message, true); }
      loadCreations(modelId);
    }));
  });
  if (rows.some((r) => ['queued', 'generating'].includes(r.stage))) st.poll = setTimeout(() => loadCreations(modelId), 3000);
}

function creationCard(c) {
  const running = ['queued', 'generating'].includes(c.stage);
  const scene = meta.scenes.find((s) => s.key === c.config.scene);
  const tone = { review: 'act', approved: 'ok', failed: 'bad', cancelled: 'off' }[c.stage] || 'run';
  const stageLabel = { queued: 'Queued', generating: 'Generating', review: 'Review', approved: 'Approved', failed: 'Failed', cancelled: 'Canceled' }[c.stage] || c.stage;
  const file = (i) => `${h.esc((c.model_name || 'model').toLowerCase())}_${c.id}_${i + 1}.png`;
  return `<article class="card creation" data-id="${c.id}">
    <div class="row between">
      <div class="row" style="gap:8px"><span class="stage ${tone}">${stageLabel}</span><b>${h.esc(scene?.label || 'Photo')}</b>
        <span class="dim" style="font-size:12px">#${c.id} · ${h.dateTime(c.created_at)} · ${usd(c.cost_usd || 0)} · ${h.esc(c.config.aspect)} ${h.esc(c.config.resolution)}</span></div>
      <div class="row">${running ? '<button class="btn sm ghost danger" data-act="cancel">Cancel</button>'
        : `<button class="btn sm" data-act="again">${icon('refresh')}Generate more</button>${c.stage === 'review' ? `<button class="btn sm primary" data-act="approve">${icon('check')}Approve</button>` : ''}`}<button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button></div>
    </div>
    ${running ? `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(c.step_status || 'Preparing…'))}</b></div></div>` : ''}
    ${c.error ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(c.error))}</div>` : ''}
    ${c.candidates.length ? `<div class="photo-grid">${c.candidates.map((x, i) => `<div class="pg">
      <img src="${media(x.path)}" data-zoom="${media(x.path)}" loading="lazy"><div class="pg-label">${h.esc(x.label || '')}</div>
      <div class="pg-actions"><a class="btn sm icon-only" href="${media(x.path)}" download="${file(i)}" title="Download" aria-label="Download">${icon('download')}</a><button class="btn sm icon-only" data-act="folder" data-i="${i}" title="Save to the model folder" aria-label="Save to the model folder">${icon('folder-plus')}</button></div></div>`).join('')}</div>` : ''}
  </article>`;
}
