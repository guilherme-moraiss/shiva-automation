// Quick CLI check of a scraper without touching the database.
//   npm run scrape:test -- tiktok somehandle
//   npm run scrape:test -- instagram somehandle
import { scrapeCreator } from '../server/scrapers/index.js';
import { getSettings } from '../server/db.js';

const [platform = 'tiktok', handle = 'tiktok'] = process.argv.slice(2);
const t = Date.now();
try {
  const { profile, reels, note } = await scrapeCreator(platform, handle, getSettings());
  console.log({ platform, handle, ms: Date.now() - t, profile, note, reels: reels.length });
  console.table(reels.map((r) => ({
    posted: r.postedAt ? new Date(r.postedAt * 1000).toISOString().slice(0, 16) : '?',
    views: r.views, likes: r.likes, comments: r.comments,
    ftvr: profile.followers ? +(r.views / profile.followers).toFixed(2) : null, url: r.url,
  })));
} catch (e) {
  console.error(`✗ ${platform} @${handle} [${e.code || 'error'}]: ${e.message}`);
  process.exit(1);
}
