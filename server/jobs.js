import path from 'node:path';
import fs from 'node:fs';
import { db, now, getSettings, setSetting, MEDIA_DIR } from './db.js';
import { scrapeCreator } from './scrapers/index.js';
import { downloadFile, jitter } from './scrapers/util.js';
import { queueDownload } from './media.js';

/**
 * One scan job at a time. A scan walks the selected creators with limited concurrency,
 * upserts their reels, stores metric snapshots and caches thumbnails locally
 * (Instagram/TikTok CDN URLs expire and block hotlinking).
 */

let job = null;
const log = (msg) => {
  if (!job) return;
  job.log.push({ at: Date.now(), msg });
  if (job.log.length > 200) job.log.shift();
};

export function currentJob() {
  if (!job) return null;
  const { cancel, ...rest } = job;
  return rest;
}

export function cancelJob() {
  if (job && job.state === 'running') {
    job.cancelRequested = true;
    log('Cancel requested…');
  }
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

const upsertReel = db.prepare(`
  INSERT INTO reels (creator_id, platform, external_id, shortcode, url, caption, posted_at, views, likes, comments, shares,
                     duration, thumb_url, video_url, media_type, image_urls, first_seen_at, updated_at)
  VALUES (:creator_id, :platform, :external_id, :shortcode, :url, :caption, :posted_at, :views, :likes, :comments, :shares,
          :duration, :thumb_url, :video_url, :media_type, :image_urls, :t, :t)
  ON CONFLICT(platform, external_id) DO UPDATE SET
    creator_id = excluded.creator_id,
    shortcode = COALESCE(excluded.shortcode, shortcode),
    url = COALESCE(excluded.url, url),
    caption = excluded.caption,
    posted_at = COALESCE(excluded.posted_at, posted_at),
    views = COALESCE(excluded.views, views),
    likes = COALESCE(excluded.likes, likes),
    comments = COALESCE(excluded.comments, comments),
    shares = COALESCE(excluded.shares, shares),
    duration = COALESCE(excluded.duration, duration),
    thumb_url = COALESCE(excluded.thumb_url, thumb_url),
    video_url = COALESCE(excluded.video_url, video_url),
    media_type = excluded.media_type,
    image_urls = CASE WHEN excluded.image_urls != '[]' THEN excluded.image_urls ELSE image_urls END,
    updated_at = excluded.updated_at
  RETURNING id, thumb_path, first_seen_at, image_paths`);

const insertReelSnap = db.prepare('INSERT INTO reel_snapshots (reel_id, at, views, likes, comments) VALUES (?, ?, ?, ?, ?)');
const insertCreatorSnap = db.prepare('INSERT INTO creator_snapshots (creator_id, at, followers) VALUES (?, ?, ?)');
const setThumb = db.prepare('UPDATE reels SET thumb_path = ? WHERE id = ?');

// Background thumbnail queue (used by full-history imports, which can bring thousands of posts).
const thumbQueue = [];
let thumbActive = 0;
function queueThumb(task) {
  thumbQueue.push(task);
  pumpThumbs();
}
function pumpThumbs() {
  while (thumbActive < 6 && thumbQueue.length) {
    const { url, rel, id } = thumbQueue.shift();
    thumbActive++;
    (fs.existsSync(path.join(MEDIA_DIR, rel)) ? Promise.resolve(true) : downloadFile(url, path.join(MEDIA_DIR, rel)))
      .then((ok) => { if (ok) setThumb.run(rel, id); })
      .catch(() => {})
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}
export const thumbQueueSize = () => thumbQueue.length + thumbActive;

export async function scanOne(creator, settings, { full = false, limit = null, photosOnly = false } = {}) {
  const t = now();
  if (full) log(`@${creator.handle}: importing the full history (this may take a few minutes)…`);
  const result = await scrapeCreator(creator.platform, creator.handle, settings, { full, limit, photosOnly });
  const { profile, reels } = result;

  let avatarPath = creator.avatar_path;
  if (profile.avatarUrl && !avatarPath) {
    const rel = `avatars/${creator.platform}_${safe(creator.handle)}.jpg`;
    if (await downloadFile(profile.avatarUrl, path.join(MEDIA_DIR, rel))) avatarPath = rel;
  }

  db.prepare(`UPDATE creators SET display_name = ?, followers = COALESCE(?, followers), avatar_path = ?, platform_user_id = COALESCE(?, platform_user_id),
              sec_uid = COALESCE(?, sec_uid), status = ?, last_error = ?, last_checked_at = ? WHERE id = ?`)
    .run(profile.displayName, profile.followers, avatarPath, profile.platformUserId, profile.secUid,
      result.note ? 'private' : 'ok', result.note || null, t, creator.id);
  if (profile.followers != null) insertCreatorSnap.run(creator.id, t, profile.followers);

  // (a) All rows in ONE transaction, with no await inside: the connection is shared by the whole server,
  //     so a transaction must never stay open across an await.
  let fresh = 0;
  const slideJobs = []; // photo posts whose slides still have to be cached
  const thumbJobs = []; // reels without a local thumbnail
  db.exec('BEGIN');
  try {
    for (const r of reels) {
      const row = upsertReel.get({
        creator_id: creator.id, platform: creator.platform, external_id: r.externalId, shortcode: r.shortcode ?? null,
        url: r.url ?? null, caption: r.caption ?? '', posted_at: r.postedAt ?? null, views: r.views ?? null, likes: r.likes ?? null,
        comments: r.comments ?? null, shares: r.shares ?? null, duration: r.duration ?? null, thumb_url: r.thumbUrl ?? null,
        video_url: r.videoUrl ?? null, media_type: r.mediaType || 'video', image_urls: JSON.stringify(r.images || []), t,
      });
      if (row.first_seen_at === t) fresh++;
      insertReelSnap.run(row.id, t, r.views ?? null, r.likes ?? null, r.comments ?? null);
      let cached = [];
      try { cached = JSON.parse(row.image_paths || '[]'); } catch {}
      if (r.images?.length && cached.length < r.images.length) slideJobs.push({ id: row.id, externalId: r.externalId, images: r.images });
      if (!row.thumb_path && r.thumbUrl) thumbJobs.push({ id: row.id, url: r.thumbUrl, rel: `thumbs/${creator.platform}_${safe(r.externalId)}.jpg` });
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  // (b) Downloads, outside the transaction. Thumbnails first (what the grid shows).
  for (const th of thumbJobs) {
    if (reels.length > 60) { queueThumb(th); continue; } // big import: don't block the scan
    const ok = fs.existsSync(path.join(MEDIA_DIR, th.rel)) || (await downloadFile(th.url, path.join(MEDIA_DIR, th.rel)));
    if (ok) setThumb.run(th.rel, th.id);
  }
  // Photo posts: cache every slide now (CDN links expire in a few days).
  const headers = creator.platform === 'instagram' ? { Referer: 'https://www.instagram.com/' } : {};
  // Up to 20 slides (Instagram's carousel limit). Many posts (a whole profile in Carrosséis): cached in the
  // background so the scan answers at once.
  const cacheSlides = async (s) => {
    const paths = [];
    for (const [i, u] of s.images.slice(0, 20).entries()) {
      const rel = `posts/${creator.platform}_${safe(s.externalId)}_${i}.jpg`;
      const ok = fs.existsSync(path.join(MEDIA_DIR, rel)) || (await downloadFile(u, path.join(MEDIA_DIR, rel), headers));
      if (ok) paths.push(rel);
    }
    db.prepare('UPDATE reels SET image_paths = ? WHERE id = ?').run(JSON.stringify(paths), s.id);
  };
  if (slideJobs.length > 20) slideQueue.push(...slideJobs.map((s) => () => cacheSlides(s))), runSlideQueue();
  else for (const s of slideJobs) await cacheSlides(s);
  // Auto-download the reels that broke out of the creator's bubble, so they're ready to remake.
  const threshold = Number(settings.auto_download_ftvr) || 0;
  if (threshold > 0 && profile.followers) {
    const viral = db.prepare("SELECT * FROM reels WHERE creator_id = ? AND media_type = 'video' AND video_path IS NULL AND hidden = 0 AND views >= ?").all(creator.id, Math.ceil(profile.followers * threshold));
    viral.forEach(queueDownload);
    if (viral.length) log(`${viral.length} viral reel(s) from @${creator.handle} downloading to the Library`);
  }
  return { reels: reels.length, fresh, followers: profile.followers, note: result.note };
}

// Slide downloads of big photo scans, one at a time in the background.
const slideQueue = [];
let slideRunning = false;
async function runSlideQueue() {
  if (slideRunning) return;
  slideRunning = true;
  try { while (slideQueue.length) { try { await slideQueue.shift()(); } catch { /* next */ } } } finally { slideRunning = false; }
}

// Creator ids waiting for the running scan to finish (e.g. imported mid-scan).
const pendingIds = new Set();

export function startScan(creatorIds = null, { reason = 'manual', full = false } = {}) {
  if (job && job.state === 'running') {
    if (creatorIds?.length) {
      creatorIds.forEach((id) => pendingIds.add(Number(id)));
      log(`${creatorIds.length} creator(s) waiting — they start when this scan finishes`);
      return { queued: true, job: currentJob() };
    }
    return { error: 'A scan is already running', job: currentJob() };
  }
  const creators = creatorIds?.length
    ? db.prepare(`SELECT * FROM creators WHERE id IN (${creatorIds.map(() => '?').join(',')})`).all(...creatorIds)
    : db.prepare('SELECT * FROM creators WHERE tracked = 1 ORDER BY starred DESC, last_checked_at ASC NULLS FIRST').all();
  if (!creators.length) return { error: 'No creators to check' };

  job = {
    id: Date.now(), reason, state: 'running', startedAt: Date.now(), finishedAt: null,
    total: creators.length, done: 0, ok: 0, failed: 0, newReels: 0, current: [], log: [], cancelRequested: false,
  };
  const settings = getSettings();
  const concurrency = Math.max(1, Math.min(6, Number(settings.concurrency) || 2));
  const queue = [...creators];
  let igBlocked = 0;
  log(`Scan started: ${creators.length} creators, concurrency ${concurrency}`);

  const worker = async () => {
    while (queue.length && !job.cancelRequested) {
      const c = queue.shift();
      if (c.platform === 'instagram' && igBlocked >= 3) {
        job.done++; job.failed++;
        db.prepare("UPDATE creators SET status = 'error', last_error = ? WHERE id = ?").run('Skipped: Instagram blocked requests in this scan', c.id);
        continue;
      }
      const label = `${c.platform === 'instagram' ? 'IG' : 'TT'} @${c.handle}`;
      job.current.push(label);
      try {
        const r = await scanOne(c, settings, { full });
        job.ok++; job.newReels += r.fresh;
        if (c.platform === 'instagram') igBlocked = 0;
        log(`${label}: ${r.reels} posts (${r.fresh} new)${r.note ? ` — ${r.note}` : ''}${thumbQueueSize() ? ` · ${thumbQueueSize()} thumbnails downloading in the background` : ''}`);
      } catch (e) {
        job.failed++;
        if (c.platform === 'instagram' && ['rate_limited', 'auth_required'].includes(e.code)) igBlocked++;
        db.prepare('UPDATE creators SET status = ?, last_error = ?, last_checked_at = ? WHERE id = ?')
          .run(e.code === 'not_found' ? 'not_found' : 'error', e.message, now(), c.id);
        log(`Error on ${label}: ${e.message}`);
        if (igBlocked === 3) log('Instagram blocked 3 times in a row — the remaining IG accounts in this scan were skipped.');
      } finally {
        job.done++;
        job.current = job.current.filter((x) => x !== label);
      }
      // Be gentle with the platforms.
      await jitter(c.platform === 'instagram' ? 2500 : 800, c.platform === 'instagram' ? 6000 : 2000);
    }
  };

  Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
    job.state = job.cancelRequested ? 'cancelled' : 'done';
    job.finishedAt = Date.now();
    if (!creatorIds?.length) setSetting('last_full_scan_at', now());
    log(`Scan finished: ${job.ok} ok, ${job.failed} failed, ${job.newReels} new reels`);
    if (pendingIds.size && !job.cancelRequested) {
      const ids = [...pendingIds];
      pendingIds.clear();
      setTimeout(() => startScan(ids, { reason: 'queued' }), 500);
    }
  });
  return { job: currentJob() };
}

/** Auto-scan loop: runs a full scan every `auto_scan_hours` (0 = off). */
/** Creators that were imported but never scanned (e.g. the app closed mid-scan). */
function scanNeverChecked() {
  if (job && job.state === 'running') return false;
  const ids = db.prepare('SELECT id FROM creators WHERE tracked = 1 AND last_checked_at IS NULL').all().map((r) => r.id);
  if (!ids.length) return false;
  startScan(ids, { reason: 'new' });
  return true;
}

export function startScheduler() {
  setTimeout(scanNeverChecked, 3000).unref();
  setInterval(() => {
    if (scanNeverChecked()) return;
    const s = getSettings();
    const hours = Number(s.auto_scan_hours) || 0;
    if (!hours || (job && job.state === 'running')) return;
    if (now() - (Number(s.last_full_scan_at) || 0) >= hours * 3600) startScan(null, { reason: 'auto' });
  }, 60_000).unref();
}
