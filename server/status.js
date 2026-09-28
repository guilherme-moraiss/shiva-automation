import { db, now, getSettings } from './db.js';
import { route } from './http.js';
import { WaveSpeed } from './pipeline/wavespeed.js';
import { RunningHub, RH_SITES } from './pipeline/runninghub.js';
import { recordBalance } from './costs.js';

/**
 * The status chips at the top of every page: provider balances (with how many days they last at the recent pace),
 * today's spend and what is running. Balances are read at most every 5 minutes (a failed read is retried after 1).
 * A balance is "low" under 3 projects at the average cost, or under the owner's own threshold (setting
 * low_balance_usd, default $5), whichever is higher.
 */
const cache = { at: 0, value: null, pending: null };

async function readBalances() {
  const s = getSettings();
  const out = {};
  await Promise.all([
    (async () => {
      if (!s.wavespeed_api_key) return;
      try { out.wavespeed = { usd: (await new WaveSpeed(s.wavespeed_api_key).balance()).usd }; recordBalance('wavespeed', out.wavespeed.usd); } catch (e) { out.wavespeed = { error: e.message }; }
    })(),
    (async () => {
      if (!s.rh_api_key) return;
      try {
        const d = await new RunningHub({ apiKey: s.rh_api_key, baseUrl: RH_SITES[s.rh_site] || RH_SITES.ai }).account();
        const money = Number(d?.remainMoney);
        out.runninghub = { money: Number.isFinite(money) ? money : null, currency: d?.currency || (s.rh_site === 'cn' ? 'CNY' : 'USD') };
        if (out.runninghub.money != null) recordBalance('runninghub', out.runninghub.money, out.runninghub.currency);
      } catch (e) { out.runninghub = { error: e.message }; }
    })(),
  ]);
  return out;
}

function balances() {
  const ok = cache.value && !Object.values(cache.value).some((v) => v?.error);
  if (cache.value && Date.now() - cache.at < (ok ? 5 * 60e3 : 60e3)) return Promise.resolve(cache.value);
  if (!cache.pending) {
    cache.pending = readBalances()
      .then((v) => { Object.assign(cache, { at: Date.now(), value: v }); return v; })
      .finally(() => { cache.pending = null; });
  }
  // Serve the last value while a new read runs (the chips never wait on a slow provider).
  return cache.value ? Promise.resolve(cache.value) : cache.pending;
}

/** Midnight of today in the agenda's time zone, as epoch seconds (also right on clock-change days, 23 or 25 hours long). */
function todayStart(zone) {
  const wall = (ms) => { // wall-clock time in `zone` at instant `ms`, as a UTC timestamp
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const d = new Date(wall(now() * 1000));
  const want = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); // today 00:00 as a wall time
  let guess = want;
  for (let i = 0; i < 3; i++) guess += want - wall(guess);
  return Math.round(guess / 1000);
}

/** Under this a balance is "low": 3 projects at the recent average cost, or the owner's own value (default $5). */
export function lowBalanceThreshold() {
  const s = getSettings();
  const proj = db.prepare("SELECT COUNT(DISTINCT generation_id) n, COALESCE(SUM(amount), 0) s FROM costs WHERE currency = 'USD' AND generation_id IS NOT NULL AND at >= ?").get(now() - 30 * 86400);
  const avgProject = proj.n ? proj.s / proj.n : 0;
  return Math.round(Math.max(3 * avgProject, Number(s.low_balance_usd) > 0 ? Number(s.low_balance_usd) : 5) * 100) / 100;
}

export function registerStatusRoutes() {
  route('GET', '/api/status/summary', async () => {
    const s = getSettings();
    const zone = s.sched_tz || 'Europe/Lisbon';
    const t = now();
    const today = todayStart(zone);
    const usd = (from, to = t + 1) => db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM costs WHERE currency = 'USD' AND at >= ? AND at < ?").get(from, to).s;
    const spentToday = usd(today);
    const avgDaily = usd(today - 7 * 86400, today) / 7;
    // The WaveSpeed balance lasts at the WaveSpeed pace (fal or RunningHub spend does not come out of it).
    const wsDaily = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM costs WHERE currency = 'USD' AND provider = 'wavespeed' AND at >= ? AND at < ?").get(today - 7 * 86400, today).s / 7;
    const threshold = lowBalanceThreshold();
    const b = await balances();
    const wavespeed = b.wavespeed ? { ...b.wavespeed, low: b.wavespeed.usd != null && b.wavespeed.usd < threshold, days: b.wavespeed.usd != null && wsDaily > 0 ? b.wavespeed.usd / wsDaily : null } : null;
    const rh = b.runninghub ? { ...b.runninghub, low: b.runninghub.money != null && b.runninghub.currency === 'USD' && b.runninghub.money < threshold } : null;
    const count = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    return {
      wavespeed, runninghub: rh, threshold: Math.round(threshold * 100) / 100,
      today: { spent: Math.round(spentToday * 10000) / 10000, projects: db.prepare('SELECT COUNT(*) n FROM generations WHERE created_at >= ?').get(today).n },
      avgDaily: Math.round(avgDaily * 100) / 100,
      running: {
        projects: count("SELECT COUNT(*) n FROM generations WHERE stage IN ('queued', 'imaging', 'animating')"),
        other: count("SELECT COUNT(*) n FROM creations WHERE stage IN ('queued', 'generating')") + count("SELECT COUNT(*) n FROM spicy_jobs WHERE stage IN ('queued', 'running')") + count("SELECT COUNT(*) n FROM face_jobs WHERE stage IN ('queued', 'running')"),
      },
    };
  });
}
