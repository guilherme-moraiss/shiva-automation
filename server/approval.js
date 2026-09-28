import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, setSetting, MEDIA_DIR } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { getGeneration, setStage, log, isBusy } from './pipeline/runner.js';
import { PLATFORMS, randomCaption } from './profiles.js';
import { learn, unlearn, STEP } from './signals.js';

export const reelOfGeneration = (id) => db.prepare('SELECT m.reel_id FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE g.id = ?').get(id)?.reel_id ?? null;

/**
 * Aprovação: finished videos one at a time. Normal = posted on every chosen account of the model at the same time;
 * Trial = a trial reel on her Instagram accounts that take them; Saltar = back of the queue; Rejeitar = out.
 * Each decision becomes one row in `posts` per account, at the account's next free slot:
 *   · at least `gap` hours from any other post of the same kind on that account (normal and trial are spaced apart
 *     separately), earlier holes in the agenda are filled first;
 *   · plus 3–12 random minutes, fixed per project and account, so the preview shows exactly the time that is used;
 *   · Normal on several accounts goes out at one common time (the earliest that fits all of them).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('normal', 'trial')),
  caption TEXT NOT NULL DEFAULT '',
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  video_path TEXT,
  created_at INTEGER NOT NULL,
  posted_at INTEGER
);
CREATE INDEX IF NOT EXISTS posts_account_time ON posts(account_id, scheduled_at);
CREATE INDEX IF NOT EXISTS posts_generation ON posts(generation_id);
`);

const HOUR = 3600;
const LEAD = 10 * 60; // the first slot is never sooner than 10 minutes from now
const TZS = ['Europe/Lisbon', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo'];
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const exists = (rel) => !!rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));

export function schedSettings(s = getSettings()) {
  const gap = (v) => (Number(v) === 3 ? 3 : 2);
  return { normalGap: gap(s.sched_normal_gap), trialGap: gap(s.sched_trial_gap), tz: TZS.includes(s.sched_tz) ? s.sched_tz : 'Europe/Lisbon', tzs: TZS };
}

/** 3–12 minutes, always the same for this project, account and kind. */
function jitter(genId, accountId, kind) {
  const h = crypto.createHash('sha1').update(`${genId}:${accountId}:${kind}`).digest();
  return 180 + (h.readUInt32BE(0) % 541);
}

/** Times already taken on an account for this kind of post (scheduled or published), oldest first. */
const busyTimes = (accountId, kind, excludeGen = -1) => db.prepare(`SELECT scheduled_at FROM posts
  WHERE account_id = ? AND kind = ? AND status IN ('scheduled', 'posted') AND generation_id != ? ORDER BY scheduled_at`).all(accountId, kind, excludeGen).map((r) => r.scheduled_at);
const fits = (t, busy, gap) => busy.every((b) => Math.abs(b - t) >= gap);

/** The earliest time ≥ from that keeps `gap` from every busy time (holes first), with the jitter when it still fits. */
function earliest(from, busy, gap, jit) {
  const cands = [from, ...busy.map((b) => b + gap)].filter((t) => t >= from).sort((a, b) => a - b);
  for (const t of cands) {
    if (!fits(t, busy, gap)) continue;
    const tj = t + jit;
    const at = fits(tj, busy, gap) ? tj : t;
    return { at, hole: busy.some((b) => b > at) };
  }
  return { at: from, hole: false };
}

/** Accounts of this project's model that a decision can post to. */
function projectAccounts(genId) {
  const row = db.prepare('SELECT m.model_id FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE g.id = ?').get(genId);
  if (!row?.model_id) return [];
  return db.prepare('SELECT * FROM accounts WHERE model_id = ? ORDER BY position, id').all(row.model_id);
}

/** Networks that take a photo / carousel post (a YouTube channel does not). */
export const PHOTO_PLATFORMS = ['instagram', 'tiktok', 'x'];

/**
 * Where and when each post of a decision goes. `accountIds`: the chips switched on (default: every active account).
 * Trial only goes to Instagram accounts that take trial reels; photo projects only to PHOTO_PLATFORMS. `at`: an exact
 * time typed by hand (no spacing applied).
 */

export function plan({ genId, kind, accountIds = null, at = null }) {
  const s = schedSettings();
  const photos = db.prepare('SELECT kind FROM generations WHERE id = ?').get(genId)?.kind !== 'video';
  if (photos && kind === 'trial') return []; // Trial is a reels thing
  const gap = (kind === 'trial' ? s.trialGap : s.normalGap) * HOUR;
  const all = projectAccounts(genId).filter((a) => a.active);
  // Chips switched on may include other models' accounts ("Outras contas"): any active account can be chosen.
  let list = accountIds ? db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY position, id').all().filter((a) => accountIds.includes(a.id)) : all;
  if (kind === 'trial') list = list.filter((a) => a.platform === 'instagram' && a.trial);
  if (photos) list = list.filter((a) => PHOTO_PLATFORMS.includes(a.platform));
  if (at) return list.map((a) => ({ account: a, at, solo: null, hole: false, override: true, conflict: !fits(at, busyTimes(a.id, kind, genId), gap) }));
  const from = now() + LEAD;
  const each = list.map((a) => {
    const busy = busyTimes(a.id, kind, genId);
    return { a, busy, ...earliest(from, busy, gap, jitter(genId, a.id, kind)) };
  });
  if (kind === 'trial' || each.length <= 1) return each.map((x) => ({ account: x.a, at: x.at, solo: null, hole: x.hole }));
  // Normal on several accounts: one common time, the earliest that fits every one of them.
  let T = Math.max(...each.map((x) => x.at));
  for (let i = 0; i < 50; i++) {
    const clash = each.find((x) => !fits(T, x.busy, gap));
    if (!clash) break;
    T = earliest(T, clash.busy, gap, 0).at;
  }
  // `solo`: when this account alone would have gone out at another minute (shown as "sozinha seria …").
  return each.map((x) => ({ account: x.a, at: T, solo: Math.abs(x.at - T) >= 60 ? x.at : null, hole: x.busy.some((b) => b > T) }));
}

const planJson = (p) => p.map((x) => ({ accountId: x.account.id, platform: x.account.platform, handle: x.account.handle, at: x.at, solo: x.solo, hole: x.hole, override: !!x.override, conflict: !!x.conflict }));

// ---- the queue --------------------------------------------------------------------------------------------------
const QUEUE_WHERE = "g.archived = 0 AND g.publish IS NULL AND g.stage IN ('review', 'approved') AND ((g.kind = 'video' AND g.video_path IS NOT NULL) OR (g.kind IN ('photo', 'poses') AND g.candidates IS NOT NULL AND g.candidates != '[]'))";

/** A photo project's images that exist, and the default choice: the first version of each slide, in slide order. */
function photoSet(candidatesJson) {
  let list = [];
  try { list = JSON.parse(candidatesJson || '[]'); } catch {}
  const all = list.filter((c) => exists(c.path)).map((c) => ({ path: c.path, slide: c.slide ?? null, pose: c.pose || null, label: c.label || '' }));
  const bySlide = new Map();
  for (const c of all) if (c.slide != null && !bySlide.has(c.slide)) bySlide.set(c.slide, c.path);
  const media = bySlide.size ? [...bySlide.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p) : all.slice(0, 10).map((c) => c.path);
  return { all, media: media.slice(0, 20) };
}
const QUEUE_FROM = `FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id
  JOIN creators c ON c.id = r.creator_id LEFT JOIN models md ON md.id = m.model_id`;

// Who scheduled each post (the name in "A trabalhar como"); older posts get it once from the Equipa log.
// Photo posts: the images that go, in order (JSON array of media paths); video posts keep video_path.
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'media')) db.exec('ALTER TABLE posts ADD COLUMN media TEXT');
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'worker_id')) {
  db.exec('ALTER TABLE posts ADD COLUMN worker_id INTEGER');
  try {
    db.exec(`UPDATE posts SET worker_id = (SELECT a.worker_id FROM activity a WHERE a.generation_id = posts.generation_id AND a.action IN ('normal', 'trial', 'to_trial')
      AND a.undone = 0 AND a.at <= posts.created_at + 5 ORDER BY a.at DESC LIMIT 1)`);
  } catch { /* no Equipa log yet */ }
}
const WORKER_NAME = (col) => `(SELECT name FROM workers WHERE id = ${col})`;

export function approvalPending() {
  return db.prepare(`SELECT COUNT(*) n ${QUEUE_FROM} WHERE ${QUEUE_WHERE}`).get().n;
}

function queue(modelId, workerId = null) {
  const rows = db.prepare(`SELECT g.id, g.kind, g.candidates, g.stage, g.video_path, g.chosen_image, g.qa, g.config, g.cost_usd, g.created_at, g.updated_at, g.skipped_at,
      g.worker_id, ${WORKER_NAME('g.worker_id')} AS worker_name,
      m.model_id, md.name AS model_name, md.color AS model_color, r.id AS reel_id, r.url, r.platform, r.caption AS reel_caption, r.views, c.handle
    ${QUEUE_FROM} WHERE ${QUEUE_WHERE} ${modelId ? 'AND m.model_id = ?' : ''} ${workerId === 0 ? 'AND g.worker_id IS NULL' : workerId ? 'AND g.worker_id = ?' : ''}
    ORDER BY (g.skipped_at IS NOT NULL), g.skipped_at, g.updated_at, g.id LIMIT 500`).all(...(modelId ? [modelId] : []), ...(workerId ? [workerId] : []));
  return rows.filter((r) => (r.kind === 'video' ? exists(r.video_path) : photoSet(r.candidates).all.length > 0)).map(({ config, qa, candidates, ...r }) => {
    const photos = r.kind === 'video' ? null : photoSet(candidates);
    const cfg = parse(config, {});
    return { ...r, qa: parse(qa, null), engine: r.kind === 'video' ? cfg.videoEngine || null : null, trimmed: !!cfg.trim, photos: photos?.all || null, media: photos?.media || null };
  });
}

export function registerApprovalRoutes() {
  route('GET', '/api/approval/queue', (req, { query }) => {
    const modelId = int(query.get('model'));
    const w = query.get('worker');
    const workerId = w === '0' ? 0 : int(w);
    const byModel = db.prepare(`SELECT m.model_id AS id, md.name, COUNT(*) n ${QUEUE_FROM} WHERE ${QUEUE_WHERE} GROUP BY m.model_id ORDER BY md.name`).all();
    const byWorker = db.prepare(`SELECT g.worker_id AS id, ${WORKER_NAME('g.worker_id')} AS name, COUNT(*) n ${QUEUE_FROM} WHERE ${QUEUE_WHERE} ${modelId ? 'AND m.model_id = ?' : ''} GROUP BY g.worker_id ORDER BY n DESC`).all(...(modelId ? [modelId] : []));
    return { items: queue(modelId, workerId), byModel, byWorker, total: byModel.reduce((a, x) => a + x.n, 0), settings: schedSettings() };
  });

  // What one project needs on screen: its model's accounts and a caption from her pool.
  route('GET', '/api/approval/:id/context', (req, { params, query }) => {
    const g = getGeneration(Number(params.id));
    if (!g) throw new HttpError(404, 'Project not found');
    const accounts = projectAccounts(g.id);
    const row = db.prepare('SELECT m.model_id FROM remakes m WHERE m.id = ?').get(g.remake_id);
    const cap = row?.model_id ? randomCaption(row.model_id, int(query.get('exclude'))) : null;
    // The other models' active accounts, offered folded and not chosen (reference: POST TO lists every profile).
    const others = db.prepare('SELECT a.*, md.name AS model_name FROM accounts a JOIN models md ON md.id = a.model_id WHERE a.active = 1 AND a.model_id != ? ORDER BY md.name, a.position, a.id').all(row?.model_id ?? 0);
    return { accounts, others, caption: cap ? { id: cap.id, text: cap.text } : null, platforms: PLATFORMS };
  });

  // "Se escolheres Normal / Trial": the exact times each choice would use right now.
  route('POST', '/api/approval/:id/preview', async (req, { params }) => {
    const b = await readBody(req);
    const id = Number(params.id);
    if (!getGeneration(id)) throw new HttpError(404, 'Project not found');
    const accountIds = Array.isArray(b.accounts) ? b.accounts.map(Number) : null;
    const at = int(b.at);
    return { normal: planJson(plan({ genId: id, kind: 'normal', accountIds, at })), trial: planJson(plan({ genId: id, kind: 'trial', accountIds, at })), settings: schedSettings() };
  });

  route('POST', '/api/approval/:id/decide', async (req, { params }) => {
    const b = await readBody(req);
    const g = getGeneration(Number(params.id));
    if (!g) throw new HttpError(404, 'Project not found');
    const isPhoto = g.kind !== 'video';
    if (!isPhoto && !exists(g.video_path)) throw new HttpError(400, 'This project has no video');
    // Photo posts: the images chosen (in order), else the first version of each slide.
    const set = isPhoto ? photoSet(JSON.stringify(g.candidates)) : null;
    const media = isPhoto ? (Array.isArray(b.media) && b.media.length ? [...new Set(b.media.map(String))].filter((p) => set.all.some((c) => c.path === p)).slice(0, 20) : set.media) : null;
    if (isPhoto && !media.length) throw new HttpError(400, 'This project has no photos to post');
    if (isPhoto && b.action === 'trial') throw new HttpError(400, 'Trial is only for reels: choose Normal');
    if (g.publish) throw new HttpError(409, 'This project has already been scheduled');
    if (!['review', 'approved'].includes(g.stage)) throw new HttpError(409, 'This project is no longer waiting for approval');
    // The Topaz or a new enlargement is working on it: the video may still change.
    if (isBusy(g.id) && b.action !== 'skip') throw new HttpError(409, 'This project is busy (Topaz or enlargement): wait for it to finish');
    const prev = { stage: g.stage, skipped_at: g.skipped_at ?? null };
    const keepPrev = () => db.prepare('UPDATE generations SET config = ? WHERE id = ?').run(JSON.stringify({ ...g.config, approvalPrev: prev }), g.id);
    const action = String(b.action || '');
    if (action === 'skip') {
      keepPrev();
      db.prepare('UPDATE generations SET skipped_at = ? WHERE id = ?').run(now(), g.id);
      return { ok: true, action };
    }
    if (action === 'reject') {
      keepPrev();
      setStage(g.id, 'rejected');
      return { ok: true, action };
    }
    if (!['normal', 'trial'].includes(action)) throw new HttpError(400, 'Invalid choice');
    const accountIds = Array.isArray(b.accounts) ? b.accounts.map(Number) : null;
    const at = int(b.at);
    if (at && at < now() - 60) throw new HttpError(400, 'The chosen time has already passed');
    const p = plan({ genId: g.id, kind: action, accountIds, at });
    if (!p.length) {
      throw new HttpError(400, action === 'trial'
        ? 'None of the chosen accounts is an Instagram account with Trial on. Turn on Trial for an account in Profiles.'
        : "No active account chosen. Add the model's accounts in Profiles.");
    }
    if (isPhoto && media.length > 4 && p.some((x) => x.account.platform === 'x')) throw new HttpError(400, `X accepts at most 4 photos per post (you chose ${media.length}): choose up to 4 photos or remove the X account`);
    const caption = String(b.caption ?? '').trim().slice(0, 2200);
    const t = now();
    const ins = db.prepare('INSERT INTO posts (generation_id, account_id, kind, caption, scheduled_at, status, video_path, created_at, worker_id, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id');
    db.exec('BEGIN');
    try {
      for (const x of p) ins.get(g.id, x.account.id, action, caption, x.at, 'scheduled', isPhoto ? null : g.video_path, t, req.worker?.id ?? null, isPhoto ? JSON.stringify(media) : null);
      db.prepare('UPDATE generations SET publish = ?, config = ? WHERE id = ?').run(action, JSON.stringify({ ...g.config, approvalPrev: prev }), g.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (g.stage === 'review') setStage(g.id, 'approved');
    if (action === 'normal') learn(`normal:${g.id}`, reelOfGeneration(g.id), STEP.normal); // Sinais de treino
    const tz = schedSettings().tz;
    const when = (x) => new Date(x.at * 1000).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    log(g.id, `Scheduled (${action === 'trial' ? 'Trial' : 'Normal'}): ${p.map((x) => `${PLATFORMS[x.account.platform]} @${x.account.handle} ${when(x)}`).join('; ')}`);
    return { ok: true, action, posts: planJson(p) };
  });

  // Undo the last decision on this project (only while none of its posts went out).
  route('POST', '/api/approval/:id/undo', (req, { params }) => {
    const g = getGeneration(Number(params.id));
    if (!g) throw new HttpError(404, 'Project not found');
    const prev = g.config.approvalPrev;
    if (!prev) throw new HttpError(400, 'Nothing to undo on this project');
    const cfg = { ...g.config };
    delete cfg.approvalPrev;
    if (g.publish) {
      const out = db.prepare("SELECT COUNT(*) n FROM posts WHERE generation_id = ? AND status != 'scheduled'").get(g.id).n;
      if (out) throw new HttpError(409, 'One of the posts has already gone out: this cannot be undone');
      db.prepare('DELETE FROM posts WHERE generation_id = ?').run(g.id);
      db.prepare('UPDATE generations SET publish = NULL, stage = ?, config = ? WHERE id = ?').run(prev.stage, JSON.stringify(cfg), g.id);
      unlearn(`normal:${g.id}`);
      log(g.id, 'Scheduling undone: back to Approval');
    } else if (g.stage === 'rejected') {
      db.prepare('UPDATE generations SET stage = ?, config = ? WHERE id = ?').run(prev.stage, JSON.stringify(cfg), g.id);
      log(g.id, 'Rejection undone: back to Approval');
    } else {
      db.prepare('UPDATE generations SET skipped_at = ?, config = ? WHERE id = ?').run(prev.skipped_at, JSON.stringify(cfg), g.id);
    }
    return { ok: true };
  });

  route('GET', '/api/approval/settings', () => schedSettings());
  route('PUT', '/api/approval/settings', async (req) => {
    const b = await readBody(req);
    if (b.normalGap !== undefined) setSetting('sched_normal_gap', Number(b.normalGap) === 3 ? '3' : '2');
    if (b.trialGap !== undefined) setSetting('sched_trial_gap', Number(b.trialGap) === 3 ? '3' : '2');
    if (b.tz !== undefined) {
      if (!TZS.includes(b.tz)) throw new HttpError(400, 'Invalid time zone');
      setSetting('sched_tz', b.tz);
    }
    return schedSettings();
  });

  // The agenda between two times (Aprovação's day view and the Calendário), with what each post is.
  route('GET', '/api/schedule', (req, { query }) => {
    const from = int(query.get('from'), now() - 86400);
    const to = int(query.get('to'), from + 86400);
    const modelId = int(query.get('model'));
    const rows = db.prepare(`SELECT p.*, a.platform, a.handle, a.label, a.model_id, md.name AS model_name, COALESCE(g.chosen_image, json_extract(p.media, '$[0]')) AS chosen_image
      FROM posts p JOIN accounts a ON a.id = p.account_id LEFT JOIN models md ON md.id = a.model_id JOIN generations g ON g.id = p.generation_id
      WHERE p.scheduled_at >= ? AND p.scheduled_at < ? AND p.status != 'pulled' ${modelId ? 'AND a.model_id = ?' : ''} ORDER BY p.scheduled_at`).all(from, to, ...(modelId ? [modelId] : []));
    // Active accounts, plus switched-off ones that still have posts that day (so they can be seen and moved).
    const withPosts = [...new Set(rows.map((p) => p.account_id))];
    const accounts = db.prepare(`SELECT a.*, md.name AS model_name FROM accounts a LEFT JOIN models md ON md.id = a.model_id
      WHERE (a.active = 1${withPosts.length ? ` OR a.id IN (${withPosts.map(() => '?').join(',')})` : ''}) ${modelId ? 'AND a.model_id = ?' : ''} ORDER BY md.name, a.position, a.id`)
      .all(...withPosts, ...(modelId ? [modelId] : []));
    // Models with no active account yet: drawn as an empty column that links to Perfis (the day is still shown).
    const noAccounts = db.prepare(`SELECT md.id, md.name, md.color FROM models md
      WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.model_id = md.id AND a.active = 1) ${modelId ? 'AND md.id = ?' : ''} ORDER BY md.name`).all(...(modelId ? [modelId] : []));
    return { from, to, posts: rows, accounts, noAccounts, settings: schedSettings() };
  });

  // A project's posts (project page).
  route('GET', '/api/projects/:id/posts', (req, { params }) => db.prepare(`SELECT p.*, a.platform, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id
    WHERE p.generation_id = ? ORDER BY p.scheduled_at, a.position`).all(params.id));
}
