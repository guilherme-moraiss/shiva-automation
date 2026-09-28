import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, MEDIA_DIR } from './db.js';
import { route, readBody, HttpError } from './http.js';
import { runYtDlp, downloadFile } from './scrapers/util.js';
import { ffmpegPath, probe, extractFrame } from './ffmpeg.js';
import { ensureVideo } from './media.js';
import { learn, unlearn, unbump, STEP } from './signals.js';

/**
 * Revisão: the team sends reel links, the owner watches them one by one and decides:
 *   Keep → the reel goes to the Galeria, ready to be remade with her AI model (it becomes a normal app reel, so
 *          "Criar remake" works on it). Its creator is recorded as not tracked: never scanned, not in Criadoras.
 *   Push → not approved. Kept in the history (so the same reel is not sent twice); its video is deleted a day later.
 * Links are resolved in the background: the app's own copy when the reel is already known, else metadata and video
 * with yt-dlp (Instagram with the session cookie of Definições).
 */

db.exec(`
CREATE TABLE IF NOT EXISTS review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  platform TEXT NOT NULL,
  ref TEXT NOT NULL,                        -- TikTok video id / Instagram shortcode / short link until resolved
  external_id TEXT,
  handle TEXT,
  display_name TEXT,
  caption TEXT,
  views INTEGER, likes INTEGER, comments INTEGER,
  duration REAL,
  posted_at INTEGER,
  thumb_path TEXT,
  video_path TEXT,
  submitted_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing', -- processing | pending | keep | push | error | duplicate
  error TEXT,
  reel_id INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_items_ref ON review_items(platform, ref);
CREATE INDEX IF NOT EXISTS review_items_status ON review_items(status, created_at);
`);

const THUMB_DIR = 'review';
fs.mkdirSync(path.join(MEDIA_DIR, THUMB_DIR), { recursive: true });

const getItem = (id) => db.prepare('SELECT * FROM review_items WHERE id = ?').get(id);
function upd(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE review_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
}
const exists = (rel) => !!rel && fs.existsSync(path.join(MEDIA_DIR, rel));

/**
 * Reel links in pasted text → [{ platform, ref, url, handle? , short? }], plus what could not be read.
 *   TikTok     tiktok.com/@user/video/<id>  ·  vm.tiktok.com/<code> / vt.tiktok.com/<code> / tiktok.com/t/<code>
 *   Instagram  instagram.com/reel/<code>  ·  /reels/<code>  ·  /p/<code>  ·  /tv/<code>  (optionally after /<user>/)
 */
export function parseReelLinks(text) {
  const out = [];
  const invalid = [];
  const seen = new Set();
  for (let token of String(text || '').split(/[\s,;]+/)) {
    token = token.trim().replace(/^<|>$/g, '');
    if (!token) continue;
    const t = token.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)/i, '');
    let item = null;
    let m;
    if ((m = t.match(/^tiktok\.com\/@([\w.]+)\/(?:video|photo)\/(\d+)/i))) {
      item = { platform: 'tiktok', ref: m[2], handle: m[1].toLowerCase(), url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}` };
    } else if ((m = t.match(/^(?:vm|vt)\.tiktok\.com\/([\w-]+)/i)) || (m = t.match(/^tiktok\.com\/t\/([\w-]+)/i))) {
      item = { platform: 'tiktok', ref: `short:${m[1]}`, short: true, url: `https://${t.split(/[?#]/)[0].replace(/\/$/, '')}/` };
    } else if ((m = t.match(/^instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/([\w-]+)/i))) {
      item = { platform: 'instagram', ref: m[1], url: `https://www.instagram.com/reel/${m[1]}/` };
    }
    if (!item) { invalid.push(token); continue; }
    const key = `${item.platform}:${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return { links: out, invalid };
}

/** The reel already in the app (from a tracked creator or an earlier Keep), if any. */
function knownReel(platform, ref) {
  return platform === 'instagram'
    ? db.prepare("SELECT r.*, c.handle, c.display_name FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.platform = 'instagram' AND (r.shortcode = ? OR r.external_id = ?)").get(ref, ref)
    : db.prepare("SELECT r.*, c.handle, c.display_name FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.platform = 'tiktok' AND r.external_id = ?").get(ref);
}

const cleanHandle = (v) => {
  const h = String(v || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(h) && !/^\d+$/.test(h) ? h : '';
};

/** Explain a yt-dlp failure in plain Portuguese (the original reason is kept). */
function explainFailure(item, e) {
  const msg = String(e?.message || e || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (item.platform === 'instagram' && /login|log in|rate-limit|not available|cookies|private/i.test(msg)) {
    return `Instagram did not allow reading this reel without a session. Paste the session cookie in Settings → Instagram and press "Try again". (${msg})`;
  }
  if (/private|unavailable|removed|not exist|404/i.test(msg)) return `The reel is no longer available or is private. (${msg})`;
  return `Could not get this reel: ${msg || 'unknown error'}`;
}

/** A reel link's metadata read with yt-dlp (nothing downloaded yet), normalised. */
async function fetchLinkInfo(link) {
  const args = ['-J', '--no-warnings', '--no-playlist'];
  const cookie = getSettings().instagram_cookie?.trim();
  if (link.platform === 'instagram' && cookie) args.push('--add-header', `Cookie:${cookie.includes('=') ? cookie : `sessionid=${cookie}`}`);
  args.push(link.url);
  const { out } = await runYtDlp(args, { timeoutMs: 120000 });
  let info;
  try { info = JSON.parse(out); } catch { throw new Error('unreadable yt-dlp response'); }
  const externalId = String(info.id || link.ref);
  const handle = cleanHandle(link.handle) || cleanHandle(info.uploader_id) || cleanHandle(info.channel) || cleanHandle(info.uploader) || 'desconhecida';
  return {
    externalId, handle, display_name: String(info.channel || info.uploader || '').slice(0, 80) || null,
    url: link.platform === 'tiktok' && handle !== 'desconhecida' ? `https://www.tiktok.com/@${handle}/video/${externalId}` : link.url,
    caption: String(info.description || info.title || '').slice(0, 2200) || null,
    views: Number.isFinite(info.view_count) ? info.view_count : null, likes: Number.isFinite(info.like_count) ? info.like_count : null,
    comments: Number.isFinite(info.comment_count) ? info.comment_count : null, duration: Number(info.duration) || null,
    posted_at: Number(info.timestamp) || null, thumbnail: info.thumbnail || null,
  };
}

/** Cover picture of a reel from its link metadata (saved under `dir`), or null. */
async function saveCover(platform, info, dir) {
  if (!info.thumbnail) return null;
  const rel = `${dir}/${platform}_${info.externalId.replace(/[^\w.-]/g, '_')}.jpg`;
  return (await downloadFile(info.thumbnail, path.join(MEDIA_DIR, rel), platform === 'instagram' ? { Referer: 'https://www.instagram.com/' } : {})) ? rel : null;
}

/** Link → metadata, video and cover on disk, ready to review. */
async function processItem(item) {
  const known = !item.short && knownReel(item.platform, item.ref);
  if (known) {
    const video = await ensureVideo(known);
    upd(item.id, {
      status: 'pending', error: null, reel_id: known.id, external_id: known.external_id, handle: known.handle, display_name: known.display_name,
      caption: known.caption, views: known.views, likes: known.likes, comments: known.comments, duration: known.duration, posted_at: known.posted_at,
      thumb_path: exists(known.thumb_path) ? known.thumb_path : null, video_path: video,
    });
    if (!exists(known.thumb_path)) await coverFromVideo(item.id, video);
    return;
  }
  const info = await fetchLinkInfo(item);
  // A short TikTok link can point at a reel that was already sent: the older entry wins.
  const twin = db.prepare('SELECT id, status FROM review_items WHERE platform = ? AND external_id = ? AND id != ?').get(item.platform, info.externalId, item.id);
  if (twin) {
    upd(item.id, { status: 'duplicate', error: `This reel was already sent (#${twin.id})`, external_id: info.externalId });
    return;
  }
  upd(item.id, {
    external_id: info.externalId, handle: info.handle, display_name: info.display_name, url: info.url, caption: info.caption,
    views: info.views, likes: info.likes, comments: info.comments, duration: info.duration, posted_at: info.posted_at,
  });
  // Same file name the app uses for its own reels (a later Keep or scan reuses it).
  const video = await ensureVideo({ id: `review:${item.id}`, platform: item.platform, external_id: info.externalId, url: info.url, video_path: null });
  const thumb = await saveCover(item.platform, info, THUMB_DIR);
  let duration = info.duration;
  if (!duration && ffmpegPath()) duration = (await probe(path.join(MEDIA_DIR, video)).catch(() => ({}))).duration || null;
  upd(item.id, { status: 'pending', error: null, video_path: video, thumb_path: thumb, duration });
  if (!thumb) await coverFromVideo(item.id, video);
}

async function coverFromVideo(id, video) {
  if (!ffmpegPath() || !exists(video)) return;
  try {
    const rel = `${THUMB_DIR}/item_${id}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, rel), await extractFrame(path.join(MEDIA_DIR, video), 0.5));
    upd(id, { thumb_path: rel });
  } catch { /* the review still works without a cover */ }
}

// ---- background worker: 2 links at a time -------------------------------------------------------------------------
const busy = new Set();
function tick() {
  const rows = db.prepare("SELECT * FROM review_items WHERE status = 'processing' ORDER BY id LIMIT 10").all();
  for (const it of rows) {
    if (busy.size >= 2) break;
    if (busy.has(it.id)) continue;
    busy.add(it.id);
    processItem(it)
      .catch((e) => { if (getItem(it.id)) upd(it.id, { status: 'error', error: explainFailure(it, e) }); })
      .finally(() => { busy.delete(it.id); setTimeout(tick, 50); });
  }
}

/** Videos of reels not approved more than a day ago are deleted (the entry stays, so they are not sent again). */
function cleanup() {
  const old = db.prepare("SELECT * FROM review_items WHERE status IN ('push', 'duplicate') AND decided_at < ? AND video_path IS NOT NULL").all(now() - 86400);
  for (const it of old) {
    const usedByReel = db.prepare('SELECT 1 FROM reels WHERE video_path = ?').get(it.video_path);
    if (!usedByReel) fs.rmSync(path.join(MEDIA_DIR, it.video_path), { force: true });
    if (it.thumb_path?.startsWith(`${THUMB_DIR}/`)) fs.rmSync(path.join(MEDIA_DIR, it.thumb_path), { force: true });
    upd(it.id, { video_path: null, thumb_path: it.thumb_path?.startsWith(`${THUMB_DIR}/`) ? null : it.thumb_path });
  }
}

export function startReviewWorker() {
  setInterval(tick, 3000).unref();
  setInterval(cleanup, 3600e3).unref();
  setTimeout(tick, 1000);
  setTimeout(cleanup, 60e3);
}

/**
 * A reel that did not come from a scan becomes an app reel (so "Criar remake" works on it). Its creator is added as
 * not tracked: she never enters the scans or the Criadoras list (a creator already tracked stays tracked).
 */
function upsertReel(r, group) {
  const t = now();
  const handle = r.handle || 'desconhecida';
  db.prepare(`INSERT INTO creators (platform, handle, display_name, group_name, tracked, created_at) VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(platform, handle) DO NOTHING`).run(r.platform, handle, r.display_name || null, group, t);
  const creator = db.prepare('SELECT id FROM creators WHERE platform = ? AND handle = ?').get(r.platform, handle);
  return db.prepare(`INSERT INTO reels (creator_id, platform, external_id, shortcode, url, caption, posted_at, views, likes, comments, duration,
      thumb_path, video_path, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, external_id) DO UPDATE SET video_path = COALESCE(reels.video_path, excluded.video_path),
      thumb_path = COALESCE(reels.thumb_path, excluded.thumb_path), updated_at = excluded.updated_at
    RETURNING id`).get(
    creator.id, r.platform, r.external_id, r.shortcode || null, r.url, r.caption || null, r.posted_at || t, r.views ?? null, r.likes ?? null, r.comments ?? null,
    r.duration || null, r.thumb_path || null, r.video_path || null, t, t,
  ).id;
}

/** Keep: the reviewed reel goes to the Galeria as an app reel. */
function keepToReel(it) {
  if (it.reel_id && db.prepare('SELECT 1 FROM reels WHERE id = ?').get(it.reel_id)) return it.reel_id;
  return upsertReel({ ...it, external_id: it.external_id || it.ref, shortcode: it.platform === 'instagram' ? it.ref : null }, 'Enviados pela equipa');
}

/**
 * "Novo projeto" (Projetos page): any TikTok / Instagram reel link → an app reel with its video downloaded, ready for
 * "Criar remake". A reel the app already has is reused. → { reelId, known }
 */
export async function importReelFromLink(text) {
  const { links, invalid } = parseReelLinks(text);
  if (!links.length) {
    throw new HttpError(400, invalid.length ? 'This link is not a TikTok or Instagram reel (e.g. tiktok.com/@…/video/… or instagram.com/reel/…)' : 'Paste a reel link');
  }
  const link = links[0];
  let reel = !link.short && knownReel(link.platform, link.ref);
  let info = null;
  if (!reel) {
    try { info = await fetchLinkInfo(link); } catch (e) { throw new HttpError(502, explainFailure(link, e)); }
    reel = knownReel(link.platform, info.externalId); // a short link can point at a reel the app has
  }
  const known = !!reel;
  if (!reel) {
    const id = upsertReel({
      ...info, platform: link.platform, external_id: info.externalId, shortcode: link.platform === 'instagram' ? link.ref : null,
      thumb_path: await saveCover(link.platform, info, 'thumbs'),
    }, 'Adicionados por link');
    reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  }
  try { await ensureVideo(reel); } catch (e) { throw new HttpError(502, explainFailure(link, e)); }
  return { reelId: reel.id, known };
}

/** A reel the app already has, straight into the Galeria (Descoberta "Guardar"). → review item id */
export function galleryFromReel(reelId, by = 'Descoberta') {
  const r = db.prepare('SELECT r.*, c.handle, c.display_name FROM reels r JOIN creators c ON c.id = r.creator_id WHERE r.id = ?').get(reelId);
  if (!r) throw new HttpError(404, 'Reel not found');
  const ref = r.platform === 'instagram' ? r.shortcode || r.external_id : r.external_id;
  const t = now();
  const prev = db.prepare('SELECT * FROM review_items WHERE platform = ? AND (ref = ? OR external_id = ?)').get(r.platform, ref, r.external_id);
  if (prev) {
    upd(prev.id, { status: 'keep', reel_id: r.id, decided_at: t, video_path: prev.video_path || r.video_path });
    return { id: prev.id, created: false };
  }
  const row = db.prepare(`INSERT INTO review_items (url, platform, ref, external_id, handle, display_name, caption, views, likes, comments, duration, posted_at,
      thumb_path, video_path, submitted_by, status, reel_id, created_at, decided_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'keep', ?, ?, ?, ?) RETURNING id`)
    .get(r.url, r.platform, ref, r.external_id, r.handle, r.display_name, r.caption, r.views, r.likes, r.comments, r.duration, r.posted_at, r.thumb_path, r.video_path, by, r.id, t, t, t);
  return { id: row.id, created: true };
}

/** Undo of galleryFromReel: an item it created is removed; one that existed before goes back to what it was. */
export function galleryUndo({ id, created, prevStatus = 'pending' }) {
  if (created) db.prepare('DELETE FROM review_items WHERE id = ?').run(id);
  else upd(id, { status: prevStatus, decided_at: null });
}

const counts = () => {
  const c = { processing: 0, pending: 0, keep: 0, push: 0, error: 0, duplicate: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM review_items GROUP BY status').all()) c[r.status] = r.n;
  return c;
};
export const reviewPending = () => db.prepare("SELECT COUNT(*) n FROM review_items WHERE status = 'pending'").get().n;

const ITEM_SELECT = `SELECT ri.*,
    (SELECT COUNT(*) FROM remakes m WHERE m.reel_id = ri.reel_id) AS remakes,
    (SELECT COUNT(*) FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE m.reel_id = ri.reel_id AND g.stage = 'approved') AS approved
  FROM review_items ri`;

// Reels kept in Descoberta before their download had finished were saved without a video: take it from the reel.
db.prepare("UPDATE review_items SET video_path = (SELECT video_path FROM reels WHERE id = review_items.reel_id) WHERE video_path IS NULL AND reel_id IS NOT NULL AND status = 'keep'").run();

export function registerReviewRoutes() {
  route('POST', '/api/review/submit', async (req) => {
    const b = await readBody(req);
    const by = String(b.by || req.worker?.name || '').trim().replace(/\s+/g, ' ').slice(0, 40); // default: the name in "A trabalhar como"
    if (!by) throw new HttpError(400, 'Write your name, so we know who sent it');
    const { links, invalid } = parseReelLinks(b.text);
    if (!links.length) throw new HttpError(400, invalid.length ? `No valid reel link (${invalid.slice(0, 3).join(', ')})` : 'Paste at least one TikTok or Instagram reel link');
    const note = String(b.note || '').trim().slice(0, 300);
    const t = now();
    const added = [];
    const duplicates = [];
    for (const l of links) {
      const prev = db.prepare('SELECT id, status FROM review_items WHERE platform = ? AND (ref = ? OR external_id = ?)').get(l.platform, l.ref, l.ref);
      if (prev) { duplicates.push({ url: l.url, id: prev.id, status: prev.status }); continue; }
      const row = db.prepare(`INSERT INTO review_items (url, platform, ref, handle, submitted_by, note, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?) RETURNING id`).get(l.url, l.platform, l.ref, l.handle || null, by, note, t, t);
      added.push(row.id);
    }
    setTimeout(tick, 50);
    return { added: added.length, duplicates, invalid, counts: counts() };
  });

  // Reels waiting for a decision, oldest first.
  route('GET', '/api/review/queue', () => ({
    items: db.prepare(`${ITEM_SELECT} WHERE ri.status = 'pending' ORDER BY ri.created_at, ri.id`).all(),
    counts: counts(),
  }));

  route('GET', '/api/review/items', (req, { query }) => {
    const where = [];
    const args = [];
    const st = query.get('status');
    if (st && st !== 'all') { where.push('ri.status IN (' + st.split(',').map(() => '?').join(',') + ')'); args.push(...st.split(',')); }
    if (query.get('by')) { where.push('ri.submitted_by = ?'); args.push(query.get('by')); }
    const order = st === 'keep' ? 'ri.decided_at DESC' : 'ri.created_at DESC, ri.id DESC';
    const limit = Math.max(1, Math.min(500, Number(query.get('limit')) || 200));
    return {
      items: db.prepare(`${ITEM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`).all(...args),
      counts: counts(),
      submitters: db.prepare("SELECT submitted_by AS name, COUNT(*) n FROM review_items WHERE submitted_by != '' GROUP BY submitted_by ORDER BY n DESC").all(),
    };
  });

  route('POST', '/api/review/:id/decide', async (req, { params }) => {
    const b = await readBody(req);
    const it = getItem(params.id);
    if (!it) throw new HttpError(404, 'This reel no longer exists');
    if (!['keep', 'push'].includes(b.decision)) throw new HttpError(400, 'Invalid decision');
    if (it.status !== 'pending' && !(b.decision === 'push' && it.status === 'keep')) throw new HttpError(409, 'This reel was already decided');
    if (b.decision === 'keep') {
      if (!exists(it.video_path)) throw new HttpError(409, 'The video of this reel is no longer in the app: press "Try again" in Sent');
      const reelId = keepToReel(it);
      upd(it.id, { status: 'keep', reel_id: reelId, decided_at: now() });
      learn(`review:${it.id}`, reelId, STEP.keep); // Sinais de treino: her creator and hashtags move up
    } else {
      upd(it.id, { status: 'push', decided_at: now() });
      if (it.status === 'keep') {
        // "Tirar da galeria": its Keep no longer counts as a good sign (Revisão's, or Descoberta's Guardar).
        unlearn(`review:${it.id}`);
        const dd = it.reel_id && db.prepare("SELECT deltas FROM discover_decisions WHERE reel_id = ? AND decision = 'keep'").get(it.reel_id);
        if (dd) {
          let deltas = {};
          try { deltas = JSON.parse(dd.deltas || '{}'); } catch {}
          for (const [k, v] of Object.entries(deltas)) unbump(k, v);
          db.prepare("UPDATE discover_decisions SET deltas = '{}' WHERE reel_id = ?").run(it.reel_id);
        }
      }
    }
    return { item: db.prepare(`${ITEM_SELECT} WHERE ri.id = ?`).get(it.id), counts: counts() };
  });

  // Galeria → "Pôr todos na fila de <modelo>": one queued remake per kept reel (free; "Gerar todos" in the Fila de
  // remakes runs them). Reels she already has are skipped.
  route('POST', '/api/review/gallery/queue', async (req) => {
    const b = await readBody(req);
    const modelId = Number(b.modelId);
    if (!modelId || !db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId)) throw new HttpError(400, 'Choose the model');
    const reels = db.prepare("SELECT DISTINCT reel_id FROM review_items WHERE status = 'keep' AND reel_id IS NOT NULL").all().map((x) => x.reel_id);
    const has = db.prepare('SELECT 1 FROM remakes WHERE reel_id = ? AND model_id = ?');
    const ins = db.prepare("INSERT INTO remakes (reel_id, model_id, prompt, status, created_at, updated_at) VALUES (?, ?, '', 'queued', ?, ?)");
    let added = 0;
    db.exec('BEGIN');
    try {
      for (const id of reels) { if (has.get(id, modelId)) continue; ins.run(id, modelId, now(), now()); added++; }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { added, skipped: reels.length - added };
  });

  // Undo a decision (the reel goes back to the review queue).
  route('POST', '/api/review/:id/undo', (req, { params }) => {
    const it = getItem(params.id);
    if (!it) throw new HttpError(404, 'This reel no longer exists');
    if (!['keep', 'push'].includes(it.status)) throw new HttpError(409, 'This reel has not been decided yet');
    if (!exists(it.video_path)) throw new HttpError(409, 'The video of this reel was already deleted');
    upd(it.id, { status: 'pending', decided_at: null });
    unlearn(`review:${it.id}`);
    return { item: db.prepare(`${ITEM_SELECT} WHERE ri.id = ?`).get(it.id), counts: counts() };
  });

  route('POST', '/api/review/:id/retry', (req, { params }) => {
    const it = getItem(params.id);
    if (!it) throw new HttpError(404, 'This reel no longer exists');
    if (it.status !== 'error') throw new HttpError(409, 'Only reels with an error can be tried again');
    upd(it.id, { status: 'processing', error: null });
    setTimeout(tick, 50);
    return { ok: true };
  });

  route('DELETE', '/api/review/:id', (req, { params }) => {
    const it = getItem(params.id);
    if (!it) return { ok: true };
    if (it.status === 'keep') throw new HttpError(409, 'This reel is in the Gallery: remove it from there first');
    if (it.status === 'processing' && busy.has(it.id)) throw new HttpError(409, 'This reel is being downloaded: wait a few seconds');
    const usedByReel = it.video_path && db.prepare('SELECT 1 FROM reels WHERE video_path = ?').get(it.video_path);
    if (it.video_path && !usedByReel) fs.rmSync(path.join(MEDIA_DIR, it.video_path), { force: true });
    if (it.thumb_path?.startsWith(`${THUMB_DIR}/`)) fs.rmSync(path.join(MEDIA_DIR, it.thumb_path), { force: true });
    db.prepare('DELETE FROM review_items WHERE id = ?').run(it.id);
    return { ok: true, counts: counts() };
  });
}
