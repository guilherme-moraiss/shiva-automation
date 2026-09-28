import fs from 'node:fs';
import path from 'node:path';
import { db, now, MEDIA_DIR } from '../db.js';
import { route, readBody, HttpError, decodeDataUrl } from '../http.js';
import { normalizeRefs, pickRefs, modelDirRel, ensureModelDir } from './modelpack.js';
import { bodyLine, POSES } from './prompts.js';
import { nanoBananaImages, defaultConfig, aspectFor } from './runner.js';
import { ensureProfile } from './profile.js';
import { recordCost } from '../costs.js';

/**
 * Studio: original content of a model inside her fixed "universe".
 *   - places (same bedroom every time), props (her phone), wardrobe — model_assets
 *   - identity rules (no tattoos, freckles…) + body — injected in every prompt
 *   - scene presets ("mirror selfie in pajamas in her bedroom"…)
 * Every generation sends the reference images, so the room/phone/outfit are literally the same.
 */

export const LOCATION_TYPES = {
  bedroom: 'Bedroom', bathroom: 'Bathroom', kitchen: 'Kitchen', living: 'Living room', car: 'Car', gym: 'Gym', outdoor: 'Outdoors', other: 'Other',
};

/** Scene styles. All SFW, social-media style. */
export const SCENES = [
  { key: 'mirror_pajamas', label: 'Mirror selfie in pajamas', location: 'bedroom', outfit: 'a cute matching pajama set (shorts and a top)', camera: 'mirror selfie: she holds her phone in front of a full-length mirror, the phone and her reflection visible', pose: 'standing relaxed in front of the mirror, one hip slightly out', phone: true, light: 'soft warm evening lamp light' },
  { key: 'bed_morning', label: 'Waking up in bed', location: 'bedroom', outfit: 'an oversized t-shirt', camera: 'front-camera selfie held above her, slightly high angle', pose: 'lying in bed on the pillows, messy hair, sleepy smile', phone: false, light: 'soft morning daylight from the window' },
  { key: 'outfit_check', label: 'Mirror outfit check', location: 'bedroom', outfit: null, camera: 'full-body mirror selfie, phone covering part of the lower face', pose: 'full body, standing, showing off the outfit', phone: true, light: 'bright natural daylight' },
  { key: 'bed_sitting', label: 'Sitting on the bed', location: 'bedroom', outfit: 'comfy loungewear', camera: 'photo taken by a friend from the doorway at eye level', pose: 'sitting cross-legged on the bed, looking at the camera, laughing softly', phone: false, light: 'warm afternoon window light' },
  { key: 'bathroom_grwm', label: 'Get ready (bathroom)', location: 'bathroom', outfit: 'a white fluffy robe', camera: 'bathroom mirror selfie with her phone', pose: 'leaning towards the mirror doing her makeup', phone: true, light: 'bright vanity lights' },
  { key: 'kitchen_coffee', label: 'Coffee in the kitchen', location: 'kitchen', outfit: 'a casual oversized hoodie and shorts', camera: 'candid photo from across the kitchen counter', pose: 'holding a coffee mug with both hands, leaning on the counter', phone: false, light: 'morning sunlight' },
  { key: 'couch_cozy', label: 'Couch with a blanket', location: 'living', outfit: 'a cozy knit sweater', camera: 'front-camera selfie at arm\'s length', pose: 'curled up on the couch under a blanket, soft smile', phone: false, light: 'cozy warm lamp light, evening' },
  { key: 'car_selfie', label: 'Car selfie', location: 'car', outfit: 'a casual top', camera: 'front-camera selfie from the driver seat (parked)', pose: 'seatbelt on, looking into the camera, candid', phone: false, light: 'natural daylight through the windshield' },
  { key: 'gym_mirror', label: 'Gym mirror', location: 'gym', outfit: 'a matching gym set (sports top and leggings)', camera: 'gym mirror selfie with her phone', pose: 'standing, slight angle to show the outfit', phone: true, light: 'bright gym lighting' },
  { key: 'window_golden', label: 'Window at sunset', location: 'bedroom', outfit: 'a light summer dress', camera: 'photo by a friend, medium shot', pose: 'standing by the window looking outside, golden light on her face', phone: false, light: 'golden hour sunlight through the window' },
];

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const readMedia = (rel) => fs.readFileSync(path.join(MEDIA_DIR, rel));
const exists = (rel) => rel && fs.existsSync(path.join(MEDIA_DIR, rel));
const getAsset = (id) => (id ? db.prepare('SELECT * FROM model_assets WHERE id = ?').get(id) : null);

/**
 * Build the reference list + prompt for a studio image.
 * Order: face refs, body refs, place, phone, outfit (≤ 10 images for Nano Banana via the Comfy proxy).
 */
export function studioPrompt({ model, refs, scene, place, phone, outfit, outfitText, pose, extra, aspect }) {
  const imgs = [];
  const at = (p) => { imgs.push(p); return imgs.length; };
  const { refs: picked } = pickRefs(refs, 5);
  const faceIdx = []; const bodyIdx = [];
  for (const r of picked) (r.kind.startsWith('body_') ? bodyIdx : faceIdx).push(at(r.path));
  const placeIdx = place?.path && exists(place.path) ? at(place.path) : null;
  const phoneIdx = phone?.path && exists(phone.path) ? at(phone.path) : null;
  const outfitImg = outfit && exists(outfit.clean_path) ? outfit.clean_path : outfit?.path;
  const outfitIdx = outfitImg && exists(outfitImg) ? at(outfitImg) : null;
  const list = (a) => (a.length === 1 ? `image ${a[0]}` : `images ${a.join(', ')}`);

  const lines = [
    `Photorealistic candid smartphone photo for Instagram, ${aspect} framing. Exactly one person: the same woman as in the reference photos.`,
    faceIdx.length && `${list(faceIdx)}: her FACE — keep her identity exactly (facial features, freckles, skin, hair).`,
    bodyIdx.length && `${list(bodyIdx)}: her BODY — keep her exact figure and proportions.`,
    model.persona && `Her look: ${model.persona}.`,
    bodyLine({ body: model.body, rules: model.rules, profile: model.profile }),
    placeIdx
      ? `Location: image ${placeIdx} is HER ${LOCATION_TYPES[place.subtype] ? place.subtype : 'place'} — it must be exactly the same place: same walls, furniture, bedding, decor, window and colours${place.description ? ` (${place.description})` : ''}. Show it from the angle that fits the scene.`
      : place?.description ? `Location: ${place.description}.` : scene?.location && `Location: her ${scene.location}.`,
    phoneIdx ? `Phone: when her phone is visible it is exactly the phone in image ${phoneIdx}${phone.description ? ` (${phone.description})` : ''} — same model, colour and case.` : phone?.description ? `Phone: ${phone.description}.` : '',
    outfitIdx
      ? `Outfit: she wears exactly the clothes shown in image ${outfitIdx} (same garments, colours, fabric, fit and details${outfit.description ? `: ${outfit.description}` : ''}). Use only the clothes from that image — ignore any person, face or body in it.`
      : `Outfit: ${outfitText || outfit?.description || scene?.outfit || 'casual everyday clothes'}.`,
    scene && `Scene: ${scene.label.toLowerCase()} — ${scene.camera}. Lighting: ${scene.light}.`,
    `Pose: ${pose || scene?.pose || 'natural and relaxed'}.`,
    extra && `Extra direction (priority): ${extra}`,
    'Style: authentic amateur iPhone photo, natural colours, realistic skin texture with visible freckles and pores, slight grain, no beauty filter. SFW. No text, captions, stickers, watermarks or UI.',
  ].filter(Boolean);
  return { prompt: lines.join('\n'), inputs: imgs };
}

// ---- worker ------------------------------------------------------------------------------------
let busy = false;
const upd = (id, f) => {
  const k = Object.keys(f);
  db.prepare(`UPDATE creations SET ${k.map((x) => `${x} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...k.map((x) => (f[x] !== null && typeof f[x] === 'object' ? JSON.stringify(f[x]) : f[x])), now(), id);
};
const clog = (id, msg) => {
  const r = db.prepare('SELECT log FROM creations WHERE id = ?').get(id);
  if (!r) return;
  const l = parse(r.log, []); l.push({ at: now(), msg });
  db.prepare('UPDATE creations SET log = ?, step_status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(l.slice(-60)), msg, now(), id);
};
const cancelled = (id) => db.prepare('SELECT stage FROM creations WHERE id = ?').get(id)?.stage === 'cancelled';

async function runCreation(c) {
  const cfg = parse(c.config, {});
  await ensureProfile(c.model_id, (m) => clog(c.id, m));
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(c.model_id);
  if (!model) throw new Error('Model not found');
  const refs = normalizeRefs(model.ref_images);
  if (!refs.length) throw new Error(`${model.name}'s folder has no photos yet`);
  const scene = SCENES.find((s) => s.key === cfg.scene) || null;
  const place = getAsset(cfg.placeId);
  const phone = cfg.phoneId ? getAsset(cfg.phoneId) : null;
  const outfit = getAsset(cfg.outfitId);
  const poses = [...POSES.filter((p) => (cfg.poses || []).includes(p.key)), ...(cfg.customPose ? [{ key: 'custom', label: 'Custom pose', prompt: cfg.customPose }] : [])];
  const shots = poses.length ? poses : [{ key: 'scene', label: scene?.label || 'Photo', prompt: null }];
  const n = Math.max(1, Math.min(4, Number(cfg.variants) || 1));
  const aspect = cfg.aspect || '4:5';
  const gcfg = { ...defaultConfig(), nbResolution: cfg.resolution || defaultConfig().nbResolution };
  const out = [];
  let blocked = 0;
  for (const shot of shots) {
    if (cancelled(c.id)) return;
    const { prompt, inputs } = studioPrompt({
      model, refs, scene, place, phone: scene?.phone === false && !cfg.forcePhone ? null : phone, outfit, outfitText: cfg.outfitText,
      pose: shot.prompt, extra: cfg.extra, aspect,
    });
    if (!out.length) upd(c.id, { prompt });
    clog(c.id, `${shot.label}: generating ${n} image(s)…`);
    try {
      const imgs = await nanoBananaImages({
        inputs, prompt, cfg: gcfg, n, tag: `c${c.id}`, aspectRatio: aspect, meta: { label: shot.label, pose: shot.key },
        onStatus: (m) => upd(c.id, { step_status: `${shot.label}: ${m}` }), isCancelled: () => cancelled(c.id),
      });
      out.push(...imgs);
      const spent = imgs.reduce((a, x) => a + (x.cost || 0), 0);
      db.prepare('UPDATE creations SET cost_usd = cost_usd + ? WHERE id = ?').run(spent, c.id);
      recordCost({ amount: spent, provider: gcfg.imageEngine === 'gemini' ? 'gemini' : 'comfy', category: 'estudio', creationId: c.id, modelId: c.model_id });
    } catch (e) {
      if (!e.safety) throw e;
      blocked++;
      clog(c.id, `${shot.label}: blocked by the safety filter`);
    }
  }
  if (!out.length) throw new Error(blocked ? "All the images were blocked by Google's safety filter. Try another outfit/pose or remove suggestive words from the Persona." : 'Nothing was generated');
  const prev = parse(db.prepare('SELECT candidates FROM creations WHERE id = ?').get(c.id)?.candidates, []);
  upd(c.id, { candidates: [...prev, ...out], stage: 'review', error: null });
  clog(c.id, `${out.length} image(s) ready${blocked ? ` · ${blocked} blocked` : ''}`);
}

async function tick() {
  if (busy) return;
  const c = db.prepare("SELECT * FROM creations WHERE stage = 'queued' ORDER BY id LIMIT 1").get();
  if (!c) return;
  busy = true;
  upd(c.id, { stage: 'generating' });
  try { await runCreation(c); } catch (e) {
    if (!cancelled(c.id)) { upd(c.id, { stage: 'failed', error: e.message }); clog(c.id, `Error: ${e.message}`); }
  } finally { busy = false; setTimeout(tick, 100); }
}

export function startStudioWorker() {
  db.prepare("UPDATE creations SET stage = 'queued' WHERE stage = 'generating'").run(); // resume after restart
  setInterval(tick, 3000).unref();
  setTimeout(tick, 500);
}

// ---- routes --------------------------------------------------------------------------------------
export function registerStudioRoutes() {
  route('GET', '/api/studio/meta', () => ({ scenes: SCENES.map(({ key, label, location, outfit, phone }) => ({ key, label, location, outfit, phone })), locationTypes: LOCATION_TYPES, poses: POSES.map(({ key, label }) => ({ key, label })) }));

  // assets
  route('GET', '/api/models/:id/assets', (req, { params }) => db.prepare('SELECT * FROM model_assets WHERE model_id = ? ORDER BY type, created_at').all(params.id));

  route('POST', '/api/models/:id/assets', async (req, { params }) => {
    const b = await readBody(req);
    const m = db.prepare('SELECT * FROM models WHERE id = ?').get(params.id);
    if (!m) throw new HttpError(404, 'Model not found');
    if (!['location', 'prop', 'outfit'].includes(b.type)) throw new HttpError(400, 'Invalid type');
    let rel = null;
    if (b.image) {
      const { buf, ext } = decodeDataUrl(b.image);
      rel = `assets/m${m.id}_${b.type}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
    }
    const name = String(b.name || { location: LOCATION_TYPES[b.subtype] || 'Place', prop: 'Phone', outfit: 'Outfit' }[b.type]).slice(0, 60);
    return db.prepare('INSERT INTO model_assets (model_id, type, subtype, name, description, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(m.id, b.type, b.type === 'location' ? (LOCATION_TYPES[b.subtype] ? b.subtype : 'other') : b.subtype || null, name, String(b.description || '').slice(0, 600), rel, now());
  });

  route('PATCH', '/api/assets/:id', async (req, { params }) => {
    const b = await readBody(req);
    const a = getAsset(params.id);
    if (!a) throw new HttpError(404, 'Not found');
    let rel = a.path;
    if (b.image) {
      const { buf, ext } = decodeDataUrl(b.image);
      rel = `assets/m${a.model_id}_${a.type}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
      if (a.path) fs.rmSync(path.join(MEDIA_DIR, a.path), { force: true });
      if (a.clean_path) fs.rmSync(path.join(MEDIA_DIR, a.clean_path), { force: true });
      db.prepare("UPDATE model_assets SET clean_path = NULL, garment_desc = '' WHERE id = ?").run(a.id);
    }
    if (a.type === 'location' && b.subtype && LOCATION_TYPES[b.subtype]) db.prepare('UPDATE model_assets SET subtype = ? WHERE id = ?').run(b.subtype, a.id);
    db.prepare('UPDATE model_assets SET name = COALESCE(?, name), description = COALESCE(?, description), path = ? WHERE id = ?')
      .run(b.name ?? null, b.description ?? null, rel, a.id);
    return getAsset(a.id);
  });

  route('DELETE', '/api/assets/:id', (req, { params }) => {
    const a = getAsset(params.id);
    if (a?.path) fs.rmSync(path.join(MEDIA_DIR, a.path), { force: true });
    if (a?.clean_path) fs.rmSync(path.join(MEDIA_DIR, a.clean_path), { force: true });
    db.prepare('DELETE FROM model_assets WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // Create the reference image of a place/phone/outfit from a text description (done once, then reused).
  route('POST', '/api/assets/:id/generate', async (req, { params }) => {
    const a = getAsset(params.id);
    if (!a) throw new HttpError(404, 'Not found');
    if (!a.description.trim()) throw new HttpError(400, 'Write the description first');
    const prompt = {
      location: `Photorealistic smartphone photo of an empty ${a.subtype === 'other' ? 'room' : a.subtype} with no people: ${a.description}. Wide shot that shows the whole space, natural light, realistic, lived-in, Instagram girl-next-door aesthetic. No people, no text.`,
      prop: `Product photo of ${a.description}, on a plain light background, sharp, realistic, no people, no text.`,
      outfit: `Flat-lay product photo of this outfit on a plain light background: ${a.description}. Realistic fabric, no people, no text.`,
    }[a.type];
    const cfg = defaultConfig();
    const [img] = await nanoBananaImages({ inputs: a.path && exists(a.path) ? [a.path] : [], prompt, cfg, n: 1, tag: `asset${a.id}`, aspectRatio: a.type === 'location' ? '4:3' : '1:1' });
    if (!img) throw new HttpError(502, 'Could not generate');
    const rel = `assets/m${a.model_id}_${a.type}_${Date.now()}${path.extname(img.path)}`;
    fs.renameSync(path.join(MEDIA_DIR, img.path), path.join(MEDIA_DIR, rel));
    if (a.path) fs.rmSync(path.join(MEDIA_DIR, a.path), { force: true });
    db.prepare('UPDATE model_assets SET path = ? WHERE id = ?').run(rel, a.id);
    return getAsset(a.id);
  });

  // creations
  const row = (c) => ({ ...c, config: parse(c.config, {}), candidates: parse(c.candidates, []), log: parse(c.log, []) });
  route('GET', '/api/creations', (req, { query }) => {
    const mid = query.get('model');
    return db.prepare(`SELECT c.*, m.name AS model_name FROM creations c JOIN models m ON m.id = c.model_id ${mid ? 'WHERE c.model_id = ?' : ''} ORDER BY c.id DESC LIMIT 200`)
      .all(...(mid ? [mid] : [])).map(row);
  });

  route('POST', '/api/creations', async (req) => {
    const b = await readBody(req);
    const m = db.prepare('SELECT * FROM models WHERE id = ?').get(b.modelId);
    if (!m) throw new HttpError(404, 'Choose the model');
    if (!normalizeRefs(m.ref_images).length) throw new HttpError(400, `${m.name}'s folder has no photos yet`);
    const cfg = {
      scene: b.scene || null, placeId: b.placeId || null, phoneId: b.phoneId || null, forcePhone: !!b.forcePhone,
      outfitId: b.outfitId || null, outfitText: String(b.outfitText || '').slice(0, 400),
      poses: Array.isArray(b.poses) ? b.poses.slice(0, 12) : [], customPose: String(b.customPose || '').slice(0, 300),
      extra: String(b.extra || '').slice(0, 600), variants: Math.max(1, Math.min(4, Number(b.variants) || 1)),
      aspect: ['4:5', '1:1', '9:16', '3:4'].includes(b.aspect) ? b.aspect : '4:5', resolution: ['1K', '2K', '4K'].includes(b.resolution) ? b.resolution : '1K',
    };
    // One-off outfit dragged into the form: save it to her wardrobe so it can be reused.
    if (b.outfitImage) {
      const { buf, ext } = decodeDataUrl(b.outfitImage);
      const rel = `assets/m${m.id}_outfit_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
      cfg.outfitId = db.prepare('INSERT INTO model_assets (model_id, type, name, description, path, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
        .get(m.id, 'outfit', String(b.outfitName || 'New outfit').slice(0, 60), '', rel, now()).id;
    }
    const t = now();
    const c = db.prepare('INSERT INTO creations (model_id, stage, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *').get(m.id, 'queued', JSON.stringify(cfg), t, t);
    setTimeout(tick, 50);
    return row(c);
  });

  route('POST', '/api/creations/:id/again', (req, { params }) => {
    db.prepare("UPDATE creations SET stage = 'queued', error = NULL WHERE id = ?").run(params.id);
    setTimeout(tick, 50);
    return { ok: true };
  });
  route('POST', '/api/creations/:id/stage', async (req, { params }) => {
    const b = await readBody(req);
    if (!['approved', 'review', 'cancelled'].includes(b.stage)) throw new HttpError(400, 'Invalid status');
    upd(Number(params.id), { stage: b.stage });
    return { ok: true };
  });
  route('DELETE', '/api/creations/:id', (req, { params }) => {
    const c = db.prepare('SELECT * FROM creations WHERE id = ?').get(params.id);
    if (c) {
      upd(c.id, { stage: 'cancelled' });
      parse(c.candidates, []).forEach((x) => fs.rmSync(path.join(MEDIA_DIR, x.path), { force: true }));
      db.prepare('DELETE FROM creations WHERE id = ?').run(c.id);
    }
    return { ok: true };
  });
  // Use a created image as a new photo of her folder (e.g. an extra outfit/style reference).
  route('POST', '/api/creations/:id/to-folder', async (req, { params }) => {
    const b = await readBody(req);
    const c = db.prepare('SELECT * FROM creations WHERE id = ?').get(params.id);
    const cand = parse(c?.candidates, [])[Number(b.index)];
    if (!cand) throw new HttpError(404, 'Image not found');
    const m = db.prepare('SELECT * FROM models WHERE id = ?').get(c.model_id);
    const dir = modelDirRel(m);
    ensureModelDir(m);
    const dest = `${dir}/extra_studio_${Date.now()}${path.extname(cand.path)}`;
    fs.copyFileSync(path.join(MEDIA_DIR, cand.path), path.join(MEDIA_DIR, dest));
    const refs = normalizeRefs(m.ref_images);
    db.prepare('UPDATE models SET ref_images = ? WHERE id = ?').run(JSON.stringify([...refs, { path: dest, kind: 'extra', generated: true }]), m.id);
    return { ok: true };
  });
}

export { aspectFor };
