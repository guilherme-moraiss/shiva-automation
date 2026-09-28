import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, MEDIA_DIR } from '../db.js';
import { route, readBody, HttpError, decodeDataUrl } from '../http.js';
import { normalizeRefs, slug } from './modelpack.js';
import { Fal, FalError, makeZip } from './fal.js';
import { RH_WORKFLOWS, RH_ADULT_ENGINES, RH_ADULT_TOOLS, rhReady, runRhSky, runRhImage } from './rhworkflows.js';
import { RunningHubError } from './runninghub.js';
import { maskIntoAlpha } from '../ffmpeg.js';
import { recordCost, rhCurrency } from '../costs.js';

/**
 * Spicy (UI: "Conteúdo 18+"): adult (18+) content of the app's FICTIONAL AI models, on open-weight models via fal.ai.
 *   1. train  — a Z-Image Turbo LoRA from the model's own folder (her identity)
 *   2. image  — Z-Image Turbo + her LoRA, text-to-image or image-to-image from one of HER photos
 *   3. video  — Wan 2.2 A14B image-to-video from one of HER photos
 *   + the user's own workflows on RunningHub (SKY 18+, INSTARAW zImage / SDXL combos from one of HER photos, and the
 *     Detailing / Inpainting tools on one of HER images)
 *
 * Hard rules (enforced here, not only in the UI):
 *   - inputs are only the model's own photos/outputs — never scraped reels/frames of real creators, never uploads
 *   - prompts that sexualise minors or name a tracked real creator are refused
 *   - every prompt pins her as an adult woman
 *   - LoRA training needs an explicit confirmation that her face is AI-generated (not a real person)
 */

const SPICY_DIR = 'spicy';
fs.mkdirSync(path.join(MEDIA_DIR, SPICY_DIR), { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS spicy_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- train | image | video
  stage TEXT NOT NULL DEFAULT 'queued',    -- queued | running | review | approved | failed | cancelled
  config TEXT NOT NULL DEFAULT '{}',
  prompt TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  fal TEXT,                                -- queued fal request (resume after restart without paying twice)
  step_status TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spicy_jobs_stage ON spicy_jobs(stage);
CREATE INDEX IF NOT EXISTS spicy_jobs_model ON spicy_jobs(model_id, kind);
`);
const addColumn = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumn('models', 'lora_url', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'lora_trigger', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'lora_images', 'INTEGER NOT NULL DEFAULT 0');
addColumn('models', 'lora_at', 'INTEGER');
addColumn('models', 'ai_face_confirmed', 'INTEGER NOT NULL DEFAULT 0');

// ---- endpoints + prices (fal.ai, approximate — the fal dashboard has the real bill) -------------
export const EP = {
  train: 'fal-ai/z-image-trainer',
  t2i: 'fal-ai/z-image/turbo/lora',
  i2i: 'fal-ai/z-image/turbo/image-to-image/lora',
  i2v: 'fal-ai/wan/v2.2-a14b/image-to-video',
  i2vLora: 'fal-ai/wan/v2.2-a14b/image-to-video/lora',
};
const PRICE = { trainPer1k: 2.26, image: 0.012, videoPerSec: { '480p': 0.04, '580p': 0.06, '720p': 0.08 } };
const SIZES = { '4:5': { width: 1024, height: 1280 }, '9:16': { width: 864, height: 1536 }, '3:4': { width: 960, height: 1280 }, '1:1': { width: 1152, height: 1152 } };
const DURATIONS = { 5: 81, 8: 129, 10: 161 }; // seconds → frames at 16 fps

// ---- presets: scene (where/how) × level (how much) -------------------------------------------------
// icon = name of a line icon in public/icons.js (the UI draws it; no emoji).
export const SCENES = [
  { key: 'mirror', label: 'Mirror selfie', icon: 'mirror', text: 'mirror selfie in her bedroom, holding her phone in front of a full-length mirror, standing with one hip out, soft warm lamp light' },
  { key: 'bed', label: 'In bed', icon: 'bed', text: 'lying on her bed on soft white sheets, propped on one elbow, looking at the camera, soft morning window light, photo taken from slightly above' },
  { key: 'pov', label: 'POV selfie', icon: 'smartphone', text: 'front-camera selfie at arm\'s length, slight high angle, lying back on the pillows, playful smile' },
  { key: 'kneel', label: 'Kneeling on the bed', icon: 'bed', text: 'kneeling on her bed facing the camera, hands resting on her thighs, warm bedside lamp light' },
  { key: 'behind', label: 'From behind', icon: 'user', text: 'standing by the window seen from behind, looking back over her shoulder at the camera, golden hour light' },
  { key: 'shower', label: 'Shower', icon: 'droplet', text: 'in a steamy glass shower, wet hair and wet glistening skin, water droplets, soft bathroom light' },
  { key: 'bath', label: 'Bathtub', icon: 'bath', text: 'relaxing in a bathtub with bubbles, candles around, warm cosy light' },
  { key: 'couch', label: 'Couch', icon: 'sofa', text: 'sitting on the couch in her living room, legs crossed, evening lamp light, candid photo' },
  { key: 'beach', label: 'Beach', icon: 'sun', text: 'on a sunny secluded beach at golden hour, ocean in the background' },
  { key: 'custom', label: 'Custom', icon: 'edit', text: '' },
];
export const LEVELS = [
  { key: 1, label: 'Suggestive', hint: 'lingerie / bikini', text: 'wearing a matching lace lingerie set, no nudity' },
  { key: 2, label: 'Topless', hint: 'panties only', text: 'topless, bare breasts visible, wearing only panties' },
  { key: 3, label: 'Nude', hint: 'fully nude', text: 'fully nude, natural adult body' },
  { key: 4, label: 'Explicit', hint: 'nude, explicit pose', text: 'fully nude, explicit sensual pose' },
];

// ---- guardrails ---------------------------------------------------------------------------------
const MINOR_RE = /\b(teens?|teenager|teenage|underage|under-age|minors?|child|children|childlike|child-like|kids?|little girl|young girl|schoolgirl|school girl|school uniform|high ?school|middle school|loli|lolita|shota|jailbait|barely legal|pre-?teen|infant|toddler|babyface|baby face|daughter|niece|little sister|(?:1[0-7]|[1-9]) ?(?:yo|y\/o|years? old|-year-old)|menina|menininha|adolescente|crian[çc]a|novinha|colegial|menor(?:es)? de idade|escola)\b/i;
const REAL_RE = /\b(celebrity|celeb|famous|lookalike|look-alike|deepfake|face ?swap|real person)\b|@\w{2,}/i;

let creatorNames = { at: 0, list: [] };
function trackedCreators() {
  if (Date.now() - creatorNames.at > 60_000) {
    const rows = db.prepare('SELECT handle, display_name FROM creators').all();
    const names = new Set();
    for (const r of rows) {
      for (const v of [r.handle, r.display_name]) {
        const s = String(v || '').trim().toLowerCase();
        if (s.length >= 4) names.add(s);
      }
    }
    creatorNames = { at: Date.now(), list: [...names] };
  }
  return creatorNames.list;
}

export function checkPrompt(text) {
  const t = String(text || '');
  if (MINOR_RE.test(t)) throw new HttpError(400, 'Refused: the text suggests a minor. 18+ content is for adult women only.');
  if (REAL_RE.test(t)) throw new HttpError(400, 'Refused: 18+ content cannot refer to real people (celebrities, @handles, lookalikes, face swap).');
  const low = t.toLowerCase();
  const hit = trackedCreators().find((n) => new RegExp(`(^|[^\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'u').test(low));
  if (hit) throw new HttpError(400, `Refused: "${hit}" is a real creator tracked in the app. 18+ content is only for your AI models.`);
}

/** Age from the persona ("22-year-old …"). Refuses anything under 18; defaults to an adult in her twenties. */
function adultAge(model) {
  const m = String(model.persona || '').match(/(\d{1,2})\s*(?:-|\s)?\s*(?:years?[- ]old|y\/?o|anos)/i);
  const age = m ? Number(m[1]) : null;
  if (age !== null && age < 18) throw new HttpError(400, "This model's persona is under 18: 18+ content refused.");
  return age && age >= 18 ? `${age}-year-old` : 'mid-twenties';
}

// ---- helpers ----------------------------------------------------------------------------------
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const getModel = (id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id);
const getJob = (id) => db.prepare('SELECT * FROM spicy_jobs WHERE id = ?').get(id);
const exists = (rel) => rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));
const falClient = () => new Fal(getSettings().fal_api_key);
const upd = (id, f) => {
  const k = Object.keys(f);
  db.prepare(`UPDATE spicy_jobs SET ${k.map((x) => `${x} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...k.map((x) => (f[x] !== null && typeof f[x] === 'object' ? JSON.stringify(f[x]) : f[x])), now(), id);
};
const cancelled = (id) => ['cancelled', undefined].includes(getJob(id)?.stage);

export function triggerWord(model) {
  return `${slug(model.name).replace(/-/g, '')}ofm`;
}

/** Every image the model owns: her folder, her Studio creations, her Spicy images. Nothing scraped. */
function ownImages(modelId) {
  const m = getModel(modelId);
  const set = new Set(normalizeRefs(m?.ref_images).map((r) => r.path));
  for (const c of db.prepare('SELECT candidates FROM creations WHERE model_id = ?').all(modelId)) parse(c.candidates, []).forEach((x) => x?.path && set.add(x.path));
  for (const j of db.prepare("SELECT outputs FROM spicy_jobs WHERE model_id = ? AND kind = 'image'").all(modelId)) parse(j.outputs, []).forEach((x) => x?.path && set.add(x.path));
  return set;
}

function identityText(model) {
  const p = parse(model.profile, null) || {};
  const none = (v) => !v || /^none$|^no\b|^n\/a$/i.test(String(v).trim());
  return [
    p.hair && `hair: ${p.hair}`, p.eyes && `eyes: ${p.eyes}`, p.skin && `skin: ${p.skin}`,
    !none(p.face_marks) && p.face_marks,
    none(p.tattoos) ? 'no tattoos' : `tattoos: ${p.tattoos}`,
  ].filter(Boolean).join(', ');
}

export function buildSpicyPrompt({ model, scene, level, text }) {
  const tw = model.lora_trigger || triggerWord(model);
  const sc = SCENES.find((s) => s.key === scene);
  const lv = LEVELS.find((l) => l.key === Number(level)) || LEVELS[0];
  const body = String(model.body || '').trim().replace(/\.$/, '');
  const rules = String(model.rules || '').trim().replace(/\s*\n+\s*/g, '; ').replace(/\.$/, '');
  return [
    `Photo of ${tw}, a ${adultAge(model)} adult woman.`,
    identityText(model) && `${identityText(model)}.`,
    body && `Her body: ${body}.`,
    rules && `Always: ${rules}.`,
    `She is ${lv.text}.`,
    sc?.text && `Scene: ${sc.text}.`,
    text && `${String(text).trim().replace(/\.$/, '')}.`,
    'Authentic amateur smartphone photo, photorealistic, natural skin texture with visible pores, realistic lighting, slight grain, candid, one person only, no text, no watermark.',
  ].filter(Boolean).join(' ');
}

// ---- workers ------------------------------------------------------------------------------------
const CAPTION = {
  face_front: 'close-up portrait photo of {tw}, a woman, looking at the camera',
  face_left: 'close-up photo of {tw}, a woman, three-quarter view from the left',
  face_right: 'close-up photo of {tw}, a woman, three-quarter view from the right',
  face_profile: 'profile photo of {tw}, a woman, side view of her face',
  face_smile: 'close-up photo of {tw}, a woman, smiling',
  body_front: 'full body photo of {tw}, a woman, standing, front view',
  body_side: 'full body photo of {tw}, a woman, standing, side view',
  body_back: 'full body photo of {tw}, a woman, standing, seen from behind',
  body_half: 'half body photo of {tw}, a woman',
};

function datasetFor(model) {
  const refs = normalizeRefs(model.ref_images).filter((r) => exists(r.path));
  return refs.slice(0, 40);
}

async function runTrain(job, fal, log) {
  const cfg = parse(job.config, {});
  const model = getModel(job.model_id);
  if (!model) throw new Error('Model not found');
  const tw = triggerWord(model);
  let pending = parse(job.fal, null);
  if (!pending) {
    const refs = datasetFor(model);
    if (refs.length < 8) throw new Error(`There are only ${refs.length} photos in ${model.name}'s folder. At least 8 are needed (ideally 15–30).`);
    log(`Preparing the dataset (${refs.length} photos)…`);
    const entries = [];
    refs.forEach((r, i) => {
      const ext = path.extname(r.path).toLowerCase();
      const base = `${String(i + 1).padStart(2, '0')}_${r.kind}`;
      entries.push({ name: `${base}${ext}`, data: fs.readFileSync(path.join(MEDIA_DIR, r.path)) });
      entries.push({ name: `${base}.txt`, data: (CAPTION[r.kind] || 'photo of {tw}, a woman').replace('{tw}', tw) });
    });
    log('Uploading the dataset to fal.ai…');
    const url = await fal.uploadBuffer(makeZip(entries), `${slug(model.name)}_dataset.zip`, 'application/zip');
    if (cancelled(job.id)) return;
    pending = await fal.submit(EP.train, {
      image_data_url: url, steps: cfg.steps, learning_rate: 0.0001, training_type: 'content', default_caption: `photo of ${tw}, a woman`,
    });
    upd(job.id, { fal: pending, cost_usd: (cfg.steps / 1000) * PRICE.trainPer1k });
    recordCost({ amount: (cfg.steps / 1000) * PRICE.trainPer1k, provider: 'fal', category: 'treino', spicyJobId: job.id, modelId: job.model_id });
    db.prepare('UPDATE models SET lora_images = ? WHERE id = ?').run(refs.length, model.id);
  }
  log('Training the LoRA (usually takes 10–30 min)…');
  const out = await fal.wait(pending, { onStatus: log, isCancelled: () => cancelled(job.id), intervalMs: 10_000, maxMs: 3 * 3600_000 });
  const url = out?.diffusers_lora_file?.url;
  if (!url) throw new Error('fal.ai finished but did not return the LoRA file');
  db.prepare('UPDATE models SET lora_url = ?, lora_trigger = ?, lora_at = ? WHERE id = ?').run(url, tw, now(), model.id);
  upd(job.id, { stage: 'approved', outputs: [{ type: 'lora', url }], error: null });
  log(`LoRA ready. Trigger word: ${tw}`);
}

const RH_NEGATIVE = 'child, teen, underage, minor, childlike, extra people, deformed, extra fingers, text, watermark, low quality';

/**
 * Her own photo through one of her RunningHub workflows (cfg.engine): the 18+ generators or a tool (Detailing,
 * Inpainting). One task per variant; tasks and finished images are saved on the job, so a restart resumes them.
 */
async function runRhSpicy(job, cfg, model, log) {
  const s = getSettings();
  const key = cfg.engine;
  const state = parse(job.fal, null)?.rh || { tasks: {}, done: [] };
  const save = () => upd(job.id, { fal: { rh: state } });
  const src = path.join(MEDIA_DIR, cfg.source);
  if (!exists(cfg.source)) throw new Error('The base photo no longer exists');
  let image = { buf: fs.readFileSync(src), name: `photo${path.extname(cfg.source) || '.png'}` };
  if (key === 'inpaint') {
    if (!exists(cfg.mask)) throw new Error('The painted area no longer exists: paint it again');
    log('Preparing the painted area…');
    image = { buf: await maskIntoAlpha(src, path.join(MEDIA_DIR, cfg.mask)), name: 'area.png' };
  }
  const n = Math.max(1, Math.min(4, Number(cfg.n) || 1));
  for (let i = 0; i < n; i++) {
    if (cancelled(job.id)) return;
    if (state.done.some((d) => d.slot === i)) continue;
    const slot = String(i);
    const common = {
      s, task: state.tasks[slot] || null,
      onTask: (t) => { state.tasks[slot] = t; save(); },
      onStatus: (m) => log(n > 1 ? `Image ${i + 1}/${n}: ${m}` : m), isCancelled: () => cancelled(job.id),
    };
    const r = key === 'sky_nsfw'
      ? await runRhSky({ ...common, model, source: image, prompt: String(job.prompt || '').replace(/^Photo of \S+, /, ''), nsfw: true })
      : await runRhImage({ ...common, key, image, prompt: key === 'detailing' ? undefined : job.prompt, negative: RH_NEGATIVE });
    for (const [k, f] of r.files.entries()) {
      const rel = `${SPICY_DIR}/s${job.id}_${Date.now()}_${i}${k ? `_${k}` : ''}.${f.ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), f.buf);
      state.done.push({ slot: i, type: 'image', path: rel, engine: key, from: cfg.source });
    }
    delete state.tasks[slot];
    save();
    if (r.cost) log(r.cost);
    if (r.money) recordCost({ amount: r.money, currency: rhCurrency(), provider: 'runninghub', category: 'adulto', spicyJobId: job.id, modelId: job.model_id, estimated: false });
  }
  const outputs = state.done.map(({ slot, ...o }) => o);
  if (!outputs.length) throw new RunningHubError('RunningHub returned no images');
  upd(job.id, { stage: 'review', outputs, error: null, fal: null });
  log(`${outputs.length} image(s) ready · ${RH_WORKFLOWS[key].name}`);
}

async function runImage(job, fal, log) {
  const cfg = parse(job.config, {});
  const model = getModel(job.model_id);
  if (cfg.engine && cfg.engine !== 'fal') return runRhSpicy(job, cfg, model, log);
  if (!model?.lora_url) throw new Error('This model has no trained LoRA yet');
  let pending = parse(job.fal, null);
  if (!pending) {
    const loras = [{ path: model.lora_url, scale: cfg.loraScale }];
    const base = {
      prompt: job.prompt, num_images: cfg.n, num_inference_steps: cfg.steps, enable_safety_checker: false,
      output_format: 'png', acceleration: 'regular', loras, ...(cfg.seed ? { seed: cfg.seed } : {}),
    };
    if (cfg.source) {
      log('Uploading the base photo…');
      const image_url = await fal.uploadFile(path.join(MEDIA_DIR, cfg.source));
      pending = await fal.submit(EP.i2i, { ...base, image_url, strength: cfg.strength, image_size: 'auto' });
    } else {
      pending = await fal.submit(EP.t2i, { ...base, image_size: SIZES[cfg.aspect] || SIZES['4:5'] });
    }
    upd(job.id, { fal: pending, cost_usd: cfg.n * PRICE.image });
    recordCost({ amount: cfg.n * PRICE.image, provider: 'fal', category: 'adulto', spicyJobId: job.id, modelId: job.model_id });
  }
  const out = await fal.wait(pending, { onStatus: log, isCancelled: () => cancelled(job.id) });
  const imgs = out?.images || [];
  if (!imgs.length) throw new Error('fal.ai returned no images');
  const saved = [];
  for (const [i, im] of imgs.entries()) {
    const ext = /jpe?g/.test(im.content_type || '') ? 'jpg' : 'png';
    const rel = `${SPICY_DIR}/s${job.id}_${Date.now()}_${i}.${ext}`;
    await Fal.download(im.url, path.join(MEDIA_DIR, rel));
    saved.push({ type: 'image', path: rel, seed: out.seed, width: im.width, height: im.height });
  }
  upd(job.id, { stage: 'review', outputs: saved, error: null });
  log(`${saved.length} image(s) ready`);
}

async function runVideo(job, fal, log) {
  const cfg = parse(job.config, {});
  let pending = parse(job.fal, null);
  if (!pending) {
    log('Uploading the image…');
    const image_url = await fal.uploadFile(path.join(MEDIA_DIR, cfg.source));
    const loras = (cfg.loras || []).map((l) => ({ path: l.url, scale: l.scale, transformer: 'both' }));
    pending = await fal.submit(loras.length ? EP.i2vLora : EP.i2v, {
      image_url, prompt: job.prompt, negative_prompt: 'blurry, distorted face, face morphing, identity change, extra limbs, extra people, text, watermark, child, teen',
      num_frames: DURATIONS[cfg.seconds] || 81, frames_per_second: 16, resolution: cfg.resolution, aspect_ratio: 'auto',
      enable_safety_checker: false, enable_output_safety_checker: false, enable_prompt_expansion: false,
      ...(loras.length ? { loras } : {}), ...(cfg.seed ? { seed: cfg.seed } : {}),
    });
    upd(job.id, { fal: pending, cost_usd: cfg.seconds * (PRICE.videoPerSec[cfg.resolution] || 0.08) });
    recordCost({ amount: cfg.seconds * (PRICE.videoPerSec[cfg.resolution] || 0.08), provider: 'fal', category: 'adulto', spicyJobId: job.id, modelId: job.model_id });
  }
  log('Animating with Wan 2.2 (usually takes 2–6 min)…');
  const out = await fal.wait(pending, { onStatus: log, isCancelled: () => cancelled(job.id), intervalMs: 5000 });
  const url = out?.video?.url;
  if (!url) throw new Error('fal.ai returned no video');
  const rel = `${SPICY_DIR}/v${job.id}_${Date.now()}.mp4`;
  await Fal.download(url, path.join(MEDIA_DIR, rel));
  upd(job.id, { stage: 'review', outputs: [{ type: 'video', path: rel, poster: cfg.source, seed: out.seed }], error: null });
  log('Video ready');
}

const RUN = { train: runTrain, image: runImage, video: runVideo };
const busy = { train: false, gen: 0 };
const GEN_LANES = 2;

async function runJob(job) {
  const log = (msg) => upd(job.id, { step_status: msg });
  upd(job.id, { stage: 'running', error: null });
  try {
    // Jobs on her RunningHub workflows never touch fal.ai (and must not need its key).
    const engine = parse(job.config, {}).engine;
    await RUN[job.kind](job, engine && engine !== 'fal' ? null : falClient(), log);
  } catch (e) {
    if (cancelled(job.id)) return;
    const msg = e instanceof FalError || e instanceof HttpError || e instanceof RunningHubError ? e.message : `Error: ${e.message}`;
    upd(job.id, { stage: 'failed', error: msg, step_status: /^(?:Erro|Error)\b/.test(msg) ? msg : `Error: ${msg}` });
    // A request that fal / RunningHub rejected must not be resumed on retry (finished RunningHub images are kept).
    const rh = parse(getJob(job.id)?.fal, null)?.rh;
    upd(job.id, { fal: rh ? { rh: { tasks: {}, done: rh.done || [] } } : null });
  }
}

function tick() {
  if (!busy.train) {
    const j = db.prepare("SELECT * FROM spicy_jobs WHERE stage = 'queued' AND kind = 'train' ORDER BY id LIMIT 1").get();
    if (j) { busy.train = true; runJob(j).finally(() => { busy.train = false; setTimeout(tick, 100); }); }
  }
  while (busy.gen < GEN_LANES) {
    const j = db.prepare("SELECT * FROM spicy_jobs WHERE stage = 'queued' AND kind != 'train' ORDER BY id LIMIT 1").get();
    if (!j) break;
    busy.gen++;
    upd(j.id, { stage: 'running' }); // claim before the async run so the loop doesn't pick it twice
    runJob(j).finally(() => { busy.gen--; setTimeout(tick, 100); });
  }
}

export function startSpicyWorker() {
  db.prepare("UPDATE spicy_jobs SET stage = 'queued' WHERE stage = 'running'").run(); // resume (the stored fal request is reused)
  setInterval(tick, 3000).unref();
  setTimeout(tick, 800);
}

// ---- routes -------------------------------------------------------------------------------------
const jobRow = (j) => ({ ...j, config: parse(j.config, {}), outputs: parse(j.outputs, []), fal: undefined });

export function registerSpicyRoutes() {
  route('GET', '/api/spicy/meta', () => {
    const s = getSettings();
    const rh = (k) => ({ key: k, name: RH_WORKFLOWS[k].name, desc: RH_WORKFLOWS[k].desc, ready: rhReady(s, k) });
    return {
      falKey: !!s.fal_api_key, scenes: SCENES, levels: LEVELS, price: PRICE, sizes: Object.keys(SIZES), durations: Object.keys(DURATIONS).map(Number),
      rhEngines: RH_ADULT_ENGINES.map(rh), rhTools: RH_ADULT_TOOLS.map(rh),
    };
  });

  route('GET', '/api/spicy/models', () => db.prepare('SELECT * FROM models ORDER BY name').all().map((m) => {
    const refs = normalizeRefs(m.ref_images);
    const training = db.prepare("SELECT id, stage, step_status, error, created_at FROM spicy_jobs WHERE model_id = ? AND kind = 'train' ORDER BY id DESC LIMIT 1").get(m.id) || null;
    return {
      id: m.id, name: m.name, color: m.color, persona: m.persona, refs, dataset: datasetFor(m).length,
      lora: m.lora_url ? { trigger: m.lora_trigger, at: m.lora_at, images: m.lora_images } : null,
      rhLora: !!m.rh_lora, aiFaceConfirmed: !!m.ai_face_confirmed, training,
    };
  }));

  // Images the model owns (usable as i2i base or video first frame).
  route('GET', '/api/spicy/models/:id/images', (req, { params }) => {
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    return [...ownImages(m.id)].filter(exists).reverse();
  });

  route('POST', '/api/spicy/models/:id/train', async (req, { params }) => {
    const b = await readBody(req);
    const m = getModel(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    if (!getSettings().fal_api_key) throw new HttpError(400, 'The fal.ai API key is missing');
    if (!b.confirmAiFace) throw new HttpError(400, "Confirm that this model's face was generated by AI and is not a real person's.");
    adultAge(m);
    const n = datasetFor(m).length;
    if (n < 8) throw new HttpError(400, `There are only ${n} photos in ${m.name}'s folder. At least 8 are needed (ideally 15–30): generate more in Create content and use "Save to folder".`);
    if (db.prepare("SELECT 1 FROM spicy_jobs WHERE model_id = ? AND kind = 'train' AND stage IN ('queued','running')").get(m.id)) throw new HttpError(409, 'A LoRA training is already running for this model');
    db.prepare('UPDATE models SET ai_face_confirmed = 1 WHERE id = ?').run(m.id);
    const steps = [500, 1000, 1500, 2000].includes(Number(b.steps)) ? Number(b.steps) : 1000;
    const t = now();
    const j = db.prepare('INSERT INTO spicy_jobs (model_id, kind, stage, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(m.id, 'train', 'queued', JSON.stringify({ steps }), t, t);
    setTimeout(tick, 50);
    return jobRow(j);
  });

  route('POST', '/api/spicy/preview-prompt', async (req) => {
    const b = await readBody(req);
    const m = getModel(b.modelId);
    if (!m) throw new HttpError(404, 'Model not found');
    return { prompt: buildSpicyPrompt({ model: m, scene: b.scene, level: b.level, text: b.text }) };
  });

  route('POST', '/api/spicy/images', async (req) => {
    const b = await readBody(req);
    const m = getModel(b.modelId);
    if (!m) throw new HttpError(404, 'Choose the model');
    const text = String(b.text || '').slice(0, 1200);
    checkPrompt(text);
    const engine = b.engine && b.engine !== 'fal' ? String(b.engine) : 'fal';
    if (engine !== 'fal' && !RH_ADULT_ENGINES.includes(engine)) throw new HttpError(400, 'Invalid engine');
    if (engine === 'fal') {
      if (!getSettings().fal_api_key) throw new HttpError(400, 'The fal.ai API key is missing');
      if (!m.lora_url) throw new HttpError(400, `Train ${m.name}'s LoRA first (step 2)`);
    } else {
      const wf = RH_WORKFLOWS[engine];
      if (!rhReady(getSettings(), engine)) throw new HttpError(400, `The RunningHub API key or the ${wf.name} workflow ID is missing: paste them in Settings → RunningHub`);
      if (engine === 'sky_nsfw' && !m.rh_lora) throw new HttpError(400, `First enter the name of ${m.name}'s Z-Image LoRA on RunningHub (Settings → RunningHub)`);
      if (!b.source) throw new HttpError(400, `${wf.name} starts from one of her photos: choose the base photo`);
    }
    const prompt = b.promptOverride ? String(b.promptOverride).slice(0, 3000) : buildSpicyPrompt({ model: m, scene: b.scene, level: b.level, text });
    checkPrompt(prompt);
    adultAge(m);
    let source = null;
    if (b.source) {
      if (!ownImages(m.id).has(b.source) || !exists(b.source)) throw new HttpError(400, "The base photo must be one of the model's own photos");
      source = b.source;
    }
    const cfg = {
      scene: b.scene || null, level: Number(b.level) || 1, text, aspect: SIZES[b.aspect] ? b.aspect : '4:5',
      n: Math.max(1, Math.min(4, Number(b.n) || 2)), loraScale: Math.max(0.3, Math.min(1.5, Number(b.loraScale) || 1)),
      steps: Math.max(4, Math.min(20, Number(b.steps) || 8)), seed: Number(b.seed) || null,
      source, strength: Math.max(0.2, Math.min(1, Number(b.strength) || 0.6)),
      ...(engine !== 'fal' ? { engine } : {}),
    };
    const t = now();
    const j = db.prepare('INSERT INTO spicy_jobs (model_id, kind, stage, config, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(m.id, 'image', 'queued', JSON.stringify(cfg), prompt, t, t);
    setTimeout(tick, 50);
    return jobRow(j);
  });

  // Tools of her own RunningHub workflows on one of HER images: Detailing (whole image) and Inpainting (a painted zone).
  route('POST', '/api/spicy/tools', async (req) => {
    const b = await readBody(req);
    const m = getModel(b.modelId);
    if (!m) throw new HttpError(404, 'Choose the model');
    const age = adultAge(m);
    const tool = String(b.tool || '');
    if (!RH_ADULT_TOOLS.includes(tool)) throw new HttpError(400, 'Invalid tool');
    const wf = RH_WORKFLOWS[tool];
    if (!b.source || !ownImages(m.id).has(b.source) || !exists(b.source)) throw new HttpError(400, "The tools only work on the model's own images");
    if (!rhReady(getSettings(), tool)) throw new HttpError(400, `The RunningHub API key or the ${wf.name} workflow ID is missing: paste them in Settings → RunningHub`);
    const cfg = { engine: tool, source: b.source, n: 1 };
    let prompt = null;
    if (tool === 'inpaint') {
      const text = String(b.text || '').slice(0, 600).trim();
      if (!text) throw new HttpError(400, 'Describe what you want in the painted area');
      checkPrompt(text);
      const mask = decodeDataUrl(b.mask);
      if (mask.ext !== 'png' || mask.buf.length < 100) throw new HttpError(400, 'First paint the area to redo');
      cfg.mask = `${SPICY_DIR}/mask_${m.id}_${Date.now()}.png`;
      fs.writeFileSync(path.join(MEDIA_DIR, cfg.mask), mask.buf);
      cfg.text = text;
      prompt = [text.replace(/[.\s]+$/, ''), `${age} adult woman`, identityText(m), 'photorealistic, natural skin texture, blends seamlessly with the rest of the photo'].filter(Boolean).join(', ');
      checkPrompt(prompt);
    }
    const t = now();
    const j = db.prepare('INSERT INTO spicy_jobs (model_id, kind, stage, config, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(m.id, 'image', 'queued', JSON.stringify(cfg), prompt, t, t);
    setTimeout(tick, 50);
    return jobRow(j);
  });

  route('POST', '/api/spicy/videos', async (req) => {
    const b = await readBody(req);
    const m = getModel(b.modelId);
    if (!m) throw new HttpError(404, 'Choose the model');
    adultAge(m);
    if (!b.source || !ownImages(m.id).has(b.source) || !exists(b.source)) throw new HttpError(400, "The video must start from one of the model's own photos");
    const motion = String(b.motion || '').slice(0, 1200).trim();
    checkPrompt(motion);
    if (!getSettings().fal_api_key) throw new HttpError(400, 'The fal.ai API key is missing');
    const loras = (Array.isArray(b.loras) ? b.loras : []).slice(0, 3)
      .map((l) => ({ url: String(l.url || '').trim(), scale: Math.max(0.1, Math.min(2, Number(l.scale) || 1)) }))
      .filter((l) => /^https:\/\/\S+$/.test(l.url));
    const prompt = [
      `A ${adultAge(m)} adult woman. ${motion ? motion.replace(/[.!]?$/, '.') : 'She moves naturally and sensually, subtle body movement, looks into the camera and smiles.'}`,
      'Same woman as in the first frame for the whole video: same face, hair, body and skin. Realistic smartphone video, natural motion, handheld camera, photorealistic, no text.',
    ].join(' ');
    const cfg = {
      source: b.source, motion, seconds: DURATIONS[b.seconds] ? Number(b.seconds) : 5,
      resolution: ['480p', '580p', '720p'].includes(b.resolution) ? b.resolution : '720p', loras, seed: Number(b.seed) || null,
    };
    const t = now();
    const j = db.prepare('INSERT INTO spicy_jobs (model_id, kind, stage, config, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(m.id, 'video', 'queued', JSON.stringify(cfg), prompt, t, t);
    setTimeout(tick, 50);
    return jobRow(j);
  });

  route('GET', '/api/spicy/jobs', (req, { query }) => {
    const mid = query.get('model');
    return db.prepare(`SELECT j.*, m.name AS model_name FROM spicy_jobs j JOIN models m ON m.id = j.model_id
      WHERE j.kind != 'train' ${mid ? 'AND j.model_id = ?' : ''} ORDER BY j.id DESC LIMIT 120`).all(...(mid ? [mid] : [])).map(jobRow);
  });

  route('POST', '/api/spicy/jobs/:id/retry', (req, { params }) => {
    const j = getJob(params.id);
    if (!j) throw new HttpError(404, 'Not found');
    // RunningHub jobs keep the images already finished (not paid again); an unfinished task is started anew.
    const rh = parse(j.fal, null)?.rh;
    upd(j.id, { stage: 'queued', error: null, fal: rh ? { rh: { tasks: {}, done: rh.done || [] } } : null, step_status: 'Queued…' });
    setTimeout(tick, 50);
    return { ok: true };
  });

  route('POST', '/api/spicy/jobs/:id/stage', async (req, { params }) => {
    const b = await readBody(req);
    if (!['approved', 'review', 'cancelled'].includes(b.stage)) throw new HttpError(400, 'Invalid status');
    upd(Number(params.id), { stage: b.stage });
    return { ok: true };
  });

  route('DELETE', '/api/spicy/jobs/:id', (req, { params }) => {
    const j = getJob(params.id);
    if (j) {
      parse(j.outputs, []).forEach((o) => { if (o.path?.startsWith(`${SPICY_DIR}/`)) fs.rmSync(path.join(MEDIA_DIR, o.path), { force: true }); });
      const mask = parse(j.config, {}).mask;
      if (mask?.startsWith(`${SPICY_DIR}/mask_`)) fs.rmSync(path.join(MEDIA_DIR, mask), { force: true });
      db.prepare('DELETE FROM spicy_jobs WHERE id = ?').run(j.id);
    }
    return { ok: true };
  });

  route('DELETE', '/api/spicy/models/:id/lora', (req, { params }) => {
    db.prepare("UPDATE models SET lora_url = '', lora_trigger = '', lora_at = NULL WHERE id = ?").run(params.id);
    return { ok: true };
  });

  // Cheap key check: an authenticated status call on a non-existent request → 401/403 means a bad key.
  route('POST', '/api/spicy/test-key', async () => {
    const fal = falClient();
    try {
      await fal.req(`${process.env.FAL_QUEUE_URL || 'https://queue.fal.run'}/fal-ai/z-image/requests/00000000-0000-0000-0000-000000000000/status`);
      return { ok: true };
    } catch (e) {
      if (/recusou a API key|rejected the API key/.test(e.message)) return { ok: false, error: e.message };
      return { ok: true }; // 404/422 on the fake id = key accepted
    }
  });
}
