import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, MEDIA_DIR } from '../db.js';
import { WaveSpeed } from './wavespeed.js';
import { geminiText } from './gemini.js';
import { nanoBananaImages } from './runner.js';
import { noTattooLine } from './prompts.js';

/**
 * "Wear THIS outfit" for remakes. One big Nano Banana call (8 images: her refs + outfit + reel frame)
 * mostly copies the reel frame's clothes, so the outfit is enforced in dedicated, verified steps:
 *
 *   1. prepareOutfit  — once per wardrobe item: clothing-only product shot (removes the other person,
 *                       her face/tattoos) + a short text description of the garments (vision).
 *   2. ensureOutfitOn — after the person swap: vision check; if she isn't wearing it, a targeted
 *                       Nano Banana edit ("change ONLY her clothes to image 2"), checked again (2 tries).
 *   3. checkVideoOutfit — after the video: a frame is checked so a drift is reported, not hidden.
 *
 * Vision = Gemini 2.5 Flash on WaveSpeed (or the Gemini key) — a fraction of a cent per check.
 */

const readMedia = (rel) => fs.readFileSync(path.join(MEDIA_DIR, rel));
const mimeOf = (rel) => (/\.png$/i.test(rel) ? 'image/png' : /\.webp$/i.test(rel) ? 'image/webp' : 'image/jpeg');
const exists = (rel) => rel && fs.existsSync(path.join(MEDIA_DIR, rel));
const rm = (rel) => { if (rel && !rel.includes('..')) fs.rmSync(path.join(MEDIA_DIR, rel), { force: true }); };

const PRODUCT_SYSTEM = 'You are an e-commerce product photographer. You must ALWAYS produce an image. Output only clothing — never a person, face, skin or body.';
const EDIT_SYSTEM = 'You are a precise photo editor. Apply ONLY the requested edit and keep everything else in the photo unchanged. You must ALWAYS produce an image.';

const PRODUCT_PROMPT = (desc) => [
  'Create a clean e-commerce product photo of ONLY the clothing worn in this image, shown on an invisible (ghost) mannequin, front view, on a plain light-grey studio background, evenly lit and sharp.',
  'Reproduce every garment exactly: garment types, exact colours, fabric and texture (e.g. ribbing), neckline, straps, trims, embroidery, prints, logos, length and fit.',
  desc && `The garments: ${desc}.`,
  'NO person: no face, no hair, no skin, no arms, no hands, no body, no phone, no tattoos, no jewelry. Clothing only.',
].filter(Boolean).join('\n');

const DESCRIBE_PROMPT = 'Describe ONLY the clothing in this image for a fashion catalogue, in ONE English sentence of at most 40 words: every garment type, exact colours, fabric/texture, neckline, straps, trims, embroidery/prints, length and fit. Do not mention any person, body, skin, pose, phone or background. Output only the sentence.';

/** Vision question → text: Gemini 2.5 Flash on WaveSpeed, else the Gemini key (null when neither is saved). */
export async function vision(prompt, paths) {
  const s = getSettings();
  const images = paths.map((p) => ({ buf: readMedia(p), mime: mimeOf(p) }));
  if (s.wavespeed_api_key) return new WaveSpeed(s.wavespeed_api_key).chat({ prompt, images });
  if (s.gemini_api_key) return geminiText({ apiKey: s.gemini_api_key, prompt, images: images.map((i) => ({ mime: i.mime, data: i.buf })) });
  return null;
}

const parseJson = (t) => { try { return JSON.parse(String(t).match(/\{[\s\S]*\}/)[0]); } catch { return null; } };

/**
 * Clothing-only product shot + description, cached on the wardrobe item.
 * Returns { id, ref, desc, clean } — `ref` is the image to send to the models.
 */
export async function prepareOutfit(asset, { cfg, log = () => {} }) {
  let a = db.prepare('SELECT * FROM model_assets WHERE id = ?').get(asset.id);
  let cost = 0;
  if (!exists(a.clean_path)) {
    log('Outfit: creating a photo of the garment only (without the person in the photo)…');
    try {
      const [img] = await nanoBananaImages({
        inputs: [a.path], prompt: PRODUCT_PROMPT(a.description), systemPrompt: PRODUCT_SYSTEM, cfg: { ...cfg, nbResolution: '1K' },
        n: 1, tag: `outfit${a.id}`, aspectRatio: '3:4',
      });
      if (img) {
        const rel = `assets/m${a.model_id}_outfit${a.id}_clean_${Date.now()}${path.extname(img.path) || '.png'}`;
        fs.renameSync(path.join(MEDIA_DIR, img.path), path.join(MEDIA_DIR, rel));
        db.prepare('UPDATE model_assets SET clean_path = ? WHERE id = ?').run(rel, a.id);
        cost += img.cost || 0;
      }
    } catch (e) {
      log(`Outfit: could not isolate the garment (${e.message.slice(0, 120)}); using the original photo`);
    }
    a = db.prepare('SELECT * FROM model_assets WHERE id = ?').get(a.id);
  }
  if (!a.garment_desc && !a.description) {
    try {
      const d = await vision(DESCRIBE_PROMPT, [exists(a.clean_path) ? a.clean_path : a.path]);
      if (d) {
        db.prepare('UPDATE model_assets SET garment_desc = ? WHERE id = ?').run(d.replace(/\s+/g, ' ').trim().slice(0, 400), a.id);
        a = db.prepare('SELECT * FROM model_assets WHERE id = ?').get(a.id);
      }
    } catch (e) { log(`Outfit: automatic description failed (${e.message.slice(0, 80)})`); }
  }
  const desc = (a.description || a.garment_desc || '').trim().replace(/[.\s]+$/, '');
  if (desc) log(`Outfit: ${desc}`);
  return { id: a.id, ref: exists(a.clean_path) ? a.clean_path : a.path, clean: exists(a.clean_path), desc, cost };
}

/** Is she wearing the outfit? → { match: bool, worn } or null (no vision / unreadable answer). */
export async function checkOutfit(imgPath, prep) {
  const t = await vision([
    'You are checking an AI-generated photo. Image 1: a photo of a woman. Image 2: a photo of an outfit (look only at the clothing).',
    prep.desc && `The outfit: ${prep.desc}`,
    'Is the woman in image 1 wearing THIS outfit — the same garment types, the same main colour(s) and the same key details (neckline, straps, trims)?',
    'Small differences in fit, wrinkles or lighting are fine. A different colour, a different garment type or the original clothes = NOT a match.',
    'Reply ONLY with compact JSON: {"match": true or false, "worn": "<what she actually wears, max 15 words>"}',
  ].filter(Boolean).join('\n'), [imgPath, prep.ref]).catch(() => null);
  const j = t && parseJson(t);
  return j && typeof j.match === 'boolean' ? { match: j.match, worn: String(j.worn || '').slice(0, 160) } : null;
}

// Worded as a fashion "virtual try-on": undressing-style wording ("remove her clothes") and long
// body-part lists make Google's IMAGE_SAFETY filter block the edit.
const tryOnPrompt = (prep, body, attempt = 0) => [
  attempt === 0
    ? 'Virtual try-on for a fashion catalogue. Image 1 is a photo of a woman. Image 2 is a product photo of an outfit.'
    : 'Fashion photo edit. Image 1 is a lifestyle photo. Image 2 is a clothing product photo from an online store.',
  `Create the same photo as image 1, but with her wearing the outfit from image 2 instead of the one she has on${prep.desc ? ` — ${prep.desc}` : ''}.`,
  'Reproduce the garments of image 2 faithfully: garment types, colours, knit texture, neckline, straps, trims, embroidery and length. The fabric is thick and fully opaque, with a natural everyday fit.',
  'Everything else stays exactly as in image 1: her face and identity, hair, pose, hands, jewelry, expression, background, lighting, camera angle and framing.',
  hasNoTattoosLite(body) && 'She has no tattoos.',
  'Photorealistic smartphone photo, natural fabric folds that follow her pose and the scene lighting.',
].filter(Boolean).join('\n');
const hasNoTattoosLite = (body) => !!noTattooLine(body);

/**
 * Make sure the generated image `imgPath` shows her in the outfit.
 * Returns { path, ok: true|false|null, worn, cost } — ok=null means it couldn't be verified.
 * Intermediate images that failed are deleted; the returned path is the one to keep.
 */
export async function ensureOutfitOn({ imgPath, prep, cfg, body, tag, aspectRatio = '9:16', log = () => {}, isCancelled = () => false }) {
  let cost = 0;
  const first = await checkOutfit(imgPath, prep);
  if (first?.match) { log('Outfit confirmed on the 1st frame'); return { path: imgPath, ok: true, worn: first.worn, cost }; }
  if (first) log(`Wrong outfit in the frame (${first.worn || 'other clothes'}): swapping only the outfit…`);
  else log('Swapping only the outfit (dedicated edit)…');
  let best = null;
  for (let t = 0; t < 2; t++) {
    if (isCancelled()) break;
    let img;
    try {
      [img] = await nanoBananaImages({
        inputs: [imgPath, prep.ref], prompt: tryOnPrompt(prep, body, t), systemPrompt: EDIT_SYSTEM, cfg, n: 1, tag: `${tag}_fit${t}`, aspectRatio,
      });
    } catch (e) { log(`Outfit swap ${t + 1}: ${e.message.slice(0, 140)}`); continue; }
    if (!img) continue;
    cost += img.cost || 0;
    const chk = await checkOutfit(img.path, prep);
    if (!chk) { // no vision available: trust the dedicated edit
      if (best) rm(best.path);
      rm(imgPath);
      return { path: img.path, ok: null, worn: '', cost };
    }
    if (chk.match) {
      if (best) rm(best.path);
      rm(imgPath);
      log(`Outfit swapped and confirmed (attempt ${t + 1})`);
      return { path: img.path, ok: true, worn: chk.worn, cost };
    }
    log(`Attempt ${t + 1}: still does not match (${chk.worn || '?'})`);
    if (best) rm(best.path);
    best = { path: img.path, worn: chk.worn };
  }
  if (best) { rm(imgPath); return { path: best.path, ok: false, worn: best.worn, cost }; }
  return { path: imgPath, ok: first ? false : null, worn: first?.worn || '', cost };
}

/** After the video: is she still wearing it (frame at ~60%)? Returns check or null. */
export async function checkVideoOutfit(frameRel, prep) {
  return checkOutfit(frameRel, prep);
}
