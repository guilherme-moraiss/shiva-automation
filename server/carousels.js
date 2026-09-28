import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSettings, MEDIA_DIR } from './db.js';
import { route, readBody, int, HttpError, decodeDataUrl } from './http.js';
import { parseHandles } from './scrapers/index.js';
import { scanOne } from './jobs.js';

/**
 * Carrosséis: an Instagram profile's photo posts and carousels, remade with her. "Ir buscar" reads the profile's
 * latest posts (free, same scraper as Criadoras; the account is not added to Criadoras), then each post chosen is
 * remade as a photo project (every slide) and appears in Projetos. Nothing is paid until "Refazer".
 */
db.exec(`
CREATE TABLE IF NOT EXISTS carousel_profiles (
  creator_id INTEGER PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  last_scan_at INTEGER,
  last_error TEXT
);
`);
// The model last used for each profile (chosen again when it is opened) and favourites (listed first).
for (const [c, t] of [['model_id', 'INTEGER'], ['starred', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(carousel_profiles)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE carousel_profiles ADD COLUMN ${c} ${t}`);
}
/** Your own uploaded carousels live under this profile. */
const UPLOADS = 'carregados';

const exists = (rel) => !!rel && !rel.includes('..') && fs.existsSync(path.join(MEDIA_DIR, rel));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const PHOTO = "r.media_type IN ('photo', 'carousel')";

function profiles() {
  return db.prepare(`SELECT p.*, c.handle, c.display_name, c.avatar_path, c.followers, c.status, md.name AS model_name, md.color AS model_color,
      (SELECT COUNT(*) FROM reels r WHERE r.creator_id = c.id AND ${PHOTO}) AS posts, (c.handle = '${UPLOADS}') AS uploads
    FROM carousel_profiles p JOIN creators c ON c.id = p.creator_id LEFT JOIN models md ON md.id = p.model_id ORDER BY p.starred DESC, p.added_at DESC`).all();
}

async function scan(creatorId) {
  const c = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId);
  if (!c) throw new HttpError(404, 'Profile not found');
  try {
    const s = getSettings();
    // The whole profile (up to 500 posts, the photo feed only). On Apify each result is paid: keep its usual limit there.
    const r = await scanOne(c, s, s.instagram_provider === 'apify' ? {} : { limit: 500, photosOnly: true });
    db.prepare('UPDATE carousel_profiles SET last_scan_at = ?, last_error = ? WHERE creator_id = ?').run(now(), r.note || null, c.id);
    return r;
  } catch (e) {
    db.prepare('UPDATE carousel_profiles SET last_scan_at = ?, last_error = ? WHERE creator_id = ?').run(now(), String(e.message).slice(0, 300), c.id);
    throw new HttpError(502, `Could not read @${c.handle}: ${e.message}`);
  }
}

export function registerCarouselRoutes() {
  route('GET', '/api/carousels', () => ({ profiles: profiles(), provider: getSettings().instagram_provider }));

  route('POST', '/api/carousels', async (req) => {
    const b = await readBody(req);
    const raw = String(b.handle || '').trim();
    const { handles, invalid } = parseHandles(raw, 'instagram');
    const found = handles.filter((x) => x.platform === 'instagram');
    if (!found.length || invalid.length || /\s/.test(raw)) throw new HttpError(400, 'Enter the @ of one Instagram profile (just one) or the profile link');
    const handle = found[0].handle;
    const t = now();
    db.prepare(`INSERT INTO creators (platform, handle, group_name, tracked, created_at) VALUES ('instagram', ?, 'Carrosséis', 0, ?)
      ON CONFLICT(platform, handle) DO NOTHING`).run(handle, t);
    const c = db.prepare("SELECT * FROM creators WHERE platform = 'instagram' AND handle = ?").get(handle);
    db.prepare('INSERT INTO carousel_profiles (creator_id, added_at) VALUES (?, ?) ON CONFLICT(creator_id) DO NOTHING').run(c.id, t);
    const r = await scan(c.id);
    return { profile: profiles().find((p) => p.creator_id === c.id), note: r.note || null };
  });

  // ★ and the model remembered for a profile.
  route('PATCH', '/api/carousels/:id', async (req, { params }) => {
    const b = await readBody(req);
    if (!db.prepare('SELECT 1 FROM carousel_profiles WHERE creator_id = ?').get(params.id)) throw new HttpError(404, 'This profile is not in Carousels');
    if (b.starred !== undefined) db.prepare('UPDATE carousel_profiles SET starred = ? WHERE creator_id = ?').run(b.starred ? 1 : 0, params.id);
    if (b.modelId !== undefined) {
      const m = int(b.modelId);
      if (m && !db.prepare('SELECT 1 FROM models WHERE id = ?').get(m)) throw new HttpError(400, 'Model not found');
      db.prepare('UPDATE carousel_profiles SET model_id = ? WHERE creator_id = ?').run(m || null, params.id);
    }
    return { profile: profiles().find((p) => p.creator_id === Number(params.id)) };
  });

  // "Carregar carrossel": up to 20 of your own photos become one post of the "carregados" profile (nothing is paid).
  route('POST', '/api/carousels/upload', async (req) => {
    const b = await readBody(req);
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 20);
    if (!images.length) throw new HttpError(400, 'Choose at least one photo');
    const t = now();
    db.prepare(`INSERT INTO creators (platform, handle, display_name, group_name, tracked, created_at) VALUES ('instagram', ?, 'Carousels you uploaded', 'Carrosséis', 0, ?)
      ON CONFLICT(platform, handle) DO NOTHING`).run(UPLOADS, t);
    const c = db.prepare("SELECT * FROM creators WHERE platform = 'instagram' AND handle = ?").get(UPLOADS);
    db.prepare('INSERT INTO carousel_profiles (creator_id, added_at) VALUES (?, ?) ON CONFLICT(creator_id) DO NOTHING').run(c.id, t);
    const ext = `upload_${Date.now()}`;
    fs.mkdirSync(path.join(MEDIA_DIR, 'posts'), { recursive: true });
    const paths = images.map((data, i) => {
      const { buf, ext: e } = decodeDataUrl(data);
      if (buf.length < 1000) throw new HttpError(400, `Photo ${i + 1} is empty or damaged`);
      const rel = `posts/instagram_${ext}_${i}.${e}`;
      fs.writeFileSync(path.join(MEDIA_DIR, rel), buf);
      return rel;
    });
    const r = db.prepare(`INSERT INTO reels (creator_id, platform, external_id, url, caption, posted_at, thumb_path, media_type, image_paths, first_seen_at, updated_at)
      VALUES (?, 'instagram', ?, '', ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(c.id, ext, String(b.caption || '').slice(0, 2200), t, paths[0], paths.length > 1 ? 'carousel' : 'photo', JSON.stringify(paths), t, t);
    return { reelId: r.id, profile: profiles().find((p) => p.creator_id === c.id) };
  });

  route('POST', '/api/carousels/:id/scan', async (req, { params }) => {
    if (!db.prepare('SELECT 1 FROM carousel_profiles WHERE creator_id = ?').get(params.id)) throw new HttpError(404, 'This profile is not in Carousels');
    if (db.prepare('SELECT 1 FROM creators WHERE id = ? AND handle = ?').get(params.id, UPLOADS)) throw new HttpError(400, 'This profile holds the carousels you uploaded: there is nothing to read on Instagram');
    const r = await scan(Number(params.id));
    return { profile: profiles().find((p) => p.creator_id === Number(params.id)), note: r.note || null };
  });

  route('DELETE', '/api/carousels/:id', (req, { params }) => {
    db.prepare('DELETE FROM carousel_profiles WHERE creator_id = ?').run(params.id);
    return { ok: true };
  });

  // Photo posts of one profile, with what was already made of each for `model`.
  route('GET', '/api/carousels/:id/posts', (req, { params, query }) => {
    const modelId = int(query.get('model'));
    const rows = db.prepare(`SELECT r.id, r.url, r.media_type, r.image_paths, r.image_urls, r.thumb_path, r.likes, r.comments, r.views, r.posted_at, r.caption
      FROM reels r WHERE r.creator_id = ? AND ${PHOTO} ORDER BY r.posted_at DESC LIMIT 300`).all(params.id);
    const last = db.prepare(`SELECT g.id, g.stage FROM generations g JOIN remakes m ON m.id = g.remake_id
      WHERE m.reel_id = ? AND m.model_id = ? AND g.kind = 'photo' ORDER BY g.id DESC LIMIT 1`);
    return rows.map(({ image_paths, image_urls, ...r }) => {
      const slides = parse(image_paths, []).filter(exists);
      return { ...r, slides, total: Math.max(slides.length, parse(image_urls, []).length), made: modelId ? last.get(r.id, modelId) || null : null };
    });
  });
}
