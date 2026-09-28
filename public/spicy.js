// "Conteúdo 18+": adult content of the fictional AI models via fal.ai (Z-Image LoRA + Wan 2.2) and via the user's own
// workflows on RunningHub (SKY 18+, INSTARAW generators; Detailing and Inpainting tools on her images).
import { icon, stripEmoji } from './icons.js';

let h;
export function init(helpers) { h = helpers; }

const media = (p) => `/media/${h.esc(p)}`;
const on = () => /^#\/spicy(?:[/?]|$)/.test(location.hash);
const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const st = { modelId: null, model: null, scene: 'mirror', level: 1, source: null, engine: 'fal', poll: null, trainPoll: null, seq: 0 };
let meta = null; // static catalogue (scenes, levels, prices) + whether the fal.ai key exists; reset after saving the key

// Local icon per scene. The server's emoji icons (sc.icon) are never rendered.
const SCENE_ICONS = { mirror: 'mirror', bed: 'bed', pov: 'smartphone', kneel: 'bed', behind: 'user', shower: 'droplet', bath: 'bath', couch: 'sofa', beach: 'sun', custom: 'edit' };
const textLabel = (key) => (key === 'custom' ? 'Describe the photo' : 'Extra directions (optional)');
// Her RunningHub workflows that are configured (key + workflow id): generators and tools.
const rhEngines = () => (meta?.rhEngines || []).filter((e) => e.ready);
const rhTools = () => (meta?.rhTools || []).filter((t) => t.ready);
const rhName = (key) => [...(meta?.rhEngines || []), ...(meta?.rhTools || [])].find((x) => x.key === key)?.name || key;
const textHint = (key) => (key === 'custom' ? 'e.g. sitting on the kitchen counter in an oversized shirt, morning light' : 'e.g. black lace, hair in a messy bun, biting her lip');

export async function renderSpicy(params) {
  clearTimeout(st.poll); clearTimeout(st.trainPoll);
  const seq = ++st.seq;
  // Always fresh: which of her RunningHub workflows are configured can change in Definições.
  const [m1, models] = await Promise.all([h.api('/api/spicy/meta').catch((e) => { if (meta) return meta; throw e; }), h.api('/api/spicy/models')]);
  meta = m1;
  if (!on() || seq !== st.seq) return;
  h.$('#page-title').textContent = '18+ content';

  const keyCard = `
    <div class="card spicy-key">
      <div class="row between"><b><span class="dot ${meta.falKey ? 'on' : ''}"></span>fal.ai connection ${meta.falKey ? '<span class="status ok">Key saved</span>' : ''}</b>
        <a class="dim" href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener" style="font-size:12.5px;display:inline-flex;align-items:center;gap:5px">${icon('external-link', { size: 13 })}Create a key on fal.ai</a></div>
      <div class="row" style="margin-top:10px">
        <input class="input" id="fal-key" type="password" autocomplete="off" style="flex:1;min-width:240px" placeholder="${meta.falKey ? '•••••• (leave empty to keep)' : 'Paste your fal.ai API key here (id:secret)'}">
        <button class="btn" id="fal-save">Save</button>
        <button class="btn ghost" id="fal-test" ${meta.falKey ? '' : 'disabled'}>Test</button>
      </div>
      <small class="dim">Open-weight models (Z-Image Turbo and Wan 2.2) with no NSFW filter. Pay per use on fal.ai: add credits at fal.ai/dashboard/billing.</small>
    </div>`;

  if (!models.length) {
    h.$('#view').innerHTML = `<h2>18+ content</h2>${keyCard}<div class="empty">${icon('user', { size: 28 })}<h3>No models yet</h3><p><a href="#/models">Create a model</a> and upload her photos.</p></div>`;
    bindKey();
    return;
  }
  st.modelId = Number(params.get('model')) || st.modelId || models[0].id;
  const m = models.find((x) => x.id === st.modelId) || models[0];
  st.modelId = m.id;
  if (st.model && st.model.id !== m.id) st.source = null; // a base photo only belongs to the model it came from
  st.model = m;
  const cover = (x) => (x.refs.find((r) => r.kind === 'face_front') || x.refs[0])?.path;
  const training = m.training && ['queued', 'running'].includes(m.training.stage);
  const scene = meta.scenes.find((s) => s.key === st.scene) || meta.scenes[0];
  st.scene = scene.key;
  if (st.engine !== 'fal' && !rhEngines().some((e) => e.key === st.engine)) st.engine = 'fal';
  // What the selected engine needs: fal = her trained LoRA + the fal key; SKY 18+ = her Z-Image LoRA name on RunningHub.
  const usable = () => (st.engine === 'fal' ? !!(m.lora && meta.falKey) : st.engine !== 'sky_nsfw' || m.rhLora);
  const loraStatus = (x) => (x.lora
    ? `<div class="dim" style="font-size:11.5px;display:flex;align-items:center;gap:4px">${icon('check-circle', { cls: 'ok', size: 12 })}LoRA ready</div>`
    : `<div class="dim" style="font-size:11.5px">${x.training && ['queued', 'running'].includes(x.training.stage) ? 'Training…' : 'No LoRA'}</div>`);

  h.$('#view').innerHTML = `
    <h2>18+ content</h2>
    <p class="sub">Adult content of your AI models, who are fictional adult characters. Only the model's own photos are used: reels and real creators never come in here.</p>
    ${keyCard}

    <div class="step"><span class="step-n">1</span><b>Model</b></div>
    <div class="model-cards">${models.map((x) => `
      <a class="mcard ${x.id === m.id ? 'active' : ''}" href="#/spicy?model=${x.id}">
        <div class="mcard-img" style="${cover(x) ? `background-image:url('${media(cover(x))}')` : ''}">${cover(x) ? '' : h.esc(x.name[0])}</div>
        <div><b>${h.esc(x.name)}</b>${loraStatus(x)}</div>
      </a>`).join('')}</div>

    <div class="step"><span class="step-n">2</span><b>Identity (LoRA)</b> <span class="dim" style="font-size:12px">· a one-time training that keeps her face and body the same in every photo</span></div>
    <div class="card" id="lora-card">${loraCard(m, training)}</div>

    <div class="step"><span class="step-n">3</span><b>Generate photos</b></div>
    <div class="card stack ${usable() ? '' : 'off-card'}" id="gen-card">
      ${rhEngines().length ? `<div><div class="label">Engine</div>
        <div class="chips" id="s-engines"><button class="chip ${st.engine === 'fal' ? 'active' : ''}" data-engine="fal">Z-Image LoRA <span class="dim">· fal.ai</span></button>${rhEngines().map((e) => `<button class="chip ${st.engine === e.key ? 'active' : ''}" data-engine="${e.key}" title="${h.esc(e.desc)}">${h.esc(e.name)} <span class="dim">· RunningHub</span></button>`).join('')}</div>
        <small class="dim" id="s-engine-hint" style="display:block;margin-top:6px"></small></div>` : ''}
      <div><div class="label">Scene</div>
        <div class="scene-cards">${meta.scenes.map((sc) => `<button class="scard ${st.scene === sc.key ? 'active' : ''}" data-scene="${sc.key}"><span>${icon(SCENE_ICONS[sc.key] || 'image')}</span>${h.esc(sc.label)}</button>`).join('')}</div></div>
      <div><div class="label">Level</div>
        <div class="chips">${meta.levels.map((l) => `<button class="chip ${st.level === l.key ? 'active' : ''}" data-level="${l.key}">${h.esc(l.label)} <span class="dim">· ${h.esc(l.hint)}</span></button>`).join('')}</div></div>
      <label class="field"><span id="s-text-label">${textLabel(scene.key)}</span>
        <textarea class="input" id="s-text" rows="2" placeholder="${h.esc(textHint(scene.key))}"></textarea>
        <small>Write in English for the best results. The text is checked, and any reference to minors or real people is blocked.</small></label>
      <div><div class="label" id="s-src-label"></div>
        <div class="row" id="s-src-row" style="margin-top:6px"></div></div>
      <div class="row" style="align-items:flex-end">
        <label class="field" data-fal><span>Format</span><select class="input" id="s-aspect">${meta.sizes.map((a) => `<option ${a === '4:5' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <label class="field"><span>Variants</span><select class="input" id="s-n"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></label>
        <label class="field" data-fal><span>LoRA strength</span><select class="input" id="s-scale"><option value="0.8">0.8 (looser)</option><option value="1" selected>1.0</option><option value="1.2">1.2 (closer likeness)</option></select></label>
        <label class="field" data-fal><span>Seed (optional)</span><input class="input" id="s-seed" type="number" style="width:120px" placeholder="Random"></label>
      </div>
      <details class="adjust" id="s-prompt-box"><summary class="dim">View the full text sent to the generator (optional)</summary>
        <small class="dim" style="display:block;margin:6px 0">The app builds this text on its own from the scene, the level and what you wrote above. You do not need to touch it. It is only for full manual control: check “Use this prompt as is” and it is sent exactly as written.</small>
        <textarea class="input" id="s-prompt" rows="6"></textarea>
        <label class="check"><input type="checkbox" id="s-prompt-use"> Use this prompt as is</label>
      </details>
    </div>
    <div class="gen-bar"><span id="s-cost" class="dim"></span>
      <button class="btn big" id="s-anim" ${m.lora || m.refs.length ? '' : 'disabled'}>${icon('film')}Animate a photo</button>
      <button class="btn primary big" id="s-go" ${usable() ? '' : 'disabled'}>${icon('play-circle')}Generate</button></div>

    <h3 style="margin:22px 0 10px">${h.esc(m.name)}'s gallery</h3>
    <div id="spicy-jobs" class="stack"></div>`;

  bindKey();
  bindLora(m, training);
  bindSource(m);

  let pt;
  const refreshPrompt = async () => {
    if (h.$('#s-prompt-use').checked) return;
    try {
      const r = await h.api('/api/spicy/preview-prompt', { method: 'POST', body: { modelId: m.id, scene: st.scene, level: st.level, text: h.$('#s-text').value } });
      if (on() && h.$('#s-prompt')) h.$('#s-prompt').value = r.prompt;
    } catch {}
  };

  // selections: update in place (no page re-render, no refetch)
  h.$$('[data-scene]').forEach((b) => (b.onclick = () => {
    st.scene = b.dataset.scene;
    h.$$('[data-scene]').forEach((x) => x.classList.toggle('active', x === b));
    h.$('#s-text-label').textContent = textLabel(st.scene);
    h.$('#s-text').placeholder = textHint(st.scene);
    refreshPrompt();
  }));
  h.$$('[data-level]').forEach((b) => (b.onclick = () => { st.level = Number(b.dataset.level); h.$$('[data-level]').forEach((x) => x.classList.toggle('active', x === b)); refreshPrompt(); }));
  const cost = () => {
    h.$('#s-cost').textContent = st.engine === 'fal' ? `≈ ${usd(Number(h.$('#s-n').value) * meta.price.image)} per generation` : 'Paid on RunningHub (GPU time, billed there)';
  };
  // The engine changes what the card asks for; updated in place.
  const applyEngine = () => {
    const rh = st.engine !== 'fal';
    h.$$('[data-fal]').forEach((el) => el.classList.toggle('hidden', rh));
    h.$('#gen-card')?.classList.toggle('off-card', !usable());
    const go = h.$('#s-go');
    if (go) go.disabled = !usable();
    const hint = h.$('#s-engine-hint');
    if (hint) {
      const e = rhEngines().find((x) => x.key === st.engine);
      hint.innerHTML = !rh ? 'Z-Image Turbo with her trained LoRA (step 2), on fal.ai.'
        : `${h.esc(e?.desc || '')}${st.engine === 'sky_nsfw' && !m.rhLora ? ` <b style="color:var(--bad)">The name of ${h.esc(m.name)}'s Z-Image LoRA is missing in <a href="#/setup">Settings → RunningHub</a>.</b>` : ''}`;
    }
    bindSource(m);
    cost();
  };
  h.$$('[data-engine]').forEach((b) => (b.onclick = () => {
    st.engine = b.dataset.engine;
    h.$$('[data-engine]').forEach((x) => x.classList.toggle('active', x === b));
    applyEngine();
  }));
  h.$('#s-n').onchange = cost;
  applyEngine();

  h.$('#s-text').oninput = () => { clearTimeout(pt); pt = setTimeout(refreshPrompt, 500); };
  refreshPrompt();

  h.$('#s-go').onclick = async () => {
    const btn = h.$('#s-go');
    if (st.engine !== 'fal' && !st.source) return h.toast(`${rhName(st.engine)} starts from one of her photos: choose the base photo`, true);
    btn.disabled = true;
    try {
      await h.api('/api/spicy/images', { method: 'POST', body: {
        modelId: m.id, engine: st.engine, scene: st.scene, level: st.level, text: h.$('#s-text').value, aspect: h.$('#s-aspect').value, n: h.$('#s-n').value,
        loraScale: h.$('#s-scale').value, seed: h.$('#s-seed').value || null, source: st.source, strength: h.$('#s-strength')?.value,
        promptOverride: h.$('#s-prompt-use').checked ? h.$('#s-prompt').value : null,
      } });
      h.toast(st.engine === 'fal' ? 'Queued on fal.ai' : 'Queued on RunningHub');
      loadJobs(m.id);
    } catch (e) { h.toast(e.message, true); }
    btn.disabled = !usable();
  };
  h.$('#s-anim').onclick = () => pickImage(m, 'Photo to animate', (p) => animateDialog(m, p));
  loadJobs(m.id);
}

// Base photo row: re-rendered on its own when the photo is chosen or removed.
function bindSource(m) {
  const row = h.$('#s-src-row');
  if (!row) return;
  const strength = h.$('#s-strength')?.value || '0.65';
  const rh = st.engine !== 'fal';
  const label = h.$('#s-src-label');
  if (label) label.innerHTML = rh ? `Base photo <b>(required)</b> <span class="dim">· the workflow redoes this photo of her</span>` : 'Base photo (optional) <span class="dim">· starts from one of her photos (e.g. from Create content) and keeps the setting and pose</span>';
  row.innerHTML = `<button class="btn sm" id="s-src-btn">${st.source ? 'Change base photo' : `${icon('plus')}Choose one of her photos`}</button>
    ${st.source ? `<img class="src-thumb" src="${media(st.source)}" alt=""><button class="btn sm ghost" id="s-src-clear">${icon('x')}Remove base photo</button>
    ${rh ? '' : `<label class="field" style="flex-direction:row;align-items:center;gap:8px"><span>Change</span><input type="range" id="s-strength" min="0.3" max="0.95" step="0.05" value="${strength}"><b id="s-strength-v">${strength}</b></label>`}` : ''}`;
  h.$('#s-src-btn').onclick = () => pickImage(m, 'Base photo', (p) => { st.source = p; bindSource(m); });
  if (h.$('#s-src-clear')) h.$('#s-src-clear').onclick = () => { st.source = null; bindSource(m); };
  if (h.$('#s-strength')) h.$('#s-strength').oninput = (e) => { h.$('#s-strength-v').textContent = e.currentTarget.value; };
}

function bindKey() {
  h.$('#fal-save').onclick = async () => {
    const v = h.$('#fal-key').value.trim();
    if (!v) return h.toast('Paste the key first', true);
    try {
      await h.api('/api/settings', { method: 'PUT', body: { fal_api_key: v } });
      meta = null; // falKey changed
      h.toast('fal.ai key saved');
      renderSpicy(new URLSearchParams(`model=${st.modelId || ''}`));
    } catch (e) { h.toast(e.message, true); }
  };
  h.$('#fal-test').onclick = async () => {
    const b = h.$('#fal-test'); b.disabled = true; b.textContent = 'Testing…';
    try { const r = await h.api('/api/spicy/test-key', { method: 'POST' }); r.ok ? h.toast('fal.ai accepted the key') : h.toast(r.error, true); }
    catch (e) { h.toast(e.message, true); }
    b.disabled = false; b.textContent = 'Test';
  };
}

function loraCard(m, training) {
  if (training) {
    return `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(m.training.step_status || 'Queued…'))}</b>
      <div class="dim" style="font-size:12px">Training runs on fal.ai (10–30 min). You can close the app: tracking resumes when you come back.</div></div></div>`;
  }
  const failed = m.training?.stage === 'failed' && !m.lora ? `<div class="err-box">${icon('x-circle')}Last training: ${h.esc(stripEmoji(m.training.error || 'failed'))}</div>` : '';
  if (m.lora) {
    return `<div class="row between"><div><b style="display:flex;align-items:center;gap:6px">${icon('check-circle', { cls: 'ok' })}${h.esc(m.name)}'s LoRA is ready</b>
      <div class="dim" style="font-size:12.5px">Trigger word <code>${h.esc(m.lora.trigger)}</code> · trained on ${m.lora.images || '?'} photos · ${h.dateTime(m.lora.at)}</div></div>
      <div class="row"><button class="btn sm" id="lora-retrain">${icon('refresh')}Retrain</button><button class="btn sm ghost danger" id="lora-del">Remove</button></div></div>
      <div id="lora-form" class="hidden" style="margin-top:12px">${trainForm(m)}</div>`;
  }
  return `${failed}${trainForm(m)}`;
}

function trainForm(m) {
  const n = m.dataset;
  const warn = n < 8 ? `<div class="callout warn">${icon('alert-triangle')}<div>Only ${n} photos in the folder. At least 8 are needed (ideal: 15–30). Generate more in <a href="#/create?model=${m.id}">Create content</a> and use “Save to the model folder”, or use “Generate missing angles” in Models.</div></div>`
    : n < 15 ? `<div class="dim" style="font-size:12.5px;margin:6px 0">${n} photos: enough, but with 15–30 (varied angles, outfits and lighting) the face comes out more faithful.</div>` : '';
  return `
    <div class="dim" style="font-size:12.5px">Dataset: the ${n} photos in ${h.esc(m.name)}'s folder.</div>
    <div class="ds-strip">${m.refs.slice(0, 40).map((r) => `<img src="${media(r.path)}" title="${h.esc(r.kind)}">`).join('')}</div>
    ${warn}
    <label class="check confirm"><input type="checkbox" id="ai-face" ${m.aiFaceConfirmed ? 'checked' : ''}><span>I confirm that this model's face and body were <b>generated by AI</b> and do not belong to a real person, and that she is an adult character.</span></label>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <label class="field"><span>Training steps</span><select class="input" id="lora-steps">${[500, 1000, 1500, 2000].map((s) => `<option value="${s}" ${s === 1000 ? 'selected' : ''}>${s} · ≈ ${usd((s / 1000) * meta.price.trainPer1k)}</option>`).join('')}</select></label>
      <button class="btn primary" id="lora-train" ${n >= 8 && meta.falKey ? '' : 'disabled'}>${icon('dna')}Train LoRA</button>
    </div>`;
}

function bindLora(m, training) {
  if (training) {
    const seq = st.seq; // a newer render of the page owns the polling from then on
    st.trainPoll = setTimeout(async () => {
      if (!on() || seq !== st.seq) return;
      let models;
      try { models = await h.api('/api/spicy/models'); }
      catch { if (on() && seq === st.seq && h.$('#lora-card')) bindLora(m, true); return; } // server briefly unavailable: keep checking
      const x = models.find((y) => y.id === m.id);
      if (!x || !on() || seq !== st.seq || !h.$('#lora-card')) return;
      const still = x.training && ['queued', 'running'].includes(x.training.stage);
      if (still) { h.$('#lora-card').innerHTML = loraCard(x, true); bindLora(x, true); } else renderSpicy(new URLSearchParams(`model=${m.id}`));
    }, 8000);
    return;
  }
  if (h.$('#lora-retrain')) h.$('#lora-retrain').onclick = () => h.$('#lora-form').classList.toggle('hidden');
  if (h.$('#lora-del')) h.$('#lora-del').onclick = async () => {
    if (!confirm('Remove the LoRA of this model? You can train another one afterwards.')) return;
    try { await h.api(`/api/spicy/models/${m.id}/lora`, { method: 'DELETE' }); }
    catch (e) { h.toast(e.message, true); return; }
    renderSpicy(new URLSearchParams(`model=${m.id}`));
  };
  const btn = h.$('#lora-train');
  if (btn) btn.onclick = async () => {
    if (!h.$('#ai-face').checked) return h.toast('You need to confirm that the model is AI-generated and an adult', true);
    btn.disabled = true;
    try {
      await h.api(`/api/spicy/models/${m.id}/train`, { method: 'POST', body: { steps: h.$('#lora-steps').value, confirmAiFace: true } });
      h.toast('Training sent to fal.ai');
      renderSpicy(new URLSearchParams(`model=${m.id}`));
    } catch (e) { h.toast(e.message, true); btn.disabled = false; }
  };
}

async function pickImage(m, title, onPick) {
  let imgs;
  try { imgs = await h.api(`/api/spicy/models/${m.id}/images`); }
  catch (e) { h.toast(e.message, true); return; }
  h.showModal(`<div class="modal-box small" style="max-width:900px">
    <div class="row between"><h3 style="margin:0">${h.esc(title)} · ${h.esc(m.name)}'s photos</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
    <p class="dim" style="font-size:12.5px">Only the model's own photos appear here (folder, Create content and 18+ content).</p>
    ${imgs.length ? `<div class="pick-grid">${imgs.map((p) => `<button data-p="${h.esc(p)}" style="background-image:url('${media(p)}')"></button>`).join('')}</div>` : `<div class="empty">${icon('image', { size: 28 })}<p>No photos yet.</p></div>`}
  </div>`);
  h.$$('.pick-grid [data-p]').forEach((b) => (b.onclick = () => { h.closeModal(); onPick(b.dataset.p); }));
}

/** "Corrigir uma zona": paint over the zone to redo (white on a black mask of the image's own size) + what goes there. */
function inpaintDialog(m, source) {
  h.showModal(`<div class="modal-box small" style="max-width:760px">
    <div class="row between"><h3 style="margin:0;display:flex;align-items:center;gap:8px">${icon('brush')}Fix an area</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
    <p class="dim" style="font-size:12.5px;margin:8px 0 10px">Paint over the area to redo (a hand, the eyes, a piece of clothing…) and write what you want there. The rest of the photo stays the same.</p>
    <div class="paint-box"><div class="paint-wrap"><img id="ip-img" src="${media(source)}" alt=""><canvas id="ip-canvas" aria-label="Area to redo"></canvas></div></div>
    <div class="row" style="margin-top:10px;align-items:center">
      <label class="field" style="flex-direction:row;align-items:center;gap:8px"><span>Brush</span><input type="range" id="ip-size" min="8" max="140" value="44"></label>
      <button class="btn sm ghost" id="ip-clear">${icon('rotate-ccw')}Clear</button>
    </div>
    <label class="field" style="margin-top:8px"><span>What you want in the painted area</span><input class="input" id="ip-text" maxlength="600" placeholder="e.g. relaxed natural hand with five fingers, red nail polish"></label>
    <div class="row between" style="margin-top:12px"><span class="dim" style="font-size:12.5px">${h.esc(rhName('inpaint'))} · paid on RunningHub (GPU time)</span><button class="btn primary" id="ip-go">${icon('play-circle')}Redo the area</button></div>
  </div>`);
  const img = h.$('#ip-img');
  const cv = h.$('#ip-canvas');
  const mask = document.createElement('canvas');
  let painted = false;
  const reset = () => {
    const w = img.naturalWidth; const hh = img.naturalHeight;
    cv.width = w; cv.height = hh; mask.width = w; mask.height = hh;
    const mc = mask.getContext('2d');
    mc.fillStyle = '#000'; mc.fillRect(0, 0, w, hh);
    painted = false;
  };
  if (img.complete && img.naturalWidth) reset(); else img.onload = reset;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height }; };
  const size = () => (Number(h.$('#ip-size').value) * cv.width) / (cv.getBoundingClientRect().width || cv.width);
  const stroke = (a, b) => {
    for (const [c, colour] of [[cv.getContext('2d'), '#b15cff'], [mask.getContext('2d'), '#fff']]) {
      c.strokeStyle = colour; c.lineWidth = size(); c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + 0.01, b.y); c.stroke();
    }
    painted = true;
  };
  let last = null;
  cv.onpointerdown = (e) => { if (!cv.width) return; cv.setPointerCapture(e.pointerId); last = pos(e); stroke(last, last); };
  cv.onpointermove = (e) => { if (!last) return; const p = pos(e); stroke(last, p); last = p; };
  cv.onpointerup = () => { last = null; };
  cv.onpointercancel = cv.onpointerup;
  h.$('#ip-clear').onclick = () => { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); reset(); };
  h.$('#ip-go').onclick = async () => {
    const text = h.$('#ip-text').value.trim();
    if (!painted) return h.toast('Paint the area to redo first', true);
    if (!text) return h.toast('Write what you want in the painted area', true);
    const go = h.$('#ip-go');
    go.disabled = true;
    try {
      await h.api('/api/spicy/tools', { method: 'POST', body: { tool: 'inpaint', modelId: m.id, source, text, mask: mask.toDataURL('image/png') } });
      h.closeModal(); h.toast('Queued on RunningHub'); loadJobs(m.id);
    } catch (e) { h.toast(e.message, true); go.disabled = false; }
  };
}

function animateDialog(m, source) {
  h.showModal(`<div class="modal-box small" style="max-width:620px">
    <div class="row between"><h3 style="margin:0;display:flex;align-items:center;gap:8px">${icon('film')}Animate (Wan 2.2)</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
    <div class="row" style="gap:14px;margin-top:12px;align-items:flex-start">
      <img src="${media(source)}" style="width:150px;border-radius:10px">
      <div class="stack" style="flex:1">
        <label class="field"><span>Motion</span><textarea class="input" id="v-motion" rows="4" placeholder="e.g. she slowly turns around, looks back over her shoulder at the camera and smiles, hair moving, handheld phone camera"></textarea></label>
        <div class="row">
          <label class="field"><span>Duration</span><select class="input" id="v-sec">${meta.durations.map((d) => `<option value="${d}">${d} s</option>`).join('')}</select></label>
          <label class="field"><span>Quality</span><select class="input" id="v-res"><option>480p</option><option>580p</option><option selected>720p</option></select></label>
        </div>
      </div>
    </div>
    <details class="adjust"><summary class="dim">Motion LoRAs (optional, advanced)</summary>
      <div class="dim" style="font-size:12px;margin:6px 0">Direct URL of a Wan 2.2 .safetensors file (Hugging Face or Civitai). Up to 3.</div>
      ${[0, 1, 2].map(() => `<div class="row" style="margin-top:6px"><input class="input" data-lora-url style="flex:1" placeholder="https://…/lora.safetensors"><input class="input" data-lora-scale type="number" step="0.1" value="1" style="width:80px"></div>`).join('')}
    </details>
    <div class="row between" style="margin-top:14px"><span class="dim" id="v-cost"></span><button class="btn primary" id="v-go">${icon('play-circle')}Animate</button></div>
  </div>`);
  const cost = () => { h.$('#v-cost').textContent = `≈ ${usd(Number(h.$('#v-sec').value) * (meta.price.videoPerSec[h.$('#v-res').value] || 0.08))}`; };
  h.$('#v-sec').onchange = cost; h.$('#v-res').onchange = cost; cost();
  h.$('#v-go').onclick = async () => {
    const go = h.$('#v-go');
    const urls = h.$$('[data-lora-url]'); const scales = h.$$('[data-lora-scale]');
    const loras = urls.map((u, i) => ({ url: u.value.trim(), scale: scales[i].value })).filter((l) => l.url);
    go.disabled = true; // no double submits
    try {
      await h.api('/api/spicy/videos', { method: 'POST', body: { modelId: m.id, source, motion: h.$('#v-motion').value, seconds: h.$('#v-sec').value, resolution: h.$('#v-res').value, loras } });
      h.closeModal(); h.toast('Video queued on fal.ai'); loadJobs(m.id);
    } catch (e) { h.toast(e.message, true); go.disabled = false; }
  };
}

async function loadJobs(modelId) {
  clearTimeout(st.poll);
  const box = h.$('#spicy-jobs');
  if (!box) return;
  let rows;
  try { rows = await h.api(`/api/spicy/jobs?model=${modelId}`); }
  catch {
    // Server briefly unavailable (e.g. restarting): try again quietly instead of stopping the updates.
    if (on() && box.isConnected) st.poll = setTimeout(() => loadJobs(modelId), 5000);
    return;
  }
  if (!on() || !box.isConnected) return;
  box.innerHTML = rows.length ? rows.map(jobCard).join('') : '<div class="dim" style="font-size:13px">Nothing generated yet.</div>';
  const m = { id: modelId };
  h.$$('.sjob', box).forEach((el) => {
    const id = Number(el.dataset.id);
    h.$$('[data-zoom]', el).forEach((img) => (img.onclick = () => h.showModal(`<div class="modal-box small" style="max-width:640px;padding:0;background:black"><img src="${img.dataset.zoom}" style="width:100%;display:block" data-close></div>`)));
    h.$$('[data-act]', el).forEach((b) => (b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'animate') return animateDialog(m, b.dataset.p);
      if (act === 'inpaint') return inpaintDialog(m, b.dataset.p);
      if (act === 'detail') {
        if (!confirm(`Refine the details of this image with ${rhName('detailing')}? It runs on RunningHub (GPU time).`)) return;
        b.disabled = true;
        try {
          await h.api('/api/spicy/tools', { method: 'POST', body: { tool: 'detailing', modelId, source: b.dataset.p } });
          h.toast('Queued on RunningHub');
        } catch (e) { h.toast(e.message, true); }
        loadJobs(modelId);
        return;
      }
      if (act === 'base') {
        st.source = b.dataset.p;
        h.toast('Base photo chosen');
        const row = h.$('#s-src-row');
        if (row && st.model?.id === modelId) { bindSource(st.model); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        else renderSpicy(new URLSearchParams(`model=${modelId}`));
        return;
      }
      if (act === 'delete' && !confirm('Delete this result?')) return;
      b.disabled = true; // no double submits (a second "Gerar de novo" would pay twice)
      try {
        if (act === 'retry') await h.api(`/api/spicy/jobs/${id}/retry`, { method: 'POST' });
        if (act === 'approve') await h.api(`/api/spicy/jobs/${id}/stage`, { method: 'POST', body: { stage: 'approved' } });
        if (act === 'cancel') await h.api(`/api/spicy/jobs/${id}/stage`, { method: 'POST', body: { stage: 'cancelled' } });
        if (act === 'delete') await h.api(`/api/spicy/jobs/${id}`, { method: 'DELETE' });
      } catch (e) { h.toast(e.message, true); }
      loadJobs(modelId);
    }));
  });
  if (rows.some((r) => ['queued', 'running'].includes(r.stage))) st.poll = setTimeout(() => loadJobs(modelId), 3000);
}

function jobCard(j) {
  const running = ['queued', 'running'].includes(j.stage);
  const tone = { review: 'act', approved: 'ok', failed: 'bad', cancelled: 'off' }[j.stage] || 'run';
  const stageLabel = { queued: 'Queued', running: 'Generating', review: 'Review', approved: 'Approved', failed: 'Failed', cancelled: 'Canceled' }[j.stage] || j.stage;
  const sc = meta.scenes.find((s) => s.key === j.config.scene);
  const lv = meta.levels.find((l) => l.key === j.config.level);
  const eng = j.config.engine;
  const ic = j.kind === 'video' ? 'video' : eng === 'detailing' ? 'wand' : eng === 'inpaint' ? 'brush' : (SCENE_ICONS[j.config.scene] || 'image');
  const title = j.kind === 'video'
    ? `Video ${j.config.seconds} s ${j.config.resolution}`
    : eng === 'detailing' ? 'Refine details'
      : eng === 'inpaint' ? `Fix area: ${j.config.text || ''}`
        : `${sc?.label || 'Photo'}${lv ? ` · ${lv.label}` : ''}${j.config.source ? ' · from a photo' : ''}${eng ? ` · ${rhName(eng)}` : ''}`;
  const where = eng ? 'RunningHub' : `≈ ${usd(j.cost_usd || 0)}`;
  const tools = rhTools();
  const name = (j.model_name || 'model').toLowerCase();
  return `<article class="card sjob" data-id="${j.id}">
    <div class="row between">
      <div class="row" style="gap:8px"><span class="stage ${tone}">${stageLabel}</span>${icon(ic, { cls: 'muted' })}<b>${h.esc(title)}</b>
        <span class="dim" style="font-size:12px">#${j.id} · ${h.dateTime(j.created_at)} · ${where}</span></div>
      <div class="row">${running ? '<button class="btn sm ghost danger" data-act="cancel">Cancel</button>'
        : `<button class="btn sm" data-act="retry">${icon('refresh')}Generate again</button>${j.stage === 'review' ? `<button class="btn sm primary" data-act="approve">${icon('check')}Approve</button>` : ''}`}<button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button></div>
    </div>
    ${running ? `<div class="gen-running"><div class="spinner"></div><div><b>${h.esc(stripEmoji(j.step_status || 'Preparing…'))}</b></div></div>` : ''}
    ${j.error ? `<div class="err-box">${icon('x-circle')}${h.esc(stripEmoji(j.error))}</div>` : ''}
    ${j.outputs.length ? `<div class="photo-grid">${j.outputs.map((o, i) => o.type === 'video'
      ? `<div class="pg"><video src="${media(o.path)}" controls loop playsinline poster="${o.poster ? media(o.poster) : ''}"></video>
          <div class="pg-actions"><a class="btn sm icon-only" href="${media(o.path)}" download="${h.esc(name)}_spicy_${j.id}.mp4" title="Download" aria-label="Download">${icon('download')}</a></div></div>`
      : `<div class="pg"><img src="${media(o.path)}" data-zoom="${media(o.path)}" loading="lazy">
          <div class="pg-actions"><a class="btn sm icon-only" href="${media(o.path)}" download="${h.esc(name)}_spicy_${j.id}_${i + 1}.png" title="Download" aria-label="Download">${icon('download')}</a>
          <button class="btn sm icon-only" data-act="animate" data-p="${h.esc(o.path)}" title="Animate into a video" aria-label="Animate into a video">${icon('film')}</button>
          <button class="btn sm icon-only" data-act="base" data-p="${h.esc(o.path)}" title="Use as base photo" aria-label="Use as base photo">${icon('rotate-ccw')}</button>
          ${tools.some((t) => t.key === 'detailing') ? `<button class="btn sm icon-only" data-act="detail" data-p="${h.esc(o.path)}" title="Refine details" aria-label="Refine details">${icon('wand')}</button>` : ''}
          ${tools.some((t) => t.key === 'inpaint') ? `<button class="btn sm icon-only" data-act="inpaint" data-p="${h.esc(o.path)}" title="Fix an area" aria-label="Fix an area">${icon('brush')}</button>` : ''}</div></div>`).join('')}</div>` : ''}
  </article>`;
}
