import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../db.js';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export class ScrapeError extends Error {
  constructor(message, { code = 'error', retryable = false } = {}) {
    super(message);
    this.code = code; // error | not_found | private | rate_limited | auth_required | config
    this.retryable = retryable;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new ScrapeError(`Timeout contacting ${new URL(url).host}`, { retryable: true });
    throw new ScrapeError(`Network error: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(t);
  }
}

export async function downloadFile(url, dest, headers = {}) {
  if (!url) return false;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, ...headers } }, 30000);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/** Parse "1.2K", "3,4M", "12 345" etc. Numbers pass through. */
export function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  const m = s.match(/^([\d.]+)([kmb])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// ---- yt-dlp -----------------------------------------------------------------

export function ytDlpPath() {
  const local = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function runYtDlp(args, { timeoutMs = 120000 } = {}) {
  const bin = ytDlpPath();
  if (!bin) {
    return Promise.reject(new ScrapeError('yt-dlp not found. Run `npm run setup`.', { code: 'config' }));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ScrapeError('yt-dlp took too long (timeout)', { retryable: true }));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ScrapeError(`yt-dlp failed: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      const line = err.split('\n').filter((l) => l.startsWith('ERROR')).pop() || err.trim().split('\n').pop() || `exit ${code}`;
      reject(new ScrapeError(line.replace(/^ERROR:\s*/, '').slice(0, 300), { retryable: /timed out|429|temporar/i.test(line) }));
    });
  });
}
