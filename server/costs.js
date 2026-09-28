import { db, now, getSettings, setSetting } from './db.js';
import { route, int, HttpError } from './http.js';

/**
 * Custos: one row per paid step, so spend can be read per day, provider, AI model and kind of work.
 *   provider — comfy (Comfy API credits: Nano Banana, Flux.2, Seedream, Wan 3.0, Kling, Gemini QA) | gemini (direct key)
 *              | fal | runninghub
 *   category — imagem | video | roupa | edicao | estudio | adulto | treino | caras
 *   estimated — 1 when the amount comes from the app's price table (Comfy/fal do not return the bill per request);
 *               0 when the provider reported it (RunningHub).
 * Projects made before this ledger existed are added once, with their total on the day they were created.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  provider TEXT NOT NULL,
  category TEXT NOT NULL,
  generation_id INTEGER,
  creation_id INTEGER,
  spicy_job_id INTEGER,
  model_id INTEGER,
  user TEXT,
  estimated INTEGER NOT NULL DEFAULT 1,
  note TEXT
);
CREATE INDEX IF NOT EXISTS costs_at ON costs(at);
`);
// Equipa: the person who started (or last redid) the paid job.
if (!db.prepare('PRAGMA table_info(costs)').all().some((c) => c.name === 'worker_id')) db.exec('ALTER TABLE costs ADD COLUMN worker_id INTEGER');
// How much work a cost was: images (or edits) made, or seconds of video. Empty for the costs from before.
if (!db.prepare('PRAGMA table_info(costs)').all().some((c) => c.name === 'units')) db.exec('ALTER TABLE costs ADD COLUMN units REAL');
// The balance read from each provider (Comfy, RunningHub) about every 5 minutes: its drops are the real spend.
db.exec('CREATE TABLE IF NOT EXISTS balance_snapshots (at INTEGER NOT NULL, provider TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT \'USD\')');
db.exec('CREATE INDEX IF NOT EXISTS balance_snapshots_at ON balance_snapshots(provider, at)');

/** Keeps a balance reading (at most one every 4 minutes per provider). */
export function recordBalance(provider, amount, currency = 'USD') {
  const a = Number(amount);
  if (!Number.isFinite(a)) return;
  const last = db.prepare('SELECT at FROM balance_snapshots WHERE provider = ? ORDER BY at DESC LIMIT 1').get(provider);
  if (last && now() - last.at < 240) return;
  db.prepare('INSERT INTO balance_snapshots (at, provider, amount, currency) VALUES (?, ?, ?, ?)').run(now(), provider, a, currency);
}

const modelOfGeneration = (id) => db.prepare('SELECT m.model_id FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE g.id = ?').get(id)?.model_id ?? null;

/** The person answering for a job (set by the Equipa log when they started or redid it), read when the cost comes in. */
function workerOfJob({ generationId, creationId, spicyJobId }) {
  const [table, id] = generationId ? ['generations', generationId] : creationId ? ['creations', creationId] : spicyJobId ? ['spicy_jobs', spicyJobId] : [];
  if (!table) return null;
  try { return db.prepare(`SELECT worker_id FROM ${table} WHERE id = ?`).get(id)?.worker_id ?? null; } catch { return null; } // column added by team.js
}

export function recordCost({ amount, currency = 'USD', provider, category, generationId = null, creationId = null, spicyJobId = null, modelId = undefined, workerId = undefined, user = null, estimated = true, note = null, at = null, units = null }) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return;
  const model = modelId !== undefined ? modelId : generationId ? modelOfGeneration(generationId) : null;
  const worker = workerId !== undefined ? workerId : workerOfJob({ generationId, creationId, spicyJobId });
  db.prepare(`INSERT INTO costs (at, amount, currency, provider, category, generation_id, creation_id, spicy_job_id, model_id, user, worker_id, estimated, note, units)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at ?? now(), a, currency, provider, category, generationId, creationId, spicyJobId, model, user, worker, estimated ? 1 : 0, note, Number.isFinite(Number(units)) && units !== null ? Number(units) : null);
}

/** RunningHub bills in the account's currency: dollars on runninghub.ai, yuan on runninghub.cn. */
export const rhCurrency = (s = getSettings()) => (s.rh_site === 'cn' ? 'CNY' : 'USD');

// Once: projects, Studio creations and 18+ jobs paid before the ledger existed (their total, on the day they started).
if (getSettings().costs_backfilled !== '1') {
  const t = now();
  db.exec('BEGIN');
  try {
    for (const g of db.prepare('SELECT g.id, g.cost_usd, g.created_at, m.model_id FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE g.cost_usd > 0').all()) {
      recordCost({ amount: g.cost_usd, provider: 'comfy', category: 'remake', generationId: g.id, modelId: g.model_id, workerId: null, at: g.created_at, note: 'Project total before daily tracking' });
    }
    for (const c of db.prepare('SELECT id, cost_usd, created_at, model_id FROM creations WHERE cost_usd > 0').all()) {
      recordCost({ amount: c.cost_usd, provider: 'comfy', category: 'estudio', creationId: c.id, modelId: c.model_id, workerId: null, at: c.created_at, note: 'Total before daily tracking' });
    }
    const spicy = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spicy_jobs'").get();
    if (spicy) {
      for (const j of db.prepare('SELECT id, cost_usd, created_at, model_id, kind FROM spicy_jobs WHERE cost_usd > 0').all()) {
        recordCost({ amount: j.cost_usd, provider: 'fal', category: j.kind === 'train' ? 'treino' : 'adulto', spicyJobId: j.id, modelId: j.model_id, workerId: null, at: j.created_at, note: 'Total before daily tracking' });
      }
    }
    db.exec('COMMIT');
    setSetting('costs_backfilled', '1');
    console.log(`  Costs: history imported (${t})`);
  } catch (e) { db.exec('ROLLBACK'); console.error('Costs: could not import the history', e.message); }
}

// ---- Custos page ---------------------------------------------------------------------------------------------------
const PROVIDERS = { wavespeed: 'WaveSpeed', comfy: 'Comfy API (before)', gemini: 'Gemini (Google)', fal: 'fal.ai', runninghub: 'RunningHub' };
const CATEGORIES = { imagem: 'Her images', video: 'Videos', roupa: 'Chosen outfit', remake: 'Projects (before daily tracking)', estudio: 'Create content', adulto: '18+ content', treino: 'LoRA training', caras: 'Face generator', edicao: 'Image edits', final: 'Final (Topaz)' };

/** "2026-09-27" of instant `sec` in `zone`. */
function dayKey(sec, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(sec * 1000)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function registerCostRoutes() {
  // Spend between two instants: per day (in the agenda's time zone) and provider, and broken down by model, kind of work
  // and project. Amounts in another currency (a RunningHub account in yuan) are kept apart, never added to dollars.
  route('GET', '/api/usage', (req, { query }) => {
    const to = int(query.get('to'), now());
    const from = int(query.get('from'), to - 30 * 86400);
    if (!(to > from) || to - from > 400 * 86400) throw new HttpError(400, 'Invalid date range');
    const zone = getSettings().sched_tz || 'Europe/Lisbon';
    const team = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workers'").get();
    const rows = db.prepare(`SELECT c.*, md.name AS model_name${team ? ', w.name AS worker_name' : ''} FROM costs c LEFT JOIN models md ON md.id = c.model_id
      ${team ? 'LEFT JOIN workers w ON w.id = c.worker_id' : ''} WHERE c.at >= ? AND c.at < ? ORDER BY c.at`).all(from, to);
    const hasTeam = team && db.prepare('SELECT 1 FROM workers LIMIT 1').get();
    const usd = rows.filter((r) => r.currency === 'USD');
    const sum = (list) => Math.round(list.reduce((a, r) => a + r.amount, 0) * 10000) / 10000;
    const group = (list, key, label) => {
      const m = new Map();
      for (const r of list) {
        const k = key(r);
        const g = m.get(k) || { key: k, label: label(r, k), amount: 0, n: 0 };
        g.amount += r.amount; g.n++;
        m.set(k, g);
      }
      return [...m.values()].map((g) => ({ ...g, amount: Math.round(g.amount * 10000) / 10000 })).sort((a, b) => b.amount - a.amount);
    };
    // Every day of the range, even the ones without spend (the chart shows the gaps).
    const days = [];
    for (let t = from; t < to && days.length < 400; t += 86400) { const k = dayKey(t, zone); if (!days.includes(k)) days.push(k); }
    const lastKey = dayKey(to - 1, zone);
    if (!days.includes(lastKey)) days.push(lastKey);
    const perDay = days.map((d) => ({ day: d, total: 0, byProvider: {} }));
    const idx = new Map(perDay.map((d, i) => [d.day, i]));
    for (const r of usd) {
      const d = perDay[idx.get(dayKey(r.at, zone))];
      if (!d) continue;
      d.total += r.amount;
      d.byProvider[r.provider] = (d.byProvider[r.provider] || 0) + r.amount;
    }
    perDay.forEach((d) => { d.total = Math.round(d.total * 10000) / 10000; });
    const projects = new Set(usd.filter((r) => r.generation_id).map((r) => r.generation_id));
    const jobs = usd.filter((r) => r.generation_id || r.creation_id || r.spicy_job_id).map((r) => (r.generation_id ? `g${r.generation_id}` : r.creation_id ? `c${r.creation_id}` : `s${r.spicy_job_id}`));
    const total = sum(usd);
    const top = group(usd.filter((r) => r.generation_id), (r) => r.generation_id, () => '').slice(0, 10);
    const handles = top.length ? db.prepare(`SELECT g.id, c.handle, g.stage FROM generations g JOIN remakes m ON m.id = g.remake_id JOIN reels r ON r.id = m.reel_id JOIN creators c ON c.id = r.creator_id
      WHERE g.id IN (${top.map(() => '?').join(',')})`).all(...top.map((t) => t.key)) : [];
    // Day by day per person: images and edits made, videos (and their seconds), and the money; the day's budget.
    const budgets = team ? new Map(db.prepare('SELECT id, daily_budget FROM workers').all().map((w) => [w.id, w.daily_budget || 0])) : new Map();
    const pd = new Map();
    for (const r of usd) {
      const k = `${dayKey(r.at, zone)}|${r.worker_id || 0}`;
      const x = pd.get(k) || { day: dayKey(r.at, zone), worker: r.worker_id || 0, name: r.worker_name || (r.worker_id ? 'Deleted person' : hasTeam ? 'No person selected' : 'You'), images: 0, edits: 0, videos: 0, seconds: 0, amount: 0 };
      const u = Number(r.units) || 0;
      if (r.category === 'imagem') x.images += u;
      else if (r.category === 'edicao') x.edits += u;
      else if (r.category === 'video') { x.videos += 1; x.seconds += u; }
      x.amount += r.amount;
      pd.set(k, x);
    }
    const byUserDay = [...pd.values()].map((x) => ({ ...x, amount: Math.round(x.amount * 10000) / 10000, budget: budgets.get(x.worker) || 0 }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.amount - a.amount));
    // The real spend: the drops between two balance readings (a rise is a top-up and is ignored), per day and provider.
    const snaps = db.prepare("SELECT at, provider, amount FROM balance_snapshots WHERE currency = 'USD' AND at >= ? AND at < ? ORDER BY provider, at").all(from - 3600, to);
    const real = new Map();
    let realFrom = null;
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1]; const b = snaps[i];
      if (a.provider !== b.provider || b.at < from) continue;
      realFrom = realFrom == null ? a.at : Math.min(realFrom, a.at);
      const drop = a.amount - b.amount;
      if (drop <= 0) continue;
      const d = dayKey(b.at, zone);
      const x = real.get(d) || { day: d, total: 0, byProvider: {} };
      x.total += drop;
      x.byProvider[b.provider] = (x.byProvider[b.provider] || 0) + drop;
      real.set(d, x);
    }
    const realByDay = [...real.values()].map((x) => ({ ...x, total: Math.round(x.total * 10000) / 10000 }));
    const realTotal = Math.round(realByDay.reduce((a, x) => a + x.total, 0) * 10000) / 10000;
    return {
      from, to, zone, providers: PROVIDERS,
      total,
      byUserDay,
      unitsSince: db.prepare('SELECT MIN(at) t FROM costs WHERE units IS NOT NULL').get()?.t ?? null,
      real: { byDay: realByDay, total: realTotal, since: realFrom },
      perDayAvg: Math.round((total / Math.max(1, days.length)) * 10000) / 10000,
      paidJobs: new Set(jobs).size,
      avgPerProject: projects.size ? Math.round((sum(usd.filter((r) => r.generation_id)) / projects.size) * 10000) / 10000 : 0,
      estimatedShare: total ? Math.round((sum(usd.filter((r) => r.estimated)) / total) * 100) : 0,
      days: perDay,
      byProvider: group(usd, (r) => r.provider, (r) => PROVIDERS[r.provider] || r.provider),
      byCategory: group(usd, (r) => r.category, (r) => CATEGORIES[r.category] || r.category),
      byModel: group(usd, (r) => r.model_id || 0, (r) => r.model_name || 'No model'),
      byUser: group(usd, (r) => r.worker_id || 0, (r) => r.worker_name || (r.worker_id ? 'Deleted person' : hasTeam ? 'No person selected' : 'You (no team yet)')),
      hasTeam: !!hasTeam,
      topProjects: top.map((t) => ({ ...t, handle: handles.find((x) => x.id === t.key)?.handle || null, stage: handles.find((x) => x.id === t.key)?.stage || null })),
      otherCurrencies: group(rows.filter((r) => r.currency !== 'USD'), (r) => r.currency, (r) => r.currency),
    };
  });
}
