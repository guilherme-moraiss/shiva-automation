import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { db, getSettings, MEDIA_DIR } from './db.js';
import { downloadFile, runYtDlp, ytDlpPath } from './scrapers/util.js';
import { ffmpegPath, probe } from './ffmpeg.js';

const pending = new Map();

/** True when the file is a readable video (duration > 0). Without ffmpeg it can't be checked: trust it. */
async function isPlayable(abs) {
  if (!ffmpegPath()) return true;
  try { return (await probe(abs)).duration > 0; } catch { return false; }
}

/** Delete a half-written video and the temporary parts yt-dlp leaves next to it (x.f137.mp4, x.temp.mp4, x.mp4.part…). */
function discardPartial(abs) {
  try { fs.rmSync(abs, { force: true }); } catch {}
  const dir = path.dirname(abs);
  const base = path.basename(abs, '.mp4');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f !== path.basename(abs) && f.startsWith(`${base}.`) && /\.(part|ytdl|temp\.mp4)$|\.f\d+[\w-]*\.\w+$/.test(f)) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
      }
    }
  } catch {}
}

/** Make sure a reel's video is cached locally (downloads on first play). Returns the relative path. */
export function ensureVideo(reel) {
  if (reel.video_path && fs.existsSync(path.join(MEDIA_DIR, reel.video_path))) return Promise.resolve(reel.video_path);
  if (pending.has(reel.id)) return pending.get(reel.id);
  const p = (async () => {
    const rel = `videos/${reel.platform}_${String(reel.external_id).replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`;
    const abs = path.join(MEDIA_DIR, rel);
    // A file that exists but was never recorded in the DB may be a download that was cut off
    // (timeout/kill): only reuse it if ffmpeg can read a real duration from it.
    let ok = fs.existsSync(abs) && (await isPlayable(abs));
    if (!ok) discardPartial(abs);
    if (!ok && reel.platform === 'instagram' && reel.video_url) {
      ok = await downloadFile(reel.video_url, abs, { Referer: 'https://www.instagram.com/' });
      if (!ok) discardPartial(abs);
    }
    if (!ok && ytDlpPath() && reel.url) {
      const ff = ffmpegPath();
      // With ffmpeg: best video + best audio merged into mp4; without: best single mp4 file.
      const args = ff
        ? ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', '--merge-output-format', 'mp4', '--ffmpeg-location', ff, '-o', abs, '--no-part', '--no-warnings', '--no-playlist']
        : ['-f', 'mp4/best[ext=mp4]/best', '-o', abs, '--no-part', '--no-warnings', '--no-playlist'];
      const cookie = getSettings().instagram_cookie?.trim();
      if (reel.platform === 'instagram' && cookie) {
        args.push('--add-header', `Cookie:${cookie.includes('=') ? cookie : `sessionid=${cookie}`}`);
      }
      args.push(reel.url);
      try {
        await runYtDlp(args, { timeoutMs: 180000 });
        ok = fs.existsSync(abs);
      } catch {
        ok = false;
      }
      if (!ok) discardPartial(abs); // e.g. yt-dlp killed by the timeout while writing straight to abs (--no-part)
    }
    if (!ok) throw new Error('Could not get the video');
    db.prepare('UPDATE reels SET video_path = ? WHERE id = ?').run(rel, reel.id);
    return rel;
  })().finally(() => pending.delete(reel.id));
  pending.set(reel.id, p);
  return p;
}

// Background download queue (auto-download of viral reels after a scan).
const dlQueue = [];
let dlActive = 0;
export function queueDownload(reel) {
  if (reel.video_path || pending.has(reel.id) || dlQueue.some((r) => r.id === reel.id)) return;
  dlQueue.push(reel);
  pumpDownloads();
}
function pumpDownloads() {
  while (dlActive < 2 && dlQueue.length) {
    const r = dlQueue.shift();
    dlActive++;
    ensureVideo(r).catch(() => {}).finally(() => { dlActive--; pumpDownloads(); });
  }
}
export const downloadQueueSize = () => dlQueue.length + dlActive;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

/** Static file responder with HTTP Range support (needed for <video> seeking). */
export function sendFile(req, res, abs, { cache = 'no-cache', filename, download = false } = {}) {
  let stat;
  try { stat = fs.statSync(abs); } catch { res.writeHead(404); return res.end('Not found'); }
  if (!stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  // Always give media a real name + extension, so "Save video as…" produces e.g. remake_Maddy_12.mp4
  const name = filename || (/^(video|image)\//.test(type) ? path.basename(abs) : null);
  const disp = name ? { 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\w.\-]+/g, '_')}"` } : {};
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? parseInt(range[1], 10) : 0;
    let end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
    if (!range[1] && range[2]) { start = stat.size - parseInt(range[2], 10); end = stat.size - 1; }
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Cache-Control': cache, ...disp,
    });
    // pipeline, not .pipe() (also below): a read that fails after the stat (file deleted or replaced, EBUSY/EPERM on
    // Windows) destroys the response instead of an unhandled 'error' ending the process; a dropped request closes the file.
    return pipeline(fs.createReadStream(abs, { start, end }), res, () => {});
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ...disp });
  pipeline(fs.createReadStream(abs), res, () => {});
}
