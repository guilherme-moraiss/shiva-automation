import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './db.js';

/** Local ffmpeg (bin/ffmpeg from `npm run setup`, or one on PATH). */
export function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const local = path.join(ROOT, 'bin', exe);
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function run(args, timeoutMs = 180000) {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg not found — run `npm run setup`'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg: timeout')); }, timeoutMs);
    child.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(err) : reject(Object.assign(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`), { stderr: err })); });
  });
}

/** { duration, hasAudio, width, height, fps } parsed from `ffmpeg -i`. */
export async function probe(file) {
  let out = '';
  try { await run(['-i', file]); } catch (e) { out = e.stderr || ''; } // ffmpeg exits 1 without an output file — expected
  const d = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const line = (out.match(/Stream #[^\n]*Video:[^\n]*/) || [''])[0];
  const v = line.match(/(\d{2,5})x(\d{2,5})/);
  const fps = Number((line.match(/([\d.]+) fps/) || line.match(/([\d.]+) tbr/) || [])[1]) || null;
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasAudio: /Stream #[^\n]*Audio:/.test(out),
    width: v ? Number(v[1]) : null,
    height: v ? Number(v[2]) : null,
    fps: fps && fps > 0 && fps < 241 ? fps : null,
  };
}

/** The part of a video between `start` and `end` seconds, re-encoded (frame-accurate cut), audio kept. Writes `dst`. */
export async function cutVideo(src, dst, start, end) {
  const s = Math.max(0, Number(start) || 0);
  const len = Math.max(0.1, Number(end) - s);
  await run(['-y', '-ss', s.toFixed(3), '-i', src, '-t', len.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dst], 300000);
}

const tmp = (ext) => path.join(os.tmpdir(), `rr_${crypto.randomUUID()}${ext}`);

/** First `seconds` of a video, re-encoded (clean cut), without audio. Returns a Buffer. */
export async function trimVideo(src, seconds) {
  const out = tmp('.mp4');
  try {
    await run(['-y', '-i', src, '-t', String(seconds), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/**
 * Put the original reel's audio on the generated video (video stream copied untouched).
 * The result lasts as long as the generated video.
 */
export async function muxOriginalAudio(videoBuf, sourcePath) {
  const vin = tmp('.mp4');
  const out = tmp('.mp4');
  fs.writeFileSync(vin, videoBuf);
  try {
    await run(['-y', '-i', vin, '-i', sourcePath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
    return fs.readFileSync(out);
  } finally {
    fs.rm(vin, { force: true }, () => {});
    fs.rm(out, { force: true }, () => {});
  }
}

/** The reel re-encoded for person replacement: constant `fps`, at most `maxSecs`, no audio (put back afterwards). */
export async function reencodeVideo(src, { fps = 24, maxSecs = 60 } = {}) {
  const out = tmp('.mp4');
  try {
    await run(['-y', '-i', src, '-t', String(maxSecs), '-an', '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], 300000);
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/**
 * "Acabamento realista": generated video looks too clean, too smooth and too red. The video is brought to the
 * reel's own size (lanczos), saturated reds (blush patches, glossy lips) are toned down, a light sharpen restores
 * texture and a temporal luma grain gives the phone-sensor look. Audio is copied untouched.
 */
export async function realismFinish(src, out, { width, height } = {}) {
  const scale = width && height ? `scale=${width}:${height}:flags=lanczos,setsar=1,` : '';
  const vf = `${scale}huesaturation=saturation=-0.45:colors=r:strength=1,huesaturation=saturation=-0.2:colors=m,unsharp=5:5:0.4:5:5:0,noise=c0s=10:c0f=t+u`;
  await run(['-y', '-i', src, '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '16M', '-bufsize', '32M', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out], 600000);
}

/**
 * The reel prepared for a ComfyUI workflow (RunningHub): H.264 at a constant `fps`, at most `maxSecs`,
 * at most `width` pixels wide (the workflows render at 720×1280 anyway), audio kept (the workflows put it back).
 */
export async function prepareForWorkflow(src, { maxSecs = 30, fps = 30, width = 720 } = {}) {
  const out = tmp('.mp4');
  try {
    await run(['-y', '-i', src, '-t', String(maxSecs), '-vf', `fps=${fps},scale='min(${width},iw)':-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], 300000);
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/**
 * A picture with a painted zone as its alpha channel, the way ComfyUI's LoadImage reads a mask (mask = the transparent
 * part). `mask`: white where the user painted, any size (scaled to the picture). The picture's colours stay untouched.
 */
export async function maskIntoAlpha(src, mask) {
  const out = tmp('.png');
  try {
    await run(['-y', '-i', src, '-i', mask, '-filter_complex', '[1:v][0:v]scale2ref[m][base];[m]format=gray,negate[a];[base]format=rgb24[b];[b][a]alphamerge,format=rgba', '-frames:v', '1', out], 60000);
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}

/** The same video without its audio track (video copied untouched). */
export async function stripAudio(src, dst) {
  await run(['-y', '-i', src, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', dst]);
}

/** One JPEG frame at `atSeconds`. Returns a Buffer. */
export async function extractFrame(src, atSeconds) {
  const out = tmp('.jpg');
  try {
    await run(['-y', '-ss', String(Math.max(0, atSeconds)), '-i', src, '-frames:v', '1', '-q:v', '2', out], 60000);
    return fs.readFileSync(out);
  } finally { fs.rm(out, { force: true }, () => {}); }
}
