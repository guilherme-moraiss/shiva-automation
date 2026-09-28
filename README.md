# SHIVA Automation

A local-first content desk for an OFM agency. It tracks creators on **Instagram** and **TikTok**, surfaces the reels that
perform above normal, and remakes them with the agency's AI models, step by step, from the swap image to a publish-ready
video.

## Run it

```bash
npm run setup   # downloads yt-dlp and ffmpeg into ./bin for your platform (the repo also carries the Windows builds)
npm start       # http://localhost:4747
```

- Node 22.13 or newer. There are no npm dependencies: the database is SQLite through the `node:sqlite` module that ships
  with Node.
- All state lives in `data/`: `data/radar.db` (settings, creators, reels, projects, costs) and `data/media/` (thumbnails,
  downloaded reels, model photos, generated images and videos).
- This repository includes the owner's `data/` folder on purpose. **It contains the API keys saved in Settings**, so keep
  the repository private.

### Where it can run

It is a long-running Node server. Several things need an always-on process with a writable disk:
- the SQLite database on disk;
- background workers (scans, generation jobs that take up to ~20 minutes);
- ffmpeg;
- media files it writes.

That rules out serverless platforms such as **Vercel**. There the pages would load, but nothing that generates or scans
would work. Suitable hosts:
- your computer (`npm start`);
- a VPS;
- a service with a persistent disk, such as Railway, Render or Fly.io. Mount `data/` on the persistent volume, and set
  `PORT` if the host requires it.

## Providers

| What | Provider | Configure in |
|---|---|---|
| Swap images, enlargement, videos, final 2× + 60 fps, quality checks | **WaveSpeed** (wavespeed.ai) | Settings → Pipeline: WaveSpeed API key |
| Her own ComfyUI workflows (optional) | RunningHub | Settings → RunningHub |
| 18+ content of the AI models (optional) | fal.ai | 18+ content page |
| Instagram scraping | Instagram web session cookie (secondary account) or Apify | Settings |

Every paid request is saved on the project before the app waits for it. After a restart the same request is resumed and
never paid twice. The app reports provider refusals as they are: it never rewords a request or retries it on its own.

## The remake, step by step

Nothing starts by itself. In each step you choose the AI and press **Generate**, or press **Continue** on an image to
choose it.

| Step | What happens | Model (WaveSpeed) | Price |
|---|---|---|---|
| 1 · Source | On the Remake page: the reel frame, the model, "Images with", how many, swap options, the image prompt | `google/nano-banana-pro/edit` with the reference swap prompt (image 1 = her photo, image 2 = the frame). Also Nano Banana 2, Seedream 5.0 Pro, Flux.2 [pro], Wan 2.7 | ~$0.14 per image |
| 2 · Pick the swap | Continue on the image you like | none | none |
| 3 · Enlargement | Choose the engine and how many, then Generate. Or Continue on "No enlargement" | `alibaba/wan-2.7/image-edit` (default), Wan 2.7 Pro, Seedream, Nano Banana… | ~$0.03 per image |
| 4 · Video | Choose the model, then Generate | `alibaba/wan-3.0[-prime]/reference-to-video` (exact copy of the reel's motion, with the reel's music put back), or `wavespeed-ai/wan-2.2/animate` (open model, replaces the person in the original reel) | Wan 3.0: $0.10/s at 720p for video + reel seconds. Prime: $0.15/s. Animate: $0.08/s |
| 5 · Review the video | Quality check (same face, tattoos, deformed hands…), approve or redo | Gemini 2.5 Flash through WaveSpeed's LLM API | ~$0.001 per check |
| 6 · Final 2× · 60 fps | Optional: frame rate doubled, then the size doubled | `wavespeed-ai/video-fps-increaser`, `wavespeed-ai/ultimate-video-upscaler` | ~$0.06/s at 2K |
| 7 · Publish | Schedule it on the model's accounts | none | none |

- Wan 3.0 is Alibaba's closed model: every host forwards it to Alibaba, whose "Green net" content check can refuse the
  output. Wan 2.2 Animate is the open model WaveSpeed runs itself.
- Canceling while images are being made keeps the images already requested (they are paid when sent).

## Pages

| Group | Pages |
|---|---|
| Home | **Projects**: every remake with its steps, filters and focus mode |
| Radar | **Reels** (metrics, FTVR = views ÷ followers), **Discover** (keep / pass, one reel at a time), **Review** (the team sends links, you keep or push), **Creators**, **Library**, **Remake queue**, **Launch links** |
| Generation | **Create content**, **Carousels** (photo posts remade slide by slide), **18+ content**, **Models** (her reference photos by angle, persona, body), **Face generator**, **Settings** |
| Publishing | **Approval**, **Scheduled**, **Calendar**, **Profiles** (the model's accounts) |
| Management | **Costs** (per day, provider, model and kind of work), **Team** (workers, activity) |

## Testing without spending

- `RADAR_DATA_DIR=/some/folder` runs an instance on another database (use a copy, never the live `data/`). `PORT` sets
  the port.
- `WAVESPEED_URL` and `WAVESPEED_LLM_URL` point the WaveSpeed client at a mock.
- `npm run mock:runninghub` (port 8399) and `npm run mock:fal` (port 8299) simulate those providers. Use
  `RUNNINGHUB_URL`, `FAL_QUEUE_URL` and `FAL_REST_URL`.
- `npm run scrape:test -- tiktok zachking` tests a scraper from the command line.

## Structure

```
server/
  index.js              HTTP API + static files (no framework)
  db.js                 SQLite schema (data/radar.db) and settings
  jobs.js               scan queue, concurrency, automatic scans
  media.js              reel video cache (on-demand download) + range streaming
  ffmpeg.js             trims, audio mux, realism finish, frames
  scrapers/             instagram.js · tiktok.js · apify.js · index.js
  review.js · discover.js · signals.js · approval.js · agenda.js · team.js · costs.js · status.js …
  pipeline/
    wavespeed.js        WaveSpeed client: upload, submit, wait, balance, vision chat; safe retries
    runner.js           the project state machine: images, enlargement, video, final (resumes after a restart)
    routes.js           API for models, projects, steps and pipeline status
    prompts.js          prompt engineering (the reference swap, enlargement, video prompts)
    qa.js               vision quality checks of images and videos
    outfit.js           chosen-outfit handling and vision helper
    rhworkflows.js      her RunningHub workflows: inputs and checks
    spicy.js            18+ content with its safety rules
public/                 vanilla JS single-page app (index.html, app.js, pipeline.js, styles.css …)
public/workflows/       copies of the ComfyUI workflows used on RunningHub (no API keys)
scripts/                setup (yt-dlp + ffmpeg) and provider mocks
data/                   database + media (included here on purpose, contains API keys)
bin/                    yt-dlp and ffmpeg (Windows builds; `npm run setup` fetches the right ones)
```
