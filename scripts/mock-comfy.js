// Fake ComfyUI server for developing/testing the pipeline without spending credits.
//   npm run mock:comfy            → http://127.0.0.1:8199  (put this URL in Setup → Pipeline)
// It validates the submitted API-format graph like ComfyUI would (unknown nodes, broken links, missing inputs,
// missing uploads, missing comfy.org key for partner nodes), then "renders" by echoing inputs back:
// Nano Banana returns the last uploaded image, Wan returns the uploaded source video or any cached reel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MOCK_PORT) || 8199;
const REQUIRE_KEY = process.env.MOCK_REQUIRE_KEY !== '0';

const REQUIRED = {
  LoadImage: ['image'], LoadVideo: ['file'], SaveImage: ['images'], SaveVideo: ['video'],
  GeminiNanoBanana2V2: ['prompt', 'model', 'model.resolution', 'model.aspect_ratio', 'seed'],
  Wan3ImageToVideoApi: ['model', 'model.prompt', 'model.resolution', 'model.ratio', 'model.duration', 'first_frame', 'seed'],
  Wan3ReferenceToVideoApi: ['model', 'model.prompt', 'model.resolution', 'model.duration', 'seed'],
};
const API_NODES = ['GeminiNanoBanana2V2', 'Wan3ImageToVideoApi', 'Wan3ReferenceToVideoApi'];

const uploads = new Map(); // name -> Buffer
const outputs = new Map(); // filename -> Buffer
const history = {};
const pending = [];
let running = null;
const received = [];
const sockets = new Set();
const blobs = new Map();
const wanTasks = new Map();
let nbCalls = 0;
const OBJECT_INFO = {
  LoadImage: { input: { required: { image: [['x.png'], { image_upload: true }] } }, input_order: { required: ['image'] } },
  SaveVideo: { input: { required: { video: ['VIDEO'], filename_prefix: ['STRING'], format: ['COMFY_DYNAMICCOMBO_V3'] } }, input_order: { required: ['video', 'filename_prefix', 'format'] } },
};

function wsSend(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
  if (!head) return;
  for (const s of sockets) { try { s.write(Buffer.concat([head, payload])); } catch {} }
}

function parseMultipart(buf, contentType) {
  const boundary = '--' + contentType.split('boundary=')[1];
  const parts = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString();
    const body = part.subarray(headEnd + 4);
    const name = head.match(/name="([^"]+)"/)?.[1];
    const filename = head.match(/filename="([^"]+)"/)?.[1];
    parts[name] = filename ? { filename, data: body } : body.toString();
    pos = next;
  }
  return parts;
}

function validate(prompt, extra) {
  const errors = {};
  for (const [id, n] of Object.entries(prompt)) {
    const errs = [];
    if (!REQUIRED[n.class_type]) errs.push({ message: `Node type not found: ${n.class_type}` });
    for (const k of REQUIRED[n.class_type] || []) if (!(k in (n.inputs || {}))) errs.push({ message: 'Required input is missing', details: k });
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !prompt[v[0]]) errs.push({ message: 'Linked node not found', details: `${k} → ${v[0]}` });
    }
    if (n.class_type === 'LoadImage' && !uploads.has(n.inputs.image)) errs.push({ message: 'Invalid image file', details: n.inputs.image });
    if (n.class_type === 'LoadVideo' && !uploads.has(n.inputs.file)) errs.push({ message: 'Invalid video file', details: n.inputs.file });
    if (errs.length) errors[id] = { errors: errs, class_type: n.class_type };
  }
  return errors;
}

function execute(item) {
  running = item;
  setTimeout(() => {
    const { id, prompt, extra } = item;
    const out = {};
    let error = null;
    for (const [nid, n] of Object.entries(prompt)) {
      if (API_NODES.includes(n.class_type) && REQUIRE_KEY && !extra?.api_key_comfy_org) {
        error = { node_id: nid, node_type: n.class_type, exception_message: 'Unauthorized: Please login first to use this node.' };
      }
    }
    if (!error) {
      const images = Object.values(prompt).filter((n) => n.class_type === 'LoadImage').map((n) => uploads.get(n.inputs.image));
      const vids = Object.values(prompt).filter((n) => n.class_type === 'LoadVideo').map((n) => uploads.get(n.inputs.file));
      for (const [nid, n] of Object.entries(prompt)) {
        if (n.class_type === 'SaveImage') {
          const filename = `nb2_${crypto.randomBytes(3).toString('hex')}.png`;
          outputs.set(filename, images[images.length - 1]);
          out[nid] = { images: [{ filename, subfolder: 'reels-radar', type: 'output' }] };
        }
        if (n.class_type === 'SaveVideo') {
          let video = vids[0];
          if (!video) {
            const dir = path.join(ROOT, 'data/media/videos');
            const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.mp4'));
            video = f ? fs.readFileSync(path.join(dir, f)) : Buffer.from('not a real video');
          }
          const filename = `wan3_${crypto.randomBytes(3).toString('hex')}.mp4`;
          outputs.set(filename, video);
          out[nid] = { images: [{ filename, subfolder: 'reels-radar', type: 'output' }], animated: [true] };
        }
      }
    }
    history[id] = {
      prompt: [0, id, prompt, extra, []],
      outputs: error ? {} : out,
      status: {
        status_str: error ? 'error' : 'success', completed: !error,
        messages: error ? [['execution_error', { prompt_id: id, ...error }]] : [['execution_success', { prompt_id: id }]],
      },
    };
    for (const [nid, o] of Object.entries(out)) wsSend({ type: 'executed', data: { prompt_id: id, node: nid, output: o } });
    wsSend(error ? { type: 'execution_error', data: { prompt_id: id, ...error } } : { type: 'execution_success', data: { prompt_id: id } });
    console.log(`${error ? '✗' : '✓'} ${id.slice(0, 8)} ${Object.values(prompt).map((n) => n.class_type).join(' → ')}${error ? ' — ' + error.exception_message : ''}`);
    running = null;
    if (pending.length) execute(pending.shift());
  }, 1500 + Math.random() * 1500);
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Comfy Cloud flavour: same routes under /api, X-API-Key required.
  if (url.pathname.startsWith('/api/')) {
    if (!req.headers['x-api-key']) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"code":"UNAUTHORIZED","message":"authentication required"}'); }
    const rest = url.pathname.slice(4);
    const V1_OFF = process.env.MOCK_V1_OFF === '1';
    if (V1_OFF && ['/prompt', '/upload/image', '/object_info/LoadImage'].includes(rest)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"gone"}'); }
    if (rest.startsWith('/v2/')) {
      if (!/^Bearer .+/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"code":"UNAUTHORIZED"}'); }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (rest === '/v2/assets' && req.method === 'POST') {
          const parts = parseMultipart(body, req.headers['content-type']);
          uploads.set(parts.file_path, parts.file.data);
          return json(201, { id: crypto.randomUUID(), file_path: parts.file_path, size_bytes: parts.file.data.length });
        }
        if (rest === '/v2/jobs' && req.method === 'GET') return json(200, { jobs: [] });
        if (rest === '/v2/jobs' && req.method === 'POST') {
          const { workflow, extra_data: extra } = JSON.parse(body.toString());
          fs.writeFileSync(path.join(ROOT, 'data/mock-comfy-last-prompt.json'), JSON.stringify(workflow, null, 2));
          const errors = validate(workflow, extra);
          if (Object.keys(errors).length) return json(400, { code: 'invalid_workflow', message: 'validation failed', node_errors: errors });
          const id = crypto.randomUUID();
          if (running) pending.push({ id, prompt: workflow, extra }); else execute({ id, prompt: workflow, extra });
          return json(201, { id, status: 'queued', outputs: [], progress: { value: 0 } });
        }
        const jm = rest.match(/^\/v2\/jobs\/([^/]+)$/);
        if (jm) {
          const h = history[jm[1]];
          if (!h) return json(200, { id: jm[1], status: 'running', progress: { value: 0.5, current_node_class: 'Wan3' }, outputs: [] });
          if (h.status.status_str === 'error') { const e = h.status.messages[0][1]; return json(200, { id: jm[1], status: 'failed', error: { code: 'execution_error', message: e.exception_message, class_type: e.node_type } }); }
          const outs = Object.entries(h.outputs).flatMap(([nid, o]) => (o.images || []).map((f) => ({ node_id: nid, name: f.filename, url: `http://127.0.0.1:${PORT}/signed/${encodeURIComponent(f.filename)}` })));
          return json(200, { id: jm[1], status: 'succeeded', outputs: outs });
        }
        json(404, { error: 'not found' });
      });
      return;
    }
    if (rest.startsWith('/workflows/published/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ share_id: rest.split('/').pop(), name: 'Wan 3.0 I2V (shared)', workflow_json: JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/mock-share-workflow.json'), 'utf8')), assets: [] }));
    }
    if (rest === '/jobs' || rest.startsWith('/jobs/')) {
      // Fake run history: one finished manual run with an image output.
      if (!outputs.has('zimage_sfw_00001_.png')) {
        const d = path.join(ROOT, 'data/media/thumbs'); const f = fs.existsSync(d) && fs.readdirSync(d)[0];
        outputs.set('zimage_sfw_00001_.png', f ? fs.readFileSync(path.join(d, f)) : Buffer.from('x'));
      }
      const job = { id: 'job-zimage-1', status: 'completed', create_time: Date.now(), outputs_count: 1, previewable_outputs_count: 1 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (rest === '/jobs') return res.end(JSON.stringify({ jobs: [job, { id: 'job-failed', status: 'failed', outputs_count: 0 }], pagination: { total: 2 } }));
      return res.end(JSON.stringify({ ...job, outputs: { 65: { images: [{ filename: 'zimage_sfw_00001_.png', subfolder: 'reels-radar', type: 'output' }] }, 31: { images: [{ filename: 'canny_temp.png', type: 'temp' }] } } }));
    }
    const jm = rest.match(/^\/job\/([^/]+)\/status$/);
    if (jm) { res.writeHead(200, { 'Content-Type': 'application/json' }); const h = history[jm[1]]; return res.end(JSON.stringify({ status: h ? h.status.status_str : 'in_progress' })); }
    if (rest === '/view') { res.writeHead(302, { Location: `/signed/${encodeURIComponent(url.searchParams.get('filename'))}` }); return res.end(); }
    req.url = rest + url.search;
  }
  // api.comfy.org flavour (start the app with COMFY_API_URL=http://127.0.0.1:8199)
  if (url.pathname.startsWith('/customers/') || url.pathname.startsWith('/proxy/') || url.pathname.startsWith('/blob/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = url.pathname;
      if (p.startsWith('/blob/')) {
        const name = decodeURIComponent(p.slice(6));
        if (req.method === 'PUT') { if (req.headers['x-api-key']) return json(400, { message: 'no auth on signed url' }); blobs.set(name, body); res.writeHead(200); return res.end(); }
        const b = blobs.get(name); res.writeHead(b ? 200 : 404); return res.end(b || '');
      }
      if (!req.headers['x-api-key']) return json(401, { message: 'Unauthorized' });
      if (p === '/customers/balance') return json(200, { effective_balance_micros: Number(process.env.MOCK_BALANCE_MICROS || 5000000), currency: 'usd' });
      if (p === '/customers/storage') {
        const { file_name } = JSON.parse(body.toString());
        const u = `http://127.0.0.1:${PORT}/blob/${encodeURIComponent(file_name)}`;
        return json(200, { upload_url: u, download_url: u });
      }
      const gm = p.match(/^\/proxy\/vertexai\/gemini\/(.+)$/);
      if (gm) {
        const b = JSON.parse(body.toString());
        const files = b.contents[0].parts.filter((x) => x.fileData).map((x) => decodeURIComponent(x.fileData.fileUri.split('/blob/')[1]));
        if (!b.generationConfig?.imageConfig) {
          console.log(`✓ api gemini-text ${gm[1]} (${files.length} imgs)`);
          const profile = { hair: 'long dark brown wavy hair', eyes: 'green, almond-shaped', skin: 'warm olive, smooth', face_marks: 'light freckles across the nose and cheeks', tattoos: 'none', piercings: 'small earrings only', nails: 'short, nude', makeup: 'natural', body: 'curvy hourglass', other: '' };
          return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(profile) }] } }] });
        }
        nbCalls++;
        const every = Number(process.env.MOCK_SAFETY_EVERY || 0);
        if (every && nbCalls % every === 0) {
          console.log(`✗ api gemini ${gm[1]} → IMAGE_SAFETY (simulated)`);
          return json(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] });
        }
        console.log(`✓ api gemini ${gm[1]} (${files.length} imgs, imageConfig ${JSON.stringify(b.generationConfig.imageConfig)})`);
        let img = blobs.get(files.at(-1));
        if (!img) { const d = path.join(ROOT, 'data/media/thumbs'); const f = fs.existsSync(d) && fs.readdirSync(d)[0]; img = f ? fs.readFileSync(path.join(d, f)) : Buffer.from('x'); }
        return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: (img || Buffer.alloc(0)).toString('base64') } }] } }] });
      }
      const km = p.match(/^\/proxy\/kling\/v1\/videos\/(motion-control|omni-video)(?:\/(.+))?$/);
      if (km) {
        if (req.method === 'POST') {
          const b = JSON.parse(body.toString());
          const vurl = b.video_url || b.video_list?.[0]?.video_url;
          const id = crypto.randomUUID();
          wanTasks.set(id, { at: Date.now(), video: vurl ? decodeURIComponent(vurl.split('/blob/')[1]) : null });
          console.log(`✓ api kling ${km[1]} keep_sound=${b.keep_original_sound || b.video_list?.[0]?.keep_original_sound} imgs=${b.image_url ? 1 : (b.image_list || []).length} prompt="${String(b.prompt).slice(0, 70)}"`);
          return json(200, { code: 0, message: 'SUCCEED', data: { task_id: id, task_status: 'submitted' } });
        }
        const t = wanTasks.get(km[2]);
        if (!t) return json(404, { code: 1, message: 'no task' });
        if (Date.now() - t.at < 3000) return json(200, { code: 0, data: { task_id: km[2], task_status: 'processing' } });
        return json(200, { code: 0, data: { task_id: km[2], task_status: 'succeed', task_result: { videos: [{ url: `http://127.0.0.1:${PORT}/blob/${encodeURIComponent(t.video)}` }] } } });
      }
      if (p === '/proxy/wan/api/v1/services/aigc/video-generation/video-synthesis') {
        const b = JSON.parse(body.toString());
        const id = crypto.randomUUID();
        const vid = b.input.media.find((m) => m.type === 'reference_video' || m.type === 'video');
        if (b.parameters.audio_setting) console.log(`  (wan edit audio_setting=${b.parameters.audio_setting})`);
        wanTasks.set(id, { at: Date.now(), video: vid ? decodeURIComponent(vid.url.split('/blob/')[1]) : null, covered: /more covered/.test(String(b.input.prompt)) });
        console.log(`✓ api wan3 ${b.model} media=${b.input.media.map((m) => m.type).join(',')} dur=${b.parameters.duration} prompt="${String(b.input.prompt).slice(0, 60)}"`);
        return json(200, { request_id: 'r', output: { task_id: id, task_status: 'PENDING' } });
      }
      const tm = p.match(/^\/proxy\/wan\/api\/v1\/tasks\/(.+)$/);
      if (tm) {
        const t = wanTasks.get(tm[1]);
        if (!t) return json(404, { message: 'no task' });
        if (Date.now() - t.at < 3000) return json(200, { request_id: 'r', output: { task_id: tm[1], task_status: 'RUNNING' } });
        if (process.env.MOCK_WAN_MODERATION === '1' && !t.covered) return json(200, { request_id: 'r', output: { task_id: tm[1], task_status: 'FAILED', code: 'DataInspectionFailed', message: 'Green net check failed for image (input): Input data may contain inappropriate content.' } });
        let name = t.video;
        if (!name) {
          const dir = path.join(ROOT, 'data/media/videos');
          const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.mp4'));
          name = 'wan_out.mp4';
          blobs.set(name, f ? fs.readFileSync(path.join(dir, f)) : Buffer.from('fake'));
        }
        return json(200, { request_id: 'r', output: { task_id: tm[1], task_status: 'SUCCEEDED', video_url: `http://127.0.0.1:${PORT}/blob/${encodeURIComponent(name)}` } });
      }
      json(404, { message: 'not found' });
    });
    return;
  }
  if (url.pathname.startsWith('/signed/')) {
    if (req.headers['x-api-key']) { res.writeHead(400); return res.end('signed url must not get auth header'); }
    const f = outputs.get(decodeURIComponent(url.pathname.slice(8)));
    res.writeHead(f ? 200 : 404); return res.end(f || 'nf');
  }
  handle(req, res);
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
  socket.on('data', () => {});
});

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const p = url.pathname;
    if (p === '/user') return send(res, 200, { id: 'mock-user', status: 'active' });
    if (p === '/object_info') return send(res, 200, Object.fromEntries(Object.keys(REQUIRED).map((c) => [c, OBJECT_INFO[c] || { name: c }])));
    if (p === '/system_stats') return send(res, 200, { system: { os: process.platform, comfyui_version: 'mock-0.1' }, devices: [{ name: 'mock-device' }] });
    if (p.startsWith('/object_info/')) {
      const c = decodeURIComponent(p.split('/')[2]);
      return send(res, 200, REQUIRED[c] ? { [c]: OBJECT_INFO[c] || { name: c } } : {});
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const parts = parseMultipart(body, req.headers['content-type']);
      const f = parts.image;
      if (!f) return send(res, 400, { error: 'no image' });
      uploads.set(f.filename, f.data);
      return send(res, 200, { name: f.filename, subfolder: '', type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const { prompt, extra_data: extra } = JSON.parse(body.toString());
      received.push(prompt);
      fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'data/mock-comfy-last-prompt.json'), JSON.stringify(prompt, null, 2));
      const errors = validate(prompt, extra);
      if (Object.keys(errors).length) return send(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: errors });
      const id = crypto.randomUUID();
      const item = { id, prompt, extra };
      if (running) pending.push(item); else execute(item);
      return send(res, 200, { prompt_id: id, number: received.length, node_errors: {} });
    }
    if (p === '/queue') return send(res, 200, { queue_running: running ? [[0, running.id]] : [], queue_pending: pending.map((x, i) => [i + 1, x.id]) });
    if (p.startsWith('/history/')) { const id = p.split('/')[2]; return send(res, 200, history[id] ? { [id]: history[id] } : {}); }
    if (p === '/view') {
      const f = outputs.get(url.searchParams.get('filename'));
      return f ? send(res, 200, f, 'application/octet-stream') : send(res, 404, { error: 'not found' });
    }
    if (p === '/interrupt') return send(res, 200, {});
    // Fake Gemini API (start the app with GEMINI_BASE_URL=http://127.0.0.1:8199/v1beta)
    const gm = p.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (gm && req.method === 'POST') {
      const b = JSON.parse(body.toString());
      if (!req.headers['x-goog-api-key']) return send(res, 403, { error: { message: 'API key missing' } });
      const parts = b.contents?.[0]?.parts || [];
      console.log(`✓ gemini ${gm[1]} (${parts.length} parts)`);
      if (b.generationConfig?.responseModalities?.includes('IMAGE')) {
        const img = [...parts].reverse().find((x) => x.inline_data)?.inline_data;
        return send(res, 200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: img?.mime_type || 'image/png', data: img?.data || '' } }] } }] });
      }
      const analysis = {
        summary: 'She films a casual mirror selfie, then turns and smiles at the camera.', format: 'mirror selfie / outfit check',
        hook: 'sudden turn to camera', on_screen_text: '', setting: 'small bedroom, white walls, unmade bed', lighting: 'warm window light, afternoon',
        camera: 'medium shot, phone held at chest height in the mirror, slight handheld sway', outfit: 'oversized hoodie and shorts',
        start_pose: 'standing sideways to the mirror, looking at phone', timeline: [{ t: '0-2s', action: 'looks at phone screen' }, { t: '2-5s', action: 'turns to camera and smiles' }],
        duration_seconds: 6, audio: 'trending lo-fi sound', why_it_works: 'relatable, authentic, quick payoff',
        first_frame_prompt: 'the woman standing sideways in front of a bedroom mirror holding a phone, warm afternoon light',
        video_prompt: '[0-2s] the woman looks at her phone in the mirror; [2-5s] she turns towards the camera and smiles; handheld phone sway; no text',
      };
      return send(res, 200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(analysis) }] } }] });
    }
    send(res, 404, { error: 'not found' });
  });
}
server.listen(PORT, '127.0.0.1', () => console.log(`Mock ComfyUI at http://127.0.0.1:${PORT} (require key: ${REQUIRE_KEY})`));
