// Simulated fal.ai (storage upload + queue) for testing the 18+ page (Spicy) without spending credits.
//   node scripts/mock-fal.js            → http://127.0.0.1:8299
//   FAL_QUEUE_URL=http://127.0.0.1:8299/queue FAL_REST_URL=http://127.0.0.1:8299/rest npm start
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_FAL_PORT) || 8299;
const BASE = `http://127.0.0.1:${PORT}`;
const files = new Map();
const jobs = new Map();
let seq = 0;

// 64×80 solid PNG
function png(w = 64, h = 80, rgb = [200, 120, 150]) {
  const crc = (b) => zlib.crc32(b) >>> 0;
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const buf = await body(req);
  if (u.pathname.startsWith('/rest') || u.pathname.startsWith('/queue')) {
    if (req.headers.authorization !== 'Key good:key') return json(res, 401, { detail: 'Invalid key' });
  }
  if (u.pathname === '/rest/storage/upload/initiate') {
    const id = `f${++seq}`;
    return json(res, 200, { upload_url: `${BASE}/put/${id}`, file_url: `${BASE}/file/${id}` });
  }
  if (u.pathname.startsWith('/put/')) { files.set(u.pathname.slice(5), buf); res.writeHead(200); return res.end(); }
  if (u.pathname.startsWith('/file/')) { const f = files.get(u.pathname.slice(6)); res.writeHead(f ? 200 : 404); return res.end(f); }
  if (u.pathname.startsWith('/queue/') && req.method === 'POST') {
    const endpoint = u.pathname.slice(7);
    const input = JSON.parse(buf.toString() || '{}');
    const id = `req${++seq}`;
    jobs.set(id, { endpoint, input, t0: Date.now() });
    console.log('submit', endpoint, JSON.stringify(input).slice(0, 300));
    return json(res, 200, { request_id: id, status_url: `${BASE}/queue/requests/${id}/status`, response_url: `${BASE}/queue/requests/${id}` });
  }
  const m = u.pathname.match(/^\/queue\/(?:.*\/)?requests\/([^/]+)(\/status)?$/);
  if (m) {
    const j = jobs.get(m[1]);
    if (!j) return json(res, 404, { detail: 'not found' });
    const done = Date.now() - j.t0 > (Number(process.env.MOCK_FAL_DELAY_MS) || 4000);
    if (m[2]) return json(res, 200, done ? { status: 'COMPLETED' } : { status: 'IN_PROGRESS', logs: [{ message: `mock ${j.endpoint} working…` }] });
    if (j.endpoint.includes('trainer')) return json(res, 200, { diffusers_lora_file: { url: `${BASE}/lora.safetensors` }, config_file: { url: `${BASE}/cfg.json` } });
    if (j.endpoint.includes('animate')) {
      const vid = String(j.input.video_url || '').split('/file/')[1];
      const id = `f${++seq}`;
      files.set(id, files.get(vid) || png());
      return json(res, 200, { video: { url: `${BASE}/file/${id}` }, seed: 7, prompt: 'mock' });
    }
    if (j.endpoint.includes('image-to-video')) { const id = `f${++seq}`; files.set(id, files.get([...files.keys()].pop()) || png()); return json(res, 200, { video: { url: `${BASE}/file/${id}` }, seed: 7 }); }
    const n = j.input.num_images || 1;
    const images = Array.from({ length: n }, (_, i) => { const id = `f${++seq}`; files.set(id, png(64, 80, [180 + i * 20, 90, 140])); return { url: `${BASE}/file/${id}`, content_type: 'image/png', width: 64, height: 80 }; });
    return json(res, 200, { images, seed: 42, has_nsfw_concepts: images.map(() => false), prompt: j.input.prompt });
  }
  json(res, 404, { detail: 'mock: no route' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock fal.ai at ${BASE}`));
