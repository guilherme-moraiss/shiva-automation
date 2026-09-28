import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.RADAR_DATA_DIR ? path.resolve(process.env.RADAR_DATA_DIR) : path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
for (const d of ['thumbs', 'avatars', 'videos', 'models', 'frames', 'generated', 'posts', 'imported', 'assets']) fs.mkdirSync(path.join(MEDIA_DIR, d), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'radar.db'));
// synchronous = NORMAL is corruption-safe in WAL mode and makes each commit ~50x cheaper (scans, runner logs).
// busy_timeout: a moment when another connection writes (a backup, a test) waits instead of failing with 'database is locked'.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','tiktok')),
  handle TEXT NOT NULL,
  display_name TEXT,
  avatar_path TEXT,
  followers INTEGER,
  platform_user_id TEXT,
  sec_uid TEXT,
  group_name TEXT NOT NULL DEFAULT 'Watchlist',
  starred INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  last_error TEXT,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, handle)
);

CREATE TABLE IF NOT EXISTS reels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  shortcode TEXT,
  url TEXT,
  caption TEXT,
  posted_at INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  duration REAL,
  thumb_url TEXT,
  thumb_path TEXT,
  video_url TEXT,
  video_path TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS reels_posted ON reels(posted_at DESC);
CREATE INDEX IF NOT EXISTS reels_creator ON reels(creator_id);

CREATE TABLE IF NOT EXISTS reel_snapshots (
  reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER
);
CREATE INDEX IF NOT EXISTS reel_snapshots_reel ON reel_snapshots(reel_id, at);

CREATE TABLE IF NOT EXISTS creator_snapshots (
  creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  followers INTEGER
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remake_id INTEGER NOT NULL REFERENCES remakes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'queued',
  -- queued -> imaging -> awaiting_approval -> animating -> review -> approved | rejected | failed | cancelled
  config TEXT NOT NULL DEFAULT '{}',
  analysis TEXT,
  image_prompt TEXT,
  video_prompt TEXT,
  candidates TEXT NOT NULL DEFAULT '[]',
  chosen_image TEXT,
  video_path TEXT,
  step_status TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS generations_stage ON generations(stage);

-- A model's fixed "universe": places (same room every time), props (her phone), wardrobe.
CREATE TABLE IF NOT EXISTS model_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- location | prop | outfit
  subtype TEXT,                  -- location: bedroom | bathroom | kitchen | living | car | gym | outdoor | other
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  path TEXT,
  created_at INTEGER NOT NULL
);

-- Original content made in the Studio (not tied to a scraped reel).
CREATE TABLE IF NOT EXISTS creations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'queued',   -- queued | generating | review | approved | failed | cancelled
  config TEXT NOT NULL DEFAULT '{}',
  candidates TEXT NOT NULL DEFAULT '[]',
  prompt TEXT,
  step_status TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'comfy-cloud',
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, filename)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Lightweight migrations for columns added after v0.1.
const addColumn = (table, col, def) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumn('models', 'persona', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'ref_images', "TEXT NOT NULL DEFAULT '[]'");
addColumn('models', 'body', "TEXT NOT NULL DEFAULT ''"); // body proportions, injected in every prompt
addColumn('models', 'rules', "TEXT NOT NULL DEFAULT ''"); // identity rules, e.g. "no tattoos; freckles on nose and cheeks"
addColumn('models', 'profile', "TEXT NOT NULL DEFAULT ''"); // auto identity profile (JSON) read from her photos
addColumn('models', 'profile_sig', "TEXT NOT NULL DEFAULT ''"); // which photos the profile was read from
addColumn('models', 'rh_lora', "TEXT NOT NULL DEFAULT ''"); // her Z-Image LoRA file name on RunningHub (SKY workflow)
addColumn('models', 'rh_trigger', "TEXT NOT NULL DEFAULT ''"); // trigger word of that LoRA
addColumn('models', 'rh_wan_lora', "TEXT NOT NULL DEFAULT ''"); // her WAN 2.2 (low noise) LoRA on RunningHub, for the Instagirl realism pass (optional)
// Editar imagem / Aumento (Perfis): her own edit prompt, editor and variants; edit_auto = Automático edits the chosen image before the video
addColumn('models', 'edit_prompt', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'edit_engine', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'edit_n', 'INTEGER NOT NULL DEFAULT 2');
addColumn('models', 'edit_auto', 'INTEGER NOT NULL DEFAULT 0');
// Perfis: her default instructions for the image of every remake (added to the built prompt) and her ★ photo (first reference).
addColumn('models', 'image_extra', "TEXT NOT NULL DEFAULT ''");
addColumn('models', 'default_ref', "TEXT NOT NULL DEFAULT ''");
// Perfis: her own person-swap prompt (the reference's per-profile default prompt); '' = the app builds it.
addColumn('models', 'swap_prompt', "TEXT NOT NULL DEFAULT ''");
addColumn('reels', 'frame_path', 'TEXT');
addColumn('reels', 'media_type', "TEXT NOT NULL DEFAULT 'video'"); // video | photo | carousel
addColumn('creators', 'tracked', 'INTEGER NOT NULL DEFAULT 1'); // 0 = only known from a reel the team sent for review: never scanned, not listed
addColumn('reels', 'image_urls', "TEXT NOT NULL DEFAULT '[]'");
addColumn('reels', 'image_paths', "TEXT NOT NULL DEFAULT '[]'");
addColumn('generations', 'kind', "TEXT NOT NULL DEFAULT 'video'"); // video | photo | poses
addColumn('model_assets', 'clean_path', 'TEXT');
addColumn('generations', 'qa', 'TEXT'); // video quality check (JSON)
addColumn('generations', 'archived', 'INTEGER NOT NULL DEFAULT 0'); // 1 = closed by hand: out of the open projects list (Projetos)
addColumn('generations', 'publish', 'TEXT'); // Aprovação: 'normal' | 'trial' once its posts are scheduled
addColumn('generations', 'skipped_at', 'INTEGER'); // Aprovação: "Saltar" sends it to the back of the queue
addColumn('generations', 'kept_at', 'INTEGER'); // Agendados: checked again after scheduling and kept
addColumn('reels', 'preflight', 'TEXT'); // remake suitability check (JSON) // outfit: clothing-only product shot (no person) made from the uploaded photo
addColumn('model_assets', 'garment_desc', "TEXT NOT NULL DEFAULT ''"); // outfit: auto description of the garments (vision)

// Indexes for the per-row subqueries of the lists that the UI polls (remake counts, latest generation, assets).
db.exec(`
CREATE INDEX IF NOT EXISTS remakes_reel ON remakes(reel_id);
CREATE INDEX IF NOT EXISTS remakes_model ON remakes(model_id);
CREATE INDEX IF NOT EXISTS generations_remake ON generations(remake_id);
CREATE INDEX IF NOT EXISTS generations_updated ON generations(updated_at);
CREATE INDEX IF NOT EXISTS model_assets_model ON model_assets(model_id, type);
CREATE INDEX IF NOT EXISTS creations_model ON creations(model_id);
`);

export const now = () => Math.floor(Date.now() / 1000);

const DEFAULT_SETTINGS = {
  fresh_days: '3',
  max_reels_per_creator: '100', // latest posts re-read on every scan
  concurrency: '2',
  auto_scan_hours: '2', // keep creators up to date while the app is open (0 = off)
  groups: JSON.stringify(['Watchlist', 'Priority', 'Competitors', 'Inspiration']),
  instagram_provider: 'native', // native | apify
  tiktok_provider: 'native', // native | apify
  instagram_cookie: '',
  apify_token: '',
  last_full_scan_at: '0',
  auto_download_ftvr: '1', // auto-download reels with views/followers ≥ this after each scan (0 = off)

  // ---- generation pipeline ----
  comfy_mode: 'api', // api (api.comfy.org direct: cloud, credits only) | cloud (Comfy Cloud, paid plan) | local (ComfyUI Desktop)
  comfy_url: 'http://127.0.0.1:8000', // local mode: ComfyUI Desktop default (manual installs use :8188)
  wavespeed_api_key: '', // wavespeed.ai key: the one provider for the images, the edits and the video (27/09)
  comfy_api_key: '', // platform.comfy.org API key — no longer used by the pipeline (WaveSpeed replaced it)
  gemini_api_key: '', // Google AI Studio key — direct Nano Banana + reel analysis
  image_engine: 'comfyui', // comfyui | gemini
  nb_model_comfy: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
  nb_model_gemini: 'gemini-3.1-flash-image',
  nb_resolution: '1K',
  nb_variants: '2',
  analysis_enabled: '1',
  analysis_model: 'gemini-2.5-flash',
  video_engine: 'wan3_copy', // wan3_copy (exact copy, Wan 3.0 + original audio) | wan3 (recreate) | kling_motion | wan27_edit | kling_edit
  kling_mode: 'std', // std | pro
  keep_original_sound: '1',
  keep_outfit: '1',
  first_frame_mode: 'nano', // nano (Nano Banana puts the model in the reel frame) | direct (model photos straight to Wan 3.0)
  wan_model: 'wan3.0-video', // wan3.0-video | wan3.0-video-prime
  wan_mode: 'i2v', // i2v (first frame) | r2v (character image + source video as motion reference)
  wan_resolution: '720P',
  wan_duration: 'auto',
  wan_audio: '1',
  wan_prompt_extend: '1',
  auto_approve_image: '0',
  pipeline_concurrency: '1',
  realism_finish: '1', // "Acabamento realista" on every generated video (reel size, grain, fewer saturated reds)
  // ---- RunningHub: the user's own ComfyUI workflows (see server/pipeline/rhworkflows.js) ----
  rh_api_key: '',
  rh_site: 'ai', // ai = runninghub.ai · cn = runninghub.cn
  rh_instance: 'default', // default 24 GB · plus 48 GB · ultra 84 GB
  rh_wf_wan_animate: '', // workflow ids (or links) saved in the user's RunningHub account
  rh_wf_nb_wan_animate: '',
  rh_wf_sky: '',
  rh_wf_sky_nsfw: '',
  rh_wf_ttt_animator: '',
  rh_wf_animate_x: '',
  rh_wf_faceswap: '',
  rh_wf_instagirl: '',
  rh_wf_zimage: '',
  rh_wf_sdxl_zimage: '',
  rh_wf_sdxl_wan: '',
  rh_wf_detailing: '',
  rh_wf_inpaint: '',
  rh_max_secs: '30', // longest part of a reel sent to the video workflows
  frame_engine: '', // her image in the reel frame / post, when chosen in Definições: nano | nanopro | wan27 | seedream | flux | sky | faceswap. Empty = Nano Banana Pro (the reference's swap)
  // ---- Aprovação / agenda of posts ----
  sched_normal_gap: '2', // hours between two normal posts on the same account
  sched_trial_gap: '2', // hours between two trial reels on the same Instagram account
  sched_tz: 'Europe/Lisbon', // time zone the agenda is shown and typed in
  fal_api_key: '', // fal.ai key for Conteúdo 18+ (open-weight models: Z-Image LoRA, Wan 2.2)
};

export const SECRET_KEYS = ['instagram_cookie', 'apify_token', 'wavespeed_api_key', 'comfy_api_key', 'gemini_api_key', 'fal_api_key', 'rh_api_key'];

// Settings are read many times per request and by every worker tick: keep them in memory.
// setSetting() is the only writer, and it drops the cache.
let settingsCache = null;
export function getSettings() {
  if (!settingsCache) {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
    settingsCache = out;
  }
  return { ...settingsCache };
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
  settingsCache = null;
}

export function getGroups() {
  try { return JSON.parse(getSettings().groups); } catch { return ['Watchlist']; }
}
