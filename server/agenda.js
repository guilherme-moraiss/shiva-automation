import fs from 'node:fs';
import path from 'node:path';
import { db, now, MEDIA_DIR } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { getGeneration, log } from './pipeline/runner.js';
import { plan, schedSettings } from './approval.js';
import { unlearn } from './signals.js';
import { PLATFORMS } from './profiles.js';
import { sendFile } from './media.js';

/**
 * What happens after Aprovação:
 *   Agendados  — the scheduled videos checked once more before they go out: Manter, Retirar (all its posts come off
 *                and the video goes back to Aprovação), Mudar para Trial, Saltar.
 *   Calendário — every post by account and hour: move it (drag), change its time or caption, take it off one account.
 *   A publicar — posts whose time has come. No posting service is connected yet, so the team posts them by hand
 *                (video + caption here) and marks them as published.
 */
const exists = (rel) => !!rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x';

const postsOf = (genId) => db.prepare(`SELECT p.*, a.platform, a.handle, a.label FROM posts p JOIN accounts a ON a.id = p.account_id
  WHERE p.generation_id = ? AND p.status != 'pulled' ORDER BY p.scheduled_at, a.position, a.id`).all(genId);

/** Takes a project off the agenda (its posts that did not go out yet) and puts it back in Aprovação. */
function pullProject(g, why) {
  const out = db.prepare("SELECT COUNT(*) n FROM posts WHERE generation_id = ? AND status = 'posted'").get(g.id).n;
  if (out) throw new HttpError(409, "One of this video's posts has already gone out: remove the others in the Calendar, one account at a time");
  db.prepare("DELETE FROM posts WHERE generation_id = ? AND status = 'scheduled'").run(g.id);
  const cfg = { ...g.config };
  delete cfg.approvalPrev;
  db.prepare('UPDATE generations SET publish = NULL, kept_at = NULL, skipped_at = NULL, config = ? WHERE id = ?').run(JSON.stringify(cfg), g.id);
  unlearn(`normal:${g.id}`); // taken off the agenda: its Normal no longer counts as a good sign
  log(g.id, why);
}

/** After one of its posts is taken off: with nothing left scheduled or published, the video goes back to Aprovação. */
export function settle(genId) {
  const left = db.prepare("SELECT COUNT(*) n FROM posts WHERE generation_id = ? AND status IN ('scheduled', 'posted')").get(genId).n;
  if (!left) {
    db.prepare('UPDATE generations SET publish = NULL, kept_at = NULL WHERE id = ?').run(genId);
    unlearn(`normal:${genId}`); // back in Aprovação: its Normal no longer counts (same as pullProject)
    log(genId, 'No posts left on the schedule: back to Approval');
  }
}

const SCHED_FROM = `FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id
  JOIN creators c ON c.id = r.creator_id LEFT JOIN models md ON md.id = m.model_id`;
// Still to go out: scheduled, with at least one post in the future.
const SCHED_WHERE = `g.publish IS NOT NULL AND g.archived = 0 AND EXISTS (SELECT 1 FROM posts p WHERE p.generation_id = g.id AND p.status = 'scheduled' AND p.scheduled_at > ?)`;

export function registerAgendaRoutes() {
  // ---- Agendados ----
  route('GET', '/api/scheduled/queue', (req, { query }) => {
    const t = now();
    const modelId = int(query.get('model'));
    const kind = ['normal', 'trial'].includes(query.get('kind')) ? query.get('kind') : '';
    const extra = `${modelId ? ' AND m.model_id = ?' : ''}${kind ? ' AND g.publish = ?' : ''}`;
    const args = [t, ...(modelId ? [modelId] : []), ...(kind ? [kind] : [])];
    const rows = db.prepare(`SELECT g.id, g.kind, g.publish, g.video_path, g.kept_at, g.config, m.model_id, md.name AS model_name, md.color AS model_color,
        r.url, r.platform, r.caption AS reel_caption, c.handle, (SELECT name FROM workers WHERE id = g.worker_id) AS worker_name,
        (SELECT w.name FROM posts p JOIN workers w ON w.id = p.worker_id WHERE p.generation_id = g.id ORDER BY p.id DESC LIMIT 1) AS scheduled_by, (SELECT MIN(p.scheduled_at) FROM posts p WHERE p.generation_id = g.id AND p.status = 'scheduled') AS next_at
      ${SCHED_FROM} WHERE ${SCHED_WHERE}${extra} ORDER BY (g.kept_at IS NOT NULL), next_at LIMIT 500`).all(...args);
    const counts = db.prepare(`SELECT g.publish AS kind, COUNT(*) n, SUM(CASE WHEN g.kept_at IS NOT NULL THEN 1 ELSE 0 END) kept ${SCHED_FROM}
      WHERE ${SCHED_WHERE}${modelId ? ' AND m.model_id = ?' : ''} GROUP BY g.publish`).all(t, ...(modelId ? [modelId] : []));
    const byModel = db.prepare(`SELECT m.model_id AS id, md.name, COUNT(*) n ${SCHED_FROM} WHERE ${SCHED_WHERE} GROUP BY m.model_id ORDER BY md.name`).all(t);
    return {
      items: rows.map(({ config, ...r }) => {
        const posts = postsOf(r.id);
        let media = null; // photo posts: their images (the first post's list)
        if (r.kind !== 'video') { try { media = JSON.parse(posts.find((p) => p.media)?.media || 'null'); } catch { media = null; } }
        return { ...r, trimmed: !!parse(config, {}).trim, posts, media: Array.isArray(media) ? media.filter(exists) : null };
      }).filter((r) => (r.kind === 'video' ? exists(r.video_path) : r.media?.length)),
      counts: { normal: counts.find((c) => c.kind === 'normal')?.n || 0, trial: counts.find((c) => c.kind === 'trial')?.n || 0, kept: counts.reduce((a, c) => a + (c.kept || 0), 0) },
      byModel,
      settings: schedSettings(),
    };
  });

  route('POST', '/api/scheduled/:id/keep', async (req, { params }) => {
    const b = await readBody(req);
    const g = getGeneration(Number(params.id));
    if (!g?.publish) throw new HttpError(404, 'This project is not scheduled');
    db.prepare('UPDATE generations SET kept_at = ? WHERE id = ?').run(b.undo ? null : now(), g.id);
    return { ok: true };
  });

  route('POST', '/api/scheduled/:id/pull', (req, { params }) => {
    const g = getGeneration(Number(params.id));
    if (!g?.publish) throw new HttpError(404, 'This project is not scheduled');
    pullProject(g, 'Taken off the schedule in Scheduled: back to Approval');
    return { ok: true };
  });

  // Normal → Trial: its normal posts come off and a trial reel goes to her Instagram accounts that take them.
  route('POST', '/api/scheduled/:id/to-trial', (req, { params }) => {
    const g = getGeneration(Number(params.id));
    if (!g?.publish) throw new HttpError(404, 'This project is not scheduled');
    if (g.publish === 'trial') throw new HttpError(409, 'It is already Trial');
    if (g.kind !== 'video') throw new HttpError(400, 'Trial is only for reels: this is a photo post');
    if (db.prepare("SELECT COUNT(*) n FROM posts WHERE generation_id = ? AND status = 'posted'").get(g.id).n) throw new HttpError(409, 'One of the posts has already gone out: it cannot be switched to Trial');
    const caption = db.prepare("SELECT caption FROM posts WHERE generation_id = ? AND status = 'scheduled' ORDER BY id LIMIT 1").get(g.id)?.caption || '';
    const p = plan({ genId: g.id, kind: 'trial' }); // every active Instagram account of hers that takes trial reels
    if (!p.length) throw new HttpError(400, 'This model has no Instagram account with Trial on (turn it on in Profiles)');
    const ins = db.prepare("INSERT INTO posts (generation_id, account_id, kind, caption, scheduled_at, status, video_path, created_at, worker_id) VALUES (?, ?, 'trial', ?, ?, 'scheduled', ?, ?, ?)");
    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM posts WHERE generation_id = ? AND status = 'scheduled'").run(g.id);
      for (const x of p) ins.run(g.id, x.account.id, caption, x.at, g.video_path, now(), req.worker?.id ?? null);
      db.prepare("UPDATE generations SET publish = 'trial', kept_at = NULL WHERE id = ?").run(g.id);
      unlearn(`normal:${g.id}`); // no longer Normal: a Trial teaches nothing
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log(g.id, `Switched to Trial: ${p.map((x) => `Instagram @${x.account.handle}`).join(', ')}`);
    return { ok: true, posts: p.map((x) => ({ accountId: x.account.id, handle: x.account.handle, at: x.at })) };
  });

  // ---- one post (Calendário) ----
  const getPost = (id) => {
    const p = db.prepare('SELECT p.*, a.platform, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?').get(id);
    if (!p) throw new HttpError(404, 'Post not found');
    return p;
  };

  route('PATCH', '/api/posts/:id', async (req, { params }) => {
    const b = await readBody(req);
    const p = getPost(params.id);
    if (p.status !== 'scheduled') throw new HttpError(409, 'Only posts that have not gone out yet can be changed');
    let at = p.scheduled_at;
    if (b.scheduled_at !== undefined) {
      at = int(b.scheduled_at);
      if (!at || at < now() - 60) throw new HttpError(400, 'Choose a time that has not passed yet');
    }
    const caption = b.caption !== undefined ? String(b.caption).trim().slice(0, 2200) : p.caption;
    db.prepare('UPDATE posts SET scheduled_at = ?, caption = ? WHERE id = ?').run(at, caption, p.id);
    if (at !== p.scheduled_at) log(p.generation_id, `${PLATFORMS[p.platform]} @${p.handle}: post rescheduled`);
    // How close it now is to the other posts of that account (the Calendário warns, it never refuses).
    const gap = (p.kind === 'trial' ? schedSettings().trialGap : schedSettings().normalGap) * 3600;
    const near = db.prepare("SELECT COUNT(*) n FROM posts WHERE account_id = ? AND kind = ? AND id != ? AND status IN ('scheduled','posted') AND ABS(scheduled_at - ?) < ?").get(p.account_id, p.kind, p.id, at, gap).n;
    return { ...getPost(p.id), tooClose: near > 0 };
  });

  route('DELETE', '/api/posts/:id', (req, { params }) => {
    const p = getPost(params.id);
    if (p.status === 'posted') throw new HttpError(409, 'This post has already gone out');
    db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
    log(p.generation_id, `${PLATFORMS[p.platform]} @${p.handle}: post taken off the schedule`);
    settle(p.generation_id);
    return { ok: true };
  });

  route('POST', '/api/posts/:id/posted', async (req, { params }) => {
    const b = await readBody(req);
    const p = getPost(params.id);
    if (b.undo) {
      db.prepare("UPDATE posts SET status = 'scheduled', posted_at = NULL WHERE id = ?").run(p.id);
      log(p.generation_id, `${PLATFORMS[p.platform]} @${p.handle}: marked as not posted again`);
    } else {
      db.prepare("UPDATE posts SET status = 'posted', posted_at = ? WHERE id = ?").run(now(), p.id);
      log(p.generation_id, `${PLATFORMS[p.platform]} @${p.handle}: posted`);
    }
    return getPost(p.id);
  });

  // Posts whose time has come (or passes within the next `soon` minutes), oldest first.
  route('GET', '/api/posts/due', (req, { query }) => {
    const soon = Math.max(0, Math.min(24 * 60, int(query.get('soon'), 30)));
    const modelId = int(query.get('model'));
    return db.prepare(`SELECT p.*, a.platform, a.handle, a.label, a.model_id, md.name AS model_name, g.chosen_image
      FROM posts p JOIN accounts a ON a.id = p.account_id LEFT JOIN models md ON md.id = a.model_id JOIN generations g ON g.id = p.generation_id
      WHERE p.status = 'scheduled' AND p.scheduled_at <= ? ${modelId ? 'AND a.model_id = ?' : ''} ORDER BY p.scheduled_at LIMIT 200`).all(now() + soon * 60, ...(modelId ? [modelId] : []));
  });

  // A photo post's image i, named for the account, time and position (what the team uploads by hand).
  route('GET', '/api/posts/:id/photo/:i', (req, { params, res }) => {
    const p = db.prepare(`SELECT p.*, a.platform, a.handle, md.name AS model_name FROM posts p JOIN accounts a ON a.id = p.account_id
      LEFT JOIN models md ON md.id = a.model_id WHERE p.id = ?`).get(params.id);
    if (!p) throw new HttpError(404, 'Post not found');
    let list = [];
    try { list = JSON.parse(p.media || '[]'); } catch {}
    const i = int(params.i);
    const rel = list[i];
    if (!exists(rel)) throw new HttpError(404, 'This photo no longer exists');
    const d = new Date(p.scheduled_at * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    sendFile(req, res, path.join(MEDIA_DIR, rel), { filename: `${slug(p.model_name)}_${p.platform}_${slug(p.handle)}_${d}_${p.generation_id}_${i + 1}${path.extname(rel)}`, download: true });
  });

  // The video of one post, named for the account and time (what the team uploads by hand).
  route('GET', '/api/posts/:id/video', (req, { params, res }) => {
    const p = db.prepare(`SELECT p.*, a.platform, a.handle, md.name AS model_name FROM posts p JOIN accounts a ON a.id = p.account_id
      LEFT JOIN models md ON md.id = a.model_id WHERE p.id = ?`).get(params.id);
    if (!p) throw new HttpError(404, 'Post not found');
    const g = getGeneration(p.generation_id);
    const rel = exists(p.video_path) ? p.video_path : g?.video_path;
    if (!exists(rel)) throw new HttpError(404, "This post's video no longer exists");
    const d = new Date(p.scheduled_at * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    sendFile(req, res, path.join(MEDIA_DIR, rel), { filename: `${slug(p.model_name)}_${p.platform}_${slug(p.handle)}_${d}_${p.generation_id}.mp4`, download: true });
  });
}
