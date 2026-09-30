/**
 * The brief: what the daily routine writes and render.mjs / publish.mjs read.
 * validateBrief returns a list of problems (empty when it is good to go).
 */
import { SCENES, STILLS } from '../scenes.mjs';
import { TEMPLATES, SIZES } from '../cards.mjs';

/** X's weighted length: URLs count 23, most emoji and CJK count 2. */
export function xLength(text) {
  const noUrls = text.replace(/https?:\/\/\S+/g, (u) => 'x'.repeat(23));
  let n = 0;
  for (const ch of noUrls) {
    const cp = ch.codePointAt(0);
    n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

export function validateBrief(b) {
  const p = [];
  if (!b || typeof b !== 'object') return ['brief is not an object'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) p.push('date must be YYYY-MM-DD');
  if (!b.title) p.push('title is required');
  if (!b.video && !b.cards?.length && !b.carousel?.length) p.push('needs a video, cards or a carousel');
  if (b.video) {
    if (!SCENES[b.video.scene]) p.push(`video.scene must be one of ${Object.keys(SCENES).join(', ')}`);
    if (b.video.scene === 'steps' && !b.video.steps?.length) p.push('video.steps is required for the steps scene');
  }
  for (const [i, c] of [...(b.cards ?? []), ...(b.carousel ?? [])].entries()) {
    if (!TEMPLATES.includes(c.template)) p.push(`card/slide ${i + 1}: template must be one of ${TEMPLATES.join(', ')}`);
    if (c.size && !SIZES[c.size]) p.push(`card ${i + 1}: size must be one of ${Object.keys(SIZES).join(', ')}`);
    for (const g of c.gates ?? []) if (!['allow', 'deny', 'approve', 'inspect', 'limit'].includes(g.action)) p.push(`card/slide ${i + 1}: gate action must be allow, deny, approve, inspect or limit`);
    if (c.still && !STILLS[c.still]) p.push(`card/slide ${i + 1}: still must be one of ${Object.keys(STILLS).join(', ')}`);
  }
  if (b.cards?.length > 4) p.push('at most 4 cards');
  if (b.carousel && (b.carousel.length < 3 || b.carousel.length > 12)) p.push('a carousel has 3–12 slides');

  const li = b.linkedin;
  if (!li?.text) p.push('linkedin.text is required');
  else if (li.text.length > 2900) p.push(`linkedin.text is ${li.text.length} chars (max 2900)`);
  if (li?.media && !mediaAvailable(b, li.media)) p.push(`linkedin.media "${li.media}" has nothing to post`);

  const x = b.x;
  if (!x?.posts?.length) p.push('x.posts is required (one post, or a thread)');
  else x.posts.forEach((t, i) => { const n = xLength(t); if (n > 280) p.push(`x.posts[${i}] is ${n} weighted chars (max 280)`); });
  if (x?.media && !mediaAvailable(b, x.media)) p.push(`x.media "${x.media}" has nothing to post`);
  if (x?.media === 'carousel') p.push('X has no document posts — use video or cards');
  return p;
}

function mediaAvailable(b, m) {
  if (m === 'none') return true;
  if (m === 'video') return !!b.video;
  if (m === 'cards') return !!b.cards?.length;
  if (m === 'carousel') return !!b.carousel?.length;
  return false;
}
