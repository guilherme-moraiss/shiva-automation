// Tiny router + request helpers shared by all route modules.

export const routes = [];

export function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, pattern });
}

export class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const readBody = (req, maxBytes = 60e6) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    // Kept on the request too: the Equipa log reads what was decided after the route has run.
    req.on('end', () => {
      if (!chunks.length) return resolve((req.body = {}));
      try {
        resolve((req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });

export const int = (v, def = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

/** Decode a `data:image/png;base64,...` URL into { buf, ext }. */
export function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) throw new HttpError(400, 'Invalid image (a base64 data URL was expected)');
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' }[m[1]];
  if (!ext) throw new HttpError(400, `Unsupported format: ${m[1]}`);
  return { buf: Buffer.from(m[2], 'base64'), ext, mime: m[1] };
}
