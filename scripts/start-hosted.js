// Start on a host (Railway, Render, a VPS). The data folder lives on the host's persistent volume (RADAR_DATA_DIR):
// on the first boot it is empty, so the database and media shipped in ./data are copied there once. The app refuses to
// start without APP_PASSWORD, because a public link would otherwise let anyone use it with the saved API keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.APP_PASSWORD) {
  console.error('APP_PASSWORD is not set. Set it in the host\'s environment variables: the app is protected by it.');
  process.exit(1);
}
const dest = process.env.RADAR_DATA_DIR ? path.resolve(process.env.RADAR_DATA_DIR) : null;
if (dest && !fs.existsSync(path.join(dest, 'radar.db')) && fs.existsSync(path.join(ROOT, 'data', 'radar.db'))) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(ROOT, 'data'), dest, { recursive: true });
  console.log(`Data copied to ${dest} (first boot)`);
}
process.env.HOST ||= '0.0.0.0'; // reachable from the host's proxy
await import('../server/index.js');
