import fs from 'node:fs';
import path from 'node:path';
import { db, now, MEDIA_DIR, getSettings, setSetting } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { importReelFromLink } from './review.js';
import { isBusy, busyCount, getGeneration, log, kick } from './pipeline/runner.js';
import { probe, cutVideo, ffmpegPath } from './ffmpeg.js';
import { sendFile } from './media.js';

/**
 * Projetos (the front page). A project is one remake run (a row of `generations`): the reel, her image, the video,
 * the review. Pieces:
 *   1. Novo projeto: any TikTok / Instagram reel link → the reel in the app → "Criar remake".
 *   2. Open projects with the step each one is at, search by number, and "Foco" (the next one that needs you).
 */

// ---- A correr agora ----------------------------------------------------------------------------------------------
const parallel = () => Math.max(1, Math.min(4, Number(getSettings().pipeline_concurrency) || 1));
/**
 * Place in the queue of the projects waiting for a free slot (the worker takes them oldest first, up to
 * pipeline_concurrency at a time). Only set when every slot is taken; otherwise they start within seconds.
 */
export function queuePositions() {
  const out = new Map();
  if (busyCount() < parallel()) return out; // same test as the worker (enlargements, edits and Topaz run beside the slots)
  const rows = db.prepare("SELECT id FROM generations WHERE stage IN ('queued', 'imaging', 'animating') ORDER BY updated_at ASC").all();
  let n = 0;
  for (const r of rows) if (!isBusy(r.id)) out.set(r.id, ++n);
  return out;
}

// Which projects each list shows. "Precisa de ti" = waiting for a person: pick the image, review the video, or a failure.
// A project scheduled in Aprovação (publish set) leaves the open list for "Agendados".
const BUCKETS = {
  open: "g.archived = 0 AND g.publish IS NULL AND g.stage NOT IN ('rejected', 'cancelled')",
  // Needs a person here: an image to choose, a failure, or a photo post to approve. Finished videos are judged in Aprovação
  // (one queue, one badge), so they are not counted twice.
  todo: "g.archived = 0 AND g.publish IS NULL AND (g.stage IN ('awaiting_approval', 'failed') OR (g.stage = 'review' AND NOT ((g.kind = 'video' AND g.video_path IS NOT NULL) OR (g.kind IN ('photo', 'poses') AND g.candidates IS NOT NULL AND g.candidates != '[]'))))",
  active: "g.archived = 0 AND g.publish IS NULL AND g.stage IN ('queued', 'imaging', 'animating')",
  ready: "g.archived = 0 AND g.publish IS NULL AND g.stage = 'approved'",
  scheduled: "g.archived = 0 AND g.publish IS NOT NULL",
  archived: "(g.archived = 1 OR g.stage IN ('rejected', 'cancelled'))",
};

const FROM = `FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id
  JOIN creators c ON c.id = r.creator_id LEFT JOIN models md ON md.id = m.model_id`;

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const exists = (rel) => !!rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));
const abs = (rel) => path.join(MEDIA_DIR, rel);
const secs = (x) => (Math.round(x * 100) / 100).toFixed(2);
const RUNNING = ['queued', 'imaging', 'animating'];

/** Small picture for the list: her chosen image, else her first candidate, else the reel frame or cover. */
function thumbOf(p) {
  const cands = parse(p.candidates, []);
  return [p.chosen_image, cands[0]?.path, p.frame_path, p.thumb_path].find(exists) || null;
}

export function projectCounts() {
  const row = db.prepare(`SELECT ${Object.entries(BUCKETS).map(([k, w]) => `COALESCE(SUM(CASE WHEN ${w} THEN 1 ELSE 0 END), 0) AS ${k}`).join(', ')} ${FROM}`).get();
  return Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, row[k]]));
}

export function registerProjectRoutes() {
  route('POST', '/api/projects/from-link', async (req) => {
    const b = await readBody(req);
    return importReelFromLink(String(b.url || '').slice(0, 500));
  });

  // The list on the left of Projetos: newest first, with the counts of every list for the tabs.
  // Everything generating or waiting (projects, Criar conteúdo, 18+, caras), and how many projects run at once.
  route('GET', '/api/running', () => {
    const pos = queuePositions();
    const projects = db.prepare(`SELECT g.id, g.kind, g.stage, g.step_status, g.updated_at, md.name AS model_name, c.handle
      FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id JOIN creators c ON c.id = r.creator_id LEFT JOIN models md ON md.id = m.model_id
      WHERE g.stage IN ('queued', 'imaging', 'animating') ORDER BY g.updated_at ASC`).all().map((p) => ({ ...p, busy: isBusy(p.id), queuePos: pos.get(p.id) || null }));
    const jobs = (sql, label, href) => { try { return db.prepare(sql).all().map((j) => ({ ...j, label, href })); } catch { return []; } };
    const other = [
      ...jobs("SELECT id, stage, step_status, updated_at FROM creations WHERE stage IN ('queued', 'generating') ORDER BY id", 'Create content', '#/create'),
      ...jobs("SELECT id, stage, step_status, updated_at FROM spicy_jobs WHERE stage IN ('queued', 'running') ORDER BY id", '18+ content', '#/spicy'),
      ...jobs("SELECT id, stage, step_status, updated_at FROM face_jobs WHERE stage IN ('queued', 'running') ORDER BY id", 'Face generator', '#/faces'),
    ];
    return { parallel: parallel(), projects, other };
  });

  route('PUT', '/api/running/parallel', async (req) => {
    const b = await readBody(req);
    const n = int(b.parallel);
    if (!(n >= 1 && n <= 4)) throw new HttpError(400, 'Choose between 1 and 4');
    setSetting('pipeline_concurrency', String(n));
    kick(); // more slots: the waiting projects start now
    return { parallel: n };
  });

  route('GET', '/api/projects', (req, { query }) => {
    const positions = queuePositions();
    const view = BUCKETS[query.get('view')] ? query.get('view') : 'open';
    const where = [BUCKETS[view]];
    const args = [];
    const q = String(query.get('q') || '').trim().replace(/^#/, '');
    if (/^\d+$/.test(q)) { where.push('g.id = ?'); args.push(Number(q)); }
    else if (q) { where.push("(c.handle LIKE ? ESCAPE '\\' OR md.name LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`; args.push(like, like); }
    // Chips: how many of this list each model and each person has (before the chip filters themselves).
    const facetWhere = where.join(' AND ');
    const facets = {
      models: db.prepare(`SELECT m.model_id AS id, md.name, COUNT(*) n ${FROM} WHERE ${facetWhere} GROUP BY m.model_id ORDER BY n DESC`).all(...args),
      workers: db.prepare(`SELECT g.worker_id AS id, w.name, COUNT(*) n ${FROM} LEFT JOIN workers w ON w.id = g.worker_id WHERE ${facetWhere} GROUP BY g.worker_id ORDER BY n DESC`).all(...args),
    };
    const model = int(query.get('model'));
    const worker = query.get('worker');
    if (model) { where.push('m.model_id = ?'); args.push(model); }
    if (worker === '0') where.push('g.worker_id IS NULL');
    else if (int(worker)) { where.push('g.worker_id = ?'); args.push(int(worker)); }
    const rows = db.prepare(`SELECT g.id, g.kind, g.stage, g.step_status, g.error, g.created_at, g.updated_at, g.archived, g.cost_usd, g.publish,
        g.worker_id, (SELECT name FROM workers WHERE id = g.worker_id) AS worker_name,
        g.chosen_image, g.candidates, (g.video_path IS NOT NULL) AS has_video, json_extract(g.config, '$.step') AS step, m.model_id, md.name AS model_name, md.color AS model_color,
        r.id AS reel_id, r.platform, r.media_type, r.thumb_path, r.frame_path, c.handle
      ${FROM} WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT 300`).all(...args);
    return {
      view,
      facets,
      counts: projectCounts(),
      items: rows.map(({ candidates, chosen_image, frame_path, thumb_path, error, ...p }) => ({
        ...p,
        has_video: !!p.has_video,
        chosen: !!chosen_image,
        images: parse(candidates, []).length,
        thumb: thumbOf({ candidates, chosen_image, frame_path, thumb_path }),
        error: error ? String(error).slice(0, 160) : null,
        busy: isBusy(p.id),
        queuePos: positions.get(p.id) || null,
      })),
    };
  });

  // "Foco": the project that has waited longest for a person (an image to pick, photos to review or a failure;
  // finished videos are in Aprovação). Failures last.
  route('GET', '/api/projects/next', (req, { query }) => {
    const skip = String(query.get('skip') || '').split(',').map((x) => int(x)).filter((x) => x > 0).slice(0, 500);
    // "Só os meus": only the projects of the person working (X-Worker).
    const mine = query.get('mine') === '1' && req.worker ? req.worker.id : null;
    const rows = db.prepare(`SELECT g.id ${FROM} WHERE ${BUCKETS.todo}${mine ? ' AND g.worker_id = ?' : ''}${skip.length ? ` AND g.id NOT IN (${skip.map(() => '?').join(',')})` : ''}
      ORDER BY CASE g.stage WHEN 'failed' THEN 1 ELSE 0 END, g.updated_at ASC, g.id ASC LIMIT 100`).all(...(mine ? [mine] : []), ...skip);
    const row = rows.find((r) => !isBusy(r.id)); // one that is enlarging (or in the Topaz) is not waiting for you yet
    return { id: row?.id ?? null, waiting: projectCounts().todo };
  });

  // Close a project by hand (out of the open list) or open it again. Nothing is deleted.
  route('POST', '/api/projects/:id/archive', async (req, { params }) => {
    const b = await readBody(req);
    const g = db.prepare('SELECT id, stage FROM generations WHERE id = ?').get(params.id);
    if (!g) throw new HttpError(404, 'Project not found');
    const archived = b.archived !== false;
    if (archived && (['queued', 'imaging', 'animating'].includes(g.stage) || isBusy(g.id))) {
      throw new HttpError(400, 'This project is still generating: wait for it to finish or cancel it first');
    }
    db.prepare('UPDATE generations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, g.id);
    return { ok: true, archived };
  });

  // Frame picker of the Remake page: frames per second and length of the reel video in the app.
  route('GET', '/api/reels/:id/meta', async (req, { params }) => {
    const r = db.prepare('SELECT video_path, duration FROM reels WHERE id = ?').get(params.id);
    if (!r) throw new HttpError(404, 'Reel not found');
    if (!exists(r.video_path) || !ffmpegPath()) return { video: exists(r.video_path), fps: null, duration: r.duration ?? null, frames: null };
    const p = await probe(abs(r.video_path));
    const duration = p.duration || r.duration || null;
    const fps = p.fps || 30;
    return { video: true, fps, duration, frames: duration ? Math.max(1, Math.round(duration * fps)) : null, width: p.width, height: p.height };
  });

  // ---- Cortar o vídeo (optional): the finished video, cut to [start, end] of the uncut one --------------
  const idleWithVideo = (id) => {
    const g = getGeneration(Number(id));
    if (!g) throw new HttpError(404, 'Project not found');
    if (RUNNING.includes(g.stage) || isBusy(g.id)) throw new HttpError(400, 'Wait for the video to finish generating');
    if (g.kind !== 'video' || !exists(g.video_path)) throw new HttpError(400, 'This project has no video yet');
    if (g.publish) throw new HttpError(409, 'This project is already scheduled: undo the scheduling in Approval before changing the video');
    return g;
  };
  /** The uncut video (after a cut the project keeps it, so every cut starts from the whole video). */
  const uncut = (g) => (exists(g.config.untrimmedVideo) ? g.config.untrimmedVideo : g.video_path);

  route('GET', '/api/projects/:id/source-video', (req, { params, res }) => {
    const g = getGeneration(Number(params.id));
    if (!g || !exists(g.video_path)) throw new HttpError(404, 'This project has no video yet');
    sendFile(req, res, abs(uncut(g)), { cache: 'private, max-age=3600', filename: `project_${g.id}_full.mp4` });
  });

  const restore = (g, why) => {
    const orig = g.config.untrimmedVideo;
    const cfg = { ...g.config };
    delete cfg.trim;
    delete cfg.untrimmedVideo;
    if (exists(orig) && orig !== g.video_path) {
      db.prepare('UPDATE generations SET video_path = ?, config = ?, updated_at = ? WHERE id = ?').run(orig, JSON.stringify(cfg), now(), g.id);
      fs.rmSync(abs(g.video_path), { force: true });
    } else db.prepare('UPDATE generations SET config = ? WHERE id = ?').run(JSON.stringify(cfg), g.id);
    log(g.id, why);
  };

  route('POST', '/api/projects/:id/trim', async (req, { params }) => {
    const b = await readBody(req);
    const g = idleWithVideo(params.id);
    if (!ffmpegPath()) throw new HttpError(500, 'ffmpeg not found — run `npm run setup`');
    const src = uncut(g);
    const { duration } = await probe(abs(src));
    if (!duration) throw new HttpError(500, 'Could not read the video duration');
    const start = Math.min(Math.max(0, Number(b.start) || 0), duration);
    const end = Math.min(duration, Number.isFinite(Number(b.end)) && Number(b.end) > 0 ? Number(b.end) : duration);
    if (end - start < 0.5) throw new HttpError(400, 'The cut must be at least 0.5 s long');
    if (start < 0.05 && end > duration - 0.05) { // the whole video: nothing to cut (undo a previous cut, if any)
      if (g.config.untrimmedVideo) restore(g, 'Cut undone: the whole video is kept');
      return { ok: true, trim: null, duration };
    }
    const out = `generated/g${g.id}_cut_${Date.now()}.mp4`;
    try { await cutVideo(abs(src), abs(out), start, end); } catch (e) {
      fs.rmSync(abs(out), { force: true });
      throw new HttpError(500, `Could not cut the video: ${e.message}`);
    }
    const prevCut = g.video_path !== src ? g.video_path : null;
    const trim = { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
    const cfg = { ...g.config, untrimmedVideo: src, trim };
    db.prepare('UPDATE generations SET video_path = ?, config = ?, updated_at = ? WHERE id = ?').run(out, JSON.stringify(cfg), now(), g.id);
    if (prevCut) fs.rmSync(abs(prevCut), { force: true });
    log(g.id, `Video cut: from ${secs(start)} s to ${secs(end)} s (keeps ${secs(end - start)} s of ${secs(duration)} s)`);
    return { ok: true, trim, duration: end - start };
  });

  route('POST', '/api/projects/:id/trim/reset', (req, { params }) => {
    const g = idleWithVideo(params.id);
    if (!g.config.untrimmedVideo) return { ok: true, trim: null };
    restore(g, 'Cut undone: the whole video is kept');
    return { ok: true, trim: null };
  });
}
