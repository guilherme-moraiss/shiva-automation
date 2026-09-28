import crypto from 'node:crypto';

/**
 * ComfyUI client for both targets:
 *   - local  → ComfyUI Desktop / manual install on this Mac (http://127.0.0.1:8000), no auth.
 *   - cloud  → Comfy Cloud (https://cloud.comfy.org), `X-API-Key` header, routes under /api,
 *              completion via WebSocket (+ /api/job/<id>/status), /api/view answers with a 302 to a signed URL.
 *
 * How ComfyUI executes things:
 *   1. Every workflow is a graph of nodes. The "API format" is a flat JSON object
 *        { "<node id>": { "class_type": "LoadImage", "inputs": { "image": "x.png" } }, ... }
 *      where an input is either a literal (widget value) or a link `["<other node id>", <output index>]`.
 *   2. Input files (images/videos) must live in ComfyUI's `input/` folder → POST /upload/image.
 *   3. POST /prompt { prompt, client_id, extra_data } queues the graph and returns a prompt_id.
 *      Partner/API nodes (Wan 3.0, Nano Banana…) read the comfy.org key from extra_data.api_key_comfy_org.
 *   4. When the run finishes, `outputs[node_id]` lists the files written by Save* nodes,
 *      downloadable via GET /view?filename=…&subfolder=…&type=output.
 */

export const COMFY_CLOUD_URL = process.env.COMFY_CLOUD_URL || 'https://cloud.comfy.org';

export class ComfyError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const CLIENT_ID = `reels-radar-${crypto.randomUUID()}`;
const TERMINAL = ['success', 'error', 'non_retryable_error', 'lost', 'cancelled', 'failed', 'completed'];

export class ComfyClient {
  /** @param opts { mode: 'local'|'cloud', url, apiKey } */
  constructor({ mode = 'local', url, apiKey = '' } = {}) {
    this.mode = mode;
    this.apiKey = apiKey;
    this.base = String(mode === 'cloud' ? COMFY_CLOUD_URL : url || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    this.prefix = mode === 'cloud' ? '/api' : '';
  }

  static fromSettings(s) {
    return new ComfyClient({ mode: s.comfy_mode, url: s.comfy_url, apiKey: s.comfy_api_key });
  }

  get label() { return this.mode === 'cloud' ? 'Comfy Cloud' : 'ComfyUI'; }

  headers(extra = {}) {
    // v1 routes read X-API-Key, v2 routes read the Bearer token — send both.
    return this.mode === 'cloud' && this.apiKey ? { 'X-API-Key': this.apiKey, Authorization: `Bearer ${this.apiKey}`, ...extra } : extra;
  }

  async req(path, opts = {}, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(this.base + this.prefix + path, { ...opts, headers: this.headers(opts.headers), signal: ctrl.signal });
    } catch (e) {
      throw new ComfyError(
        e.name === 'AbortError' ? `${this.label} did not respond (${path})`
          : this.mode === 'cloud' ? `Could not connect to Comfy Cloud (${e.message})` : `Could not connect to ComfyUI at ${this.base} — is it open?`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  async jsonReq(path, opts, timeoutMs) {
    const res = await this.req(path, opts, timeoutMs);
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const fail = (msg) => Object.assign(new ComfyError(msg, body), { status: res.status });
      if (res.status === 404 || res.status === 405 || res.status === 410) throw fail(`${this.label}: endpoint ${path} does not exist (HTTP ${res.status})`);
      const serverMsg = body?.error?.message || body?.message || '';
      if (/free tier/i.test(serverMsg) || body?.error?.type === 'FREE_TIER_NOT_ALLOWED') {
        throw fail('Your Comfy Cloud account is on the Free plan: the Cloud API only works with a paid subscription. Use the "ComfyUI on Mac" mode (free, it only uses credits) or upgrade your Cloud plan.');
      }
      if (res.status === 401 || res.status === 403) throw fail(`${this.label}: invalid API key or no access (HTTP ${res.status})${serverMsg ? ` — ${serverMsg}` : ''}`);
      if (res.status === 402) throw new ComfyError(`${this.label}: no credits or no active subscription (HTTP 402)`, body);
      const msg = body?.error?.message || body?.error || body?.message || body?.raw || `HTTP ${res.status}`;
      throw new ComfyError(`${this.label}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, body);
    }
    return body;
  }

  /** Connectivity + auth check. Returns { ok, version, devices }. */
  async ping() {
    if (this.mode === 'cloud') {
      if (!this.apiKey) throw new ComfyError('The comfy.org API key is missing');
      const user = await this.jsonReq('/user', {}, 15000); // 401 if the key is wrong
      const st = await this.jsonReq('/system_stats', {}, 15000).catch(() => ({}));
      const billing = await this.jsonReq('/billing/status', {}, 15000).catch(() => null);
      const tier = billing?.subscription_tier || null;
      const out = { ok: true, version: `Comfy Cloud ${st.system?.cloud_version || ''}`.trim(), devices: ['cloud'], account: user.status || 'ok', tier, hasFunds: billing?.has_funds ?? null };
      if (tier === 'FREE') {
        out.ok = false;
        out.error = 'Comfy Cloud account on the Free plan: the key is valid and you have credits, but Comfy does not allow running workflows through the API on the Free plan. Use "ComfyUI on Mac" (free) or upgrade your Cloud plan.';
      }
      return out;
    }
    const st = await this.jsonReq('/system_stats', {}, 5000);
    return { ok: true, version: st.system?.comfyui_version || '?', os: st.system?.os, devices: (st.devices || []).map((d) => d.name) };
  }

  /** Whole /object_info (Comfy Cloud only serves the full list), cached for 10 minutes. */
  async allObjectInfo() {
    const cache = ComfyClient._infoCache;
    if (cache && cache.base === this.base && Date.now() - cache.at < 10 * 60e3) return cache.info;
    const info = await this.jsonReq('/object_info', {}, 60000);
    ComfyClient._infoCache = { base: this.base, at: Date.now(), info };
    return info;
  }

  /** Which of the given node classes are installed. */
  async hasNodes(classes) {
    const info = await this.objectInfo(classes);
    return Object.fromEntries(classes.map((c) => [c, !!info[c]]));
  }

  /** Full /object_info entries for the given classes (missing ones are omitted). */
  async objectInfo(classes) {
    if (this.mode === 'cloud') {
      const all = await this.allObjectInfo().catch(() => ({}));
      return Object.fromEntries([...new Set(classes)].filter((c) => all[c]).map((c) => [c, all[c]]));
    }
    const out = {};
    await Promise.all([...new Set(classes)].map(async (c) => {
      try {
        const info = await this.jsonReq(`/object_info/${encodeURIComponent(c)}`, {}, 20000);
        if (info[c]) out[c] = info[c];
      } catch {}
    }));
    return out;
  }

  /** Workflow behind a Comfy Cloud share link (…/?share=<id>). Needs the API key. */
  static async sharedWorkflow(shareId, apiKey) {
    const cloud = new ComfyClient({ mode: 'cloud', apiKey });
    if (!apiKey) throw new ComfyError('Paste the comfy.org API key first to import shared workflows');
    const body = await cloud.jsonReq(`/workflows/published/${encodeURIComponent(shareId)}`, {}, 30000);
    let wf = body.workflow_json ?? body.workflowJson ?? body.workflow ?? body.data?.workflow_json;
    if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch { wf = null; } }
    if (!wf || typeof wf !== 'object') throw new ComfyError('The link did not return a valid workflow');
    return { workflow: wf, name: body.name || body.title || body.workflow_name || `share-${shareId}`, assets: body.assets || [], raw: body };
  }

  /** Upload a file into ComfyUI's input folder. Returns the name to put in LoadImage/LoadVideo. */
  async upload(buf, filename, mime = 'image/png') {
    const fd = new FormData();
    fd.append('image', new Blob([buf], { type: mime }), filename);
    fd.append('overwrite', 'true');
    fd.append('type', 'input');
    try {
      const r = await this.jsonReq('/upload/image', { method: 'POST', body: fd }, 180000);
      return r.subfolder && this.mode !== 'cloud' ? `${r.subfolder}/${r.name}` : r.name;
    } catch (e) {
      if (this.mode !== 'cloud' || ![404, 405, 410].includes(e.status)) throw e;
      // Cloud v2: upload as an asset; LoadImage/LoadVideo reference it by its file_path.
      const v2 = new FormData();
      v2.append('file', new Blob([buf], { type: mime }), filename);
      v2.append('content_type', mime);
      v2.append('file_path', filename);
      v2.append('tags', 'input');
      const a = await this.jsonReq('/v2/assets', { method: 'POST', body: v2, headers: { 'Idempotency-Key': crypto.randomUUID() } }, 180000);
      return a.file_path || a.name || filename;
    }
  }

  async queue(prompt) {
    const body = { prompt, client_id: CLIENT_ID, extra_data: {} };
    if (this.apiKey) body.extra_data.api_key_comfy_org = this.apiKey;
    try {
      const r = await this.jsonReq('/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.node_errors && Object.keys(r.node_errors).length) throw new ComfyError(describeNodeErrors(r.node_errors), r);
      return r.prompt_id;
    } catch (e) {
      if (e.details?.node_errors && Object.keys(e.details.node_errors).length) {
        throw new ComfyError(describeNodeErrors(e.details.node_errors), e.details);
      }
      throw e;
    }
  }

  async queuePosition(promptId) {
    try {
      const q = await this.jsonReq('/queue', {}, 8000);
      const id = (x) => (Array.isArray(x) ? x[1] : x?.prompt_id);
      if ((q.queue_running || []).some((x) => id(x) === promptId)) return 0;
      const idx = (q.queue_pending || []).findIndex((x) => id(x) === promptId);
      return idx >= 0 ? idx + 1 : null;
    } catch { return null; }
  }

  async interrupt() { await this.req('/interrupt', { method: 'POST' }).catch(() => {}); }

  // ---- local: poll /history ----------------------------------------------------------------
  async waitLocal(promptId, { timeoutMs, onProgress, isCancelled }) {
    const started = Date.now();
    let lastPos;
    while (Date.now() - started < timeoutMs) {
      if (isCancelled?.()) { await this.interrupt(); throw new ComfyError('Canceled'); }
      const h = await this.jsonReq(`/history/${promptId}`, {}, 15000).catch(() => ({}));
      const entry = h[promptId];
      const st = entry?.status?.status_str;
      if (entry && (entry.status?.completed || st === 'success' || st === 'error')) {
        if (st === 'error') throw executionError((entry.status.messages || []).find((m) => m[0] === 'execution_error')?.[1]);
        return outputFiles(entry.outputs);
      }
      const pos = await this.queuePosition(promptId);
      if (pos !== lastPos) { lastPos = pos; onProgress?.(pos === 0 ? 'running on ComfyUI…' : pos ? `in the ComfyUI queue (position ${pos})` : 'waiting for ComfyUI…'); }
      await sleep(3000);
    }
    throw new ComfyError('Timeout waiting for ComfyUI');
  }

  // ---- cloud: websocket events + status polling -----------------------------------------------
  openEvents() {
    const events = { outputs: {}, done: null, error: null, progress: null, listeners: new Set() };
    try {
      const wsUrl = this.base.replace(/^http/, 'ws') + `/ws?clientId=${CLIENT_ID}&token=${encodeURIComponent(this.apiKey)}`;
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return; // binary previews
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        const pid = m.data?.prompt_id;
        if (!pid) return;
        for (const fn of events.listeners) fn(pid, m.type, m.data);
      };
      ws.onerror = () => {};
      events.close = () => { try { ws.close(); } catch {} };
    } catch {
      events.close = () => {};
    }
    return events;
  }

  async waitCloud(promptId, events, { timeoutMs, onProgress, isCancelled }) {
    const outputs = {};
    let finished = null;
    let failure = null;
    events.listeners.add((pid, type, data) => {
      if (pid !== promptId) return;
      if (type === 'executed' && data.output) outputs[data.node] = data.output;
      else if (type === 'execution_success') finished = true;
      else if (type === 'execution_error') failure = data;
      else if (type === 'progress' && data.max) onProgress?.(`generating on Comfy Cloud… ${Math.round((data.value / data.max) * 100)}%`);
      else if (type === 'executing' && data.node) onProgress?.('running on Comfy Cloud…');
    });
    const started = Date.now();
    let lastStatus = null;
    let lastPoll = 0;
    while (Date.now() - started < timeoutMs) {
      if (isCancelled?.()) {
        await this.jsonReq('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
        await this.interrupt();
        throw new ComfyError('Canceled');
      }
      if (failure) throw executionError(failure);
      if (finished) break;
      if (Date.now() - lastPoll > 6000) {
        lastPoll = Date.now();
        const st = await this.jsonReq(`/job/${promptId}/status`, {}, 15000).catch(() => null);
        const status = String(st?.status || '').toLowerCase();
        if (status && status !== lastStatus) {
          lastStatus = status;
          if (!TERMINAL.includes(status)) onProgress?.(`Comfy Cloud: ${status}`);
        }
        if (['error', 'non_retryable_error', 'lost', 'cancelled', 'failed'].includes(status)) {
          await sleep(1500); // give the websocket a moment to deliver the error details
          if (failure) throw executionError(failure);
          throw new ComfyError(`Comfy Cloud: job ended with status "${status}"${st?.error ? ` — ${JSON.stringify(st.error).slice(0, 200)}` : ''}`);
        }
        if (['success', 'completed'].includes(status)) { await sleep(1500); break; }
      }
      await sleep(1000);
    }
    if (!finished && !['success', 'completed'].includes(lastStatus)) throw new ComfyError('Timeout waiting for Comfy Cloud');
    let files = outputFiles(outputs);
    if (!files.length) {
      // Websocket missed the outputs — try the history endpoints.
      for (const p of [`/history_v2/${promptId}`, `/history/${promptId}`, `/jobs/${promptId}`]) {
        const h = await this.jsonReq(p, {}, 15000).catch(() => null);
        const entry = h?.[promptId] || h;
        files = outputFiles(entry?.outputs || {});
        if (files.length) break;
      }
    }
    return files;
  }

  async download(file) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    let res = await this.req(`/view?${q}`, { redirect: this.mode === 'cloud' ? 'manual' : 'follow' }, 300000);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      // Signed URL — must be fetched WITHOUT our auth header.
      res = await fetch(new URL(res.headers.get('location'), this.base));
    }
    if (!res.ok) throw new ComfyError(`Failed to download ${file.filename} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Comfy Cloud v2 jobs API: submit → poll /api/v2/jobs/<id> → download outputs by URL. */
  async runV2(prompt, { exts, onProgress, isCancelled, timeoutMs }) {
    const body = { workflow: prompt, extra_data: this.apiKey ? { api_key_comfy_org: this.apiKey } : {} };
    let job = await this.jsonReq('/v2/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
    }, 60000);
    onProgress?.('sent to Comfy Cloud (v2)');
    const started = Date.now();
    while (!['succeeded', 'failed', 'expired', 'canceled'].includes(job.status)) {
      if (Date.now() - started > timeoutMs) throw new ComfyError('Timeout waiting for Comfy Cloud');
      if (isCancelled?.()) {
        await this.jsonReq(`/v2/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
        throw new ComfyError('Canceled');
      }
      await sleep(3000);
      job = await this.jsonReq(`/v2/jobs/${job.id}`, {}, 20000).catch(() => job);
      const p = job.progress;
      if (job.status === 'queued') onProgress?.(`in the Comfy Cloud queue${job.queue_position ? ` (position ${job.queue_position})` : ''}`);
      else if (job.status === 'running') onProgress?.(`generating on Comfy Cloud… ${p?.value != null ? Math.round(p.value * 100) + '%' : ''}${p?.current_node_class ? ` · ${p.current_node_class}` : ''}`);
    }
    if (job.status !== 'succeeded') {
      const e = job.error || {};
      throw executionError({ node_type: e.class_type || e.code, exception_message: e.message || `job ${job.status}` });
    }
    const outs = job.outputs || [];
    const out = outs.find((o) => !exts || exts.some((x) => String(o.name || '').toLowerCase().endsWith(x))) || outs[0];
    if (!out) throw new ComfyError('The workflow finished but did not save any file (is a Save node missing?)');
    // Absolute URLs are usually signed (no auth header); relative ones are API paths on the Cloud host.
    const target = out.url ? new URL(out.url, this.base) : new URL(`/api/v2/assets/${out.id}`, this.base);
    const sameHost = target.origin === new URL(this.base).origin && target.pathname.startsWith('/api/');
    const res = await fetch(target, { headers: sameHost ? this.headers() : {} });
    if (!res.ok) throw new ComfyError(`Failed to download ${out.name} (HTTP ${res.status})`);
    return { promptId: job.id, file: { filename: out.name, type: 'output' }, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  /** Queue + wait + download the first file matching `exts`. */
  async run(prompt, { exts, onProgress, isCancelled, timeoutMs = 30 * 60e3 } = {}) {
    if (this.mode === 'cloud' && ComfyClient.useV2) return this.runV2(prompt, { exts, onProgress, isCancelled, timeoutMs });
    const events = this.mode === 'cloud' ? this.openEvents() : null;
    try {
      if (events) await sleep(300); // let the socket connect before queueing
      let id;
      try {
        id = await this.queue(prompt);
      } catch (e) {
        if (this.mode === 'cloud' && [404, 405, 410].includes(e.status)) {
          ComfyClient.useV2 = true; // v1 retired on this account — remember for the rest of the session
          events?.close();
          return this.runV2(prompt, { exts, onProgress, isCancelled, timeoutMs });
        }
        throw e;
      }
      onProgress?.(`sent to ${this.label}`);
      const files = events
        ? await this.waitCloud(id, events, { timeoutMs, onProgress, isCancelled })
        : await this.waitLocal(id, { timeoutMs, onProgress, isCancelled });
      const outs = files.filter((f) => (f.type || 'output') === 'output');
      const file = outs.find((f) => !exts || exts.some((e) => f.filename.toLowerCase().endsWith(e))) || outs[0];
      if (!file) throw new ComfyError('The workflow finished but did not save any file (is a Save node missing?)');
      return { promptId: id, file, buffer: await this.download(file) };
    } finally {
      events?.close();
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All files in an outputs map: [{ filename, subfolder, type, nodeId }]. */
function outputFiles(outputs) {
  const files = [];
  for (const [nodeId, out] of Object.entries(outputs || {})) {
    for (const list of Object.values(out || {})) {
      if (!Array.isArray(list)) continue;
      for (const f of list) if (f && typeof f === 'object' && f.filename) files.push({ ...f, nodeId });
    }
  }
  return files;
}

function executionError(err) {
  let msg = err ? `${err.node_type || 'node'}: ${String(err.exception_message || '').trim().split('\n')[0]}` : 'Execution failed';
  if (/unauthori[sz]ed|login first/i.test(msg)) msg += ' — the comfy.org API key is missing in Settings';
  else if (/credit|balance|payment|insufficient/i.test(msg)) msg += ' — no credits on the comfy.org account';
  return new ComfyError(msg, err);
}

function describeNodeErrors(nodeErrors) {
  const parts = [];
  for (const [id, ne] of Object.entries(nodeErrors)) {
    for (const e of ne.errors || []) parts.push(`${ne.class_type || 'node'} #${id}: ${e.message}${e.details ? ` (${e.details})` : ''}`);
  }
  return parts.join(' · ') || 'Invalid workflow';
}
