// Downloads the official standalone yt-dlp binary into ./bin (used by the TikTok scraper and video cache).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asset = { darwin: 'yt-dlp_macos', win32: 'yt-dlp.exe', linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux' }[process.platform];
if (!asset) {
  console.error(`Platform ${process.platform} is not supported — install yt-dlp manually and put it on the PATH.`);
  process.exit(1);
}
const dest = path.join(root, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
fs.mkdirSync(path.dirname(dest), { recursive: true });

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
console.log(`Downloading ${url} …`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Failed: HTTP ${res.status}`);
  process.exit(1);
}
fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
fs.chmodSync(dest, 0o755);
console.log(`yt-dlp ${execFileSync(dest, ['--version']).toString().trim()} installed in ${path.relative(root, dest)}`);

// ffmpeg (static build from github.com/eugeneware/ffmpeg-static) — used to put the reel's original
// audio back on generated videos and to trim reference clips.
import zlib from 'node:zlib';
const ffAsset = { darwin: `ffmpeg-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.gz`, linux: `ffmpeg-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}.gz`, win32: 'ffmpeg-win32-x64.gz' }[process.platform];
if (ffAsset) {
  const ffDest = path.join(root, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffUrl = `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/${ffAsset}`;
  console.log(`Downloading ${ffUrl} …`);
  const r = await fetch(ffUrl);
  if (!r.ok) {
    console.error(`ffmpeg failed: HTTP ${r.status}`);
  } else {
    fs.writeFileSync(ffDest, zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
    fs.chmodSync(ffDest, 0o755);
    console.log(`ffmpeg installed in ${path.relative(root, ffDest)}: ${execFileSync(ffDest, ['-version']).toString().split('\n')[0]}`);
  }
}

