import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, setSetting, MEDIA_DIR } from '../db.js';
import { route, readBody, HttpError, decodeDataUrl } from '../http.js';
import { ComfyClient } from './comfy.js';
import { ComfyApi } from './comfyapi.js';
import { vision } from './outfit.js';
import { WaveSpeed } from './wavespeed.js';
import {
  REQUIRED_NODES, NODES, PLACEHOLDERS, NB_COMFY_MODELS, NB_GEMINI_MODELS, nanoBananaWorkflow, wanI2VWorkflow, wanR2VWorkflow,
  validateApiWorkflow, describeWorkflow, estimateImageCost, estimateVideoCost,
} from './workflows.js';
import { createGeneration, getGeneration, chooseImage, retryGeneration, setStage, defaultConfig, isBusy, kick, nanoBananaImages, ensureAutoFrame, previewImagePrompt, editCandidate, editOptions, EDIT_ENGINE_KEYS, promptState, pickSwap, startEnlarge, pickFinal, startVideo, enlargeSettings, topazEstimate, startTopaz, resumeTopaz, undoTopaz, editEngineLabel, aspectFor, editEngineList, defaultEnlargeEngine, IMAGE_EDITORS, estimateAnimateCost } from './runner.js';
import { POSES, bodyLine, BODY_DESCRIBE_PROMPT, PROFILE_PROMPT, EDIT_PRESETS, EDIT_SYSTEM_PROMPT, buildImageEditPrompt, buildEnlargePrompt, ENLARGE_DEFAULT } from './prompts.js';
import { geminiText } from './gemini.js';
import { analyzeProfile } from './profile.js';
import { KINDS, normalizeRefs, readiness, syncFolder, ensureModelDir, modelDirRel, ANGLE_PROMPTS, slug } from './modelpack.js';
import { isUiWorkflow, uiToApi, suggestMapping, mappableInputs, VARIABLES } from './comfyworkflow.js';
import { ensureVideo, sendFile } from '../media.js';
import { recordCost, recordBalance } from '../costs.js';
import { reelPreflight } from './qa.js';
import { verifyRunningHub, RH_VIDEO_ENGINES, RH_FRAME_ENGINES, rhCatalog, rhReady } from './rhworkflows.js';
import { RunningHub, RH_SITES } from './runninghub.js';
import { lowBalanceThreshold } from '../status.js';

/**
 * Whether this remake needs WaveSpeed (Nano Banana, Seedream, Wan 2.7, Wan 3.0, Wan 2.2 Animate). With her image made by
 * one of her RunningHub workflows (SKY / Faceswap) and the video by a RunningHub workflow, only the RunningHub key is
 * needed. A chosen outfit is put on with a Nano Banana edit, and extra poses are Nano Banana images: those need WaveSpeed.
 */
function needsWaveSpeed(cfg, kind, raw = {}) {
  if (!RH_FRAME_ENGINES.includes(cfg.frameEngine) || cfg.outfitId || raw.outfitId) return true;
  if (kind === 'photo') return !!((Array.isArray(raw.poses) && raw.poses.length) || String(raw.customPose || '').trim());
  return !RH_VIDEO_ENGINES[cfg.videoEngine];
}
/** WaveSpeed for the pages (key saved? balance), cached 60 s (10 s after an error); one check at a time. */
const wsc = { key: '', at: 0, value: null, pending: null };
function wsStatus(s, fresh = false) {
  const key = s.wavespeed_api_key || '';
  if (!key) return Promise.resolve({ apiKey: false, ok: false });
  const ttl = wsc.value?.ok ? 60e3 : 10e3;
  if (!fresh && wsc.key === key && wsc.value && Date.now() - wsc.at < ttl) return Promise.resolve(wsc.value);
  if (!wsc.pending) {
    wsc.pending = new WaveSpeed(key).balance()
      .then(({ usd }) => { recordBalance('wavespeed', usd); return { apiKey: true, ok: true, balanceUsd: usd }; }, (e) => ({ apiKey: true, ok: false, error: e.message }))
      .then((v) => { Object.assign(wsc, { key, at: Date.now(), value: v }); return v; })
      .finally(() => { wsc.pending = null; });
  }
  return wsc.pending;
}
import { execFile } from 'node:child_process';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

async function checkComfy(client) {
  if (client.mode === 'api') {
    try {
      const { usd } = await new ComfyApi(client.apiKey).balance({ retry: false, timeoutMs: 5000 }); // status check: one quick request
      const info = { ok: true, version: 'Comfy API (partner nodes, no subscription)', devices: ['api.comfy.org'], balanceUsd: usd };
      if (usd < 0.1) info.warning = `Low balance: $${usd.toFixed(3)} — buy credits at platform.comfy.org to generate.`;
      return { info, nodes: Object.fromEntries([...new Set(Object.values(REQUIRED_NODES).flat())].map((c) => [c, true])) };
    } catch (e) {
      return { info: { ok: false, error: e.message }, nodes: {} };
    }
  }
  try {
    const info = await client.ping();
    const nodes = await client.hasNodes([...new Set(Object.values(REQUIRED_NODES).flat())]);
    return { info, nodes };
  } catch (e) {
    return { info: { ok: false, error: e.message }, nodes: {} };
  }
}
/**
 * Comfy connection status, cached (stale-while-revalidate). The check talks to api.comfy.org (~1 s, much longer
 * during an outage) and every page (Remake, Studio, Comfy, Definições) waits for it before painting.
 * - fresh answer within the TTL (60 s when connected, 10 s when not): served from memory;
 * - older answer for the same connection: served at once while a new check runs in the background;
 * - other mode/URL/key (settings just saved) or ?fresh=1: waits for a new check.
 * Concurrent requests share one check.
 * A momentary outage (timeout, network, HTTP 429/5xx) right after a good check keeps the last good status for up to
 * 5 minutes (re-checked every 10 s), so a blip doesn't flip the UI to "não ligado" and disable "Gerar" mid-session.
 */
const cc = { key: '', at: 0, okAt: 0, value: null, softFail: false, pending: null, pendingKey: '' };
const TRANSIENT_COMFY = /não respondeu|Falha de rede|did not respond|didn't respond|not responding|no response|timed out|network (error|failure)|HTTP (429|5\d\d)/i;
function comfyStatus(s, fresh = false) {
  const key = `${s.comfy_mode}|${s.comfy_url}|${s.comfy_api_key}`;
  const same = cc.key === key && !!cc.value;
  const ttl = cc.value?.info?.ok && !cc.softFail ? 60e3 : 10e3;
  if (!fresh && same && Date.now() - cc.at < ttl) return Promise.resolve(cc.value);
  if (!cc.pending || cc.pendingKey !== key) {
    cc.pendingKey = key;
    const p = checkComfy(ComfyClient.fromSettings(s))
      .then((v) => {
        if (cc.pending !== p) return v; // a newer check (other settings) wins
        const t = Date.now();
        if (v?.info?.ok) { Object.assign(cc, { key, at: t, okAt: t, value: v, softFail: false }); return v; }
        if (cc.key === key && cc.value?.info?.ok && t - cc.okAt < 5 * 60e3 && TRANSIENT_COMFY.test(String(v?.info?.error || ''))) {
          Object.assign(cc, { at: t, softFail: true });
          return cc.value;
        }
        Object.assign(cc, { key, at: t, value: v, softFail: false });
        return v;
      })
      .finally(() => { if (cc.pending === p) cc.pending = null; });
    cc.pending = p;
  }
  return !fresh && same ? Promise.resolve(cc.value) : cc.pending;
}

// Synchronous on purpose: the model-folder sync runs right after and must not see deleted files.
const rmMedia = (rel) => { if (rel && !rel.includes('..')) { try { fs.rmSync(path.join(MEDIA_DIR, rel), { force: true }); } catch {} } };

const EXAMPLES = {
  nano_banana: () => nanoBananaWorkflow({ images: ['model_ref_1.png', 'model_ref_2.png', 'source_frame.png'], prompt: 'Create a photorealistic vertical 9:16 smartphone photo of the woman shown in the first 2 images…', seed: 42 }),
  wan3_i2v: () => wanI2VWorkflow({ firstFrame: 'first_frame.png', prompt: 'Vertical 9:16 smartphone video, using the input image as the first frame…', seed: 42 }),
  wan3_r2v: () => wanR2VWorkflow({ images: ['first_frame.png'], video: 'source_reel.mp4', prompt: 'The on-screen person is the woman in @Image1… Use @Video1 only as a motion reference…', seed: 42 }),
};

export function registerPipelineRoutes() {
  // ---- models (AI personas) + their photo folder -------------------------------------------
  const getModel = (id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  const saveRefs = (id, refs) => db.prepare('UPDATE models SET ref_images = ? WHERE id = ?').run(JSON.stringify(refs), id);
  const modelRow = (m) => {
    let refs = normalizeRefs(m.ref_images);
    const synced = syncFolder(m, refs); // pick up files dropped straight into the folder
    if (synced.added) { refs = synced.refs; saveRefs(m.id, refs); }
    const sig = refs.map((r) => r.path).sort().join('|');
    let profile = null;
    try { profile = m.profile ? JSON.parse(m.profile) : null; } catch {}
    return {
      ...m, ref_images: refs, folder: path.join(MEDIA_DIR, modelDirRel(m)), readiness: readiness(refs), task: modelTasks.get(m.id) || null,
      profile, profileStale: refs.length > 0 && (!profile || m.profile_sig !== sig),
    };
  };
  const modelTasks = new Map();

  route('GET', '/api/models/kinds', () => KINDS);

  route('GET', '/api/models', () =>
    db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM remakes r WHERE r.model_id = m.id) AS remakes,
      (SELECT COUNT(*) FROM generations g JOIN remakes r ON r.id = g.remake_id WHERE r.model_id = m.id AND g.stage = 'approved') AS approved
      FROM models m ORDER BY m.name`).all().map(modelRow));

  route('POST', '/api/models', async (req) => {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Name is required');
    let m;
    try {
      m = db.prepare('INSERT INTO models (name, color, notes, persona, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
        .get(name, b.color || null, b.notes || '', String(b.persona || '').slice(0, 1000), now());
    } catch { throw new HttpError(409, 'A model with that name already exists'); }
    ensureModelDir(m);
    return modelRow(m);
  });

  route('PATCH', '/api/models/:id', async (req, { params }) => {
    const b = await readBody(req);
    db.prepare('UPDATE models SET color = COALESCE(?, color), notes = COALESCE(?, notes), persona = COALESCE(?, persona), body = COALESCE(?, body), rules = COALESCE(?, rules) WHERE id = ?')
      .run(b.color ?? null, b.notes ?? null, b.persona ?? null, b.body !== undefined ? String(b.body).slice(0, 800) : null, b.rules !== undefined ? String(b.rules).slice(0, 800) : null, params.id);
    // Her Z-Image LoRA on RunningHub (SKY workflow): file name as shown in RunningHub, and its trigger word.
    if (b.rh_lora !== undefined) db.prepare('UPDATE models SET rh_lora = ? WHERE id = ?').run(String(b.rh_lora).trim().slice(0, 300), params.id);
    if (b.rh_trigger !== undefined) db.prepare('UPDATE models SET rh_trigger = ? WHERE id = ?').run(String(b.rh_trigger).trim().replace(/\s+/g, ' ').slice(0, 60), params.id);
    // Her WAN 2.2 (low noise) LoRA on RunningHub: optional, used by the Instagirl realism pass instead of its author's LoRA.
    if (b.rh_wan_lora !== undefined) db.prepare('UPDATE models SET rh_wan_lora = ? WHERE id = ?').run(String(b.rh_wan_lora).trim().slice(0, 300), params.id);
    // Perfis: her default image instructions and her ★ photo (one of her own references, or '' for none).
    if (b.image_extra !== undefined) db.prepare('UPDATE models SET image_extra = ? WHERE id = ?').run(String(b.image_extra).trim().slice(0, 1500), params.id);
    if (b.swap_prompt !== undefined) db.prepare('UPDATE models SET swap_prompt = ? WHERE id = ?').run(String(b.swap_prompt).trim().slice(0, 4000), params.id);
    if (b.default_ref !== undefined) {
      const ref = String(b.default_ref || '');
      const mine = normalizeRefs(getModel(params.id)?.ref_images).some((r) => r.path === ref);
      if (ref && !mine) throw new HttpError(400, 'That photo is not one of her photos');
      db.prepare('UPDATE models SET default_ref = ? WHERE id = ?').run(ref, params.id);
    }
    // Editar imagem / Aumento automático (Perfis).
    if (b.edit_prompt !== undefined) db.prepare('UPDATE models SET edit_prompt = ? WHERE id = ?').run(String(b.edit_prompt).trim().slice(0, 1500), params.id);
    if (b.edit_engine !== undefined) {
      if (b.edit_engine && !EDIT_ENGINE_KEYS.includes(b.edit_engine)) throw new HttpError(400, 'Invalid edit engine');
      db.prepare('UPDATE models SET edit_engine = ? WHERE id = ?').run(String(b.edit_engine || ''), params.id);
    }
    if (b.edit_n !== undefined) db.prepare('UPDATE models SET edit_n = ? WHERE id = ?').run(Math.max(1, Math.min(4, Number(b.edit_n) || 1)), params.id);
    if (b.edit_auto !== undefined) db.prepare('UPDATE models SET edit_auto = ? WHERE id = ?').run(b.edit_auto ? 1 : 0, params.id);
    return modelRow(getModel(params.id));
  });

  // "Duplicar como backup" (reference: 'Backup Faye' with the same photos): a new model with her photos (copied files),
  // texts, image and enlargement settings and captions — no accounts, so the backup's own accounts go there.
  route('POST', '/api/models/:id/duplicate', (req, { params }) => {
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    let name = `Backup ${m.name}`.slice(0, 40);
    for (let i = 2; db.prepare('SELECT 1 FROM models WHERE name = ?').get(name); i++) {
      if (i > 999) throw new HttpError(409, 'There are too many copies with this name: rename one of them in Models');
      const sfx = ` ${i}`;
      name = `Backup ${m.name}`.slice(0, 40 - sfx.length).trimEnd() + sfx;
    }
    const cols = ['color', 'notes', 'persona', 'body', 'rules', 'profile', 'rh_lora', 'rh_trigger', 'rh_wan_lora', 'edit_prompt', 'edit_engine', 'edit_n', 'edit_auto', 'image_extra', 'swap_prompt'];
    const b = db.prepare(`INSERT INTO models (name, created_at, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')}) RETURNING *`).get(name, now(), ...cols.map((c) => m[c] ?? null));
    const dir = modelDirRel(b);
    ensureModelDir(b);
    const refs = normalizeRefs(m.ref_images).map((r, i) => {
      const dest = `${dir}/${path.basename(r.path).replace(/\.[^.]+$/, '')}_${i}${path.extname(r.path)}`;
      fs.copyFileSync(path.join(MEDIA_DIR, r.path), path.join(MEDIA_DIR, dest));
      return { ...r, path: dest, star: r.path === m.default_ref };
    });
    const star = refs.find((r) => r.star)?.path || '';
    saveRefs(b.id, refs.map(({ star: _s, ...r }) => r));
    db.prepare('UPDATE models SET default_ref = ? WHERE id = ?').run(star, b.id);
    const ins = db.prepare('INSERT INTO captions (model_id, text, weight, created_at) VALUES (?, ?, ?, ?)');
    for (const c of db.prepare('SELECT text, weight FROM captions WHERE model_id = ? ORDER BY id').all(m.id)) ins.run(b.id, c.text, c.weight, now());
    return modelRow(getModel(b.id));
  });

  route('DELETE', '/api/models/:id', (req, { params }) => {
    const m = getModel(params.id);
    // Her accounts and their posts are deleted with her (ON DELETE CASCADE): same rule as removing one account in Perfis.
    const n = db.prepare(`SELECT SUM(p.status = 'posted') posted, SUM(p.status = 'scheduled') scheduled
      FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.model_id = ?`).get(params.id);
    if (n.posted) throw new HttpError(409, `${m?.name || 'This model'} already has ${n.posted} published post(s): turn off her accounts in Profiles instead of removing the model, so that history is not lost`);
    if (n.scheduled) throw new HttpError(409, `${m?.name || 'This model'} has ${n.scheduled} post(s) on the schedule: remove them in Scheduled or in the Calendar before removing the model`);
    if (m) fs.rmSync(path.join(MEDIA_DIR, modelDirRel(m)), { recursive: true, force: true });
    normalizeRefs(m?.ref_images).forEach((r) => rmMedia(r.path));
    db.prepare('DELETE FROM models WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // Upload photos: { images: [{ data: dataUrl, kind }] } (kind defaults to "extra")
  route('POST', '/api/models/:id/images', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const dir = modelDirRel(m);
    ensureModelDir(m);
    let refs = normalizeRefs(m.ref_images);
    const items = (Array.isArray(b.images) ? b.images : [b.image]).map((x) => (typeof x === 'string' ? { data: x } : x));
    for (const [i, it] of items.entries()) {
      if (refs.length >= 30) break;
      const kind = KINDS.some((k) => k.key === it.kind) ? it.kind : 'extra';
      const { buf, ext } = decodeDataUrl(it.data);
      const single = !KINDS.find((k) => k.key === kind)?.multi;
      if (single) refs.filter((r) => r.kind === kind).forEach((r) => rmMedia(r.path)); // one photo per angle slot
      if (single) refs = refs.filter((r) => r.kind !== kind);
      const rel = `${dir}/${kind}_${Date.now()}_${i}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
      refs.push({ path: rel, kind });
    }
    saveRefs(m.id, refs);
    return modelRow(getModel(m.id));
  });

  route('PATCH', '/api/models/:id/images', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const refs = normalizeRefs(m.ref_images).map((r) => (r.path === b.path ? { ...r, kind: b.kind, generated: r.generated } : r));
    saveRefs(m.id, refs);
    return modelRow(getModel(m.id));
  });

  route('DELETE', '/api/models/:id/images', async (req, { params, query }) => {
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const p = query.get('path');
    rmMedia(p);
    saveRefs(m.id, normalizeRefs(m.ref_images).filter((r) => r.path !== p));
    return modelRow(getModel(m.id));
  });

  // The editors (with their price per image) and the ready prompts: Modelos' "Aumentar o peito" window.
  route('GET', '/api/edit-options', () => ({ engines: editEngineList(), default: defaultEnlargeEngine(), presets: Object.entries(EDIT_PRESETS).map(([key, p]) => ({ key, label: p.label, text: p.text })) }));

  // Modelos → "Aumentar o peito" (or any one change) on one of her photos: N edits to choose from. Only photos the app
  // generated of her: an uploaded photo may show a real person. The edit keeps her dressed (EDIT_SYSTEM_PROMPT).
  route('POST', '/api/models/:id/images/edit', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const ref = normalizeRefs(m.ref_images).find((r) => r.path === String(b.path || ''));
    if (!ref) throw new HttpError(400, 'That photo is not one of her photos');
    if (!ref.generated) throw new HttpError(400, 'Only photos the app generated of her can be edited: an uploaded photo may be of a real person.');
    const preset = EDIT_PRESETS[b.preset];
    const change = String(b.change || '').trim() ? String(b.change).trim().slice(0, 1500) : preset ? preset.text : ENLARGE_DEFAULT;
    const engine = EDIT_ENGINE_KEYS.includes(b.engine) ? b.engine : defaultEnlargeEngine();
    const n = Math.max(1, Math.min(4, Number(b.n) || 2));
    const s = getSettings();
    const cfg = defaultConfig();
    const onFal = IMAGE_EDITORS[engine]?.provider === 'fal';
    if (onFal && !s.fal_api_key) throw new HttpError(400, 'Wan 2.7 runs on fal.ai: the fal.ai API key is missing (Settings → Pipeline)');
    if (!s.wavespeed_api_key) throw new HttpError(400, 'First paste the WaveSpeed API key in Settings → Pipeline');
    // A bust preset (or the default) is an enlargement: sent short, as the reference writes it.
    const lean = !String(b.change || '').trim() || Object.values(EDIT_PRESETS).some((p) => p.text === change);
    let out;
    try {
      out = await nanoBananaImages({
        inputs: [ref.path], prompt: (lean ? buildEnlargePrompt : buildImageEditPrompt)({ change, body: { body: m.body || '', rules: m.rules || '', profile: m.profile || '' } }), cfg, n,
        tag: `m${m.id}_edit`, aspectRatio: aspectFor(fs.readFileSync(path.join(MEDIA_DIR, ref.path))), systemPrompt: lean ? '' : EDIT_SYSTEM_PROMPT, engine,
      });
    } catch (e) {
      const raw = String(e.raw || e.message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new HttpError(400, e.safety ? `${editEngineLabel(engine)} refused this edit in its content filter${raw ? ` ("${raw}")` : ''}. Her photo did not change.` : e.message);
    }
    const usd = out.reduce((a, c) => a + (c.cost || 0), 0);
    recordCost({ amount: usd, provider: onFal ? 'fal' : engine === 'nano' && cfg.imageEngine === 'gemini' ? 'gemini' : 'comfy', category: 'edicao', modelId: m.id, workerId: req.worker?.id ?? null, note: 'Model photo edited (Models)', units: out.length });
    return { candidates: out.map((c) => ({ path: c.path, cost: c.cost })), asked: n, engine };
  });

  // … and the one kept: it replaces the photo (the old file is kept aside in generated/) or joins her photos.
  route('POST', '/api/models/:id/images/apply', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const refs = normalizeRefs(m.ref_images);
    const ref = refs.find((r) => r.path === String(b.path || ''));
    const src = String(b.with || '');
    if (!ref || !new RegExp(`^generated/m${m.id}_edit_[\\w.-]+$`).test(src) || !fs.existsSync(path.join(MEDIA_DIR, src))) throw new HttpError(400, 'Invalid image');
    const add = b.mode === 'add';
    const dir = modelDirRel(m);
    ensureModelDir(m);
    const dest = `${dir}/${add ? 'extra' : ref.kind}_edited_${Date.now()}${path.extname(src)}`;
    fs.renameSync(path.join(MEDIA_DIR, src), path.join(MEDIA_DIR, dest));
    let next;
    if (add) next = [...refs, { path: dest, kind: 'extra', generated: true, editedFrom: ref.path }];
    else {
      // Out of her folder (the folder is read back as her photos), not deleted: it can still be found in generated/.
      const aside = `generated/m${m.id}_before_${Date.now()}${path.extname(ref.path)}`;
      try { fs.renameSync(path.join(MEDIA_DIR, ref.path), path.join(MEDIA_DIR, aside)); } catch { /* already gone */ }
      next = refs.map((r) => (r.path === ref.path ? { ...r, path: dest, generated: true, editedFrom: aside } : r));
      if (m.default_ref === ref.path) db.prepare('UPDATE models SET default_ref = ? WHERE id = ?').run(dest, m.id);
    }
    saveRefs(m.id, next);
    return modelRow(getModel(m.id));
  });

  // Open the model's folder in Finder/Explorer so photos can be dropped in directly.
  route('POST', '/api/models/:id/open-folder', (req, { params }) => {
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const dir = ensureModelDir(m);
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [dir], () => {});
    return { ok: true, folder: dir };
  });

  // Text → photo of the model (Nano Banana). Optionally uses the photos already in the folder to keep identity.
  route('POST', '/api/models/:id/generate-photo', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const prompt = String(b.prompt || '').trim();
    if (prompt.length < 5) throw new HttpError(400, 'Write a prompt');
    const kind = KINDS.some((k) => k.key === b.kind) ? b.kind : 'face_front';
    if (modelTasks.get(m.id)?.state === 'running') throw new HttpError(409, 'Already generating for this model');
    const s = getSettings();
    const cfg = defaultConfig();
    if (!s.wavespeed_api_key) throw new HttpError(400, 'First paste the WaveSpeed API key in Settings → Pipeline');
    const refs = b.useRefs ? normalizeRefs(m.ref_images).filter((r) => !r.generated).slice(0, 6).map((r) => r.path) : [];
    const n = Math.max(1, Math.min(4, Number(b.n) || 1));
    const task = { state: 'running', total: n, done: 0, current: 'Photo from prompt', errors: [] };
    modelTasks.set(m.id, task);
    (async () => {
      try {
        const full = (refs.length ? 'Use the reference photos: they all show the SAME woman — keep her identity exactly.\n' : '') + (m.body || m.rules || m.profile ? `${bodyLine({ body: m.body, rules: m.rules, profile: m.profile })}\n` : '') + prompt +
          '\nPhotorealistic smartphone photo, realistic skin texture, exactly one person, no text, no watermark.';
        const imgs = await nanoBananaImages({ inputs: refs, prompt: full, cfg: { ...cfg, autoApprove: false }, n, tag: `m${m.id}_prompt`, onStatus: (msg) => { task.current = msg; } });
        const single = !KINDS.find((k) => k.key === kind)?.multi;
        let cur = normalizeRefs(getModel(m.id).ref_images);
        imgs.forEach((img, i) => {
          const k = i === 0 || !single ? kind : 'extra'; // extra variants go to "Estilo" so nothing is overwritten
          const dest = `${modelDirRel(m)}/${k}_prompt_${Date.now()}_${i}${path.extname(img.path)}`;
          fs.renameSync(path.join(MEDIA_DIR, img.path), path.join(MEDIA_DIR, dest));
          if (k === kind && single) { cur.filter((r) => r.kind === kind).forEach((r) => rmMedia(r.path)); cur = cur.filter((r) => r.kind !== kind); }
          cur.push({ path: dest, kind: k, generated: true, prompt: prompt.slice(0, 500) });
          task.done++;
        });
        saveRefs(m.id, cur);
      } catch (e) { task.errors.push(e.message); }
      task.state = 'done';
      task.current = null;
    })();
    return { ok: true };
  });

  // Read her identity profile (hair, eyes, freckles, tattoos, piercings, nails, body) from her own photos.
  route('POST', '/api/models/:id/analyze-profile', async (req, { params }) => {
    try { return { profile: await analyzeProfile(Number(params.id)) }; } catch (e) { throw new HttpError(/não existe|not found/i.test(e.message) ? 404 : 502, e.message); }
  });

  // Describe the model's body proportions from her real body photos (Gemini vision) and save them.
  route('POST', '/api/models/:id/describe-body', async (req, { params, query }) => {
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    const refs = normalizeRefs(m.ref_images).filter((r) => !r.generated);
    const pics = [...refs.filter((r) => r.kind.startsWith('body_')), ...refs.filter((r) => r.kind === 'extra')].slice(0, 4);
    if (!pics.length) throw new HttpError(400, 'First upload a REAL full-body photo (not a generated one)');
    const images = pics.map((r) => {
      const buf = fs.readFileSync(path.join(MEDIA_DIR, r.path));
      return { buf, data: buf, mime: /\.png$/i.test(r.path) ? 'image/png' : /\.webp$/i.test(r.path) ? 'image/webp' : 'image/jpeg' };
    });
    const s = getSettings();
    let text;
    try {
      text = await vision(BODY_DESCRIBE_PROMPT, pics.map((r) => r.path));
      if (!text) throw new Error('The WaveSpeed API key is required (Settings → Pipeline)');
    } catch (e) { throw new HttpError(502, `Could not describe the body: ${e.message}`); }
    const body = text.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 800);
    if (query.get('save') === '1') db.prepare('UPDATE models SET body = ? WHERE id = ?').run(body, m.id);
    return { body, saved: query.get('save') === '1' };
  });

  // Generate the missing angles from the photos that exist (Nano Banana).
  route('POST', '/api/models/:id/fill-angles', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    if (modelTasks.get(m.id)?.state === 'running') throw new HttpError(409, 'Already generating angles for this model');
    const refs = normalizeRefs(m.ref_images);
    if (!refs.length) throw new HttpError(400, 'Upload at least one sharp photo of her face (front)');
    const have = new Set(refs.map((r) => r.kind));
    const kinds = (Array.isArray(b.kinds) && b.kinds.length ? b.kinds : Object.keys(ANGLE_PROMPTS).filter((k) => !have.has(k))).filter((k) => ANGLE_PROMPTS[k]);
    if (!kinds.length) return { ok: true, message: 'All angles already exist' };
    const cfg = defaultConfig();
    const s = getSettings();
    if (!s.wavespeed_api_key) throw new HttpError(400, 'First paste the WaveSpeed API key in Settings → Pipeline');
    const task = { state: 'running', total: kinds.length, done: 0, current: null, errors: [] };
    modelTasks.set(m.id, task);
    (async () => {
      for (const kind of kinds) {
        task.current = KINDS.find((k) => k.key === kind)?.label;
        try {
          const cur = getModel(m.id);
          const fresh = normalizeRefs(cur.ref_images).filter((r) => !r.generated && r.kind !== kind);
          const faces = fresh.filter((r) => r.kind.startsWith('face_'));
          const bodies = fresh.filter((r) => r.kind.startsWith('body_'));
          const isBody = kind.startsWith('body_');
          // Body angles: every real body photo + one face; face angles: faces + one body photo.
          const chosen = isBody ? [...faces.slice(0, 2), ...bodies.slice(0, 4)] : [...faces.slice(0, 4), ...bodies.slice(0, 1)];
          const inputs = chosen.map((r) => r.path);
          const idx = (pred) => chosen.map((r, i) => (pred(r) ? i + 1 : null)).filter(Boolean);
          const fIdx = idx((r) => r.kind.startsWith('face_'));
          const bIdx = idx((r) => r.kind.startsWith('body_'));
          const roles = [fIdx.length && `image(s) ${fIdx.join(', ')}: her FACE`, bIdx.length && `image(s) ${bIdx.join(', ')}: her BODY — reproduce this exact figure`].filter(Boolean).join('; ');
          const persona = cur.persona ? ` Her look: ${cur.persona}.` : '';
          const prompt = (cur.body || cur.rules || cur.profile ? `${bodyLine({ body: cur.body, rules: cur.rules, profile: cur.profile })}\n` : '') +
            `All reference photos show the SAME woman (${roles}). Keep her identity exactly: face, facial features, hair and skin tone.${persona}\n` +
            (cur.body || cur.rules || cur.profile ? '' : `${bodyLine(cur.body)}\n`) +
            `${ANGLE_PROMPTS[kind]}. ${isBody ? 'Wear form-fitting everyday clothes (fitted top and leggings or jeans) so her real silhouette and proportions are clearly visible. ' : ''}` +
            'Plain light neutral background, soft natural daylight, photorealistic, sharp focus, realistic skin texture, amateur smartphone photo look. Exactly one person, no text, no watermark.';
          const [img] = await nanoBananaImages({ inputs, prompt, cfg: { ...cfg, autoApprove: false }, n: 1, tag: `m${m.id}_${kind}` });
          if (img) {
            const dest = `${modelDirRel(m)}/${kind}_generated_${Date.now()}${path.extname(img.path)}`;
            fs.renameSync(path.join(MEDIA_DIR, img.path), path.join(MEDIA_DIR, dest));
            const all = normalizeRefs(getModel(m.id).ref_images);
            all.filter((r) => r.kind === kind).forEach((r) => rmMedia(r.path)); // replaced photo: delete the file too (folder sync would re-add it)
            saveRefs(m.id, [...all.filter((r) => r.kind !== kind), { path: dest, kind, generated: true }]);
          }
        } catch (e) {
          task.errors.push(`${task.current}: ${e.message}`);
          if (/API key|Comfy|créditos|credits|saldo|balance|subscri/i.test(e.message)) break;
        }
        task.done++;
      }
      task.state = 'done';
      task.current = null;
    })();
    return { ok: true, kinds };
  });

  // ---- source frame picked in the player -------------------------------------------------
  route('POST', '/api/reels/:id/frame', async (req, { params }) => {
    const b = await readBody(req);
    const { buf, ext } = decodeDataUrl(b.image);
    const rel = `frames/r${params.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
    const old = db.prepare('SELECT frame_path FROM reels WHERE id = ?').get(params.id)?.frame_path;
    rmMedia(old);
    db.prepare('UPDATE reels SET frame_path = ? WHERE id = ?').run(rel, params.id);
    return { frame_path: rel };
  });

  // ---- generations -------------------------------------------------------------------------
  const GEN_SELECT = `
    SELECT g.*, m.prompt AS instructions, m.model_id, md.name AS model_name, md.color AS model_color,
      r.id AS reel_id, r.external_id, r.platform, r.url, r.thumb_path, r.frame_path, r.views, r.duration, r.media_type, r.image_paths, c.handle, c.followers,
      (COALESCE(md.swap_prompt, '') != '') AS model_swap_prompt
    FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id JOIN creators c ON c.id = r.creator_id
    LEFT JOIN models md ON md.id = m.model_id`;
  const genRow = (g) => {
    const config = parse(g.config, {});
    const edit = !config.ownImage ? editOptions({ ...g, config }) : null; // "Editar imagem": engines, costs, her defaults (videos and photos)
    const enlarge = edit && g.kind === 'video' ? enlargeSettings({ ...g, config }) : null; // step 3: this project's prompt, editor and variants
    return { ...g, config, analysis: parse(g.analysis, null), candidates: parse(g.candidates, []), log: parse(g.log, []), qa: parse(g.qa, null), busy: isBusy(g.id), wsReady: !!getSettings().wavespeed_api_key, edit, enlarge, promptEdited: promptState({ ...g, config }) };
  };

  route('GET', '/api/generations', (req, { query }) => {
    const where = []; const args = [];
    if (query.get('stage')) { where.push(`g.stage IN (${query.get('stage').split(',').map(() => '?').join(',')})`); args.push(...query.get('stage').split(',')); }
    if (query.get('model')) { where.push('m.model_id = ?'); args.push(Number(query.get('model'))); }
    return db.prepare(`${GEN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.updated_at DESC LIMIT 300`).all(...args).map(genRow);
  });

  route('GET', '/api/generations/:id', (req, { params }) => {
    const g = db.prepare(`${GEN_SELECT} WHERE g.id = ?`).get(params.id);
    if (!g) throw new HttpError(404, 'Generation not found');
    return genRow(g);
  });

  // One-shot from the Remake page: create the remake and start generating.
  route('POST', '/api/reels/:id/remake', async (req, { params }) => {
    const b = await readBody(req);
    const reel = db.prepare('SELECT id FROM reels WHERE id = ?').get(params.id);
    if (!reel) throw new HttpError(404, 'Reel not found');
    if (!b.modelId) throw new HttpError(400, 'Choose the model');
    const m = getModel(b.modelId);
    if (!m) throw new HttpError(404, 'Model not found');
    if (!normalizeRefs(m.ref_images).length) throw new HttpError(400, `${m.name}'s folder has no photos yet (go to Models)`);
    const s = getSettings();
    const cfg = defaultConfig(b.config);
    const kind = b.kind === 'photo' ? 'photo' : 'video';
    if (needsWaveSpeed(cfg, kind, b.config || {})) {
      if (!s.wavespeed_api_key) throw new HttpError(400, 'First paste the WaveSpeed API key in Settings → Pipeline');
    }
    const { phoneId, ownImage: _own, ...config } = b.config || {}; // remakes never add her phone: only her face, hair and body go into the reel
    // "A minha imagem" (video remakes): her image uploaded on the Remake page is animated instead of generating images.
    // Read before anything is created, so a bad file leaves nothing behind.
    const own = kind === 'video' && b.ownImage ? decodeDataUrl(b.ownImage) : null;
    if (own && own.buf.length < 1000) throw new HttpError(400, 'The uploaded image is empty or damaged');
    const t = now();
    const remake = db.prepare('INSERT INTO remakes (reel_id, model_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(reel.id, m.id, String(b.prompt || '').slice(0, 2000), 'queued', t, t);
    if (own) {
      const rel = `generated/own_r${reel.id}_${Date.now()}.${own.ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), own.buf);
      config.ownImage = rel;
    }
    // The image prompt edited on the Remake page (video remakes): sent as written.
    const imagePrompt = kind === 'video' && !config.ownImage && typeof b.imagePrompt === 'string' && b.imagePrompt.trim() ? b.imagePrompt.trim().slice(0, 8000) : null;
    return createGeneration(remake.id, config, kind, { imagePrompt });
  });

  // The image prompt a remake with these choices would send: shown (and editable) on the Remake page before generating.
  route('POST', '/api/reels/:id/image-prompt', async (req, { params }) => {
    const b = await readBody(req);
    if (!db.prepare('SELECT 1 FROM reels WHERE id = ?').get(params.id)) throw new HttpError(404, 'Reel not found');
    if (!b.modelId) throw new HttpError(400, 'Choose the model');
    try {
      return previewImagePrompt({ modelId: Number(b.modelId), instructions: String(b.prompt || '').slice(0, 2000), config: b.config || {} });
    } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });

  route('GET', '/api/reels/:id', (req, { params }) => {
    const r = db.prepare(`SELECT r.*, c.handle, c.display_name, c.followers, c.avatar_path,
        CASE WHEN c.followers > 0 AND r.views IS NOT NULL THEN r.views * 1.0 / c.followers END AS ftvr,
        CASE WHEN c.followers > 0 THEN (COALESCE(r.likes, 0) + COALESCE(r.comments, 0)) * 1.0 / c.followers END AS engagement
      FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.id = ?`).get(params.id);
    if (!r) throw new HttpError(404, 'Reel not found');
    if (r.video_path && !fs.existsSync(path.join(MEDIA_DIR, r.video_path))) r.video_path = null;
    return r;
  });

  route('GET', '/api/poses', () => POSES.map(({ key, label }) => ({ key, label })));

  // Same woman, same scene: generate the chosen image (or a post slide) in other poses.
  route('POST', '/api/generations/:id/poses', async (req, { params }) => {
    const b = await readBody(req);
    const g = getGeneration(Number(params.id));
    if (!g) throw new HttpError(404, 'Generation not found');
    const poses = (Array.isArray(b.poses) ? b.poses : []).filter((k) => POSES.some((p) => p.key === k));
    const customPose = String(b.customPose || '').trim().slice(0, 400);
    if (!poses.length && !customPose) throw new HttpError(400, 'Choose at least one pose');
    const base = String(b.image || '');
    if (!base || !fs.existsSync(path.join(MEDIA_DIR, base)) || base.includes('..')) throw new HttpError(400, 'Invalid base image');
    return createGeneration(g.remake_id, { variants: 1, poses, customPose, baseImage: base }, 'poses');
  });

  // Generated image with a readable filename: /api/generations/:id/image/:idx/<name>.png
  const serveGenImage = (req, { params, query, res }) => {
    const g = db.prepare(`${GEN_SELECT} WHERE g.id = ?`).get(params.id);
    const c = parse(g?.candidates, [])[Number(params.idx)];
    if (!c) throw new HttpError(404, 'Image not found');
    const ext = path.extname(c.path) || '.png';
    const label = slug(c.label || `img${Number(params.idx) + 1}`);
    sendFile(req, res, path.join(MEDIA_DIR, c.path), { cache: 'private, max-age=86400', filename: `remake_${slug(g.model_name || 'model')}_${g.handle}_${g.id}_${label}${ext}`, download: query.get('download') === '1' });
  };
  route('GET', '/api/generations/:id/image/:idx', serveGenImage);
  route('GET', '/api/generations/:id/image/:idx/:name', serveGenImage);

  // ---- results of workflows run by hand on the Comfy Cloud site → app Library -----------------
  const cloudClient = () => {
    const s = getSettings();
    if (!s.comfy_api_key) throw new HttpError(400, 'Connect your Comfy account first (API key)');
    return new ComfyClient({ mode: 'cloud', apiKey: s.comfy_api_key });
  };
  /** Files produced by a job, whatever shape the Cloud returns them in. */
  const jobFiles = (job) => {
    const out = [];
    const push = (f) => { if (f && typeof f === 'object' && (f.filename || f.name)) out.push({ filename: f.filename || f.name, subfolder: f.subfolder || '', type: f.type || 'output', url: f.url }); };
    const o = job.outputs;
    if (Array.isArray(o)) o.forEach(push);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) for (const list of Object.values(v || {})) if (Array.isArray(list)) list.forEach(push);
    return out.filter((f) => /\.(png|jpe?g|webp|mp4|webm)$/i.test(f.filename) && f.type !== 'temp');
  };

  route('GET', '/api/comfy-cloud/jobs', async () => {
    const c = cloudClient();
    const d = await c.jsonReq('/jobs?limit=30', {}, 30000);
    const done = new Set(db.prepare('SELECT DISTINCT job_id FROM imports').all().map((r) => r.job_id));
    return (d.jobs || []).map((j) => ({ id: j.id, status: j.status, created: j.create_time, outputs: j.outputs_count ?? null, imported: done.has(j.id), error: j.execution_error?.exception_message?.slice(0, 160) || null }));
  });

  route('POST', '/api/comfy-cloud/import', async (req) => {
    const b = await readBody(req);
    const c = cloudClient();
    const list = (await c.jsonReq('/jobs?limit=30', {}, 30000)).jobs || [];
    const want = Array.isArray(b.jobIds) && b.jobIds.length ? list.filter((j) => b.jobIds.includes(j.id)) : list;
    let added = 0; const errors = [];
    const ins = db.prepare('INSERT OR IGNORE INTO imports (source, job_id, filename, path, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id');
    for (const j of want) {
      if (!/success|completed|succeeded/i.test(j.status || '')) continue;
      if (!b.force && db.prepare('SELECT 1 FROM imports WHERE job_id = ?').get(j.id)) continue;
      try {
        const detail = await c.jsonReq(`/jobs/${encodeURIComponent(j.id)}`, {}, 30000);
        for (const f of jobFiles(detail)) {
          if (db.prepare('SELECT 1 FROM imports WHERE job_id = ? AND filename = ?').get(j.id, f.filename)) continue;
          const buf = f.url ? Buffer.from(await (await fetch(f.url)).arrayBuffer()) : await c.download(f);
          const rel = `imported/${j.id.slice(0, 8)}_${f.filename.replace(/[^\w.-]+/g, '_')}`;
          fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
          if (ins.get('comfy-cloud', j.id, f.filename, rel, now())) added++;
        }
      } catch (e) { errors.push(`${j.id.slice(0, 8)}: ${e.message}`); }
    }
    return { added, errors };
  });

  route('GET', '/api/imports', () => db.prepare(`SELECT i.*, m.name AS model_name FROM imports i LEFT JOIN models m ON m.id = i.model_id ORDER BY i.created_at DESC, i.id DESC LIMIT 500`).all());

  // Send an imported image to a model's folder (as "Estilo / outfits" by default).
  route('POST', '/api/imports/:id/to-model', async (req, { params }) => {
    const b = await readBody(req);
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(params.id);
    const m = getModel(b.modelId);
    if (!imp || !m) throw new HttpError(404, 'Image or model not found');
    if (!/\.(png|jpe?g|webp)$/i.test(imp.path)) throw new HttpError(400, "Only images can go into the model's folder");
    const kind = KINDS.some((k) => k.key === b.kind) ? b.kind : 'extra';
    const dest = `${modelDirRel(m)}/${kind}_comfy_${Date.now()}${path.extname(imp.path)}`;
    ensureModelDir(m);
    fs.copyFileSync(path.join(MEDIA_DIR, imp.path), path.join(MEDIA_DIR, dest));
    let refs = normalizeRefs(m.ref_images);
    if (!KINDS.find((k) => k.key === kind)?.multi) { refs.filter((r) => r.kind === kind).forEach((r) => rmMedia(r.path)); refs = refs.filter((r) => r.kind !== kind); }
    saveRefs(m.id, [...refs, { path: dest, kind }]);
    db.prepare('UPDATE imports SET model_id = ? WHERE id = ?').run(m.id, imp.id);
    return { ok: true };
  });

  route('DELETE', '/api/imports/:id', (req, { params }) => {
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(params.id);
    if (imp) { rmMedia(imp.path); db.prepare('DELETE FROM imports WHERE id = ?').run(imp.id); }
    return { ok: true };
  });

  // Download the original reel into the app (Library).
  // Before spending: is this reel a good fit for an exact copy? (6 frames read by a vision model, cached)
  route('POST', '/api/reels/:id/preflight', async (req, { params }) => {
    const b = await readBody(req);
    const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(params.id);
    if (!reel) throw new HttpError(404, 'Reel not found');
    if (!reel.video_path || !fs.existsSync(path.join(MEDIA_DIR, reel.video_path))) {
      try { reel.video_path = await ensureVideo(reel); } catch (e) { throw new HttpError(502, `Could not download the reel: ${e.message}`); }
    }
    try { return await reelPreflight(reel, { force: !!b.force }); } catch (e) { throw new HttpError(502, e.message); }
  });

  // Custos: what is left on each paid account, read live (one quick request each, nothing is spent).
  route('GET', '/api/usage/balances', async () => {
    const s = getSettings();
    const out = { wavespeed: null, runninghub: null };
    await Promise.all([
      (async () => {
        if (!s.wavespeed_api_key) return;
        try { out.wavespeed = { usd: (await new WaveSpeed(s.wavespeed_api_key).balance()).usd }; recordBalance('wavespeed', out.wavespeed.usd); } catch (e) { out.wavespeed = { error: e.message }; }
      })(),
      (async () => {
        if (!s.rh_api_key) return;
        try {
          const d = await new RunningHub({ apiKey: s.rh_api_key, baseUrl: RH_SITES[s.rh_site] || RH_SITES.ai }).account();
          const money = Number(d?.remainMoney);
          out.runninghub = { money: Number.isFinite(money) ? money : null, coins: d?.remainCoins ?? null, currency: d?.currency || (s.rh_site === 'cn' ? 'CNY' : 'USD') };
          if (out.runninghub.money != null) recordBalance('runninghub', out.runninghub.money, out.runninghub.currency);
        } catch (e) { out.runninghub = { error: e.message }; }
      })(),
    ]);
    return out;
  });

  // RunningHub: check the key and every workflow id (reads the saved workflow, finds the inputs the app replaces).
  route('POST', '/api/runninghub/verify', async () => {
    const s = getSettings();
    if (!s.rh_api_key) throw new HttpError(400, 'First paste the RunningHub API key and save the settings');
    const r = await verifyRunningHub(s);
    // Kept so the pages can say which workflows passed the last check (the run itself checks again before paying).
    const summary = Object.fromEntries(Object.entries(r.workflows).filter(([, w]) => w.configured).map(([k, w]) => [k, { id: w.id, ok: !!w.ok }]));
    setSetting('rh_verify', JSON.stringify({ at: Date.now(), workflows: summary }));
    return r;
  });

  // The workflows the app can run on RunningHub, which ones are configured, and the result of the last check.
  route('GET', '/api/runninghub/workflows', () => {
    const s = getSettings();
    let last = null;
    try { last = JSON.parse(s.rh_verify || 'null'); } catch {}
    return {
      key: !!s.rh_api_key,
      workflows: rhCatalog().map((w) => {
        const id = String(s[w.setting] || '');
        const v = last?.workflows?.[w.key];
        return { ...w, id, ready: rhReady(s, w.key), verified: v && v.id === id ? v.ok : null };
      }),
    };
  });

  route('POST', '/api/reels/:id/download', async (req, { params }) => {
    const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(params.id);
    if (!reel) throw new HttpError(404, 'Reel not found');
    try {
      const rel = await ensureVideo(reel);
      const frame_path = reel.media_type === 'video' || !reel.media_type ? await ensureAutoFrame({ ...reel, video_path: rel }) : reel.frame_path;
      return { video_path: rel, frame_path, size: fs.statSync(path.join(MEDIA_DIR, rel)).size };
    } catch (e) { throw new HttpError(502, `Could not download: ${e.message}`); }
  });

  // Library: originals downloaded into the app + everything generated.
  route('GET', '/api/library', (req, { query }) => {
    const kind = query.get('kind') || 'originals';
    if (kind === 'originals') {
      return db.prepare(`SELECT r.id, r.external_id, r.platform, r.url, r.caption, r.posted_at, r.views, r.likes, r.duration, r.thumb_path, r.frame_path, r.video_path,
          c.handle, c.followers, CASE WHEN c.followers > 0 THEN r.views * 1.0 / c.followers END AS ftvr,
          (SELECT COUNT(*) FROM remakes m WHERE m.reel_id = r.id) AS remake_count
        FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.video_path IS NOT NULL ORDER BY r.posted_at DESC LIMIT 300`).all()
        .filter((r) => fs.existsSync(path.join(MEDIA_DIR, r.video_path)));
    }
    if (kind === 'photos') {
      return db.prepare(`${GEN_SELECT} WHERE g.kind IN ('photo', 'poses') AND g.candidates != '[]' ORDER BY g.updated_at DESC LIMIT 300`).all().map(genRow);
    }
    const stage = kind === 'approved' ? "AND g.stage = 'approved'" : '';
    return db.prepare(`${GEN_SELECT} WHERE g.video_path IS NOT NULL ${stage} ORDER BY g.updated_at DESC LIMIT 300`).all().map(genRow);
  });

  // /api/generations/:id/video/<name>.mp4 — generated video with a readable filename
  const serveGenVideo = (req, { params, query, res }) => {
    const g = db.prepare(`${GEN_SELECT} WHERE g.id = ?`).get(params.id);
    if (!g?.video_path) throw new HttpError(404, 'This generation has no video yet');
    const name = `remake_${slug(g.model_name || 'model')}_${g.handle}_${g.id}.mp4`;
    sendFile(req, res, path.join(MEDIA_DIR, g.video_path), { cache: 'private, max-age=86400', filename: name, download: query.get('download') === '1' });
  };
  route('GET', '/api/generations/:id/video', serveGenVideo);
  route('GET', '/api/generations/:id/video/:name', serveGenVideo);

  route('GET', '/api/reels/:id/generations', (req, { params }) =>
    db.prepare(`${GEN_SELECT} WHERE r.id = ? ORDER BY g.id DESC`).all(params.id).map(genRow));

  /** Starts one remake of the queue (the same checks and choices for "Gerar" and "Gerar todos"). */
  /** The config a remake runs with: its last run's choices (engine, outfit, 1st frame, variants, slides…) + the override. */
  const remakeConfig = (remakeId, kind, override = {}) => {
    // Left out: per-run state, the phone (never injected into remakes) and the connection-dependent keys, which follow the current settings.
    const last = db.prepare('SELECT config FROM generations WHERE remake_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(remakeId, kind);
    const {
      refusedImages, wanTask, falTask, rhTask, rhImageTasks, imagePromptEdited, videoPromptEdited, phoneId,
      imageEngine, nbModel, useCustomImageWorkflow, useCustomVideoWorkflow, sceneUsed, refsUsed, variantsOnce, enlarge, ...lastCfg
    } = parse(last?.config, {});
    const { phoneId: _phone, ...rest } = override || {};
    return { ...lastCfg, ...rest };
  };
  /** What a remake would pay now, and later (step by step), with the config it will run with. */
  const remakePrice = (x, override) => {
    const photo = !!x.media_type && x.media_type !== 'video';
    const raw = remakeConfig(x.id, photo ? 'photo' : 'video', override);
    const c = defaultConfig(raw);
    const noImage = !photo && (['wan27_edit', 'kling_edit'].includes(c.videoEngine) || !!raw.ownImage || (c.videoEngine === 'wan3_copy' && c.firstFrame === 'direct'));
    const unit = RH_FRAME_ENGINES.includes(c.frameEngine) ? 0 : IMAGE_EDITORS[c.frameEngine]?.cost(4) ?? estimateImageCost(c.nbModel, c.nbResolution);
    const images = noImage ? 0 : unit * c.variants * (photo && Array.isArray(raw.slides) && raw.slides.length ? raw.slides.length : 1);
    const video = photo ? 0 : estimateVideoCost(c.wanModel, c.wanResolution, Math.min(15, Math.max(2, Math.round(x.duration || 10))));
    const md = db.prepare('SELECT md.edit_n, md.edit_auto, md.edit_engine FROM remakes r JOIN models md ON md.id = r.model_id WHERE r.id = ?').get(x.id);
    const enlUnit = editEngineList().find((e) => e.key === (EDIT_ENGINE_KEYS.includes(md?.edit_engine) ? md.edit_engine : defaultEnlargeEngine()))?.cost ?? 0.045;
    const enl = photo || noImage ? 0 : Math.max(1, Math.min(4, Number(md?.edit_n) || 2)) * enlUnit;
    const autoEnl = md?.edit_auto && !photo && !noImage ? Math.max(1, Math.min(4, Number(md.edit_n) || 1)) * enlUnit : 0;
    return c.autoApprove ? { manual: false, now: images + video + autoEnl, later: 0 } : { manual: true, now: images, later: enl + video };
  };

  const startRemake = (remakeId, override = {}) => {
    const r = db.prepare('SELECT * FROM remakes WHERE id = ?').get(remakeId);
    if (!r) throw new HttpError(404, 'Remake not found');
    if (!r.model_id) throw new HttpError(400, 'Assign a model to this remake before generating');
    const m = db.prepare('SELECT * FROM models WHERE id = ?').get(r.model_id);
    if (!normalizeRefs(m?.ref_images).length) throw new HttpError(400, `Model ${m?.name} has no reference photos yet (go to Models)`);
    // Photo and carousel posts are remade as photos: the video pipeline would pay for the image and then fail.
    const reel = db.prepare('SELECT media_type FROM reels WHERE id = ?').get(r.reel_id);
    const kind = reel?.media_type && reel.media_type !== 'video' ? 'photo' : 'video';
    // Repeat the choices of this remake's last run, not the Setup defaults.
    const config = remakeConfig(r.id, kind, override);
    const s = getSettings();
    const cfg = defaultConfig(config);
    if (needsWaveSpeed(cfg, kind, config)) {
      if (!s.wavespeed_api_key) throw new HttpError(400, 'First paste the WaveSpeed API key in Settings → Pipeline');
    }
    return createGeneration(r.id, config, kind);
  };

  // "Gerar" / "Gerar de novo" from the remake queue.
  route('POST', '/api/remakes/:id/generate', async (req, { params }) => {
    const b = await readBody(req);
    if (b.dryRun) {
      // The queue's "Gerar": what this remake will pay, before it starts (it repeats its last run's choices).
      const x = db.prepare('SELECT m.id, r.media_type, r.duration FROM remakes m JOIN reels r ON r.id = m.reel_id WHERE m.id = ?').get(Number(params.id));
      if (!x) throw new HttpError(404, 'Remake not found');
      const p = remakePrice(x, b.config || {});
      return { manual: p.manual, estimate: Math.round(p.now * 100) / 100, later: Math.round(p.later * 100) / 100 };
    }
    return startRemake(params.id, b.config || {});
  });

  // "Gerar todos": the waiting remakes of one model (or the ids given), one confirmation. dryRun = only the count and
  // the estimate. Each starts exactly as its own "Gerar" would; the pipeline runs them N at a time (Em paralelo).
  const waitingRemakes = (modelId, ids) => db.prepare(`SELECT m.id, r.duration, r.media_type FROM remakes m JOIN reels r ON r.id = m.reel_id
    WHERE m.model_id = ? AND m.status != 'rejected'
      AND COALESCE((SELECT g.stage FROM generations g WHERE g.remake_id = m.id ORDER BY g.id DESC LIMIT 1), 'cancelled') = 'cancelled'
    ORDER BY m.created_at`).all(modelId).filter((x) => !ids || ids.includes(x.id));
  route('POST', '/api/remakes/generate-all', async (req) => {
    const b = await readBody(req);
    const modelId = Number(b.modelId);
    if (!modelId || !db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId)) throw new HttpError(400, 'Choose the model');
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : null;
    const list = waitingRemakes(modelId, ids);
    // One mode for the whole batch, the one the dialog shows: a remake whose last run was Automático is not Automático here.
    // Step by step only the swap images are paid now; the enlargement and the video come later, when you choose them.
    const batch = { ...(b.config || {}), autoApprove: !!defaultConfig(b.config || {}).autoApprove };
    const manual = !batch.autoApprove;
    const round = (x) => Math.round(x * 100) / 100;
    const prices = list.map((x) => remakePrice(x, batch)); // each priced with the config its own run will use
    const estimate = round(prices.reduce((a, p) => a + p.now, 0));
    const later = round(prices.reduce((a, p) => a + p.later, 0));
    if (b.dryRun) return { count: list.length, estimate, later, manual, parallel: Math.max(1, Math.min(4, Number(getSettings().pipeline_concurrency) || 1)) };
    const started = [];
    const skipped = [];
    for (const x of list) {
      try { started.push(startRemake(x.id, batch).id); } catch (e) { skipped.push({ id: x.id, error: e.message }); if (e.status === 400 && /API key|Gemini/.test(e.message)) break; }
    }
    return { started, skipped, estimate, later, manual };
  });

  // Perfis → "Ver o prompt de imagem": what a remake of hers would send with today's settings (nothing is generated).
  route('GET', '/api/models/:id/prompt-preview', (req, { params }) => {
    try { return previewImagePrompt({ modelId: Number(params.id) }); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });

  // "Editar imagem": one change to one of the project's images (preset or the user's words); a new image next to it.
  route('POST', '/api/generations/:id/edit-image', async (req, { params }) => {
    const b = await readBody(req);
    const preset = EDIT_PRESETS[b.preset];
    const change = String(b.change || '').trim() ? String(b.change).trim().slice(0, 1500) : preset ? preset.text : '';
    try {
      const made = await editCandidate(Number(params.id), { path: String(b.path || ''), change, engine: String(b.engine || ''), n: Number(b.n) || 1, workerId: req.worker?.id ?? null });
      return { ok: true, candidates: made, asked: Number(b.n) || 1 };
    } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });

  // The project in steps: 2 · escolher a troca, 3 · aumento, 4 · vídeo (runner.js explains each).
  const stepCall = (fn) => { try { return fn(); } catch (e) { throw new HttpError(e.status || 400, e.message); } };
  route('POST', '/api/generations/:id/pick', async (req, { params }) => {
    const b = await readBody(req);
    const r = stepCall(() => pickSwap(Number(params.id), String(b.path || ''), { skipEnlarge: !!b.skipEnlarge, workerId: req.worker?.id ?? null }));
    return { ok: true, enlarging: r.enlarging };
  });
  route('POST', '/api/generations/:id/enlarge', async (req, { params }) => {
    const b = await readBody(req);
    return stepCall(() => startEnlarge(Number(params.id), { prompt: b.prompt, engine: b.engine, n: b.n, more: b.more, workerId: req.worker?.id ?? null }));
  });
  route('POST', '/api/generations/:id/final', async (req, { params }) => {
    const b = await readBody(req);
    stepCall(() => pickFinal(Number(params.id), String(b.path || '')));
    return { ok: true };
  });
  route('POST', '/api/generations/:id/video', async (req, { params }) => {
    const b = await readBody(req);
    stepCall(() => startVideo(Number(params.id), { extra: b.extra, negative: b.negative }));
    return { ok: true };
  });

  // Step 6 · Final (Topaz): the price first, then the run (in the background), and its undo.
  route('GET', '/api/generations/:id/topaz', async (req, { params }) => {
    try { return await topazEstimate(Number(params.id)); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });
  route('POST', '/api/generations/:id/topaz', async (req, { params }) => {
    try { return await startTopaz(Number(params.id), { workerId: req.worker?.id ?? null }); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });
  route('POST', '/api/generations/:id/topaz/resume', async (req, { params }) => {
    try { return resumeTopaz(Number(params.id), { workerId: req.worker?.id ?? null }); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });
  route('POST', '/api/generations/:id/topaz/undo', async (req, { params }) => {
    stepCall(() => undoTopaz(Number(params.id)));
    return { ok: true };
  });

  route('POST', '/api/generations/:id/choose', async (req, { params }) => {
    const b = await readBody(req);
    try { chooseImage(Number(params.id), b.path); } catch (e) { throw new HttpError(400, e.message); }
    return { ok: true };
  });

  route('POST', '/api/generations/:id/retry', async (req, { params }) => {
    const b = await readBody(req);
    if (b.from && !['queued', 'imaging', 'animating'].includes(b.from)) throw new HttpError(400, 'Invalid step');
    if (b.from === 'imaging' && b.resetPrompt) db.prepare('UPDATE generations SET image_prompt = NULL WHERE id = ?').run(params.id);
    if (b.from === 'animating' && b.resetPrompt) db.prepare('UPDATE generations SET video_prompt = NULL WHERE id = ?').run(params.id);
    retryGeneration(Number(params.id), { from: b.from });
    return { ok: true };
  });

  route('POST', '/api/generations/:id/stage', async (req, { params }) => {
    const b = await readBody(req);
    if (!['approved', 'rejected', 'cancelled', 'review'].includes(b.stage)) throw new HttpError(400, 'Invalid status');
    setStage(Number(params.id), b.stage);
    return { ok: true };
  });

  route('PATCH', '/api/generations/:id', async (req, { params }) => {
    const b = await readBody(req);
    const g = getGeneration(Number(params.id));
    if (!g) throw new HttpError(404, 'Generation not found');
    // A running video is found again after a restart by its prompt and step-4 extras: they cannot change until it ends.
    const same = (x, y) => (String(x ?? '').trim() || null) === (String(y ?? '').trim() || null);
    const vidChange = (b.video_prompt !== undefined && !same(b.video_prompt, g.video_prompt))
      || ['videoExtra', 'videoNegative'].some((k) => b.config && k in b.config && !same(b.config[k], g.config[k]));
    if (vidChange && g.stage === 'animating') throw new HttpError(409, 'The video is being generated: change the video prompt and extras once it finishes.');
    if (b.image_prompt !== undefined) db.prepare('UPDATE generations SET image_prompt = ? WHERE id = ?').run(b.image_prompt || null, g.id);
    if (b.video_prompt !== undefined) db.prepare('UPDATE generations SET video_prompt = ? WHERE id = ?').run(b.video_prompt || null, g.id);
    const cfg = { ...g.config, ...(b.config || {}) };
    // An emptied prompt goes back to the app's own ("Repor o padrão", free: nothing is generated now).
    if (b.image_prompt !== undefined && !b.image_prompt) delete cfg.imagePromptEdited;
    if (b.video_prompt !== undefined && !b.video_prompt) delete cfg.videoPromptEdited;
    if (b.config || (b.image_prompt !== undefined && !b.image_prompt) || (b.video_prompt !== undefined && !b.video_prompt)) db.prepare('UPDATE generations SET config = ? WHERE id = ?').run(JSON.stringify(cfg), g.id);
    return { ok: true };
  });

  route('DELETE', '/api/generations/:id', (req, { params }) => {
    const g = getGeneration(Number(params.id));
    if (!g) return { ok: true };
    // The Topaz or an enlargement is writing to it: its result would come back to a project that no longer exists.
    if (isBusy(g.id)) throw new HttpError(409, 'This project is busy (Topaz or enlargement): wait for it to finish');
    // Scheduled or published posts use its files (same rule as removing a remake or a model).
    const posts = db.prepare("SELECT SUM(status = 'scheduled') s, SUM(status = 'posted') p FROM posts WHERE generation_id = ?").get(g.id);
    if (posts?.p) throw new HttpError(409, 'This project already has published posts: it is kept, so that history is not lost.');
    if (posts?.s) throw new HttpError(409, 'This project is scheduled: take it off the schedule first (Scheduled or Calendar).');
    db.prepare("UPDATE generations SET stage = 'cancelled' WHERE id = ?").run(g.id);
    g.candidates.forEach((c) => rmMedia(c.path));
    rmMedia(g.video_path);
    for (const k of ['untrimmedVideo', 'rawVideo']) if (g.config?.[k] && g.config[k] !== g.video_path) rmMedia(g.config[k]); // the uncut / unfinished copies
    for (const f of [g.config?.upscaled?.from, g.config?.upscaled?.untrimmed]) if (f && f !== g.video_path) rmMedia(f); // the video from before the Topaz
    db.prepare('DELETE FROM generations WHERE id = ?').run(g.id);
    return { ok: true };
  });

  // ---- pipeline status / workflows -----------------------------------------------------------
  route('GET', '/api/pipeline/status', async (req, { query }) => {
    const s = getSettings();
    const wavespeed = await wsStatus(s, query.get('fresh') === '1');
    const counts = Object.fromEntries(db.prepare('SELECT stage, COUNT(*) n FROM generations GROUP BY stage').all().map((r) => [r.stage, r.n]));
    const spent = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM generations').get().s;
    return {
      wavespeed,
      gemini: { apiKey: !!s.gemini_api_key },
      counts, spentUsd: spent,
      checkedAt: wsc.at,
      lowThreshold: lowBalanceThreshold(), // same rule as the red chip at the top
    };
  });

  // Test a connection before saving it (key may be typed but not stored yet).
  route('POST', '/api/pipeline/test-comfy', async (req) => {
    const b = await readBody(req);
    const s = getSettings();
    const client = new ComfyClient({ mode: b.mode || s.comfy_mode, url: b.url || s.comfy_url, apiKey: b.apiKey || s.comfy_api_key });
    const { info, nodes } = await checkComfy(client);
    return { ...info, nodes, mode: client.mode, url: client.base, apiKey: !!client.apiKey };
  });

  // End-to-end check without partner nodes (no credits): upload → LoadImage → SaveImage → download.
  route('POST', '/api/pipeline/smoke-test', async () => {
    const s0 = getSettings();
    if (s0.comfy_mode === 'api') {
      const t0 = Date.now();
      try {
        const api = new ComfyApi(s0.comfy_api_key);
        const { usd } = await api.balance();
        const url = await api.upload(Buffer.from('reels-radar smoke test'), 'text/plain', 'txt');
        return { ok: true, ms: Date.now() - t0, mode: 'api', steps: [`balance $${usd.toFixed(3)}`, `upload ok (${new URL(url).host})`, usd < 0.1 ? 'WARNING: no credits to generate' : 'ready to generate'] };
      } catch (e) { return { ok: false, ms: Date.now() - t0, mode: 'api', steps: [], error: e.message }; }
    }
    const client = ComfyClient.fromSettings(s0);
    const thumbs = path.join(MEDIA_DIR, 'thumbs');
    const f = fs.existsSync(thumbs) && fs.readdirSync(thumbs).find((x) => /\.jpe?g$/i.test(x));
    if (!f) throw new HttpError(400, 'At least one reel with a thumbnail is needed for the test');
    const t0 = Date.now();
    const steps = [];
    try {
      const buf = fs.readFileSync(path.join(thumbs, f));
      const name = await client.upload(buf, `rr_smoke_${Date.now()}.jpg`, 'image/jpeg');
      steps.push(`upload ok (${name})`);
      const wf = { 1: { class_type: 'LoadImage', inputs: { image: name } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'reels-radar/smoke' } } };
      const r = await client.run(wf, { exts: ['.png', '.jpg'], timeoutMs: 5 * 60e3, onProgress: (m) => steps.push(m) });
      steps.push(`download ok (${r.buffer.length} bytes)`);
      return { ok: true, ms: Date.now() - t0, steps, mode: client.mode };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, steps, error: e.message, mode: client.mode };
    }
  });

  route('GET', '/api/pipeline/estimate', (req, { query }) => {
    const cfg = defaultConfig();
    const reel = Number(query.get('seconds')) || 10;
    const image = estimateImageCost(cfg.nbModel, cfg.nbResolution, cfg.variants);
    const animate = cfg.videoEngine === 'animate_replace';
    const secs = animate ? reel : Math.min(15, Math.max(2, reel)); // the exact copy uses at most 15 s of the reel
    const video = animate ? estimateAnimateCost(secs, cfg.wanResolution === '480P' ? '480p' : '720p') : estimateVideoCost(cfg.wanModel, cfg.wanResolution, secs);
    return { config: cfg, seconds: secs, image, video, total: image + video };
  });

  const importedList = () => parse(getSettings().imported_workflows, []);

  route('GET', '/api/pipeline/workflows', () => {
    const s = getSettings();
    const out = {
      builtin: Object.fromEntries(Object.entries(EXAMPLES).map(([k, fn]) => { const wf = fn(); return [k, { json: wf, graph: describeWorkflow(wf) }]; })),
      custom: {},
      imported: importedList().map(({ api, ...x }) => ({ ...x, graph: describeWorkflow(api), inputs: mappableInputs(api), suggested: { image: suggestMapping(api, 'image'), video: suggestMapping(api, 'video') } })),
      variables: VARIABLES,
      placeholders: PLACEHOLDERS,
      required: REQUIRED_NODES,
      nodeDocs: NODES,
    };
    for (const kind of ['image', 'video']) {
      const wf = parse(s[`custom_workflow_${kind}`], null);
      if (wf) out.custom[kind] = { json: wf, graph: describeWorkflow(wf), info: validateApiWorkflow(wf), mapping: parse(s[`custom_mapping_${kind}`], {}), inputs: mappableInputs(wf), name: s[`custom_name_${kind}`] || 'custom workflow' };
    }
    return out;
  });

  /** Accept a workflow in UI or API format, convert if needed, remember it in the imported list. */
  async function importWorkflow(wf, name, source) {
    let api = wf;
    let warnings = [];
    if (isUiWorkflow(wf)) {
      const s = getSettings();
      const classes = [...new Set((wf.nodes || []).map((n) => n.type))];
      let info = {};
      for (const client of [ComfyClient.fromSettings(s), ...(s.comfy_api_key ? [new ComfyClient({ mode: 'cloud', apiKey: s.comfy_api_key })] : [])]) {
        info = { ...(await client.objectInfo(classes).catch(() => ({}))), ...info };
        if (classes.every((c) => info[c])) break;
      }
      ({ api, warnings } = uiToApi(wf, info));
    }
    const v = validateApiWorkflow(api);
    const entry = { id: `wf${Date.now()}`, name: String(name || 'workflow').slice(0, 80), source, created_at: now(), warnings, classes: v.classes, nodeCount: v.nodeCount, api };
    setSetting('imported_workflows', JSON.stringify([entry, ...importedList()].slice(0, 20)));
    return entry;
  }

  // Import from a Comfy Cloud share link (https://cloud.comfy.org/?share=…) or a raw id.
  route('POST', '/api/pipeline/import-share', async (req) => {
    const b = await readBody(req);
    const m = String(b.link || '').match(/[?&]share=([A-Za-z0-9_-]+)/) || String(b.link || '').trim().match(/^([A-Za-z0-9_-]{6,})$/);
    if (!m) throw new HttpError(400, 'Invalid link — expected https://cloud.comfy.org/?share=…');
    const s = getSettings();
    let shared;
    try { shared = await ComfyClient.sharedWorkflow(m[1], s.comfy_api_key); } catch (e) { throw new HttpError(400, e.message); }
    const entry = await importWorkflow(shared.workflow, shared.name, `share:${m[1]}`);
    return { ...entry, api: undefined, suggested: { image: suggestMapping(entry.api, 'image'), video: suggestMapping(entry.api, 'video') } };
  });

  route('POST', '/api/pipeline/import-json', async (req) => {
    const b = await readBody(req);
    let wf = b.workflow;
    if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    try {
      const entry = await importWorkflow(wf, b.name, 'file');
      return { ...entry, api: undefined };
    } catch (e) { throw new HttpError(400, e.message); }
  });

  route('DELETE', '/api/pipeline/imported/:id', (req, { params }) => {
    setSetting('imported_workflows', JSON.stringify(importedList().filter((w) => w.id !== params.id)));
    return { ok: true };
  });

  // Use a workflow for a stage: { importedId, mapping } or { workflow (API json), mapping }
  route('PUT', '/api/pipeline/workflows/:kind', async (req, { params }) => {
    if (!['image', 'video'].includes(params.kind)) throw new HttpError(400, 'Invalid type');
    const b = await readBody(req);
    let wf = b.workflow;
    let name = b.name || 'custom workflow';
    if (b.importedId) {
      const e = importedList().find((w) => w.id === b.importedId);
      if (!e) throw new HttpError(404, 'Imported workflow not found');
      wf = e.api; name = e.name;
    } else if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    if (!wf) {
      // Only updating the mapping of the active workflow.
      if (!getSettings()[`custom_workflow_${params.kind}`]) throw new HttpError(400, 'No active workflow');
      setSetting(`custom_mapping_${params.kind}`, JSON.stringify(b.mapping || {}));
      return { ok: true };
    }
    if (isUiWorkflow(wf)) {
      const e = await importWorkflow(wf, name, 'file');
      wf = e.api;
    }
    let info;
    try { info = validateApiWorkflow(wf); } catch (e) { throw new HttpError(400, e.message); }
    const mapping = b.mapping || suggestMapping(wf, params.kind);
    setSetting(`custom_workflow_${params.kind}`, JSON.stringify(wf));
    setSetting(`custom_mapping_${params.kind}`, JSON.stringify(mapping));
    setSetting(`custom_name_${params.kind}`, name);
    return { ok: true, info, mapping };
  });

  route('DELETE', '/api/pipeline/workflows/:kind', (req, { params }) => {
    setSetting(`custom_workflow_${params.kind}`, '');
    setSetting(`custom_mapping_${params.kind}`, '');
    return { ok: true };
  });

  kick();
  // Warm the WaveSpeed status now, so the first visit to Remake/Projetos doesn't wait for its balance.
  setTimeout(() => { wsStatus(getSettings()).catch(() => {}); }, 0);
}
