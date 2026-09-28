import { db, now } from './db.js';

/**
 * Sinais de treino: what the app has learnt about which creators (@) and hashtags (#) are worth remaking.
 *   weight — used to rank Descoberta: the score capped at ±10, so one creator never takes over the list;
 *   score  — the running total shown on the panel (not capped), like the reference's training signals.
 * Every page that teaches (Descoberta Guardar/Passar, Revisão Keep, Aprovação Normal, a remake started, a # added in
 * Fontes) goes through learn(), once per event, and its undo goes through unlearn(), which takes back exactly what
 * that event added.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS discover_weights (
  key TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discover_events (
  key TEXT PRIMARY KEY,
  deltas TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);
if (!db.prepare('PRAGMA table_info(discover_weights)').all().some((c) => c.name === 'score')) {
  db.exec('ALTER TABLE discover_weights ADD COLUMN score REAL NOT NULL DEFAULT 0');
  db.exec('UPDATE discover_weights SET score = weight'); // what was learnt before counts from here
}
db.exec('UPDATE discover_weights SET weight = MAX(-10, MIN(10, score))'); // weight is always the capped score (repairs old drift)

/** How much each kind of event moves the creator (c) and each of the reel's hashtags (h). */
export const STEP = {
  keep: { c: 1, h: 0.5 }, // Descoberta Guardar / Revisão Keep
  pass: { c: -0.5, h: -0.25 }, // Descoberta Passar
  remake: { c: 1, h: 0.5 }, // a project started from this reel
  normal: { c: 0.5, h: 0.25 }, // its video scheduled as Normal in Aprovação
};

const clamp = (x) => Math.max(-10, Math.min(10, x));
const UNKNOWN = 'desconhecida'; // review.js's creator for reels whose author could not be read: not a real account
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Hashtags of a caption, lower case, without the #. */
export const tagsOf = (caption) => [...new Set((String(caption || '').toLowerCase().match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)))].slice(0, 12);

export function weights() {
  return new Map(db.prepare('SELECT key, weight FROM discover_weights').all().map((x) => [x.key, x.weight]));
}

export function bump(key, delta) {
  const cur = db.prepare('SELECT score FROM discover_weights WHERE key = ?').get(key);
  const score = (cur?.score || 0) + delta; // weight follows the exact running score, so an undo always comes back exactly
  if (cur) db.prepare('UPDATE discover_weights SET weight = ?, score = ?, n = n + 1 WHERE key = ?').run(clamp(score), score, key);
  else db.prepare('INSERT INTO discover_weights (key, weight, score, n) VALUES (?, ?, ?, 1)').run(key, clamp(score), score);
}

export function unbump(key, delta) {
  const cur = db.prepare('SELECT score FROM discover_weights WHERE key = ?').get(key);
  if (!cur) return;
  const score = cur.score - delta;
  db.prepare('UPDATE discover_weights SET weight = ?, score = ?, n = MAX(0, n - 1) WHERE key = ?').run(clamp(score), score, key);
}

/** The deltas one event gives a reel: its creator and each of its hashtags. */
export function reelDeltas(reelId, step) {
  const r = reelId ? db.prepare('SELECT r.creator_id, r.caption, c.handle FROM reels r LEFT JOIN creators c ON c.id = r.creator_id WHERE r.id = ?').get(reelId) : null;
  if (!r) return null;
  const tags = Object.fromEntries(tagsOf(r.caption).map((x) => [`h:${x}`, step.h]));
  return r.handle === UNKNOWN ? tags : { [`c:${r.creator_id}`]: step.c, ...tags }; // the unknown-author placeholder never learns
}

/** Applies `deltas` once for `event` (a second call with the same event does nothing). Returns true if applied. */
export function learnDeltas(event, deltas) {
  if (!deltas || !Object.keys(deltas).length) return false;
  if (db.prepare('SELECT 1 FROM discover_events WHERE key = ?').get(event)) return false;
  db.exec('SAVEPOINT learn'); // works inside or outside a caller's transaction
  try {
    for (const [k, d] of Object.entries(deltas)) bump(k, d);
    db.prepare('INSERT INTO discover_events (key, deltas, at) VALUES (?, ?, ?)').run(event, JSON.stringify(deltas), now());
    db.exec('RELEASE learn');
  } catch (e) { db.exec('ROLLBACK TO learn'); db.exec('RELEASE learn'); throw e; }
  return true;
}

export const learn = (event, reelId, step) => learnDeltas(event, reelDeltas(reelId, step));

/** Takes back exactly what `event` added. */
export function unlearn(event) {
  const e = db.prepare('SELECT * FROM discover_events WHERE key = ?').get(event);
  if (!e) return false;
  db.exec('SAVEPOINT unlearn');
  try {
    for (const [k, d] of Object.entries(parse(e.deltas, {}))) unbump(k, d);
    db.prepare('DELETE FROM discover_events WHERE key = ?').run(event);
    db.exec('RELEASE unlearn');
  } catch (err) { db.exec('ROLLBACK TO unlearn'); db.exec('RELEASE unlearn'); throw err; }
  return true;
}

/** The panel: the best 8 @ and 8 # (by running score), and what to avoid (negative), with each creator's link. */
export function signals() {
  const rows = db.prepare('SELECT key, weight, score, n FROM discover_weights WHERE score != 0 OR weight != 0').all();
  const creators = new Map(db.prepare('SELECT id, handle, platform, tracked FROM creators').all().map((c) => [`c:${c.id}`, c]));
  const round = (x) => Math.round(x * 100) / 100;
  const c = rows.filter((r) => r.key.startsWith('c:') && creators.has(r.key) && creators.get(r.key).handle !== UNKNOWN).map((r) => {
    const cr = creators.get(r.key);
    return { key: r.key, id: cr.id, label: cr.handle, platform: cr.platform, tracked: !!cr.tracked, weight: round(r.weight), score: round(r.score), n: r.n };
  });
  const hts = rows.filter((r) => r.key.startsWith('h:')).map((r) => ({ key: r.key, label: r.key.slice(2), weight: round(r.weight), score: round(r.score), n: r.n }));
  const top = (list) => list.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  const low = (list) => list.filter((x) => x.score < 0).sort((a, b) => a.score - b.score).slice(0, 8);
  return { creators: top(c), hashtags: top(hts), avoid: { creators: low(c), hashtags: low(hts) }, total: rows.length };
}

/** Forgets everything learnt (the caller wraps it in its transaction). */
export function resetSignals() {
  db.prepare('DELETE FROM discover_weights').run();
  db.prepare('DELETE FROM discover_events').run();
}
