import crypto from 'node:crypto';

/**
 * Direct Comfy API (api.comfy.org) — the same service the ComfyUI partner nodes call.
 * Works with a free Comfy account: no Comfy Cloud subscription needed, only credits.
 *
 *   upload:      POST /customers/storage {file_name, content_type} → {upload_url, download_url}; PUT bytes to upload_url
 *   Nano Banana: POST /proxy/vertexai/gemini/<model>   (Gemini generateContent body, images as fileData URLs)
 *   Wan 3.0:     POST /proxy/wan/api/v1/services/aigc/video-generation/video-synthesis → task_id
 *                GET  /proxy/wan/api/v1/tasks/<task_id> → output.task_status / output.video_url
 *   balance:     GET  /customers/balance
 *
 * Mirrors comfy_api_nodes (nodes_gemini.py / nodes_wan.py) in the ComfyUI repo.
 */

export const COMFY_API_URL = process.env.COMFY_API_URL || 'https://api.comfy.org';

const NB_MODEL_IDS = {
  'Nano Banana 2 (Gemini 3.1 Flash Image)': 'gemini-3.1-flash-image',
  'Nano Banana 2 Lite': 'gemini-3.1-flash-lite-image',
  'Nano Banana Pro (Gemini 3 Pro Image)': 'gemini-3-pro-image',
};
const COMPLETED = ['succeeded', 'succeed', 'success', 'completed', 'finished', 'done', 'complete'];
const FAILED = ['cancelled', 'canceled', 'canceling', 'fail', 'failed', 'error', 'unknown'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ComfyApiError extends Error {}

/**
 * Error while polling a task that already exists (and is already paid for).
 * Transient problems (network, 5xx, timeouts) are ridden out; permanent ones stop the wait right away instead
 * of showing "a aguardar" for 45 minutes: a revoked key or no credits (401/402/403), or a task the API does not
 * know (400/404, only after a few polls in a row, in case the task is not visible yet right after creation).
 * Returns the error to throw, or null to keep polling.
 */
const MAX_POLL_FAILURES = 15;
function pollFailure(err, state, label) {
  const same = state.lastStatus === err.httpStatus;
  state.failures++;
  state.statusStreak = same ? state.statusStreak + 1 : 1;
  state.lastStatus = err.httpStatus;
  // e.g. "API key verification service unavailable" arrives as a 503: that one is an outage, not a bad key.
  const transient = err.network || [429, 500, 502, 503, 504].includes(err.httpStatus);
  if (!transient && ([401, 402, 403].includes(err.httpStatus) || /API key|créditos|credits/.test(err.message))) return err;
  if ([400, 404].includes(err.httpStatus) && state.statusStreak >= 3) return err;
  if (state.failures >= MAX_POLL_FAILURES) {
    return Object.assign(new ComfyApiError(`${label}: the Comfy API did not respond to ${state.failures} checks in a row (${err.message.slice(0, 120)}). Check your internet connection and the status of api.comfy.org before trying again.`), { httpStatus: err.httpStatus });
  }
  return null;
}
const pollState = () => ({ failures: 0, statusStreak: 0, lastStatus: undefined });

/** Alibaba (Wan) "Green net" / Kling content moderation rejected an input or output. */
export const isModeration = (msg) => /DataInspectionFailed|Green net|inappropriate content|content.*(risk|moderation|violat)|sensitive/i.test(String(msg));
/**
 * Text shown when the provider's automatic content filter refuses a request. It quotes the provider's own reply:
 * the provider checks the image, the reel and the text together, so the app does not guess which one it was.
 */
export const wanModerationMessage = (raw) => {
  const reply = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `The automatic content filter of Wan 3.0 (Alibaba) refused this request and the video was not made.${reply ? ` Wan's reply: «${reply}».` : ''} It is not an app error nor a judgment of the outfit: Alibaba's rules are stricter than TikTok's and can refuse pronounced necklines, even in normal clothes.`;
};
export const WAN_MODERATION_HELP = wanModerationMessage('');

export class ComfyApi {
  constructor(apiKey) {
    if (!apiKey) throw new ComfyApiError('The comfy.org API key is missing');
    this.key = apiKey;
    this.base = COMFY_API_URL.replace(/\/+$/, '');
  }

  headers(extra = {}) {
    return { 'X-API-KEY': this.key, Accept: 'application/json', 'Comfy-Usage-Source': 'comfyui-api', ...extra };
  }

  /**
   * api.comfy.org has short outages ("API key verification service unavailable", 502/503/429).
   * Those are rejected before any work is billed, so they are retried with backoff (~1 min total).
   */
  async call(path, opts = {}) {
    const waits = [2000, 5000, 10000, 20000, 30000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(path, opts);
      } catch (e) {
        const transient = [429, 502, 503].includes(e.httpStatus) || (e.httpStatus === 504 && (opts.method || 'GET') === 'GET') || e.network;
        if (!transient || attempt >= waits.length) throw e;
        opts.onRetry?.(`Comfy API unavailable (${e.httpStatus || 'network'}) — retrying in ${waits[attempt] / 1000}s…`);
        await sleep(waits[attempt]);
      }
    }
  }

  async callOnce(path, { method = 'GET', body, timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        method, signal: ctrl.signal,
        headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new ComfyApiError(`The Comfy API did not respond (${path})`);
      throw Object.assign(new ComfyApiError(`Network error while contacting the Comfy API: ${e.message}`), { network: true });
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      const msg = data?.message || data?.error?.message || data?.error || data?.raw || `HTTP ${res.status}`;
      if (res.status === 402 || /insufficient|balance|credit/i.test(String(msg))) {
        throw new ComfyApiError('Not enough credits on the comfy.org account — buy credits at platform.comfy.org');
      }
      if (res.status === 401) throw new ComfyApiError('Invalid comfy.org API key');
      if (isModeration(msg)) {
        const rawMsg = typeof msg === 'string' ? msg : JSON.stringify(msg);
        throw Object.assign(new ComfyApiError(wanModerationMessage(rawMsg)), { moderation: true, raw: rawMsg });
      }
      const hint = [502, 503, 504].includes(res.status) ? ' — temporary failure on the Comfy side (you were not charged). Press “More” / “Try again” in a minute.' : '';
      throw Object.assign(new ComfyApiError(`Comfy API (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${hint}`), { httpStatus: res.status });
    }
    return data;
  }

  /**
   * USD balance available for partner nodes. Despite the `*_micros` names the API returns CENTS
   * (ComfyUI_frontend treats them the same way); 1 USD = 211 Comfy credits.
   */
  async balance({ retry = true, timeoutMs = 15000 } = {}) {
    // retry: false for status checks (one quick request); true for real work (rides out short outages).
    const b = retry ? await this.call('/customers/balance', { timeoutMs }) : await this.callOnce('/customers/balance', { timeoutMs });
    const cents = b.effective_balance_micros ?? b.amount_micros ?? 0;
    const usd = cents / 100;
    return { usd, credits: Math.round(usd * 211), raw: b };
  }

  /** Upload bytes to Comfy storage; returns a URL the partner services can read. */
  async upload(buf, mime, ext) {
    const file_name = `${crypto.randomUUID()}.${ext}`;
    const { upload_url, download_url } = await this.call('/customers/storage', { method: 'POST', body: { file_name, content_type: mime } });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(upload_url, { method: 'PUT', body: buf, headers: { 'Content-Type': mime } }); // signed URL: no auth header
        if (r.ok) return download_url;
        lastErr = new ComfyApiError(`Upload failed (HTTP ${r.status})`);
      } catch (e) { lastErr = e; }
      await sleep(1000 * (attempt + 1));
    }
    throw lastErr;
  }

  /**
   * Nano Banana 2. `images` = [{ buf, mime }] (model refs first, scene frame last).
   * Returns a Buffer with the generated image.
   */
  async nanoBanana({ model, prompt, images, aspectRatio = '9:16', resolution = '1K', systemPrompt, onStatus }) {
    const modelId = NB_MODEL_IDS[model] || model;
    onStatus?.(`Uploading ${images.length} images to the Comfy API…`);
    const urls = [];
    for (const img of images.slice(0, 10)) urls.push({ url: await this.upload(img.buf, img.mime, img.mime.split('/')[1].replace('jpeg', 'jpg')), mime: img.mime });
    onStatus?.('Nano Banana generating…');
    const imageConfig = { imageSize: /lite/.test(modelId) ? '1K' : resolution };
    if (aspectRatio && aspectRatio !== 'auto') imageConfig.aspectRatio = aspectRatio;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }, ...urls.map((u) => ({ fileData: { mimeType: u.mime, fileUri: u.url } }))] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig,
        ...(/pro/.test(modelId) ? {} : { thinkingConfig: { thinkingLevel: 'MINIMAL' } }), // Pro always thinks: no MINIMAL level
        temperature: 1.0,
        topP: 0.95,
      },
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
    };
    const data = await this.call(`/proxy/vertexai/gemini/${encodeURIComponent(modelId)}`, { method: 'POST', body, timeoutMs: 300000 });
    const parts = (data.candidates || []).flatMap((c) => c.content?.parts || []).filter((p) => !p.thought);
    const img = parts.find((p) => p.inlineData?.data || p.fileData?.fileUri);
    if (!img) {
      const txt = parts.map((p) => p.text || '').join(' ').trim();
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
      const err = new ComfyApiError(/SAFETY|PROHIBITED|BLOCK/i.test(String(reason))
        ? `Blocked by Google's safety filter (${reason})`
        : `Nano Banana returned no image${reason ? ` (${reason})` : ''}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
      err.safety = /SAFETY|PROHIBITED|BLOCK/i.test(String(reason));
      throw err;
    }
    if (img.inlineData?.data) return Buffer.from(img.inlineData.data, 'base64');
    const r = await fetch(img.fileData.fileUri);
    if (!r.ok) throw new ComfyApiError(`Failed to download the generated image (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }

  /**
   * Wan 3.0 video. mode 'i2v': firstFrame; mode 'r2v': refImages (+ refVideo) referenced as @Image1… / @Video1.
   * Returns a Buffer (mp4).
   */
  async wan3({ mode, model = 'wan3.0-video', prompt, firstFrame, refImages = [], refVideo, resolution = '720P', ratio = '9:16', duration = 'auto', audio = true, promptExtend = true, seed, onStatus, isCancelled }) {
    onStatus?.('Uploading media to the Comfy API…');
    const media = [];
    if (mode === 'r2v') {
      for (const img of refImages) media.push({ type: 'reference_image', url: await this.upload(img.buf, img.mime, img.mime.split('/')[1].replace('jpeg', 'jpg')) });
      if (refVideo) media.push({ type: 'reference_video', url: await this.upload(refVideo, 'video/mp4', 'mp4') });
      prompt = rewriteRefTags(prompt, { image: refImages.length, video: refVideo ? 1 : 0, audio: 0 });
    } else {
      media.push({ type: 'first_frame', url: await this.upload(firstFrame.buf, firstFrame.mime, firstFrame.mime.split('/')[1].replace('jpeg', 'jpg')) });
    }
    const body = {
      model,
      input: { prompt: prompt || null, media },
      parameters: {
        resolution, ratio, duration: duration === 'auto' ? -1 : Number(duration),
        seed: seed ?? Math.floor(Math.random() * 2147483647), audio: !!audio, prompt_extend: promptExtend !== false, watermark: false,
      },
    };
    onStatus?.('Wan 3.0: creating task…');
    const created = await this.call('/proxy/wan/api/v1/services/aigc/video-generation/video-synthesis', { method: 'POST', body, timeoutMs: 120000 });
    const taskId = created.output?.task_id;
    if (!taskId) {
      const raw = `${created.code || ''} ${created.message || ''}`.trim();
      throw Object.assign(new ComfyApiError(isModeration(raw) ? wanModerationMessage(raw) : `Wan 3.0 refused the request: ${raw}`), { moderation: isModeration(raw), raw });
    }
    const started = Date.now();
    const poll = pollState();
    while (Date.now() - started < 45 * 60e3) {
      if (isCancelled?.()) throw new ComfyApiError('Canceled');
      await sleep(8000);
      const st = await this.call(`/proxy/wan/api/v1/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 60000 }).catch((e) => ({ _err: e }));
      if (st._err) {
        const fatal = pollFailure(st._err, poll, 'Wan 3.0');
        if (fatal) throw fatal;
        onStatus?.(`Wan 3.0: waiting (${st._err.message.slice(0, 60)})`);
        continue;
      }
      poll.failures = 0; poll.statusStreak = 0; poll.lastStatus = undefined;
      const status = String(st.output?.task_status || '').toLowerCase();
      const secs = Math.round((Date.now() - started) / 1000);
      if (COMPLETED.includes(status)) {
        const url = st.output?.video_url;
        if (!url) throw new ComfyApiError('Wan 3.0 finished without a video_url');
        onStatus?.('Wan 3.0: downloading the video…');
        const r = await fetch(url);
        if (!r.ok) throw new ComfyApiError(`Failed to download the video (HTTP ${r.status})`);
        return Buffer.from(await r.arrayBuffer());
      }
      if (FAILED.includes(status)) {
        const raw = `${st.output?.code || ''} ${st.output?.message || status}`.trim();
        throw Object.assign(new ComfyApiError(isModeration(raw) ? wanModerationMessage(raw) : `Wan 3.0 failed: ${raw}`), { moderation: isModeration(raw), raw });
      }
      onStatus?.(`Wan 3.0: ${status || 'processing'}… ${secs}s`);
    }
    throw new ComfyApiError('Timeout waiting for Wan 3.0');
  }
}

/** Gemini text model through the Comfy proxy (vision + text → text). */
ComfyApi.prototype.geminiText = async function ({ model = 'gemini-2.5-flash', prompt, images = [] }) {
  const parts = [];
  for (const img of images) parts.push({ fileData: { mimeType: img.mime, fileUri: await this.uploadImage(img) } });
  parts.push({ text: prompt });
  const data = await this.call(`/proxy/vertexai/gemini/${encodeURIComponent(model)}`, {
    method: 'POST', timeoutMs: 180000,
    body: { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } },
  });
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new ComfyApiError(`Gemini did not respond (${data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty'})`);
  return text;
};

// ---- other image editors for the person swap (same Comfy key and credits) --------------------------------------

/** The image editors' own content filters: refused requests are reported as such (not as a generic error). */
const blockedBy = (who, raw) => Object.assign(
  new ComfyApiError(`Blocked by the content filter of ${who}${raw ? ` («${String(raw).replace(/\s+/g, ' ').slice(0, 200)}»)` : ''}`),
  { safety: true, raw: String(raw || '') },
);

/** Download a result URL (signed / public link: no Comfy key sent to other hosts). */
async function fetchResult(url, label) {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = new ComfyApiError(`${label}: failed to download the generated image (HTTP ${r.status})`);
    } catch (e) { last = e; }
    await sleep(1500 * (a + 1));
  }
  throw last;
}

/**
 * Flux.2 [pro] / [max] (Black Forest Labs), as the ComfyUI "Flux.2 Image" partner node calls it:
 *   POST /proxy/bfl/flux-2-<pro|max>/generate { prompt, width, height, seed, input_image, input_image_2… (base64) }
 *     → { id, polling_url };  GET polling_url → { status: Pending|Generating|Ready|Request Moderated|…, result.sample }
 * Up to 8 reference images; width/height multiples of 32 (256–2048). Returns a Buffer.
 */
ComfyApi.prototype.flux2 = async function ({ model = 'pro', prompt, images = [], width = 768, height = 1344, seed, onStatus, isCancelled }) {
  const body = { prompt, width, height, seed: seed ?? crypto.randomInt(0, 2 ** 31 - 1), output_format: 'png' };
  images.slice(0, 8).forEach((img, i) => { body[i ? `input_image_${i + 1}` : 'input_image'] = img.buf.toString('base64'); });
  onStatus?.(`Sending ${Math.min(images.length, 8)} images to Flux.2…`);
  let created;
  try {
    created = await this.call(`/proxy/bfl/flux-2-${model === 'max' ? 'max' : 'pro'}/generate`, { method: 'POST', body, timeoutMs: 180000 });
  } catch (e) {
    if (/Moderat|NSFW|safety|sensitive/i.test(String(e.raw || e.message))) throw blockedBy('Flux.2 (Black Forest Labs)', e.raw || e.message);
    throw e;
  }
  if (!created?.polling_url) throw new ComfyApiError(`Flux.2 did not create the request: ${JSON.stringify(created).slice(0, 200)}`);
  // The polling link may point at api.comfy.org (needs the key) or be a signed link of the provider (must not get it).
  const onComfy = (() => { try { return new URL(created.polling_url, this.base).host === new URL(this.base).host; } catch { return false; } })();
  const url = new URL(created.polling_url, this.base).toString();
  const started = Date.now();
  let failures = 0;
  while (Date.now() - started < 10 * 60e3) {
    if (isCancelled?.()) throw new ComfyApiError('Canceled');
    await sleep(2000);
    let st;
    try {
      const r = await fetch(url, { headers: onComfy ? this.headers() : { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      st = await r.json().catch(() => ({}));
      if (!r.ok && ![404].includes(r.status)) throw Object.assign(new ComfyApiError(`HTTP ${r.status}`), { httpStatus: r.status });
      failures = 0;
    } catch (e) {
      if (++failures >= 15) throw new ComfyApiError(`Flux.2: no response to the request (${e.message})`);
      continue;
    }
    const status = String(st.status || '');
    if (status === 'Ready') {
      const sample = st.result?.sample;
      if (!sample) throw new ComfyApiError('Flux.2 finished without an image');
      return fetchResult(sample, 'Flux.2');
    }
    if (/Moderated/i.test(status)) throw blockedBy('Flux.2 (Black Forest Labs)', `${status}${st.details ? `: ${JSON.stringify(st.details).slice(0, 160)}` : ''}`);
    if (/Error|Task not found/i.test(status)) throw new ComfyApiError(`Flux.2 failed: ${status}${st.details ? ` (${JSON.stringify(st.details).slice(0, 160)})` : ''}`);
    onStatus?.(`Flux.2 generating…${st.progress != null ? ` ${Math.round(st.progress * 100)}%` : ''}`);
  }
  throw new ComfyApiError('Flux.2: timed out waiting for the image');
};

/**
 * Seedream (ByteDance), as the ComfyUI "ByteDance Seedream 4.5 & 5.0" partner node calls it:
 *   POST /proxy/byteplus/api/v3/images/generations { model, prompt, image: [urls], size: "WxH", seed, watermark }
 *     → { data: [{ url }], error? }   (synchronous; reference images uploaded to Comfy storage first)
 * Up to 10 reference images; Seedream 5.0 Pro takes 0.92–4.62 MP. Returns a Buffer.
 */
ComfyApi.prototype.seedream = async function ({ model = 'seedream-5-0-pro-260628', prompt, images = [], width = 800, height = 1424, seed, onStatus }) {
  onStatus?.(`Uploading ${Math.min(images.length, 10)} images to Seedream…`);
  const urls = [];
  for (const img of images.slice(0, 10)) urls.push(await this.uploadImage(img));
  onStatus?.('Seedream generating…');
  let data;
  try {
    data = await this.call('/proxy/byteplus/api/v3/images/generations', {
      method: 'POST', timeoutMs: 300000,
      body: { model, prompt, image: urls, size: `${width}x${height}`, seed: seed ?? crypto.randomInt(0, 2 ** 31 - 1), watermark: false, response_format: 'url' },
    });
  } catch (e) {
    if (/SensitiveContent|sensitive|risk|moderat/i.test(String(e.message))) throw blockedBy('Seedream (ByteDance)', e.raw || e.message);
    throw e;
  }
  const err = data?.error && Object.keys(data.error).length ? data.error : null;
  if (err) {
    const raw = `${err.code || ''} ${err.message || ''}`.trim();
    if (/SensitiveContent|sensitive|risk/i.test(raw)) throw blockedBy('Seedream (ByteDance)', raw);
    throw new ComfyApiError(`Seedream failed: ${raw}`);
  }
  const url = data?.data?.[0]?.url;
  if (!url) throw new ComfyApiError(`Seedream returned no image: ${JSON.stringify(data).slice(0, 200)}`);
  return fetchResult(url, 'Seedream');
};

/**
 * Wan 2.5 image edit (Alibaba), as the ComfyUI "Wan Image to Image" partner node calls it:
 *   POST /proxy/wan/api/v1/services/aigc/image2image/image-synthesis
 *     { model: 'wan2.5-i2i-preview', input: { prompt, negative_prompt, images: [data URLs, 1–2] }, parameters: { seed, watermark } }
 *     → output.task_id;  GET /proxy/wan/api/v1/tasks/<id> → output.task_status / output.results[0].url
 * Keeps the input's framing; about $0.03 per image. Alibaba's content check stays on. Returns a Buffer.
 */
ComfyApi.prototype.wanImageEdit = async function ({ model = 'wan2.5-i2i-preview', prompt, negativePrompt = '', images = [], seed, onStatus, isCancelled }) {
  if (!images.length) throw new ComfyApiError('Wan: the image to edit is missing');
  onStatus?.('Sending the image to Wan…');
  let created;
  try {
    created = await this.call('/proxy/wan/api/v1/services/aigc/image2image/image-synthesis', {
      method: 'POST', timeoutMs: 180000,
      body: {
        model,
        input: { prompt, negative_prompt: negativePrompt, images: images.slice(0, 2).map((img) => `data:${img.mime};base64,${img.buf.toString('base64')}`) },
        parameters: { n: 1, seed: seed ?? crypto.randomInt(0, 2 ** 31 - 1), watermark: false }, // n: 1 — the provider makes 4 (and bills 4) when it is left out
      },
    });
  } catch (e) {
    if (e.moderation || isModeration(e.raw || e.message)) throw blockedBy('Wan (Alibaba)', e.raw || e.message);
    throw e;
  }
  const taskId = created.output?.task_id;
  if (!taskId) {
    const raw = `${created.code || ''} ${created.message || ''}`.trim();
    if (isModeration(raw)) throw blockedBy('Wan (Alibaba)', raw);
    throw new ComfyApiError(`Wan refused the request: ${raw || JSON.stringify(created).slice(0, 200)}`);
  }
  const started = Date.now();
  const poll = pollState();
  while (Date.now() - started < 10 * 60e3) {
    if (isCancelled?.()) throw new ComfyApiError('Canceled');
    await sleep(4000);
    const st = await this.call(`/proxy/wan/api/v1/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 60000 }).catch((e) => ({ _err: e }));
    if (st._err) {
      const fatal = pollFailure(st._err, poll, 'Wan');
      if (fatal) throw fatal;
      continue;
    }
    poll.failures = 0; poll.statusStreak = 0; poll.lastStatus = undefined;
    const status = String(st.output?.task_status || '').toLowerCase();
    if (COMPLETED.includes(status)) {
      const url = st.output?.results?.find((r) => r.url)?.url;
      if (!url) {
        const why = st.output?.results?.[0] ? `${st.output.results[0].code || ''} ${st.output.results[0].message || ''}`.trim() : '';
        if (isModeration(why)) throw blockedBy('Wan (Alibaba)', why);
        throw new ComfyApiError(`Wan finished without an image${why ? `: ${why}` : ''}`);
      }
      return fetchResult(url, 'Wan');
    }
    if (FAILED.includes(status)) {
      const raw = `${st.output?.code || ''} ${st.output?.message || status}`.trim();
      if (isModeration(raw)) throw blockedBy('Wan (Alibaba)', raw);
      throw new ComfyApiError(`Wan failed: ${raw}`);
    }
    onStatus?.(`Wan editing… ${Math.round((Date.now() - started) / 1000)}s`);
  }
  throw new ComfyApiError('Wan: timed out waiting for the image');
};

// ---- "remake de tudo": motion transfer / video edit engines (all keep the original audio) ------------

ComfyApi.prototype.uploadImage = function (img) {
  return this.upload(img.buf, img.mime, img.mime.split('/')[1].replace('jpeg', 'jpg'));
};

/** Poll a Kling task until done; returns the result video URL. */
ComfyApi.prototype.pollKling = async function (path, { onStatus, isCancelled, label = 'Kling' } = {}) {
  const started = Date.now();
  const poll = pollState();
  while (Date.now() - started < 45 * 60e3) {
    if (isCancelled?.()) throw new ComfyApiError('Canceled');
    await sleep(8000);
    const r = await this.call(path, { timeoutMs: 60000 }).catch((e) => ({ _err: e }));
    if (r._err) {
      const fatal = pollFailure(r._err, poll, label);
      if (fatal) throw fatal;
      onStatus?.(`${label}: waiting (${r._err.message.slice(0, 60)})`);
      continue;
    }
    poll.failures = 0; poll.statusStreak = 0; poll.lastStatus = undefined;
    const d = r.data || {};
    const st = String(d.task_status || '').toLowerCase();
    if (COMPLETED.includes(st)) {
      const url = d.task_result?.videos?.[0]?.url;
      if (!url) throw new ComfyApiError(`${label} finished without a video`);
      return url;
    }
    if (FAILED.includes(st)) throw new ComfyApiError(`${label} failed: ${d.task_status_msg || r.message || st}`);
    onStatus?.(`${label}: ${st || 'processing'}… ${Math.round((Date.now() - started) / 1000)}s`);
  }
  throw new ComfyApiError(`Timeout waiting for ${label}`);
};

ComfyApi.prototype.pollWan = async function (taskId, { onStatus, isCancelled, label = 'Wan' } = {}) {
  const started = Date.now();
  const poll = pollState();
  while (Date.now() - started < 45 * 60e3) {
    if (isCancelled?.()) throw new ComfyApiError('Canceled');
    await sleep(8000);
    const st = await this.call(`/proxy/wan/api/v1/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 60000 }).catch((e) => ({ _err: e }));
    if (st._err) {
      const fatal = pollFailure(st._err, poll, label);
      if (fatal) throw fatal;
      onStatus?.(`${label}: waiting (${st._err.message.slice(0, 60)})`);
      continue;
    }
    poll.failures = 0; poll.statusStreak = 0; poll.lastStatus = undefined;
    const status = String(st.output?.task_status || '').toLowerCase();
    if (COMPLETED.includes(status)) {
      if (!st.output?.video_url) throw new ComfyApiError(`${label} finished without a video_url`);
      return st.output.video_url;
    }
    if (FAILED.includes(status)) throw new ComfyApiError(`${label} failed: ${st.output?.code || ''} ${st.output?.message || status}`.trim());
    onStatus?.(`${label}: ${status || 'processing'}… ${Math.round((Date.now() - started) / 1000)}s`);
  }
  throw new ComfyApiError(`Timeout waiting for ${label}`);
};

async function fetchVideo(url, label) {
  const r = await fetch(url); // signed URL: no auth header
  if (!r.ok) throw new ComfyApiError(`Failed to download the ${label} video (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

const klingCheck = (res, label) => {
  if (res.code && res.code !== 0) throw new ComfyApiError(`${label} refused the request: ${res.message || res.code}`);
  const id = res.data?.task_id;
  if (!id) throw new ComfyApiError(`${label} did not return a task_id`);
  return id;
};

/**
 * Kling Motion Control — the character in `image` performs the reel's exact movements, gestures,
 * expressions and camera moves. keepSound keeps the reel's original audio. Video: 3–30 s.
 */
ComfyApi.prototype.klingMotion = async function ({ image, video, prompt, keepSound = true, orientation = 'video', mode = 'std', model = 'kling-v3', onStatus, isCancelled }) {
  onStatus?.('Uploading the photo and the reel to the Comfy API…');
  const image_url = await this.uploadImage(image);
  const video_url = await this.upload(video, 'video/mp4', 'mp4');
  onStatus?.('Kling Motion Control: creating task…');
  const res = await this.call('/proxy/kling/v1/videos/motion-control', {
    method: 'POST', timeoutMs: 120000,
    body: { prompt: prompt || '', image_url, video_url, keep_original_sound: keepSound ? 'yes' : 'no', character_orientation: orientation, mode, model_name: model },
  });
  const id = klingCheck(res, 'Kling Motion Control');
  const url = await this.pollKling(`/proxy/kling/v1/videos/motion-control/${encodeURIComponent(id)}`, { onStatus, isCancelled, label: 'Kling Motion Control' });
  onStatus?.('Downloading the video…');
  return fetchVideo(url, 'Kling');
};

/**
 * Kling 3.0 Omni — edits the original reel (same length, same cuts) replacing the person with the model.
 * Prompt refs: <<<video_1>>> = reel, <<<image_N>>> = model photos. Video: 3–10 s, ≥720 px.
 */
ComfyApi.prototype.klingEdit = async function ({ video, images = [], prompt, keepSound = true, resolution = '720p', model = 'kling-v3-omni', onStatus, isCancelled }) {
  onStatus?.('Uploading the reel and the photos to the Comfy API…');
  const image_list = [];
  for (const img of images.slice(0, 4)) image_list.push({ image_url: await this.uploadImage(img) });
  const video_url = await this.upload(video, 'video/mp4', 'mp4');
  onStatus?.('Kling Omni Edit: creating task…');
  const res = await this.call('/proxy/kling/v1/videos/omni-video', {
    method: 'POST', timeoutMs: 120000,
    body: {
      model_name: model, prompt, aspect_ratio: null, duration: null,
      image_list: image_list.length ? image_list : null,
      video_list: [{ video_url, refer_type: 'base', keep_original_sound: keepSound ? 'yes' : 'no' }],
      mode: resolution === '1080p' ? 'pro' : 'std',
    },
  });
  const id = klingCheck(res, 'Kling Omni Edit');
  const url = await this.pollKling(`/proxy/kling/v1/videos/omni-video/${encodeURIComponent(id)}`, { onStatus, isCancelled, label: 'Kling Omni Edit' });
  onStatus?.('Downloading the video…');
  return fetchVideo(url, 'Kling');
};

/** Wan 2.7 Video Edit — edits the reel replacing the person; audio_setting 'origin' keeps the original audio. Video: 2–10 s. */
ComfyApi.prototype.wan27Edit = async function ({ video, images = [], prompt, resolution = '720P', ratio = '9:16', keepSound = true, seed, onStatus, isCancelled }) {
  onStatus?.('Uploading the reel and the photos to the Comfy API…');
  const media = [{ type: 'video', url: await this.upload(video, 'video/mp4', 'mp4') }];
  for (const img of images) media.push({ type: 'reference_image', url: await this.uploadImage(img) });
  onStatus?.('Wan 2.7 Video Edit: creating task…');
  const created = await this.call('/proxy/wan/api/v1/services/aigc/video-generation/video-synthesis', {
    method: 'POST', timeoutMs: 120000,
    body: {
      model: 'wan2.7-videoedit', input: { prompt, media },
      parameters: { resolution, ratio, duration: 0, audio_setting: keepSound ? 'origin' : 'auto', watermark: false, seed: seed ?? Math.floor(Math.random() * 2147483647) },
    },
  });
  const taskId = created.output?.task_id;
  if (!taskId) throw new ComfyApiError(`Wan 2.7 refused the request: ${created.code || ''} ${created.message || ''}`.trim());
  const url = await this.pollWan(taskId, { onStatus, isCancelled, label: 'Wan 2.7 Video Edit' });
  onStatus?.('Downloading the video…');
  return fetchVideo(url, 'Wan 2.7');
};

/** Duration limits (seconds) of the source reel per engine. */
export const ENGINE_LIMITS = {
  kling_motion: { min: 3, max: 30 },
  kling_edit: { min: 3, max: 10 },
  wan27_edit: { min: 2, max: 10 },
  wan3: { min: 0, max: Infinity },
  wan3_copy: { min: 2, max: Infinity }, // reference auto-trimmed to the first 15 s
};

/** Same rewrite the ComfyUI node does: "@Image1" → "Image 1", validated against the attached media. */
export function rewriteRefTags(prompt, counts) {
  return String(prompt || '').replace(/(^|[^A-Za-z0-9_])@(image|video|audio)(\d*)(?!\w)/gi, (m, pre, kind, idx) => {
    const k = kind.toLowerCase();
    const n = Number(idx || 1);
    if (n < 1 || n > (counts[k] || 0)) return `${pre}${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()} ${n}`;
    return `${pre}${k.charAt(0).toUpperCase()}${k.slice(1)} ${n}`;
  });
}

/**
 * Topaz Video AI (upscale + frame interpolation), as ComfyUI's "Topaz Video Enhance" partner node calls it:
 *   POST  /proxy/topaz/video/ { source, filters, output }      → { requestId, estimates: { cost: [credits…], time } }
 *   PATCH /proxy/topaz/video/<id>/accept                      → { urls: [one presigned PUT url] }
 *   PUT   the mp4 (Content-Type video/mp4)                    → ETag
 *   PATCH /proxy/topaz/video/<id>/complete-upload { uploadResults: [{ partNum: 1, eTag }] }
 *   GET   /proxy/topaz/video/<id>/status every 10 s           → status / progress / download.url
 * Returns { buf, estimates }. onCreated(requestId, estimates) runs as soon as the request exists.
 */
ComfyApi.prototype.topazVideo = async function ({ video, width, height, fps, duration, frames, hasAudio = true, outWidth, outHeight, outFps = 60, model = 'slf-1', onStatus, isCancelled, onCreated, onUploaded }) {
  onStatus?.('Topaz: creating the request…');
  const created = await this.call('/proxy/topaz/video/', {
    method: 'POST', timeoutMs: 120000,
    body: {
      source: { container: 'mp4', size: video.length, duration: Math.max(1, Math.round(duration)), frameCount: frames, frameRate: fps, resolution: { width, height } },
      filters: [{ model }, { model: 'apo-8', fps: outFps }],
      output: { resolution: { width: outWidth, height: outHeight }, frameRate: outFps, audioCodec: 'AAC', audioTransfer: hasAudio ? 'Copy' : 'None', dynamicCompressionLevel: 'Low' },
    },
  });
  const requestId = created?.requestId;
  if (!requestId) throw new ComfyApiError(`Topaz did not accept the request: ${JSON.stringify(created).slice(0, 200)}`);
  onCreated?.(requestId, created.estimates || null);
  const acc = await this.call(`/proxy/topaz/video/${encodeURIComponent(requestId)}/accept`, { method: 'PATCH', timeoutMs: 120000 });
  if (!acc?.urls?.length) throw new ComfyApiError('Topaz did not provide a place to upload the video');
  if (acc.urls.length > 1) throw new ComfyApiError('The video is too large to upload to Topaz in one go');
  if (isCancelled?.()) throw new ComfyApiError('Canceled');
  onStatus?.('Topaz: uploading the video…');
  let put;
  try { put = await fetch(acc.urls[0], { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: video }); } catch (e) { throw new ComfyApiError(`Topaz: the video upload failed (${e.message})`); }
  if (!put.ok) throw new ComfyApiError(`Topaz: the video upload failed (HTTP ${put.status})`);
  const eTag = put.headers.get('etag') || '';
  await this.call(`/proxy/topaz/video/${encodeURIComponent(requestId)}/complete-upload`, { method: 'PATCH', timeoutMs: 120000, body: { uploadResults: [{ partNum: 1, eTag }] } });
  // From here Topaz works (and bills) on its side: the request id is all that is needed to fetch the result.
  onUploaded?.(requestId);
  return this.topazWait({ requestId, estimates: created.estimates || null, onStatus, isCancelled });
};

/** Waits for a Topaz request that already has its video, and downloads the result (a fresh link on every status). */
ComfyApi.prototype.topazWait = async function ({ requestId, estimates = null, onStatus, isCancelled }) {
  const WORD = { requested: 'queued', accepted: 'queued', initializing: 'preparing', preprocessing: 'preparing', processing: 'processing', postprocessing: 'finishing' };
  const started = Date.now();
  const poll = pollState();
  while (Date.now() - started < 90 * 60e3) {
    if (isCancelled?.()) throw new ComfyApiError('Canceled');
    await sleep(10000);
    const st = await this.call(`/proxy/topaz/video/${encodeURIComponent(requestId)}/status`, { timeoutMs: 60000 }).catch((e) => ({ _err: e }));
    if (st._err) {
      const fatal = pollFailure(st._err, poll, 'Topaz');
      if (fatal) throw fatal;
      continue;
    }
    poll.failures = 0; poll.statusStreak = 0; poll.lastStatus = undefined;
    if (st.estimates) estimates = st.estimates;
    const status = String(st.status || '').toLowerCase();
    if (status === 'complete') {
      if (!st.download?.url) throw new ComfyApiError('Topaz finished but did not return the video');
      onStatus?.('Topaz: downloading the video…');
      return { buf: await fetchResult(st.download.url, 'Topaz'), estimates };
    }
    if (['failed', 'canceled', 'canceling'].includes(status)) throw new ComfyApiError(`Topaz failed: ${st.message || status}`);
    onStatus?.(`Topaz: ${WORD[status] || status}${st.progress ? ` · ${Math.round(st.progress)}%` : ''}`);
  }
  throw new ComfyApiError('Topaz: timed out waiting for the video');
};
