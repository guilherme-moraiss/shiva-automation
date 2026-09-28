import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Minimal fal.ai client (no SDK): CDN upload + queue submit/poll/result.
 *   upload:  POST rest.alpha.fal.ai/storage/upload/initiate → PUT bytes to upload_url → file_url
 *   queue:   POST queue.fal.run/<endpoint> → { request_id, status_url, response_url }
 * status_url/response_url are stored so a job survives an app restart.
 */
const QUEUE = process.env.FAL_QUEUE_URL || 'https://queue.fal.run';
const REST = process.env.FAL_REST_URL || 'https://rest.alpha.fal.ai';

export class FalError extends Error {}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.zip': 'application/zip', '.mp4': 'video/mp4' };

export class Fal {
  constructor(key) {
    if (!key) throw new FalError('The fal.ai API key is missing (18+ content page → Connection).');
    this.key = key;
  }

  async req(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Key ${this.key}`, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      signal: AbortSignal.timeout(opts.timeout || 60_000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const detail = data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : text.slice(0, 400);
      if (res.status === 401 || res.status === 403) throw new FalError(`fal.ai rejected the API key (${res.status}). Check the key at fal.ai/dashboard/keys. ${detail}`);
      if (res.status === 402 || /balance|credit|payment/i.test(detail)) throw new FalError(`Insufficient balance on fal.ai: add credits at fal.ai/dashboard/billing. (${detail})`);
      throw Object.assign(new FalError(`fal.ai ${res.status}: ${detail}`), { status: res.status });
    }
    return data;
  }

  /** Upload a buffer to the fal CDN and return its public URL. */
  async uploadBuffer(buf, fileName, contentType) {
    const init = await this.req(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      method: 'POST', body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    });
    if (!init?.upload_url || !init?.file_url) throw new FalError('fal.ai: the upload did not return a URL');
    const put = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buf, signal: AbortSignal.timeout(300_000) });
    if (!put.ok) throw new FalError(`fal.ai: upload failed (${put.status})`);
    return init.file_url;
  }

  uploadFile(abs) {
    const ext = path.extname(abs).toLowerCase();
    return this.uploadBuffer(fs.readFileSync(abs), path.basename(abs), MIME[ext] || 'application/octet-stream');
  }

  /** Submit to the queue. Returns { endpoint, requestId, statusUrl, responseUrl }. */
  async submit(endpoint, input) {
    const r = await this.req(`${QUEUE}/${endpoint}`, { method: 'POST', body: JSON.stringify(input) });
    return { endpoint, requestId: r.request_id, statusUrl: r.status_url, responseUrl: r.response_url };
  }

  async status(job) {
    return this.req(`${job.statusUrl}?logs=1`);
  }

  async result(job) {
    return this.req(job.responseUrl, { timeout: 120_000 });
  }

  /**
   * Poll until done. `onStatus(msg)` gets queue position / last log line; `isCancelled()` aborts.
   * Training can take ~20 min, so `maxMs` is generous.
   */
  async wait(job, { onStatus, isCancelled, intervalMs = 3000, maxMs = 90 * 60_000 } = {}) {
    const t0 = Date.now();
    let lastMsg = '';
    for (;;) {
      if (isCancelled?.()) throw new FalError('Canceled');
      if (Date.now() - t0 > maxMs) throw new FalError('fal.ai: timed out waiting for the result');
      let s;
      try { s = await this.status(job); } catch (e) {
        if (e.status && e.status < 500) throw e;
        await sleep(intervalMs); continue; // transient network/5xx: keep polling
      }
      if (s.status === 'COMPLETED') {
        if (s.error) throw new FalError(`fal.ai: ${s.error}`);
        return this.result(job);
      }
      const msg = s.status === 'IN_QUEUE' ? `In the fal.ai queue${s.queue_position != null ? ` (position ${s.queue_position})` : ''}…`
        : s.logs?.length ? String(s.logs[s.logs.length - 1].message || '').slice(0, 160) || 'Generating…' : 'Generating…';
      if (msg !== lastMsg) { lastMsg = msg; onStatus?.(msg); }
      await sleep(intervalMs);
    }
  }

  /**
   * Wan 2.7 Image edit (Alibaba) on fal: fal-ai/wan/v2.7/edit ($0.03 per image) or fal-ai/wan/v2.7/pro/edit ($0.075).
   * 1–4 images in order (the prompt refers to them by number), the output in the given size. The prompt goes as written
   * (enable_prompt_expansion off); fal's safety checker stays on. Returns one Buffer per image made.
   */
  async wan27Edit({ pro = false, prompt, images = [], width, height, n = 1, negativePrompt = '', onStatus, isCancelled }) {
    if (!images.length) throw new FalError('Wan 2.7: the image is missing');
    onStatus?.('Uploading the images to Wan 2.7 (fal.ai)…');
    const urls = [];
    for (const [i, img] of images.slice(0, 4).entries()) urls.push(await this.uploadBuffer(img.buf, `wan27_in${i}.${/png/.test(img.mime) ? 'png' : /webp/.test(img.mime) ? 'webp' : 'jpg'}`, img.mime));
    if (isCancelled?.()) throw new FalError('Canceled');
    let job;
    try {
      job = await this.submit(pro ? 'fal-ai/wan/v2.7/pro/edit' : 'fal-ai/wan/v2.7/edit', {
        prompt: String(prompt).slice(0, 5000), image_urls: urls, num_images: Math.max(1, Math.min(4, n)),
        ...(width && height ? { image_size: { width, height } } : {}),
        enable_prompt_expansion: false, output_format: 'png',
        ...(negativePrompt ? { negative_prompt: String(negativePrompt).slice(0, 500) } : {}),
      });
    } catch (e) { throw safetyOr(e); }
    let out;
    try { out = await this.wait(job, { onStatus: (m) => onStatus?.(`Wan 2.7: ${m}`), isCancelled, intervalMs: 2500, maxMs: 15 * 60_000 }); } catch (e) { throw safetyOr(e); }
    const flagged = Array.isArray(out?.has_nsfw_concepts) ? out.has_nsfw_concepts : [];
    const list = (out?.images || []).filter((img, i) => img?.url && !flagged[i]);
    if (!list.length) {
      if (flagged.some(Boolean)) throw Object.assign(new FalError('The content filter of fal.ai (Wan 2.7) blocked the result'), { safety: true, raw: 'the fal.ai content checker flagged the result' });
      throw new FalError('Wan 2.7 finished without an image');
    }
    onStatus?.('Wan 2.7: downloading…');
    const bufs = [];
    for (const img of list) {
      const res = await fetch(img.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new FalError(`Wan 2.7: could not download the image (${res.status})`);
      bufs.push(Buffer.from(await res.arrayBuffer()));
    }
    return bufs;
  }

  /** Download a fal output URL to disk. */
  static async download(url, abs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new FalError(`Could not download the result (${res.status})`);
    fs.writeFileSync(abs, Buffer.from(await res.arrayBuffer()));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A refusal by the provider's content check is reported as one (never retried or reworded by the app). */
function safetyOr(e) {
  const msg = String(e?.message || e);
  if (/content[ _-]?policy|nsfw|safety|moderat|inappropriate|DataInspection|Green net/i.test(msg)) return Object.assign(new FalError(`The content filter of fal.ai (Wan 2.7) refused this request: ${msg.slice(0, 200)}`), { safety: true, raw: msg.slice(0, 400) });
  return e;
}

/** Build a ZIP (store, no compression) from [{ name, data: Buffer|string }]. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
