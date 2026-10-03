/**
 * Renders a social brief into post-ready media:
 *
 *   node marketing/render.mjs <brief.json> <out-dir>
 *
 * - video: the scene recorded from a real Control Tower (demo fleet), then
 *   composited into branded frames → video-wide.mp4 (1920x1080, for X) and
 *   video-square.mp4 (1080x1080, for LinkedIn), plus preview.gif + poster.jpg
 * - cards: card-<n>.png from marketing/cards.mjs templates
 * - carousel: carousel.pdf (LinkedIn document) + carousel-<n>.png
 * - manifest.json listing what was made
 *
 * Needs `pnpm build` (and `pnpm docs:build` for website/docs scenes), ffmpeg
 * and Playwright's Chromium. See marketing/README.md for the brief format.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { SCENES, STILLS } from './scenes.mjs';
import { renderCard, renderCarousel, renderVideoFrame } from './cards.mjs';
import { startControlTower, startSite, openStage, ffmpeg, duration } from './lib/stage.mjs';
import { validateBrief } from './lib/brief.mjs';

const [briefFile, outArg] = process.argv.slice(2);
if (!briefFile || !outArg) {
  console.error('usage: node marketing/render.mjs <brief.json> <out-dir>');
  process.exit(2);
}
const brief = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
const problems = validateBrief(brief);
if (problems.length) {
  console.error('brief is not valid:\n- ' + problems.join('\n- '));
  process.exit(1);
}
const OUT = path.resolve(outArg);
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-social-'));
const made = { video: null, cards: [], carousel: null };
const log = (...a) => console.log('·', ...a);

// Which stills the cards/slides ask for.
const wantStills = new Set([...(brief.cards ?? []), ...(brief.carousel ?? [])].map((c) => c.still).filter(Boolean));
const needStage = !!brief.video || wantStills.size > 0;
const needSite = brief.video && ['website', 'docs'].includes(brief.video.scene) || brief.video?.steps?.some((s) => s.site) || [...wantStills].some((n) => STILLS[n]?.site);

let ct, site, stage;
const browser = await chromium.launch();
try {
  if (needStage) {
    ct = await startControlTower(TMP);
    if (needSite) site = await startSite();
    stage = await openStage({ ct, site, tmp: TMP });
    await stage.signIn();
  }

  // ---------------------------------------------------------------- stills
  const stillsDir = path.join(OUT, 'stills');
  for (const name of wantStills) {
    const st = STILLS[name];
    fs.mkdirSync(stillsDir, { recursive: true });
    if (st.go) await stage.go(st.go);
    if (st.site) await stage.page.goto(site.url + st.site);
    if (st.warm) await stage.wait(st.warm);
    if (st.fit) await stage.fitMap();
    if (st.focus) { const [x, y] = await stage.stationAt(st.focus); await stage.clickAt(x, y, 100); await stage.wait(1500); }
    await stage.page.mouse.move(-10, -10);
    await stage.wait(800);
    await stage.still(path.join(stillsDir, `${name}.png`));
    if (st.focus) await stage.page.keyboard.press('Escape');
    log('still', name);
  }
  const ctx = { still: (name) => (name ? path.join(stillsDir, `${name}.png`) : null) };

  // ---------------------------------------------------------------- video
  if (brief.video) {
    const v = brief.video;
    const scene = SCENES[v.scene];
    log('recording scene', v.scene);
    await scene.setup(stage, v);
    await stage.page.mouse.move(800, 450);
    stage.rec.start();
    await scene.play(stage, v);
    await stage.caption(null);
    await stage.endCard(v.end_headline ?? 'Control Tower', v.end_sub ?? 'See every agent. Gate every call. Open source.', v.end_contact);
    await stage.wait(2800);
    const raw = path.join(TMP, 'raw.mp4');
    await stage.rec.stop(raw);
    const dur = duration(raw);
    log('raw', dur.toFixed(1) + 's');

    const composite = async (size, file) => {
      const bg = path.join(TMP, `bg-${size}.png`), mask = path.join(TMP, `mask-${size}.png`);
      const r = await renderVideoFrame(browser, { headline: v.headline ?? brief.title, sub: v.sub }, size, bg, mask);
      ffmpeg(['-loop', '1', '-i', bg, '-i', raw, '-loop', '1', '-i', mask, '-filter_complex',
        `[1:v]scale=${r.vw}:${r.vh}:flags=lanczos,format=rgba[v];[2:v]scale=${r.vw}:${r.vh},format=gray[m];[v][m]alphamerge[vr];[0:v][vr]overlay=${r.vx}:${r.vy}:shortest=1,format=yuv420p[o]`,
        '-map', '[o]', '-t', dur.toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-profile:v', 'high', '-movflags', '+faststart', file]);
      log(path.basename(file), (fs.statSync(file).size / 1e6).toFixed(1) + ' MB');
    };
    await composite('wide', path.join(OUT, 'video-wide.mp4'));
    await composite('square', path.join(OUT, 'video-square.mp4'));
    // Preview for the review issue (small), and a poster frame from 40% in.
    const sq = path.join(OUT, 'video-square.mp4');
    ffmpeg(['-i', sq, '-vf', 'fps=8,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', path.join(OUT, 'preview.gif')]);
    ffmpeg(['-ss', String(duration(sq) * 0.4), '-i', sq, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'poster.jpg')]);
    made.video = { wide: 'video-wide.mp4', square: 'video-square.mp4', preview: 'preview.gif', poster: 'poster.jpg', seconds: Math.round(duration(sq)) };
  }

  // ---------------------------------------------------------------- cards
  for (const [i, c] of (brief.cards ?? []).entries()) {
    const f = `card-${i + 1}.png`;
    await renderCard(browser, c, c.size ?? 'square', path.join(OUT, f), ctx);
    made.cards.push({ file: f, alt: c.alt ?? c.headline ?? c.statement ?? c.label ?? '' });
    log(f, c.template);
  }

  // ---------------------------------------------------------------- carousel
  if (brief.carousel?.length) {
    const pngs = await renderCarousel(browser, brief.carousel, path.join(OUT, 'carousel.pdf'), path.join(OUT, 'carousel'), ctx);
    made.carousel = { pdf: 'carousel.pdf', slides: pngs.map((p) => path.basename(p)) };
    log('carousel.pdf', pngs.length, 'slides');
  }

  fs.rmSync(stillsDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ brief, made }, null, 2));
  log('done →', OUT);
} catch (err) {
  await stage?.page.screenshot({ path: path.join(OUT, 'error.png') }).catch(() => {});
  throw err;
} finally {
  await stage?.close();
  await browser.close();
  ct?.stop();
  site?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}
