import { ScrapeError, fetchWithTimeout, toInt } from './util.js';

/**
 * Paid-but-reliable fallback: Apify actors (https://apify.com). Needs an API token in Setup.
 *  - TikTok:    clockworks/tiktok-scraper
 *  - Instagram: apify/instagram-profile-scraper (followers + latest posts in one run)
 */

async function runActor(actor, input, token, timeoutSec = 180) {
  if (!token) throw new ScrapeError('The Apify token is missing in Settings', { code: 'config' });
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutSec}`;
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    (timeoutSec + 30) * 1000,
  );
  if (res.status === 401 || res.status === 403) throw new ScrapeError('Invalid Apify token or no credits', { code: 'config' });
  if (!res.ok) throw new ScrapeError(`Apify responded ${res.status}: ${(await res.text()).slice(0, 200)}`, { retryable: res.status >= 500 });
  const items = await res.json();
  if (!Array.isArray(items)) throw new ScrapeError('Apify returned an unexpected format');
  return items;
}

export async function apifyTikTok(handle, { limit = 12, token }) {
  const items = await runActor(
    'clockworks~tiktok-scraper',
    {
      profiles: [handle],
      resultsPerPage: limit,
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
    },
    token,
  );
  const valid = items.filter((i) => i && i.id && !i.error);
  if (!valid.length) {
    const err = items.find((i) => i?.error)?.error;
    throw new ScrapeError(err ? `Apify: ${err}` : 'Apify returned no videos', { code: /not.?found|exist/i.test(err || '') ? 'not_found' : 'error' });
  }
  const a = valid[0].authorMeta || {};
  return {
    profile: {
      displayName: a.nickName || a.name || handle,
      followers: toInt(a.fans),
      avatarUrl: a.avatar || null,
      platformUserId: a.id || null,
      secUid: a.secUid || null,
      isPrivate: !!a.privateAccount,
    },
    reels: valid.map((v) => ({
      externalId: String(v.id),
      shortcode: String(v.id),
      url: v.webVideoUrl || `https://www.tiktok.com/@${handle}/video/${v.id}`,
      caption: v.text || '',
      postedAt: toInt(v.createTime) ?? (v.createTimeISO ? Math.floor(Date.parse(v.createTimeISO) / 1000) : null),
      views: toInt(v.playCount),
      likes: toInt(v.diggCount),
      comments: toInt(v.commentCount),
      shares: toInt(v.shareCount),
      duration: v.videoMeta?.duration ?? null,
      thumbUrl: v.videoMeta?.coverUrl || v.videoMeta?.originalCoverUrl || v.slideshowImageLinks?.[0]?.downloadLink || null,
      videoUrl: null,
      ...(() => {
        const imgs = (v.slideshowImageLinks || v.imagePost?.images || []).map((x) => x.downloadLink || x.tiktokLink || x.imageURL?.urlList?.[0]).filter(Boolean);
        return v.isSlideshow || imgs.length ? { mediaType: imgs.length > 1 ? 'carousel' : 'photo', images: imgs } : { mediaType: 'video', images: [] };
      })(),
    })),
  };
}

export async function apifyInstagram(handle, { limit = 12, token }) {
  const items = await runActor('apify~instagram-profile-scraper', { usernames: [handle], resultsLimit: limit }, token);
  const p = items.find((i) => i && i.username);
  if (!p) throw new ScrapeError('Apify: Instagram account not found', { code: 'not_found' });
  const posts = p.latestPosts || []; // reels, photos and carousels (Sidecar)
  return {
    profile: {
      displayName: p.fullName || p.username,
      followers: toInt(p.followersCount),
      avatarUrl: p.profilePicUrlHD || p.profilePicUrl || null,
      platformUserId: p.id || null,
      secUid: null,
      isPrivate: !!p.private,
    },
    reels: posts.slice(0, limit).map((x) => ({
      externalId: String(x.id),
      shortcode: x.shortCode,
      url: x.url || `https://www.instagram.com/p/${x.shortCode}/`,
      caption: x.caption || '',
      postedAt: x.timestamp ? Math.floor(Date.parse(x.timestamp) / 1000) : null,
      views: toInt(x.videoPlayCount ?? x.videoViewCount),
      likes: toInt(x.likesCount),
      comments: toInt(x.commentsCount),
      shares: null,
      duration: x.videoDuration ?? null,
      thumbUrl: x.displayUrl || null,
      videoUrl: x.videoUrl || null,
      mediaType: x.type === 'Sidecar' ? 'carousel' : x.type === 'Video' || x.videoUrl ? 'video' : 'photo',
      images: x.type === 'Sidecar' ? (x.images || (x.childPosts || []).map((c) => c.displayUrl)).filter(Boolean) : x.type === 'Image' ? [x.displayUrl].filter(Boolean) : [],
    })),
  };
}
