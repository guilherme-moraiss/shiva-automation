import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, MEDIA_DIR } from '../db.js';
import { normalizeRefs } from './modelpack.js';
import { PROFILE_PROMPT } from './prompts.js';
import { WaveSpeed } from './wavespeed.js';
import { geminiText } from './gemini.js';

/** Identity profile (hair, eyes, freckles, tattoos, piercings, nails, body) read from the model's own photos. */
export async function analyzeProfile(modelId) {
  const m = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
  if (!m) throw new Error('Model not found');
  const refs = normalizeRefs(m.ref_images);
  const real = refs.filter((r) => !r.generated);
  const pics = [...real.filter((r) => r.kind.startsWith('face_')).slice(0, 3), ...real.filter((r) => r.kind.startsWith('body_')).slice(0, 3)];
  const use = (pics.length ? pics : refs).slice(0, 6);
  if (!use.length) throw new Error('The model has no photos yet');
  const images = use.map((r) => {
    const buf = fs.readFileSync(path.join(MEDIA_DIR, r.path));
    return { buf, data: buf, mime: /\.png$/i.test(r.path) ? 'image/png' : /\.webp$/i.test(r.path) ? 'image/webp' : 'image/jpeg' };
  });
  const s = getSettings();
  let text;
  if (s.wavespeed_api_key) text = await new WaveSpeed(s.wavespeed_api_key).chat({ prompt: PROFILE_PROMPT, images });
  else if (s.gemini_api_key) text = await geminiText({ apiKey: s.gemini_api_key, prompt: PROFILE_PROMPT, images });
  else throw new Error('The WaveSpeed API key is required (Settings → Pipeline)');
  let profile;
  // Tolerant: the model sometimes wraps the JSON in ``` fences or adds a sentence before/after it.
  try { profile = JSON.parse(String(text).match(/\{[\s\S]*\}/)[0]); } catch { profile = null; }
  if (!profile || typeof profile !== 'object') throw new Error('The analysis did not return a valid profile: try again');
  const sig = refs.map((r) => r.path).sort().join('|');
  db.prepare('UPDATE models SET profile = ?, profile_sig = ? WHERE id = ?').run(JSON.stringify(profile), sig, m.id);
  return profile;
}

// Failed automatic reads, keyed by model + photo set: not retried for a while, so a model whose profile can't be
// read doesn't cost a vision call (and up to minutes of waiting) on every stage of every generation.
const failed = new Map();
const RETRY_AFTER_MS = 30 * 60e3;

/** Read the profile if it's missing or the photos changed since. Never throws (generation goes on without it). */
export async function ensureProfile(modelId, log = () => {}) {
  const m = modelId && db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
  if (!m) return;
  const refs = normalizeRefs(m.ref_images);
  if (!refs.length) return;
  const sig = refs.map((r) => r.path).sort().join('|');
  if (m.profile && m.profile_sig === sig) return;
  const key = `${m.id}:${sig}`;
  const at = failed.get(key);
  if (at && Date.now() - at < RETRY_AFTER_MS) return; // failed recently: carry on without it
  try {
    await analyzeProfile(m.id);
    failed.delete(key);
    log('Model profile read from the photos (tattoos, piercings, freckles…)');
  } catch (e) {
    failed.set(key, Date.now());
    log(`Could not read the profile: ${e.message}`);
  }
}
