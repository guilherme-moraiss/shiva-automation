// Links de lançamento: reels already proven viral on her accounts. A new model starts with all of them at once.
import { icon, stripEmoji } from './icons.js';

let h; // { $, $$, esc, api, toast, fmt, PF, loadShared }
export function init(helpers) { h = helpers; }

const on = () => /^#\/launch(?:[/?]|$)/.test(location.hash);
const media = (p) => `/media/${h.esc(p)}`;
const st = { items: [], models: [], seq: 0 };

export async function renderLaunch() {
  const seq = ++st.seq;
  const d = await h.api('/api/launch-links');
  if (!on() || seq !== st.seq) return;
  st.items = d.items;
  st.models = d.models;
  h.$('#view').innerHTML = `
    <h2>Launch links</h2>
    <p class="sub">Reels that have already proven viral on your accounts. When you create a new model, you <b>launch</b> them all at once: one remake of each goes into her <a href="#/remakes">Remake queue</a>, ready to generate. Nothing is generated or paid for until you press Generate.</p>
    <div class="card stack" style="gap:10px">
      <h3 style="margin:0">${icon('plus-square')}Add link</h3>
      <form class="ln-add" id="ln-add" autocomplete="off">
        <input class="input" name="url" type="url" placeholder="https://www.tiktok.com/@…/video/…  or  https://www.instagram.com/reel/…" aria-label="Reel link" required>
        <input class="input" name="name" placeholder="Name (optional)" aria-label="Name" maxlength="80">
        <button class="btn primary">${icon('plus')}Add</button>
      </form>
      <div id="ln-msg" aria-live="polite"></div>
    </div>
    <div class="card ln-launch">
      <div><h3 style="margin:0">${icon('send')}Launch for a model</h3>
        <div class="dim" style="font-size:12.5px;margin-top:4px">Puts one remake of each link in the model's queue. Links she already has are left out.</div></div>
      <div class="row" style="flex-wrap:nowrap">
        <select class="input" id="ln-model" aria-label="Model">${st.models.map((m) => `<option value="${m.id}">${h.esc(m.name)}</option>`).join('')}</select>
        <button class="btn primary" id="ln-go" ${st.items.length && st.models.length ? '' : 'disabled'}>${icon('send')}Launch ${st.items.length} link(s)</button>
      </div>
    </div>
    <div id="ln-list" class="ln-list">${listHtml()}</div>`;
  bind();
}

function listHtml() {
  if (!st.items.length) return `<div class="empty">${icon('link', { size: 28 })}<h3>No links yet</h3><p>Add the reels that performed best. You can also save a project as a link from the project page.</p></div>`;
  return st.items.map((l) => `
    <article class="card ln-card" data-id="${l.id}">
      <div class="ln-thumb" style="${l.frame_path || l.thumb_path ? `background-image:url('${media(l.frame_path || l.thumb_path)}')` : ''}"></div>
      <div class="ln-main">
        <input class="input ln-name" value="${h.esc(l.name)}" placeholder="Untitled" aria-label="Link name" maxlength="80">
        <div class="dim" style="font-size:12.5px"><span class="pf ${l.platform}">${h.PF[l.platform]}</span> @${h.esc(l.handle)}${l.views != null ? ` · ${h.fmt(l.views)} views` : ''}${l.duration ? ` · ${Math.round(l.duration)} s` : ''}</div>
        <div class="ln-models">${l.models.length ? l.models.map((m) => `<span class="status ${m.approved ? 'ok' : m.started ? 'private' : 'new'}" title="${m.remakes} remake(s)${m.approved ? `, ${m.approved} approved` : ''}">${h.esc(m.name)} · ${m.approved ? 'done' : m.started ? 'in progress' : 'queued'}</span>`).join('') : '<span class="dim" style="font-size:12px">Not used on any model yet</span>'}</div>
      </div>
      <div class="ln-acts">
        <a class="btn sm" href="#/remake/${l.reel_id}" title="Set up and generate a remake of this reel">${icon('play-circle')}Open</a>
        <a class="btn sm ghost" href="${h.esc(l.url || '#')}" target="_blank" rel="noopener" title="Open the original">${icon('external-link')}</a>
        <button class="icon-btn" data-del title="Remove from launch links" aria-label="Remove from launch links">${icon('trash')}</button>
      </div>
    </article>`).join('');
}

function bind() {
  const form = h.$('#ln-add');
  const msg = h.$('#ln-msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const btn = h.$('button', form);
    btn.disabled = true;
    msg.innerHTML = `<div class="msg"><span class="spinner inline"></span>Fetching the reel and downloading the video…</div>`;
    try {
      const r = await h.api('/api/launch-links', { method: 'POST', body: f });
      if (!on()) return;
      h.toast(r.existed ? 'That reel was already in the links' : 'Link added');
      renderLaunch();
    } catch (err) {
      if (!on()) return;
      msg.innerHTML = `<div class="callout warn">${icon('alert-triangle')}<div>${h.esc(stripEmoji(err.message))}</div></div>`;
      btn.disabled = false;
    }
  };
  const go = h.$('#ln-go');
  if (go) {
    go.onclick = async () => {
      const sel = h.$('#ln-model');
      const name = sel.selectedOptions[0]?.textContent || '';
      go.disabled = true;
      try {
        const r = await h.api('/api/launch-links/launch', { method: 'POST', body: { modelId: Number(sel.value) } });
        h.toast(r.added ? `${r.added} remake(s) queued for ${name}${r.skipped ? ` (${r.skipped} already existed)` : ''}` : `${name} already has all these links`);
        h.loadShared?.().catch(() => {});
        renderLaunch();
      } catch (e) { h.toast(e.message, true); go.disabled = false; }
    };
  }
  h.$$('.ln-card').forEach((card) => {
    const id = Number(card.dataset.id);
    const name = h.$('.ln-name', card);
    name.onchange = async () => {
      try { await h.api(`/api/launch-links/${id}`, { method: 'PATCH', body: { name: name.value } }); name.defaultValue = name.value; } catch (e) { h.toast(e.message, true); name.value = name.defaultValue; }
    };
    h.$('[data-del]', card).onclick = async () => {
      if (!confirm('Remove this reel from the launch links? The reel and its projects stay in the app.')) return;
      try { await h.api(`/api/launch-links/${id}`, { method: 'DELETE' }); renderLaunch(); } catch (e) { h.toast(e.message, true); }
    };
  });
}
