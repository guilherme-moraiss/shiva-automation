import { UA, ScrapeError, fetchWithTimeout, runYtDlp, toInt } from './util.js';

/**
 * Native TikTok scraper (no account needed).
 *  - Profile (followers, avatar, secUid) comes from the SSR JSON embedded in the profile page.
 *  - Recent videos come from yt-dlp's TikTok user extractor (it signs the API calls for us).
 */

export async function fetchProfile(handle) {
  const res = await fetchWithTimeout(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
  });
  if (res.status === 404) throw new ScrapeError('TikTok account does not exist', { code: 'not_found' });
  if (!res.ok) throw new ScrapeError(`TikTok responded ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
  const html = await res.text();
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new ScrapeError('TikTok returned no profile data (possible block/captcha)', { retryable: true });
  let scope;
  try {
    scope = JSON.parse(m[1]).__DEFAULT_SCOPE__;
  } catch {
    throw new ScrapeError('Invalid TikTok profile JSON', { retryable: true });
  }
  const detail = scope?.['webapp.user-detail'];
  const info = detail?.userInfo;
  if (!info?.user?.uniqueId) {
    // statusCode 10221/10222 = banned / not found; 10223 private etc.
    const code = detail?.statusCode;
    if (code === 10221 || code === 10202) throw new ScrapeError('TikTok account does not exist or was banned', { code: 'not_found' });
    throw new ScrapeError(`TikTok profile unavailable (status ${code ?? '?'})`, { retryable: true });
  }
  const { user, stats = {} } = info;
  return {
    displayName: user.nickname || user.uniqueId,
    followers: toInt(stats.followerCount),
    avatarUrl: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
    platformUserId: user.id || null,
    secUid: user.secUid || null,
    isPrivate: !!user.privateAccount,
  };
}

function pickThumb(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const thumbs = entry.thumbnails || [];
  return (thumbs.find((t) => t.id === 'cover') || thumbs.find((t) => t.id === 'originCover') || thumbs[0] || {}).url || null;
}

/** Photo-mode post: read the image list from the post page SSR JSON (itemStruct.imagePost). */
export async function fetchPhotoPost(handle, id) {
  const res = await fetchWithTimeout(`https://www.tiktok.com/@${encodeURIComponent(handle)}/photo/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const item = JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    const imgs = (item?.imagePost?.images || []).map((i) => i.imageURL?.urlList?.[0]).filter(Boolean);
    return imgs.length ? { images: imgs, stats: item.stats || {} } : null;
  } catch { return null; }
}

export async function fetchVideos(handle, limit = 12) {
  const args = ['-J', '--flat-playlist', '--no-warnings'];
  if (limit < 5000) args.push('--playlist-end', String(limit));
  args.push(`https://www.tiktok.com/@${handle}`);
  const { out } = await runYtDlp(args, { timeoutMs: limit < 5000 ? 90000 : 15 * 60e3 });
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    throw new ScrapeError('yt-dlp returned invalid JSON');
  }
  const posts = (data.entries || [])
    .filter((e) => e && e.id)
    .map((e) => ({
      externalId: String(e.id),
      shortcode: String(e.id),
      url: e.webpage_url || e.url || `https://www.tiktok.com/@${handle}/video/${e.id}`,
      caption: e.description || e.title || '',
      postedAt: toInt(e.timestamp),
      views: toInt(e.view_count),
      likes: toInt(e.like_count),
      comments: toInt(e.comment_count),
      shares: toInt(e.repost_count),
      duration: e.duration ?? null,
      thumbUrl: pickThumb(e),
      videoUrl: null, // resolved on demand by yt-dlp (TikTok play URLs are cookie-bound)
      mediaType: /\/photo\//.test(e.webpage_url || e.url || '') ? 'photo' : 'video',
      images: [],
      _maybePhoto: /\/photo\//.test(e.webpage_url || e.url || '') || !e.duration,
    }));
  // Photo-mode posts: fetch their slides (few requests, only for likely photo posts).
  let checked = 0;
  for (const p of posts) {
    if (!p._maybePhoto || checked >= 8) continue;
    checked++;
    const photo = await fetchPhotoPost(handle, p.externalId).catch(() => null);
    if (photo) {
      p.mediaType = photo.images.length > 1 ? 'carousel' : 'photo';
      p.images = photo.images;
      p.url = `https://www.tiktok.com/@${handle}/photo/${p.externalId}`;
      p.thumbUrl = p.thumbUrl || photo.images[0];
      p.duration = null;
    }
  }
  posts.forEach((p) => delete p._maybePhoto);
  return posts;
}

export async function scrapeTikTok(handle, { limit = 12 } = {}) {
  const profile = await fetchProfile(handle);
  if (profile.isPrivate) return { profile, reels: [], note: 'Private account' };
  const reels = await fetchVideos(handle, limit);
  return { profile, reels };
}
