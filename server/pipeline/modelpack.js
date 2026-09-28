import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from '../db.js';

/**
 * A model's "pack": reference photos organised by angle, stored in its own folder
 * (data/media/models/<name>-<id>/). The pipeline picks the right photos per step:
 * face close-ups lock identity, full-body shots lock proportions.
 *
 * Files dropped straight into the folder are picked up by "sync"; the kind is read from the
 * filename prefix (e.g. rosto_frente.jpg, corpo_lado_2.png), anything else becomes "extra".
 */

export const KINDS = [
  { key: 'face_front', group: 'face', label: 'Face — front', required: true, alias: ['rosto_frente', 'face_front', 'frente'], hint: 'Face from the front, looking at the camera, natural light, no glasses' },
  { key: 'face_left', group: 'face', label: 'Face — 3/4 left', alias: ['rosto_esq', 'rosto_esquerda', 'face_left'], hint: 'Head turned ~45° to the left' },
  { key: 'face_right', group: 'face', label: 'Face — 3/4 right', alias: ['rosto_dir', 'rosto_direita', 'face_right'], hint: 'Head turned ~45° to the right' },
  { key: 'face_profile', group: 'face', label: 'Profile', alias: ['perfil', 'profile', 'face_profile'], hint: 'Full side profile (90°)' },
  { key: 'face_smile', group: 'face', label: 'Expression / smile', alias: ['sorriso', 'expressao', 'face_smile'], hint: 'Smiling, showing teeth, for the expressions in the videos' },
  { key: 'body_front', group: 'body', label: 'Full body — front', required: true, alias: ['corpo_frente', 'body_front', 'corpo'], hint: 'Head to toe, fitted/normal clothes, standing' },
  { key: 'body_side', group: 'body', label: 'Full body — side', alias: ['corpo_lado', 'body_side'], hint: 'From the side, for the silhouette and proportions' },
  { key: 'body_back', group: 'body', label: 'Back', alias: ['costas', 'body_back'], hint: 'From behind, full body' },
  { key: 'body_half', group: 'body', label: 'Half body', alias: ['meio_corpo', 'body_half'], hint: 'From the waist up: the typical selfie framing' },
  { key: 'extra', group: 'extra', label: 'Style / outfits', multi: true, alias: ['extra', 'estilo', 'outfit'], hint: 'Other photos: outfits, hair tied up, makeup…' },
];
const KIND_KEYS = KINDS.map((k) => k.key);
const IMG_RE = /\.(jpe?g|png|webp)$/i;

export const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'modelo';

export function modelDirRel(model) {
  return `models/${slug(model.name)}-${model.id}`;
}

export function ensureModelDir(model) {
  const abs = path.join(MEDIA_DIR, modelDirRel(model));
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** ref_images column → [{ path, kind, generated? }] (accepts the old string[] format). */
export function normalizeRefs(raw) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || []; } catch { list = []; }
  return list
    .map((r) => (typeof r === 'string' ? { path: r, kind: 'extra' } : r))
    .filter((r) => r?.path && fs.existsSync(path.join(MEDIA_DIR, r.path)))
    .map((r) => ({ ...r, kind: KIND_KEYS.includes(r.kind) ? r.kind : 'extra' }));
}

export function kindFromFilename(name) {
  const base = path.basename(name).toLowerCase().replace(IMG_RE, '');
  let best = null;
  for (const k of KINDS) for (const a of k.alias) if (base.startsWith(a) && (!best || a.length > best.len)) best = { key: k.key, len: a.length };
  return best?.key || 'extra';
}

/** Pick up images dropped directly into the model folder. */
export function syncFolder(model, refs) {
  const abs = ensureModelDir(model);
  const rel = modelDirRel(model);
  const known = new Set(refs.map((r) => r.path));
  const added = [];
  for (const f of fs.readdirSync(abs)) {
    if (!IMG_RE.test(f) || f.startsWith('.')) continue;
    const p = `${rel}/${f}`;
    if (known.has(p)) continue;
    added.push({ path: p, kind: kindFromFilename(f) });
  }
  return { refs: [...refs, ...added], added: added.length };
}

export function readiness(refs) {
  const has = (k) => refs.some((r) => r.kind === k);
  const faces = refs.filter((r) => KINDS.find((k) => k.key === r.kind)?.group === 'face').length;
  const bodies = refs.filter((r) => KINDS.find((k) => k.key === r.kind)?.group === 'body').length;
  const missingRequired = KINDS.filter((k) => k.required && !has(k.key)).map((k) => k.label);
  const missingRecommended = KINDS.filter((k) => !k.required && !k.multi && !has(k.key)).map((k) => k.label);
  const slots = KINDS.filter((k) => !k.multi);
  const score = Math.round((slots.filter((k) => has(k.key)).length / slots.length) * 100);
  return {
    ready: has('face_front') || refs.length >= 2, // enough to generate; "complete" = all required angles
    complete: missingRequired.length === 0,
    score, faces, bodies, missingRequired, missingRecommended,
  };
}

const ORDER = ['face_front', 'face_left', 'face_right', 'face_smile', 'face_profile', 'body_front', 'body_side', 'body_half', 'body_back', 'extra'];

/**
 * Choose which reference photos to send, best first: several face angles for identity,
 * then body shots for proportions. Returns { refs, description } for the prompt.
 */
/** star: the path of her ★ photo (Perfis), always the first reference when it is one of hers. */
export function pickRefs(refs, max = 6, { star = '' } = {}) {
  const sorted = [...refs].sort((a, b) => (star ? (b.path === star) - (a.path === star) : 0) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.generated ? 1 : 0) - (b.generated ? 1 : 0));
  const faces = sorted.filter((r) => r.kind.startsWith('face_')).slice(0, Math.max(1, Math.ceil(max * 0.6)));
  const bodies = sorted.filter((r) => r.kind.startsWith('body_')).slice(0, max - faces.length);
  let chosen = [...faces, ...bodies];
  if (chosen.length < max) chosen = [...chosen, ...sorted.filter((r) => !chosen.includes(r)).slice(0, max - chosen.length)];
  chosen = chosen.slice(0, max);
  const starred = star && refs.find((r) => r.path === star);
  if (starred) chosen = [starred, ...chosen.filter((r) => r !== starred)].slice(0, max);
  const idx = (pred) => chosen.map((r, i) => (pred(r) ? i + 1 : null)).filter(Boolean);
  const range = (arr) => (arr.length === 1 ? `image ${arr[0]}` : `images ${arr.join(', ')}`);
  const f = idx((r) => r.kind.startsWith('face_'));
  const b = idx((r) => r.kind.startsWith('body_'));
  const e = idx((r) => r.kind === 'extra');
  const parts = [];
  if (f.length) parts.push(`${range(f)}: close-ups of her FACE from different angles — use them to lock her exact facial identity`);
  if (b.length) parts.push(`${range(b)}: her BODY — use them for her exact figure, body shape and proportions`);
  if (e.length) parts.push(`${range(e)}: more photos of the same woman (style reference)`);
  return { refs: chosen, description: parts.join('; ') };
}

/** Prompts used to generate a missing angle from the existing photos. */
export const ANGLE_PROMPTS = {
  face_front: 'Close-up portrait of the same woman, facing the camera directly, neutral relaxed expression, eyes to camera',
  face_left: 'Close-up portrait of the same woman, head turned about 45 degrees to her left (three-quarter view)',
  face_right: 'Close-up portrait of the same woman, head turned about 45 degrees to her right (three-quarter view)',
  face_profile: 'Close-up portrait of the same woman in full side profile (90 degrees)',
  face_smile: 'Close-up portrait of the same woman smiling naturally with teeth, looking at the camera',
  body_front: 'Full-body photo of the same woman standing, facing the camera, head to toe visible, casual fitted clothes',
  body_side: 'Full-body photo of the same woman standing in side view, head to toe visible, casual fitted clothes',
  body_back: 'Full-body photo of the same woman standing with her back to the camera, head to toe visible, casual fitted clothes',
  body_half: 'Waist-up photo of the same woman, facing the camera, casual top, like a selfie framing',
};
