/**
 * Direct Gemini API (Google AI Studio key):
 *  - Nano Banana image generation/editing (gemini-3.1-flash-image, gemini-3-pro-image, …)
 *  - Reel analysis: a text model watches the source video and returns a structured breakdown.
 */

const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

async function generateContent(apiKey, model, body, timeoutMs = 180000) {
  if (!apiKey) throw new Error('The Gemini API key is missing in Settings');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || 'unknown error'}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Gemini did not respond in time');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function blockedReason(data) {
  const fb = data?.promptFeedback?.blockReason;
  const fin = data?.candidates?.[0]?.finishReason;
  if (fb) return `request blocked by Gemini's filters (${fb})`;
  if (fin && !['STOP', 'MAX_TOKENS'].includes(fin)) return `generation stopped (${fin})`;
  return null;
}

/**
 * @param images [{ mime, data: Buffer }] — reference images, in the order the prompt refers to them.
 * @returns Buffer (PNG/JPEG)
 */
export async function nanoBanana({ apiKey, model, prompt, images = [], aspectRatio = '9:16', imageSize = '1K', systemPrompt }) {
  const parts = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data.toString('base64') } }))];
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio, ...(model.includes('lite') || model.startsWith('gemini-2.5') ? {} : { imageSize }) },
    },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const data = await generateContent(apiKey, model, body);
  const out = (data.candidates?.[0]?.content?.parts || []).find((p) => (p.inlineData || p.inline_data)?.data);
  if (!out) throw new Error(blockedReason(data) || 'Gemini returned no image');
  return Buffer.from((out.inlineData || out.inline_data).data, 'base64');
}

/** Plain text answer from a Gemini model (images optional). */
export async function geminiText({ apiKey, model = 'gemini-2.5-flash', prompt, images = [] }) {
  const parts = [...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data.toString('base64') } })), { text: prompt }];
  const data = await generateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } });
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(blockedReason(data) || 'Empty response');
  return text;
}

/** Ask a Gemini text model to break down a reel. `video` is a Buffer (mp4, ≤ ~18 MB) or null. */
export async function analyzeReel({ apiKey, model, prompt, video, image }) {
  const parts = [];
  if (video) parts.push({ inline_data: { mime_type: 'video/mp4', data: video.toString('base64') } });
  else if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data.toString('base64') } });
  parts.push({ text: prompt });
  const data = await generateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
  }, 240000);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(blockedReason(data) || 'Empty analysis');
  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    throw new Error('The analysis did not return valid JSON');
  }
}
