// Perfis: per model, the accounts her posts go to, her caption pool (picked at random by weight) and her
// "Editar imagem · aumento" defaults (instruction, editor, variants, automatic before the video).
// Aprovação and the Calendário read them.
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, toast, showModal, closeModal }
export function init(helpers) { h = helpers; }

const on = () => /^#\/profiles(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const PF_SHORT = { instagram: 'IG', tiktok: 'TT', x: 'X', youtube: 'YT' };
const MAX_CAPTION = 2200;

export async function renderProfiles() {
  const d = await h.api('/api/profiles');
  if (!on()) return;
  allModels = d.models;
  h.$('#view').innerHTML = `
    <h2>Profiles</h2>
    <p class="sub">What changes from model to model when posting: the <b>accounts</b> her videos go out on and the <b>captions</b> the app picks at random for each post (higher-weight captions come up more often). Approval and Calendar use these profiles.</p>
    ${d.models.length ? d.models.map((m) => cardHtml(m, d.platforms, d.edit)).join('') : `<div class="empty">${icon('user', { size: 28 })}<h3>No models</h3><p>First create a model in <a href="#/models">Models</a>.</p></div>`}`;
  h.$$('.pf-card').forEach((card) => bindCard(card, d.models.find((m) => m.id === Number(card.dataset.id)), d.platforms, d.edit));
}

function cardHtml(m, platforms, edit) {
  return `
  <article class="card pf-card" data-id="${m.id}">
    <div class="pf-head">
      ${m.cover ? `<img class="pf-cover" src="${media(m.cover)}" alt="">` : `<span class="avatar-letter" style="--c:${h.esc(m.color || '#b15cff')}">${h.esc(m.name[0])}</span>`}
      <div><b class="pf-name">${h.esc(m.name)}</b><div class="dim" style="font-size:12px" data-counts>${counts(m)}</div></div>
    </div>
    <div class="pf-cols">
      <section class="stack" style="gap:10px">
        <div class="label">Posting accounts</div>
        <div class="pf-list" data-accounts>${m.accounts.length ? m.accounts.map(accountHtml).join('') : emptyAcc}</div>
        <form class="pf-add" data-add-account autocomplete="off">
          <select class="input" name="platform" aria-label="Platform">${Object.entries(platforms).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <input class="input" name="handle" placeholder="@account or profile link" aria-label="Account" spellcheck="false" required>
          <input class="input" name="label" placeholder="Label (optional)" aria-label="Label" maxlength="40">
          <label class="check pf-add-trial" title="Receives test reels (trial reels). Needs a professional account (creator or business) on Instagram."><input type="checkbox" name="trial" checked>Trial</label>
          <button class="btn sm primary">${icon('plus')}Add</button>
        </form>
      </section>
      <section class="stack" style="gap:10px">
        <div class="label">Captions <span class="dim">· one at random per post; higher weight = comes up more often</span></div>
        <div class="pf-list" data-captions>${m.captions.length ? m.captions.map(captionHtml).join('') : emptyCap(m)}</div>
        <form class="pf-add-cap" data-add-caption>
          <textarea class="input" name="text" rows="2" placeholder="e.g. rate me 1-10 #brunette #fy #beautiful" aria-label="New caption" maxlength="${MAX_CAPTION}" required></textarea>
          <div class="row between"><label class="pf-w">Weight <input class="input" type="number" name="weight" min="1" max="10" value="1" aria-label="Weight"></label><button class="btn sm primary">${icon('plus')}Add caption</button></div>
        </form>
      </section>
    </div>
    ${swapHtml(m)}
    ${editHtml(m, edit)}
  </article>`;
}

const usd = (n) => (n >= 0.995 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
/** Step 1 of her remakes: her ★ photo, her default image instructions, and (optional) her own swap prompt. */
function swapHtml(m) {
  const refs = m.refs || [];
  return `
    <section class="pf-gen" data-swap>
      <div class="label">Person swap (step 1) <span class="dim">· what goes into her image in every remake</span></div>
      <div class="pf-star"><span class="dim">Main photo (always goes first):</span>
        ${refs.map((r) => `<button type="button" class="pf-ref ${m.default_ref === r.path ? 'on' : ''}" data-star="${h.esc(r.path)}" title="${m.default_ref === r.path ? 'Main photo' : 'Use as main photo'}" aria-pressed="${m.default_ref === r.path}"><img src="${media(r.path)}" alt="">${m.default_ref === r.path ? `<span>${icon('star-filled')}</span>` : ''}</button>`).join('') || '<span class="dim">No photos: upload them in <a href="#/models">Models</a>.</span>'}
        ${m.default_ref ? '<button type="button" class="link-btn" data-star="">No main photo</button>' : ''}</div>
      <div class="pf-gen-grid">
        <label class="field"><span>Default image instructions</span>
          <textarea class="input" rows="2" maxlength="1500" data-image-extra placeholder="e.g. no hair clips, short natural nails">${h.esc(m.image_extra || '')}</textarea>
          <small>Added to the prompt in all her remakes (they do not replace it).</small></label>
        <label class="field"><span>Her swap prompt <span class="dim">(optional)</span></span>
          <textarea class="input" rows="4" maxlength="4000" data-swap-prompt placeholder="Empty = the app prompt">${h.esc(m.swap_prompt || '')}</textarea>
          <small>If you write here, it replaces the app prompt in her remakes. Mind the order: image 1 = the video frame; images 2 onwards = her photos (the main one first).</small></label>
      </div>
      <div class="row"><button type="button" class="btn sm" data-preview-prompt>${icon('eye')}View the image prompt</button></div>
    </section>`;
}

function bindSwap(card, m) {
  const sw = h.$('[data-swap]', card);
  if (!sw) return;
  const save = async (body, revert, msg) => {
    try {
      await h.api(`/api/models/${m.id}`, { method: 'PATCH', body });
      Object.assign(m, body);
      sw.classList.add('saved');
      setTimeout(() => sw.classList.remove('saved'), 900);
      if (msg) h.toast(msg);
      return true;
    } catch (e) { h.toast(e.message, true); revert?.(); return false; }
  };
  h.$$('[data-star]', sw).forEach((b) => (b.onclick = async () => {
    if (!(await save({ default_ref: b.dataset.star }, null, b.dataset.star ? 'Main photo chosen: it goes first in her remakes' : 'No main photo'))) return;
    sw.outerHTML = swapHtml(m); // redraw this section only, and bind it again
    bindSwap(card, m);
  }));
  const ex = h.$('[data-image-extra]', sw);
  ex.onchange = () => save({ image_extra: ex.value.trim() }, () => { ex.value = m.image_extra || ''; });
  const sp = h.$('[data-swap-prompt]', sw);
  sp.onchange = () => save({ swap_prompt: sp.value.trim() }, () => { sp.value = m.swap_prompt || ''; }, sp.value.trim() ? 'Her prompt replaces the app prompt in new remakes' : 'Back to the app prompt');
  h.$('[data-preview-prompt]', sw).onclick = async () => {
    try {
      const r = await h.api(`/api/models/${m.id}/prompt-preview`);
      h.showModal(`<div class="modal-box small" style="max-width:720px">
        <div class="row between"><h3 style="margin:0">Image prompt for ${h.esc(m.name)}</h3><button class="icon-btn" data-close title="Close" aria-label="Close">${icon('x')}</button></div>
        ${r.prompt ? `<p class="sub" style="margin:6px 0 10px">What a remake of hers sends today ${r.own ? '(her prompt, from Profiles)' : '(made by the app)'}: ${r.refLayout ? 'image 1 = her photo, image 2 = the video frame (as in the reference app, with Nano Banana Pro)' : `image 1 = the video frame, images 2 to ${r.images} = her photos`}. Nothing was generated.</p><pre class="out" style="white-space:pre-wrap;max-height:60vh;overflow:auto">${h.esc(r.prompt)}</pre>`
          : `<p class="sub">${r.reason === 'no-refs' ? 'She has no photos in Models yet.' : r.reason === 'workflow' ? 'The image is made by a RunningHub workflow: it does not use a text prompt.' : 'This type of remake does not use an image.'}</p>`}
      </div>`);
    } catch (e) { h.toast(e.message, true); }
  };
}

function editHtml(m, edit) {
  if (!edit) return '';
  return `
    <section class="pf-gen" data-edit>
      <div class="label">Enlargement (step 3) <span class="dim">· what step 3 of her projects uses by default, and the “Edit” option on images</span></div>
      <div class="pf-gen-grid">
        <label class="field"><span>Default instruction</span>
          <textarea class="input" rows="3" maxlength="1500" data-edit-prompt placeholder="${h.esc(edit.preset.text)}">${h.esc(m.edit_prompt || '')}</textarea>
          <small>Empty = “${h.esc(edit.preset.label)}” (${h.esc(edit.preset.text)}). In English or Portuguese.</small>
          ${(edit.presets || []).length ? `<div class="ed-presets">${edit.presets.map((p) => `<button type="button" class="chip" data-edit-preset="${h.esc(p.key)}">${icon('wand')}${h.esc(p.label)}</button>`).join('')}</div>` : ''}</label>
        <div class="pf-gen-side">
          <label class="field"><span>Engine</span><select class="input" data-edit-engine><option value="">Seedream 5.0 Pro (default)</option>${edit.engines.map((x) => `<option value="${h.esc(x.key)}" ${x.key === m.edit_engine ? 'selected' : ''}>${h.esc(x.label)} · ${usd(x.cost)}</option>`).join('')}</select></label>
          <label class="field"><span>Variants</span><select class="input" data-edit-n>${[1, 2, 3, 4].map((n) => `<option ${n === m.edit_n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
      </div>
      <label class="check pf-auto"><input type="checkbox" data-edit-auto ${m.edit_auto ? 'checked' : ''}> Automatic enlargement: in Automatic mode, the chosen image is edited this way before the video (extra cost per variant; if the editor refuses, the original is used). Note: the Wan 3.0 (Alibaba) video refuses images with more cleavage or a bigger bust more often.</label>
    </section>`;
}

const emptyAcc = '<div class="pf-empty">No accounts. Add her accounts so Approval knows where to post.</div>';
let allModels = []; // every model of the page (for "Copiar legendas de…")
const emptyCap = (m) => {
  const others = allModels.filter((x) => x.id !== m.id && x.captions.length);
  return `<div class="pf-empty">No captions. Without captions, the post has no text.${others.length ? `<div class="row" style="margin-top:8px;gap:6px" data-clone><select class="input sm" aria-label="Copy the captions of another model">${others.map((x) => `<option value="${x.id}">${h.esc(x.name)} (${x.captions.length})</option>`).join('')}</select><button type="button" class="btn sm">${icon('copy')}Copy captions</button></div>` : ''}</div>`;
};
const counts = (m) => `${m.accounts.filter((a) => a.active).length} active account(s) · ${m.captions.length} caption(s)`;

function accountHtml(a) {
  return `
    <div class="pf-acc ${a.active ? '' : 'off'}" data-acc="${a.id}">
      <span class="pf-plat ${a.platform}" title="${h.esc(a.platform)}">${PF_SHORT[a.platform]}</span>
      <div class="pf-acc-main"><b>@${h.esc(a.handle)}</b>${a.label ? `<span class="dim"> · ${h.esc(a.label)}</span>` : ''}</div>
      ${a.platform === 'instagram' ? `<label class="check" title="Receives the test reels (trial reels: shown first to people who do not follow the account)"><input type="checkbox" data-trial ${a.trial ? 'checked' : ''}>Trial</label>` : ''}
      <label class="check" title="Off: it stays saved but does not receive posts"><input type="checkbox" data-active ${a.active ? 'checked' : ''}>Active</label>
      <button class="icon-btn" data-del-acc title="Remove the account @${h.esc(a.handle)}" aria-label="Remove the account @${h.esc(a.handle)}">${icon('x')}</button>
    </div>`;
}

function captionHtml(c) {
  return `
    <div class="pf-cap" data-cap="${c.id}">
      <textarea class="input" rows="2" data-cap-text maxlength="${MAX_CAPTION}" aria-label="Caption">${h.esc(c.text)}</textarea>
      <div class="pf-cap-side">
        <label class="pf-w" title="Weight: the higher it is, the more often this caption comes up">Weight <input class="input" type="number" min="1" max="10" value="${c.weight}" data-cap-weight aria-label="Weight"></label>
        <span class="dim pf-len" data-len>${c.text.length}/${MAX_CAPTION}</span>
        <button class="icon-btn" data-del-cap title="Delete this caption" aria-label="Delete this caption">${icon('trash')}</button>
      </div>
    </div>`;
}

function bindCard(card, m, platforms, edit) {
  if (!m) return;
  bindSwap(card, m);
  // ---- Editar imagem · aumento ----
  const ed = h.$('[data-edit]', card);
  if (ed) {
    const save = async (body, revert) => {
      try {
        await h.api(`/api/models/${m.id}`, { method: 'PATCH', body });
        Object.assign(m, body);
        ed.classList.add('saved');
        setTimeout(() => ed.classList.remove('saved'), 900);
        return true;
      } catch (e) { h.toast(e.message, true); revert(); return false; }
    };
    const pr = h.$('[data-edit-prompt]', ed); const en = h.$('[data-edit-engine]', ed); const nn = h.$('[data-edit-n]', ed); const au = h.$('[data-edit-auto]', ed);
    pr.onchange = () => save({ edit_prompt: pr.value.trim() }, () => { pr.value = m.edit_prompt || ''; });
    en.onchange = () => save({ edit_engine: en.value }, () => { en.value = m.edit_engine || ''; });
    nn.onchange = () => save({ edit_n: Number(nn.value) }, () => { nn.value = String(m.edit_n); });
    au.onchange = () => save({ edit_auto: au.checked }, () => { au.checked = !!m.edit_auto; }).then((ok) => { if (ok) h.toast(au.checked ? `Automatic enlargement on for ${m.name}: applies to new projects` : 'Automatic enlargement off'); });
    // The ready prompts ("Peito 4× maior"…): one click makes it her default instruction.
    h.$$('[data-edit-preset]', ed).forEach((b) => (b.onclick = () => {
      const p = (edit?.presets || []).find((x) => x.key === b.dataset.editPreset);
      if (!p) return;
      pr.value = p.text;
      save({ edit_prompt: p.text }, () => { pr.value = m.edit_prompt || ''; }).then((ok) => { if (ok) h.toast(`Default instruction for ${m.name}: ${p.label}`); });
    }));
  }
  const refreshCounts = () => { const el = h.$('[data-counts]', card); if (el) el.textContent = counts(m); };

  // ---- accounts ----
  const accBox = h.$('[data-accounts]', card);
  const bindAcc = (row) => {
    const a = m.accounts.find((x) => x.id === Number(row.dataset.acc));
    if (!a) return;
    const patch = async (body, input) => {
      try {
        Object.assign(a, await h.api(`/api/accounts/${a.id}`, { method: 'PATCH', body }));
        row.classList.toggle('off', !a.active);
        refreshCounts();
      } catch (e) { h.toast(e.message, true); if (input) input.checked = !input.checked; }
    };
    const trial = h.$('[data-trial]', row);
    if (trial) trial.onchange = () => patch({ trial: trial.checked }, trial);
    const active = h.$('[data-active]', row);
    active.onchange = () => {
      // Switching off an account with posts on the agenda: ask whether they come off too.
      const drop = !active.checked && a.scheduled > 0 && confirm(`@${a.handle} has ${a.scheduled} scheduled post(s). Remove them from the schedule? (Videos left with none go back to Approval.) Cancel keeps them scheduled.`);
      patch({ active: active.checked, dropScheduled: drop }, active).then(() => { if (drop) h.toast(`${a.dropped || 0} post(s) removed from the schedule`); });
    };
    h.$('[data-del-acc]', row).onclick = async () => {
      if (!confirm(`Remove the ${platforms[a.platform]} account @${a.handle} from ${m.name}?${a.scheduled ? ` Its ${a.scheduled} scheduled post(s) come off the schedule.` : ''}`)) return;
      try {
        const r = await h.api(`/api/accounts/${a.id}`, { method: 'DELETE' });
        if (r.dropped) h.toast(`${r.dropped} post(s) removed from the schedule`);
        m.accounts = m.accounts.filter((x) => x.id !== a.id);
        row.remove();
        if (!m.accounts.length) accBox.innerHTML = emptyAcc;
        refreshCounts();
      } catch (e) { h.toast(e.message, true); }
    };
  };
  h.$$('[data-acc]', accBox).forEach(bindAcc);
  const accForm = h.$('[data-add-account]', card);
  const trialBox = h.$('.pf-add-trial', accForm); // trial reels exist on Instagram only
  accForm.platform.onchange = () => { trialBox.hidden = accForm.platform.value !== 'instagram'; };
  accForm.handle.oninput = () => { // a pasted link decides the platform
    const k = /(?:^|[/.])(instagram|tiktok|twitter|x|youtube)\.com\//i.exec(accForm.handle.value)?.[1]?.toLowerCase();
    if (k) { accForm.platform.value = k === 'twitter' ? 'x' : k; accForm.platform.onchange(); }
  };
  accForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(accForm));
    f.trial = accForm.trial.checked;
    const btn = h.$('button', accForm);
    btn.disabled = true;
    try {
      const a = await h.api(`/api/models/${m.id}/accounts`, { method: 'POST', body: f });
      m.accounts.push(a);
      if (!accBox.querySelector('[data-acc]')) accBox.innerHTML = '';
      accBox.insertAdjacentHTML('beforeend', accountHtml(a));
      bindAcc(accBox.lastElementChild);
      accForm.handle.value = '';
      accForm.label.value = '';
      refreshCounts();
      h.toast(`${platforms[a.platform]} account @${a.handle} added`);
    } catch (err) { h.toast(stripEmoji(err.message), true); }
    btn.disabled = false;
    accForm.handle.focus();
  };

  // ---- captions ----
  const capBox = h.$('[data-captions]', card);
  const bindCap = (row) => {
    const c = m.captions.find((x) => x.id === Number(row.dataset.cap));
    if (!c) return;
    const text = h.$('[data-cap-text]', row);
    const weight = h.$('[data-cap-weight]', row);
    const len = h.$('[data-len]', row);
    text.oninput = () => { len.textContent = `${text.value.length}/${MAX_CAPTION}`; };
    const save = async (body, revert) => {
      try {
        Object.assign(c, await h.api(`/api/captions/${c.id}`, { method: 'PATCH', body }));
        text.defaultValue = c.text;
        weight.value = c.weight;
        row.classList.add('saved');
        setTimeout(() => row.classList.remove('saved'), 900);
      } catch (e) { h.toast(e.message, true); revert(); }
    };
    text.onchange = () => save({ text: text.value }, () => { text.value = c.text; len.textContent = `${c.text.length}/${MAX_CAPTION}`; });
    weight.onchange = () => save({ weight: Number(weight.value) }, () => { weight.value = c.weight; });
    h.$('[data-del-cap]', row).onclick = async () => {
      try {
        await h.api(`/api/captions/${c.id}`, { method: 'DELETE' });
        m.captions = m.captions.filter((x) => x.id !== c.id);
        row.remove();
        if (!m.captions.length) { capBox.innerHTML = emptyCap(m); bindClone(); }
        refreshCounts();
      } catch (e) { h.toast(e.message, true); }
    };
  };
  h.$$('[data-cap]', capBox).forEach(bindCap);
  // Empty pool: copy another model's captions.
  function bindClone() {
    const box = h.$('[data-clone]', capBox);
    if (!box) return;
    h.$('button', box).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const from = Number(h.$('select', box).value);
        const r = await h.api(`/api/models/${m.id}/captions/clone`, { method: 'POST', body: { from } });
        m.captions = r.captions;
        capBox.innerHTML = m.captions.length ? m.captions.map(captionHtml).join('') : emptyCap(m);
        h.$$('[data-cap]', capBox).forEach(bindCap);
        refreshCounts();
        h.toast(`${r.added} caption(s) copied from ${allModels.find((x) => x.id === from)?.name || 'another model'}`);
      } catch (err) { h.toast(err.message, true); btn.disabled = false; }
    };
  }
  bindClone();
  const capForm = h.$('[data-add-caption]', card);
  capForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(capForm));
    const btn = h.$('button', capForm);
    btn.disabled = true;
    try {
      const c = await h.api(`/api/models/${m.id}/captions`, { method: 'POST', body: { text: f.text, weight: Number(f.weight) } });
      m.captions.push(c);
      if (!capBox.querySelector('[data-cap]')) capBox.innerHTML = '';
      capBox.insertAdjacentHTML('beforeend', captionHtml(c));
      bindCap(capBox.lastElementChild);
      capForm.text.value = '';
      capForm.weight.value = '1';
      refreshCounts();
    } catch (err) { h.toast(err.message, true); }
    btn.disabled = false;
  };
  capForm.text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); capForm.requestSubmit(); } };
}
