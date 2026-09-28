import { scrapeInstagram } from './instagram.js';
import { scrapeTikTok } from './tiktok.js';
import { apifyInstagram, apifyTikTok } from './apify.js';

/** Scrape one creator using the provider configured in Setup. Returns { profile, reels, note? }. */
export function scrapeCreator(platform, handle, settings, { full = false, limit: want = null, photosOnly = false } = {}) {
  // Every scan re-reads the latest N posts (default 100): new posts come in, recent metrics get refreshed,
  // older posts already in the app are kept. full = whole history (not exposed in the UI).
  const limit = full ? 5000 : Math.max(1, Math.min(500, Number(want) || Number(settings.max_reels_per_creator) || 100));
  if (platform === 'instagram') {
    return settings.instagram_provider === 'apify'
      ? apifyInstagram(handle, { limit, token: settings.apify_token })
      : scrapeInstagram(handle, { limit, cookie: settings.instagram_cookie, photosOnly });
  }
  if (platform === 'tiktok') {
    return settings.tiktok_provider === 'apify'
      ? apifyTikTok(handle, { limit, token: settings.apify_token })
      : scrapeTikTok(handle, { limit });
  }
  throw new Error(`Unknown platform: ${platform}`);
}

/**
 * Turn pasted text into [{ platform, handle }].
 * Accepts @handles, bare handles, instagram.com/x and tiktok.com/@x URLs, separated by
 * newlines, spaces or commas. Bare handles use `defaultPlatform`.
 */
export function parseHandles(text, defaultPlatform = 'instagram') {
  const out = [];
  const seen = new Set();
  const invalid = [];
  for (let token of String(text || '').split(/[\s,;]+/)) {
    token = token.trim();
    if (!token) continue;
    let platform = defaultPlatform;
    let handle = token;
    const ig = token.match(/instagram\.com\/(?:reel\/[^/]+\/?)?@?([A-Za-z0-9._]+)/i);
    const tt = token.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
    if (tt) { platform = 'tiktok'; handle = tt[1]; }
    else if (ig) { platform = 'instagram'; handle = ig[1]; }
    else if (/^(tt|tiktok):/i.test(token)) { platform = 'tiktok'; handle = token.replace(/^(tt|tiktok):/i, ''); }
    else if (/^(ig|instagram):/i.test(token)) { platform = 'instagram'; handle = token.replace(/^(ig|instagram):/i, ''); }
    handle = handle.replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
    const re = platform === 'instagram' ? /^[a-z0-9._]{1,30}$/ : /^[a-z0-9._]{2,24}$/;
    if (!re.test(handle) || ['p', 'reel', 'reels', 'explore', 'stories'].includes(handle)) {
      invalid.push(token);
      continue;
    }
    const key = `${platform}:${handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform, handle });
  }
  return { handles: out, invalid };
}
