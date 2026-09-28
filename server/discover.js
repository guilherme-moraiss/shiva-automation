import fs from 'node:fs';
import path from 'node:path';
import { db, now, MEDIA_DIR } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { galleryFromReel, galleryUndo } from './review.js';
import { STEP, tagsOf, weights, bump, unbump, learnDeltas, unlearn, signals, resetSignals } from './signals.js';

export { tagsOf } from './signals.js';

/**
 * Descoberta: the reels of the tracked creators, one at a time, best first. Guardar sends one to the Galeria (to be
 * remade); Passar leaves it. Each decision teaches the order (signals.js): the creator and the hashtags of what you keep
 * weigh more next time, those of what you pass weigh less. The score also counts views, how far the reel went past the
 * creator's followers (FTVR) and how recent it is.
 * Fontes: @creators pasted here are imported as tracked creators (Criadoras' importer); #hashtags are saved and give
 * the reels that use them a head start in the order. Bringing in new reels from a hashtag needs a hashtag scraper,
 * which is not connected yet.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS discover_decisions (
  reel_id INTEGER PRIMARY KEY REFERENCES reels(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  deltas TEXT NOT NULL DEFAULT '{}',
  gallery TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discover_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, value)
);
`);

const TAG_BOOST = 3; // a # added in Fontes: its reels move up about as much as three kept reels would
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };

/** Reels not decided and not remade yet, best first. */
function candidates(limit) {
  const rows = db.prepare(`SELECT r.id, r.platform, r.url, r.caption, r.views, r.likes, r.comments, r.shares, r.duration, r.posted_at, r.thumb_path, r.video_path,
      r.creator_id, c.handle, c.display_name, c.followers, c.avatar_path
    FROM reels r JOIN creators c ON c.id = r.creator_id
    WHERE c.tracked = 1 AND r.hidden = 0 AND r.media_type = 'video' AND r.views IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM discover_decisions d WHERE d.reel_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM remakes m WHERE m.reel_id = r.id)
    ORDER BY r.views DESC LIMIT 1000`).all();
  const W = weights();
  const t = now();
  // "× the creator's usual": views against the median of her last 30 video reels.
  const ids = [...new Set(rows.map((r) => r.creator_id))];
  const usual = new Map();
  if (ids.length) {
    const recent = db.prepare(`SELECT creator_id, views FROM reels WHERE media_type = 'video' AND views IS NOT NULL AND creator_id IN (${ids.map(() => '?').join(',')}) ORDER BY posted_at DESC`).all(...ids);
    const by = new Map();
    for (const x of recent) { const l = by.get(x.creator_id) || []; if (l.length < 30) l.push(x.views); by.set(x.creator_id, l); }
    for (const [id, l] of by) usual.set(id, median(l));
  }
  return rows.map((r) => {
    const ftvr = r.followers ? r.views / r.followers : null;
    const days = r.posted_at ? Math.max(0, (t - r.posted_at) / 86400) : 30;
    const tags = tagsOf(r.caption);
    const cw = W.get(`c:${r.creator_id}`) || 0;
    const tw = tags.reduce((a, x) => a + (W.get(`h:${x}`) || 0), 0);
    const parts = { views: Math.log10((r.views || 0) + 1) * 10, ftvr: ftvr ? Math.min(ftvr, 20) * 1.5 : 0, creator: cw * 4, tags: tw * 1.5, age: -Math.min(days, 90) * 0.15 };
    const score = Object.values(parts).reduce((a, x) => a + x, 0);
    // A video file that is gone (deleted, or another copy of the data) is downloaded again when shown.
    const video = r.video_path && fs.existsSync(path.join(MEDIA_DIR, r.video_path)) ? r.video_path : null;
    const med = usual.get(r.creator_id);
    return {
      ...r, video_path: video, ftvr, tags, tagWeights: Object.fromEntries(tags.map((x) => [x, W.get(`h:${x}`) || 0])), creatorWeight: cw, score: Math.round(score * 10) / 10, parts,
      likeRate: r.views ? (r.likes || 0) / r.views : null,
      vsUsual: med ? r.views / med : null,
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

function sources() {
  return {
    tags: db.prepare("SELECT id, value, created_at FROM discover_sources WHERE kind = 'tag' ORDER BY id").all(),
    tracked: db.prepare('SELECT COUNT(*) n FROM creators WHERE tracked = 1').get().n,
  };
}

const cleanTag = (s) => String(s || '').trim().replace(/^#+/, '').toLowerCase();
const TAG_RE = /^[\p{L}\p{N}_]{1,60}$/u;

export function registerDiscoverRoutes() {
  route('GET', '/api/discover', (req, { query }) => {
    const limit = Math.max(1, Math.min(50, int(query.get('limit'), 12)));
    const c = db.prepare("SELECT SUM(CASE WHEN decision = 'keep' THEN 1 ELSE 0 END) kept, SUM(CASE WHEN decision = 'pass' THEN 1 ELSE 0 END) passed FROM discover_decisions").get();
    return { items: candidates(limit), signals: signals(), sources: sources(), counts: { kept: c.kept || 0, passed: c.passed || 0 } };
  });

  route('POST', '/api/discover/:id/decide', async (req, { params }) => {
    const b = await readBody(req);
    const decision = b.decision === 'keep' ? 'keep' : b.decision === 'pass' ? 'pass' : null;
    if (!decision) throw new HttpError(400, 'Invalid decision');
    const r = db.prepare('SELECT id, creator_id, caption FROM reels WHERE id = ?').get(params.id);
    if (!r) throw new HttpError(404, 'Reel not found');
    if (db.prepare('SELECT 1 FROM discover_decisions WHERE reel_id = ?').get(r.id)) throw new HttpError(409, 'This reel was already decided');
    const step = STEP[decision];
    const deltas = { [`c:${r.creator_id}`]: step.c, ...Object.fromEntries(tagsOf(r.caption).map((x) => [`h:${x}`, step.h])) };
    let gallery = null;
    db.exec('BEGIN');
    try {
      for (const [k, d] of Object.entries(deltas)) bump(k, d);
      if (decision === 'keep') {
        const prev = db.prepare('SELECT status FROM review_items WHERE reel_id = ?').get(r.id)?.status;
        gallery = { ...galleryFromReel(r.id), prevStatus: prev || 'pending' };
        // "Ao guardar, pôr também na fila de <modelo>": one queued remake (free), unless she already has this reel.
        const qm = Number(b.queueModel) || null;
        if (qm && db.prepare('SELECT 1 FROM models WHERE id = ?').get(qm) && !db.prepare('SELECT 1 FROM remakes WHERE reel_id = ? AND model_id = ?').get(r.id, qm)) {
          gallery.remakeId = db.prepare("INSERT INTO remakes (reel_id, model_id, prompt, status, created_at, updated_at) VALUES (?, ?, '', 'queued', ?, ?) RETURNING id").get(r.id, qm, now(), now()).id;
        }
      }
      db.prepare('INSERT INTO discover_decisions (reel_id, decision, deltas, gallery, at) VALUES (?, ?, ?, ?, ?)').run(r.id, decision, JSON.stringify(deltas), gallery ? JSON.stringify(gallery) : null, now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true, decision, signals: signals(), queued: !!gallery?.remakeId };
  });

  // Undo: the weights go back exactly, and a reel sent to the Galeria leaves it.
  route('POST', '/api/discover/:id/undo', (req, { params }) => {
    const d = db.prepare('SELECT * FROM discover_decisions WHERE reel_id = ?').get(params.id);
    if (!d) throw new HttpError(404, 'Nothing to undo on this reel');
    db.exec('BEGIN');
    try {
      for (const [k, delta] of Object.entries(parse(d.deltas, {}))) unbump(k, delta);
      const g = parse(d.gallery, null);
      if (g) galleryUndo(g);
      // The remake it queued goes too, while nothing was generated from it.
      if (g?.remakeId && !db.prepare('SELECT 1 FROM generations WHERE remake_id = ?').get(g.remakeId)) db.prepare('DELETE FROM remakes WHERE id = ?').run(g.remakeId);
      db.prepare('DELETE FROM discover_decisions WHERE reel_id = ?').run(d.reel_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true, signals: signals() };
  });

  // Start learning again (the decisions stay: the reels already seen do not come back, and their undo takes back nothing).
  route('POST', '/api/discover/signals/reset', () => {
    db.exec('BEGIN');
    try {
      resetSignals();
      db.prepare("UPDATE discover_decisions SET deltas = '{}'").run();
      // The # in Fontes are settings, not something learnt: they keep their head start.
      for (const { value } of db.prepare("SELECT value FROM discover_sources WHERE kind = 'tag'").all()) learnDeltas(`source:#${value}`, { [`h:${value}`]: TAG_BOOST });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true, signals: signals() };
  });

  // Fontes: #hashtags (the @creators go through POST /api/creators/import).
  route('POST', '/api/discover/sources', async (req) => {
    const b = await readBody(req);
    const list = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[\s,;]+/)).map(cleanTag).filter(Boolean);
    const invalid = list.filter((x) => !TAG_RE.test(x));
    const tags = [...new Set(list.filter((x) => TAG_RE.test(x)))].slice(0, 100);
    let added = 0;
    for (const tag of tags) {
      const row = db.prepare("INSERT INTO discover_sources (kind, value, created_at) VALUES ('tag', ?, ?) ON CONFLICT(kind, value) DO NOTHING RETURNING id").get(tag, now());
      learnDeltas(`source:#${tag}`, { [`h:${tag}`]: TAG_BOOST }); // once per # (a no-op when it already has it)
      if (row) added++;
    }
    return { added, existing: tags.length - added, invalid, sources: sources(), signals: signals() };
  });

  route('DELETE', '/api/discover/sources/:id', (req, { params }) => {
    const s = db.prepare('SELECT * FROM discover_sources WHERE id = ?').get(params.id);
    if (!s) return { ok: true, sources: sources(), signals: signals() };
    unlearn(`source:#${s.value}`);
    db.prepare('DELETE FROM discover_sources WHERE id = ?').run(s.id);
    return { ok: true, sources: sources(), signals: signals() };
  });
}
