/**
 * The review issue: built from a rendered draft, edited by a human, parsed
 * back when it is approved. Plain Node, no dependencies (the publish job does
 * not install the workspace).
 *
 *   node marketing/lib/issue.mjs body <manifest.json> <raw-base-url> <id>   → issue markdown on stdout
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FENCE = '````';

export function buildIssueBody(manifest, rawBase, id) {
  const { brief, made } = manifest;
  const u = (f) => `${rawBase}/${f}`;
  const L = [];
  L.push(`<!-- social-id: ${id} -->`);
  L.push(`**${brief.title}** · angle: \`${brief.angle ?? 'feature'}\``);
  if (brief.why) L.push('', `> ${brief.why.replace(/\n/g, '\n> ')}`);
  L.push('', '**To publish:** edit the text below if you like, then add the **`approved`** label. Close the issue to skip today.');
  L.push('', '## Media', '');
  if (made.video) {
    L.push(`<img src="${u(made.video.preview)}" width="360" alt="preview"> `, '');
    L.push(`▶️ [Square video (LinkedIn)](${u(made.video.square)}) · [Wide video (X)](${u(made.video.wide)}) · ${made.video.seconds}s`);
  }
  if (made.cards.length) L.push('', made.cards.map((c) => `<img src="${u(c.file)}" width="260" alt="${c.alt.replace(/"/g, '&quot;')}">`).join(' '));
  if (made.carousel) L.push('', `**Carousel** ([PDF](${u(made.carousel.pdf)})):`, '', made.carousel.slides.map((f) => `<img src="${u(f)}" width="150">`).join(' '));

  L.push('', '## LinkedIn (company page)', '');
  L.push(`<!-- linkedin-media: ${brief.linkedin.media ?? 'none'} -->  media: \`${brief.linkedin.media ?? 'none'}\` (edit the comment to change: video, cards, carousel, none)`);
  if (brief.linkedin.media === 'carousel') L.push(`<!-- linkedin-document-title: ${(brief.linkedin.document_title ?? brief.title).replace(/-->/g, '')} -->`);
  L.push('', '<!-- linkedin -->', FENCE + 'text', brief.linkedin.text, FENCE, '<!-- /linkedin -->');

  L.push('', `## X ${brief.x.posts.length > 1 ? `(thread of ${brief.x.posts.length})` : ''}`, '');
  L.push(`<!-- x-media: ${brief.x.media ?? 'none'} -->  media on the first post: \`${brief.x.media ?? 'none'}\``);
  L.push('', '<!-- x -->');
  for (const p of brief.x.posts) L.push(FENCE + 'text', p, FENCE);
  L.push('<!-- /x -->');
  if (brief.notes) L.push('', '<details><summary>Notes from the routine</summary>', '', brief.notes, '', '</details>');
  return L.join('\n');
}

const between = (body, tag) => {
  const m = body.match(new RegExp(`<!-- ${tag} -->([\\s\\S]*?)<!-- /${tag} -->`));
  return m ? m[1] : null;
};
const blocks = (s) => [...s.matchAll(/`{3,}text\r?\n([\s\S]*?)\r?\n`{3,}/g)].map((m) => m[1].replace(/\r/g, '').trim()).filter(Boolean);
const comment = (body, key) => body.match(new RegExp(`<!-- ${key}: *([^>]*?) *-->`))?.[1] ?? null;

/** What to post, as edited in the issue. */
export function parseIssueBody(body) {
  const li = between(body, 'linkedin');
  const x = between(body, 'x');
  return {
    id: comment(body, 'social-id'),
    linkedin: li ? { text: blocks(li)[0] ?? '', media: comment(body, 'linkedin-media') ?? 'none', document_title: comment(body, 'linkedin-document-title') } : null,
    x: x ? { posts: blocks(x), media: comment(body, 'x-media') ?? 'none' } : null,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'body') process.stdout.write(buildIssueBody(JSON.parse(fs.readFileSync(a, 'utf8')), b, c));
  else if (cmd === 'parse') console.log(JSON.stringify(parseIssueBody(fs.readFileSync(a, 'utf8')), null, 2));
  else { console.error('usage: issue.mjs body <manifest> <raw-base> <id> | parse <body.md>'); process.exit(2); }
}
