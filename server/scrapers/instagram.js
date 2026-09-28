import crypto from 'node:crypto';
import { UA, ScrapeError, fetchWithTimeout, toInt } from './util.js';

/**
 * Native Instagram scraper using the same private web endpoints instagram.com uses.
 *
 * Instagram increasingly answers anonymous requests with 401 "Please wait a few minutes"
 * (require_login). Pasting the cookie of a logged-in browser session (ideally a burner
 * account) in Setup makes this reliable and unlocks the Reels tab endpoint (more reels,
 * real play counts).
 */

const IG_APP_ID = '936619743392459';

function parseCookie(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  // Accept either the full Cookie header or just the sessionid value.
  const jar = {};
  if (raw.includes('=')) {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  } else {
    jar.sessionid = raw;
  }
  if (!jar.sessionid) return null;
  if (!jar.csrftoken) jar.csrftoken = crypto.randomBytes(16).toString('hex');
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function headers(handle, jar) {
  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': IG_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    'X-ASBD-ID': '129477',
    Referer: `https://www.instagram.com/${handle}/`,
    Origin: 'https://www.instagram.com',
  };
  if (jar) {
    h.Cookie = cookieHeader(jar);
    h['X-CSRFToken'] = jar.csrftoken;
  }
  return h;
}

async function igJson(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML login wall */ }
  if (res.status === 404) throw new ScrapeError('Instagram account does not exist', { code: 'not_found' });
  if (res.status === 429 || body?.message?.includes('wait a few minutes')) {
    throw new ScrapeError(
      body?.require_login
        ? 'Instagram asked for a login / limit reached. Add a session cookie in Settings.'
        : 'Instagram rate limit (429). Try again in a few minutes.',
      { code: body?.require_login ? 'auth_required' : 'rate_limited', retryable: true },
    );
  }
  if (res.status === 401 || res.status === 403 || body?.require_login) {
    throw new ScrapeError('Instagram requires a logged-in session. Paste the cookie in Settings.', { code: 'auth_required' });
  }
  if (!res.ok || !body) throw new ScrapeError(`Instagram responded ${res.status}`, { retryable: res.status >= 500 });
  return body;
}

/** Timeline node (web_profile_info) → post. GraphVideo = reel, GraphImage = photo, GraphSidecar = carousel. */
function mapTimelineNode(n, handle) {
  const kids = (n.edge_sidecar_to_children?.edges || []).map((e) => e.node);
  const mediaType = n.__typename === 'GraphSidecar' || kids.length > 1 ? 'carousel' : n.is_video ? 'video' : 'photo';
  const images = mediaType === 'carousel'
    ? kids.map((k) => k.display_url).filter(Boolean)
    : mediaType === 'photo' ? [n.display_url].filter(Boolean) : [];
  return {
    externalId: String(n.id),
    shortcode: n.shortcode,
    url: `https://www.instagram.com/${mediaType === 'video' ? 'reel' : 'p'}/${n.shortcode}/`,
    caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || '',
    postedAt: toInt(n.taken_at_timestamp),
    views: n.is_video ? toInt(n.video_play_count ?? n.video_view_count) : null,
    likes: toInt(n.edge_liked_by?.count ?? n.edge_media_preview_like?.count),
    comments: toInt(n.edge_media_to_comment?.count),
    shares: null,
    duration: n.video_duration ?? null,
    thumbUrl: n.display_url || n.thumbnail_src || null,
    videoUrl: n.video_url || null,
    mediaType,
    images,
    owner: handle,
  };
}

const bestImage = (m) => (m?.image_versions2?.candidates || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;

/** Private API media item (clips / feed endpoints). media_type 1 = photo, 2 = video, 8 = carousel. */
function mapMediaItem(m) {
  const mediaType = m.media_type === 8 ? 'carousel' : m.media_type === 2 ? 'video' : 'photo';
  const images = mediaType === 'carousel'
    ? (m.carousel_media || []).filter((c) => c.media_type !== 2).map(bestImage).filter(Boolean)
    : mediaType === 'photo' ? [bestImage(m)].filter(Boolean) : [];
  return {
    externalId: String(m.pk ?? m.id).split('_')[0],
    shortcode: m.code,
    url: `https://www.instagram.com/${mediaType === 'video' ? 'reel' : 'p'}/${m.code}/`,
    caption: m.caption?.text || '',
    postedAt: toInt(m.taken_at),
    views: mediaType === 'video' ? toInt(m.ig_play_count ?? m.play_count ?? m.view_count) : null,
    likes: toInt(m.like_count),
    comments: toInt(m.comment_count),
    shares: toInt(m.reshare_count),
    duration: m.video_duration ?? null,
    thumbUrl: bestImage(m) || bestImage(m.carousel_media?.[0]),
    videoUrl: m.video_versions?.[0]?.url || null,
    mediaType,
    images,
    pinned: Array.isArray(m.clips_tab_pinned_user_ids) && m.clips_tab_pinned_user_ids.length > 0,
  };
}
const mapClipMedia = mapMediaItem;

export async function scrapeInstagram(handle, { limit = 12, cookie = '', photosOnly = false } = {}) {
  const jar = parseCookie(cookie);
  const res = await fetchWithTimeout(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
    { headers: headers(handle, jar) },
  );
  const body = await igJson(res);
  const user = body?.data?.user;
  if (!user) throw new ScrapeError('Instagram account does not exist', { code: 'not_found' });

  const profile = {
    displayName: user.full_name || user.username,
    followers: toInt(user.edge_followed_by?.count),
    avatarUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
    platformUserId: user.id,
    secUid: null,
    isPrivate: !!user.is_private,
  };
  if (profile.isPrivate && !user.followed_by_viewer) return { profile, reels: [], note: 'Private account' };

  let reels = [];
  if (jar && !photosOnly) {
    // Logged in: use the Reels tab endpoint (proper play counts, only reels). Skipped when only photo posts are wanted.
    try {
      let maxId = null;
      for (let page = 0; page < Math.ceil(limit / 50) && reels.length < limit; page++) {
        const form = new URLSearchParams({ target_user_id: user.id, page_size: String(Math.min(limit, 50)), include_feed_video: 'true' });
        if (maxId) form.set('max_id', maxId);
        const r = await fetchWithTimeout('https://www.instagram.com/api/v1/clips/user/', {
          method: 'POST',
          headers: { ...headers(handle, jar), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const clips = await igJson(r);
        reels.push(...(clips.items || []).map((it) => mapClipMedia(it.media || it)).filter((x) => x.shortcode));
        maxId = clips.paging_info?.more_available ? clips.paging_info.max_id : null;
        if (!maxId) break;
        await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2000)); // be gentle when paging
      }
    } catch (e) {
      if (e.code === 'rate_limited') throw e;
      // fall through to timeline videos
    }
  }
  if (jar) {
    // Logged in: the profile feed has the photo posts and carousels too.
    try {
      const seen = new Set(reels.map((x) => x.externalId));
      let maxId = null;
      for (let page = 0; page < Math.ceil(limit / 33); page++) {
        const r = await fetchWithTimeout(`https://www.instagram.com/api/v1/feed/user/${user.id}/?count=33${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, { headers: headers(handle, jar) });
        const feed = await igJson(r);
        for (const it of feed.items || []) {
          const post = mapMediaItem(it);
          if (post.shortcode && !seen.has(post.externalId)) { reels.push(post); seen.add(post.externalId); }
        }
        maxId = feed.more_available ? feed.next_max_id : null;
        if (!maxId || limit <= 50) break;
        await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2000));
      }
    } catch (e) {
      if (e.code === 'rate_limited') throw e;
    }
  }
  // Timeline (works anonymously when IG allows it): reels, photos and carousels.
  const edges = user.edge_owner_to_timeline_media?.edges || [];
  const seen = new Set(reels.map((x) => x.externalId));
  for (const n of edges.map((e) => e.node)) {
    if (n && !seen.has(String(n.id))) { reels.push(mapTimelineNode(n, handle)); seen.add(String(n.id)); }
  }
  reels.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  return { profile, reels: reels.slice(0, limit * 2) };
}
