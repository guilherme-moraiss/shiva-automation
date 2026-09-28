// Simulated RunningHub workflow API, to test the app without spending credits.
//   node scripts/mock-runninghub.js                → http://127.0.0.1:8399   (API key: rh-good-key)
//   RUNNINGHUB_URL=http://127.0.0.1:8399 npm start
// Workflow ids (see WF below): …001 WAN Animate · …002 NB WanAnimate · …003 SKY · …004 SKY 18+ · …005 TTT Animator ·
// …006 Animate X · …007 INSTARAW Faceswap · …008 WAN 2.2 Instagirl · …009 INSTARAW zImage (saved in img2img mode) ·
// …010 zImage as in the file (text→image mode) · …011 SDXL+zImage · …012 SDXL+WAN · …013 Detailing · …014 Inpainting ·
// …015 Faceswap without API keys · …016 Faceswap with the "fully clothe" group switched on.
// Like RunningHub it: returns the saved workflow in API format (bypassed/muted nodes left out, every widget named),
// rejects node/field ids that do not exist and input files that were not uploaded, queues → runs → finishes, and
// returns the saved outputs (plus previews / side-by-sides / pose videos, to check that the app keeps the right file).
// A seed of 666 makes the task fail. MOCK_RH_FAIL=1 fails every task, MOCK_RH_NO_NODE_ID=1 leaves nodeId out.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_RH_PORT) || 8399;
const BASE = `http://127.0.0.1:${PORT}`;
const DELAY = Number(process.env.MOCK_RH_DELAY_MS) || 4000;
const KEY = 'rh-good-key';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// out: [nodeId, file name prefix] of every saved output (the first one is the real result)
const WF = {
  '100000000000001': { file: 'wan-animate.json', kind: 'video', out: [['119', 'WanAnimate']] },
  '100000000000002': { file: 'nb-wan-animate.json', kind: 'video', out: [['186', 'NB_WanAnimate'], ['30', 'NB_compare']] },
  '100000000000003': { file: 'sky-zimage-controlnet.json', kind: 'image', out: [['824', 'SKY_final'], ['510', 'SKY_compare']] },
  '100000000000004': { file: 'sky-zimage-controlnet.json', kind: 'image', out: [['824', 'SKY_final']] },
  '100000000000005': { file: 'ttt-animator.json', kind: 'video', out: [['319', 'SteadyDancer']] },
  // Animate X saves 4 videos (result, side-by-side, pose, faces) and this one answers without node ids: picked by name.
  '100000000000006': { file: 'animate-x.json', kind: 'video', noNodeId: true, out: [['226', 'KIARA_AnimateX', 'both'], ['303', 'ComfyUI'], ['301', 'ComfyUI'], ['300', 'ComfyUI']] },
  '100000000000007': { file: 'instaraw-faceswap.json', kind: 'image', fill: { 419: 'wavespeed-user-key' }, out: [['140', 'INSTARAW_Faceswap'], ['431', 'INSTARAW_Edited']] },
  '100000000000008': { file: 'wan22-instagirl-i2i.json', kind: 'image', out: [['17', 'ComfyUI']] },
  '100000000000009': { file: 'instaraw-zimage.json', kind: 'image', unbypass: [448], rpgField: true, out: [['613', 'HasMetadata'], ['402', 'zImage']] },
  '100000000000010': { file: 'instaraw-zimage.json', kind: 'image', out: [['613', 'HasMetadata']] },
  '100000000000011': { file: 'instaraw-sdxl-zimage.json', kind: 'image', unbypass: [393], out: [['505', 'HasMetadata'], ['464', 'SDXL']] },
  '100000000000012': { file: 'instaraw-sdxl-wan.json', kind: 'image', unbypass: [393], out: [['505', 'HasMetadata']] },
  '100000000000013': { file: 'instaraw-detailing.json', kind: 'image', out: [['151', 'Detailed']] },
  '100000000000014': { file: 'instaraw-sdxl-inpainting.json', kind: 'image', out: [['7', 'Inpainting']] },
  '100000000000015': { file: 'instaraw-faceswap.json', kind: 'image', out: [['140', 'INSTARAW_Faceswap']] },
  '100000000000016': { file: 'instaraw-faceswap.json', kind: 'image', fill: { 419: 'wavespeed-user-key' }, unbypass: [358], out: [['140', 'INSTARAW_Faceswap']] },
};

// Enough of a UI→API conversion for the mock: every widget of the nodes the app touches gets its real input name.
const VIRTUAL = new Set(['Reroute', 'Note', 'MarkdownNote', 'PrimitiveNode', 'GetNode', 'SetNode', 'Label (rgthree)', 'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)']);
const KNOWN = {
  LoadImage: ['image'],
  CLIPTextEncode: ['text'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  'Seed (rgthree)': ['seed'],
  INSTARAWSeedGenerator: ['seed'],
  KSampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  WanVideoSampler: ['steps', 'cfg', 'shift', 'seed', 'force_offload', 'scheduler', 'riflex_freq_index', 'denoise_strength', 'batched_cfg', 'rope_function', 'start_step', 'end_step', 'add_noise_to_samples'],
  'easy int': ['value'], 'easy string': ['value'], PrimitiveBoolean: ['value'], PrimitiveFloat: ['value'], PrimitiveInt: ['value'],
  PrimitiveString: ['value'], PrimitiveStringMultiline: ['value'], 'String Literal': ['string'], INSTARAW_FloatInput: ['value'],
  SaveImage: ['filename_prefix'], 'Image Save': ['output_path', 'filename_prefix'],
  INSTARAW_Interactive_Crop: ['timeout', 'cache_behavior', 'bypass', 'lock_aspect_ratio'],
  INSTARAW_TextImageFilter: ['enabled', 'text', 'timeout', 'cache_behavior', 'tip', 'extra1', 'extra2', 'extra3', 'textareaheight'],
  INSTARAW_MaskImageFilter: ['enabled', 'timeout', 'if_no_mask', 'cache_behavior', 'tip', 'extra1', 'extra2', 'extra3'],
  INSTARAW_ImageFilter: ['timeout', 'ontimeout', 'cache_behavior', 'tip', 'extra1', 'extra2', 'extra3', 'pick_list_start', 'pick_list', 'video_frames'],
};
const CONTROL = /^(fixed|increment|decrement|randomize)$/;
function uiToApiLite(ui, { unbypass = [], rpgField = false, fill = {} } = {}) {
  const api = {};
  for (const n of ui.nodes) {
    if (unbypass.includes(n.id)) n.mode = 0;
    if (VIRTUAL.has(n.type) || n.mode === 2 || n.mode === 4) continue;
    const inputs = {};
    const wv = n.widgets_values;
    if (wv && !Array.isArray(wv) && typeof wv === 'object') Object.assign(inputs, Object.fromEntries(Object.entries(wv).filter(([k]) => k !== 'videopreview')));
    else if (n.type === 'INSTARAW_AdvancedImageLoader' && Array.isArray(wv)) {
      Object.assign(inputs, { mode: wv[0], resize_mode: wv[1], enable_img2img: wv.find((x) => typeof x === 'boolean') ?? true, batch_data: wv.find((x) => typeof x === 'string' && x.startsWith('{')) ?? '{}' });
    } else if (n.type === 'INSTARAW_RealityPromptGenerator' && Array.isArray(wv)) {
      Object.assign(inputs, { gemini_api_key: wv[0], grok_api_key: wv[1] });
      const saved = wv.find((x) => typeof x === 'string' && x.startsWith('['));
      if (saved !== undefined || rpgField) inputs.prompt_batch_data = saved ?? '[]';
    } else if (Array.isArray(wv)) {
      const names = (n.inputs || []).filter((i) => i.widget).map((i) => i.widget.name).filter((x) => x !== 'upload');
      const list = KNOWN[n.type] || names;
      let i = 0;
      for (const name of list) {
        if (i >= wv.length) break;
        inputs[name] = wv[i++];
        if (/seed/.test(name) && CONTROL.test(String(wv[i]))) i++;
        if (n.type === 'LoadImage' && wv[i] === 'image') i++;
      }
    }
    if (fill[n.id] !== undefined) inputs.value = fill[n.id];
    for (const inp of n.inputs || []) if (inp.link != null && !(inp.name in inputs)) inputs[inp.name] = ['0', 0];
    api[String(n.id)] = { class_type: n.type, inputs, _meta: { title: n.title || n.type } };
  }
  return api;
}
const apis = {};
for (const [id, w] of Object.entries(WF)) apis[id] = uiToApiLite(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'workflows', w.file), 'utf8')), w);

const files = new Map(); // "api/…" and output names → { buf, type }
const tasks = new Map();
let seq = 0;
const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const ok = (res, data) => json(res, { code: 0, msg: 'success', data });
const err = (res, code, msg) => json(res, { code, msg, data: null });
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

/** The uploaded file a value points at: a plain "api/…" name, or the INSTARAW loader JSON ("../api/…"). */
function uploadedIn(item, node) {
  if (/^(LoadImage|VHS_LoadVideo)$/.test(node.class_type) && /^(image|video)$/.test(item.fieldName)) return { name: String(item.fieldValue), must: true };
  if (node.class_type === 'INSTARAW_AdvancedImageLoader' && item.fieldName === 'batch_data') {
    let d = null;
    try { d = JSON.parse(item.fieldValue); } catch { return { bad: 'batch_data is not JSON' }; }
    const f = d?.images?.[0]?.filename;
    if (!f || !d.order?.includes(d.images[0].id)) return { bad: 'batch_data without an image in order' };
    // INSTARAW looks in input/INSTARAW_ImagePool/<filename>: an upload is reached with "../".
    if (!f.startsWith('../')) return { bad: `batch_data filename not reachable from the image pool: ${f}` };
    return { name: f.slice(3), must: true };
  }
  return null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const raw = await body(req);
  if (u.pathname.startsWith('/files/')) {
    const name = decodeURIComponent(u.pathname.slice(7));
    const f = files.get(name);
    if (f) console.log(`download ${name}`);
    res.writeHead(f ? 200 : 404, f ? { 'Content-Type': f.type } : {});
    return res.end(f?.buf);
  }
  if (u.pathname === '/task/openapi/upload') {
    const fd = await new Request(BASE + u.pathname, { method: 'POST', headers: req.headers, body: raw }).formData();
    if (fd.get('apiKey') !== KEY) return err(res, 412, 'TOKEN_INVALID');
    const file = fd.get('file');
    const ext = String(file.name).split('.').pop().toLowerCase();
    const name = `api/${(++seq).toString(16).padStart(6, '0')}${Date.now()}.${ext}`;
    files.set(name, { buf: Buffer.from(await file.arrayBuffer()), type: file.type || 'application/octet-stream' });
    console.log(`upload ${name} (${file.name}, ${files.get(name).buf.length} bytes)`);
    return ok(res, { fileName: name, fileType: /mp4|mov|webm/.test(ext) ? 'video' : 'image' });
  }
  let b = {};
  try { b = raw.length ? JSON.parse(raw) : {}; } catch { return err(res, 400, 'bad json'); }
  const key = b.apiKey || b.apikey;
  if (key !== KEY) return err(res, 412, 'TOKEN_INVALID');
  if (u.pathname === '/uc/openapi/accountStatus') return ok(res, { remainCoins: '1234', remainMoney: '12.34', currency: 'USD', currentTaskCounts: '0', apiType: 'NORMAL' });
  if (u.pathname === '/api/openapi/getJsonApiFormat') {
    const api = apis[b.workflowId];
    return api ? ok(res, { prompt: JSON.stringify(api) }) : err(res, 810, 'WORKFLOW_NOT_EXISTS');
  }
  if (u.pathname === '/task/openapi/create') {
    const api = apis[b.workflowId];
    if (!api) return err(res, 810, 'WORKFLOW_NOT_EXISTS');
    const inputs = [];
    for (const it of b.nodeInfoList || []) {
      const n = api[String(it.nodeId)];
      if (!n || !(it.fieldName in n.inputs)) return err(res, 803, `APIKEY_INVALID_NODE_INFO: node ${it.nodeId}.${it.fieldName}`);
      const up = uploadedIn(it, n);
      if (up?.bad) return err(res, 803, `APIKEY_INVALID_NODE_INFO: ${up.bad}`);
      if (up?.must && !files.has(up.name)) return err(res, 803, `file not uploaded: ${up.name}`);
      if (up?.name) inputs.push({ field: it.fieldName, name: up.name });
      if (n.class_type === 'INSTARAW_RealityPromptGenerator' && it.fieldName === 'prompt_batch_data') {
        let p = null;
        try { p = JSON.parse(it.fieldValue); } catch {}
        if (!Array.isArray(p) || !p[0]?.positive_prompt) return err(res, 803, 'APIKEY_INVALID_NODE_INFO: prompt_batch_data without positive_prompt');
      }
    }
    const id = String(1900000000000000000 + ++seq);
    tasks.set(id, { wf: b.workflowId, list: b.nodeInfoList || [], inputs, t0: Date.now(), instanceType: b.instanceType || 'default' });
    console.log(`create ${id} wf=${b.workflowId} instance=${b.instanceType || 'default'} nodeInfoList=${JSON.stringify(b.nodeInfoList)}`);
    return ok(res, { taskId: id, taskStatus: 'QUEUED', promptTips: JSON.stringify({ result: true, node_errors: {} }) });
  }
  const t = tasks.get(String(b.taskId));
  if (/^\/task\/openapi\/(status|outputs|cancel)$/.test(u.pathname) && !t) return err(res, 807, 'TASK_NOT_FOUND');
  if (u.pathname === '/task/openapi/cancel') { t.cancelled = true; return ok(res, null); }
  const age = Date.now() - t.t0;
  const failed = !!process.env.MOCK_RH_FAIL || t.list.some((i) => /seed/.test(i.fieldName) && Number(i.fieldValue) === 666);
  const st = t.cancelled ? 'FAILED' : age < 1500 ? 'QUEUED' : age < DELAY ? 'RUNNING' : failed ? 'FAILED' : 'SUCCESS';
  if (u.pathname === '/task/openapi/status') return ok(res, st);
  if (u.pathname === '/task/openapi/outputs') {
    if (st === 'QUEUED') return err(res, 813, 'APIKEY_TASK_IS_QUEUED');
    if (st === 'RUNNING') return err(res, 804, 'APIKEY_TASK_IS_RUNNING');
    if (st === 'FAILED') return json(res, { code: 805, msg: 'APIKEY_TASK_STATUS_ERROR', data: { failedReason: { node_name: 'WanVideoSampler', exception_message: 'Allocation on device (mock)', traceback: '' } } });
    const w = WF[t.wf];
    // The "result" is the main input sent back (the video, else the picture the workflow worked on).
    const main = w.kind === 'video' ? t.inputs.find((i) => i.field === 'video') : t.inputs.find((i) => i.field === 'batch_data') || t.inputs.find((i) => i.field === 'image');
    const src = files.get(main.name);
    const ext = w.kind === 'video' ? 'mp4' : String(main.name).split('.').pop();
    const out = [];
    for (const [k, [node, prefix, both]] of w.out.entries()) {
      const names = both ? [`${prefix}_0000${k + 1}.${ext}`, `${prefix}_0000${k + 1}-audio.${ext}`] : [`${prefix}_0000${k + 1}${w.kind === 'video' ? '-audio' : '_'}.${ext}`];
      for (const name of names) {
        // Like RunningHub: a folder per task, ComfyUI's own file name at the end of the URL.
        const dir = `o/${t.wf.slice(-3)}${String(b.taskId).slice(-5)}`;
        files.set(`${dir}/${name}`, src);
        out.push({ fileUrl: `${BASE}/files/${dir}/${encodeURIComponent(name)}`, fileType: ext, nodeId: node, taskCostTime: '42', consumeCoins: '12' });
      }
    }
    // a preview the app must ignore
    out.push({ fileUrl: `${BASE}/files/o/rgthree.compare._temp_mock_00001_.png`, fileType: 'png', nodeId: '999' });
    if (process.env.MOCK_RH_NO_NODE_ID || w.noNodeId) out.forEach((o) => delete o.nodeId);
    return ok(res, out);
  }
  err(res, 404, `mock: no route ${u.pathname}`);
}).listen(PORT, '127.0.0.1', () => console.log(`mock RunningHub at ${BASE} (workflows: ${Object.keys(WF).join(', ')})`));
