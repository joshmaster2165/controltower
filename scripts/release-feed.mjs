/**
 * The release feed (site/releases.json): what a running Control Tower reads once a day to tell its admins about new
 * versions. Built from docs/changelog.md by the docs build:
 *
 *   ## 0.2.14 — 18 October 2026               a release (a "(security)" at the end marks a security fix)
 *   - **Upgrading:** …                         a note for people upgrading to it
 *
 * The summary is the release's first bullet, as plain text.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const plain = (md) =>
  md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const anchor = (heading) =>
  heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-');

export function releaseFeed(changelog, base = 'https://agentcontroltower.app/docs/changelog.html') {
  const releases = [];
  const parts = changelog.split(/^## /m).slice(1);
  for (const part of parts) {
    const [heading, ...rest] = part.split('\n');
    const m = /^(\d+\.\d+\.\d+(?:-[\w.]+)?)\s+—\s+(\d{1,2}) (\w+) (\d{4})(.*)$/.exec(heading.trim());
    if (!m) continue; // "Unreleased", or anything else
    const month = MONTHS.indexOf(m[3].toLowerCase());
    if (month < 0) continue;
    const date = `${m[4]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    // Top-level bullets, each with its continuation lines.
    const bullets = [];
    for (const line of rest) {
      if (/^- /.test(line)) bullets.push(line.slice(2));
      else if (/^\s+\S/.test(line) && bullets.length && !/^\s+- /.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
    const notes = bullets.filter((b) => /^\*\*Upgrad(ing|e note)/i.test(b)).map(plain);
    const first = plain(bullets.find((b) => !/^\*\*Upgrad(ing|e note)/i.test(b)) ?? '');
    releases.push({
      version: m[1],
      date,
      security: /\(security\)/i.test(m[5]) || /^\*\*Security/i.test(bullets[0] ?? ''),
      summary: first.length > 300 ? `${first.slice(0, first.lastIndexOf(' ', 297))}…` : first,
      notes,
      url: `${base}#${anchor(heading)}`,
    });
  }
  return { schema: 1, latest: releases[0]?.version ?? null, releases };
}
