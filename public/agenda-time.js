// Times of the posting agenda, shown and typed in the time zone chosen in Aprovação (not the computer's).

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock time in `zone` at instant `ms`, as a UTC timestamp (only its fields are meaningful). */
export function partsIn(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** "2026-09-28T14:30" read as a wall time in `zone` → unix seconds. */
export function zonedToEpoch(local, zone) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = want;
  for (let i = 0; i < 3; i++) guess += want - partsIn(guess, zone);
  return Math.round(guess / 1000);
}

/** Midnight (in `zone`) of the day that contains `ts` (unix seconds). */
export function dayStart(ts, zone) {
  const d = new Date(partsIn(ts * 1000, zone));
  return zonedToEpoch(`${d.toISOString().slice(0, 10)}T00:00`, zone);
}
// A day lasts 23 to 25 hours around a clock change: step past it, then back to midnight.
export const nextDay = (start, zone) => dayStart(start + 26 * 3600, zone);
export const prevDay = (start, zone) => dayStart(start - 22 * 3600, zone);

/** The periods Custos and Equipa both offer, as [from, to) in unix seconds, in calendar days of `zone`. */
export const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['month', 'This month'], ['prev', 'Last month']];
export function presetRange(key, zone) {
  const nowS = Math.floor(Date.now() / 1000);
  const today = dayStart(nowS, zone);
  const back = (n) => { let d = today; for (let i = 0; i < n; i++) d = prevDay(d, zone); return d; };
  const ymd = (ts) => new Date(partsIn(ts * 1000, zone)).toISOString().slice(0, 10);
  const monthStart = (ts) => zonedToEpoch(`${ymd(ts).slice(0, 7)}-01T00:00`, zone);
  switch (key) {
    case 'today': return [today, nowS];
    case 'yesterday': return [back(1), today];
    case '7': return [back(6), nowS];
    case 'month': return [monthStart(today), nowS];
    case 'prev': { const m = monthStart(today); return [monthStart(m - 86400), m]; }
    default: return [back(29), nowS];
  }
}

export const fmtHour = (ts, zone) => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' });

const dayOf = (ms, zone) => { const d = new Date(partsIn(ms, zone)); return { key: d.toISOString().slice(0, 10), wd: d.getUTCDay(), dd: d.getUTCDate(), mm: d.getUTCMonth() + 1 }; };

/** "hoje", "amanhã", "ontem" or "ter 29/09". */
export function fmtDay(ts, zone) {
  const t = dayOf(ts * 1000, zone);
  if (t.key === dayOf(Date.now(), zone).key) return 'today';
  if (t.key === dayOf(Date.now() + 86400e3, zone).key) return 'tomorrow';
  if (t.key === dayOf(Date.now() - 86400e3, zone).key) return 'yesterday';
  return `${WD[t.wd]} ${String(t.dd).padStart(2, '0')}/${String(t.mm).padStart(2, '0')}`;
}

/** "dom 27/09" */
export function fmtDate(ts, zone) {
  const t = dayOf(ts * 1000, zone);
  return `${WD[t.wd]} ${String(t.dd).padStart(2, '0')}/${String(t.mm).padStart(2, '0')}`;
}

/** "hoje · dom 27/09" or "ter 29/09" (a day heading). */
export function fmtDayTitle(ts, zone) {
  const rel = fmtDay(ts, zone);
  return rel.includes('/') ? rel : `${rel[0].toUpperCase()}${rel.slice(1)} · ${fmtDate(ts, zone)}`;
}

/** "hoje 09:43", "amanhã 07:29" or "ter 29/09 09:43". */
export const fmtWhen = (ts, zone) => `${fmtDay(ts, zone)} ${fmtHour(ts, zone)}`;

export const TZ_LABEL = { 'Europe/Lisbon': 'Lisbon', 'Europe/London': 'London', 'America/New_York': 'New York (ET)', 'America/Chicago': 'Chicago (CT)', 'America/Los_Angeles': 'Los Angeles (PT)', 'America/Sao_Paulo': 'São Paulo' };
