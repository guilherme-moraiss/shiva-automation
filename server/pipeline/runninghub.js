/**
 * RunningHub: cloud ComfyUI with the community custom nodes and models pre-installed.
 * The app runs the user's OWN workflows, exactly as they are saved in their RunningHub account,
 * and only replaces inputs (nodeInfoList: nodeId + fieldName + fieldValue). Endpoints (RunningHub docs,
 * same as production clients such as AIDC-AI Pixelle-MCP):
 *   POST /task/openapi/upload           multipart { apiKey, fileType, file }             → data.fileName ("api/…")
 *   POST /api/openapi/getJsonApiFormat  { apiKey, workflowId }                           → data.prompt (API-format JSON string)
 *   POST /task/openapi/create           { apiKey, workflowId, nodeInfoList, instanceType } → data.taskId
 *   POST /task/openapi/status           { apiKey, taskId }                               → data: QUEUED | RUNNING | SUCCESS | FAILED
 *   POST /task/openapi/outputs          { apiKey, taskId }                               → data: [{ fileUrl, fileType, nodeId?, … }]
 *                                        (code 804 running, 813 queued, 805 failed with data.failedReason)
 *   POST /task/openapi/cancel           { apiKey, taskId }
 *   POST /uc/openapi/accountStatus      { apikey }                                       → data.remainCoins / remainMoney / currency
 * Every reply is { code, msg, data }; code 0 = OK.
 */

export class RunningHubError extends Error {}

export const RH_SITES = { ai: 'https://www.runninghub.ai', cn: 'https://www.runninghub.cn' };
export const RH_INSTANCES = { default: '24 GB', plus: '48 GB', ultra: '84 GB' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

/** A workflow link from the RunningHub site, or the bare id → the id. */
export function rhWorkflowId(v) {
  const s = String(v || '').trim();
  return s.match(/(\d{12,})/)?.[1] || (/^\d+$/.test(s) ? s : '');
}

/** Plain-Portuguese explanation of a RunningHub error reply (the original message is always kept). */
function explain(r, what) {
  const msg = String(r?.msg || r?.message || '').trim();
  const reason = r?.data?.failedReason;
  const detail = reason ? ` ${reason.node_name ? `Node ${reason.node_name}: ` : ''}${String(reason.exception_message || '').trim().split('\n')[0]}` : '';
  // RunningHub codes all start with "APIKEY_" (APIKEY_TASK_IS_RUNNING, APIKEY_INVALID_NODE_INFO…): match the specific part.
  const hint =
    /INVALID_NODE_INFO|node.?info|node_errors|fieldName/i.test(msg) ? 'A node or field that the app replaces does not exist in this workflow: press Verify in Settings → RunningHub.'
      : r?.code === 805 || /TASK_STATUS_ERROR|TASK_FAILED/i.test(msg) ? 'The task failed on RunningHub.'
        : /TOKEN_INVALID|APIKEY_(INVALID|UNAUTHORI[SZ]ED|USER_NOT_FOUND|NOT_FOUND|DISABLED)\b|invalid api ?key|unauthori[sz]ed/i.test(msg) ? 'Invalid RunningHub API key, or the key has no API access.'
          : /BALANCE|余额|INSUFFICIENT|NOT_ENOUGH|COINS?_|充值/i.test(msg) ? 'Insufficient balance on RunningHub: top up the account at runninghub.ai.'
            : /QUEUE_MAXED|TASK_LIMIT|QUEUE|排队|CONCURREN|并发/i.test(msg) ? 'RunningHub is not accepting more tasks right now (full queue or concurrent task limit). Try again shortly.'
              : /WORKFLOW_NOT_EXISTS|NOT_EXISTS?\b|not.*found|不存在/i.test(msg) ? 'Workflow not found in this RunningHub account: check the ID in Settings → RunningHub.'
                : /NOT_SAVED|NOT_RUN|运行成功/i.test(msg) ? 'The workflow must be saved and run successfully once on RunningHub before the API can use it.'
                  : '';
  return `RunningHub${what ? ` (${what})` : ''}: ${hint ? `${hint} ` : ''}Reply: «${msg || `code ${r?.code}`}».${detail}`;
}

export class RunningHub {
  constructor({ apiKey, baseUrl } = {}) {
    if (!apiKey) throw new RunningHubError('The RunningHub API key is missing: paste it in Settings → RunningHub');
    this.key = apiKey;
    this.base = String(process.env.RUNNINGHUB_URL || baseUrl || RH_SITES.ai).replace(/\/+$/, '');
  }

  /** POST JSON → raw { code, msg, data }. Network errors and 5xx are retried with backoff. */
  async post(path, body, { timeout = 60_000, retries = 2 } = {}) {
    let last;
    for (let a = 0; a <= retries; a++) {
      try {
        const res = await fetch(this.base + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (res.ok && data && typeof data === 'object') return data;
        last = Object.assign(new RunningHubError(`RunningHub HTTP ${res.status}: ${text.slice(0, 200) || 'no response'}`), { httpStatus: res.status });
        if (res.status < 500 && res.status !== 429) throw last;
      } catch (e) {
        if (e instanceof RunningHubError && e.httpStatus && e.httpStatus < 500 && e.httpStatus !== 429) throw e;
        last = e instanceof RunningHubError ? e : new RunningHubError(`No response from RunningHub (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      }
      if (a < retries) await sleep(1500 * 2 ** a);
    }
    throw last;
  }

  data(r, what) {
    if (r?.code === 0) return r.data;
    throw Object.assign(new RunningHubError(explain(r, what)), { code: r?.code, raw: r });
  }

  /** Upload an input file; returns the RunningHub file name for LoadImage / VHS_LoadVideo ("api/…"). */
  async upload(buf, fileName) {
    const ext = String(fileName).split('.').pop().toLowerCase();
    let last;
    for (let a = 0; a < 3; a++) {
      try {
        const fd = new FormData();
        fd.append('apiKey', this.key);
        fd.append('fileType', 'input');
        fd.append('file', new Blob([buf], { type: MIME[ext] || 'application/octet-stream' }), fileName);
        const res = await fetch(this.base + '/task/openapi/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(300_000) });
        const text = await res.text();
        let r = null;
        try { r = JSON.parse(text); } catch {}
        if (!res.ok || !r) throw Object.assign(new RunningHubError(`RunningHub upload HTTP ${res.status}: ${text.slice(0, 200)}`), { httpStatus: res.status });
        const d = this.data(r, 'file upload');
        const name = d?.fileName || d?.url;
        if (!name) throw new RunningHubError('RunningHub: the file upload did not return the file name');
        return name;
      } catch (e) {
        last = e;
        if (e.code !== undefined && e.code !== null) throw e; // an API answer (bad key, no balance…): no point retrying
        if (e.httpStatus && e.httpStatus < 500) throw e;
        await sleep(2000 * (a + 1));
      }
    }
    throw last;
  }

  /** The saved workflow in API format (RunningHub's own UI→API conversion, real input names). */
  async workflowApi(workflowId) {
    const d = this.data(await this.post('/api/openapi/getJsonApiFormat', { apiKey: this.key, workflowId: String(workflowId) }), 'reading the workflow');
    const p = typeof d?.prompt === 'string' ? JSON.parse(d.prompt) : d?.prompt;
    if (!p || typeof p !== 'object') throw new RunningHubError('RunningHub: the workflow came back empty');
    return p;
  }

  async create(workflowId, nodeInfoList, { instanceType } = {}) {
    const body = { apiKey: this.key, workflowId: String(workflowId), nodeInfoList };
    if (instanceType && instanceType !== 'default') body.instanceType = instanceType;
    const d = this.data(await this.post('/task/openapi/create', body, { retries: 0 }), 'creating the task');
    let tips = null;
    try { tips = typeof d?.promptTips === 'string' ? JSON.parse(d.promptTips) : d?.promptTips; } catch {}
    const errs = tips?.node_errors && Object.keys(tips.node_errors).length ? tips.node_errors : null;
    if (errs) {
      const first = Object.entries(errs)[0];
      const why = first?.[1]?.errors?.[0];
      throw Object.assign(new RunningHubError(`RunningHub rejected the workflow: node ${first?.[0]} (${first?.[1]?.class_type || '?'}) — ${why?.message || ''} ${why?.details || ''}`.trim()), { nodeErrors: errs });
    }
    if (!d?.taskId) throw new RunningHubError('RunningHub: the task did not return a taskId');
    return { taskId: String(d.taskId), status: d.taskStatus || null };
  }

  async status(taskId) {
    return String(this.data(await this.post('/task/openapi/status', { apiKey: this.key, taskId: String(taskId) }), 'task status') || '').toUpperCase();
  }

  /** Raw outputs reply: code 0 → data list; 804 running; 813 queued; 805 failed. */
  async outputsRaw(taskId) {
    return this.post('/task/openapi/outputs', { apiKey: this.key, taskId: String(taskId) });
  }

  async cancel(taskId) {
    try { await this.post('/task/openapi/cancel', { apiKey: this.key, taskId: String(taskId) }, { retries: 0 }); } catch {}
  }

  async account() {
    return this.data(await this.post('/uc/openapi/accountStatus', { apikey: this.key, apiKey: this.key }), 'account');
  }

  /**
   * Create (or resume) a task and wait for its outputs.
   * `taskId`: resume a task created before a restart (it is already paid for).
   * `onTask(taskId)`: called right after creation so the caller can save it.
   */
  async run({ workflowId, nodeInfoList, instanceType, taskId, onTask, onStatus, isCancelled, maxMs = 3 * 3600_000 }) {
    if (!taskId) {
      ({ taskId } = await this.create(workflowId, nodeInfoList, { instanceType }));
      await onTask?.(taskId);
    }
    const t0 = Date.now();
    let lastMsg = '';
    let failures = 0;
    for (;;) {
      if (isCancelled?.()) { await this.cancel(taskId); throw new RunningHubError('Canceled'); }
      if (Date.now() - t0 > maxMs) throw Object.assign(new RunningHubError('RunningHub: timed out waiting for the result'), { timeout: true });
      let st;
      try { st = await this.status(taskId); failures = 0; } catch (e) {
        if (e.code !== undefined && e.code !== null) throw e;
        if (++failures > 20) throw e;
        await sleep(5000);
        continue;
      }
      if (st === 'SUCCESS') {
        const r = await this.outputsRaw(taskId);
        if (r.code === 0) return { taskId, outputs: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [] };
        if (r.code === 804 || r.code === 813) { await sleep(3000); continue; }
        throw Object.assign(new RunningHubError(explain(r, 'result')), { code: r.code, raw: r });
      }
      if (st === 'FAILED') {
        const r = await this.outputsRaw(taskId).catch(() => null);
        throw Object.assign(new RunningHubError(r ? explain(r, 'the task failed') : 'RunningHub: the task failed'), { code: r?.code, failed: true });
      }
      const msg = st === 'QUEUED' ? 'In the RunningHub queue…' : st === 'RUNNING' ? `Running on RunningHub… ${Math.round((Date.now() - t0) / 1000)} s` : `RunningHub: ${st || 'waiting'}…`;
      if (msg !== lastMsg) { lastMsg = msg; onStatus?.(msg); }
      await sleep(5000);
    }
  }

  /** Download an output file to a Buffer. */
  static async download(url) {
    let last;
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) throw new RunningHubError(`Could not download the RunningHub result (HTTP ${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) { last = e; await sleep(2000 * (a + 1)); }
    }
    throw last;
  }
}
