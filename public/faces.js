// Gerador de caras: a new AI model in four phases — new faces, refine a winner, edit, create the model.
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, toast, showModal, closeModal, state, loadShared }
export function init(helpers) { h = helpers; }

const on = () => /^#\/faces(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const PHASES = [[1, 'New faces'], [2, 'Refine'], [3, 'Edit'], [4, 'Create model']];
const FILTERS = [['', 'All'], ['none', 'Undecided'], ['win', 'Winners'], ['loser', 'Losers']];
const VERDICT = { winner: 'Winner', super: 'Super', loser: 'Loser' };
const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const st = { phase: 1, filter: '', refs: [], src: { 2: null, 3: null, 4: null }, data: null, prompts: [], seq: 0, timer: null, form: {} };

const priceOne = (engine, res, nb) => (engine === 'wan' ? 0.03 : engine === 'seedream' ? 0.045 : engine === 'flux' ? 0.045 : /lite/i.test(nb || '') ? 0.0408 : res === '2K' ? 0.1217 : 0.0835);

// Ready prompt per phase (the reference starts every phase with one). "Repor o padrão" goes back to it; the last one
// written is remembered on this computer.
const DEFAULT_PROMPT = {
  1: 'A new fictional adult woman (clearly over 21) with a natural, girl-next-door face. Amateur iPhone selfie from the chest up, natural window light, relaxed soft smile, plain wall behind her.',
  2: 'Refer to the model: the same woman standing in her bedroom, close to the camera, casual top, soft natural light, amateur iPhone photo. Keep her face exactly the same.',
  3: 'Refer to the model: turn this into a clean reference photo of her. Same face, hair, body and outfit; plain light background, soft even light, sharp focus on her face. Do not change anything else.',
};
const BUSTS = [
  { label: 'Bust 4× bigger', text: 'refer to the model, make her boobs four times bigger, do not change anything else' }, // the reference's prompt
  { label: 'Bigger bust (natural)', text:'Refer to the model: make her breasts noticeably larger and fuller, with a natural shape. Same clothing and neckline, same face, hair, pose, background and light. Do not change anything else.' },
];
const LS_KEY = 'facesPrompts';
try { Object.assign(st.form, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch {}
const remember = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(st.form)); } catch {} };

export async function renderFaces(params) {
  const seq = ++st.seq;
  clearTimeout(st.timer);
  if (params.get('phase')) st.phase = Math.max(1, Math.min(4, Number(params.get('phase')) || 1));
  h.$('#view').innerHTML = `
    <h2>Face generator</h2>
    <p class="sub">A new model in four phases: <b>new faces</b> (with or without reference faces), <b>refine</b> the winner, <b>edit</b> the details and <b>create the model</b> from the best one. Mark each image as a winner, super or loser, also one at a time with the keyboard.</p>
    <div class="seg fc-phases" id="fc-phases">${PHASES.map(([n, l]) => `<button data-p="${n}" class="${st.phase === n ? 'active' : ''}"><b>${n}</b> ${l}</button>`).join('')}</div>
    <div id="fc-panel" class="card fc-panel"><div class="page-loading" style="min-height:120px"><div class="spinner"></div></div></div>
    <div id="fc-jobs"></div>
    <div class="card">
      <div class="row between"><h3 style="margin:0" id="fc-gen-title">Generations</h3>
        <div class="row">
          <div class="seg" id="fc-filter">${FILTERS.map(([v, l]) => `<button data-f="${v}" class="${st.filter === v ? 'active' : ''}">${l}</button>`).join('')}</div>
          <button class="btn sm" id="fc-swipe" title="One at a time: ← loser, → winner, ↑ super, space skips">${icon('eye')}Choose one by one</button>
        </div></div>
      <div class="fc-grid" id="fc-grid"></div>
    </div>`;
  h.$$('#fc-phases button').forEach((b) => (b.onclick = () => { st.phase = Number(b.dataset.p); history.replaceState(null, '', `#/faces?phase=${st.phase}`); renderFaces(new URLSearchParams()); }));
  h.$$('#fc-filter button').forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; h.$$('#fc-filter button').forEach((x) => x.classList.toggle('active', x === b)); paintGrid(); }));
  h.$('#fc-swipe').onclick = openSwipe;
  try {
    const [d, prompts] = await Promise.all([h.api('/api/faces'), h.api('/api/faces/prompts')]);
    if (!on() || seq !== st.seq) return;
    st.data = d;
    st.prompts = prompts;
  } catch (e) {
    if (on() && seq === st.seq) h.$('#fc-panel').innerHTML = `<span class="msg bad">${h.esc(stripEmoji(e.message))}</span>`;
    return;
  }
  paintPanel();
  paintJobs();
  paintGrid();
  poll(seq);
}

async function refresh() {
  try { st.data = await h.api('/api/faces'); } catch { return; }
  if (!on()) return;
  paintJobs();
  paintGrid();
}

function poll(seq) {
  clearTimeout(st.timer);
  const busy = st.data?.jobs?.some((j) => ['queued', 'running'].includes(j.stage));
  st.timer = setTimeout(async () => {
    if (!on() || seq !== st.seq) return;
    await refresh();
    poll(seq);
  }, busy ? 3000 : 15000);
}

// ---- the form of each phase --------------------------------------------------------------------------------------
const facesOf = (phase) => (st.data?.faces || []).filter((f) => f.phase === phase);
const findFace = (id) => (st.data?.faces || []).find((f) => f.id === id);

function promptBox(phase, placeholder) {
  const saved = st.prompts.filter((p) => p.phase === phase);
  // A div, not a label: clicking the word Prompt must not press the buttons next to it.
  return `<div class="field"><span class="row between" style="width:100%"><label for="fc-prompt">Prompt</label>
      <span class="row" style="gap:6px">${saved.length ? `<select class="input fc-saved" id="fc-saved" aria-label="Saved prompts"><option value="">Saved prompts (${saved.length})</option>${saved.map((p) => `<option value="${p.id}">${h.esc(p.text.slice(0, 70))}</option>`).join('')}</select>` : ''}
        <button type="button" class="btn sm ghost" id="fc-save-prompt" title="Save this prompt to use it again">${icon('star')}Save prompt</button></span></span>
    <textarea class="input" id="fc-prompt" rows="4" placeholder="${h.esc(placeholder)}">${h.esc(st.form[phase] ?? DEFAULT_PROMPT[phase] ?? '')}</textarea></div>
    <span class="fc-pdef"><span class="ed-tag" id="fc-ptag"></span><button type="button" class="link-btn" id="fc-preset-reset">Reset to default</button>${phase === 3 ? BUSTS.map((b, i) => `<button type="button" class="chip" data-bust="${i}">${icon('wand')}${b.label}</button>`).join('') : ''}</span>`;
}

function sourceBox(phase, hint) {
  const f = st.src[phase] ? findFace(st.src[phase]) : null;
  return `<div class="fc-src" id="fc-src" role="button" tabindex="0" title="${h.esc(hint)}">
    ${f ? `<img src="${media(f.path)}" alt=""><span class="fc-src-tag">#${f.id}${f.verdict ? ` · ${VERDICT[f.verdict]}` : ''}</span>` : `<div class="fc-src-empty">${icon('plus')}<small>${h.esc(hint)}</small></div>`}
  </div>`;
}

function paintPanel() {
  const box = h.$('#fc-panel');
  if (!box) return;
  const p = st.phase;
  const d = st.data;
  const nbName = d?.nbModel || 'Nano Banana';
  h.$('#fc-gen-title').textContent = p === 4 ? 'Super winners (all phases)' : `Phase ${p} generations`;
  if (p === 1) {
    box.innerHTML = `
      <div class="row between"><h3 style="margin:0">${icon('plus-square')}New faces</h3><span class="dim" style="font-size:12px">${h.esc(nbName)}</span></div>
      <div class="fc-drop" id="fc-drop" tabindex="0" role="button" title="Drag face photos here or click to choose">
        ${st.refs.length ? `<div class="fc-refs">${st.refs.map((r, i) => `<div class="fc-ref"><img src="${r}" alt=""><span class="fc-ref-n">@image${i + 1}</span><button class="icon-btn" data-rm-ref="${i}" title="Remove this reference" aria-label="Remove this reference">${icon('x')}</button></div>`).join('')}${st.refs.length < 8 ? `<div class="fc-ref add">${icon('plus')}</div>` : ''}</div>`
          : `<div class="fc-drop-empty">${icon('upload', { size: 22 })}<b>Drag reference faces here</b><small>or click to choose · optional · up to 8 · in the prompt they are @image1, @image2…</small></div>`}
        <input type="file" id="fc-files" accept="image/*" multiple hidden>
      </div>
      ${promptBox(1, 'e.g. use 50% of the facial features of @image1 and 50% of @image2; amateur phone selfie from the chest up, natural light')}
      <div class="fc-opts">
        <label class="field"><span>Quantity</span><select class="input" id="fc-n">${[1, 2, 3, 4, 6, 8].map((n) => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>Format</span><select class="input" id="fc-aspect">${['9:16', '4:5', '3:4', '1:1', '2:3', '16:9'].map((a) => `<option ${a === '9:16' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <label class="field"><span>Resolution</span><select class="input" id="fc-res"><option>1K</option><option>2K</option></select></label>
        <span class="grow"></span>
        <span class="dim fc-cost" id="fc-cost"></span>
        <button class="btn primary" id="fc-go">${icon('play-circle')}Generate</button>
      </div>`;
    bindDrop();
  } else if (p === 2 || p === 3) {
    const hint = p === 2 ? 'Choose a winner from phase 1' : 'Choose an image from phase 2';
    box.innerHTML = `
      <div class="row between"><h3 style="margin:0">${icon(p === 2 ? 'refresh' : 'edit')}${p === 2 ? 'Refine a winner' : 'Edit'}</h3>
        <span class="dim" style="font-size:12px">${p === 2 ? 'the winner is redone with your prompt (scene, framing, light)' : 'the image is edited with your prompt (outfit, hair, details)'}</span></div>
      <div class="fc-two">
        ${sourceBox(p, hint)}
        <div class="stack" style="gap:10px;flex:1;min-width:0">
          ${promptBox(p, p === 2 ? 'e.g. the same woman in her bedroom, no windows behind her, hands behind her back, very close to the camera, soft light' : 'e.g. gray t-shirt, hair tied up, same face and same light')}
          <div class="fc-opts">
            <label class="field"><span>Quantity</span><select class="input" id="fc-n">${[1, 2, 3, 4, 6, 8].map((n) => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
            ${p === 2 ? `<label class="field"><span>Format</span><select class="input" id="fc-aspect">${d.aspects.map((a) => `<option value="${a}" ${a === 'auto' ? 'selected' : ''}>${a === 'auto' ? 'Same as the image' : a}</option>`).join('')}</select></label>
              <label class="field"><span>Resolution</span><select class="input" id="fc-res"><option>1K</option><option>2K</option></select></label>`
              : `<label class="field"><span>Engine</span><select class="input" id="fc-engine">${Object.entries(d.engines).map(([k, l]) => `<option value="${k}">${h.esc(l)}</option>`).join('')}</select></label>`}
            <span class="grow"></span>
            <span class="dim fc-cost" id="fc-cost"></span>
            <button class="btn primary" id="fc-go">${icon('play-circle')}Generate</button>
          </div>
        </div>
      </div>`;
  } else {
    const models = h.state.models || [];
    box.innerHTML = `
      <div class="row between"><h3 style="margin:0">${icon('user-plus')}Create the model</h3><span class="dim" style="font-size:12px">the best image becomes the front photo of a new model</span></div>
      <div class="fc-two">
        ${sourceBox(4, 'Choose a super winner')}
        <div class="stack" style="gap:10px;flex:1;min-width:0">
          <label class="field"><span>Model name</span><input class="input" id="fc-name" maxlength="40" placeholder="e.g. Lana"></label>
          <label class="field"><span>Copy settings from</span><select class="input" id="fc-clone"><option value="">None (start from scratch)</option>${models.map((m) => `<option value="${m.id}">${h.esc(m.name)}</option>`).join('')}</select>
            <small>The persona, body, rules (no tattoos, etc.) and captions are copied from the chosen model. Then complete her folder in Models with “Generate missing angles”.</small></label>
          <div class="row" style="justify-content:flex-end"><button class="btn primary" id="fc-create">${icon('user-plus')}Create model</button></div>
        </div>
      </div>`;
  }
  bindPanel();
}

function bindPanel() {
  const p = st.phase;
  const prompt = h.$('#fc-prompt');
  const ptag = h.$('#fc-ptag');
  const markDefault = () => {
    if (!prompt || !ptag) return;
    const same = prompt.value.trim() === (DEFAULT_PROMPT[p] || '').trim();
    ptag.textContent = same ? 'default' : 'edited';
    h.$('#fc-preset-reset').hidden = same;
  };
  if (prompt) prompt.oninput = () => { st.form[p] = prompt.value; remember(); markDefault(); };
  const reset = h.$('#fc-preset-reset');
  if (reset) reset.onclick = () => { prompt.value = DEFAULT_PROMPT[p] || ''; st.form[p] = prompt.value; remember(); markDefault(); };
  h.$$('[data-bust]').forEach((bt) => (bt.onclick = () => { prompt.value = BUSTS[Number(bt.dataset.bust)].text; st.form[p] = prompt.value; remember(); markDefault(); }));
  // The enlargement runs on Seedream 5.0 unless you picked another editor on this computer.
  const engSel = h.$('#fc-engine');
  if (engSel) {
    let saved = null;
    try { saved = localStorage.getItem(`facesEngine${p}`); } catch {}
    const want = saved || (p === 3 ? 'seedream' : '');
    if (want && [...engSel.options].some((o) => o.value === want)) engSel.value = want;
    engSel.addEventListener('change', () => { try { localStorage.setItem(`facesEngine${p}`, engSel.value); } catch {} });
  }
  markDefault();
  const saved = h.$('#fc-saved');
  if (saved) saved.onchange = () => { const x = st.prompts.find((q) => q.id === Number(saved.value)); if (x) { prompt.value = x.text; st.form[p] = x.text; remember(); markDefault(); } saved.value = ''; };
  const save = h.$('#fc-save-prompt');
  if (save) {
    save.onclick = async () => {
      if (!prompt.value.trim()) return h.toast('Write the prompt first', true);
      try {
        const r = await h.api('/api/faces/prompts', { method: 'POST', body: { phase: p, text: prompt.value } });
        if (!r.existed) st.prompts.unshift(r);
        h.toast(r.existed ? 'This prompt was already saved' : 'Prompt saved');
        if (!r.existed) paintPanel();
      } catch (e) { h.toast(e.message, true); }
    };
  }
  const src = h.$('#fc-src');
  if (src) {
    const pick = () => openPicker(p);
    src.onclick = pick;
    src.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  }
  const cost = () => {
    const el = h.$('#fc-cost');
    if (!el) return;
    const n = Number(h.$('#fc-n')?.value || 1);
    const engine = h.$('#fc-engine')?.value || 'nano';
    el.textContent = `~${usd(n * priceOne(engine, h.$('#fc-res')?.value || '1K', st.data?.nbModel))}`;
  };
  h.$$('#fc-n, #fc-res, #fc-engine').forEach((x) => (x.onchange = cost));
  cost();
  const go = h.$('#fc-go');
  if (go) {
    go.onclick = async () => {
      if (!prompt.value.trim()) return h.toast('Write the prompt', true);
      if (p > 1 && !st.src[p]) return h.toast(p === 2 ? 'Choose the starting winner' : 'Choose the starting image', true);
      go.disabled = true;
      try {
        await h.api('/api/faces/jobs', {
          method: 'POST',
          body: {
            phase: p, prompt: prompt.value, n: Number(h.$('#fc-n').value), aspect: h.$('#fc-aspect')?.value, resolution: h.$('#fc-res')?.value,
            engine: h.$('#fc-engine')?.value, refs: p === 1 ? st.refs : undefined, sourceId: p > 1 ? st.src[p] : undefined,
          },
        });
        h.toast('Generating: the images will appear below');
        await refresh();
        poll(st.seq);
      } catch (e) { h.toast(e.message, true); }
      go.disabled = false;
    };
  }
  const create = h.$('#fc-create');
  if (create) {
    create.onclick = async () => {
      const name = h.$('#fc-name').value.trim();
      if (!st.src[4]) return h.toast('Choose the super winner', true);
      if (!name) return h.toast('Enter the model name', true);
      create.disabled = true;
      try {
        const r = await h.api(`/api/faces/${st.src[4]}/create-model`, { method: 'POST', body: { name, cloneFrom: Number(h.$('#fc-clone').value) || null } });
        await h.loadShared?.();
        h.toast(`Model ${r.model.name} created${r.captions ? ` with ${r.captions} caption(s)` : ''}. Complete her folder in Models`);
        location.hash = '#/models';
      } catch (e) { h.toast(e.message, true); create.disabled = false; }
    };
  }
}

function bindDrop() {
  const drop = h.$('#fc-drop');
  const files = h.$('#fc-files');
  const add = async (list) => {
    const imgs = [...list].filter((f) => f.type.startsWith('image/')).slice(0, 8 - st.refs.length);
    for (const f of imgs) {
      try { st.refs.push(await toDataUrl(f)); } catch { h.toast(`Could not read ${f.name}`, true); }
    }
    const keep = h.$('#fc-prompt')?.value;
    if (keep !== undefined) st.form[1] = keep;
    paintPanel();
  };
  drop.onclick = (e) => { if (!e.target.closest('[data-rm-ref]')) files.click(); };
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); files.click(); } };
  files.onchange = () => add(files.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); add(e.dataTransfer.files); };
  h.$$('[data-rm-ref]', drop).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); st.refs.splice(Number(b.dataset.rmRef), 1); paintPanel(); }));
}

function toDataUrl(file, max = 1600) {
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
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---- jobs and the grid -------------------------------------------------------------------------------------------
function paintJobs() {
  const box = h.$('#fc-jobs');
  if (!box) return;
  const jobs = (st.data?.jobs || []).filter((j) => j.phase === st.phase || st.phase === 4);
  box.innerHTML = jobs.map((j) => `
    <div class="gen-running fc-job">${['queued', 'running'].includes(j.stage) ? '<div class="spinner"></div>' : icon('x-circle', { cls: 'bad' })}
      <div><b>Phase ${j.phase} · ${j.n} image(s)</b> <span class="dim">· ${h.esc(stripEmoji(j.stage === 'failed' ? (j.error || 'Failed') : j.step_status || 'Queued'))}</span>
        <div class="dim" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h.esc(j.prompt.slice(0, 140))}</div></div>
      ${['queued', 'running'].includes(j.stage) ? `<button class="btn sm ghost danger" data-cancel="${j.id}">Cancel</button>` : ''}
    </div>`).join('');
  h.$$('[data-cancel]', box).forEach((b) => (b.onclick = async () => { try { await h.api(`/api/faces/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); refresh(); } catch (e) { h.toast(e.message, true); } }));
}

function visible() {
  const all = st.data?.faces || [];
  let list = st.phase === 4 ? all.filter((f) => f.verdict === 'super') : all.filter((f) => f.phase === st.phase);
  if (st.filter === 'none') list = list.filter((f) => !f.verdict);
  else if (st.filter === 'win') list = list.filter((f) => f.verdict === 'winner' || f.verdict === 'super');
  else if (st.filter === 'loser') list = list.filter((f) => f.verdict === 'loser');
  return list;
}

function paintGrid() {
  const grid = h.$('#fc-grid');
  if (!grid) return;
  const list = visible();
  if (!list.length) {
    grid.innerHTML = `<div class="dim" style="font-size:13px;padding:12px 0">${st.phase === 4 ? 'Mark an image as super (star) to use it here.' : 'No images in this phase yet.'}</div>`;
    return;
  }
  grid.innerHTML = list.map(cardHtml).join('');
  h.$$('.fc-card', grid).forEach(bindCard);
}

function cardHtml(f) {
  const next = f.phase < 3 ? f.phase + 1 : 4;
  return `<div class="fc-card ${f.verdict || ''}" data-id="${f.id}">
    <img src="${media(f.path)}" alt="" loading="lazy" data-zoom>
    <span class="fc-tag">${f.phase === 1 ? `${f.refs_count} ref` : `phase ${f.phase}`}${f.model_id ? ' · model' : ''}</span>
    <div class="fc-verdicts">
      <button class="fc-v ${f.verdict === 'winner' ? 'on' : ''}" data-v="winner" title="Winner" aria-label="Winner">${icon('check')}</button>
      <button class="fc-v ${f.verdict === 'super' ? 'on' : ''}" data-v="super" title="Super winner" aria-label="Super winner">${icon(f.verdict === 'super' ? 'star-filled' : 'star')}</button>
      <button class="fc-v ${f.verdict === 'loser' ? 'on' : ''}" data-v="loser" title="Loser" aria-label="Loser">${icon('x')}</button>
    </div>
    <div class="fc-actions">
      <button class="btn sm" data-next title="Use this image in phase ${next}">${icon('arrow-right')}Phase ${next}</button>
      <button class="icon-btn" data-del title="Delete" aria-label="Delete">${icon('trash')}</button>
    </div>
    ${f.prompt ? `<div class="fc-prompt" title="${h.esc(f.prompt)}">${h.esc(f.prompt)}</div>` : ''}
  </div>`;
}

async function setVerdict(f, v) {
  const verdict = f.verdict === v ? null : v;
  await h.api(`/api/faces/${f.id}/verdict`, { method: 'POST', body: { verdict } });
  f.verdict = verdict;
}

function bindCard(card) {
  const f = findFace(Number(card.dataset.id));
  if (!f) return;
  h.$$('[data-v]', card).forEach((b) => (b.onclick = async () => {
    try { await setVerdict(f, b.dataset.v); paintGrid(); } catch (e) { h.toast(e.message, true); }
  }));
  h.$('[data-zoom]', card).onclick = () => h.showModal(`<div class="modal-box small" style="max-width:560px;padding:0;background:black"><img src="${media(f.path)}" style="width:100%;display:block" data-close alt=""></div>`);
  h.$('[data-next]', card).onclick = () => {
    const next = f.phase < 3 ? f.phase + 1 : 4;
    st.src[next] = f.id;
    if (next === 4 && f.verdict !== 'super') setVerdict(f, 'super').catch(() => {});
    st.phase = next;
    history.replaceState(null, '', `#/faces?phase=${next}`);
    renderFaces(new URLSearchParams());
  };
  h.$('[data-del]', card).onclick = async () => {
    if (!confirm('Delete this image?')) return;
    try { await h.api(`/api/faces/${f.id}`, { method: 'DELETE' }); st.data.faces = st.data.faces.filter((x) => x.id !== f.id); paintGrid(); } catch (e) { h.toast(e.message, true); }
  };
}

// Choosing the starting image of a phase.
function openPicker(phase) {
  const all = st.data?.faces || [];
  const list = phase === 2 ? all.filter((f) => f.phase === 1 && f.verdict !== 'loser').sort((a, b) => rank(b) - rank(a))
    : phase === 3 ? all.filter((f) => f.phase === 2 && f.verdict !== 'loser').sort((a, b) => rank(b) - rank(a))
    : all.filter((f) => f.verdict === 'super' || f.verdict === 'winner').sort((a, b) => rank(b) - rank(a) || b.phase - a.phase);
  h.showModal(`<div class="modal-box fc-pick">
    <div class="row between"><h3 style="margin:0">${phase === 2 ? 'Starting winner (phase 1)' : phase === 3 ? 'Starting image (phase 2)' : 'Super winner'}</h3><button class="btn sm ghost" data-close>Close</button></div>
    ${list.length ? `<div class="fc-pick-grid">${list.map((f) => `<button class="fc-pick-item ${f.verdict || ''}" data-pick="${f.id}"><img src="${media(f.path)}" alt=""><span>${f.verdict ? VERDICT[f.verdict] : `#${f.id}`}</span></button>`).join('')}</div>`
      : `<p class="dim">${phase === 2 ? 'No phase 1 faces yet.' : phase === 3 ? 'No phase 2 images yet.' : 'First mark an image as a winner or super.'}</p>`}
  </div>`);
  h.$$('[data-pick]').forEach((b) => (b.onclick = () => { st.src[phase] = Number(b.dataset.pick); h.closeModal(); const keep = h.$('#fc-prompt')?.value; if (keep !== undefined) st.form[phase] = keep; paintPanel(); }));
}
const rank = (f) => ({ super: 3, winner: 2 }[f.verdict] || (f.verdict ? 0 : 1));

// One at a time: ← perdedora, → vencedora, ↑ super, espaço salta.
function openSwipe() {
  const queue = visible().filter((f) => !f.verdict);
  if (!queue.length) return h.toast('No undecided images in this phase');
  let i = 0;
  const done = []; // { f, prev }: every step, skips included, so Z always goes back one
  const show = () => {
    const f = queue[i];
    if (!f) { h.closeModal(); paintGrid(); return h.toast('All decided'); }
    h.showModal(`<div class="modal-box fc-swipe">
      <div class="row between"><b>${i + 1} / ${queue.length}</b><span class="row" style="gap:6px"><button class="btn sm ghost" id="fc-sw-undo" ${done.length ? '' : 'disabled'}>${icon('rotate-ccw')}Undo<kbd>Z</kbd></button><button class="btn sm ghost" data-close>Close (Esc)</button></span></div>
      <img src="${media(f.path)}" alt="">
      ${f.prompt ? `<div class="fc-sw-prompt" title="${h.esc(f.prompt)}">${h.esc(f.prompt)}</div>` : ''}
      <div class="fc-swipe-acts">
        <button class="btn rv-push" data-s="loser">${icon('x')}Loser<kbd>←</kbd></button>
        <button class="btn" data-s="skip">Skip<kbd>Space</kbd></button>
        <button class="btn ap-trial" data-s="super">${icon('star')}Super<kbd>↑</kbd></button>
        <button class="btn rv-keep" data-s="winner">${icon('check')}Winner<kbd>→</kbd></button>
      </div></div>`);
    h.$$('[data-s]').forEach((btn) => (btn.onclick = () => act(btn.dataset.s)));
    h.$('#fc-sw-undo').onclick = undo;
  };
  let busy = false;
  const act = async (v) => {
    const f = queue[i];
    if (!f || busy) return;
    busy = true;
    try {
      if (v !== 'skip') {
        await h.api(`/api/faces/${f.id}/verdict`, { method: 'POST', body: { verdict: v } }); // set, not toggle
      }
      done.push({ f, prev: f.verdict ?? null, changed: v !== 'skip' });
      if (v !== 'skip') f.verdict = v;
      i++;
      show();
    } catch (e) { h.toast(e.message, true); } finally { busy = false; }
  };
  const undo = async () => {
    const last = done[done.length - 1];
    if (!last || busy) return;
    busy = true;
    try {
      if (last.changed) await h.api(`/api/faces/${last.f.id}/verdict`, { method: 'POST', body: { verdict: last.prev } });
      last.f.verdict = last.prev;
      done.pop();
      i = Math.max(0, i - 1);
      show();
    } catch (e) { h.toast(e.message, true); } finally { busy = false; }
  };
  const key = (e) => {
    if (h.$('#modal').classList.contains('hidden')) { window.removeEventListener('keydown', key, true); paintGrid(); return; }
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); e.stopPropagation(); undo(); return; }
    const m = { ArrowLeft: 'loser', ArrowRight: 'winner', ArrowUp: 'super', ' ': 'skip' }[e.key];
    if (m) { e.preventDefault(); e.stopPropagation(); act(m); }
  };
  window.addEventListener('keydown', key, true);
  show();
}
