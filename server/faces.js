import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, MEDIA_DIR } from './db.js';
import { route, readBody, int, HttpError, decodeDataUrl } from './http.js';
import { nanoBananaImages, defaultConfig, IMAGE_EDITORS, EDIT_ONLY } from './pipeline/runner.js';
import { ensureModelDir, modelDirRel } from './pipeline/modelpack.js';
import { recordCost } from './costs.js';

/**
 * Gerador de caras: a new AI model, in four phases.
 *   1 Novas caras — a prompt, with optional reference faces (up to 8), → N candidates.
 *   2 Refinar     — one Phase-1 winner, re-made with a prompt (her in a scene, framing, light).
 *   3 Editar      — one Phase-2 image edited with a prompt (clothes, hair, details), Nano Banana / Seedream / Flux.2.
 *   4 Criar modelo — a "super" winner becomes a model: the image is her front face, the rest cloned from a model you pick.
 * Every image can be marked vencedora / super / perdedora (also one at a time, with the keyboard).
 * Jobs are paid when they run: a restart in the middle marks the job as interrupted instead of paying again.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS face_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  source_id INTEGER,
  n INTEGER NOT NULL DEFAULT 4,
  aspect TEXT NOT NULL DEFAULT '9:16',
  resolution TEXT NOT NULL DEFAULT '1K',
  engine TEXT NOT NULL DEFAULT 'nano',
  stage TEXT NOT NULL DEFAULT 'queued',
  step_status TEXT,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES face_jobs(id) ON DELETE SET NULL,
  phase INTEGER NOT NULL,
  parent_id INTEGER REFERENCES faces(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  prompt TEXT,
  refs_count INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  verdict TEXT,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS faces_phase ON faces(phase, id);
CREATE TABLE IF NOT EXISTS face_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
fs.mkdirSync(path.join(MEDIA_DIR, 'faces'), { recursive: true });

// A restart while a job ran: its images may be paid already, so it is never re-sent on its own.
db.prepare("UPDATE face_jobs SET stage = 'failed', error = 'The app restarted in the middle of this generation. Press Generate again if you want to repeat it.' WHERE stage = 'running'").run();

const ASPECTS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:5', '5:4', '4:3', '9:16', '16:9'];
const ENGINES = { nano: 'Nano Banana', seedream: IMAGE_EDITORS.seedream.label, flux: IMAGE_EDITORS.flux.label, wan: EDIT_ONLY.wan.label };
const SYSTEM = 'You create photorealistic, unretouched smartphone photos of ONE fictional adult woman (clearly over 21). '
  + 'She is always fully dressed: every garment stays on, opaque and in place. '
  + 'Natural skin texture, real phone-camera look, no text, no watermark, no borders, exactly one person.';
const exists = (rel) => !!rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const upd = (id, f) => {
  const k = Object.keys(f);
  db.prepare(`UPDATE face_jobs SET ${k.map((x) => `${x} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...k.map((x) => f[x]), now(), id);
};

// ---- worker: one job at a time (each job already runs its N images in parallel) ----------------------------------
let running = false;
async function kick() {
  if (running) return;
  running = true;
  let job = null;
  try { // an error here (e.g. the database busy for a moment) fails this job, never the whole app
    job = db.prepare("SELECT * FROM face_jobs WHERE stage = 'queued' ORDER BY id LIMIT 1").get();
    if (!job) return;
    upd(job.id, { stage: 'running', step_status: 'Starting…' });
    await runJob(job);
  } catch (e) {
    if (job) try { upd(job.id, { stage: 'failed', error: String(e.message || e).slice(0, 600) }); } catch { /* retried by the next kick */ }
  } finally {
    running = false;
    if (job) setTimeout(kick, 50);
  }
}

async function runJob(job) {
  const s = getSettings();
  const source = job.source_id ? db.prepare('SELECT * FROM faces WHERE id = ?').get(job.source_id) : null;
  if (job.source_id && !exists(source?.path)) throw new Error('The starting image no longer exists');
  const inputs = job.phase === 1 ? parse(job.refs, []).filter(exists) : [source.path];
  const engine = job.phase === 3 ? job.engine : 'nano';
  if (!s.wavespeed_api_key) throw new Error('The WaveSpeed API key is missing (Settings → Pipeline)');
  const cfg = { ...defaultConfig(), nbResolution: job.resolution };
  const aspect = job.aspect === 'auto' ? (job.phase === 1 ? '9:16' : 'auto') : job.aspect;
  const prompt = job.phase === 1
    ? job.prompt
    : `${job.prompt}\n\nThe woman is the one in image 1: keep her exact face, identity, skin tone and hair unless the instruction changes them.`;
  // A provider's content filter refusal is reported as it is (no reel-pipeline advice here, no retry elsewhere).
  const imgs = await nanoBananaImages({
    inputs, prompt, cfg, n: job.n, tag: `face${job.id}`, aspectRatio: aspect, systemPrompt: SYSTEM, engine,
    onStatus: (m) => upd(job.id, { step_status: String(m).slice(0, 200) }),
    isCancelled: () => db.prepare('SELECT stage FROM face_jobs WHERE id = ?').get(job.id)?.stage === 'cancelled',
  }).catch((e) => {
    if (e.safety) throw new Error(`The content filter of ${ENGINES[engine] || engine} refused this request. Nothing was generated or charged for those images.`);
    throw e;
  });
  const t = now();
  const cost = imgs.reduce((a, x) => a + (x.cost || 0), 0);
  const ins = db.prepare('INSERT INTO faces (job_id, phase, parent_id, path, prompt, refs_count, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const im of imgs) {
    // Kept apart from the pipeline's files: faces/ is only cleaned when you delete a face here.
    const rel = `faces/${path.basename(im.path)}`;
    fs.renameSync(path.join(MEDIA_DIR, im.path), path.join(MEDIA_DIR, rel));
    ins.run(job.id, job.phase, source?.id ?? null, rel, job.prompt, inputs.length, ENGINES[engine] || engine, t);
  }
  const workerId = db.prepare('SELECT * FROM face_jobs WHERE id = ?').get(job.id)?.worker_id ?? null; // Equipa: who asked for these faces
  if (cost) recordCost({ amount: cost, provider: engine === 'nano' && cfg.imageEngine === 'gemini' ? 'gemini' : 'comfy', category: 'caras', modelId: null, workerId });
  if (db.prepare('SELECT stage FROM face_jobs WHERE id = ?').get(job.id)?.stage === 'cancelled') return;
  upd(job.id, { stage: 'done', cost, step_status: `${imgs.length} image(s)`, error: imgs.length < job.n ? `${job.n - imgs.length} of ${job.n} did not come out (filter or error)` : null });
}

export function startFaceWorker() {
  setInterval(kick, 3000).unref();
  setTimeout(kick, 500);
}

// ---- routes ------------------------------------------------------------------------------------------------------
const faceRow = (f) => ({ ...f });

export function registerFaceRoutes() {
  route('GET', '/api/faces', (req, { query }) => {
    const phase = int(query.get('phase'));
    const verdict = query.get('verdict');
    const where = [];
    const args = [];
    if (phase) { where.push('phase = ?'); args.push(phase); }
    if (verdict === 'none') where.push('verdict IS NULL');
    else if (verdict === 'win') where.push("verdict IN ('winner', 'super')");
    else if (['winner', 'super', 'loser'].includes(verdict)) { where.push('verdict = ?'); args.push(verdict); }
    const faces = db.prepare(`SELECT * FROM faces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 600`).all(...args).filter((f) => exists(f.path)).map(faceRow);
    const jobs = db.prepare("SELECT * FROM face_jobs WHERE stage IN ('queued', 'running') OR (stage = 'failed' AND updated_at > ?) ORDER BY id DESC LIMIT 20").all(now() - 3600);
    const counts = Object.fromEntries(db.prepare('SELECT phase, COUNT(*) n FROM faces GROUP BY phase').all().map((r) => [r.phase, r.n]));
    const s = getSettings();
    return { faces, jobs, counts, engines: ENGINES, aspects: ASPECTS, nbModel: s.image_engine === 'gemini' ? s.nb_model_gemini : s.nb_model_comfy };
  });

  // New job. Phase 1: `refs` = data URLs (optional, ≤ 8). Phases 2 and 3: `sourceId` = the face to start from.
  route('POST', '/api/faces/jobs', async (req) => {
    const b = await readBody(req);
    const phase = int(b.phase);
    if (![1, 2, 3].includes(phase)) throw new HttpError(400, 'Invalid phase');
    const prompt = String(b.prompt || '').trim().slice(0, 4000);
    if (!prompt) throw new HttpError(400, 'Write the prompt');
    const n = Math.max(1, Math.min(8, int(b.n, 4)));
    const aspect = ASPECTS.includes(b.aspect) ? b.aspect : phase === 1 ? '9:16' : 'auto';
    const resolution = b.resolution === '2K' ? '2K' : '1K';
    const engine = phase === 3 && ENGINES[b.engine] ? b.engine : 'nano';
    let refs = [];
    let sourceId = null;
    if (phase === 1) {
      const list = (Array.isArray(b.refs) ? b.refs : []).slice(0, 8);
      refs = list.map((d, i) => {
        const { buf, ext } = decodeDataUrl(d);
        const rel = `faces/ref_${Date.now()}_${i}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
        return rel;
      });
    } else {
      sourceId = int(b.sourceId);
      const src = sourceId && db.prepare('SELECT * FROM faces WHERE id = ?').get(sourceId);
      if (!src || !exists(src.path)) throw new HttpError(400, phase === 2 ? 'Choose the winning face to start from' : 'Choose the starting image');
    }
    const t = now();
    const job = db.prepare('INSERT INTO face_jobs (phase, prompt, refs, source_id, n, aspect, resolution, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(phase, prompt, JSON.stringify(refs), sourceId, n, aspect, resolution, engine, t, t);
    setTimeout(kick, 10);
    return job;
  });

  route('POST', '/api/faces/jobs/:id/cancel', (req, { params }) => {
    db.prepare("UPDATE face_jobs SET stage = 'cancelled', step_status = 'Canceled' WHERE id = ? AND stage IN ('queued', 'running')").run(params.id);
    return { ok: true };
  });

  route('POST', '/api/faces/:id/verdict', async (req, { params }) => {
    const b = await readBody(req);
    const v = ['winner', 'super', 'loser'].includes(b.verdict) ? b.verdict : null;
    const f = db.prepare('SELECT id FROM faces WHERE id = ?').get(params.id);
    if (!f) throw new HttpError(404, 'Image not found');
    db.prepare('UPDATE faces SET verdict = ? WHERE id = ?').run(v, f.id);
    return { ok: true, verdict: v };
  });

  route('DELETE', '/api/faces/:id', (req, { params }) => {
    const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(params.id);
    if (f) {
      const used = db.prepare('SELECT COUNT(*) n FROM faces WHERE path = ? AND id != ?').get(f.path, f.id).n;
      if (!used) fs.rmSync(path.join(MEDIA_DIR, f.path), { force: true });
      db.prepare('DELETE FROM faces WHERE id = ?').run(f.id);
    }
    return { ok: true };
  });

  // Saved prompts per phase.
  route('GET', '/api/faces/prompts', () => db.prepare('SELECT * FROM face_prompts ORDER BY phase, id DESC').all());
  route('POST', '/api/faces/prompts', async (req) => {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'The prompt is empty');
    const phase = [1, 2, 3].includes(int(b.phase)) ? int(b.phase) : 1;
    if (db.prepare('SELECT 1 FROM face_prompts WHERE phase = ? AND text = ?').get(phase, text)) return { ok: true, existed: true };
    return db.prepare('INSERT INTO face_prompts (phase, text, created_at) VALUES (?, ?, ?) RETURNING *').get(phase, text, now());
  });
  route('DELETE', '/api/faces/prompts/:id', (req, { params }) => {
    db.prepare('DELETE FROM face_prompts WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // Phase 4: a new model from a face. Persona, body, rules and her caption pool are copied from `cloneFrom`.
  route('POST', '/api/faces/:id/create-model', async (req, { params }) => {
    const b = await readBody(req);
    const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(params.id);
    if (!f || !exists(f.path)) throw new HttpError(404, 'Image not found');
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Write the model name');
    const from = int(b.cloneFrom) ? db.prepare('SELECT * FROM models WHERE id = ?').get(int(b.cloneFrom)) : null;
    let m;
    try {
      m = db.prepare('INSERT INTO models (name, color, notes, persona, body, rules, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .get(name, b.color || null, `Created in the Face generator (image #${f.id})${from ? `, settings copied from ${from.name}` : ''}`,
          from?.persona || '', from?.body || '', from?.rules || '', now());
    } catch { throw new HttpError(409, 'A model with that name already exists'); }
    ensureModelDir(m);
    const rel = `${modelDirRel(m)}/face_front_${Date.now()}${path.extname(f.path) || '.png'}`;
    fs.copyFileSync(path.join(MEDIA_DIR, f.path), path.join(MEDIA_DIR, rel));
    db.prepare('UPDATE models SET ref_images = ? WHERE id = ?').run(JSON.stringify([{ path: rel, kind: 'face_front', generated: true }]), m.id);
    let captions = 0;
    if (from) {
      const hasCaptions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'captions'").get();
      if (hasCaptions) {
        const rows = db.prepare('SELECT text, weight FROM captions WHERE model_id = ?').all(from.id);
        const ins = db.prepare('INSERT INTO captions (model_id, text, weight, created_at) VALUES (?, ?, ?, ?)');
        for (const c of rows) ins.run(m.id, c.text, c.weight, now());
        captions = rows.length;
      }
    }
    db.prepare("UPDATE faces SET model_id = ?, verdict = 'super' WHERE id = ?").run(m.id, f.id);
    return { model: { id: m.id, name: m.name }, captions };
  });
}
