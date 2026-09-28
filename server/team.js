import { db, now, getSettings } from './db.js';
import { route, readBody, int, HttpError } from './http.js';

/**
 * Equipa: the people who work on the operation, what each one did and for how long.
 * There are no logins yet (the app only answers on this computer): each person picks their name in "A trabalhar como"
 * and the browser sends it with every request (X-Worker header). The server then:
 *   - logs the work actions (the routes in ACTIONS), with the project and the model they touched;
 *   - counts time from presence: the open app pings once a minute while it is visible and in use, one row per person and
 *     minute (two tabs never count twice); minutes less than SESSION_GAP apart make one session;
 *   - gives the spend of a project, a Criar conteúdo creation, an 18+ job or a face job to whoever started or last redid
 *     it (costs.worker_id, filled by recordCost).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'va',
  color TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  generation_id INTEGER,
  model_id INTEGER,
  target TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS activity_worker_at ON activity(worker_id, at);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
CREATE TABLE IF NOT EXISTS presence (
  worker_id INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  view TEXT,
  PRIMARY KEY (worker_id, minute)
) WITHOUT ROWID;
`);

// Who started (or last redid) each paid job: its costs are theirs. Imported after the modules that create these tables.
for (const t of ['generations', 'creations', 'spicy_jobs', 'face_jobs']) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'worker_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN worker_id INTEGER`);
}

export const ROLES = { admin: 'Administrator', va: 'Assistant' };
const SESSION_GAP = 6; // minutes: a shorter pause is the same session
const NOW_WINDOW = 3; // minutes: seen this recently = "a trabalhar agora"

/** The person named in the request's X-Worker header (an active one), or null. */
export function workerOf(req) {
  const id = int(req.headers['x-worker']);
  if (!id) return null;
  return db.prepare('SELECT id, name FROM workers WHERE id = ? AND active = 1').get(id) || null;
}

function markPresent(workerId, at, view) {
  db.prepare(`INSERT INTO presence (worker_id, minute, view) VALUES (?, ?, ?)
    ON CONFLICT(worker_id, minute) DO UPDATE SET view = COALESCE(excluded.view, presence.view)`).run(workerId, Math.floor(at / 60), view);
}

// ---- what counts as work --------------------------------------------------------------------------------------------
// "METHOD /pattern" → act: the action name (or a function of { params, body, out }; null = not logged)
//   gen: where the project is — 'param' (:id), 'out' (the new project returned), 'post' (:id is a post)
//   target: what else was acted on (a reel, a post…), so an undo finds the action it cancels
//   undoes: when act is 'undo', the actions it cancels (the latest one on the same project or target is marked undone)
//   owns: the paid job this person now answers for — a table (its id is the project) or a function → [table, id]
//   model / meta: extra details for the log
const param = (c) => int(c.params.id);
const outId = (c) => int(c.out?.id);
const modelOf = (table, id) => (id ? db.prepare(`SELECT model_id FROM ${table} WHERE id = ?`).get(id)?.model_id ?? null : null);
const DECISIONS = ['normal', 'trial', 'skip', 'reject'];

const ACTIONS = {
  // Projetos
  'POST /api/reels/:id/remake': { act: 'project', gen: 'out', owns: 'generations' },
  'POST /api/remakes/:id/generate': { act: 'project', gen: 'out', owns: 'generations' },
  'POST /api/generations/:id/poses': { act: 'variants', gen: 'param', owns: (c) => ['generations', outId(c)] },
  'POST /api/generations/:id/choose': { act: 'image', gen: 'param', owns: 'generations' },
  'POST /api/generations/:id/pick': { act: 'image', gen: 'param', owns: 'generations', meta: (c) => (c.body.skipEnlarge ? { skipEnlarge: true } : c.out?.enlarging ? { enlarge: c.out.enlarging.n } : null) },
  'POST /api/generations/:id/enlarge': { act: 'image_edit', gen: 'param', owns: 'generations', meta: (c) => ({ preset: 'enlarge', engine: c.out?.engine || null, n: c.out?.n || null }) },
  'POST /api/generations/:id/final': { act: 'enlarge_pick', gen: 'param' },
  'POST /api/generations/:id/video': { act: 'video_start', gen: 'param', owns: 'generations' },
  'POST /api/generations/:id/topaz': { act: 'topaz', gen: 'param', owns: 'generations' },
  'POST /api/generations/:id/topaz/undo': { act: 'undo', gen: 'param', undoes: ['topaz'] },
  'POST /api/generations/:id/edit-image': { act: 'image_edit', gen: 'param', owns: 'generations', meta: (c) => ({ preset: c.body.preset || null, engine: c.body.engine || null, n: c.out?.candidates?.length || null }) },
  'POST /api/generations/:id/retry': { act: 'redo', gen: 'param', owns: 'generations', meta: (c) => ({ from: c.body.from || null }) },
  'POST /api/generations/:id/stage': { act: (c) => ({ approved: 'video_ok', rejected: 'reject', cancelled: 'cancel', review: 'reopen' })[c.body.stage] || null, gen: 'param' },
  'DELETE /api/generations/:id': { act: 'delete', gen: 'param' },
  'POST /api/projects/:id/archive': { act: (c) => (c.body.archived === false ? 'unarchive' : 'archive'), gen: 'param' },
  'POST /api/projects/:id/trim': { act: 'trim', gen: 'param' },
  'POST /api/projects/:id/trim/reset': { act: 'trim_reset', gen: 'param' },
  // Aprovação, Agendados, Calendário
  'POST /api/approval/:id/decide': { act: (c) => (DECISIONS.includes(c.body.action) ? c.body.action : null), gen: 'param', meta: (c) => (c.out?.posts ? { posts: c.out.posts.length } : null) },
  'POST /api/approval/:id/undo': { act: 'undo', gen: 'param', undoes: DECISIONS },
  'POST /api/scheduled/:id/keep': { act: (c) => (c.body.undo ? 'undo' : 'keep'), gen: 'param', undoes: ['keep'] },
  'POST /api/scheduled/:id/pull': { act: 'pull', gen: 'param' },
  'POST /api/scheduled/:id/to-trial': { act: 'to_trial', gen: 'param' },
  'PATCH /api/posts/:id': { act: 'reschedule', gen: 'post', target: (c) => `post:${param(c)}` },
  'DELETE /api/posts/:id': { act: 'unschedule', gen: 'post', target: (c) => `post:${param(c)}` },
  'POST /api/posts/:id/posted': { act: (c) => (c.body.undo ? 'undo' : 'posted'), gen: 'post', target: (c) => `post:${param(c)}`, undoes: ['posted'] },
  // Radar
  'POST /api/discover/:id/decide': { act: (c) => (c.body.decision === 'keep' ? 'discover_keep' : 'discover_pass'), target: (c) => `reel:${param(c)}` },
  'POST /api/discover/:id/undo': { act: 'undo', target: (c) => `reel:${param(c)}`, undoes: ['discover_keep', 'discover_pass'] },
  'POST /api/review/submit': { act: 'review_submit', meta: (c) => ({ n: c.out?.added || 0 }) },
  'POST /api/review/:id/decide': { act: (c) => (c.body.decision === 'keep' ? 'review_keep' : 'review_push'), target: (c) => `review:${param(c)}` },
  'POST /api/review/:id/undo': { act: 'undo', target: (c) => `review:${param(c)}`, undoes: ['review_keep', 'review_push'] },
  'POST /api/launch-links': { act: 'link_saved' },
  'POST /api/review/gallery/queue': { act: 'launch', model: (c) => c.body.modelId, meta: (c) => ({ n: c.out?.added || 0 }) },
  'POST /api/launch-links/launch': { act: 'launch', model: (c) => c.body.modelId, meta: (c) => ({ n: c.out?.added || 0 }) },
  'POST /api/carousels': { act: 'carousel_added' },
  // Geração
  'POST /api/creations': { act: 'creation', model: (c) => c.out?.model_id, owns: (c) => ['creations', outId(c)] },
  'POST /api/creations/:id/again': { act: 'creation_again', model: (c) => modelOf('creations', param(c)), owns: (c) => ['creations', param(c)] },
  'POST /api/spicy/images': { act: 'adult', model: (c) => c.out?.model_id, owns: (c) => ['spicy_jobs', outId(c)] },
  'POST /api/spicy/videos': { act: 'adult', model: (c) => c.out?.model_id, owns: (c) => ['spicy_jobs', outId(c)] },
  'POST /api/spicy/tools': { act: 'adult', model: (c) => c.out?.model_id, owns: (c) => ['spicy_jobs', outId(c)] },
  'POST /api/spicy/jobs/:id/retry': { act: 'redo_adult', model: (c) => modelOf('spicy_jobs', param(c)), owns: (c) => ['spicy_jobs', param(c)] },
  'POST /api/spicy/models/:id/train': { act: 'train', model: param, owns: (c) => ['spicy_jobs', outId(c)] },
  'POST /api/faces/jobs': { act: 'faces_job', owns: (c) => ['face_jobs', outId(c)], meta: (c) => ({ n: c.out?.n || null }) },
  'POST /api/faces/:id/verdict': { act: 'face_verdict', target: (c) => `face:${param(c)}`, meta: (c) => ({ verdict: c.out?.verdict || null }) },
  'POST /api/faces/:id/create-model': { act: 'model_created', model: (c) => c.out?.model?.id, meta: (c) => ({ name: c.out?.model?.name || null }) },
  // Perfis
  'POST /api/models/:id/accounts': { act: 'accounts', model: param },
  'POST /api/models/:id/duplicate': { act: 'model_created', model: (c) => c.out?.id, meta: (c) => ({ name: c.out?.name || null }) },
  'PATCH /api/accounts/:id': { act: 'accounts', model: (c) => modelOf('accounts', param(c)) },
  'DELETE /api/accounts/:id': { act: 'accounts' },
  'POST /api/models/:id/captions': { act: 'captions', model: param },
  'PATCH /api/captions/:id': { act: 'captions', model: (c) => modelOf('captions', param(c)) },
  'DELETE /api/captions/:id': { act: 'captions' },
};
const OWN_TABLES = new Set(['generations', 'creations', 'spicy_jobs', 'face_jobs']);
const modelOfGen = (id) => (id ? db.prepare('SELECT m.model_id FROM generations g JOIN remakes m ON m.id = g.remake_id WHERE g.id = ?').get(id)?.model_id ?? null : null);

/** Before a route runs: is this work to log? Reads what a delete would take away (the post's project, the model). */
export function beforeAction(req, r, params) {
  if (!req.worker || r.method === 'GET') return null;
  const spec = ACTIONS[`${r.method} ${r.pattern}`];
  if (!spec) return null;
  try {
    let gen = null;
    if (spec.gen === 'param') gen = int(params.id);
    else if (spec.gen === 'post') gen = db.prepare('SELECT generation_id FROM posts WHERE id = ?').get(params.id)?.generation_id ?? null;
    return { worker: req.worker, spec, params, gen, model: gen ? modelOfGen(gen) : null };
  } catch (e) {
    console.error('Team: could not prepare the action log entry', e.message);
    return null;
  }
}

/** After the route succeeded: log it. Never fails the request. */
export function afterAction(ctx, req, out) {
  try {
    const c = { params: ctx.params, body: req.body || {}, out };
    const { spec } = ctx;
    const act = typeof spec.act === 'function' ? spec.act(c) : spec.act;
    if (!act) return;
    const gen = spec.gen === 'out' ? outId(c) : ctx.gen;
    const model = spec.model ? int(spec.model(c)) : ctx.model ?? modelOfGen(gen);
    const target = spec.target ? spec.target(c) : null;
    const meta = spec.meta ? spec.meta(c) : null;
    const t = now();
    if (act === 'undo' && spec.undoes && (target || gen)) {
      const prev = db.prepare(`SELECT id FROM activity WHERE undone = 0 AND action IN (${spec.undoes.map(() => '?').join(',')})
        AND ${target ? 'target' : 'generation_id'} = ? ORDER BY id DESC LIMIT 1`).get(...spec.undoes, target || gen);
      if (prev) db.prepare('UPDATE activity SET undone = 1 WHERE id = ?').run(prev.id);
    }
    db.prepare('INSERT INTO activity (at, worker_id, action, generation_id, model_id, target, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t, ctx.worker.id, act, gen || null, model || null, target, meta ? JSON.stringify(meta) : null);
    const own = typeof spec.owns === 'function' ? spec.owns(c) : spec.owns ? [spec.owns, gen] : null;
    if (own && OWN_TABLES.has(own[0]) && own[1]) db.prepare(`UPDATE ${own[0]} SET worker_id = ? WHERE id = ?`).run(ctx.worker.id, own[1]);
    markPresent(ctx.worker.id, t, null);
  } catch (e) {
    console.error('Team: could not log the action', e.message);
  }
}

// ---- stats --------------------------------------------------------------------------------------------------------
// What each person may spend per day (0 = no limit): Custos paints the days over it.
if (!db.prepare('PRAGMA table_info(workers)').all().some((c) => c.name === 'daily_budget')) db.exec('ALTER TABLE workers ADD COLUMN daily_budget REAL NOT NULL DEFAULT 0');

function peopleRows() {
  return db.prepare('SELECT id, name, role, color, active, created_at, daily_budget FROM workers ORDER BY active DESC, name COLLATE NOCASE').all();
}

function lastSeen() {
  return new Map(db.prepare('SELECT worker_id, MAX(minute) m FROM presence GROUP BY worker_id').all().map((r) => [r.worker_id, r.m * 60]));
}

/** Per person and day (agenda time zone): first and last minute, minutes, sessions, actions and spend. Newest first. */
function perDay(from, to) {
  const zone = getSettings().sched_tz || 'Europe/Lisbon';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = (sec) => fmt.format(new Date(sec * 1000));
  const out = new Map(); // worker → Map(day → row)
  const row = (w, d) => {
    if (!out.has(w)) out.set(w, new Map());
    const m = out.get(w);
    if (!m.has(d)) m.set(d, { day: d, first: null, last: null, minutes: 0, sessions: 0, actions: 0, spent: 0, _prev: null });
    return m.get(d);
  };
  for (const p of db.prepare('SELECT worker_id, minute FROM presence WHERE minute >= ? AND minute < ? ORDER BY worker_id, minute').all(Math.floor(from / 60), Math.ceil(to / 60))) {
    const r = row(p.worker_id, dayOf(p.minute * 60));
    if (r.first === null) r.first = p.minute * 60;
    r.last = p.minute * 60 + 59;
    r.minutes++;
    if (r._prev === null || p.minute - r._prev > SESSION_GAP) r.sessions++;
    r._prev = p.minute;
  }
  for (const a of db.prepare('SELECT worker_id, at FROM activity WHERE at >= ? AND at < ?').all(from, to)) row(a.worker_id, dayOf(a.at)).actions++;
  for (const c of db.prepare("SELECT worker_id, at, amount FROM costs WHERE currency = 'USD' AND worker_id IS NOT NULL AND at >= ? AND at < ?").all(from, to)) row(c.worker_id, dayOf(c.at)).spent += c.amount;
  const res = new Map();
  for (const [w, m] of out) {
    res.set(w, [...m.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 62).map(({ _prev, spent, ...r }) => ({ ...r, spent: Math.round(spent * 10000) / 10000 })));
  }
  return res;
}

function teamStats(from, to) {
  const f = Math.floor(from / 60);
  const tm = Math.ceil(to / 60);
  const nowMin = Math.floor(now() / 60);
  const seen = lastSeen();
  const time = new Map(db.prepare(`SELECT worker_id, COUNT(*) minutes, MIN(minute) first, MAX(minute) last,
      SUM(CASE WHEN prev IS NULL OR minute - prev > ? THEN 1 ELSE 0 END) sessions
    FROM (SELECT worker_id, minute, LAG(minute) OVER (PARTITION BY worker_id ORDER BY minute) prev FROM presence WHERE minute >= ? AND minute < ?)
    GROUP BY worker_id`).all(SESSION_GAP, f, tm).map((r) => [r.worker_id, r]));
  const byView = db.prepare('SELECT worker_id, view, COUNT(*) minutes FROM presence WHERE minute >= ? AND minute < ? GROUP BY worker_id, view ORDER BY minutes DESC').all(f, tm);
  const counts = db.prepare('SELECT worker_id, action, COUNT(*) n, SUM(undone) undone FROM activity WHERE at >= ? AND at < ? GROUP BY worker_id, action').all(from, to);
  const byModel = db.prepare(`SELECT a.worker_id, a.model_id, md.name, md.color, COUNT(*) actions, SUM(CASE WHEN a.action = 'project' THEN 1 ELSE 0 END) projects
    FROM activity a LEFT JOIN models md ON md.id = a.model_id WHERE a.at >= ? AND a.at < ? AND a.model_id IS NOT NULL
    GROUP BY a.worker_id, a.model_id ORDER BY actions DESC`).all(from, to);
  const spent = new Map(db.prepare(`SELECT worker_id, SUM(amount) s FROM costs WHERE currency = 'USD' AND worker_id IS NOT NULL AND at >= ? AND at < ?
    GROUP BY worker_id`).all(from, to).map((r) => [r.worker_id, Math.round(r.s * 10000) / 10000]));
  const days = perDay(from, to);
  const people = peopleRows().map((w) => {
    const t = time.get(w.id);
    const mine = counts.filter((x) => x.worker_id === w.id);
    const last = seen.get(w.id) || null;
    return {
      ...w,
      dailyBudget: w.daily_budget || 0, // the Equipa edit form reads this name (as /api/team/people)
      active: !!w.active,
      working: !!last && last / 60 >= nowMin - NOW_WINDOW,
      lastSeen: last,
      minutes: t?.minutes || 0,
      sessions: t?.sessions || 0,
      first: t ? t.first * 60 : null,
      last: t ? t.last * 60 + 59 : null,
      actions: mine.reduce((a, x) => a + x.n, 0),
      // Actions that stood (an undone decision is not counted in its kind; the undo itself is counted as "undo").
      counts: Object.fromEntries(mine.map((x) => [x.action, x.n - (x.undone || 0)]).filter(([, n]) => n > 0)),
      spent: spent.get(w.id) || 0,
      byView: byView.filter((x) => x.worker_id === w.id).map(({ view, minutes }) => ({ view, minutes })),
      byModel: byModel.filter((x) => x.worker_id === w.id).map(({ model_id, name, color, actions, projects }) => ({ id: model_id, name: name || 'Deleted model', color, actions, projects })),
      days: days.get(w.id) || [],
    };
  });
  // Removed people only show when they worked in this period.
  const shown = people.filter((p) => p.active || p.minutes || p.actions);
  return {
    from, to,
    people: shown,
    totals: {
      minutes: shown.reduce((a, p) => a + p.minutes, 0),
      actions: shown.reduce((a, p) => a + p.actions, 0),
      spent: Math.round(shown.reduce((a, p) => a + p.spent, 0) * 10000) / 10000,
      working: shown.filter((p) => p.working).length,
    },
  };
}

const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const cleanColor = (s) => (/^#[0-9a-f]{6}$/i.test(String(s || '')) ? String(s).toLowerCase() : '');

export function registerTeamRoutes() {
  // The names for "A trabalhar como" (active people only).
  route('GET', '/api/team/people', () => {
    const seen = lastSeen();
    const nowMin = Math.floor(now() / 60);
    return peopleRows().filter((w) => w.active).map((w) => ({ id: w.id, name: w.name, role: w.role, color: w.color, dailyBudget: w.daily_budget || 0, working: (seen.get(w.id) || 0) / 60 >= nowMin - NOW_WINDOW }));
  });

  route('POST', '/api/team/people', async (req) => {
    const b = await readBody(req);
    const name = cleanName(b.name);
    if (!name) throw new HttpError(400, "Write the person's name");
    const role = ROLES[b.role] ? b.role : 'va';
    const prev = db.prepare('SELECT * FROM workers WHERE name = ?').get(name);
    if (prev?.active) throw new HttpError(409, `There is already a person named ${prev.name}`);
    // Someone removed before and added again keeps their history.
    if (prev) {
      db.prepare('UPDATE workers SET active = 1, role = ?, color = ? WHERE id = ?').run(role, cleanColor(b.color) || prev.color, prev.id);
      return { id: prev.id, restored: true };
    }
    return db.prepare('INSERT INTO workers (name, role, color, created_at) VALUES (?, ?, ?, ?) RETURNING id').get(name, role, cleanColor(b.color), now());
  });

  route('PATCH', '/api/team/people/:id', async (req, { params }) => {
    const b = await readBody(req);
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(params.id);
    if (!w) throw new HttpError(404, 'This person no longer exists');
    const name = b.name !== undefined ? cleanName(b.name) : w.name;
    if (!name) throw new HttpError(400, 'The name cannot be empty');
    const other = db.prepare('SELECT id FROM workers WHERE name = ? AND id != ?').get(name, w.id);
    if (other) throw new HttpError(409, `There is already a person named ${name}`);
    const role = b.role !== undefined ? (ROLES[b.role] ? b.role : w.role) : w.role;
    const color = b.color !== undefined ? cleanColor(b.color) : w.color;
    const budget = b.dailyBudget !== undefined ? Math.max(0, Math.min(10000, Number(b.dailyBudget) || 0)) : w.daily_budget || 0;
    db.prepare('UPDATE workers SET name = ?, role = ?, color = ?, daily_budget = ? WHERE id = ?').run(name, role, color, budget, w.id);
    return { ok: true };
  });

  // Remove: someone who never worked is deleted; someone with history is only hidden (their hours and actions stay).
  route('DELETE', '/api/team/people/:id', (req, { params }) => {
    const w = db.prepare('SELECT id FROM workers WHERE id = ?').get(params.id);
    if (!w) return { ok: true, removed: 'none' };
    const worked = db.prepare('SELECT 1 FROM activity WHERE worker_id = ? LIMIT 1').get(w.id) || db.prepare('SELECT 1 FROM presence WHERE worker_id = ? LIMIT 1').get(w.id);
    if (worked) {
      db.prepare('UPDATE workers SET active = 0 WHERE id = ?').run(w.id);
      return { ok: true, removed: 'hidden' };
    }
    db.prepare('DELETE FROM workers WHERE id = ?').run(w.id);
    return { ok: true, removed: 'deleted' };
  });

  // The open app, once a minute while it is in use: this minute counts as work time for this person.
  route('POST', '/api/team/ping', async (req) => {
    const b = await readBody(req);
    if (!req.worker) return { ok: false };
    const view = /^[a-z]{1,20}$/.test(String(b.view || '')) ? b.view : null;
    markPresent(req.worker.id, now(), view);
    return { ok: true };
  });

  route('GET', '/api/team', (req, { query }) => {
    const to = int(query.get('to'), now());
    const from = Math.max(0, int(query.get('from'), to - 7 * 86400));
    if (!(to > from)) throw new HttpError(400, 'Invalid date range');
    return teamStats(from, to);
  });

  // What was done, newest first (one person or everyone).
  route('GET', '/api/team/activity', (req, { query }) => {
    const limit = Math.max(1, Math.min(200, int(query.get('limit'), 40)));
    const where = [];
    const args = [];
    if (int(query.get('worker'))) { where.push('a.worker_id = ?'); args.push(int(query.get('worker'))); }
    if (int(query.get('before'))) { where.push('a.id < ?'); args.push(int(query.get('before'))); }
    const rows = db.prepare(`SELECT a.id, a.at, a.action, a.generation_id, a.model_id, a.target, a.undone, a.meta,
        w.name AS worker, w.color AS worker_color, w.id AS worker_id, md.name AS model_name
      FROM activity a JOIN workers w ON w.id = a.worker_id LEFT JOIN models md ON md.id = a.model_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...args, limit + 1);
    const items = rows.slice(0, limit).map((r) => ({ ...r, undone: !!r.undone, meta: (() => { try { return r.meta ? JSON.parse(r.meta) : null; } catch { return null; } })() }));
    return { items, more: rows.length > limit };
  });
}
