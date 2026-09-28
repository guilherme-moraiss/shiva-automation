import fs from 'node:fs';
import path from 'node:path';
import { db, now, MEDIA_DIR } from '../db.js';
import { extractFrame, probe, ffmpegPath } from '../ffmpeg.js';
import { vision } from './outfit.js';
import { hasNoTattoos, hasNoPiercings } from './prompts.js';

/**
 * Quality control with a vision model (Gemini 2.5 Flash via the Comfy API — a fraction of a cent per check).
 *   reelPreflight — BEFORE spending: is this reel a good candidate for an exact copy?
 *   checkFrame    — first frame, BEFORE the video: same woman? tattoos / piercings / garbled text / extra people?
 *   checkVideo    — AFTER the video: the same checks on 4 frames, reported in the Studio.
 * Every check is best-effort: a failed vision call returns null and never blocks the pipeline by itself.
 */

const parseJson = (t) => { try { return JSON.parse(String(t).match(/\{[\s\S]*\}/)[0]); } catch { return null; } };
const exists = (rel) => rel && fs.existsSync(path.join(MEDIA_DIR, rel));
const rm = (rel) => { if (rel) fs.rmSync(path.join(MEDIA_DIR, rel), { force: true }); };

/** Frames at the given fractions of a video → temporary media paths (caller removes them). */
async function framesOf(videoRel, fractions) {
  const abs = path.join(MEDIA_DIR, videoRel);
  const { duration } = await probe(abs);
  const d = duration || 10;
  const out = [];
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; // unique: several checks can run at once
  for (const [i, f] of fractions.entries()) {
    const rel = `generated/qa_${stamp}_${i}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, rel), await extractFrame(abs, Math.min(d - 0.1, Math.max(0, d * f))));
    out.push({ rel, t: Math.round(d * f * 10) / 10 });
  }
  return out;
}

/** Up to 3 identity references: best face shots + one body shot. */
export function identityRefs(refs) {
  const pick = (pred) => refs.find((r) => pred(r) && !r.generated) || refs.find(pred);
  return [
    pick((r) => r.kind === 'face_front'),
    pick((r) => r.kind === 'face_smile' || r.kind === 'face_left' || r.kind === 'face_right'),
    pick((r) => r.kind === 'body_front' || r.kind === 'body_half'),
  ].filter((r, i, a) => r && exists(r.path) && a.findIndex((x) => x?.path === r.path) === i).map((r) => r.path);
}

function rulesText(body) {
  return [
    hasNoTattoos(body) && 'she has NO tattoos',
    hasNoPiercings(body) && 'she has NO piercings except small earlobe earrings (no navel/belly-button, nose, lip or eyebrow piercing)',
    body?.rules && `her rules: ${String(body.rules).replace(/\s*\n+\s*/g, '; ')}`,
  ].filter(Boolean).join('; ');
}

const CHECK_FIELDS = `"same_person": 0-10 (be STRICT: judge bone structure — face shape, jawline, cheekbones, nose, lip shape and size, eye shape, eyebrows. Hair, freckles, blush and makeup are easy to copy and must NOT raise the score. 10 = unmistakably the same woman; 7 = same woman with small drift; 5 = features partly from someone else; 0 = a different person),
"tattoos": true|false (any visible tattoo),
"extra_piercings": true|false (any piercing other than small earlobe earrings, e.g. navel, nose, lip),
"garbled_text": true|false (letters, numbers or logos on clothing or objects that are mirrored, misspelled or nonsensical),
"extra_people": true|false,
"deformed": true|false (clearly deformed hands, fingers, limbs or face)`;

/** Turns the raw flags into { ok, issues[] } for this model's rules. */
function verdict(j, body, minSame = 8) {
  if (!j) return null;
  const issues = [];
  const same = Number(j.same_person);
  if (Number.isFinite(same) && same < minSame) issues.push(`face not very similar to the model (${same}/10)`);
  if (j.tattoos && hasNoTattoos(body)) issues.push('has tattoos');
  if (j.extra_piercings && hasNoPiercings(body)) issues.push('has piercings (navel/nose…)');
  if (j.garbled_text) issues.push('garbled text/print on the clothes');
  if (j.extra_people) issues.push('another person appears');
  if (j.deformed) issues.push('deformed hands/body');
  return { ok: issues.length === 0, same: Number.isFinite(same) ? same : null, issues };
}

/** First-frame / photo check. Returns { ok, same, issues } or null. */
export async function checkFrame({ imgPath, refs, body }) {
  const ids = identityRefs(refs);
  if (!ids.length) return null;
  const t = await vision([
    'You are a strict quality reviewer for AI-generated photos of ONE fictional model.',
    `Images 1–${ids.length} are reference photos of the model (her true face and body). The LAST image is a new generated photo.`,
    rulesText(body) && `About the model: ${rulesText(body)}.`,
    'Check ONLY the LAST image and reply ONLY with compact JSON:',
    `{${CHECK_FIELDS}}`,
  ].filter(Boolean).join('\n'), [...ids, imgPath]).catch(() => null);
  return verdict(parseJson(t), body);
}

/** Video check on 4 frames. Returns { ok, same, issues: ['at 6.2s: …'], frames } or null. */
export async function checkVideo({ videoRel, refs, body }) {
  if (!ffmpegPath()) return null;
  const ids = identityRefs(refs);
  if (!ids.length) return null;
  let frames = [];
  try {
    frames = await framesOf(videoRel, [0.12, 0.38, 0.63, 0.88]);
    const t = await vision([
      'You are a strict quality reviewer for an AI-generated video of ONE fictional model.',
      `Images 1–${ids.length} are reference photos of the model (her true face and body). The last ${frames.length} images are frames of the new video, in order (${frames.map((f) => `${f.t}s`).join(', ')}).`,
      rulesText(body) && `About the model: ${rulesText(body)}.`,
      'Check EACH video frame and reply ONLY with compact JSON:',
      `{"frames": [{${CHECK_FIELDS}}, … one object per video frame, in order]}`,
    ].filter(Boolean).join('\n'), [...ids, ...frames.map((f) => f.rel)]).catch(() => null);
    const j = parseJson(t);
    if (!Array.isArray(j?.frames)) return null;
    const per = j.frames.slice(0, frames.length).map((f, i) => ({ t: frames[i].t, ...verdict(f, body) }));
    const issues = per.flatMap((f) => (f.issues || []).map((x) => `at ${f.t}s: ${x}`));
    const sames = per.map((f) => f.same).filter((x) => x !== null);
    return { ok: issues.length === 0, same: sames.length ? Math.min(...sames) : null, issues, frames: per };
  } finally { frames.forEach((f) => rm(f.rel)); }
}

/**
 * Before spending: is this reel a good candidate for an exact copy with the model?
 * Cached on the reel (preflight JSON). Needs the reel video in the app.
 */
export async function reelPreflight(reel, { force = false } = {}) {
  if (!force && reel.preflight) { try { return JSON.parse(reel.preflight); } catch {} }
  if (!reel.video_path || !exists(reel.video_path)) throw new Error('The reel video is not in the app yet');
  if (!ffmpegPath()) throw new Error('ffmpeg is missing (npm run setup)');
  let frames = [];
  try {
    frames = await framesOf(reel.video_path, [0.04, 0.2, 0.38, 0.56, 0.74, 0.94]);
    const t = await vision([
      `These ${frames.length} images are frames of ONE short vertical reel, in order from start to end (${frames.map((f) => `${f.t}s`).join(', ')}).`,
      reel.caption && `Caption: ${String(reel.caption).slice(0, 200)}`,
      'We want to REMAKE it as an "exact copy" with a different woman (an AI model): same choreography and camera, but HER face, and ONE outfit for the whole video.',
      'Reply ONLY with compact JSON:',
      `{"format": "talking | dance | grwm/outfit change | transition | lifestyle | other",
"outfit_changes": true|false (she clearly wears different outfits in different frames),
"undressing": true|false (she takes clothes off, or is topless/partly nude, even from behind),
"face_closeup_talking": true|false (face close to the camera and talking/lip-syncing for most of the reel),
"multiple_people": true|false,
"text_on_clothes": true|false (letters, numbers or logos printed on her clothes),
"revealing_outfit": true|false (pronounced cleavage, bikini, lingerie or very short clothes),
"source_tattoos": true|false, "source_piercings": true|false,
"outfits": ["short English description of each distinct outfit"],
"best_frame": 1-${frames.length} (the frame to recreate her in: exactly one person, sharp with no motion blur, face towards the camera, the whole outfit visible, a natural pose),
"verdict": "good | risky | bad",
"reasons": ["short reason in English"],
"advice": "one short recommendation in English"}`,
      'Rules for the verdict: outfit changes or undressing → "bad" (the copy keeps one outfit, so the actions stop making sense, and video moderation may refuse). Face close-up talking for most of the reel → at least "risky" (the original face tends to leak into the copy). Multiple people → "bad". Text on clothes → "risky" (it comes out garbled). Revealing outfit → at least "risky" (the automatic content filter of the Wan 3.0 video provider often refuses it, even for normal clothes; say so in the reasons). Otherwise "good".',
    ].filter(Boolean).join('\n'), frames.map((f) => f.rel));
    const j = parseJson(t);
    if (!j?.verdict) throw new Error('The analysis did not return a valid result');
    const bf = Number(j.best_frame);
    const out = { ...j, best_t: bf >= 1 && bf <= frames.length ? frames[bf - 1].t : null, at: now() };
    db.prepare('UPDATE reels SET preflight = ? WHERE id = ?').run(JSON.stringify(out), reel.id);
    return out;
  } finally { frames.forEach((f) => rm(f.rel)); }
}
