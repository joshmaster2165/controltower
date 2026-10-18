/**
 * Every link in the built docs (site/docs, after `pnpm docs:build`) and the website pages goes somewhere: other pages,
 * their headings (#anchors), images and media. External links aren't fetched. Exits 1 with the broken ones.
 *
 *   node scripts/check-docs-links.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = path.resolve(import.meta.dirname, '../site');
const pages = [...fs.readdirSync(path.join(SITE, 'docs')).filter((f) => f.endsWith('.html')).map((f) => path.join(SITE, 'docs', f)), ...fs.readdirSync(SITE).filter((f) => f.endsWith('.html')).map((f) => path.join(SITE, f))];
const html = new Map(pages.map((p) => [p, fs.readFileSync(p, 'utf8')]));
const ids = (file) => new Set([...(html.get(file) ?? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const broken = [];
let checked = 0;
for (const [file, text] of html) {
  for (const m of text.matchAll(/\s(href|src|poster)="([^"]+)"/g)) {
    const url = m[2];
    if (/^(https?:|mailto:|tel:|data:|javascript:)/.test(url) || url.startsWith('//')) continue;
    checked++;
    const [p, hash] = url.split('#');
    const target = p ? path.resolve(path.dirname(file), decodeURIComponent(p.split('?')[0])) : file;
    const exists = fs.existsSync(target) && (fs.statSync(target).isFile() || fs.existsSync(path.join(target, 'index.html')));
    if (!exists) broken.push(`${path.relative(SITE, file)}: ${url} (no such file)`);
    else if (hash && target.endsWith('.html') && !ids(target).has(decodeURIComponent(hash))) broken.push(`${path.relative(SITE, file)}: ${url} (no #${hash} there)`);
  }
}
console.log(`${checked} links in ${pages.length} pages: ${broken.length ? `${broken.length} broken` : 'all good'}`);
for (const b of broken) console.log(`  ${b}`);
process.exitCode = broken.length ? 1 : 0;
