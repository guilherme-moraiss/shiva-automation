import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, now, getSettings, setSetting, getGroups, SECRET_KEYS, ROOT, MEDIA_DIR } from './db.js';
import { parseHandles, scrapeCreator } from './scrapers/index.js';
import { ytDlpPath } from './scrapers/util.js';
import { startScan, currentJob, cancelJob, startScheduler } from './jobs.js';
import { ensureVideo, sendFile } from './media.js';
import { route, routes, json, readBody, int, HttpError } from './http.js';
import { registerPipelineRoutes } from './pipeline/routes.js';
import { startPipelineWorker } from './pipeline/runner.js';
import { registerStudioRoutes, startStudioWorker } from './pipeline/studio.js';
import { registerSpicyRoutes, startSpicyWorker } from './pipeline/spicy.js';
import { registerReviewRoutes, startReviewWorker, reviewPending } from './review.js';
import { registerProjectRoutes, projectCounts } from './projects.js';
import { registerProfileRoutes } from './profiles.js';
import { registerApprovalRoutes, approvalPending } from './approval.js';
import { registerAgendaRoutes } from './agenda.js';
import { registerCostRoutes } from './costs.js';
import { registerLaunchRoutes } from './launch.js';
import { registerFaceRoutes, startFaceWorker } from './faces.js';
import { registerCarouselRoutes } from './carousels.js';
import { registerDiscoverRoutes } from './discover.js';
import { registerStatusRoutes } from './status.js';
import { registerTeamRoutes, workerOf, beforeAction, afterAction } from './team.js'; // last: it adds columns to the job tables above

/** Read-only demo (the Vercel deployment): browse everything, change or generate nothing, start no worker. */
const DEMO = process.env.SHIVA_DEMO === '1';

const PORT = Number(process.env.PORT) || 4747;
/** On a public host, APP_PASSWORD puts the whole app behind the browser's login box (any user name, this password). */
const PASSWORD = process.env.APP_PASSWORD || '';
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req) {
  if (!PASSWORD) return true;
  const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return crypto.timingSafeEqual(digest(pass), digest(PASSWORD));
}
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---- stats ----------------------------------------------------------------------
const freshCutoff = () => now() - (Number(getSettings().fresh_days) || 3) * 86400;

route('GET', '/api/stats', () => {
  const cutoff = freshCutoff();
  const byPlatform = db.prepare('SELECT platform, COUNT(*) n FROM creators WHERE tracked = 1 GROUP BY platform').all();
  return {
    trackedCreators: db.prepare('SELECT COUNT(*) n FROM creators WHERE tracked = 1').get().n,
    reviewPending: reviewPending(),
    projectsTodo: projectCounts().todo,
    approvalPending: approvalPending(),
    postsDue: db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?").get(now() + 30 * 60).n,
    postedRecently: db.prepare('SELECT COUNT(DISTINCT creator_id) n FROM reels WHERE posted_at >= ?').get(cutoff).n,
    freshReels: db.prepare('SELECT COUNT(*) n FROM reels WHERE posted_at >= ? AND hidden = 0').get(cutoff).n,
    totalReels: db.prepare('SELECT COUNT(*) n FROM reels').get().n,
    queuedRemakes: db.prepare(`SELECT COUNT(*) n FROM remakes m WHERE (${REMAKE_STATE}) = 'queued'`).get().n,
    byPlatform: Object.fromEntries(byPlatform.map((r) => [r.platform, r.n])),
    freshDays: Number(getSettings().fresh_days) || 3,
  };
});

// ---- creators -------------------------------------------------------------------
route('GET', '/api/creators', (req, { query }) => {
  const cutoff = freshCutoff();
  const where = ['c.tracked = 1']; // creators only known from a reel sent for review are not listed
  const args = { cutoff };
  if (query.get('platform')) { where.push('c.platform = :platform'); args.platform = query.get('platform'); }
  if (query.get('group')) { where.push('c.group_name = :grp'); args.grp = query.get('group'); }
  if (query.get('q')) { where.push('(c.handle LIKE :q OR c.display_name LIKE :q)'); args.q = `%${query.get('q').replace(/^@/, '')}%`; }
  if (query.get('starred') === '1') where.push('c.starred = 1');
  const sortMap = {
    followers: 'c.followers DESC NULLS LAST', ftvr: 'best_ftvr DESC NULLS LAST', fresh: 'fresh DESC',
    latest: 'latest_reel DESC NULLS LAST', handle: 'c.handle ASC', checked: 'c.last_checked_at DESC NULLS LAST',
  };
  const order = sortMap[query.get('sort')] || 'c.starred DESC, latest_reel DESC NULLS LAST, c.created_at DESC';
  return db.prepare(`
    SELECT c.*,
      (SELECT MAX(CASE WHEN c.followers > 0 THEN r.views * 1.0 / c.followers END) FROM reels r WHERE r.creator_id = c.id) AS best_ftvr,
      (SELECT COUNT(*) FROM reels r WHERE r.creator_id = c.id AND r.posted_at >= :cutoff) AS fresh,
      (SELECT COUNT(*) FROM reels r WHERE r.creator_id = c.id) AS total,
      (SELECT MAX(posted_at) FROM reels r WHERE r.creator_id = c.id) AS latest_reel
    FROM creators c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}`).all(args);
});

route('POST', '/api/creators/import', async (req) => {
  const body = await readBody(req);
  const { handles, invalid } = parseHandles(body.text, body.platform === 'tiktok' ? 'tiktok' : 'instagram');
  const group = String(body.group || 'Watchlist').slice(0, 40);
  const groups = getGroups();
  if (!groups.includes(group)) setSetting('groups', JSON.stringify([...groups, group]));
  const ins = db.prepare(`INSERT INTO creators (platform, handle, group_name, starred, created_at) VALUES (?, ?, ?, ?, ?)
                          ON CONFLICT(platform, handle) DO NOTHING RETURNING id`);
  const regroup = db.prepare('UPDATE creators SET group_name = ?, starred = MAX(starred, ?) WHERE platform = ? AND handle = ?');
  // A creator only known from a reel the team sent becomes a tracked creator when she is added here.
  const adopt = db.prepare('UPDATE creators SET tracked = 1, group_name = ?, starred = MAX(starred, ?) WHERE platform = ? AND handle = ? AND tracked = 0 RETURNING id');
  let added = 0, existing = 0;
  const addedIds = [];
  const t = now();
  for (const h of handles) {
    const row = ins.get(h.platform, h.handle, group, body.starred ? 1 : 0, t) || adopt.get(group, body.starred ? 1 : 0, h.platform, h.handle);
    if (row) { added++; addedIds.push(row.id); }
    else { existing++; if (body.regroup) regroup.run(group, body.starred ? 1 : 0, h.platform, h.handle); }
  }
  // Re-importing a creator that never loaded (new / failed scan) scans her again too.
  const retry = handles.length ? db.prepare(`SELECT id FROM creators WHERE (${handles.map(() => '(platform = ? AND handle = ?)').join(' OR ')})
    AND (status IN ('new', 'error') OR last_checked_at IS NULL)`).all(...handles.flatMap((h) => [h.platform, h.handle])).map((r) => r.id) : [];
  const scanIds = [...new Set([...addedIds, ...retry])];
  let scan = null;
  if (body.scanNow && scanIds.length) scan = startScan(scanIds, { reason: 'import' });
  return { added, existing, invalid, scan };
});

route('PATCH', '/api/creators/:id', async (req, { params }) => {
  const body = await readBody(req);
  if (body.group !== undefined) {
    const g = String(body.group).slice(0, 40);
    const groups = getGroups();
    if (!groups.includes(g)) setSetting('groups', JSON.stringify([...groups, g]));
    db.prepare('UPDATE creators SET group_name = ? WHERE id = ?').run(g, params.id);
  }
  if (body.starred !== undefined) db.prepare('UPDATE creators SET starred = ? WHERE id = ?').run(body.starred ? 1 : 0, params.id);
  // Deixar de seguir: out of Criadoras and the scans. Her reels stay, and so do the projects made from them.
  if (body.tracked !== undefined) db.prepare('UPDATE creators SET tracked = ? WHERE id = ?').run(body.tracked ? 1 : 0, params.id);
  return db.prepare('SELECT * FROM creators WHERE id = ?').get(params.id);
});

// Her reels go with her (ON DELETE CASCADE), and with them every remake and project made from them, and their posts.
// Same rule as removing a model or a remake: never with posts published (their history) or still in the agenda.
// With projects only, the page asks first: a 409 with `force: true`, then ?force=1 once confirmed.
route('DELETE', '/api/creators/:id', (req, { params, query, res }) => {
  const c = db.prepare('SELECT id, handle FROM creators WHERE id = ?').get(params.id);
  if (!c) return { ok: true };
  const ofHerReels = 'JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id WHERE r.creator_id = ?';
  const p = db.prepare(`SELECT SUM(p.status = 'posted') posted, SUM(p.status = 'scheduled') scheduled
    FROM posts p JOIN generations g ON g.id = p.generation_id ${ofHerReels}`).get(c.id);
  if (p.posted) throw new HttpError(409, `The projects made from @${c.handle}'s reels already have ${p.posted} published post(s): unfollow her instead of removing her, so that history is not lost`);
  if (p.scheduled) throw new HttpError(409, `The projects made from @${c.handle}'s reels have ${p.scheduled} post(s) on the schedule: remove them in Scheduled or in the Calendar before removing her`);
  const g = db.prepare(`SELECT COUNT(*) n, SUM(g.video_path IS NOT NULL) vids FROM generations g ${ofHerReels}`).get(c.id);
  if (g.n && query.get('force') !== '1') {
    return json(res, 409, { force: true, error: `There are ${g.n} project(s) made from @${c.handle}'s reels (${g.vids} with video): removing her deletes them too. To keep them, unfollow her instead of removing her.` });
  }
  db.prepare('DELETE FROM creators WHERE id = ?').run(c.id);
  return { ok: true };
});

route('GET', '/api/groups', () => getGroups());

// ---- scanning -------------------------------------------------------------------
route('POST', '/api/scan', async (req) => {
  const body = await readBody(req);
  let ids = Array.isArray(body.creatorIds) ? body.creatorIds.map(Number).filter(Boolean) : null;
  if (!ids?.length && (body.platform || body.group || body.starred)) {
    const where = []; const args = [];
    if (body.platform) { where.push('platform = ?'); args.push(body.platform); }
    if (body.group) { where.push('group_name = ?'); args.push(body.group); }
    if (body.starred) where.push('starred = 1');
    where.push('tracked = 1');
    ids = db.prepare(`SELECT id FROM creators WHERE ${where.join(' AND ')}`).all(...args).map((r) => r.id);
    if (!ids.length) throw new HttpError(400, 'No creator matches that filter');
  }
  const r = startScan(ids, { full: !!body.full, reason: body.full ? 'full' : 'manual' });
  if (r.error) throw new HttpError(409, r.error);
  return r;
});
route('GET', '/api/job', () => ({ job: currentJob() }));
route('POST', '/api/job/cancel', () => { cancelJob(); return { job: currentJob() }; });

route('POST', '/api/test-scrape', async (req) => {
  const body = await readBody(req);
  const { handles } = parseHandles(body.handle, body.platform);
  if (!handles.length) throw new HttpError(400, 'Invalid handle');
  const { platform, handle } = handles[0];
  const started = Date.now();
  try {
    const r = await scrapeCreator(platform, handle, getSettings());
    return { ok: true, platform, handle, ms: Date.now() - started, profile: r.profile, note: r.note,
      reels: r.reels.length, sample: r.reels.slice(0, 3).map(({ url, views, likes, comments, postedAt }) => ({ url, views, likes, comments, postedAt })) };
  } catch (e) {
    return { ok: false, platform, handle, ms: Date.now() - started, code: e.code || 'error', error: e.message };
  }
});

// ---- reels ----------------------------------------------------------------------
const REEL_SORTS = {
  newest: 'r.posted_at DESC NULLS LAST',
  views: 'r.views DESC NULLS LAST',
  likes: 'r.likes DESC NULLS LAST',
  like_rate: 'like_rate DESC NULLS LAST',
  comments: 'r.comments DESC NULLS LAST',
  ftvr: 'ftvr DESC NULLS LAST',
  engagement: 'engagement DESC NULLS LAST',
};

route('GET', '/api/reels', (req, { query }) => {
  const where = ['r.hidden = 0', 'c.tracked = 1']; // reels kept from the team's review live in Revisão → Galeria
  const args = {};
  if (query.get('hidden') === '1') where[0] = 'r.hidden = 1';
  if (query.get('platform')) { where.push('r.platform = :platform'); args.platform = query.get('platform'); }
  if (query.get('type') === 'video') where.push("r.media_type = 'video'");
  if (query.get('type') === 'photo') where.push("r.media_type IN ('photo', 'carousel')");
  if (query.get('creator')) { where.push('r.creator_id = :creator'); args.creator = int(query.get('creator')); }
  if (query.get('group')) { where.push('c.group_name = :grp'); args.grp = query.get('group'); }
  if (query.get('fresh') === '1') { where.push('r.posted_at >= :cutoff'); args.cutoff = freshCutoff(); }
  if (query.get('days')) { where.push('r.posted_at >= :since'); args.since = now() - int(query.get('days'), 7) * 86400; }
  if (query.get('viral') === '1') where.push("c.followers > 0 AND (r.views > c.followers OR (r.media_type != 'video' AND (COALESCE(r.likes,0) + COALESCE(r.comments,0)) > c.followers * 0.1))");
  if (query.get('minViews')) { where.push('r.views >= :minViews'); args.minViews = int(query.get('minViews'), 0); }
  if (query.get('q')) { where.push('(c.handle LIKE :q OR r.caption LIKE :q)'); args.q = `%${query.get('q').replace(/^@/, '')}%`; }
  const order = REEL_SORTS[query.get('sort')] || REEL_SORTS.newest;
  const limit = Math.min(200, int(query.get('limit'), 60));
  const offset = int(query.get('offset'), 0);
  const base = `FROM reels r JOIN creators c ON c.id = r.creator_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(args).n;
  const items = db.prepare(`
    SELECT r.id, r.platform, r.external_id, r.shortcode, r.url, r.caption, r.posted_at, r.views, r.likes, r.comments, r.shares,
      r.duration, r.thumb_path, r.thumb_url, r.frame_path, r.video_path, r.hidden, r.first_seen_at, r.media_type, r.image_paths,
      CASE WHEN c.followers > 0 THEN (COALESCE(r.likes, 0) + COALESCE(r.comments, 0)) * 1.0 / c.followers END AS engagement,
      c.id AS creator_id, c.handle, c.display_name, c.followers, c.avatar_path, c.group_name, c.starred,
      CASE WHEN c.followers > 0 AND r.views IS NOT NULL THEN r.views * 1.0 / c.followers END AS ftvr,
      CASE WHEN r.views > 0 AND r.likes IS NOT NULL THEN r.likes * 1.0 / r.views END AS like_rate,
      (SELECT COUNT(*) FROM remakes m WHERE m.reel_id = r.id) AS remake_count
    ${base} ORDER BY ${order} LIMIT :limit OFFSET :offset`).all({ ...args, limit, offset });
  return { total, items, freshCutoff: freshCutoff() };
});

route('PATCH', '/api/reels/:id', async (req, { params }) => {
  const body = await readBody(req);
  if (body.hidden !== undefined) db.prepare('UPDATE reels SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, params.id);
  return { ok: true };
});

route('GET', '/api/reels/:id/history', (req, { params }) =>
  db.prepare('SELECT at, views, likes, comments FROM reel_snapshots WHERE reel_id = ? ORDER BY at').all(params.id));

// /api/reels/:id/video and /api/reels/:id/video/<name>.mp4 (the latter makes browsers save a proper .mp4)
const serveReelVideo = async (req, { params, query, res }) => {
  const reel = db.prepare('SELECT r.*, c.handle FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.id = ?').get(params.id);
  if (!reel) throw new HttpError(404, 'Reel not found');
  try {
    const rel = await ensureVideo(reel);
    sendFile(req, res, path.join(MEDIA_DIR, rel), {
      cache: 'private, max-age=86400', filename: `${reel.handle}_original_${reel.external_id}.mp4`, download: query.get('download') === '1',
    });
  } catch (e) {
    throw new HttpError(502, e.message);
  }
};
route('GET', '/api/reels/:id/video', serveReelVideo);
route('GET', '/api/reels/:id/video/:name', serveReelVideo);

// ---- remake queue (models live in pipeline/routes.js) ----------------------------------
// A remake's status is read from its latest project, so it can never go stale (e.g. "Em produção" with no project
// after the project was deleted). Only "Rejeitado" is set by hand, and a new project run overrides it.
const LAST_STAGE = '(SELECT g.stage FROM generations g WHERE g.remake_id = m.id ORDER BY g.id DESC LIMIT 1)';
const REMAKE_STATE = `CASE
    WHEN ${LAST_STAGE} IN ('queued', 'imaging', 'awaiting_approval', 'animating', 'review') THEN 'in_progress'
    WHEN ${LAST_STAGE} = 'approved' THEN 'done'
    WHEN m.status = 'rejected' OR (${LAST_STAGE} = 'rejected' AND m.status <> 'queued') THEN 'rejected'
    WHEN ${LAST_STAGE} = 'failed' THEN 'failed'
    ELSE 'queued' END`;
route('GET', '/api/remakes', (req, { query }) => {
  const where = []; const args = [];
  if (query.get('status')) { where.push(`(${REMAKE_STATE}) = ?`); args.push(query.get('status')); }
  if (query.get('model')) { where.push('m.model_id = ?'); args.push(int(query.get('model'))); }
  return db.prepare(`
    SELECT m.*, (${REMAKE_STATE}) AS status, m.status AS stored_status, md.name AS model_name, md.color AS model_color,
      r.platform, r.url, r.thumb_path, r.views, r.likes, r.caption, r.posted_at, c.handle, c.followers,
      (SELECT g.id FROM generations g WHERE g.remake_id = m.id ORDER BY g.id DESC LIMIT 1) AS gen_id,
      (SELECT g.stage FROM generations g WHERE g.remake_id = m.id ORDER BY g.id DESC LIMIT 1) AS gen_stage
    FROM remakes m JOIN reels r ON r.id = m.reel_id JOIN creators c ON c.id = r.creator_id
    LEFT JOIN models md ON md.id = m.model_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC`).all(...args);
});
route('POST', '/api/remakes', async (req) => {
  const b = await readBody(req);
  if (!b.reelId) throw new HttpError(400, 'reelId is required');
  const t = now();
  return db.prepare('INSERT INTO remakes (reel_id, model_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .get(b.reelId, b.modelId || null, String(b.prompt || '').slice(0, 2000), 'queued', t, t);
});
route('PATCH', '/api/remakes/:id', async (req, { params }) => {
  const b = await readBody(req);
  const status = ['queued', 'in_progress', 'done', 'rejected'].includes(b.status) ? b.status : null;
  db.prepare('UPDATE remakes SET status = COALESCE(?, status), prompt = COALESCE(?, prompt), updated_at = ? WHERE id = ?')
    .run(status, b.prompt ?? null, now(), params.id);
  if ('modelId' in b) db.prepare('UPDATE remakes SET model_id = ? WHERE id = ?').run(Number(b.modelId) || null, params.id); // null = "sem modelo"
  return { ok: true };
});
route('DELETE', '/api/remakes/:id', (req, { params }) => {
  // Its projects and their posts go with it (ON DELETE CASCADE): never while one is scheduled or already published.
  const n = db.prepare(`SELECT COUNT(*) n FROM posts p JOIN generations g ON g.id = p.generation_id
    WHERE g.remake_id = ? AND p.status IN ('scheduled', 'posted')`).get(params.id).n;
  if (n) throw new HttpError(409, 'This remake has scheduled or published posts: first remove the scheduled ones (Scheduled or Calendar). With published posts, the remake is kept, so the history is not lost.');
  db.prepare('DELETE FROM remakes WHERE id = ?').run(params.id);
  return { ok: true };
});

// ---- settings & health ------------------------------------------------------------
const SETTING_KEYS = ['fresh_days', 'max_reels_per_creator', 'concurrency', 'auto_scan_hours', 'instagram_provider',
  'tiktok_provider', 'instagram_cookie', 'apify_token',
  // pipeline
  'wavespeed_api_key', 'comfy_mode', 'comfy_url', 'comfy_api_key', 'auto_download_ftvr', 'video_engine', 'kling_mode', 'keep_original_sound', 'keep_outfit', 'first_frame_mode', 'gemini_api_key', 'image_engine', 'nb_model_comfy', 'nb_model_gemini', 'nb_resolution',
  'nb_variants', 'analysis_enabled', 'analysis_model', 'wan_model', 'wan_mode', 'wan_resolution', 'wan_duration', 'wan_audio',
  'wan_prompt_extend', 'auto_approve_image', 'pipeline_concurrency', 'fal_api_key', 'realism_finish',
  'rh_api_key', 'rh_site', 'rh_instance', 'rh_wf_wan_animate', 'rh_wf_nb_wan_animate', 'rh_wf_sky', 'rh_wf_sky_nsfw', 'rh_max_secs', 'frame_engine',
  'rh_wf_ttt_animator', 'rh_wf_animate_x', 'rh_wf_faceswap', 'rh_wf_instagirl', 'rh_wf_zimage', 'rh_wf_sdxl_zimage', 'rh_wf_sdxl_wan', 'rh_wf_detailing', 'rh_wf_inpaint'];

route('GET', '/api/settings', () => {
  const s = getSettings();
  const out = {};
  for (const k of SETTING_KEYS) out[k] = SECRET_KEYS.includes(k) ? '' : s[k];
  for (const k of SECRET_KEYS) out[`${k}_set`] = !!s[k];
  out.groups = getGroups();
  return out;
});
route('PUT', '/api/settings', async (req) => {
  const b = await readBody(req);
  for (const k of SETTING_KEYS) {
    if (b[k] === undefined) continue;
    if (SECRET_KEYS.includes(k) && b[k] === '' && !b[`clear_${k}`]) continue; // empty = keep existing secret
    // RunningHub workflows may be pasted as the page link: keep only the id.
    if (k.startsWith('rh_wf_')) { const v = String(b[k]).trim(); setSetting(k, v.match(/(\d{12,})/)?.[1] || v.replace(/\D/g, '')); continue; }
    setSetting(k, String(b[k]).trim());
  }
  for (const k of SECRET_KEYS) if (b[`clear_${k}`]) setSetting(k, '');
  if (Array.isArray(b.groups)) setSetting('groups', JSON.stringify([...new Set(b.groups.map((g) => String(g).trim()).filter(Boolean))]));
  return { ok: true };
});

// yt-dlp version, read in the background (the PyInstaller exe takes ~1.5 s to start on Windows).
// Never read it synchronously inside a request: that would freeze every other request and video stream.
let ytVersion = null;
let ytChecking = false;
function warmYt() {
  const bin = ytDlpPath();
  if (!bin || ytVersion || ytChecking) return;
  ytChecking = true;
  execFile(bin, ['--version'], { timeout: 15000, windowsHide: true }, (e, out) => {
    ytChecking = false;
    ytVersion = e ? '?' : String(out).trim() || '?';
  });
}
route('GET', '/api/health', () => {
  const bin = ytDlpPath();
  if (bin && !ytVersion) warmYt(); // e.g. installed with `npm run setup` after the server started
  const s = getSettings();
  return {
    ytdlp: bin ? { path: bin, version: ytVersion || '…' } : null,
    instagramCookie: !!s.instagram_cookie,
    apifyToken: !!s.apify_token,
    providers: { instagram: s.instagram_provider, tiktok: s.tiktok_provider },
    lastFullScanAt: Number(s.last_full_scan_at) || null,
    demo: DEMO,
  };
});

registerPipelineRoutes();
registerStudioRoutes();
registerSpicyRoutes();
registerReviewRoutes();
registerProjectRoutes();
registerProfileRoutes();
registerApprovalRoutes();
registerAgendaRoutes();
registerCostRoutes();
registerLaunchRoutes();
registerFaceRoutes();
registerCarouselRoutes();
registerDiscoverRoutes();
registerTeamRoutes();
registerStatusRoutes();

// ---- server -----------------------------------------------------------------------
const handler = async (req, res) => {
  try {
    // Inside the try: nothing awaits this async handler, so a throw here (`GET /%`, a malformed Host header)
    // would be an unhandled rejection and end the whole process.
    let url, p;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      p = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Invalid request');
    }
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); } // the host's health check
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SHIVA Automation", charset="UTF-8"', 'Content-Type': 'text/plain' });
      return res.end('Password required');
    }
    if (p.startsWith('/api/')) {
      if (DEMO && !['GET', 'HEAD'].includes(req.method)) return json(res, 403, { error: 'Read-only demo: nothing can be changed or generated here. Run the app locally to use it.' });
      if (DEMO) {
        // Videos are static files in the demo: a reel's or a project's video goes straight to its /media/ address.
        const mv = p.match(/^\/api\/(reels|generations)\/(\d+)\/video(?:\/|$)/);
        const row = mv && db.prepare(`SELECT video_path FROM ${mv[1]} WHERE id = ?`).get(Number(mv[2]));
        if (row?.video_path) { res.writeHead(302, { Location: `/media/${row.video_path}` }); return res.end(); }
      }
      req.worker = workerOf(req); // Equipa: who is working (the name picked in "A trabalhar como")
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const work = beforeAction(req, r, params);
        const out = await r.handler(req, { params, query: url.searchParams, res });
        if (work) afterAction(work, req, out);
        if (!res.headersSent && out !== undefined) json(res, 200, out);
        return;
      }
      return json(res, 404, { error: 'Route not found' });
    }
    if (p.startsWith('/media/')) {
      const abs = path.join(MEDIA_DIR, path.normalize(p.slice(7)).replace(/^(\.\.[/\\])+/, ''));
      if (!abs.startsWith(MEDIA_DIR)) { res.writeHead(403); return res.end(); }
      return sendFile(req, res, abs, { cache: 'public, max-age=604800' });
    }
    const file = path.join(PUBLIC_DIR, path.normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'Internal error' });
    if (!e.status) console.error(e);
  }
};

// Listen on BOTH loopbacks: on Windows "localhost" resolves to ::1 first, and a browser whose IPv6 connect is
// refused only falls back to IPv4 after ~300 ms, on every new connection. Loopback only: not exposed to the LAN.
// Long keep-alive, so connections are reused between clicks instead of being reopened.
const hosts = DEMO ? [] : process.env.HOST ? [HOST] : ['127.0.0.1', '::1']; // the demo runs inside a Vercel function: no server of its own
let announced = false;
for (const h of hosts) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('error', (e) => {
    if (h === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code)) return; // machine without IPv6
    console.error(e);
    process.exit(1);
  });
  server.listen(PORT, h, () => {
    if (announced) return;
    announced = true;
    const shown = ['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost'].includes(h) ? 'localhost' : h.includes(':') ? `[${h}]` : h;
    console.log(`\n  SHIVA Automation running at http://${shown}:${PORT}\n`);
    if (!ytDlpPath()) console.log('  Warning: yt-dlp not found. Run `npm run setup` so the TikTok scraper works.\n');
    warmYt();
  });
}
if (!DEMO) {
  startScheduler();
  startPipelineWorker();
  startStudioWorker();
  startSpicyWorker();
  startReviewWorker();
  startFaceWorker();
}

/** The request handler, for the Vercel function (api/index.js). */
export { handler };
