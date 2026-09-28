/**
 * WaveSpeed AI (wavespeed.ai): the one provider for images, edits and video (the owner's choice, 27/09).
 *   submit:  POST {BASE}/api/v3/<model-id> { ...input }            → data.id (+ data.urls.get)
 *   result:  GET  {BASE}/api/v3/predictions/<id>/result            → data.status created|processing|completed|failed…, data.outputs [url]
 *   upload:  POST {BASE}/api/v3/media/upload/binary (multipart "file") → data.download_url (kept 7 days)
 *   balance: GET  {BASE}/api/v3/balance                            → data.balance (USD)
 * Auth: "Authorization: Bearer <key>". A request id is returned before the work starts, so a job survives a restart.
 * A refusal by a model's own content check is reported as it is: the app never rewords or retries it by itself.
 */
const BASE = (process.env.WAVESPEED_URL || 'https://api.wavespeed.ai').replace(/\/+$/, '');
/** The OpenAI-compatible LLM service (vision checks), same key. */
const LLM_BASE = (process.env.WAVESPEED_LLM_URL || 'https://llm.wavespeed.ai').replace(/\/+$/, '');

export class WaveSpeedError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Words a model's content check uses when it refuses (reported as a refusal, never retried or reworded). */
const SAFETY = /nsfw|safety|sensitive|content (?:policy|moderation|check)|moderat|inappropriate|DataInspection|Green net|not allowed content|prohibited/i;
export const isRefusal = (msg) => SAFETY.test(String(msg || ''));
/** The network error's own cause (ECONNRESET, UND_ERR_CONNECT_TIMEOUT…), shown and used to decide what is safe to resend. */
const causeCode = (e) => String(e?.cause?.code || e?.cause?.name || e?.code || '').trim();
/** Failed before anything reached WaveSpeed: safe to send again, even a paid request. */
const CONNECT_ERRORS = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError)$/;

export class WaveSpeed {
  constructor(key) {
    if (!key) throw new WaveSpeedError('The WaveSpeed API key is missing (Settings → Pipeline)');
    this.key = key;
  }

  async req(path, { method = 'GET', body, form, timeoutMs = 120000 } = {}) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: form || (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const code = causeCode(e);
      const why = e.name === 'TimeoutError' ? 'timed out' : [e.message, code].filter(Boolean).join(': ');
      throw Object.assign(new WaveSpeedError(`No answer from WaveSpeed (${why})`), { network: true, connect: CONNECT_ERRORS.test(code) });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    const msg = String(data?.message || data?.error || data?.data?.error || text || `HTTP ${res.status}`).slice(0, 400);
    if (res.status === 401 || res.status === 403) throw new WaveSpeedError(`WaveSpeed rejected the API key (${res.status}). Check the key at wavespeed.ai/accesskey.`);
    if (res.status === 402 || /insufficient|balance|credit|top ?up/i.test(res.ok ? '' : msg)) throw new WaveSpeedError(`No balance left on WaveSpeed: top up at wavespeed.ai. (${msg})`);
    if (!res.ok || (data && data.code && data.code !== 200)) {
      if (isRefusal(msg)) throw Object.assign(new WaveSpeedError(msg), { safety: true, raw: msg });
      throw Object.assign(new WaveSpeedError(`WaveSpeed ${res.status}: ${msg}`), { status: res.status, transient: [429, 500, 502, 503, 504].includes(res.status) });
    }
    return data?.data ?? data;
  }

  /** A file for a model input: uploaded once, its URL passed to the model. An upload costs nothing, so a dropped
   *  connection or a busy server is simply tried again (3 more times). */
  async upload(buf, filename, mime = 'application/octet-stream') {
    for (let attempt = 0; ; attempt++) {
      const form = new FormData(); // a new body each time (a sent one is used up)
      form.append('file', new Blob([buf], { type: mime }), filename);
      try {
        const d = await this.req('/api/v3/media/upload/binary', { method: 'POST', form, timeoutMs: 300000 });
        const url = d?.download_url || d?.url;
        if (!url) throw new WaveSpeedError('WaveSpeed did not return the URL of the uploaded file');
        return url;
      } catch (e) {
        if ((e.network || e.transient) && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        if (e.network || e.transient) e.message = `Could not upload ${filename} to WaveSpeed after 4 attempts (${e.message}). Nothing was charged: try again in a moment.`;
        throw e;
      }
    }
  }

  /** Submits a job; returns its id. */
  async submit(model, input) {
    let d;
    for (let attempt = 0; ; attempt++) {
      try { d = await this.req(`/api/v3/${model}`, { method: 'POST', body: input }); break; } catch (e) {
        // Sent again only when WaveSpeed surely did not get it (no connection made, or "busy, try later"): a request that
        // reached it may already be a paid job, and sending it twice would pay twice.
        if ((e.connect || [429, 503].includes(e.status)) && attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
        if (e.network && !e.connect) e.message = `${e.message}. The connection dropped while creating the request: it may have been created at WaveSpeed. Check the history on wavespeed.ai before trying again, so you don't pay twice.`;
        throw e;
      }
    }
    const id = d?.id;
    if (!id) throw new WaveSpeedError(`WaveSpeed did not accept the request: ${JSON.stringify(d).slice(0, 200)}`);
    return id;
  }

  /** Waits for a job; returns its outputs (URLs). */
  async wait(id, { onStatus, isCancelled, intervalMs = 3000, maxMs = 30 * 60e3 } = {}) {
    const t0 = Date.now();
    let fails = 0;
    for (;;) {
      if (isCancelled?.()) throw new WaveSpeedError('Canceled');
      if (Date.now() - t0 > maxMs) throw new WaveSpeedError('WaveSpeed: timed out waiting for the result');
      await sleep(intervalMs);
      let d;
      try { d = await this.req(`/api/v3/predictions/${encodeURIComponent(id)}/result`, { timeoutMs: 60000 }); fails = 0; } catch (e) {
        if ((e.network || e.transient) && ++fails < 15) continue; // a lost poll is not a lost job
        throw e;
      }
      const st = String(d?.status || '').toLowerCase();
      if (st === 'completed') {
        const outs = [].concat(d.outputs || []).filter(Boolean);
        if (d.has_nsfw_contents?.some?.(Boolean) && !outs.length) throw Object.assign(new WaveSpeedError('The content filter of the model blocked the result'), { safety: true, raw: 'has_nsfw_contents' });
        if (!outs.length) throw new WaveSpeedError('WaveSpeed finished without a result');
        return { outputs: outs, nsfw: d.has_nsfw_contents || null, raw: d };
      }
      if (['failed', 'cancelled', 'timeout', 'deleted'].includes(st)) {
        const why = String(d?.error || st).slice(0, 400);
        if (isRefusal(why)) throw Object.assign(new WaveSpeedError(`The content filter of the model refused this request: ${why}`), { safety: true, raw: why });
        throw new WaveSpeedError(`WaveSpeed: ${why}`);
      }
      onStatus?.(st === 'processing' ? `generating… ${Math.round((Date.now() - t0) / 1000)}s` : 'queued…');
    }
  }

  /** Submit + wait. */
  async run(model, input, opts = {}) {
    const id = await this.submit(model, input);
    opts.onSubmitted?.(id);
    return { id, ...(await this.wait(id, opts)) };
  }

  /**
   * A vision question (images + text → text) on WaveSpeed's OpenAI-compatible LLM service, billed per token (a Gemini
   * 2.5 Flash check with one image ≈ $0.0007). `images`: [{ buf, mime }].
   */
  async chat({ prompt, images = [], model = 'google/gemini-2.5-flash', temperature = 0.2, timeoutMs = 180000 }) {
    const content = [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${Buffer.from(i.buf).toString('base64')}` } }))];
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature, messages: [{ role: 'user', content }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
        throw Object.assign(new WaveSpeedError(`No answer from WaveSpeed (vision: ${e.message})`), { network: true });
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) throw new WaveSpeedError(`WaveSpeed rejected the API key (${res.status}). Check the key at wavespeed.ai/accesskey.`);
      if (!res.ok) throw new WaveSpeedError(`WaveSpeed (vision) ${res.status}: ${String(data?.error?.message || data?.message || text).slice(0, 300)}`);
      const out = data?.choices?.[0]?.message?.content;
      const answer = (Array.isArray(out) ? out.map((p) => p?.text || '').join('') : String(out || '')).trim();
      if (!answer) throw new WaveSpeedError(`The WaveSpeed vision model did not answer (${data?.choices?.[0]?.finish_reason || 'empty'})`);
      return answer;
    }
  }

  async balance() {
    const d = await this.req('/api/v3/balance', { timeoutMs: 8000 });
    const usd = Number(d?.balance ?? d?.credit ?? d);
    if (!Number.isFinite(usd)) throw new WaveSpeedError('WaveSpeed did not return the balance');
    return { usd };
  }

  static async download(url, label = 'result') {
    let last;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
        if (r.ok) return Buffer.from(await r.arrayBuffer());
        last = new WaveSpeedError(`Could not download the ${label} (HTTP ${r.status})`);
      } catch (e) { last = e; }
      await sleep(1500 * (a + 1));
    }
    throw last;
  }
}
