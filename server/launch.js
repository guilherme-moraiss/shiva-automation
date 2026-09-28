import { db, now } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { importReelFromLink } from './review.js';

/**
 * Links de lançamento: reels already proven viral on her accounts. A new model starts with all of them at once:
 * "Lançar" puts one remake of each in her Fila de remakes (nothing is generated or paid until "Gerar").
 */
db.exec(`
CREATE TABLE IF NOT EXISTS launch_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id INTEGER NOT NULL UNIQUE REFERENCES reels(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

const LIST = `SELECT l.*, r.url, r.platform, r.thumb_path, r.frame_path, r.views, r.likes, r.duration, r.caption, c.handle
  FROM launch_links l JOIN reels r ON r.id = l.reel_id JOIN creators c ON c.id = r.creator_id`;

function withUse(rows) {
  const use = db.prepare(`SELECT m.model_id, md.name, COUNT(*) remakes,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM generations g WHERE g.remake_id = m.id AND g.stage = 'approved') THEN 1 ELSE 0 END) approved,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM generations g WHERE g.remake_id = m.id) THEN 1 ELSE 0 END) started
    FROM remakes m JOIN models md ON md.id = m.model_id WHERE m.reel_id = ? GROUP BY m.model_id`);
  return rows.map((l) => ({ ...l, models: use.all(l.reel_id) }));
}

function addReel(reelId, name) {
  const t = now();
  const position = (db.prepare('SELECT MAX(position) p FROM launch_links').get().p ?? -1) + 1;
  db.prepare('INSERT INTO launch_links (reel_id, name, position, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(reel_id) DO UPDATE SET name = CASE WHEN excluded.name != \'\' THEN excluded.name ELSE launch_links.name END')
    .run(reelId, String(name || '').trim().slice(0, 80), position, t);
  return withUse([db.prepare(`${LIST} WHERE l.reel_id = ?`).get(reelId)])[0];
}

export function registerLaunchRoutes() {
  route('GET', '/api/launch-links', () => ({
    items: withUse(db.prepare(`${LIST} ORDER BY l.position, l.id`).all()),
    models: db.prepare('SELECT id, name, color FROM models ORDER BY id').all(),
  }));

  // A link (downloaded into the app like "Novo projeto"), or a reel the app already has (from a project).
  route('POST', '/api/launch-links', async (req) => {
    const b = await readBody(req);
    let reelId = int(b.reelId);
    if (reelId) {
      if (!db.prepare('SELECT 1 FROM reels WHERE id = ?').get(reelId)) throw new HttpError(404, 'Reel not found');
    } else {
      reelId = (await importReelFromLink(String(b.url || '').slice(0, 500))).reelId;
    }
    const existed = !!db.prepare('SELECT 1 FROM launch_links WHERE reel_id = ?').get(reelId);
    return { ...addReel(reelId, b.name), existed };
  });

  route('PATCH', '/api/launch-links/:id', async (req, { params }) => {
    const b = await readBody(req);
    const l = db.prepare('SELECT * FROM launch_links WHERE id = ?').get(params.id);
    if (!l) throw new HttpError(404, 'Link not found');
    db.prepare('UPDATE launch_links SET name = ? WHERE id = ?').run(String(b.name ?? l.name).trim().slice(0, 80), l.id);
    return { ok: true };
  });

  route('DELETE', '/api/launch-links/:id', (req, { params }) => {
    db.prepare('DELETE FROM launch_links WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // One remake of every link (or the chosen ones) in the model's Fila de remakes. Links she already has are skipped.
  route('POST', '/api/launch-links/launch', async (req) => {
    const b = await readBody(req);
    const modelId = int(b.modelId);
    if (!modelId || !db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId)) throw new HttpError(400, 'Choose the model');
    const ids = Array.isArray(b.ids) && b.ids.length ? b.ids.map(Number) : null;
    const links = db.prepare('SELECT * FROM launch_links ORDER BY position, id').all().filter((l) => !ids || ids.includes(l.id));
    if (!links.length) throw new HttpError(400, 'There are no launch links yet');
    const t = now();
    let added = 0;
    const has = db.prepare('SELECT 1 FROM remakes WHERE reel_id = ? AND model_id = ?');
    const ins = db.prepare("INSERT INTO remakes (reel_id, model_id, prompt, status, created_at, updated_at) VALUES (?, ?, '', 'queued', ?, ?)");
    db.exec('BEGIN');
    try {
      for (const l of links) {
        if (has.get(l.reel_id, modelId)) continue;
        ins.run(l.reel_id, modelId, t, t);
        added++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { added, skipped: links.length - added };
  });
}
