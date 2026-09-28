/**
 * ComfyUI workflows used by the pipeline, built in API format.
 *
 * Built-ins mirror the official ComfyUI templates (api_google_nano_banana2_image_edit, api_wan3_0_i2v,
 * api_wan3_0_r2v) but are generated in code so the number of reference images can vary.
 *
 * Custom workflows: export any graph from ComfyUI with Workflow → Export (API) and put placeholders in
 * the fields the app should fill, e.g. "{{PROMPT}}". A value that is *exactly* a placeholder is replaced
 * with the typed value (numbers stay numbers); placeholders inside longer strings are substituted as text.
 */

export const NODES = {
  LoadImage: 'Loads an image from ComfyUI/input (we upload the file there first).',
  LoadVideo: 'Loads a video from ComfyUI/input — used as the motion reference in Wan R2V.',
  GeminiNanoBanana2V2: 'Nano Banana 2 (Gemini 3.1 Flash Image) partner node — edits/generates images from a prompt + up to 14 reference images.',
  Wan3ImageToVideoApi: 'Wan 3.0 Image to Video partner node — animates a first frame (2–30 s, up to 1080P, optional audio).',
  Wan3ReferenceToVideoApi: 'Wan 3.0 Reference to Video partner node — prompt with @Image1…@Image10 / @Video1…@Video5 references.',
  SaveImage: 'Writes the result to ComfyUI/output (the app downloads it via /view).',
  SaveVideo: 'Writes the video to ComfyUI/output.',
};

export const REQUIRED_NODES = {
  image: ['LoadImage', 'GeminiNanoBanana2V2', 'SaveImage'],
  i2v: ['LoadImage', 'Wan3ImageToVideoApi', 'SaveVideo'],
  r2v: ['LoadImage', 'LoadVideo', 'Wan3ReferenceToVideoApi', 'SaveVideo'],
};

export const NB_COMFY_MODELS = ['Nano Banana 2 (Gemini 3.1 Flash Image)', 'Nano Banana 2 Lite', 'Nano Banana Pro (Gemini 3 Pro Image)'];
/** The person swap of the reference app runs Nano Banana Pro (Comfy API only; the ComfyUI graph keeps Nano Banana 2). */
export const NB_PRO = 'Nano Banana Pro (Gemini 3 Pro Image)';
export const NB_GEMINI_MODELS = ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];

const rndSeed = () => Math.floor(Math.random() * 2147483647);

const saveVideo = (src) => ({
  class_type: 'SaveVideo',
  inputs: { video: src, filename_prefix: 'reels-radar/wan3', format: 'auto', 'format.codec': 'auto', codec: 'auto' },
  _meta: { title: 'Save Video' },
});

/** Nano Banana 2: reference images (model photos first, source frame last) → one image. */
export function nanoBananaWorkflow({ images, prompt, model = NB_COMFY_MODELS[0], resolution = '1K', aspectRatio = '9:16', seed = rndSeed(), systemPrompt }) {
  const wf = {};
  const nb = {
    class_type: 'GeminiNanoBanana2V2',
    inputs: {
      prompt,
      model,
      'model.aspect_ratio': aspectRatio,
      'model.resolution': model.includes('Lite') ? '1K' : resolution,
      'model.thinking_level': 'MINIMAL',
      seed,
      response_modalities: 'IMAGE',
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    },
    _meta: { title: 'Nano Banana 2' },
  };
  images.slice(0, 14).forEach((name, i) => {
    const id = String(10 + i);
    wf[id] = { class_type: 'LoadImage', inputs: { image: name }, _meta: { title: `Reference ${i + 1}` } };
    nb.inputs[`model.images.image_${i + 1}`] = [id, 0];
  });
  wf['50'] = nb;
  wf['60'] = { class_type: 'SaveImage', inputs: { images: ['50', 0], filename_prefix: 'reels-radar/nb2' }, _meta: { title: 'Save Image' } };
  return wf;
}

const wanParams = (o) => ({
  model: o.model || 'wan3.0-video',
  'model.prompt': o.prompt,
  'model.resolution': o.resolution || '720P',
  'model.ratio': o.ratio || '9:16',
  'model.duration': String(o.duration || 'auto'),
  'model.audio': !!o.audio,
  'model.prompt_extend': o.promptExtend !== false,
  seed: o.seed ?? rndSeed(),
  watermark: false,
});

/** Wan 3.0 I2V: first frame → video. */
export function wanI2VWorkflow({ firstFrame, ...o }) {
  return {
    10: { class_type: 'LoadImage', inputs: { image: firstFrame }, _meta: { title: 'First frame (Nano Banana)' } },
    50: { class_type: 'Wan3ImageToVideoApi', inputs: { ...wanParams(o), first_frame: ['10', 0] }, _meta: { title: 'Wan 3.0 Image to Video' } },
    60: saveVideo(['50', 0]),
  };
}

/** Wan 3.0 R2V: character image(s) as @Image1… + source reel as @Video1 (motion/choreography reference). */
export function wanR2VWorkflow({ images, video, ...o }) {
  const wf = {};
  const node = { class_type: 'Wan3ReferenceToVideoApi', inputs: wanParams(o), _meta: { title: 'Wan 3.0 Reference to Video' } };
  images.slice(0, 10).forEach((name, i) => {
    const id = String(10 + i);
    wf[id] = { class_type: 'LoadImage', inputs: { image: name }, _meta: { title: `@Image${i + 1}` } };
    node.inputs[`model.reference_images.image${i + 1}`] = [id, 0];
  });
  if (video) {
    wf['30'] = { class_type: 'LoadVideo', inputs: { file: video }, _meta: { title: '@Video1 (source reel)' } };
    node.inputs['model.reference_videos.video1'] = ['30', 0];
  }
  wf['50'] = node;
  wf['60'] = saveVideo(['50', 0]);
  return wf;
}

// ---- custom workflows -----------------------------------------------------------------

export const PLACEHOLDERS = {
  image: ['PROMPT', 'SEED', 'IMAGE_1', 'IMAGE_2', 'IMAGE_3', 'IMAGE_4', 'SOURCE_FRAME', 'ASPECT_RATIO', 'RESOLUTION'],
  video: ['PROMPT', 'SEED', 'FIRST_FRAME', 'SOURCE_VIDEO', 'MODEL_IMAGE', 'DURATION', 'RESOLUTION', 'RATIO'],
};

/** True if the JSON looks like the UI format (nodes/links) instead of API format. */
export function isUiFormat(wf) {
  return wf && Array.isArray(wf.nodes) && Array.isArray(wf.links);
}

export function validateApiWorkflow(wf) {
  if (!wf || typeof wf !== 'object') throw new Error('Invalid JSON');
  if (isUiFormat(wf)) throw new Error('This is the UI format. In ComfyUI use Workflow → Export (API) and send that file.');
  const nodes = Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type);
  if (!nodes.length) throw new Error('No nodes with "class_type" were found — is it really an API export?');
  const found = new Set();
  JSON.stringify(wf).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => found.add(k));
  return { nodeCount: nodes.length, classes: [...new Set(nodes.map(([, n]) => n.class_type))], placeholders: [...found] };
}

/** Deep-replace {{PLACEHOLDERS}} in a custom API workflow. */
export function fillWorkflow(wf, vars) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const exact = v.match(/^\{\{([A-Z0-9_]+)\}\}$/);
      if (exact) return exact[1] in vars ? vars[exact[1]] : v;
      return v.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(structuredClone(wf));
}

/** Summarise an API workflow as nodes + edges (for the Workflows page diagram). */
export function describeWorkflow(wf) {
  const nodes = [];
  const edges = [];
  for (const [id, n] of Object.entries(wf)) {
    if (!n?.class_type) continue;
    const widgets = {};
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') edges.push({ from: v[0], to: id, input: k });
      else widgets[k] = typeof v === 'string' && v.length > 140 ? v.slice(0, 140) + '…' : v;
    }
    nodes.push({ id, type: n.class_type, title: n._meta?.title || n.class_type, widgets, doc: NODES[n.class_type] || '' });
  }
  return { nodes, edges };
}

// ---- cost estimates (USD, from the ComfyUI partner-node price badges) -----------------------

export function estimateImageCost(model, resolution, n = 1) {
  // WaveSpeed (27/09): Nano Banana Pro $0.14 (1K/2K) or $0.24 (4K); Nano Banana 2 $0.07 (1K), $0.105 (2K), $0.14 (4K).
  const res = String(resolution || '1K').toUpperCase();
  const per = /pro/i.test(String(model || '')) ? (res === '4K' ? 0.24 : 0.14) : ({ '2K': 0.105, '4K': 0.14 }[res] ?? 0.07);
  return per * n;
}

/**
 * Wan 3.0 on WaveSpeed (27/09), per second: Standard $0.05 / $0.10 / $0.20 (480p / 720p / 1080p), Prime $0.075 / $0.15 /
 * $0.30. The reel sent as the reference is billed too (its seconds, at most 15): the exact copy pays both.
 */
export function estimateVideoCost(model, resolution, seconds, refSeconds = seconds) {
  const table = /prime/.test(String(model || '')) ? { '480P': 0.075, '720P': 0.15, '1080P': 0.3 } : { '480P': 0.05, '720P': 0.1, '1080P': 0.2 };
  return (table[String(resolution || '720P').toUpperCase()] ?? 0.1) * (Number(seconds) + Number(refSeconds || 0));
}
