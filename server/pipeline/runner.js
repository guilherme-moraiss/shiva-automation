import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, getSettings, MEDIA_DIR } from '../db.js';
import { ensureVideo } from '../media.js';
import { analyzeReel } from './gemini.js';
import { estimateVideoCost, NB_PRO } from './workflows.js';
import { buildWan3CopyPrompt, noTattooLine } from './prompts.js';
import { probe, trimVideo, muxOriginalAudio, ffmpegPath, extractFrame, reencodeVideo, realismFinish, prepareForWorkflow, stripAudio } from '../ffmpeg.js';
import { prepareOutfit, ensureOutfitOn, checkVideoOutfit } from './outfit.js';
import { checkFrame, checkVideo, reelPreflight } from './qa.js';
import { SWAP_SYSTEM_PROMPT, SWAP_PLACE_SYSTEM_PROMPT, buildSwapPrompt, refSwapPrompt, EDIT_SYSTEM_PROMPT, EDIT_PRESETS, buildImageEditPrompt, buildEnlargePrompt, ENLARGE_DEFAULT, cleanSwapOptions, customSwapPrompt } from './prompts.js';
import { ANALYSIS_PROMPT, NB_SYSTEM_PROMPT, buildImagePrompt, buildPosePrompt, POSES } from './prompts.js';

/** Width/height of a JPEG/PNG/WebP buffer (null if unknown). */
export function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

/** Closest Nano Banana aspect ratio to the source photo (IG posts are usually 4:5). */
export function aspectFor(buf) {
  const s = imageSize(buf);
  if (!s || !s.w || !s.h) return '4:5';
  const r = s.w / s.h;
  const opts = { '1:1': 1, '4:5': 0.8, '3:4': 0.75, '2:3': 0.667, '9:16': 0.5625, '5:4': 1.25, '4:3': 1.333, '3:2': 1.5, '16:9': 1.778 };
  return Object.entries(opts).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}
import { normalizeRefs, pickRefs } from './modelpack.js';
import { rewriteRefTags } from './comfyapi.js';
import { WaveSpeed } from './wavespeed.js';
import { RH_VIDEO_ENGINES, RH_WORKFLOWS, RH_FRAME_ENGINES, rhReady, runRhVideo, runRhSky, runRhImage, instagirlValues, skyIdentity } from './rhworkflows.js';
import { RH_INSTANCES } from './runninghub.js';
import { ensureProfile } from './profile.js';
import { recordCost, rhCurrency } from '../costs.js';

/** Engines that edit the original reel directly (no Nano Banana first frame needed). */
export const EDIT_ENGINES = ['wan27_edit', 'kling_edit'];
export const VIDEO_ENGINES = ['wan3_copy', 'animate_replace', 'rh_wan_animate', 'rh_nb_wan_animate', 'rh_ttt_animator', 'rh_animate_x', 'wan3', 'kling_motion', 'wan27_edit', 'kling_edit'];
/** Video types that only the Comfy API had (Recriar, Kling, Wan 2.7 video edit): not on WaveSpeed. */
export const COMFY_ONLY_VIDEO = ['wan3', 'kling_motion', 'wan27_edit', 'kling_edit'];
const comfyOnlyError = () => new Error('This remake type was made by Comfy, which is no longer used. Make the remake again: the exact copy (Wan 3.0) and Wan 2.2 Animate run on WaveSpeed.');

export const OTHER_EDITOR_HINT = 'You can try again (the filter does not always block) or choose another engine in “Her image” (Nano Banana, Flux.2 or Seedream)';
export const SAFETY_HELP = "Google's safety filter (Nano Banana) blocked all the variants (IMAGE_SAFETY). It usually happens with photos of real people in a bikini or lingerie, or with very suggestive body descriptions. Options: “Try again” (the filter does not always block), capture another moment of the reel with “Use this frame”, remove words like “sexy” from the Persona, or use the exact copy with the 1st frame set to “Direct (model photos)”, which does not go through Nano Banana.";

/**
 * Remake pipeline: one row in `generations` per attempt, moved through stages by a small worker:
 *
 *   queued -> imaging              (reel analysis, only for the engines whose prompts use it)
 *   imaging -> awaiting_approval | animating   (Nano Banana: her refs + a frame of the reel -> N first-frame candidates)
 *   awaiting_approval -> animating             (you pick a candidate in the Studio)
 *   animating -> review                        (Wan 3.0 R2V / I2V)
 *   review -> approved (ready to publish) | rejected
 *
 * Stages are persisted, and every paid step can be resumed: if the app restarts mid-run, the worker picks the row
 * up again, keeps the images already generated and waits for the Wan task already created (never paid twice).
 */

const ACTIVE = ['queued', 'imaging', 'animating'];
const busy = new Set(); // projects the worker is running (the pipeline slots)
const bg = new Set(); // background jobs on a project: enlargement, edit, Topaz (remote work: no slot)
const WAN_REF_VIDEO_MAX = 15; // seconds, Wan 3.0 limit for reference videos
const RESUME_TTL = 2 * 3600e3; // paid work interrupted by a restart is resumed within this window

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const readMedia = (rel) => fs.readFileSync(path.join(MEDIA_DIR, rel));
const mimeOf = (rel) => (/\.png$/i.test(rel) ? 'image/png' : /\.webp$/i.test(rel) ? 'image/webp' : 'image/jpeg');
const existsMedia = (rel) => !!rel && fs.existsSync(path.join(MEDIA_DIR, rel));

/** Nano Banana ratio for a VIDEO frame: its own shape, 9:16 when it can't be read (never the 4:5 photo default). */
const frameAspect = (rel) => {
  try { const buf = readMedia(rel); return imageSize(buf) ? aspectFor(buf) : '9:16'; } catch { return '9:16'; }
};

/** Output ratios Wan accepts; the one closest to the first frame is used, so the copy keeps the reel's shape. */
const WAN_RATIOS = { '9:16': 9 / 16, '3:4': 3 / 4, '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9 };
function wanRatioOf(rel) {
  let s = null;
  try { s = existsMedia(rel) ? imageSize(readMedia(rel)) : null; } catch { s = null; }
  if (!s?.w || !s?.h) return '9:16';
  const r = s.w / s.h;
  return Object.entries(WAN_RATIOS).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}

const fmtSecs = (x) => (x < 20 ? (Math.round(x * 10) / 10).toFixed(1) : String(Math.round(x)));

export function getGeneration(id) {
  const g = db.prepare('SELECT * FROM generations WHERE id = ?').get(id);
  if (!g) return null;
  return { ...g, config: parse(g.config, {}), analysis: parse(g.analysis, null), candidates: parse(g.candidates, []), log: parse(g.log, []), qa: parse(g.qa, null) };
}

function update(id, fields) {
  const keys = Object.keys(fields);
  const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]));
  db.prepare(`UPDATE generations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
}

export function log(id, msg) {
  const g = db.prepare('SELECT log FROM generations WHERE id = ?').get(id);
  if (!g) return;
  const l = parse(g.log, []);
  l.push({ at: now(), msg });
  db.prepare('UPDATE generations SET log = ?, step_status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(l.slice(-100)), msg, now(), id);
}

const status = (id, msg) => db.prepare('UPDATE generations SET step_status = ?, updated_at = ? WHERE id = ?').run(msg, now(), id);
/** A deleted generation counts as cancelled, so its running stage stops instead of generating for nothing. */
const isCancelled = (id) => {
  const r = db.prepare('SELECT stage FROM generations WHERE id = ?').get(id);
  return !r || r.stage === 'cancelled';
};
/** Adds to the project's total and to the ledger of Custos (per day, provider, model and kind of work). */
function addCost(id, usd, category = 'imagem', provider = 'wavespeed', workerId = undefined, units = null) {
  db.prepare('UPDATE generations SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id);
  recordCost({ amount: usd, provider, category, generationId: id, workerId, units }); // workerId: who pressed it (else the project's person); units: images or seconds
}
/** What RunningHub reported for a task: added to the project's total (dollar accounts) and to the ledger of Custos. */
function rhSpend(id, money, category) {
  if (!money) return;
  const currency = rhCurrency();
  if (currency === 'USD') db.prepare('UPDATE generations SET cost_usd = cost_usd + ? WHERE id = ?').run(money, id);
  recordCost({ amount: money, currency, provider: 'runninghub', category, generationId: id, estimated: false });
}
/** Every image is paid on WaveSpeed (Nano Banana, Seedream, Flux.2, Wan): the one provider since 27/09. */
const imgProvider = () => 'wavespeed';

/** The stored config, read fresh (other code may have written keys since the stage started). */
const freshConfig = (id) => parse(db.prepare('SELECT config FROM generations WHERE id = ?').get(id)?.config, {});

/** Merge `patch` into the stored config; a null value removes that key. */
function patchConfig(id, patch) {
  const cfg = freshConfig(id);
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) delete cfg[k]; else cfg[k] = v; }
  update(id, { config: cfg });
  return cfg;
}

// ---- prompts: rebuilt on every run unless the user edited them --------------------------------

const hashText = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 16);

/**
 * The stored prompt, but only when the user edited it (Details panel). A prompt built by an earlier run is rebuilt,
 * so image numbers and @Image tags always match the images actually sent (refs, outfit and place can change).
 * Edited = flagged (imagePromptEdited / videoPromptEdited) or different from the hash saved with the built prompt.
 */
function userPrompt(g, kind) {
  const stored = g?.[`${kind}_prompt`];
  if (!stored) return null;
  const cfg = g.config || {};
  if (cfg[`${kind}PromptEdited`]) return stored;
  const saved = cfg.promptHash?.[kind];
  return saved && saved !== hashText(stored) ? stored : null;
}

/** Step 4 (Vídeo): optional extra text added to the video prompt (the app's or the user's), never replacing it. */
const withVideoExtra = (prompt, cfg) => {
  const x = String(cfg?.videoExtra || '').trim();
  return x && prompt ? `${prompt}\nExtra direction (priority): ${x}` : prompt;
};
/** … and what the video must not show: Wan's negative prompt (at most 500 characters). */
const videoNegative = (cfg) => String(cfg?.videoNegative || '').trim().slice(0, 500) || null;

/** For the project page: which prompts are the user's own ("editado") and which the app builds ("padrão"). */
export const promptState = (g) => ({ image: !!userPrompt(g, 'image'), video: !!userPrompt(g, 'video') });

/** Records in `cfg` whether the prompt about to be stored was built by the app or edited by the user. */
function recordPrompt(cfg, kind, prompt, edited) {
  if (edited) cfg[`${kind}PromptEdited`] = true;
  else {
    delete cfg[`${kind}PromptEdited`];
    if (prompt) cfg.promptHash = { ...(cfg.promptHash || {}), [kind]: hashText(prompt) };
  }
  return cfg;
}

/** Stores the prompt that was sent (shown in the Details panel). */
function savePrompt(id, kind, prompt, edited) {
  update(id, { [`${kind}_prompt`]: prompt || null, config: recordPrompt(freshConfig(id), kind, prompt, edited) });
}

/** Snapshot of the settings a generation runs with (so changing Setup doesn't affect jobs in flight). */
export function defaultConfig(overrides = {}) {
  const s = getSettings();
  const cfg = {
    imageEngine: s.image_engine,
    nbModel: s.image_engine === 'gemini' ? s.nb_model_gemini : s.nb_model_comfy,
    nbResolution: s.nb_resolution,
    variants: Math.max(1, Math.min(4, Number(s.nb_variants) || 2)),
    analysis: s.analysis_enabled === '1',
    analysisModel: s.analysis_model,
    videoEngine: VIDEO_ENGINES.includes(s.video_engine) && !COMFY_ONLY_VIDEO.includes(s.video_engine) ? s.video_engine : 'wan3_copy',
    klingMode: s.kling_mode || 'std',
    keepSound: s.keep_original_sound !== '0',
    keepOutfit: s.keep_outfit === 'covered' ? 'covered' : s.keep_outfit !== '0',
    firstFrame: s.first_frame_mode === 'direct' ? 'direct' : 'nano', // nano = Nano Banana places the model in the reel's frame; direct = model photos straight to Wan
    // Who puts her in the frame/post: Nano Banana, Flux.2, Seedream or Wan 2.7 (WaveSpeed), or her RunningHub workflows (SKY, Faceswap).
    frameEngine: ['nano', 'nanopro', ...Object.keys(IMAGE_EDITORS), ...RH_FRAME_ENGINES].includes(s.frame_engine) ? s.frame_engine : 'nanopro', // the reference's swap
    imageFinish: '', // 'instagirl' = WAN 2.2 Instagirl realism pass (RunningHub) on her images before the video / the review
    wanModel: s.wan_model,
    wanMode: s.wan_mode,
    wanResolution: s.wan_resolution,
    wanDuration: s.wan_duration,
    wanAudio: s.wan_audio === '1',
    wanPromptExtend: s.wan_prompt_extend === '1',
    autoApprove: s.auto_approve_image === '1',
    useCustomImageWorkflow: !!s.custom_workflow_image,
    useCustomVideoWorkflow: !!s.custom_workflow_video,
  };
  for (const [k, v] of Object.entries(overrides || {})) if (k in cfg && v !== undefined && v !== null && v !== '') cfg[k] = v;
  if (overrides?.imageEngine && !overrides.nbModel) cfg.nbModel = cfg.imageEngine === 'gemini' ? s.nb_model_gemini : s.nb_model_comfy;
  // "Nano Banana Pro" (Remake page): Nano Banana with the Pro model, as the reference app's person swap.
  if (cfg.frameEngine === 'nanopro') { cfg.frameEngine = 'nano'; cfg.nbModel = NB_PRO; }
  return cfg;
}

/**
 * `imagePrompt`: the image prompt the user edited on the Remake page before generating. It is stored with the
 * generation (flagged as edited), so the image step sends it as written instead of building one.
 */
export function createGeneration(remakeId, overrides, kind = 'video', { imagePrompt = null } = {}) {
  const t = now();
  const cfg = { ...defaultConfig(overrides) };
  // No phone here: remakes keep the reel's own props (the phone belongs to "Criar conteúdo" only).
  for (const k of ['slides', 'poses', 'customPose', 'baseImage', 'placeId', 'outfitId', 'ownImage']) if (overrides?.[k] !== undefined) cfg[k] = overrides[k];
  const swapOptions = cleanSwapOptions(overrides?.swapOptions); // step 1: no hair clips / no tattoos / top colour
  if (swapOptions) cfg.swapOptions = swapOptions;
  if (imagePrompt) cfg.imagePromptEdited = true;
  // Her model's 'Aumento automático' (Perfis), snapshotted like the other settings: Automático edits the chosen image first.
  const md = kind === 'video' && !overrides?.ownImage ? db.prepare('SELECT md.edit_auto, md.edit_prompt, md.edit_engine, md.edit_n FROM remakes r JOIN models md ON md.id = r.model_id WHERE r.id = ?').get(remakeId) : null;
  if (overrides?.enlarge === false) delete cfg.enlarge;
  else if (md?.edit_auto) cfg.enlarge = { prompt: md.edit_prompt?.trim() || ENLARGE_DEFAULT, engine: EDIT_ENGINE_KEYS.includes(md.edit_engine) ? md.edit_engine : defaultEnlargeEngine(), n: Math.max(1, Math.min(4, Number(md.edit_n) || 1)) };
  const row = db.prepare('INSERT INTO generations (remake_id, stage, config, kind, image_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .get(remakeId, 'queued', JSON.stringify(cfg), kind, imagePrompt || null, t, t);
  db.prepare("UPDATE remakes SET status = 'in_progress', updated_at = ? WHERE id = ? AND status IN ('queued', 'rejected')").run(t, remakeId); // a new run clears a manual Rejeitar
  log(row.id, 'Queued in the pipeline');
  kick();
  return getGeneration(row.id);
}

function loadContext(g) {
  const ctx = db.prepare(`
    SELECT m.id AS remake_id, m.prompt AS instructions, m.model_id,
           r.id AS reel_id, r.platform, r.url, r.external_id, r.duration, r.thumb_path, r.frame_path, r.video_path, r.video_url, r.caption,
           r.media_type, r.image_paths,
           md.name AS model_name, md.persona, md.ref_images, md.body AS body_text, md.rules, md.profile, md.image_extra, md.default_ref, md.swap_prompt
    FROM remakes m JOIN reels r ON r.id = m.reel_id LEFT JOIN models md ON md.id = m.model_id WHERE m.id = ?`).get(g.remake_id);
  if (!ctx) throw new Error('The remake/reel no longer exists');
  ctx.refs = normalizeRefs(ctx.ref_images);
  ctx.body = { body: ctx.body_text || '', rules: ctx.rules || '', profile: ctx.profile || '' }; // body + identity rules travel together into every prompt
  // Her default instructions (Perfis) come first, then this remake's own.
  ctx.imageInstructions = [ctx.image_extra, ctx.instructions].map((x) => String(x || '').trim()).filter(Boolean).join('\n'); // the image only, never the video
  ctx.slides = parse(ctx.image_paths, []).filter((p) => fs.existsSync(path.join(MEDIA_DIR, p)));
  if (!ctx.slides.length && ctx.media_type !== 'video' && ctx.thumb_path) ctx.slides = [ctx.thumb_path];
  ctx.sourceFrame = [ctx.frame_path, ctx.thumb_path].find((p) => p && fs.existsSync(path.join(MEDIA_DIR, p))) || null;
  return ctx;
}

/** Frame of the reel video to put her into: the user's captured moment, else the video's first second (cached). */
/**
 * smart (only inside a project run, where images are paid for anyway): the vision check picks the best moment of the
 * reel (one person, sharp, face to camera, whole outfit), once per reel; maxT keeps it inside what the exact copy uses.
 * A frame captured by the user always wins. Without smart (e.g. just viewing a reel) nothing is paid: first moment.
 */
export async function ensureAutoFrame(reel, { smart = false, maxT = null } = {}) {
  const has = reel.frame_path && fs.existsSync(path.join(MEDIA_DIR, reel.frame_path));
  const plainAuto = has && /_auto_(?!ia_)/.test(reel.frame_path);
  if (has && !(smart && plainAuto)) return reel.frame_path;
  if (smart) {
    try {
      const full = db.prepare('SELECT * FROM reels WHERE id = ?').get(reel.id);
      let pf = null;
      try { pf = full?.preflight ? JSON.parse(full.preflight) : null; } catch { pf = null; }
      if (!pf || pf.best_t == null) pf = await reelPreflight({ ...full, video_path: full?.video_path || reel.video_path }, { force: !!pf });
      let t = pf?.best_t;
      if (t != null) {
        if (maxT) t = Math.min(t, maxT - 0.5);
        const rel = reel.video_path && fs.existsSync(path.join(MEDIA_DIR, reel.video_path)) ? reel.video_path : full?.video_path;
        const out = `frames/r${reel.id}_auto_ia_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(MEDIA_DIR, out), await extractFrame(path.join(MEDIA_DIR, rel), Math.max(0.1, t)));
        db.prepare('UPDATE reels SET frame_path = ? WHERE id = ?').run(out, reel.id);
        return out;
      }
    } catch { /* the vision check is optional: the first moment is used */ }
    if (has) return reel.frame_path;
  }
  if (!ffmpegPath()) return null;
  let rel = reel.video_path && fs.existsSync(path.join(MEDIA_DIR, reel.video_path)) ? reel.video_path : null;
  if (!rel) { try { rel = await ensureVideo(reel); } catch { return null; } }
  const out = `frames/r${reel.id}_auto_${Date.now()}.jpg`;
  try {
    fs.writeFileSync(path.join(MEDIA_DIR, out), await extractFrame(path.join(MEDIA_DIR, rel), 0.3));
  } catch { return null; }
  db.prepare('UPDATE reels SET frame_path = ? WHERE id = ?').run(out, reel.id);
  return out;
}

async function videoStartFrame(ctx, gid, exactCopy = false) {
  if (ctx.media_type && ctx.media_type !== 'video') return ctx.sourceFrame;
  const f = await ensureAutoFrame({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url, frame_path: ctx.frame_path },
    { smart: true, maxT: exactCopy ? WAN_REF_VIDEO_MAX : null });
  if (f && f !== ctx.frame_path) log(gid, /_auto_ia_/.test(f) ? 'Reference frame chosen by the AI: the best moment of the reel (one person, sharp, facing the camera, the whole outfit)' : 'Reference frame: start of the video (the TikTok cover is not always a video frame)');
  else if (exactCopy && f && !/_auto_/.test(f) && (ctx.duration || 0) > WAN_REF_VIDEO_MAX + 0.4) {
    // The exact copy only uses the first 15 s of the reel: a moment captured later may show other clothes or another place.
    log(gid, `Warning: the reel is ${Math.round(ctx.duration)} s long and the exact copy uses only the first ${WAN_REF_VIDEO_MAX} s. If the captured moment is after that, the outfit and the scene may not match the video.`);
  }
  return f || ctx.sourceFrame;
}

/** Runs `fn` over `items`, at most `limit` at a time. Never rejects: returns [{ ok, value } | { ok: false, error }] in order. */
async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { res[i] = { ok: true, value: await fn(items[i], i) }; } catch (error) { res[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return res;
}

/**
 * The image editors for the person swap and the edits, all on WaveSpeed (the one provider since 27/09). They take the
 * same images and prompt as Nano Banana. Cost = WaveSpeed's price per image (27/09 list).
 */
export const IMAGE_EDITORS = {
  flux: { label: 'Flux.2 [pro]', cost: () => 0.06 },
  seedream: { label: 'Seedream 5.0 Pro', cost: (refs) => 0.045 + 0.003 * Math.max(0, refs - 1) },
  // Wan 2.7 Image (Alibaba): the reference's enlargement.
  wan27: { label: 'Wan 2.7 Image', cost: () => 0.03 },
  wan27pro: { label: 'Wan 2.7 Image Pro', cost: () => 0.075 },
};
/** Wan 2.7 runs on WaveSpeed like everything else: ready once the WaveSpeed key is saved. */
export const wan27Ready = (s = getSettings()) => !!s.wavespeed_api_key;
/** Editors used only by "Editar imagem" (one image in, same framing out): never offered for the person swap. */
export const EDIT_ONLY = {
  wan: { label: 'Wan 2.5 (Alibaba)', cost: () => 0.035 },
};
/** Output size in the shape of the scene: Flux.2 ≈ 1 MP in multiples of 32; Wan 2.7 up to 2K on the long side. */
function editorSize(engine, rel) {
  let dim = null;
  try { dim = existsMedia(rel) ? imageSize(readMedia(rel)) : null; } catch { dim = null; }
  const r = dim?.w && dim?.h ? Math.max(1 / 3, Math.min(3, dim.w / dim.h)) : 9 / 16;
  if (engine === 'flux') {
    const w = Math.max(256, Math.min(2048, Math.floor(Math.sqrt(1048576 * r) / 32) * 32));
    const h = Math.max(256, Math.min(2048, Math.floor(1048576 / w / 32) * 32));
    return { width: w, height: h };
  }
  const long = r > 0.9 && r < 1.1 ? 2000 : 2048; // Wan 2.7: at most 2048×2048 pixels in all
  return r < 1 ? { width: Math.round((long * r) / 16) * 16, height: long } : { width: long, height: Math.round(long / r / 16) * 16 };
}
const NB_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const SEEDREAM_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9'];
/** The shape asked for, when the model has it ('auto' or another shape: the model follows the input). */
const ratioOr = (list, r) => (list.includes(r) ? { aspect_ratio: r } : {});
const sizeOf = (engine, rel) => { const z = editorSize(engine, rel); return `${z.width}*${z.height}`; };
const nbRes = (cfg) => (['1K', '2K', '4K'].includes(String(cfg?.nbResolution || '').toUpperCase()) ? String(cfg.nbResolution).toLowerCase() : '1k');
const nbInput = ({ prompt, images, aspectRatio, cfg }) => ({ prompt, images, ...ratioOr(NB_RATIOS, aspectRatio), resolution: nbRes(cfg), output_format: 'png' });
/** Each image engine's WaveSpeed model: its id, how many images it takes, and its fields. */
const WS_IMAGE = {
  nano: { model: 'google/nano-banana-2/edit', label: 'Nano Banana 2', max: 14, input: nbInput },
  nanopro: { model: 'google/nano-banana-pro/edit', label: 'Nano Banana Pro', max: 14, input: nbInput },
  seedream: { model: 'bytedance/seedream-v5.0-pro/edit', label: 'Seedream 5.0 Pro', max: 10, input: ({ prompt, images, aspectRatio }) => ({ prompt, images, ...ratioOr(SEEDREAM_RATIOS, aspectRatio), resolution: '1.5k', output_format: 'png' }) },
  flux: { model: 'wavespeed-ai/flux-2-pro/edit', label: 'Flux.2 [pro]', max: 3, input: ({ prompt, images, scene }) => ({ prompt, images, size: sizeOf('flux', scene) }) },
  wan27: { model: 'alibaba/wan-2.7/image-edit', label: 'Wan 2.7 Image', max: 9, input: ({ prompt, images, scene }) => ({ prompt, images, size: sizeOf('wan27', scene) }) },
  wan27pro: { model: 'alibaba/wan-2.7/image-edit-pro', label: 'Wan 2.7 Image Pro', max: 9, input: ({ prompt, images, scene }) => ({ prompt, images, size: sizeOf('wan27pro', scene) }) },
  wan: { model: 'alibaba/wan-2.5/image-edit', label: 'Wan 2.5 (Alibaba)', max: 2, input: ({ prompt, images }) => ({ prompt: prompt.slice(0, 2000), images }) },
};
/** The WaveSpeed model of an engine: 'nano' is Nano Banana 2 or Pro, by the project's Nano Banana model. */
const wsImageKey = (engine, cfg) => (engine === 'nano' || !WS_IMAGE[engine] ? (/pro/i.test(String(cfg?.nbModel || '')) ? 'nanopro' : 'nano') : engine);
/** How many images an engine takes in one request. */
export const maxImagesFor = (engine, cfg) => WS_IMAGE[wsImageKey(engine, cfg)].max;
/** WaveSpeed's price per image (27/09): Nano Banana Pro $0.14 (1K/2K) or $0.24 (4K); Nano Banana 2 $0.07 / $0.105 / $0.14. */
function wsImageCost(key, cfg, nInputs) {
  const res = nbRes(cfg);
  if (key === 'nanopro') return res === '4k' ? 0.24 : 0.14;
  if (key === 'nano') return { '2k': 0.105, '4k': 0.14 }[res] ?? 0.07;
  return (IMAGE_EDITORS[key] || EDIT_ONLY[key])?.cost(nInputs) ?? 0.05;
}

/**
 * Her images on WaveSpeed: Nano Banana (2 or Pro) or, with `engine`, Seedream 5.0 / Flux.2 / Wan 2.7 / Wan 2.5.
 * `inputs` are media-relative paths, uploaded once and shared by the n variants (made in parallel).
 * Returns [{ path, engine, model, cost }]. Shared by the remake pipeline, the edits, the outfit and "generate missing angles".
 * WaveSpeed has no system-prompt field: the instruction goes first in the prompt itself.
 */
export async function nanoBananaImages({ inputs, prompt, cfg, n = 1, tag, aspectRatio = '9:16', meta = {}, onStatus, isCancelled = () => false, systemPrompt = NB_SYSTEM_PROMPT, engine = 'nano' }) {
  const s = getSettings();
  const out = [];
  if (isCancelled()) return out;
  if (!s.wavespeed_api_key) throw new Error('The WaveSpeed API key is missing: paste it in Settings → Pipeline');
  const key = wsImageKey(engine, cfg);
  const spec = WS_IMAGE[key];
  const editor = IMAGE_EDITORS[engine] || EDIT_ONLY[engine] || null;
  const ws = new WaveSpeed(s.wavespeed_api_key);
  const list = inputs.slice(0, spec.max);
  if (list.length < inputs.length) onStatus?.(`${spec.label} takes up to ${spec.max} images: sending the first ${spec.max}`);
  onStatus?.(`Uploading ${list.length} image(s) to WaveSpeed…`);
  const urls = await Promise.all(list.map((p, i) => ws.upload(readMedia(p), `rr_${tag}_in${i}${path.extname(p) || '.png'}`, mimeOf(p))));
  if (isCancelled()) return out;
  const input = spec.input({ prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt, images: urls, aspectRatio, cfg, scene: list[0] });
  const unit = wsImageCost(key, cfg, list.length);
  const one = async (i) => {
    const on = (m) => onStatus?.(n > 1 ? `Image ${i + 1}/${n}: ${m}` : `${spec.label}: ${m}`);
    if (isCancelled()) throw new Error('Canceled');
    // Once sent, the image is paid: it is fetched even if the project is cancelled meanwhile, so it is not lost.
    const r = await ws.run(spec.model, input, { onStatus: (m) => { if (!isCancelled()) on(m); }, intervalMs: 2000, maxMs: 30 * 60e3 }); // WaveSpeed's queue can be slow
    return WaveSpeed.download(r.outputs[0], 'generated image');
  };
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i)));
  const stamp = Date.now();
  const blocked = [];
  let fatal = null;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const rel = `generated/${tag}_${stamp}_${i}.${r.value[0] === 0xff && r.value[1] === 0xd8 ? 'jpg' : 'png'}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), r.value);
      out.push({ path: rel, engine: 'wavespeed', model: spec.label, cost: unit, ...meta });
      return;
    }
    const e = r.reason || new Error('Unknown error');
    // One blocked/failed variant must not sink the others.
    if (n > 1 && (e.safety || !/saldo|balance|API key|Cancelado|Cancell?ed/i.test(String(e.message)))) { blocked.push(e); onStatus?.(`Image ${i + 1}/${n}: ${e.message}`); } else fatal = fatal || e;
  });
  if (!out.length && fatal) throw fatal;
  if (!out.length && blocked.length) {
    const e = new Error(blocked.some((b) => b.safety) ? (editor ? `${blocked.find((b) => b.safety).message}. ${OTHER_EDITOR_HINT}` : SAFETY_HELP) : blocked[0].message);
    e.safety = blocked.some((b) => b.safety);
    const first = blocked.find((b) => b.safety);
    if (first) e.raw = first.raw || first.message; // the provider's own words, for messages that quote it
    if (editor) e.provider = engine;
    throw e;
  }
  if (blocked.length || fatal) {
    const why = !fatal && blocked.every((b) => b.safety) ? 'blocked by the filter' : 'failed';
    onStatus?.(`${n - out.length} of ${n} variants ${why}; ${out.length} left`);
  }
  return out;
}

// ---- stage handlers ----------------------------------------------------------------------

async function stageAnalyze(g, ctx) {
  const s = getSettings();
  if (g.kind === 'photo' || g.kind === 'poses') {
    update(g.id, { stage: 'imaging' });
    return;
  }
  if (g.config.videoEngine === 'wan3_copy' && g.config.firstFrame === 'direct') {
    update(g.id, { stage: 'animating' });
    log(g.id, 'Direct exact copy, no Nano Banana: the model photos go straight to Wan 3.0');
    return;
  }
  if (EDIT_ENGINES.includes(g.config.videoEngine)) {
    // The original reel is edited directly: no analysis or first frame needed.
    update(g.id, { stage: 'animating' });
    log(g.id, 'Remake by editing the original reel: skipping the image');
    return;
  }
  // Only the "Recriar" (wan3) prompts read the analysis. An exact copy works from a frame of the video itself,
  // so uploading the reel to Gemini would only add minutes and cost. Without any frame it is still needed.
  const usesAnalysis = g.config.videoEngine === 'wan3' || (!ctx.sourceFrame && !ffmpegPath());
  if (usesAnalysis && g.config.analysis && s.gemini_api_key && !g.analysis) {
    log(g.id, `Analyzing the original reel with ${g.config.analysisModel}…`);
    try {
      let video = null;
      try {
        const rel = await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
        const buf = readMedia(rel);
        if (buf.length <= 18e6) video = buf;
      } catch { /* fall back to the frame */ }
      const image = !video && ctx.sourceFrame ? { mime: mimeOf(ctx.sourceFrame), data: readMedia(ctx.sourceFrame) } : null;
      const analysis = await analyzeReel({
        apiKey: s.gemini_api_key, model: g.config.analysisModel,
        prompt: ANALYSIS_PROMPT + (ctx.caption ? `\n\nOriginal caption: ${ctx.caption.slice(0, 500)}` : ''), video, image,
      });
      update(g.id, { analysis });
      log(g.id, `Analysis: ${analysis.format || ''} — ${analysis.summary || ''}`.slice(0, 300));
    } catch (e) {
      log(g.id, `Analysis failed (going on without it): ${e.message}`);
    }
  } else if (usesAnalysis && g.config.analysis && !s.gemini_api_key) {
    log(g.id, 'Analysis skipped: no Gemini API key');
  }
  update(g.id, { stage: 'imaging' });
}

/**
 * Exact copy (wan3_copy) and the other video types: everything the VIDEO step needs is checked BEFORE any image is
 * paid for (the WaveSpeed or RunningHub key, the reel video itself, its length).
 */
async function checkVideoPrereqs(g, ctx) {
  const engine = g.config.videoEngine;
  if (g.kind === 'video' && RH_VIDEO_ENGINES[engine]) {
    const s = getSettings();
    const key = RH_VIDEO_ENGINES[engine];
    if (!s.rh_api_key) throw new Error('The RunningHub API key is missing: paste it in Settings → RunningHub');
    if (!rhReady(s, key)) throw new Error(`The ID of the ${RH_WORKFLOWS[key].name} workflow on RunningHub is missing: paste it in Settings → RunningHub`);
    try {
      await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
    } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
  }
  checkRhImagePrereqs(g, ctx);
  if (g.kind === 'video' && RH_VIDEO_ENGINES[engine]) return;
  if (g.kind === 'video' && COMFY_ONLY_VIDEO.includes(engine)) throw comfyOnlyError();
  if (g.kind === 'video' && engine === 'animate_replace') {
    if (!getSettings().wavespeed_api_key) throw new Error('The WaveSpeed API key is missing: paste it in Settings → Pipeline');
    try {
      await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
    } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
    return;
  }
  if (g.kind !== 'video' || engine !== 'wan3_copy') return;
  if (!getSettings().wavespeed_api_key) throw new Error('The WaveSpeed API key is missing: paste it in Settings → Pipeline');
  let rel;
  try {
    rel = await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
  } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
  const full = (ffmpegPath() ? (await probe(path.join(MEDIA_DIR, rel))).duration : null) || ctx.duration || null;
  if (full && full < 2) throw new Error('The reel is too short (minimum 2 s)');
  if (full && full > WAN_REF_VIDEO_MAX + 0.4 && !ffmpegPath()) throw new Error(`The reel is ${Math.round(full)} s long and the Wan 3.0 reference takes up to ${WAN_REF_VIDEO_MAX} s: install ffmpeg (npm run setup) to cut it automatically`);
}

/** Her image made by one of her RunningHub workflows (SKY / Faceswap) and the realism pass: configured? (before paying) */
function checkRhImagePrereqs(g, ctx) {
  const s = getSettings();
  const fk = g.config.frameEngine;
  if (RH_FRAME_ENGINES.includes(fk)) {
    if (!rhReady(s, fk)) throw new Error(`The RunningHub API key or the ID of the ${RH_WORKFLOWS[fk].name} workflow is missing: paste them in Settings → RunningHub`);
    if (fk === 'sky') {
      const m = db.prepare('SELECT name, rh_lora FROM models WHERE id = ?').get(ctx.model_id);
      if (!m?.rh_lora) throw new Error(`${m?.name || 'The model'} does not have the Z-Image LoRA on RunningHub yet: enter the file name in Settings → RunningHub`);
    }
  }
  if (g.config.imageFinish === 'instagirl' && !rhReady(s, 'instagirl')) {
    throw new Error('The RunningHub API key or the ID of the WAN 2.2 Instagirl (realism) workflow is missing: paste them in Settings → RunningHub, or turn off the extra realism');
  }
}

const getAssetRow = (id) => (id ? db.prepare('SELECT * FROM model_assets WHERE id = ?').get(id) : null);
/** The outfit picked for this remake (her wardrobe), if its image still exists. */
export function outfitAsset(cfg) {
  const o = getAssetRow(cfg?.outfitId);
  return o?.path && fs.existsSync(path.join(MEDIA_DIR, o.path)) ? o : null;
}
/** Her place picked for this remake, if its image still exists. */
const placeAsset = (cfg) => {
  const p = getAssetRow(cfg?.placeId);
  return p?.path && fs.existsSync(path.join(MEDIA_DIR, p.path)) ? p : null;
};
/** keepOutfit for the prompts: a chosen outfit wins over "same as the video". */
const outfitMode = (cfg) => (outfitAsset(cfg) ? 'asset' : cfg.keepOutfit === 'covered' ? 'covered' : cfg.keepOutfit !== false);

/**
 * The image prompt a new video remake would send for her image in the reel frame, built exactly like stageImage
 * builds it (Remake page: shown, and editable, before anything is paid). `prompt: null` when no prompt is used:
 * her image made by a RunningHub workflow, or a remake type without an image step.
 */
export function previewImagePrompt({ modelId, instructions = '', config = {} }) {
  const m = db.prepare('SELECT body, rules, profile, ref_images, image_extra, default_ref, swap_prompt FROM models WHERE id = ?').get(modelId);
  if (!m) throw Object.assign(new Error('Model not found'), { status: 404 });
  const cfg = defaultConfig(config);
  for (const k of ['placeId', 'outfitId']) if (config?.[k] !== undefined) cfg[k] = config[k];
  if (EDIT_ENGINES.includes(cfg.videoEngine) || (cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct')) return { prompt: null, reason: 'no-image' };
  if (RH_FRAME_ENGINES.includes(cfg.frameEngine)) return { prompt: null, reason: 'workflow', engine: cfg.frameEngine };
  const keepArg = outfitAsset(cfg) ? true : outfitMode(cfg); // as the run: a chosen outfit is put on after the swap
  const refLayout = !String(m.swap_prompt || '').trim() && isRefSwap(cfg) && keepArg !== false;
  const { refs } = pickRefs(normalizeRefs(m.ref_images), refLayout ? 1 : swapRefCount(cfg), { star: m.default_ref });
  if (!refs.length) return { prompt: null, reason: 'no-refs' };
  instructions = [m.image_extra, instructions].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
  const chosenOutfit = !!outfitAsset(cfg); // the swap keeps the reel's clothes; a verified try-on puts the outfit on after
  const uni = universeRefs(chosenOutfit ? { ...cfg, outfitId: null } : cfg, 1 + refs.length);
  const body = { body: m.body || '', rules: m.rules || '', profile: m.profile || '' };
  const own = String(m.swap_prompt || '').trim();
  const prompt = [own ? customSwapPrompt(own, { options: cleanSwapOptions(config?.swapOptions), instructions: String(instructions || '') })
    : refLayout ? refSwapPrompt({ body, options: cleanSwapOptions(config?.swapOptions), instructions: String(instructions || ''), covered: keepArg === 'covered' })
    : buildSwapPrompt({ refCount: refs.length, body, instructions: String(instructions || ''), keepOutfit: chosenOutfit ? true : outfitMode(cfg), ownPlace: uni.place, options: cleanSwapOptions(config?.swapOptions) }), ...uni.lines].join('\n');
  return { prompt, engine: cfg.frameEngine, images: 1 + refs.length + uni.inputs.length, own: !!own, refLayout }; // refLayout: image 1 = her photo, image 2 = the frame
}

/** Her photos for the swap: 3 (2 face angles + 1 body shot), fewer when the engine takes fewer images with the scene and her place. */
const swapRefCount = (cfg) => Math.max(1, Math.min(3, maxImagesFor(cfg.frameEngine, cfg) - 1 - (placeAsset(cfg) ? 1 : 0)));

/** The reference's swap: Nano Banana (2 or Pro) with its own prompt and two images (not Flux / Seedream / Wan / her workflows). */
const isRefSwap = (cfg) => !IMAGE_EDITORS[cfg.frameEngine] && !RH_FRAME_ENGINES.includes(cfg.frameEngine);

/**
 * Optional universe assets for remakes: the outfit to wear and her place (replaces the original background).
 * The phone is never added: a remake keeps the reel's own props.
 */
function universeRefs(cfg, startIndex) {
  const out = { inputs: [], lines: [], place: false };
  const place = placeAsset(cfg);
  const outfit = outfitAsset(cfg);
  let i = startIndex;
  if (outfit) {
    const clean = outfit.clean_path && fs.existsSync(path.join(MEDIA_DIR, outfit.clean_path));
    const desc = (outfit.description || outfit.garment_desc || '').trim().replace(/[.\s]+$/, '');
    out.inputs.push(clean ? outfit.clean_path : outfit.path); i++;
    out.lines.push(`OUTFIT (priority): she wears EXACTLY the clothes shown in image ${i}${desc ? ` — ${desc}` : ''} — same garments, colours, fabric, fit, print and details.${clean ? '' : ` Use only the clothing from image ${i}; ignore any person, face, body, skin or tattoos in it.`} Do NOT keep the original person's outfit.`);
  }
  if (place) {
    out.inputs.push(place.path); i++;
    out.place = true;
    out.lines.push(`Setting: do NOT use the original background — place her in HER own ${place.subtype || 'room'} shown in image ${i} (exactly the same place: walls, furniture, bedding, decor, window, colours${place.description ? `; ${place.description}` : ''}), keeping the original pose, framing and camera angle.`);
  }
  return out;
}

/** Best first: passed QA, then face similarity. Images without the chosen outfit are left out. */
const rankCandidates = (list) => list.filter((c) => c.outfitOk !== false && !c.outfitSkipped)
  .sort((a, b) => (b.qa?.ok ? 1 : 0) - (a.qa?.ok ? 1 : 0) || (b.qa?.same ?? 0) - (a.qa?.same ?? 0));

/** Quality check (same woman? tattoos, piercings, garbled print?) of the images not checked yet, in parallel. */
async function qaImages(g, ctx, list) {
  const todo = list.filter((c) => !('qa' in c));
  if (!todo.length) return;
  status(g.id, `Quality check of ${todo.length} image(s)…`);
  await Promise.all(todo.map((c) => checkFrame({ imgPath: c.path, refs: ctx.refs, body: ctx.body }).then((q) => { c.qa = q; }, () => { c.qa = null; })));
  for (const c of todo) {
    const n = list.indexOf(c) + 1;
    if (c.qa) log(g.id, c.qa.ok ? `Image ${n}: quality check OK (face ${c.qa.same ?? '?'}/10)` : `Warning on image ${n}: ${c.qa.issues.join('; ')}`);
  }
}

/** Photo post remake (one or more slides) and/or the same scene in extra poses. Ends in "review". */
async function stagePhotos(g, ctx) {
  if (!ctx.model_id) throw new Error('This remake has no model assigned');
  if (!ctx.refs.length) throw new Error(`Model ${ctx.model_name} has no photos in its folder: add them in Models`);
  const cfg = g.config;
  checkRhImagePrereqs(g, ctx);
  const { refs, description } = pickRefs(ctx.refs, 5);
  const refPaths = refs.map((r) => r.path);
  const isCanc = () => isCancelled(g.id);
  const common = { cfg, onStatus: (m) => status(g.id, m), isCancelled: isCanc };
  const userImg = userPrompt(g, 'image');
  // A run interrupted by a restart resumes: slides and poses already paid for are kept, not generated again.
  const prev = cfg.photoRun && Date.now() - (cfg.photoRun.at || 0) < RESUME_TTL ? cfg.photoRun : null;
  const run = { at: prev?.at || Date.now(), done: [...(prev?.done || [])], count: prev?.count || 0, base: prev?.base || null };
  if (prev && run.count) log(g.id, `Resuming: ${run.count} photo(s) already generated, without paying again`);
  const before = g.candidates;
  const all = [];
  const prompts = [];
  let blockedCount = 0;
  const persist = (key) => {
    if (key && !run.done.includes(key)) run.done.push(key);
    const c = freshConfig(g.id);
    c.photoRun = { ...run, count: run.count + all.length };
    update(g.id, { candidates: [...before, ...all], config: c });
  };
  // Realism pass: every new image is marked, then refined at the end (a restart finishes the marked ones).
  const finishing = cfg.imageFinish === 'instagirl';
  const mark = (list) => { if (finishing) list.forEach((c) => { c.finishPending = true; }); return list; };

  let photoPrep = null;
  if (g.kind === 'photo') {
    if (!ctx.slides.length) throw new Error('This post has no saved photos: scan the creator again');
    const photoOutfit = outfitAsset(cfg);
    photoPrep = photoOutfit ? await prepareOutfit(photoOutfit, { cfg, log: (m) => log(g.id, m) }) : null;
    if (photoPrep?.cost) addCost(g.id, photoPrep.cost, 'roupa', imgProvider(g));
    const idxs = (Array.isArray(cfg.slides) ? cfg.slides : [0]).filter((i) => ctx.slides[i]);
    for (const i of idxs) {
      if (isCanc()) return;
      if (run.done.includes(`s${i}`)) continue;
      const src = ctx.slides[i];
      const swapRefs = pickRefs(ctx.refs, swapRefCount(cfg), { star: ctx.default_ref }).refs; // her ★ photo first, as in the video remakes
      const uni = universeRefs(photoPrep ? { ...cfg, outfitId: null } : cfg, 1 + swapRefs.length);
      const ownSwap = String(ctx.swap_prompt || '').trim(); // Perfis: her own swap prompt replaces the app's (image 1 = the post's photo)
      const prompt = userImg || [ownSwap ? customSwapPrompt(ownSwap, { options: cleanSwapOptions(cfg.swapOptions), instructions: ctx.imageInstructions }) : buildSwapPrompt({ refCount: swapRefs.length, body: ctx.body, instructions: ctx.imageInstructions, keepOutfit: photoPrep ? true : outfitMode(cfg), ownPlace: uni.place, options: cleanSwapOptions(cfg.swapOptions) }), ...uni.lines].join('\n');
      prompts.push(prompt);
      log(g.id, `Photo ${i + 1}: person swap (photo edit)${uni.inputs.length ? ' + her universe' : ''}…`);
      const aspect = aspectFor(readMedia(src));
      let imgs = [];
      try {
        imgs = RH_FRAME_ENGINES.includes(cfg.frameEngine)
          ? await rhFrameImages(g, ctx, src, { n: cfg.variants, tag: `g${g.id}_s${i}`, label: `Photo ${i + 1}`, meta: { slide: i } })
          : await nanoBananaImages({ ...common, tag: `g${g.id}_s${i}`, inputs: [src, ...swapRefs.map((r) => r.path), ...uni.inputs], hasSceneImage: false, systemPrompt: uni.place ? SWAP_PLACE_SYSTEM_PROMPT : SWAP_SYSTEM_PROMPT, prompt, n: cfg.variants, aspectRatio: aspect, meta: { slide: i, label: `Photo ${i + 1}` }, engine: cfg.frameEngine });
      } catch (e) {
        if (!e.safety) throw e;
        blockedCount++;
        log(g.id, `Photo ${i + 1}: ${e.provider ? e.message : "blocked by Google's safety filter"}`);
      }
      addCost(g.id, imgs.reduce((a, c) => a + (c.cost || 0), 0), 'imagem', imgProvider(g), undefined, imgs.length);
      // Chosen outfit: the swap kept the post's clothes, now her outfit goes on (every variant in parallel).
      if (photoPrep && imgs.length && !isCanc()) {
        await Promise.all(imgs.map(async (c, k) => {
          try {
            const r = await ensureOutfitOn({ imgPath: c.path, prep: photoPrep, cfg, body: ctx.body, tag: `g${g.id}_s${i}_${k}`, aspectRatio: aspect, log: (m) => log(g.id, `Photo ${i + 1}: ${m}`), isCancelled: isCanc });
            addCost(g.id, r.cost, 'roupa', imgProvider(g));
            Object.assign(c, { path: r.path, outfitOk: r.ok, outfitWorn: r.worn });
          } catch (e) {
            log(g.id, `Warning on photo ${i + 1}: could not put the chosen outfit on her (${String(e.message).slice(0, 120)})`);
            Object.assign(c, { outfitOk: false, outfitWorn: '' });
          }
        }));
      }
      all.push(...mark(imgs));
      if (!run.base && imgs[0]) run.base = imgs[0].path;
      persist(`s${i}`);
    }
  }
  // Extra poses: same scene/outfit as the base image (the post's first selected slide, or a chosen generated image).
  const poseKeys = Array.isArray(cfg.poses) ? cfg.poses : [];
  const poses = [...POSES.filter((p) => poseKeys.includes(p.key)), ...(cfg.customPose ? [{ key: 'custom', label: 'Custom pose', prompt: cfg.customPose }] : [])];
  let poseError = null;
  if (poses.length && !isCanc()) {
    const base = [cfg.baseImage, run.base, ctx.slides[cfg.slides?.[0] ?? 0], ctx.sourceFrame].find(existsMedia);
    if (!base) throw new Error('No base image for the poses');
    const aspect = aspectFor(readMedia(base));
    const todo = poses.filter((p) => !run.done.includes(`p:${p.key}`));
    // Poses are independent of each other: up to 3 at a time. The base image already shows her outfit.
    const results = await mapLimit(todo, 3, async (p) => {
      if (isCanc()) return;
      log(g.id, `Pose: ${p.label}…`);
      const prompt = buildPosePrompt({ pose: p.prompt, refDescription: description, persona: ctx.persona, body: ctx.body });
      prompts.push(prompt);
      let imgs = [];
      try {
        imgs = await nanoBananaImages({ ...common, tag: `g${g.id}_p${poses.indexOf(p)}`, inputs: [...refPaths, base], hasSceneImage: true, prompt, n: 1, aspectRatio: aspect, meta: { pose: p.key, label: p.label } });
      } catch (e) {
        if (!e.safety) throw e;
        blockedCount++;
        log(g.id, `Pose “${p.label}”: blocked by Google's safety filter`);
      }
      addCost(g.id, imgs.reduce((a, c) => a + (c.cost || 0), 0), 'imagem', imgProvider(g), undefined, imgs.length);
      await Promise.all(imgs.map((c) => checkFrame({ imgPath: c.path, refs: ctx.refs, body: ctx.body }).then((q) => { c.qa = q; }, () => { c.qa = null; })));
      all.push(...mark(imgs));
      persist(`p:${p.key}`);
    });
    poseError = results.find((r) => !r.ok)?.error || null;
  }
  if (isCanc()) return;
  if (finishing) await finishPendingImages(g, ctx, [...before, ...all], () => persist());
  if (isCanc()) return;
  if (poseError) throw poseError; // the poses that worked are already saved
  const total = run.count + all.length;
  const editor = IMAGE_EDITORS[cfg.frameEngine];
  if (!total) {
    throw Object.assign(new Error(!blockedCount ? 'Nothing to generate: choose at least one photo or pose'
      : editor && !poses.length ? `The content filter of ${editor.label} blocked the photos. ${OTHER_EDITOR_HINT}` : SAFETY_HELP), { safety: blockedCount > 0, ...(editor && !poses.length ? { provider: cfg.frameEngine } : {}) });
  }
  const order = (c) => (c.pose ? 1000 + poses.findIndex((p) => p.key === c.pose) : c.slide ?? 0);
  const sorted = [...all].sort((a, b) => order(a) - order(b));
  const config = freshConfig(g.id);
  delete config.photoRun;
  const fields = { candidates: [...before, ...sorted], stage: 'review', error: null, config };
  if (prompts.length) {
    fields.image_prompt = prompts[0];
    recordPrompt(config, 'image', prompts[0], !!userImg && prompts[0] === userImg);
  }
  update(g.id, fields);
  log(g.id, `${total} photo(s) ready for review`);
}

async function stageImage(g, ctx) {
  if (g.kind === 'photo' || g.kind === 'poses') return stagePhotos(g, ctx);
  if (!ctx.model_id) throw new Error('This remake has no model assigned');
  if (!ctx.refs.length) throw new Error(`Model ${ctx.model_name} has no photos in its folder: add them in Models`);
  const cfg = g.config;
  const isCanc = () => isCancelled(g.id);
  await checkVideoPrereqs(g, ctx); // nothing is paid for until the video step is known to be possible
  // "A minha imagem": her image made elsewhere and uploaded on the Remake page. Nothing is generated or paid for here:
  // it gets the same quality check as a generated image, then goes on like a chosen candidate.
  if (cfg.ownImage) {
    if (!existsMedia(cfg.ownImage)) throw new Error('The image you uploaded no longer exists: upload it again');
    const own = g.candidates.find((c) => c.path === cfg.ownImage) || { path: cfg.ownImage, label: 'Your image', uploaded: true };
    savePrompt(g.id, 'image', '[Your image: uploaded by you, no image was generated]', false);
    log(g.id, 'Your image: no images generated, going on to the video');
    await qaImages(g, ctx, [own]);
    if (isCanc()) return;
    const config = freshConfig(g.id);
    delete config.imagingPending;
    Object.assign(config, { pick: own.path, final: own.path, step: 'video', skipEnlarge: true }); // nothing to swap or enlarge
    const candidates = [...g.candidates.filter((c) => c.path !== own.path), own];
    if (cfg.autoApprove) {
      update(g.id, { candidates, chosen_image: own.path, stage: 'animating', config });
      log(g.id, 'Generating the video from your image');
    } else {
      update(g.id, { candidates, stage: 'awaiting_approval', config });
      log(g.id, 'Your image is ready: press “Generate” in step 4');
    }
    return;
  }
  const outfit = outfitAsset(cfg);
  const prep = outfit ? await prepareOutfit(outfit, { cfg, log: (m) => log(g.id, m) }) : null;
  if (prep?.cost) addCost(g.id, prep.cost, 'roupa', imgProvider(g));
  if (isCanc()) return;
  // The scene = a frame of the reel VIDEO (captured by the user, or its first second) — the TikTok cover
  // is often a different moment/outfit, which made the copy's clothes and actions not match the video.
  const scene = await videoStartFrame(ctx, g.id, cfg.videoEngine === 'wan3_copy');
  // With a chosen outfit, step 1 only swaps the person; step 2 = verified try-on edit (ensureOutfitOn).
  const outfitArg = prep ? true : outfitMode(cfg);
  const userImg = userPrompt(g, 'image');
  let inputs; let fullPrompt; let systemPrompt;
  let aspectRatio = '9:16';
  if (scene) {
    const own = String(ctx.swap_prompt || '').trim(); // Perfis: her own swap prompt replaces the app's
    // Nano Banana (2 or Pro): the reference's prompt, image 1 = her photo (★ first), image 2 = the frame.
    const refLayout = !own && isRefSwap(cfg) && outfitArg !== false; // it keeps the frame's outfit: not for "Roupa das fotos dela"
    const { refs } = pickRefs(ctx.refs, refLayout ? 1 : swapRefCount(cfg), { star: ctx.default_ref }); // else 2 face angles + 1 body shot
    const uni = universeRefs(prep ? { ...cfg, outfitId: null } : cfg, 1 + refs.length);
    fullPrompt = userImg || [own ? customSwapPrompt(own, { options: cleanSwapOptions(cfg.swapOptions), instructions: ctx.imageInstructions })
      : refLayout ? refSwapPrompt({ body: ctx.body, options: cleanSwapOptions(cfg.swapOptions), instructions: ctx.imageInstructions, covered: outfitArg === 'covered' })
      : buildSwapPrompt({ refCount: refs.length, body: ctx.body, instructions: ctx.imageInstructions, keepOutfit: outfitArg, ownPlace: uni.place, options: cleanSwapOptions(cfg.swapOptions) }), ...uni.lines].join('\n');
    inputs = refLayout ? [...refs.map((r) => r.path), scene, ...uni.inputs] : [scene, ...refs.map((r) => r.path), ...uni.inputs];
    patchConfig(g.id, { sceneUsed: scene, refsUsed: refs.map((r) => r.path) }); // shown on the project: what went in
    // The reference's swap goes word for word, as the reference app sends it (no editor instruction in front of it).
    systemPrompt = refLayout ? '' : uni.place ? SWAP_PLACE_SYSTEM_PROMPT : SWAP_SYSTEM_PROMPT;
    // Same shape as the video frame, so @Image1 lines up with @Video1 (the TikTok cover keeps the classic 9:16).
    if (scene !== ctx.thumb_path) aspectRatio = frameAspect(scene);
    log(g.id, `Person swap in the video frame (${IMAGE_EDITORS[cfg.frameEngine]?.label || 'Nano Banana'}): face/hair/body from ${refs.map((r) => r.kind).join(', ')}${uni.place ? ' + her setting' : ''}`);
  } else {
    const { refs, description } = pickRefs(ctx.refs, 7, { star: ctx.default_ref });
    const uni = universeRefs(prep ? { ...cfg, outfitId: null } : cfg, refs.length);
    fullPrompt = userImg || [buildImagePrompt({
      model: { persona: ctx.persona }, refCount: refs.length, refDescription: description, analysis: g.analysis,
      instructions: ctx.imageInstructions, hasSourceFrame: false, body: ctx.body, keepOutfit: outfitArg,
    }), ...uni.lines].join('\n');
    inputs = [...refs.map((r) => r.path), ...uni.inputs];
    patchConfig(g.id, { sceneUsed: null, refsUsed: refs.map((r) => r.path) });
    systemPrompt = NB_SYSTEM_PROMPT;
    log(g.id, 'No video frame: creating the scene from her photos');
  }
  savePrompt(g.id, 'image', fullPrompt, !!userImg);
  // "+4" / "+8" on the project: that many images this time only.
  const wantN = Math.max(1, Math.min(8, Number(cfg.variantsOnce) || cfg.variants || 1));
  if (cfg.variantsOnce) patchConfig(g.id, { variantsOnce: null });

  // Images already paid for by a run that a restart interrupted are reused, not generated (and paid) again.
  const pend = cfg.imagingPending && Date.now() - (cfg.imagingPending.at || 0) < RESUME_TTL ? cfg.imagingPending : null;
  const pendPaths = new Set(pend?.paths || []);
  const before = g.candidates.filter((c) => !pendPaths.has(c.path));
  let candidates = g.candidates.filter((c) => pendPaths.has(c.path) && existsMedia(c.path));
  const pendAt = pend?.at || Date.now();
  const persist = () => {
    const c = freshConfig(g.id);
    c.imagingPending = { at: pendAt, paths: candidates.map((x) => x.path) };
    update(g.id, { candidates: [...before, ...candidates], config: c });
  };
  if (candidates.length) log(g.id, `Resuming with ${candidates.length} image(s) already generated, without paying again`);
  else if (RH_FRAME_ENGINES.includes(cfg.frameEngine) && scene) {
    if (cfg.frameEngine === 'sky') {
      savePrompt(g.id, 'image', `[Z-Image SKY · RunningHub] ${skyText(ctx)}`, false);
      log(g.id, 'Her image from your Z-Image ControlNet (SKY) workflow on RunningHub: same pose and composition as the frame, face and body from her LoRA');
    } else {
      savePrompt(g.id, 'image', '[INSTARAW Faceswap · RunningHub] the face and hair of the person in the frame swapped for hers; the rest stays the same', false);
      log(g.id, 'Her image from your INSTARAW Faceswap workflow on RunningHub: her face and hair in the video frame, the rest unchanged');
    }
    candidates = await rhFrameImages(g, ctx, scene, { n: wantN, tag: `g${g.id}` });
    persist();
  } else {
    candidates = await nanoBananaImages({
      inputs, hasSceneImage: false, systemPrompt, aspectRatio,
      prompt: fullPrompt, cfg, n: wantN, tag: `g${g.id}`, onStatus: (m) => status(g.id, m), isCancelled: isCanc,
      engine: scene ? cfg.frameEngine : 'nano', // Flux.2 / Seedream edit the reel frame; without a frame Nano Banana creates the scene
    });
    addCost(g.id, candidates.reduce((a, c) => a + (c.cost || 0), 0), 'imagem', imgProvider(g), undefined, candidates.length);
    persist(); // saved right away: a restart from here on does not pay for them again
  }
  if (isCanc()) {
    if (candidates.length) log(g.id, `Canceled midway: ${candidates.length === 1 ? 'the image already requested (and paid) was kept' : `the ${candidates.length} images already requested (and paid) were kept`} in step 2`);
    return;
  }
  if (cfg.videoEngine === 'wan3_copy' && cfg.firstFrame === 'direct') {
    // Images were asked for, so the video must start from the chosen one, not from her photos directly.
    const cur = getGeneration(g.id);
    update(g.id, { config: { ...cur.config, firstFrame: 'nano' }, ...(userPrompt(cur, 'video') ? {} : { video_prompt: null }) });
    log(g.id, '1st frame switched to Nano Banana: the video will start from the chosen image');
  }

  const note = (c) => (m) => log(g.id, candidates.length > 1 ? `Image ${candidates.indexOf(c) + 1}: ${m}` : m);
  const tryOn = async (c) => {
    try {
      const r = await ensureOutfitOn({ imgPath: c.path, prep, cfg, body: ctx.body, tag: `g${g.id}_c${candidates.indexOf(c)}`, aspectRatio, log: note(c), isCancelled: isCanc });
      addCost(g.id, r.cost, 'roupa', imgProvider(g));
      if (r.path !== c.path) delete c.qa; // a new image: checked again
      Object.assign(c, { path: r.path, outfitOk: r.ok, outfitWorn: r.worn });
    } catch (e) {
      note(c)(`Warning: could not put the chosen outfit on her (${String(e.message).slice(0, 120)})`);
      Object.assign(c, { outfitOk: false, outfitWorn: '' });
    }
    persist();
  };
  if (prep && !cfg.autoApprove) {
    // Manual: every image gets the outfit (in parallel), so any of them can be chosen.
    const todo = candidates.filter((c) => !('outfitOk' in c));
    if (todo.length) {
      status(g.id, `Putting on the chosen outfit (${todo.length} image(s))…`);
      await Promise.all(todo.map(tryOn));
    }
  }
  if (isCanc()) return;
  // Quality check of every first frame (same woman? tattoos/piercings/garbled print?) BEFORE video credits.
  await qaImages(g, ctx, candidates);
  persist();
  if (isCanc()) return;
  if (prep && cfg.autoApprove) {
    // Automatic: only the image that will be animated needs the outfit. Best-ranked first, stop at the first that works.
    let applied = candidates.find((c) => 'outfitOk' in c && c.outfitOk !== false && !c.outfitSkipped);
    for (const c of rankCandidates(candidates)) {
      if (applied || isCanc()) break;
      if ('outfitOk' in c) continue;
      await tryOn(c);
      if (c.outfitOk !== false) applied = c;
    }
    if (isCanc()) return;
    if (applied) {
      for (const c of candidates) {
        if (c !== applied && !('outfitOk' in c)) Object.assign(c, { outfitSkipped: true, outfitOk: false, outfitWorn: 'Chosen outfit not applied: this image was not used' });
      }
    }
    await qaImages(g, ctx, candidates); // the dressed image, when the try-on produced a new one
    if (isCanc()) return;
  }
  // Automático = automático: the best image goes on (QA only ranks and warns). The one exception is a
  // chosen outfit that could not be put on her — animating that would pay for the wrong clothes.
  let pick = rankCandidates(candidates)[0];
  const swapPick = pick;
  if (cfg.autoApprove && pick && cfg.enlarge) {
    pick = await autoEnlarge(g, ctx, pick, candidates, persist); // adds the edits to `candidates`
    if (isCanc()) return;
  }
  const all = [...before, ...candidates];
  const config = freshConfig(g.id);
  delete config.imagingPending;
  const back = g.video_path && ['review', 'approved'].includes(config.returnStage) ? config.returnStage : 'awaiting_approval';
  delete config.returnStage;
  if (cfg.autoApprove && pick) {
    Object.assign(config, { pick: swapPick.path, final: pick.path, step: 'video' }); // shown on the steps: what Automático chose
    if (pick === swapPick) config.skipEnlarge = true; else delete config.skipEnlarge;
    update(g.id, { candidates: all, chosen_image: pick.path, stage: 'animating', config });
    const dressed = prep ? (pick.outfitOk ? ' (outfit confirmed)' : ' (outfit applied)') : '';
    log(g.id, `Automatic approval${candidates.length > 1 ? ' of the best image' : ''}${dressed}. Generating the video`);
  } else if (cfg.autoApprove && !pick) {
    config.step = 'pick';
    update(g.id, { candidates: all, stage: back, config });
    log(g.id, 'Warning: the chosen outfit did not come out right. Stopped before the video so you do not pay for a video with the wrong outfit. Choose an image anyway or generate more variants.');
  } else {
    config.step = 'pick'; // step 2: you choose the swap (a pick from before stays marked until you choose again)
    update(g.id, { candidates: all, stage: back, config });
    log(g.id, candidates.length === 1 ? '1 image generated: choose it in step 2' : `${candidates.length} images generated: choose one in step 2`);
  }
}

async function stageVideo(g, ctx) {
  const cfg = g.config;
  const s = getSettings();
  const engine = cfg.videoEngine || 'wan3';
  const usesImage = !EDIT_ENGINES.includes(engine) && !(engine === 'wan3_copy' && cfg.firstFrame === 'direct');
  if (cfg.imageFinish === 'instagirl' && usesImage && g.chosen_image) {
    g = await finishChosenFrame(g, ctx);
    if (isCancelled(g.id)) return;
  }
  if (engine === 'animate_replace') return stageAnimateReplace(g, ctx, cfg, s);
  if (RH_VIDEO_ENGINES[engine]) return stageRhVideo(g, ctx, cfg, s, RH_VIDEO_ENGINES[engine]);
  if (engine === 'wan3_copy') return stageWan3Copy(g, ctx, cfg, s);
  throw comfyOnlyError(); // Recriar, Kling, Wan 2.7 video edit: only the Comfy API had them
}

// ---- WaveSpeed video jobs that survive a restart ------------------------------------------------

/** Merge `patch` into config.wanTask (null removes it). */
function setWanTask(id, patch) {
  const cfg = freshConfig(id);
  if (patch === null) delete cfg.wanTask;
  else cfg.wanTask = { ...(cfg.wanTask || {}), ...patch };
  update(id, { config: cfg });
}

/** The Wan task saved for this exact request (same prompt, images and settings), if still recent. */
function savedWanTask(id, key) {
  const t = freshConfig(id).wanTask;
  return t?.id && t.key === key && Date.now() - (t.at || 0) < RESUME_TTL ? t : null;
}

/** Wan 3.0 (or Prime) reference-to-video on WaveSpeed. */
const wanR2VModel = (m) => (/prime/i.test(String(m || '')) ? 'alibaba/wan-3.0-prime/reference-to-video' : 'alibaba/wan-3.0/reference-to-video');
/**
 * The video prompt for WaveSpeed: @Image1 / @Video1 become "Image 1" / "Video 1" (the media are named by the order they
 * are sent in), and step 4's negative text (there is no negative-prompt field) is added as what must not appear.
 */
const wsVideoPrompt = (prompt, negative, counts) => {
  const p = rewriteRefTags(prompt, { audio: 0, ...counts });
  return negative ? `${p}\nMust NOT appear: ${negative}` : p;
};
/** A content refusal, quoted: the provider checks the image, the reel and the text together and does not say which one. */
const videoRefusal = (raw, label) => {
  const reply = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `The content filter of ${label} refused this request and the video was not made.${reply ? ` Reply: «${reply}».` : ''} It is not an app error: the filter looks at the image, the reel and the text together and does not say which one it refused.`;
};

/**
 * A WaveSpeed video job saved on the generation (config.wanTask): after a restart (e.g. node --watch reloading) the
 * worker waits for the SAME job, or downloads its finished video again, instead of paying again. `task` = the saved job
 * for this request (or null); `makeInput` uploads the media and builds the request only when a job is created.
 * A refusal by the model's content check is reported in the provider's own words (never reworded or retried).
 */
async function runWsVideo(g, ws, task, key, model, makeInput, { label, onStatus, isCancelled: isCanc }) {
  let id = task?.id || null;
  let url = task?.url || null;
  if (id) log(g.id, url ? `The ${label} video was already done: downloading it, without paying again` : `Resuming the ${label} request already at WaveSpeed, without paying again`);
  else {
    const input = await makeInput();
    if (isCanc()) throw new Error('Canceled');
    onStatus?.(`${label}: creating the request at WaveSpeed…`);
    id = await ws.submit(model, input);
    setWanTask(g.id, { id, key, at: Date.now() });
  }
  if (!url) {
    try {
      url = (await ws.wait(id, { onStatus: (m) => onStatus?.(`${label}: ${m}`), isCancelled: isCanc, intervalMs: 5000, maxMs: 60 * 60e3 })).outputs[0];
    } catch (e) {
      // Failed or refused at WaveSpeed: a retry creates a new job. An outage, a timeout or "Cancelado" keep it, so a
      // retry waits for the same (maybe already billed) job.
      if (!(e.network || e.transient) && !/Cancelado|Cancell?ed|tempo esgotado|timed out/.test(String(e.message))) setWanTask(g.id, null);
      if (e.safety) throw Object.assign(new Error(videoRefusal(e.raw || e.message, label)), { moderation: true, safety: true, provider: 'wan', raw: String(e.raw || e.message) });
      throw e;
    }
    setWanTask(g.id, { url });
  }
  onStatus?.(`${label}: downloading the video…`);
  try { return await WaveSpeed.download(url, 'video'); } catch (e) {
    if (/HTTP 4\d\d/.test(String(e.message))) setWanTask(g.id, null); // the link expired: a retry creates a new job
    throw e;
  }
}

/**
 * Exact remake with Wan 3.0 R2V: the original reel is the motion/camera/scene reference (≤15 s), the approved
 * first frame is the AI model in the scene, her real face locks identity; the reel's audio is put back with ffmpeg.
 */
async function stageWan3Copy(g, ctx, cfg, s) {
  const direct = cfg.firstFrame === 'direct' || !g.chosen_image;
  if (direct && !ctx.refs.length) throw new Error(`Model ${ctx.model_name} has no photos in its folder`);
  if (!s.wavespeed_api_key) throw new Error('The WaveSpeed API key is missing: paste it in Settings → Pipeline');
  const ws = new WaveSpeed(s.wavespeed_api_key);
  let rel;
  try {
    rel = await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
  } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
  const srcAbs = path.join(MEDIA_DIR, rel);
  const info = ffmpegPath() ? await probe(srcAbs) : { duration: ctx.duration, hasAudio: true };
  const full = info.duration || ctx.duration || 10;
  if (full < 2) throw new Error('The reel is too short (minimum 2 s)');
  if (full > WAN_REF_VIDEO_MAX + 0.4 && !ffmpegPath()) throw new Error(`The reel is ${Math.round(full)} s long and the Wan 3.0 reference takes up to ${WAN_REF_VIDEO_MAX} s: install ffmpeg (npm run setup) to cut it automatically`);
  const secs = Math.max(2, Math.min(WAN_REF_VIDEO_MAX, Math.round(full)));

  const face = ctx.refs.find((r) => r.kind === 'face_front' && !r.generated) || ctx.refs.find((r) => r.kind === 'face_front');
  // Direct mode: @Image1 = her best real full-body photo (character), @Image2 = face.
  const bodyRef = ctx.refs.find((r) => r.kind === 'body_front' && !r.generated) || ctx.refs.find((r) => r.kind.startsWith('body_')) || face || ctx.refs[0];
  const main = direct ? bodyRef.path : g.chosen_image;
  const outfit = outfitAsset(cfg);
  const prep = outfit ? await prepareOutfit(outfit, { cfg, log: (m) => log(g.id, m) }) : null;
  if (prep?.cost) addCost(g.id, prep.cost, 'roupa', imgProvider(g));
  const outfitRef = prep?.ref || null; // clothing-only shot: keeps Wan from copying the clothes of @Video1
  // Refs: @Image1 main, @Image2 face, @Image3 second face angle (locks identity in talking/close-up reels), then the outfit.
  const faceRef = face && face.path !== main ? face.path : null;
  const face2Ref = faceRef ? (ctx.refs.find((r) => ['face_smile', 'face_left', 'face_right'].includes(r.kind) && r.path !== faceRef && r.path !== main && fs.existsSync(path.join(MEDIA_DIR, r.path)))?.path || null) : null;
  const refPaths = [main, faceRef, face2Ref, outfitRef].filter(Boolean);
  const idx = (p) => (p ? refPaths.indexOf(p) + 1 : null);
  // Output in the reel's own shape: from the first frame (Nano Banana keeps the frame's shape), or the reel frame in direct mode.
  const ratio = wanRatioOf(direct ? ctx.frame_path : g.chosen_image);
  const userVid = userPrompt(g, 'video');
  const prompt = userVid || buildWan3CopyPrompt({ keepOutfit: outfitMode(cfg), instructions: ctx.instructions, body: ctx.body, seconds: secs, hasFace: !!faceRef, face2: idx(face2Ref), direct, ownPlace: !!placeAsset(cfg) && !direct, outfitImage: idx(outfitRef), outfitDesc: prep?.desc, outfitClean: !!prep?.clean, ratio });
  savePrompt(g.id, 'video', prompt, !!userVid);
  const sent = withVideoExtra(prompt, cfg); // + step 4's extra text
  const negative = videoNegative(cfg);
  if (sent !== prompt || negative) log(g.id, `Step 4 extras in the video prompt${negative ? ' (with the negative)' : ''}`);
  const muxAudio = cfg.keepSound !== false && info.hasAudio && !!ffmpegPath();
  const key = hashText(JSON.stringify(['wan3_copy', sent, negative, refPaths, ratio, secs, cfg.wanModel, cfg.wanResolution, muxAudio]));
  const task = savedWanTask(g.id, key);
  if (task?.out && existsMedia(task.out)) {
    log(g.id, 'The video of this generation was already done: going on with the quality check');
    return finishVideo(g, ctx, task.out, prep);
  }
  log(g.id, `Wan 3.0 exact copy on WaveSpeed (${/prime/i.test(cfg.wanModel || '') ? 'Prime' : 'Standard'}, ${cfg.wanResolution}, ${secs} s${muxAudio ? ', original audio' : ''})…`);
  const refVideo = async () => {
    // Anything over 15 s is cut to exactly 15 s (without ffmpeg only up to 15.4 s can be sent as is).
    if (full <= WAN_REF_VIDEO_MAX || !ffmpegPath()) return readMedia(rel);
    log(g.id, `The reel is ${fmtSecs(full)} s long: using the first ${WAN_REF_VIDEO_MAX} s as the reference`);
    return trimVideo(srcAbs, WAN_REF_VIDEO_MAX);
  };
  let buffer = await runWsVideo(g, ws, task, key, wanR2VModel(cfg.wanModel), async () => {
    // Her images first, then the reel: the prompt names them Image 1…n and Video 1 (the order they are sent in).
    status(g.id, 'Video: uploading the images and the reel to WaveSpeed…');
    const [images, video] = await Promise.all([
      Promise.all(refPaths.map((p, i) => ws.upload(readMedia(p), `g${g.id}_ref${i + 1}${path.extname(p) || '.png'}`, mimeOf(p)))),
      refVideo().then((b) => ws.upload(b, `g${g.id}_reel.mp4`, 'video/mp4')),
    ]);
    return {
      prompt: wsVideoPrompt(sent, negative, { image: refPaths.length, video: 1 }),
      reference_images: images, reference_videos: [video],
      resolution: String(cfg.wanResolution || '720P').toLowerCase(), aspect_ratio: ratio, duration: secs,
      enable_audio: !muxAudio, // the reel's music goes back on afterwards
      enable_prompt_expansion: false, // our exact-copy instructions go as written
    };
  }, { label: 'Wan 3.0 (Alibaba)', onStatus: (m) => status(g.id, `Video: ${m}`), isCancelled: () => isCancelled(g.id) });
  if (!freshConfig(g.id).wanTask?.billed) {
    // WaveSpeed bills the reel sent as the reference too: its seconds (at most 15) + the video's.
    addCost(g.id, estimateVideoCost(cfg.wanModel, cfg.wanResolution, secs, Math.ceil(Math.min(full, WAN_REF_VIDEO_MAX))), 'video', 'wavespeed', undefined, secs);
    setWanTask(g.id, { billed: true });
  }
  if (muxAudio) {
    try {
      buffer = await muxOriginalAudio(buffer, srcAbs);
      log(g.id, 'Original audio of the reel applied');
    } catch (e) { log(g.id, `Could not apply the original audio: ${e.message}`); }
  }
  const out = `generated/g${g.id}_${Date.now()}.mp4`;
  fs.writeFileSync(path.join(MEDIA_DIR, out), buffer);
  setWanTask(g.id, { out });
  await finishVideo(g, ctx, out, prep);
}

// ---- the user's own workflows on RunningHub ------------------------------------------------------------------

/** Manual prompt for the SKY workflow (its QwenVL describes the photo; this adds her trigger and the direction). */
function skyText(ctx) {
  return [ctx.instructions && String(ctx.instructions).trim(), 'same outfit, pose and setting as in the photo'].filter(Boolean).join(', ');
}

/** Her clean face photo (not a generated one when possible): the identity source for the Faceswap workflow. */
const faceRef = (ctx) => ctx.refs.find((r) => r.kind === 'face_front' && !r.generated) || ctx.refs.find((r) => r.kind === 'face_front') || ctx.refs[0];

/** Saved RunningHub task of one image slot (resumed after a restart, never paid twice) + the saver for a new one. */
function rhSlot(g, slot) {
  const saved = freshConfig(g.id).rhImageTasks?.[slot];
  return {
    task: saved && Date.now() - (saved.at || 0) < RESUME_TTL ? saved : null,
    onTask: (t) => { const c = freshConfig(g.id); c.rhImageTasks = { ...(c.rhImageTasks || {}), [slot]: { ...t, at: Date.now() } }; update(g.id, { config: c }); },
    done: () => { const c = freshConfig(g.id); if (c.rhImageTasks?.[slot]) { delete c.rhImageTasks[slot]; update(g.id, { config: c }); } },
  };
}

/**
 * Her in a frame/photo with one of her RunningHub workflows (cfg.frameEngine): SKY Z-Image ControlNet (her LoRA)
 * or INSTARAW Faceswap (her face photo). One task per variant, one after another.
 */
async function rhFrameImages(g, ctx, source, { n = 1, tag, label, meta = {} } = {}) {
  const s = getSettings();
  const key = g.config.frameEngine;
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(ctx.model_id);
  const face = key === 'faceswap' ? faceRef(ctx) : null;
  if (key === 'faceswap' && !face) throw new Error(`Model ${ctx.model_name} has no face photos in its folder`);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (isCancelled(g.id)) break;
    const slot = rhSlot(g, `${tag}:${i}`);
    const common = {
      s, task: slot.task, onTask: slot.onTask, isCancelled: () => isCancelled(g.id),
      onStatus: (m) => status(g.id, n > 1 ? `Image ${i + 1}/${n}: ${m}` : m),
    };
    const src = { buf: readMedia(source), name: `frame${path.extname(source) || '.jpg'}` };
    const r = key === 'faceswap'
      ? await runRhImage({ ...common, key, image: src, face: { buf: readMedia(face.path), name: `face${path.extname(face.path) || '.jpg'}` } })
      : await runRhSky({ ...common, model, source: src, prompt: skyText(ctx) });
    r.files.forEach((f, k) => {
      const rel = `generated/${tag}_${Date.now()}_${i}${k ? `_${k}` : ''}.${f.ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), f.buf);
      out.push({ path: rel, engine: 'runninghub', model: RH_WORKFLOWS[key].name, cost: 0, ...(label ? { label } : {}), ...meta });
    });
    if (r.cost) log(g.id, r.cost);
    rhSpend(g.id, r.money, 'imagem');
    slot.done();
  }
  return out;
}

/** What the WAN 2.2 Instagirl pass is told about the picture (it only refines it: low denoise). */
function instagirlPrompt(ctx, model) {
  const id = skyIdentity(model || {});
  return [`candid smartphone photo of a young adult woman with ${id.hair}`, ctx.instructions && String(ctx.instructions).trim(), 'natural skin texture with visible pores, realistic light, true colours'].filter(Boolean).join(', ');
}

/** One image through the WAN 2.2 Instagirl realism workflow → the refined image (media path). */
async function instagirlImage(g, ctx, rel, onStatus) {
  const s = getSettings();
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(ctx.model_id);
  const slot = rhSlot(g, `fin:${rel}`);
  let r;
  try {
    r = await runRhImage({
      s, key: 'instagirl', image: { buf: readMedia(rel), name: `img${path.extname(rel) || '.png'}` },
      values: instagirlValues(model, instagirlPrompt(ctx, model)),
      task: slot.task, onTask: slot.onTask, onStatus, isCancelled: () => isCancelled(g.id),
    });
  } catch (e) {
    // A task RunningHub refused or failed is not resumed next time (a cancelled / timed-out one may still run: kept).
    if (!/Cancelado|Cancell?ed|tempo esgotado|timed out/.test(String(e.message))) slot.done();
    throw e;
  }
  const f = r.files[0];
  const out = `generated/g${g.id}_real_${Date.now()}.${f.ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, out), f.buf);
  if (r.cost) log(g.id, r.cost);
  rhSpend(g.id, r.money, 'imagem');
  slot.done();
  return out;
}

/** Photos: the images marked for the realism pass, one after another. A failure keeps the image as it was. */
async function finishPendingImages(g, ctx, list, save) {
  const todo = list.filter((c) => c.finishPending);
  for (const [k, c] of todo.entries()) {
    if (isCancelled(g.id)) return;
    if (existsMedia(c.path)) {
      try {
        const out = await instagirlImage(g, ctx, c.path, (m) => status(g.id, `Realism ${k + 1}/${todo.length}: ${m}`));
        Object.assign(c, { raw: c.path, path: out, finished: true });
      } catch (e) {
        if (isCancelled(g.id)) return;
        log(g.id, `Warning: the WAN 2.2 Instagirl realism failed on ${c.label || `image ${k + 1}`}; the image stays without that pass (${String(e.message).slice(0, 200)})`);
      }
    }
    delete c.finishPending;
    save();
  }
  if (todo.length) log(g.id, `WAN 2.2 Instagirl realism: ${todo.filter((c) => c.finished).length}/${todo.length} image(s) refined`);
}

/**
 * Video: the chosen image goes through the realism pass before the video. The refined image is added to the
 * candidates; the video starts from it unless the face check says it looks less like her (then the original stays).
 */
async function finishChosenFrame(g, ctx) {
  const cand = g.candidates.find((c) => c.path === g.chosen_image);
  if (cand?.finished || g.candidates.some((c) => c.from === g.chosen_image)) return g;
  log(g.id, 'WAN 2.2 Instagirl realism (RunningHub) on the chosen image, before the video…');
  let out;
  try {
    out = await instagirlImage(g, ctx, g.chosen_image, (m) => status(g.id, `Realism: ${m}`));
  } catch (e) {
    if (!isCancelled(g.id)) log(g.id, `Warning: the WAN 2.2 Instagirl realism failed; the video starts from the chosen image (${String(e.message).slice(0, 200)})`);
    return getGeneration(g.id) || g;
  }
  const q = await checkFrame({ imgPath: out, refs: ctx.refs, body: ctx.body }).catch(() => null);
  const cur = getGeneration(g.id);
  if (!cur) return g;
  const next = { path: out, engine: 'runninghub', model: 'WAN 2.2 Instagirl', cost: 0, label: `${cand?.label || 'Chosen image'} · realism`, finished: true, from: g.chosen_image, ...(q ? { qa: q } : {}) };
  const worse = q && cand?.qa && Number.isFinite(q.same) && Number.isFinite(cand.qa.same) && q.same < cand.qa.same - 1;
  update(g.id, { candidates: [...cur.candidates, next], ...(worse ? {} : { chosen_image: out }) });
  log(g.id, worse
    ? `Warning: with the realism the face looks less like her (${q.same}/10 vs ${cand.qa.same}/10): the video starts from the original image; the refined one stays in the images`
    : 'Realism applied: the video starts from the refined image');
  return getGeneration(g.id);
}

function setRhTask(id, patch) {
  const cfg = freshConfig(id);
  if (patch === null) delete cfg.rhTask;
  else cfg.rhTask = { ...(cfg.rhTask || {}), ...patch };
  update(id, { config: cfg });
}

/**
 * WAN Animate / NB WanAnimate on RunningHub: the approved first frame (her, in the reel's scene) takes the reel's
 * pose, expressions and lip movement. The reel is sent at 30 fps, at most rh_max_secs. The task id is saved, so a
 * restart waits for the same task instead of paying again.
 */
async function stageRhVideo(g, ctx, cfg, s, key) {
  const prof = RH_WORKFLOWS[key];
  if (!g.chosen_image || !existsMedia(g.chosen_image)) throw new Error('No image chosen');
  let rel;
  try {
    rel = await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
  } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
  const srcAbs = path.join(MEDIA_DIR, rel);
  const info = ffmpegPath() ? await probe(srcAbs) : { duration: ctx.duration, hasAudio: true };
  const full = info.duration || ctx.duration || 10;
  const maxSecs = Math.max(3, Math.min(120, Number(s.rh_max_secs) || 30));
  const secs = Math.min(maxSecs, full);
  const outfit = outfitAsset(cfg);
  const prep = outfit ? await prepareOutfit(outfit, { cfg, log: (m) => log(g.id, m) }) : null;
  if (prep?.cost) addCost(g.id, prep.cost, 'roupa', imgProvider(g));
  const keyHash = hashText(JSON.stringify([key, s[prof.setting], g.chosen_image, rel, Math.round(secs * 10)]));
  const saved = freshConfig(g.id).rhTask;
  const task = saved?.key === keyHash && Date.now() - (saved.at || 0) < RESUME_TTL ? saved : null;
  if (task?.out && existsMedia(task.out)) {
    log(g.id, 'The video of this generation was already done: going on with the finish and the quality check');
    return finishVideo(g, ctx, task.out, prep);
  }
  let video = null;
  if (task?.taskId) log(g.id, 'Resuming the RunningHub task that was already running, without paying again');
  else {
    if (full > maxSecs + 0.4) log(g.id, `The reel is ${fmtSecs(full)} s long: the workflow uses the first ${maxSecs} s (change it in Settings → RunningHub)`);
    log(g.id, `${prof.name} (your workflow) on RunningHub, ${RH_INSTANCES[s.rh_instance] || RH_INSTANCES.default} GPU, ${fmtSecs(secs)} s of video…`);
    status(g.id, 'Video: preparing the reel…');
    video = ffmpegPath() ? await prepareForWorkflow(srcAbs, { maxSecs, fps: 30, width: 720 }) : readMedia(rel);
    if (isCancelled(g.id)) return;
  }
  const r = await runRhVideo({
    s, key, task,
    image: { buf: readMedia(g.chosen_image), name: `frame${path.extname(g.chosen_image) || '.png'}` },
    video: video ? { buf: video, name: `reel_${ctx.reel_id}.mp4` } : null,
    seconds: secs,
    onTask: (t) => setRhTask(g.id, { ...t, key: keyHash, at: Date.now() }),
    onStatus: (m) => status(g.id, `Video: ${m}`), isCancelled: () => isCancelled(g.id),
  });
  if (r.cost) log(g.id, r.cost);
  rhSpend(g.id, r.money, 'video');
  let out = `generated/g${g.id}_${Date.now()}.${r.ext || 'mp4'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, out), r.buf);
  if (ffmpegPath()) {
    const p = await probe(path.join(MEDIA_DIR, out)).catch(() => ({}));
    if (cfg.keepSound !== false && !p.hasAudio && info.hasAudio) {
      try {
        const withAudio = `generated/g${g.id}_${Date.now()}_a.mp4`;
        fs.writeFileSync(path.join(MEDIA_DIR, withAudio), await muxOriginalAudio(readMedia(out), srcAbs));
        fs.rmSync(path.join(MEDIA_DIR, out), { force: true });
        out = withAudio;
        log(g.id, 'Original audio of the reel applied');
      } catch (e) { log(g.id, `Could not apply the original audio: ${e.message}`); }
    } else if (cfg.keepSound === false && p.hasAudio) {
      const silent = `generated/g${g.id}_${Date.now()}_mute.mp4`;
      await stripAudio(path.join(MEDIA_DIR, out), path.join(MEDIA_DIR, silent));
      fs.rmSync(path.join(MEDIA_DIR, out), { force: true });
      out = silent;
    }
  }
  setRhTask(g.id, { out });
  await finishVideo(g, ctx, out, prep);
}

// ---- "Trocar a pessoa": Wan 2.2 Animate (the open model) on WaveSpeed ----------------------------------------------
const ANIMATE_MODEL = 'wavespeed-ai/wan-2.2/animate';
const ANIMATE_MAX_SECS = 120;
const ANIMATE_PRICE = { '480p': 0.04, '720p': 0.08 }; // USD per second of the reel, at least 3 s (WaveSpeed, 27/09)
const animateRes = (r) => (r === '480P' ? '480p' : '720p');
export const estimateAnimateCost = (secs, res) => Math.max(3, Math.ceil(Math.min(ANIMATE_MAX_SECS, secs))) * (ANIMATE_PRICE[res] ?? 0.08);

/**
 * The ORIGINAL reel is kept (lip movement, gestures, timing, camera, scene, light) and only the person is replaced
 * by the woman of the approved image: her face, hair and body, in the outfit shown there. It is the open Wan 2.2
 * Animate, run by WaveSpeed. The job is saved on the generation (config.wanTask), so a restart waits for the same job
 * instead of paying again.
 */
async function stageAnimateReplace(g, ctx, cfg, s) {
  if (!s.wavespeed_api_key) throw new Error('The WaveSpeed API key is missing: paste it in Settings → Pipeline');
  if (!g.chosen_image || !existsMedia(g.chosen_image)) throw new Error('No image chosen');
  let rel;
  try {
    rel = await ensureVideo({ id: ctx.reel_id, platform: ctx.platform, external_id: ctx.external_id, url: ctx.url, video_path: ctx.video_path, video_url: ctx.video_url });
  } catch (e) { throw new Error(`The reel's original video is needed, but it could not be downloaded: ${e.message}`); }
  const srcAbs = path.join(MEDIA_DIR, rel);
  const info = ffmpegPath() ? await probe(srcAbs) : { duration: ctx.duration, hasAudio: true };
  const full = info.duration || ctx.duration || 10;
  const secs = Math.min(ANIMATE_MAX_SECS, full);
  const res = animateRes(cfg.wanResolution);
  const muxAudio = cfg.keepSound !== false && info.hasAudio && !!ffmpegPath();
  const outfit = outfitAsset(cfg);
  const prep = outfit ? await prepareOutfit(outfit, { cfg, log: (m) => log(g.id, m) }) : null;
  if (prep?.cost) addCost(g.id, prep.cost, 'roupa', imgProvider(g));
  const key = hashText(JSON.stringify(['animate_ws', g.chosen_image, rel, res, Math.round(secs * 10), muxAudio]));
  const task = savedWanTask(g.id, key);
  if (task?.out && existsMedia(task.out)) {
    log(g.id, 'The video of this generation was already done: going on with the quality check');
    return finishVideo(g, ctx, task.out, prep);
  }
  const ws = new WaveSpeed(s.wavespeed_api_key);
  if (!task) {
    if (full > ANIMATE_MAX_SECS + 0.4) log(g.id, `The reel is ${fmtSecs(full)} s long: the swap uses the first ${ANIMATE_MAX_SECS} s`);
    log(g.id, `Wan 2.2 Animate (WaveSpeed): swapping the person in the original video (${res}, ${fmtSecs(secs)} s)…`);
  }
  let buffer = await runWsVideo(g, ws, task, key, ANIMATE_MODEL, async () => {
    status(g.id, 'Video: preparing the reel…');
    const video = ffmpegPath() ? await reencodeVideo(srcAbs, { fps: 30, maxSecs: ANIMATE_MAX_SECS }) : readMedia(rel);
    status(g.id, 'Video: uploading the image and the reel to WaveSpeed…');
    const [image, reel] = await Promise.all([
      ws.upload(readMedia(g.chosen_image), `g${g.id}_image${path.extname(g.chosen_image) || '.png'}`, mimeOf(g.chosen_image)),
      ws.upload(video, `reel_${ctx.reel_id}.mp4`, 'video/mp4'),
    ]);
    return { image, video: reel, mode: 'replace', resolution: res };
  }, { label: 'Wan 2.2 Animate', onStatus: (m) => status(g.id, `Video: ${m}`), isCancelled: () => isCancelled(g.id) });
  if (!freshConfig(g.id).wanTask?.billed) {
    addCost(g.id, estimateAnimateCost(secs, res), 'video', 'wavespeed', undefined, secs);
    setWanTask(g.id, { billed: true });
  }
  if (muxAudio) {
    try {
      buffer = await muxOriginalAudio(buffer, srcAbs);
      log(g.id, 'Original audio of the reel applied');
    } catch (e) { log(g.id, `Could not apply the original audio: ${e.message}`); }
  }
  const out = `generated/g${g.id}_${Date.now()}.mp4`;
  fs.writeFileSync(path.join(MEDIA_DIR, out), buffer);
  setWanTask(g.id, { out });
  await finishVideo(g, ctx, out, prep);
}

/**
 * Every video ends here: quality check on 4 frames (same woman, tattoos, piercings, garbled print, extra people)
 * and, with a chosen outfit, whether she still wears it. Reported in the Studio — never hidden.
 */
/**
 * Realism finish of a generated video (see realismFinish). Output = the reel's own size when it has the same
 * shape and is bigger. The unfinished file is kept (config.rawVideo) so it can be compared or restored.
 */
async function applyRealismFinish(g, ctx, rel) {
  const out = await probe(path.join(MEDIA_DIR, rel));
  let size = {};
  const src = ctx.video_path && existsMedia(ctx.video_path) ? await probe(path.join(MEDIA_DIR, ctx.video_path)) : null;
  if (src?.width && src?.height && out.width && out.height) {
    const sameShape = Math.abs(src.width / src.height - out.width / out.height) < 0.02;
    if (sameShape && src.height > out.height) size = { width: src.width - (src.width % 2), height: src.height - (src.height % 2) };
  }
  const fin = `generated/g${g.id}_${Date.now()}_final.mp4`;
  await realismFinish(path.join(MEDIA_DIR, rel), path.join(MEDIA_DIR, fin), size);
  const cfg = freshConfig(g.id);
  cfg.rawVideo = rel;
  update(g.id, { config: cfg });
  log(g.id, `Realistic finish applied${size.width ? ` (${size.width}×${size.height}, the reel's resolution)` : ''}`);
  return fin;
}

async function finishVideo(g, ctx, rel, prep = null) {
  if (getSettings().realism_finish !== '0' && ffmpegPath()) {
    status(g.id, 'Realistic finish of the video…');
    try { rel = await applyRealismFinish(g, ctx, rel); } catch (e) { log(g.id, `Warning: the realistic finish failed; the video stays without it (${String(e.message).slice(0, 160)})`); }
  }
  status(g.id, 'Quality check of the video…');
  let qa = await checkVideo({ videoRel: rel, refs: ctx.refs, body: ctx.body }).catch(() => null);
  if (prep && ffmpegPath()) {
    try {
      const { duration } = await probe(path.join(MEDIA_DIR, rel));
      const frameRel = `generated/g${g.id}_check_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(MEDIA_DIR, frameRel), await extractFrame(path.join(MEDIA_DIR, rel), (duration || 8) * 0.6));
      const chk = await checkVideoOutfit(frameRel, prep);
      fs.rmSync(path.join(MEDIA_DIR, frameRel), { force: true });
      if (chk && !chk.match) qa = { ...(qa || { ok: true, issues: [] }), ok: false, issues: [...(qa?.issues || []), `the outfit changed (${chk.worn || 'other clothes'})`] };
      if (chk?.match && qa) qa.outfit = true;
    } catch { /* best-effort */ }
  }
  const config = freshConfig(g.id);
  delete config.wanTask; // done: "Refazer vídeo" creates a new video
  delete config.falTask;
  delete config.rhTask;
  delete config.trim; // a cut (Projetos → Cortar o vídeo) belonged to the previous video
  delete config.untrimmedVideo;
  delete config.upscaled; // … and so did the Topaz final
  delete config.videoInfo;
  delete config.topazError;
  if (isCancelled(g.id)) {
    // Cancelled while the paid video was finishing: keep it (Voltar a rever), but leave the stage as the user set it.
    update(g.id, { video_path: rel, qa: qa ? JSON.stringify(qa) : null, config });
    return;
  }
  update(g.id, { video_path: rel, stage: 'review', error: null, qa: qa ? JSON.stringify(qa) : null, config });
  log(g.id, qa ? (qa.ok ? `Video ready. Quality check OK (face ${qa.same ?? '?'}/10 on the worst frame)` : `Video ready. Quality check warning: ${qa.issues.join('; ')}`) : 'Video ready for review');
}

async function runStage(id) {
  busy.add(id);
  try {
    const g = getGeneration(id);
    if (!g || !ACTIVE.includes(g.stage)) return;
    let ctx = loadContext(g);
    if (ctx.model_id && ['queued', 'imaging', 'animating'].includes(g.stage)) {
      await ensureProfile(ctx.model_id, (m) => log(id, m));
      ctx = loadContext(g);
    }
    if (g.stage === 'queued') await stageAnalyze(g, ctx);
    else if (g.stage === 'imaging') await stageImage(g, ctx);
    else if (g.stage === 'animating') await stageVideo(g, ctx);
  } catch (e) {
    if (e.moderation) {
      // Keep the provider's exact reply. The refusal is not pinned on the image: the provider checks the image,
      // the reel and the text together and does not say which one it refused.
      const cur = getGeneration(id);
      if (cur) update(id, { config: { ...cur.config, lastRefusal: { raw: String(e.raw || '').slice(0, 500), image: cur.chosen_image || null, engine: cur.config.videoEngine || null, at: Date.now() } } });
    }
    if (!isCancelled(id)) {
      const at = db.prepare('SELECT stage FROM generations WHERE id = ?').get(id)?.stage; // the step that failed
      update(id, { stage: 'failed', error: e.safety && !e.provider && !/^(O filtro|The (automatic )?content filter)/.test(String(e.message)) ? SAFETY_HELP : e.message });
      patchConfig(id, { failedAt: ACTIVE.includes(at) ? at : null });
      log(id, `Error: ${e.message}`);
    }
  } finally {
    busy.delete(id);
    kick();
  }
}

let kickTimer = null;
export function kick() {
  if (process.env.SHIVA_DEMO === '1') return; // the read-only demo never starts work
  clearTimeout(kickTimer);
  kickTimer = setTimeout(tick, 50);
}

function tick() {
  const max = Math.max(1, Math.min(4, Number(getSettings().pipeline_concurrency) || 1));
  if (busy.size >= max) return;
  const rows = db.prepare(`SELECT id FROM generations WHERE stage IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY updated_at ASC`).all(...ACTIVE);
  for (const { id } of rows) {
    if (busy.size >= max) break;
    if (!busy.has(id) && !bg.has(id)) runStage(id);
  }
}

export function startPipelineWorker() {
  settleInterrupted();
  setInterval(tick, 5000).unref();
  kick();
}

/**
 * After a restart: an enlargement that was running is reported as interrupted (so no label says it is still going), a
 * step-6 run that already had a job at WaveSpeed is continued (never paid twice), and one that had not is forgotten.
 */
function settleInterrupted() {
  const rows = db.prepare("SELECT id, config FROM generations WHERE config LIKE '%enlargeRun%' OR config LIKE '%topazRun%'").all();
  for (const r of rows) {
    const cfg = parse(r.config, {});
    if (cfg.enlargeRun) patchConfig(r.id, { enlargeRun: null, enlargeError: 'The enlargement was interrupted (the app restarted). Press “Generate” again.' });
    const t = cfg.topazRun;
    if (!t) continue;
    if (t.uploaded && t.tier && Date.now() - (t.at || 0) < 24 * 3600e3) {
      try { resumeTopaz(r.id); } catch (e) { patchConfig(r.id, { topazError: `${e.message} What was already done is still at WaveSpeed: “Resume” continues without paying again.` }); }
    } else if (!t.uploaded || !t.tier) {
      patchConfig(r.id, { topazRun: null, topazError: 'The final was interrupted (the app restarted) before it started at WaveSpeed: nothing was paid. You can press “Generate” again.' });
    }
  }
}

// ---- user actions ------------------------------------------------------------------------

/** Choosing / retrying while a stage runs would mix two runs (and pay twice): wait until it ends. */
function assertIdle(g) {
  if (busy.has(g.id) || bg.has(g.id) || ACTIVE.includes(g.stage)) {
    throw Object.assign(new Error('This generation is still running: wait until it ends.'), { status: 400 });
  }
  // Its posts are scheduled with this video: a new one would leave them pointing at the old file.
  if (g.publish) throw Object.assign(new Error('This project is already scheduled: undo the scheduling in Approval before redoing it.'), { status: 409 });
}

export function chooseImage(id, imagePath) {
  const g = getGeneration(id);
  if (!g) throw new Error('Generation not found');
  assertIdle(g);
  const cand = g.candidates.find((c) => c.path === imagePath);
  if (!cand) throw new Error('Invalid image');
  const config = { ...g.config };
  // The steps show what went into the video: the swap image (step 2) and the image animated (step 3's choice).
  config.final = imagePath;
  config.pick = cand.editOf && g.candidates.some((c) => c.path === cand.editOf) ? cand.editOf : imagePath;
  config.step = 'video';
  delete config.enlargeError;
  delete config.wanTask;
  delete config.falTask;
  delete config.rhTask;
  const fields = { chosen_image: imagePath, stage: 'animating', error: null, config };
  if (config.videoEngine === 'wan3_copy' && config.firstFrame === 'direct') {
    // After "Tentar em modo Direto": choosing an image means the video must start from it.
    config.firstFrame = 'nano';
    if (!userPrompt(g, 'video')) fields.video_prompt = null;
  }
  update(id, fields);
  log(id, 'Image approved. Generating the video');
  kick();
}

/**
 * "Editar imagem" (the reference app's "enlarge" step): one change — a preset such as "Aumentar o peito", or the user's
 * own words — to one of the project's images, with the chosen editor: Nano Banana, Seedream or Flux.2 (the person-swap
 * editors) or Wan 2.5 (edit only). Only that image is sent, so her face, the outfit and the scene stay. 1–4 variants;
 * each result is a new image next to the original (which is kept). A provider's content filter refusal is reported
 * as it is: the app never rewords the request or retries it on another provider by itself.
 */
export const EDIT_ENGINE_KEYS = ['nano', ...Object.keys(IMAGE_EDITORS), ...Object.keys(EDIT_ONLY)];
export const editEngineLabel = (k) => IMAGE_EDITORS[k]?.label || EDIT_ONLY[k]?.label || 'Nano Banana';
function editUnitCost(engine, cfg) {
  const c = { ...defaultConfig(), ...(cfg || {}) };
  return wsImageCost(wsImageKey(engine, c), c, 1);
}

/** The editors with their price per image (Perfis). */
export const editEngineList = () => EDIT_ENGINE_KEYS.map((key) => ({ key, label: editEngineLabel(key), cost: editUnitCost(key, {}) }));

/** The enlargement engine when her model has none: Wan 2.7 (the reference's), on WaveSpeed; Seedream 5.0 without the key. */
export const defaultEnlargeEngine = () => (wan27Ready() ? 'wan27' : 'seedream');

/** The model's own defaults for "Editar imagem" (Perfis), else the project's person-swap editor. */
export function editDefaults(g) {
  const m = g?.remake_id ? db.prepare('SELECT md.edit_prompt, md.edit_engine, md.edit_n, md.edit_auto FROM remakes r JOIN models md ON md.id = r.model_id WHERE r.id = ?').get(g.remake_id) : null;
  // The reference enlarges after the swap with its own editor; here Seedream 5.0 (it keeps her and the outfit best).
  const engine = EDIT_ENGINE_KEYS.includes(m?.edit_engine) ? m.edit_engine : defaultEnlargeEngine();
  return { engine, prompt: m?.edit_prompt?.trim() || ENLARGE_DEFAULT, n: Math.max(1, Math.min(4, Number(m?.edit_n) || 2)), auto: !!m?.edit_auto };
}

/** What the project page needs for the "Editar imagem" window. */
export function editOptions(g) {
  return {
    ...editDefaults(g),
    presets: Object.entries(EDIT_PRESETS).map(([key, p]) => ({ key, label: p.label, text: p.text })),
    engines: EDIT_ENGINE_KEYS.map((key) => ({ key, label: editEngineLabel(key), cost: editUnitCost(key, g?.config) })),
  };
}

/** The provider's own reply is quoted, so it is clear what refused and why. */
const refusalText = (label, e) => { const raw = String(e?.raw || e?.message || '').split(OTHER_EDITOR_HINT).join('').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, 160); return `The ${label} refused this edit in its content filter${raw ? ` («${raw}»)` : ''}. The original image did not change.`; };

/** Runs the edits and books their cost. Returns the new candidates (not saved yet). */
async function runEdits(g, { src, text, engine, n, workerId, lean = false, onStatus, isCancelled: isCanc = () => false }) {
  const ctx = loadContext(g);
  const cfg = { ...defaultConfig(), ...g.config };
  // lean: the enlargement, sent as the reference writes it (no long "keep everything" wrapper to water it down).
  const out = await nanoBananaImages({
    inputs: [src], prompt: lean ? buildEnlargePrompt({ change: text, body: ctx.body }) : buildImageEditPrompt({ change: text, body: ctx.body }), cfg, n, tag: `g${g.id}_edit`,
    aspectRatio: frameAspect(src), systemPrompt: lean ? '' : EDIT_SYSTEM_PROMPT, engine, onStatus, isCancelled: isCanc,
  });
  if (!out.length) throw new Error('The editor returned no images');
  addCost(g.id, out.reduce((a, c) => a + (c.cost || 0), 0), 'edicao', imgProvider(g), workerId, out.length);
  return out.map((c) => ({ path: c.path, model: c.model, cost: c.cost, edited: true, editOf: src, edit: text.slice(0, 300), editEngine: engine, label: 'Edited' }));
}

export async function editCandidate(id, { path: src, change, engine, n = 1, workerId } = {}) {
  const g = getGeneration(id);
  if (!g) throw Object.assign(new Error('Project not found'), { status: 404 });
  assertIdle(g);
  const cand = g.candidates.find((c) => c.path === src);
  if (!cand || !existsMedia(src)) throw Object.assign(new Error('Invalid image'), { status: 400 });
  // A photo uploaded as "A minha imagem" (or anything made from it) may show a real person: only images the app generated of her are edited.
  if (cand.uploaded || g.config.ownImage) throw Object.assign(new Error('Images you uploaded cannot be edited: Edit only works on images the app generated of the model.'), { status: 400 });
  const text = String(change || '').trim();
  if (!text) throw Object.assign(new Error('Write what you want to change in the image'), { status: 400 });
  const eng = EDIT_ENGINE_KEYS.includes(engine) ? engine : editDefaults(g).engine;
  const count = Math.max(1, Math.min(4, Number(n) || 1));
  const label = editEngineLabel(eng);
  bg.add(id);
  try {
    log(id, `Editing the image (${label}${count > 1 ? `, ${count} variants` : ''}): ${text.slice(0, 160)}`);
    const made = await runEdits(g, { src, text, engine: eng, n: count, workerId, onStatus: (m) => status(id, m) });
    const cur = getGeneration(id);
    const list = cur.candidates.filter((c) => !made.some((x) => x.path === c.path));
    const at = list.findIndex((c) => c.path === src);
    list.splice(at < 0 ? list.length : at + 1, 0, ...made);
    update(id, { candidates: list });
    log(id, `Image edited (${label}): ${made.length === 1 ? '1 new image' : `${made.length} new images`} next to the original${made.length < count ? ` (you asked for ${count}; the others were refused or failed)` : ''}`);
    return made;
  } catch (e) {
    const msg = e.safety ? refusalText(label, e) : e.message;
    log(id, `Image edit failed: ${msg}`);
    throw Object.assign(new Error(msg), { status: 400 });
  } finally {
    bg.delete(id);
  }
}

/**
 * Automático with the model's "Aumento automático" on: the chosen image is edited (her model's prompt, engine and
 * variants) before the video, and the best-ranked edit is animated. The edits are saved as soon as they exist, so a
 * restart never pays for them again. If the edit fails or is refused, the unedited image goes on (Automático never
 * stops) and the log says why.
 */
async function autoEnlarge(g, ctx, pick, candidates, persist) {
  const e = g.config.enlarge;
  if (!e?.prompt || pick.edited) return pick;
  let made = candidates.filter((c) => c.editOf === pick.path);
  if (!made.length) {
    const engine = EDIT_ENGINE_KEYS.includes(e.engine) ? e.engine : 'nano';
    const label = editEngineLabel(engine);
    log(g.id, `Automatic enlargement (${label}, ${e.n || 1} variant(s)): ${e.prompt.slice(0, 120)}`);
    try {
      made = await runEdits(g, { src: pick.path, text: e.prompt, engine, lean: true, n: Math.max(1, Math.min(4, Number(e.n) || 1)), onStatus: (m) => status(g.id, m), isCancelled: () => isCancelled(g.id) });
      made.forEach((c) => { c.enlarge = true; }); // step 3 shows them as the enlargements of the pick
    } catch (err) {
      log(g.id, `Automatic enlargement not done: ${err.safety ? refusalText(label, err) : err.message} Going on with the original image.`);
      return pick;
    }
    candidates.splice(candidates.indexOf(pick) + 1, 0, ...made);
    persist();
  }
  if (isCancelled(g.id)) return pick;
  await qaImages(g, ctx, made);
  persist();
  return rankCandidates(made)[0] || made[0] || pick;
}

// ---- the project in steps (the reference app's page) --------------------------------------------------------------
/**
 * When you choose (not Automático) a video project goes step by step, like the reference app:
 *   2 · Escolher a troca — "Continue" makes one of the person-swap images the pick (config.pick). Nothing starts.
 *   3 · Aumento — you choose the AI and how many, then "Generate" edits the pick with her enlargement prompt (Perfis),
 *       in the background. You choose one ("Continue"), or "Continue sem aumento" (the pick itself): config.final.
 *   4 · Vídeo — "Gerar vídeo" animates config.final, with optional extra positive / negative text for the video prompt.
 * The stage stays awaiting_approval through steps 2–4 (a person is needed); config.step says which one. On a finished
 * video that is not scheduled the same steps make a new video (the old one stays until the new one is ready).
 */
const clampN = (n, d, max) => Math.max(1, Math.min(max, Math.round(Number(n)) || d));
const stepError = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The enlargement of this project: her defaults (Perfis) unless changed on the project. */
export function enlargeSettings(g) {
  const d = editDefaults(g);
  const own = String(g?.config?.enlargePrompt || '').trim();
  return {
    prompt: own || d.prompt, defaultPrompt: d.prompt, edited: !!own && own !== d.prompt.trim(),
    engine: EDIT_ENGINE_KEYS.includes(g?.config?.enlargeEngine) ? g.config.enlargeEngine : d.engine,
    n: clampN(g?.config?.enlargeN, d.n, 4),
  };
}

function assertStep(g) {
  if (!g) throw stepError('Project not found', 404);
  if (g.kind !== 'video') throw stepError('This is a photo project: it does not have these steps');
  assertIdle(g);
  if (!['awaiting_approval', 'failed', 'cancelled', 'review', 'approved'].includes(g.stage)) throw stepError('This project is not waiting for a choice');
}

/** Step 2: the swap image. With skipEnlarge (or her own uploaded image) it goes straight to step 4. */
export function pickSwap(id, imagePath, { skipEnlarge = false, workerId = null } = {}) {
  const g = getGeneration(id);
  assertStep(g);
  const cand = g.candidates.find((c) => c.path === imagePath);
  if (!cand || cand.enlarge) throw stepError('Invalid image: choose one of the swap images');
  if ((g.config.refusedImages || []).includes(imagePath)) throw stepError('Wan refused this image: choose another one');
  if (imagePath === g.config.pick && !skipEnlarge) return { enlarging: null }; // already the pick: a new enlargement only from step 3's priced button
  const own = !!(cand.uploaded || g.config.ownImage);
  const skip = !!skipEnlarge || own;
  patchConfig(id, { pick: imagePath, final: skip ? imagePath : null, step: skip ? 'video' : 'enlarge', skipEnlarge: skip || null, enlargeError: null });
  if (['failed', 'cancelled'].includes(g.stage) && !g.video_path) update(id, { stage: 'awaiting_approval', error: null });
  log(id, skip ? `Swap image chosen${own ? '' : ', no enlargement'}: ready for the video (step 4)` : 'Swap image chosen: in step 3, choose the enlargement AI and press “Generate” (or go on with no enlargement)');
  return { enlarging: null }; // nothing starts by itself: step 3 waits for its "Generate" (workerId is kept for that call)
}

/**
 * Step 3: the pick edited with her enlargement prompt, in the background (the page shows the progress; you can go to
 * another project meanwhile). prompt / engine / n are saved on the project; more = that many extra images, once.
 */
export function startEnlarge(id, { prompt, engine, n, more, workerId = null } = {}) {
  const g = getGeneration(id);
  assertStep(g);
  const src = g.config.pick;
  const cand = src && g.candidates.find((c) => c.path === src);
  if (!cand || !existsMedia(src)) throw stepError('Choose the swap image first (step 2)');
  if (cand.uploaded || g.config.ownImage) throw stepError('Images you uploaded cannot be edited: the enlargement only works on images the app generated of the model.');
  const d = editDefaults(g);
  const change = {};
  if (prompt !== undefined) { const t = String(prompt || '').trim().slice(0, 1500); change.enlargePrompt = t && t !== d.prompt.trim() ? t : null; }
  if (engine !== undefined) {
    if (engine && !EDIT_ENGINE_KEYS.includes(engine)) throw stepError('Invalid engine');
    change.enlargeEngine = engine || null;
  }
  if (n !== undefined && n !== null) change.enlargeN = clampN(n, d.n, 4);
  const cfg = patchConfig(id, { ...change, step: 'enlarge', enlargeError: null, enlargeRun: { at: Date.now(), src } });
  const e = enlargeSettings({ ...g, config: cfg });
  if (!e.prompt.trim()) throw stepError('Write the enlargement prompt');
  const count = more ? clampN(more, 4, 8) : e.n;
  const label = editEngineLabel(e.engine);
  bg.add(id);
  status(id, `Enlargement: ${label}, ${count} image(s)…`);
  (async () => {
    try {
      log(id, `Enlargement (${label}, ${count} variant${count > 1 ? 's' : ''}): ${e.prompt.slice(0, 160)}`);
      const made = await runEdits(getGeneration(id), { src, text: e.prompt, engine: e.engine, n: count, workerId, lean: true, onStatus: (m) => status(id, `Enlargement: ${m}`), isCancelled: () => isCancelled(id) });
      made.forEach((c) => { c.enlarge = true; });
      const cur = getGeneration(id);
      if (!cur) return;
      const list = cur.candidates.filter((c) => !made.some((x) => x.path === c.path));
      let at = list.findIndex((c) => c.path === src);
      while (at >= 0 && list[at + 1]?.editOf === src) at++; // after the pick and its earlier edits
      list.splice(at < 0 ? list.length : at + 1, 0, ...made);
      update(id, { candidates: list });
      // Same quality check as the swap images (same woman? tattoos?), so the badges mean the same in both steps.
      try {
        await qaImages(cur, loadContext(cur), made);
        const now2 = getGeneration(id);
        if (now2) update(id, { candidates: now2.candidates.map((c) => { const m = made.find((x) => x.path === c.path); return m && 'qa' in m ? { ...c, qa: m.qa } : c; }) });
      } catch { /* the check is optional */ }
      patchConfig(id, { enlargeRun: null });
      log(id, `Enlargement ready: ${made.length} image(s)${made.length < count ? ` (you asked for ${count}; the others were refused or failed)` : ''}. Choose one in step 3`);
    } catch (err) {
      const msg = err.safety ? refusalText(label, err) : String(err?.message || err);
      if (getGeneration(id)) {
        patchConfig(id, { enlargeRun: null, enlargeError: msg.slice(0, 600) });
        log(id, `Enlargement failed: ${msg}`);
      }
    } finally {
      bg.delete(id);
    }
  })();
  return { ok: true, n: count, engine: e.engine };
}

/** Step 3: the image the video starts from — one of the pick's edits, or the pick itself ("Sem aumento"). */
export function pickFinal(id, imagePath) {
  const g = getGeneration(id);
  assertStep(g);
  const pick = g.config.pick;
  if (!pick) throw stepError('Choose the swap image first (step 2)');
  const c = g.candidates.find((x) => x.path === imagePath);
  if (!c || (imagePath !== pick && c.editOf !== pick)) throw stepError('Invalid image: choose one of the enlargements of the chosen image');
  if ((g.config.refusedImages || []).includes(imagePath)) throw stepError('Wan refused this image: choose another one');
  patchConfig(id, { final: imagePath, step: 'video', skipEnlarge: imagePath === pick ? true : null });
  if (['failed', 'cancelled'].includes(g.stage) && !g.video_path) update(id, { stage: 'awaiting_approval', error: null });
  log(id, imagePath === pick ? 'No enlargement: the video starts from the swap image (step 4)' : 'Enlargement chosen: ready for the video (step 4)');
  return getGeneration(id);
}

/** Step 4: "Gerar vídeo" from the final image, with the optional extra positive / negative text. */
export function startVideo(id, { extra, negative } = {}) {
  const g = getGeneration(id);
  assertStep(g);
  const img = g.config.final;
  const noImage = EDIT_ENGINES.includes(g.config.videoEngine) || (g.config.videoEngine === 'wan3_copy' && g.config.firstFrame === 'direct' && !img);
  if (noImage) {
    patchConfig(id, { videoExtra: String(extra || '').trim().slice(0, 1000) || null, videoNegative: String(negative || '').trim().slice(0, 500) || null });
    retryGeneration(id, { from: 'animating' });
    return getGeneration(id);
  }
  if (!img || !g.candidates.some((c) => c.path === img)) throw stepError('Choose the video image first: one of the enlargements in step 3, or “No enlargement”');
  if ((g.config.refusedImages || []).includes(img)) throw stepError('Wan refused this image: choose another one in step 3');
  patchConfig(id, { videoExtra: String(extra || '').trim().slice(0, 1000) || null, videoNegative: String(negative || '').trim().slice(0, 500) || null });
  chooseImage(id, img);
  return getGeneration(id);
}

// ---- Step 6 · Final: 2x + 60 fps (the reference's "topaz final") ------------------------------------------------
/**
 * WaveSpeed has no Topaz: the same final is two WaveSpeed jobs. The frame rate is doubled first (Wan's 30 fps becomes
 * 60; skipped when the video already has 50+), then the size is doubled (the reference's "2x upscale", at most 4K).
 * WaveSpeed's price per second of video (27/09): $0.008 for the frame rate; for the size $0.02 (720p), $0.03 (1080p),
 * $0.05 (2K) or $0.08 (4K), at least 3 s. It runs in the background; the result becomes the project's video and the one
 * before is kept ("Desfazer" goes back to it). Each job id is saved as soon as it exists: after a restart or a failed
 * download "Retomar" waits for the same jobs, never paying for new ones.
 */
const FINAL = {
  label: 'WaveSpeed (upscaler + 60 fps)',
  fpsModel: 'wavespeed-ai/video-fps-increaser', fpsUsd: 0.008,
  upModel: 'wavespeed-ai/ultimate-video-upscaler', upUsd: { '720p': 0.02, '1080p': 0.03, '2k': 0.05, '4k': 0.08 },
};

/** Twice the video's size (the reference's "2x upscale"), at most 4K on the long side, never smaller; even pixels. */
function topazTarget(w, h) {
  const k = Math.max(1, Math.min(2, 3840 / Math.max(w, h)));
  const tw = Math.floor(w * k); const th = Math.floor(h * k);
  return { w: tw - (tw % 2), h: th - (th % 2) };
}
/** WaveSpeed's size for that target, by the short side (1440 = 2K, 2160 = 4K). */
const upTier = (t) => { const m = Math.min(t.w, t.h); return m > 1440 ? '4k' : m > 1080 ? '2k' : m > 720 ? '1080p' : '720p'; };

/** What step 6 would cost for the project's video now (read once per video, then kept in config.videoInfo). */
export async function topazEstimate(id) {
  const g = getGeneration(id);
  if (!g || g.kind !== 'video' || !existsMedia(g.video_path)) throw stepError('This project has no video yet');
  let info = g.config.videoInfo?.path === g.video_path ? g.config.videoInfo : null;
  if (!info) {
    if (!ffmpegPath()) throw stepError('ffmpeg not found: run npm run setup');
    const p = await probe(path.join(MEDIA_DIR, g.video_path));
    if (!p.width || !p.height || !p.duration) throw stepError('Could not read the video');
    info = { path: g.video_path, w: p.width, h: p.height, fps: p.fps || 24, duration: p.duration, audio: p.hasAudio };
    db.prepare('UPDATE generations SET config = ? WHERE id = ?').run(JSON.stringify({ ...freshConfig(id), videoInfo: info }), id); // a cache: no updated_at bump (no redraw, no reordering)
  }
  const frames = Math.max(1, Math.round(info.duration * info.fps));
  const target = topazTarget(info.w, info.h);
  const tier = upTier(target);
  const secs = Math.ceil(info.duration);
  const doubleFps = (info.fps || 30) < 50;
  const usd = Math.round(((doubleFps ? Math.max(1, secs) * FINAL.fpsUsd : 0) + Math.max(3, secs) * FINAL.upUsd[tier]) * 1000) / 1000;
  return { frames, secs: Math.round(info.duration * 10) / 10, fps: Math.round(info.fps * (doubleFps ? 2 : 1)), doubleFps, from: { w: info.w, h: info.h, fps: info.fps }, target, tier, usd, label: FINAL.label, done: !!g.config.upscaled };
}

export async function startTopaz(id, { workerId = null } = {}) {
  const g = getGeneration(id);
  if (!g) throw stepError('Project not found', 404);
  if (g.kind !== 'video' || !existsMedia(g.video_path)) throw stepError('This project has no video yet');
  assertIdle(g);
  if (!['review', 'approved'].includes(g.stage)) throw stepError('The final is for the finished video (step 5)');
  if (g.config.upscaled) throw stepError('This video was already improved: “Undo” first if you want to redo it');
  // A run that already has a job at WaveSpeed is fetched again, never paid a second time.
  if (g.config.topazRun?.uploaded) return resumeTopaz(id, { workerId });
  const s = getSettings();
  if (!s.wavespeed_api_key) throw stepError('The WaveSpeed API key is missing (Settings → Pipeline)');
  const est = await topazEstimate(id);
  if (busy.has(id) || bg.has(id)) throw stepError('This project is busy: wait until it ends.');
  const run = { at: Date.now(), src: g.video_path, w: est.target.w, h: est.target.h, tier: est.tier, fps: est.fps, doubleFps: est.doubleFps, usd: est.usd, workerId };
  patchConfig(id, { topazRun: run, topazError: null });
  log(id, `Final (${FINAL.label}): ${est.target.w}×${est.target.h}, ${est.fps} fps (~$${est.usd})`);
  runFinal(id, run, s);
  return { ok: true, estimate: est };
}

/** Step 6's WaveSpeed jobs (frame rate, then size), each resumed from its saved id. Runs in the background. */
function runFinal(id, run, s) {
  bg.add(id);
  status(id, 'Final: starting…');
  (async () => {
    try {
      const ws = new WaveSpeed(s.wavespeed_api_key);
      const save = () => patchConfig(id, { topazRun: { ...run } });
      const job = async (key, model, makeInput, label) => {
        if (!run[key]) {
          const input = await makeInput();
          if (isCancelled(id)) throw new Error('Canceled');
          run[key] = await ws.submit(model, input);
          run.uploaded = true; // paid work exists from here on: a retry fetches it instead of paying again
          save();
        }
        try {
          return (await ws.wait(run[key], { onStatus: (m) => status(id, `Final · ${label}: ${m}`), isCancelled: () => isCancelled(id), intervalMs: 5000, maxMs: 60 * 60e3 })).outputs[0];
        } catch (e) {
          // The job itself failed at WaveSpeed: a retry sends a new one. An outage, a timeout or "Cancelado" keep it.
          if (!(e.network || e.transient) && !/Cancelado|Cancell?ed|tempo esgotado|timed out/.test(String(e.message))) { delete run[key]; save(); }
          throw e;
        }
      };
      let srcUrl = null;
      const source = async () => {
        if (!srcUrl) { status(id, 'Final: uploading the video to WaveSpeed…'); srcUrl = await ws.upload(readMedia(run.src), `g${id}_final_src.mp4`, 'video/mp4'); }
        return srcUrl;
      };
      if (run.doubleFps && !run.fpsUrl) {
        run.fpsUrl = await job('fpsId', FINAL.fpsModel, async () => ({ video: await source() }), '60 fps');
        save();
      }
      const outUrl = await job('upId', FINAL.upModel, async () => ({ video: run.fpsUrl || await source(), target_resolution: run.tier }), `size ${run.tier}`);
      status(id, 'Final: downloading…');
      let buf = await WaveSpeed.download(outUrl, 'final video');
      // The sound of the video before goes back on as it was (the upscaler may re-encode it or leave it out).
      if (ffmpegPath()) {
        try {
          const srcAbs = path.join(MEDIA_DIR, run.src);
          if ((await probe(srcAbs)).hasAudio) buf = await muxOriginalAudio(buf, srcAbs);
        } catch (e) { log(id, `Warning: could not put the sound back on the final (${String(e.message).slice(0, 120)})`); }
      }
      await topazDone(id, run, buf);
    } catch (e) {
      topazFailed(id, run, e);
    } finally {
      bg.delete(id);
    }
  })();
}

/** The result becomes the project's video; booked once, at WaveSpeed's price. */
async function topazDone(id, run, buf) {
  const rel = `generated/g${id}_topaz_${Date.now()}.mp4`;
  fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
  addCost(id, run.usd, 'final', 'wavespeed', run.workerId ?? null);
  let size = `${run.w}×${run.h}`;
  let fps = run.fps;
  try { const p = await probe(path.join(MEDIA_DIR, rel)); if (p.width && p.height) size = `${p.width}×${p.height}`; if (p.fps) fps = Math.round(p.fps); } catch { /* the planned size is shown */ }
  const cur = getGeneration(id);
  if (!cur) return;
  const cfg = { ...cur.config };
  cfg.upscaled = { from: run.src, untrimmed: cfg.untrimmedVideo || null, trim: cfg.trim || null, at: Date.now(), size, fps };
  delete cfg.trim; delete cfg.untrimmedVideo; delete cfg.topazRun; delete cfg.videoInfo; delete cfg.topazError;
  update(id, { video_path: rel, config: cfg });
  log(id, `Final ready: ${size}, ${fps} fps (WaveSpeed). The previous video is kept: “Undo” goes back to it.`);
}

/** Nothing sent yet: the run is forgotten. A job at WaveSpeed is kept, so "Retomar" fetches it without paying again. */
function topazFailed(id, run, e) {
  const msg = String(e?.message || e);
  if (!getGeneration(id)) return;
  run.uploaded = !!(run.fpsId || run.fpsUrl || run.upId);
  if (run.uploaded) {
    patchConfig(id, { topazRun: { ...run }, topazError: `${msg.slice(0, 500)} What was already done is still at WaveSpeed: “Resume” continues without paying again.` });
  } else {
    patchConfig(id, { topazRun: null, topazError: msg.slice(0, 600) });
  }
  log(id, `Final failed: ${msg}`);
}

/** Continues a saved run (after a restart or a failed download): the jobs already at WaveSpeed are not paid again. */
export function resumeTopaz(id, { workerId = null } = {}) {
  const g = getGeneration(id);
  if (!g) throw stepError('Project not found', 404);
  const run = g.config.topazRun;
  if (!run?.uploaded || !run.tier) throw stepError('There is no unfinished final in this project');
  if (busy.has(id) || bg.has(id)) throw stepError('This project is busy: wait until it ends.');
  const s = getSettings();
  if (!s.wavespeed_api_key) throw stepError('The WaveSpeed API key is missing (Settings → Pipeline)');
  patchConfig(id, { topazError: null });
  log(id, 'Final: continuing with what was already at WaveSpeed (without paying again)');
  runFinal(id, { ...run, workerId: run.workerId ?? workerId }, s);
  return { ok: true, resumed: true };
}

/** Back to the video from before step 6 (with its cut); the final file is deleted. */
export function undoTopaz(id) {
  const g = getGeneration(id);
  if (!g) throw stepError('Project not found', 404);
  assertIdle(g);
  const u = g.config.upscaled;
  if (!u) throw stepError('This video has not been improved in step 6 yet');
  if (!existsMedia(u.from)) throw stepError('The video from before step 6 no longer exists');
  const cfg = { ...g.config };
  delete cfg.upscaled; delete cfg.videoInfo;
  // A cut made on the final goes with it: back to the cut (or none) from before step 6.
  const topazUncut = cfg.untrimmedVideo;
  delete cfg.trim; delete cfg.untrimmedVideo;
  if (u.untrimmed) cfg.untrimmedVideo = u.untrimmed;
  if (u.trim) cfg.trim = u.trim;
  const topazFile = g.video_path;
  update(id, { video_path: u.from, config: cfg });
  for (const f of [topazFile, topazUncut]) if (f && f !== u.from && f !== u.untrimmed) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
  log(id, 'Final undone: back to the video from before');
  return getGeneration(id);
}

const STAGE_LABEL = { queued: 'start', imaging: 'images', awaiting_approval: 'image choice', animating: 'video' };

export function retryGeneration(id, { from } = {}) {
  const g = getGeneration(id);
  if (!g) throw new Error('Generation not found');
  assertIdle(g);
  // After an image step failed, 'Tentar de novo' never goes on to the paid video by itself.
  const imgFailed = g.stage === 'failed' && ['queued', 'imaging'].includes(g.config.failedAt);
  const stage = from || (g.kind !== 'video' ? 'imaging' : g.chosen_image && !imgFailed ? 'animating' : g.candidates.length ? 'awaiting_approval' : g.analysis ? 'imaging' : 'queued');
  const config = { ...g.config };
  delete config.failedAt;
  // New images on a finished (not scheduled) video: once made, it goes back to review / approved, so the video stays in Aprovação.
  delete config.returnStage;
  if (stage === 'imaging' && g.video_path && ['review', 'approved'].includes(g.stage)) config.returnStage = g.stage;
  // A new run has nothing to resume. A saved Wan task is kept for a video retry only: it is reused just when the
  // request is identical (so a timed-out or cancelled task that is still billed upstream is not paid twice).
  delete config.imagingPending;
  delete config.photoRun;
  if (stage !== 'animating') { delete config.wanTask; delete config.falTask; delete config.rhTask; }
  if (stage === 'imaging' || stage === 'queued') delete config.rhImageTasks;
  const fields = { stage, error: null, config };
  if (stage === 'animating' && config.final && config.final !== g.chosen_image && g.candidates.some((c) => c.path === config.final)) fields.chosen_image = config.final;
  // Prompts are rebuilt on every run. A prompt the user edited is kept and gets newer identity rules (e.g. "no tattoos").
  const m = db.prepare('SELECT m.rules, m.profile FROM remakes r JOIN models m ON m.id = r.model_id WHERE r.id = ?').get(g.remake_id);
  const guard = m ? noTattooLine({ rules: m.rules, profile: m.profile }) : '';
  if (guard) {
    for (const k of ['image', 'video']) {
      const p = userPrompt(g, k);
      if (p && !p.includes('NO TATTOOS')) {
        fields[`${k}_prompt`] = `${p}\n${guard}`;
        config[`${k}PromptEdited`] = true;
      }
    }
  }
  update(id, fields);
  log(id, `Retry from: ${STAGE_LABEL[stage] || stage}`);
  kick();
}

export function setStage(id, stage) {
  update(id, { stage });
  const g = getGeneration(id);
  if (stage === 'approved') db.prepare("UPDATE remakes SET status = 'done', updated_at = ? WHERE id = ?").run(now(), g.remake_id);
  log(id, { approved: 'Approved: ready to publish', rejected: 'Rejected', cancelled: 'Canceled' }[stage] || `Stage: ${stage}`);
}

export function isBusy(id) { return busy.has(id) || bg.has(id); }
/** Pipeline slots taken (projects the worker runs): the count the worker waits on. Enlargements, edits and Topaz run beside them. */
export function busyCount() { return busy.size; }
