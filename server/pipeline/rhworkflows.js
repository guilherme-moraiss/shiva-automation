import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { probe } from '../ffmpeg.js';
import { RunningHub, RunningHubError, RH_SITES, rhWorkflowId } from './runninghub.js';

/**
 * The user's own ComfyUI workflows, run on RunningHub exactly as saved there. For each one the app knows which
 * node inputs it replaces (ids from the original files in public/workflows). If the saved copy has other ids, an
 * input is found again by type (and by node title when there are several of that type); "Verificar" says so.
 *
 * Only VALUES are replaced through the API. Switches that change the graph itself (bypass/mute of groups, including
 * the INSTARAW "Boolean Bypass" toggles, which only run in the ComfyUI editor) stay as the workflow was saved, so
 * the profiles below check the saved state instead of trying to flip it.
 *
 *   inputs  role → { node, field, class, title?, as?, value?, optional? }
 *             as 'file'           the RunningHub name of an uploaded file (LoadImage / VHS_LoadVideo)
 *             as 'instarawBatch'  INSTARAW Advanced Image Loader: batch_data JSON pointing at the uploaded file
 *             as 'rpg'            INSTARAW Reality Prompt Generator: prompt_batch_data JSON with the app's prompt
 *             value               a fixed value;  otherwise values[role] (a value or a function of the saved workflow)
 *   set     fixed values that make the run non-interactive (pop-ups that would wait for a click on paid GPU time)
 *   requires / checks   saved-state conditions the app depends on (reported by Verificar, checked before paying)
 *   output  the saving node whose file is the result ({ prefix } = its file name, used when RunningHub gives no node)
 */
export const RH_WORKFLOWS = {
  // ---- reels: her photo (the approved first frame) + the reel → video ------------------------------------------
  wan_animate: {
    setting: 'rh_wf_wan_animate', kind: 'video', use: 'reel', name: 'WAN Animate', file: 'workflows/wan-animate.json',
    desc: 'Wan 2.2 Animate: her, with the pose, expressions and mouth movements of the reel.',
    inputs: {
      image: { node: '19', field: 'image', class: 'LoadImage', as: 'file' },
      video: { node: '22', field: 'video', class: 'VHS_LoadVideo', as: 'file' },
      seed: { node: '1', field: 'seed', class: 'WanVideoSampler', optional: true },
    },
    output: { node: '119', class: 'VHS_VideoCombine' },
  },
  nb_wan_animate: {
    setting: 'rh_wf_nb_wan_animate', kind: 'video', use: 'reel', name: 'NB WanAnimate', file: 'workflows/nb-wan-animate.json',
    desc: 'Wan 2.2 Animate with a relighting LoRA; the reel goes in at 30 fps.',
    inputs: {
      image: { node: '57', field: 'image', class: 'LoadImage', as: 'file' },
      video: { node: '63', field: 'video', class: 'VHS_LoadVideo', as: 'file' },
      // Its final VHS_VideoCombine is fixed at 30 fps: the reel is loaded at 30 fps too, or a 60 fps reel comes out slowed down.
      fps: { node: '63', field: 'force_rate', class: 'VHS_LoadVideo', value: 30, optional: true },
      seed: { node: '27', field: 'seed', class: 'WanVideoSampler', optional: true },
    },
    output: { node: '186', class: 'VHS_VideoCombine' },
  },
  ttt_animator: {
    setting: 'rh_wf_ttt_animator', kind: 'video', use: 'reel', name: 'TTT Animator', file: 'workflows/ttt-animator.json',
    desc: 'Wan 2.2 Animate with pose and face detection (ViTPose), 720×1280 at 30 fps.',
    inputs: {
      image: { node: '76', field: 'image', class: 'LoadImage', as: 'file' },
      video: { node: '75', field: 'video', class: 'VHS_LoadVideo', as: 'file' },
      fps: { node: '75', field: 'force_rate', class: 'VHS_LoadVideo', value: 30, optional: true },
      seed: { node: '273', field: 'seed', class: 'WanVideoSampler', optional: true },
    },
    output: { node: '319', class: 'VHS_VideoCombine', prefix: 'SteadyDancer' },
  },
  animate_x: {
    setting: 'rh_wf_animate_x', kind: 'video', use: 'reel', name: 'Animate X', file: 'workflows/animate-x.json',
    desc: 'Native Wan 2.2 Animate, made in chunks: handles longer reels. The app sets the duration and the fps.',
    inputs: {
      image: { node: '167', field: 'image', class: 'LoadImage', as: 'file' },
      video: { node: '52', field: 'video', class: 'VHS_LoadVideo', as: 'file' },
      // frames loaded = ceil(TOTAL DURATION × FPS RATE / 4) × 4 + 1: the reel's length at the 30 fps it is sent at.
      seconds: { node: '439', field: 'value', class: 'easy int', title: /TOTAL DURATION/i },
      fpsRate: { node: '441', field: 'value', class: 'easy int', title: /FPS RATE/i, value: 30, optional: true },
      seed: { node: '353', field: 'seed', class: 'KSampler', optional: true },
    },
    output: { node: '226', class: 'VHS_VideoCombine', prefix: 'KIARA_AnimateX' },
  },

  // ---- her image in the reel frame / the post photo ----------------------------------------------------------------
  sky: {
    setting: 'rh_wf_sky', kind: 'image', use: 'frame', name: 'Z-Image SKY', file: 'workflows/sky-zimage-controlnet.json',
    desc: 'Z-Image + ControlNet: the photo remade with her (her LoRA), same pose and composition.',
    inputs: {
      image: { node: '75', field: 'image', class: 'LoadImage', as: 'file' },
      prompt: { node: '767', field: 'string', class: 'String Literal', optional: true },
      captionRules: { node: '753', field: 'value', class: 'PrimitiveStringMultiline', optional: true },
      faceTrigger: { node: '758', field: 'text', class: 'CLIPTextEncode', optional: true },
      loras: [
        { node: '752', field: 'lora_name', class: 'LoraLoaderModelOnly' },
        { node: '134', field: 'lora_name', class: 'LoraLoaderModelOnly', optional: true },
        { node: '831', field: 'lora_name', class: 'LoraLoaderModelOnly', optional: true },
      ],
      seed: { node: '192', field: 'seed', class: 'Seed (rgthree)', optional: true },
    },
    output: { node: '824', class: 'SaveImage' },
  },
  faceswap: {
    setting: 'rh_wf_faceswap', kind: 'image', use: 'frame', needs: 'instaraw', name: 'INSTARAW Faceswap', file: 'workflows/instaraw-faceswap.json',
    desc: "Swaps the person's face (and hair) for hers, with masks and compositing. Uses Nano Banana Pro through the API inside the workflow.",
    inputs: {
      image: { node: '607', field: 'batch_data', class: 'INSTARAW_AdvancedImageLoader', as: 'instarawBatch' },
      face: { node: '20', field: 'image', class: 'LoadImage', title: /CHARACTER/i, as: 'file' },
      hair: { node: '214', field: 'image', class: 'LoadImage', title: /HAIR/i, as: 'file', from: 'face', optional: true },
      seed: { node: '90', field: 'seed', class: 'INSTARAWSeedGenerator', optional: true },
    },
    set: [
      // "ASK USER CONFIRMATIONS?" on = the crops use the automatic crop (no editor); the two pop-ups then give up after 1 s.
      { node: '355', field: 'value', class: 'PrimitiveBoolean', title: /CONFIRMATION/i, value: true },
      { node: '324', field: 'timeout', class: 'INSTARAW_TextImageFilter', value: 1 },
      { node: '255', field: 'timeout', class: 'INSTARAW_MaskImageFilter', value: 1 },
      { node: '255', field: 'if_no_mask', class: 'INSTARAW_MaskImageFilter', value: 'send blank' },
      { node: '555', field: 'timeout', class: 'INSTARAW_Interactive_Crop', value: 1 },
      { node: '556', field: 'timeout', class: 'INSTARAW_Interactive_Crop', value: 1 },
    ],
    checks: [
      (api) => (Object.values(api).some((n) => n.class_type === 'INSTARAW_APIImageToImage' && /fully clothe/i.test(JSON.stringify(n.inputs || {})))
        ? { issue: "the “FULLY CLOTHE FOR NSFW FIX” group is on. It exists to get past the provider's filter and the app does not use it: turn it off (bypass) on RunningHub and save" } : null),
      (api) => {
        const keys = Object.values(api).filter((n) => /^(PrimitiveString|easy string)$/.test(n.class_type) && /API KEY/i.test(n._meta?.title || ''));
        return keys.length && !keys.some((n) => String(n.inputs?.value ?? n.inputs?.string ?? '').trim())
          ? { issue: 'the API keys inside the workflow are empty (wavespeed.ai or fal.ai for Nano Banana Pro, and Gemini): fill them in on RunningHub and save' } : null;
      },
    ],
    output: { node: '140', class: 'SaveImage', prefix: 'INSTARAW_Faceswap' },
  },

  // ---- realism pass on her images ------------------------------------------------------------------------------------
  instagirl: {
    setting: 'rh_wf_instagirl', kind: 'image', use: 'finish', name: 'WAN 2.2 Instagirl', file: 'workflows/wan22-instagirl-i2i.json',
    desc: 'Realism pass (WAN 2.2 + Instagirl LoRA): the skin, light and texture of a phone photo.',
    inputs: {
      image: { node: '35', field: 'image', class: 'LoadImage', as: 'file' },
      prompt: { node: '8', field: 'text', class: 'CLIPTextEncode', optional: true },
      charLora: { node: '15', field: 'lora_name', class: 'LoraLoaderModelOnly', optional: true },
      charStrength: { node: '15', field: 'strength_model', class: 'LoraLoaderModelOnly', optional: true },
      seed: { node: '29', field: 'seed', class: 'KSampler', optional: true },
      denoise: { node: '29', field: 'denoise', class: 'KSampler', optional: true },
    },
    output: { node: '17', class: 'SaveImage' },
  },

  // ---- Conteúdo 18+: only her own photos, only in that section ---------------------------------------------------
  sky_nsfw: null, // filled below (same as SKY, saved in its NSFW state)
  zimage: {
    setting: 'rh_wf_zimage', kind: 'image', use: 'adult', needs: 'instaraw', name: 'INSTARAW zImage', file: 'workflows/instaraw-zimage.json',
    desc: 'Z-Image Turbo + SDXL details (eyes, hands, mouth…) from one of her photos.',
    inputs: {
      image: { node: '583', field: 'batch_data', class: 'INSTARAW_AdvancedImageLoader', as: 'instarawBatch' },
      prompt: { node: '584', field: 'prompt_batch_data', class: 'INSTARAW_RealityPromptGenerator', as: 'rpg' },
    },
    set: [
      { node: '344', field: 'timeout', class: 'INSTARAW_ImageFilter', value: 1, optional: true },
      { node: '344', field: 'ontimeout', class: 'INSTARAW_ImageFilter', value: 'send all', optional: true },
      { node: '285', field: 'enabled', class: 'INSTARAW_MaskImageFilter', value: false, optional: true },
    ],
    requires: [
      { class: 'INSTARAW_FloatInput', title: /I2I Denoise/i, why: 'it is saved in text→image mode: on RunningHub set “ENABLE IMG TO IMG?” = true, run it once and save (the app always starts from one of her photos)' },
    ],
    output: { node: '613', class: 'SaveImage' },
  },
  sdxl_zimage: {
    setting: 'rh_wf_sdxl_zimage', kind: 'image', use: 'adult', needs: 'instaraw', name: 'INSTARAW SDXL + zImage', file: 'workflows/instaraw-sdxl-zimage.json',
    desc: 'SDXL (Lustify) + Z-Image refinement + details, from one of her photos.',
    inputs: {
      image: { node: '482', field: 'batch_data', class: 'INSTARAW_AdvancedImageLoader', as: 'instarawBatch' },
      prompt: { node: '483', field: 'prompt_batch_data', class: 'INSTARAW_RealityPromptGenerator', as: 'rpg' },
    },
    set: [
      { node: '324', field: 'timeout', class: 'INSTARAW_ImageFilter', value: 1, optional: true },
      { node: '324', field: 'ontimeout', class: 'INSTARAW_ImageFilter', value: 'send all', optional: true },
    ],
    requires: [
      { node: '393', class: 'PrimitiveFloat', why: 'it is saved in text→image mode: on RunningHub set “ENABLE IMG TO IMG?” = true, run it once and save (the app always starts from one of her photos)' },
    ],
    output: { node: '505', class: 'SaveImage' },
  },
  sdxl_wan: {
    setting: 'rh_wf_sdxl_wan', kind: 'image', use: 'adult', needs: 'instaraw', name: 'INSTARAW SDXL + WAN', file: 'workflows/instaraw-sdxl-wan.json',
    desc: 'SDXL (Lustify) + WAN 2.2 refinement + details, from one of her photos.',
    inputs: {
      image: { node: '482', field: 'batch_data', class: 'INSTARAW_AdvancedImageLoader', as: 'instarawBatch' },
      prompt: { node: '483', field: 'prompt_batch_data', class: 'INSTARAW_RealityPromptGenerator', as: 'rpg' },
    },
    set: [
      { node: '324', field: 'timeout', class: 'INSTARAW_ImageFilter', value: 1, optional: true },
      { node: '324', field: 'ontimeout', class: 'INSTARAW_ImageFilter', value: 'send all', optional: true },
    ],
    requires: [
      { node: '393', class: 'PrimitiveFloat', why: 'it is saved in text→image mode: on RunningHub set “ENABLE IMG TO IMG?” = true, run it once and save (the app always starts from one of her photos)' },
    ],
    output: { node: '505', class: 'SaveImage' },
  },
  detailing: {
    setting: 'rh_wf_detailing', kind: 'image', use: 'adultTool', needs: 'instaraw', name: 'INSTARAW Detailing', file: 'workflows/instaraw-detailing.json',
    desc: 'Refines the eyes, hands, mouth, feet and intimate areas of one of her images, and upscales it.',
    inputs: {
      image: { node: '111', field: 'batch_data', class: 'INSTARAW_AdvancedImageLoader', as: 'instarawBatch' },
    },
    set: [
      // Its mask editor cancels the whole run when nobody paints a mask: switched off.
      { node: '145', field: 'enabled', class: 'INSTARAW_MaskImageFilter', value: false },
    ],
    output: { node: '151', class: 'SaveImage' },
  },
  inpaint: {
    setting: 'rh_wf_inpaint', kind: 'image', use: 'adultTool', name: 'SDXL Inpainting', file: 'workflows/instaraw-sdxl-inpainting.json',
    desc: 'Redoes only the area you paint on one of her images, with the text you write.',
    inputs: {
      // The painted zone travels as the alpha channel of the PNG (LoadImage turns it into the mask).
      image: { node: '12', field: 'image', class: 'LoadImage', as: 'file' },
      prompt: { node: '3', field: 'text', class: 'CLIPTextEncode', title: /Positive/i },
      seed: { node: '13', field: 'seed', class: 'KSampler', optional: true },
    },
    output: { node: '7', class: 'Image Save' },
  },
};
// The same SKY workflow saved in its NSFW state (JoyCaption on): only for "Conteúdo 18+", only with her own photos.
RH_WORKFLOWS.sky_nsfw = { ...RH_WORKFLOWS.sky, setting: 'rh_wf_sky_nsfw', use: 'adult', name: 'Z-Image SKY (18+)', desc: 'SKY saved in its NSFW mode (JoyCaption on), from one of her photos.' };

export const RH_VIDEO_ENGINES = { rh_wan_animate: 'wan_animate', rh_nb_wan_animate: 'nb_wan_animate', rh_ttt_animator: 'ttt_animator', rh_animate_x: 'animate_x' };
/** Who puts her into the reel frame / the post photo (besides Nano Banana). */
export const RH_FRAME_ENGINES = ['sky', 'faceswap'];
/** Conteúdo 18+: generators (from one of her photos) and tools (on one of her images). */
export const RH_ADULT_ENGINES = ['sky_nsfw', 'zimage', 'sdxl_zimage', 'sdxl_wan'];
export const RH_ADULT_TOOLS = ['detailing', 'inpaint'];

export const rhSite = (s) => RH_SITES[s.rh_site] || RH_SITES.ai;
export const rhClient = (s) => new RunningHub({ apiKey: s.rh_api_key, baseUrl: rhSite(s) });
export const rhReady = (s, key) => !!(s.rh_api_key && RH_WORKFLOWS[key] && rhWorkflowId(s[RH_WORKFLOWS[key].setting]));

/** What the settings page shows for each workflow. */
export const rhCatalog = () => Object.entries(RH_WORKFLOWS).map(([key, p]) => ({
  key, setting: p.setting, kind: p.kind, use: p.use, name: p.name, desc: p.desc, file: p.file, needs: p.needs || null,
}));

// ---- saved workflow (API format) and where the inputs are ---------------------------------------------------

const apiCache = new Map(); // workflowId → { at, api }
async function savedApi(rh, workflowId, { fresh = false } = {}) {
  const c = apiCache.get(workflowId);
  if (!fresh && c && Date.now() - c.at < 10 * 60_000) return c.api;
  const api = await rh.workflowApi(workflowId);
  apiCache.set(workflowId, { at: Date.now(), api });
  return api;
}

const hasField = (n, field) => n && n.inputs && Object.prototype.hasOwnProperty.call(n.inputs, field);
const titleOf = (n) => String(n?._meta?.title || '');

/** One spec in the saved workflow: its original node id, else the only node of that type (and title) with that field. */
function locate(api, spec) {
  const fits = (n) => n && n.class_type === spec.class && hasField(n, spec.field);
  if (fits(api[spec.node]) && (!spec.title || spec.title.test(titleOf(api[spec.node])) || !Object.values(api).some((n) => fits(n) && spec.title.test(titleOf(n))))) {
    return { ...spec, moved: false };
  }
  let same = Object.entries(api).filter(([, n]) => fits(n));
  if (spec.title && same.length > 1) same = same.filter(([, n]) => spec.title.test(titleOf(n)));
  if (same.length === 1) return { ...spec, node: same[0][0], moved: true };
  return null;
}

/** Output node: the original id, else the only saving node of that type (previews excluded). */
function locateOutput(api, out) {
  if (api[out.node]?.class_type === out.class) return { ...out, moved: false };
  const saving = Object.entries(api).filter(([, n]) => n.class_type === out.class && (out.class !== 'VHS_VideoCombine' || n.inputs?.save_output !== false));
  if (saving.length === 1) return { ...out, node: saving[0][0], moved: true };
  return saving.length ? { ...out, node: null, moved: true } : null; // several: picked after the run by name / shape
}

const where = (s) => `${s.class}.${s.field} (node ${s.node} in the original)`;

/**
 * Where to write each input in this saved workflow, and whether the saved state is one the app can run.
 * → { map: { role: spec | [spec] }, set: [spec], output, issues: [], notes: [] }
 */
export function resolveProfile(key, api) {
  const prof = RH_WORKFLOWS[key];
  const issues = [];
  const notes = [];
  const map = {};
  for (const [name, spec] of Object.entries(prof.inputs)) {
    if (Array.isArray(spec)) {
      map[name] = [];
      for (const s of spec) {
        const found = api[s.node]?.class_type === s.class && hasField(api[s.node], s.field) ? { ...s, moved: false } : null;
        if (found) map[name].push(found);
        else if (!s.optional) issues.push(`missing node ${s.node} (${s.class}.${s.field})`);
      }
      if (!map[name].length) {
        const all = Object.entries(api).filter(([, n]) => n.class_type === spec[0].class && hasField(n, spec[0].field));
        if (all.length) {
          map[name] = all.map(([id]) => ({ ...spec[0], node: id, moved: true }));
          notes.push(`${spec[0].class}: found ${all.length} nodes by type`);
          const i = issues.findIndex((x) => x.startsWith(`missing node ${spec[0].node} `));
          if (i >= 0) issues.splice(i, 1);
        }
      }
      continue;
    }
    const found = locate(api, spec);
    if (found) {
      map[name] = found;
      if (found.moved) notes.push(`${spec.class}.${spec.field} is in node ${found.node} (it was node ${spec.node} in the original)`);
    } else if (!spec.optional) {
      issues.push(spec.as === 'rpg' || spec.as === 'instarawBatch'
        ? `node ${spec.class} (${spec.node}) does not expose the field ${spec.field} through the API, so the app cannot give it ${spec.as === 'rpg' ? 'the text' : 'the image'}`
        : `could not find ${where(spec)}`);
    }
  }
  const set = [];
  for (const spec of prof.set || []) {
    const found = locate(api, spec);
    if (found) set.push(found);
    else if (!spec.optional) issues.push(`could not find ${where(spec)}: without it the workflow stalls waiting for a click (paid GPU time)`);
  }
  for (const req of prof.requires || []) {
    const ok = req.node
      ? api[req.node]?.class_type === req.class
      : Object.values(api).some((n) => n.class_type === req.class && (!req.title || req.title.test(titleOf(n))));
    if (!ok) issues.push(req.why);
  }
  for (const check of prof.checks || []) {
    const r = check(api);
    if (r?.issue) issues.push(r.issue);
    if (r?.note) notes.push(r.note);
  }
  const output = locateOutput(api, prof.output);
  if (!output) issues.push(`could not find the output ${prof.output.class} (node ${prof.output.node} in the original)`);
  else if (output.moved && output.node) notes.push(`output in node ${output.node}`);
  if (/^(zimage|sdxl_zimage|sdxl_wan)$/.test(key) && Object.values(api).some((n) => /^INSTARAW_(GLCM_Normalize|Pixel_Perturb|SynthesizeAuthenticMetadata)$/.test(n.class_type))) {
    notes.push(`the app uses the image saved in node ${output?.node || prof.output.node}, before the post-processing; the anti-detection and fake-metadata steps at the end are not used (you can turn them off on RunningHub to use less GPU)`);
  }
  return { map, set, output, issues, notes };
}

/** Check the API key and every configured workflow (used by "Verificar" in Definições). */
export async function verifyRunningHub(s) {
  const rh = rhClient(s);
  const out = { account: null, workflows: {} };
  try { out.account = await rh.account(); } catch (e) { out.accountError = e.message; }
  for (const [key, prof] of Object.entries(RH_WORKFLOWS)) {
    const id = rhWorkflowId(s[prof.setting]);
    if (!id) { out.workflows[key] = { configured: false }; continue; }
    try {
      const api = await savedApi(rh, id, { fresh: true });
      const r = resolveProfile(key, api);
      out.workflows[key] = { configured: true, id, ok: !r.issues.length, issues: r.issues, notes: r.notes, nodes: Object.keys(api).length };
    } catch (e) {
      out.workflows[key] = { configured: true, id, ok: false, issues: [e.message] };
    }
  }
  return out;
}

// ---- her identity for the SKY workflow ------------------------------------------------------------------------

const slug = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
const parse = (x, d) => { try { return x ? JSON.parse(x) : d; } catch { return d; } };

/** Trigger word, hair and body of the model, as the SKY workflow needs them. */
export function skyIdentity(model) {
  const profile = parse(model.profile, {}) || {};
  const trigger = String(model.rh_trigger || model.lora_trigger || `${slug(model.name) || 'model'}ofm`).trim();
  const hairFromRules = String(model.rules || '').match(/[^;.]*\bhair\b[^;.]*/i)?.[0]?.replace(/^(same|always)\s+/i, '').replace(/\s+in every photo$/i, '').trim();
  // "Dark brown, long (past shoulders), wavy, usually worn down…" → "dark brown long wavy hair"
  const fromProfile = profile.hair
    ? String(profile.hair).replace(/\([^)]*\)/g, '').split(/[.;]/)[0].split(',').slice(0, 3).map((x) => x.trim()).filter(Boolean).join(' ')
    : '';
  let hair = fromProfile || hairFromRules || 'her natural hair colour';
  if (!/\bhair\b/i.test(hair)) hair = `${hair} hair`;
  const body = String(model.body || '').trim().replace(/\.$/, '') || 'her natural figure';
  return { trigger, hair: hair.toLowerCase(), body, lora: String(model.rh_lora || '').trim() };
}

/**
 * The SKY caption instructions are written for its author's character ("Blu3Twi", blonde hair). Rewritten for HER.
 * If the saved copy was already adapted by the user (no author placeholders), it is left untouched.
 */
export function skyCaptionRules(original, id) {
  const text = String(original || '');
  if (!/Blu3Twi|blonde hair/i.test(text)) return null;
  let t = text
    .replace(/always mention blonde hair dont ever mention black,?/i, `always mention ${id.hair}; never mention any other hair colour,`)
    .replace(/Always add "Blu3Twi", blonde hair\."?\s*at the start of the prompt,[^\n]*/i, `Always add "${id.trigger}, ${id.hair}." at the start of the prompt, ${id.body},`);
  t = t.replace(/Blu3Twi/g, id.trigger).replace(/blonde hair/gi, id.hair);
  return t;
}

// ---- running ---------------------------------------------------------------------------------------------------

const seed50 = () => crypto.randomInt(1, 2 ** 47);
const isVideo = (o) => /\b(mp4|webm|mov|mkv|video)\b/i.test(`${o.fileType || ''} ${String(o.fileUrl || '').split('?')[0].split('.').pop()}`);
const isImage = (o) => !isVideo(o) && /\b(png|jpe?g|webp|image)\b/i.test(`${o.fileType || ''} ${String(o.fileUrl || '').split('?')[0].split('.').pop()}`);
const extOf = (o, fallback) => (String(o.fileUrl || '').split('?')[0].match(/\.(\w{3,4})$/)?.[1] || fallback).toLowerCase();
const fileNameOf = (o) => { try { return decodeURIComponent(String(o.fileUrl || '').split('?')[0]).split('/').pop(); } catch { return ''; } };

/**
 * Outputs of the wanted kind: the output node's when RunningHub says the node, else the files named like the output
 * node saves them (ComfyUI names them "<prefix>_00001…"), else all of them.
 */
function candidates(outputs, kind, node, prefix) {
  const typed = (outputs || []).filter(kind === 'video' ? isVideo : isImage)
    .filter((o) => !/rgthree\.compare|_temp_|preview/i.test(String(o.fileUrl || '')));
  const exact = node ? typed.filter((o) => o.nodeId != null && String(o.nodeId) === String(node)) : [];
  if (exact.length) return exact;
  const base = prefix ? String(prefix).split('/').pop() : '';
  if (base) {
    const named = typed.filter((o) => fileNameOf(o).includes(`${base}_`));
    if (named.length) return named;
  }
  return typed;
}

/** What a task cost in the account's currency, as a number (null when RunningHub did not say). */
export function rhMoney(outputs) {
  const o = (outputs || []).find((x) => x.consumeMoney != null);
  const n = o ? Number(o.consumeMoney) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cost of a task as RunningHub reports it (currency of the account), for the log. */
export function rhCostNote(outputs) {
  const o = (outputs || []).find((x) => x.consumeMoney != null || x.consumeCoins != null || x.taskCostTime != null);
  if (!o) return '';
  const parts = [o.consumeMoney != null && `${o.consumeMoney}`, o.consumeCoins != null && `${o.consumeCoins} RH coins`, o.taskCostTime != null && `${o.taskCostTime} s of GPU`].filter(Boolean);
  return parts.length ? `RunningHub cost: ${parts.join(' · ')}` : '';
}

/** The result video: the version with the reel's audio when there are two, then the reel-shaped one (not a side-by-side). */
async function pickBestVideo(files) {
  if (files.length === 1) return files[0];
  const withAudio = files.filter((f) => /-audio\./i.test(f.name || ''));
  const pool = withAudio.length ? withAudio : files;
  if (pool.length === 1) return pool[0];
  const scored = [];
  for (const f of pool) {
    const tmp = path.join(os.tmpdir(), `rr_rh_${crypto.randomUUID()}.${f.ext}`);
    fs.writeFileSync(tmp, f.buf);
    const p = await probe(tmp).catch(() => ({}));
    fs.rmSync(tmp, { force: true });
    const ratio = p.width && p.height ? p.width / p.height : 1;
    scored.push({ f, score: Math.abs(ratio - 9 / 16) });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored[0].f;
}

function precheck(s, key) {
  const prof = RH_WORKFLOWS[key];
  if (!s.rh_api_key) throw new RunningHubError('The RunningHub API key is missing: paste it in Settings → RunningHub');
  const workflowId = rhWorkflowId(s[prof.setting]);
  if (!workflowId) throw new RunningHubError(`The ${prof.name} workflow ID on RunningHub is missing: paste it in Settings → RunningHub`);
  return workflowId;
}

/** The value the app writes into one input of the saved workflow (undefined = leave it as saved). */
function inputValue(role, spec, ctx) {
  const { names, uploads, values, seed } = ctx;
  if (spec.as === 'file') return names[spec.from || role];
  if (spec.as === 'instarawBatch') {
    const src = spec.from || role;
    if (!names[src]) return undefined;
    // The loader reads input/INSTARAW_ImagePool/<filename>; RunningHub uploads live in input/, one level up.
    const id = `rr${crypto.randomBytes(4).toString('hex')}`;
    return JSON.stringify({ images: [{ id, filename: `../${names[src]}`, original_name: path.basename(uploads[src]?.name || names[src]), repeat_count: 1 }], order: [id], total_count: 1 });
  }
  if (spec.as === 'rpg') {
    if (values.prompt === undefined) return undefined;
    return JSON.stringify([{ id: 'rr1', positive_prompt: String(values.prompt), negative_prompt: String(values.negative || ''), repeat_count: 1, seed: seed % 2147483647 }]);
  }
  if (spec.value !== undefined) return spec.value;
  const v = role === 'seed' && values.seed === undefined ? seed : values[role];
  return typeof v === 'function' ? v({ ...ctx, spec, current: ctx.api[spec.node]?.inputs?.[spec.field] }) : v;
}

/**
 * Create (or resume) one task of a profile. `uploads`: role → { buf, name } (only the files the workflow uses are
 * sent). `values`: role → value | (ctx) => value. `task`: { taskId, outputNode } of a task created before a restart.
 * → { res: { taskId, outputs }, outputNode }
 */
async function runProfile({ s, key, uploads = {}, values = {}, task, onTask, onStatus, isCancelled }) {
  const prof = RH_WORKFLOWS[key];
  const workflowId = precheck(s, key);
  const rh = rhClient(s);
  if (task?.taskId) {
    onStatus?.('Resuming the RunningHub task that was already running, without paying again');
    return { res: await rh.run({ taskId: task.taskId, onStatus, isCancelled }), outputNode: task.outputNode ?? null };
  }
  onStatus?.(`Reading your ${prof.name} workflow on RunningHub…`);
  const api = await savedApi(rh, workflowId);
  const r = resolveProfile(key, api);
  if (r.issues.length) throw new RunningHubError(`The ${prof.name} workflow on RunningHub is not ready for the app: ${r.issues.join('; ')}. Press Verify in Settings → RunningHub.`);
  const outputNode = r.output?.node ?? null;
  const used = new Set();
  const required = new Set();
  for (const [role, spec] of Object.entries(r.map)) {
    for (const sp of [].concat(spec)) {
      if (sp.as !== 'file' && sp.as !== 'instarawBatch') continue;
      used.add(sp.from || role);
      if (!sp.optional) required.add(sp.from || role);
    }
  }
  const missing = [...required].filter((k) => !uploads[k]);
  if (missing.length) throw new RunningHubError(`The input file for ${prof.name} is missing (${missing.join(', ')})`);
  const todo = [...used].filter((k) => uploads[k]);
  if (todo.length) onStatus?.(`Uploading ${todo.some((k) => k === 'video') ? 'the image and the video' : todo.length > 1 ? 'the images' : 'the image'} to RunningHub…`);
  const names = Object.fromEntries(await Promise.all(todo.map(async (k) => [k, await rh.upload(uploads[k].buf, uploads[k].name)])));
  const ctx = { api, map: r.map, names, uploads, values, seed: seed50() };
  const list = [];
  for (const [role, spec] of Object.entries(r.map)) {
    for (const sp of [].concat(spec)) {
      const v = inputValue(role, sp, ctx);
      if (v !== undefined && v !== null) list.push({ nodeId: sp.node, fieldName: sp.field, fieldValue: v });
    }
  }
  for (const sp of r.set) list.push({ nodeId: sp.node, fieldName: sp.field, fieldValue: sp.value });
  const res = await rh.run({ workflowId, nodeInfoList: list, instanceType: s.rh_instance, onTask: (taskId) => onTask?.({ taskId, outputNode }), onStatus, isCancelled });
  return { res, outputNode };
}

/** Download the image results of a finished task → { files: [{ buf, ext }], taskId, cost }. */
async function imageResult(key, res, outputNode, onStatus) {
  const prof = RH_WORKFLOWS[key];
  const cands = candidates(res.outputs, 'image', outputNode, prof.output.prefix);
  if (!cands.length) throw new RunningHubError(`RunningHub finished without an image. In the ${prof.name} workflow, check that the final save node (${prof.output.class}) is on.`);
  onStatus?.('Downloading the image from RunningHub…');
  // No node ids and several images: the last one saved is the final one.
  const pick = cands.length > 1 && !cands.some((o) => o.nodeId != null) ? [cands[cands.length - 1]] : cands;
  const files = await Promise.all(pick.slice(0, 4).map(async (o) => ({ ext: extOf(o, 'png'), buf: await RunningHub.download(o.fileUrl) })));
  return { files, taskId: res.taskId, cost: rhCostNote(res.outputs), money: rhMoney(res.outputs) };
}

/**
 * Run a video workflow: her image (the approved first frame) + the reel → video Buffer.
 * `seconds`: the length of the reel that was sent (workflows that need it, e.g. Animate X).
 */
export async function runRhVideo({ s, key, image, video, seconds, task, onTask, onStatus, isCancelled }) {
  const prof = RH_WORKFLOWS[key];
  const { res, outputNode } = await runProfile({
    s, key, task, onTask, onStatus, isCancelled,
    uploads: { image, video },
    values: { seconds: seconds ? Math.max(1, Math.ceil(seconds)) : undefined },
  });
  const cands = candidates(res.outputs, 'video', outputNode, prof.output.prefix);
  if (!cands.length) throw new RunningHubError(`RunningHub finished without a video. In the ${prof.name} workflow, the output node must save the video (save_output on).`);
  onStatus?.('Downloading the video from RunningHub…');
  const files = await Promise.all(cands.slice(0, 4).map(async (o) => ({ name: fileNameOf(o), ext: extOf(o, 'mp4'), buf: await RunningHub.download(o.fileUrl) })));
  const best = await pickBestVideo(files);
  return { buf: best.buf, ext: best.ext, taskId: res.taskId, cost: rhCostNote(res.outputs), money: rhMoney(res.outputs) };
}

/**
 * Run the SKY image workflow once: a photo (post / reel frame / her own photo for 18+) → realistic photo of HER.
 * `nsfw` selects the 18+ copy of the workflow (callers enforce who may use it).
 */
export async function runRhSky({ s, model, source, prompt, nsfw = false, task, onTask, onStatus, isCancelled }) {
  const key = nsfw ? 'sky_nsfw' : 'sky';
  precheck(s, key);
  const id = skyIdentity(model);
  if (!id.lora) throw new RunningHubError(`${model.name} does not have a Z-Image LoRA on RunningHub yet: enter its file name in Settings → RunningHub (without it, the workflow author's character would come out).`);
  const { res, outputNode } = await runProfile({
    s, key, task, onTask, onStatus, isCancelled,
    uploads: { image: source },
    values: {
      loras: id.lora,
      faceTrigger: id.trigger,
      prompt: prompt ? `${id.trigger}, ${prompt}` : id.trigger,
      captionRules: ({ current }) => skyCaptionRules(current, id) ?? undefined,
    },
  });
  return imageResult(key, res, outputNode, onStatus);
}

/**
 * Any other image workflow of the catalog (Faceswap, Instagirl, INSTARAW 18+, Detailing, Inpainting).
 *   image  the picture the workflow works on · face  her reference photo (Faceswap)
 *   prompt / negative  text for the workflows that take it · values  extra role values
 */
export async function runRhImage({ s, key, image, face, prompt, negative, values = {}, task, onTask, onStatus, isCancelled }) {
  const { res, outputNode } = await runProfile({
    s, key, task, onTask, onStatus, isCancelled,
    uploads: { image, face },
    values: { ...(prompt !== undefined ? { prompt } : {}), ...(negative !== undefined ? { negative } : {}), ...values },
  });
  return imageResult(key, res, outputNode, onStatus);
}

/**
 * The values for the WAN 2.2 Instagirl realism pass. Its node 15 holds its author's character LoRA ("joy1"): with
 * her WAN LoRA set, that one is used instead; without it, the author's LoRA is switched off (strength 0) and the
 * denoise kept low, so the pass adds skin and light texture without drifting her face. A LoRA the user already
 * put there himself is left alone.
 */
export function instagirlValues(model, prompt) {
  const own = String(model?.rh_wan_lora || '').trim();
  const author = (ctx) => {
    const n = ctx.map.charLora && ctx.api[ctx.map.charLora.node];
    return !own && /joy1|joy[_-]?fal/i.test(String(n?.inputs?.lora_name ?? ''));
  };
  return {
    prompt: prompt || undefined,
    charLora: own || undefined,
    charStrength: (ctx) => (author(ctx) ? 0 : undefined),
    denoise: (ctx) => (author(ctx) || !ctx.map.charLora ? Math.min(0.35, Number(ctx.current) || 0.35) : undefined),
  };
}
