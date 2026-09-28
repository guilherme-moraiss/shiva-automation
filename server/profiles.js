import { db, now } from './db.js';
import { route, readBody, int, HttpError } from './http.js';
import { editEngineList } from './pipeline/runner.js';
import { EDIT_PRESETS } from './pipeline/prompts.js';

/**
 * Perfis: what changes from model to model when her videos are published.
 *   accounts — where her posts go (Instagram, TikTok, X, YouTube), one row per account; Instagram accounts can take
 *              "trial" reels (shown to non-followers first). Used by Aprovação and the Calendário.
 *   captions — her caption pool: one is picked at random for each post, more often the higher its weight.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'x', 'youtube')),
  handle TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  trial INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, handle)
);
CREATE INDEX IF NOT EXISTS accounts_model ON accounts(model_id);
CREATE TABLE IF NOT EXISTS captions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS captions_model ON captions(model_id);
`);

export const PLATFORMS = { instagram: 'Instagram', tiktok: 'TikTok', x: 'X', youtube: 'YouTube' };
const MAX_CAPTION = 2200; // Instagram's and TikTok's caption limit (X and YouTube titles are shorter; the posting service will apply those)

const HOSTS = [[/(^|\.)instagram\.com$/i, 'instagram'], [/(^|\.)tiktok\.com$/i, 'tiktok'], [/(^|\.)(x|twitter)\.com$/i, 'x'], [/(^|\.)youtube\.com$/i, 'youtube']];
// First path words of links that are not a profile (a post, a reel, a channel id, a search…).
const NOT_PROFILE = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'channel', 'c', 'user', 'shorts', 'watch', 'i', 'home', 'intent', 'video', 'photo', 'tag', 'hashtag', 'search', 'share', 'discover', 'music']);
// Post links that start with the author: tiktok.com/@a/video/…, x.com/a/status/…, instagram.com/a/reel/…
const POST_WORD = { tiktok: /^(video|photo)$/i, x: /^status$/i, instagram: /^(p|reel|tv)$/i };

/**
 * "@name", a profile link or a bare name → { platform, handle }, checked for that platform's rules.
 * A link decides the platform (a TikTok link is a TikTok account whatever the select says).
 */
export function parseAccount(platform, raw) {
  let s = String(raw || '').trim();
  let pf = platform;
  if (/^https?:\/\//i.test(s) || /^(www\.|m\.)?[a-z0-9-]+\.(com|be)\//i.test(s)) {
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : `https://${s}`); } catch { throw new HttpError(400, 'Invalid link'); }
    const host = u.hostname.replace(/^(www|m)\./i, '');
    if (/^(vm|vt)\.tiktok\.com$/i.test(host) || /^youtu\.be$/i.test(host)) throw new HttpError(400, 'That is a short link: paste the profile link (for example tiktok.com/@account)');
    const hit = HOSTS.find(([re]) => re.test(host));
    if (!hit) throw new HttpError(400, 'That link is not from Instagram, TikTok, X or YouTube');
    pf = hit[1];
    const segs = u.pathname.split('/').filter(Boolean);
    let first;
    try { first = decodeURIComponent(segs[0] || ''); } catch { throw new HttpError(400, 'Invalid link'); }
    if (!first || NOT_PROFILE.has(first.replace(/^@/, '').toLowerCase()) || POST_WORD[pf]?.test(segs[1] || '')) throw new HttpError(400, 'That link is to a post, not a profile: paste the profile link');
    s = first;
  }
  s = s.replace(/^@+/, '').trim();
  const handle = checkHandle(pf, s);
  return { platform: pf, handle };
}
export const cleanAccountHandle = (platform, raw) => parseAccount(platform, raw).handle;

function checkHandle(platform, s) {
  const rules = {
    instagram: [/^[A-Za-z0-9._]{1,30}$/, 'Instagram: up to 30 characters, only letters, numbers, period and _'],
    tiktok: [/^[A-Za-z0-9._]{2,24}$/, 'TikTok: 2 to 24 characters, only letters, numbers, period and _'],
    x: [/^[A-Za-z0-9_]{1,15}$/, 'X: up to 15 characters, only letters, numbers and _'],
    youtube: [/^[A-Za-z0-9._-]{3,30}$/, 'YouTube: 3 to 30 characters, only letters, numbers, period, - and _'],
  }[platform];
  if (!rules) throw new HttpError(400, 'Invalid platform');
  if (!rules[0].test(s)) throw new HttpError(400, `Invalid account name. ${rules[1]}`);
  return s;
}

const modelExists = (id) => !!db.prepare('SELECT 1 FROM models WHERE id = ?').get(id);
const weightOf = (v) => Math.max(1, Math.min(10, int(v, 1) || 1));

export function modelAccounts(modelId) {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'scheduled') AS scheduled,
      (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'posted') AS posted
    FROM accounts a WHERE a.model_id = ? ORDER BY a.position, a.id`).all(modelId);
}

/** Takes an account's scheduled posts off; the projects left with none go back to Aprovação. Returns how many. */
async function dropScheduled(accountId) {
  const { settle } = await import('./agenda.js'); // loaded here: agenda.js → approval.js → profiles.js
  const rows = db.prepare("SELECT id, generation_id FROM posts WHERE account_id = ? AND status = 'scheduled'").all(accountId);
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM posts WHERE account_id = ? AND status = 'scheduled'").run(accountId);
    for (const g of new Set(rows.map((r) => r.generation_id))) settle(g);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}
export function modelCaptions(modelId) {
  return db.prepare('SELECT * FROM captions WHERE model_id = ? ORDER BY id').all(modelId);
}

/** One caption of her pool, at random by weight (never `excludeId` when there is another one). */
export function randomCaption(modelId, excludeId = null) {
  let list = modelCaptions(modelId);
  if (list.length > 1 && excludeId) list = list.filter((c) => c.id !== excludeId);
  if (!list.length) return null;
  let r = Math.random() * list.reduce((a, c) => a + c.weight, 0);
  for (const c of list) { r -= c.weight; if (r < 0) return c; }
  return list[list.length - 1];
}

export function registerProfileRoutes() {
  route('GET', '/api/profiles', () => {
    const models = db.prepare('SELECT id, name, color, ref_images, edit_prompt, edit_engine, edit_n, edit_auto, image_extra, default_ref, swap_prompt FROM models ORDER BY id').all();
    return {
      platforms: PLATFORMS,
      edit: { engines: editEngineList(), preset: EDIT_PRESETS.bust4x, presets: Object.entries(EDIT_PRESETS).map(([key, p]) => ({ key, ...p })) }, // step 3 (Aumento) per model
      models: models.map(({ ref_images, ...m }) => {
        let refs = [];
        try { refs = JSON.parse(ref_images || '[]'); } catch {}
        const cover = refs.find((r) => r.kind === 'face_front') || refs[0];
        return { ...m, cover: cover?.path || null, refs: refs.map((r) => ({ path: r.path, kind: r.kind, generated: !!r.generated })), accounts: modelAccounts(m.id), captions: modelCaptions(m.id) };
      }),
    };
  });

  // ---- accounts ----
  route('POST', '/api/models/:id/accounts', async (req, { params }) => {
    const b = await readBody(req);
    const modelId = Number(params.id);
    if (!modelExists(modelId)) throw new HttpError(404, 'Model not found');
    const { platform, handle } = parseAccount(String(b.platform || ''), b.handle);
    const taken = db.prepare('SELECT a.model_id, a.handle, m.name FROM accounts a JOIN models m ON m.id = a.model_id WHERE a.platform = ? AND lower(a.handle) = lower(?)').get(platform, handle);
    if (taken) throw new HttpError(409, `The ${PLATFORMS[platform]} account @${taken.handle} is already ${taken.model_id === modelId ? 'on this model' : `on the model ${taken.name}`}`);
    const position = (db.prepare('SELECT MAX(position) p FROM accounts WHERE model_id = ?').get(modelId).p ?? -1) + 1;
    return db.prepare('INSERT INTO accounts (model_id, platform, handle, label, active, trial, position, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?) RETURNING *')
      .get(modelId, platform, handle, String(b.label || '').trim().slice(0, 40), platform === 'instagram' && ![false, 0, '0', 'false'].includes(b.trial) ? 1 : 0, position, now()); // Trial on by default for Instagram
  });

  route('PATCH', '/api/accounts/:id', async (req, { params }) => {
    const b = await readBody(req);
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(params.id);
    if (!a) throw new HttpError(404, 'Account not found');
    const next = { ...a };
    if (b.handle !== undefined) {
      const r = parseAccount(a.platform, b.handle);
      if (r.platform !== a.platform) throw new HttpError(400, `That link is from ${PLATFORMS[r.platform]}, but this account is on ${PLATFORMS[a.platform]}`);
      next.handle = r.handle;
      const taken = db.prepare('SELECT 1 FROM accounts WHERE platform = ? AND lower(handle) = lower(?) AND id != ?').get(a.platform, next.handle, a.id);
      if (taken) throw new HttpError(409, `The account @${next.handle} already exists`);
    }
    if (b.label !== undefined) next.label = String(b.label || '').trim().slice(0, 40);
    if (b.active !== undefined) next.active = b.active ? 1 : 0;
    if (b.trial !== undefined) next.trial = a.platform === 'instagram' && b.trial ? 1 : 0;
    if (b.position !== undefined) next.position = int(b.position, a.position);
    db.prepare('UPDATE accounts SET handle = ?, label = ?, active = ?, trial = ?, position = ? WHERE id = ?').run(next.handle, next.label, next.active, next.trial, next.position, a.id);
    // Switched off and asked to: its scheduled posts come off too.
    const dropped = !next.active && b.dropScheduled ? await dropScheduled(a.id) : 0;
    return { ...modelAccounts(a.model_id).find((x) => x.id === a.id), dropped };
  });

  // Remove: only an account that never published (its history would go with it); its scheduled posts come off first.
  route('DELETE', '/api/accounts/:id', async (req, { params }) => {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(params.id);
    if (!a) return { ok: true, dropped: 0 };
    const posted = db.prepare("SELECT COUNT(*) n FROM posts WHERE account_id = ? AND status = 'posted'").get(a.id).n;
    if (posted) throw new HttpError(409, `The account @${a.handle} already has ${posted} published post(s): turn it off (Active) instead of removing it, so that history is not lost`);
    const dropped = await dropScheduled(a.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    return { ok: true, dropped };
  });

  // ---- captions ----
  route('POST', '/api/models/:id/captions', async (req, { params }) => {
    const b = await readBody(req);
    const modelId = Number(params.id);
    if (!modelExists(modelId)) throw new HttpError(404, 'Model not found');
    const text = String(b.text || '').trim();
    if (!text) throw new HttpError(400, 'Write the caption');
    if (text.length > MAX_CAPTION) throw new HttpError(400, `The caption has ${text.length} characters: the maximum is ${MAX_CAPTION} (Instagram's limit)`);
    return db.prepare('INSERT INTO captions (model_id, text, weight, created_at) VALUES (?, ?, ?, ?) RETURNING *').get(modelId, text, weightOf(b.weight), now());
  });

  // "Copiar legendas de…": another model's pool, same texts and weights (the ones she already has are not doubled).
  route('POST', '/api/models/:id/captions/clone', async (req, { params }) => {
    const b = await readBody(req);
    const modelId = Number(params.id);
    const from = Number(b.from);
    if (!modelExists(modelId) || !modelExists(from)) throw new HttpError(404, 'Model not found');
    if (from === modelId) throw new HttpError(400, 'Choose another model');
    const have = new Set(modelCaptions(modelId).map((c) => c.text));
    const ins = db.prepare('INSERT INTO captions (model_id, text, weight, created_at) VALUES (?, ?, ?, ?)');
    let added = 0;
    for (const c of modelCaptions(from)) if (!have.has(c.text)) { ins.run(modelId, c.text, c.weight, now()); added++; }
    return { added, captions: modelCaptions(modelId) };
  });

  route('PATCH', '/api/captions/:id', async (req, { params }) => {
    const b = await readBody(req);
    const c = db.prepare('SELECT * FROM captions WHERE id = ?').get(params.id);
    if (!c) throw new HttpError(404, 'Caption not found');
    const text = b.text !== undefined ? String(b.text || '').trim() : c.text;
    if (!text) throw new HttpError(400, 'The caption cannot be empty (delete it instead)');
    if (text.length > MAX_CAPTION) throw new HttpError(400, `The caption has ${text.length} characters: the maximum is ${MAX_CAPTION}`);
    const weight = b.weight !== undefined ? weightOf(b.weight) : c.weight;
    db.prepare('UPDATE captions SET text = ?, weight = ? WHERE id = ?').run(text, weight, c.id);
    return db.prepare('SELECT * FROM captions WHERE id = ?').get(c.id);
  });

  route('DELETE', '/api/captions/:id', (req, { params }) => {
    db.prepare('DELETE FROM captions WHERE id = ?').run(params.id);
    return { ok: true };
  });

  // One caption at random by weight ("Outra" in Aprovação picks a different one).
  route('GET', '/api/models/:id/caption', (req, { params, query }) => {
    const c = randomCaption(Number(params.id), int(query.get('exclude')));
    return c || { id: null, text: '' };
  });
}
