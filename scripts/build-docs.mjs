/**
 * Builds the documentation site from docs/*.md into site/docs/: a static,
 * dependency-free site with a top bar and search, a sidebar of sections, an
 * "On this page" table of contents, previous / next links, dark mode and
 * copyable, highlighted code. docs/ stays the single source; GitHub renders
 * the same Markdown.
 *
 *   pnpm docs:build        (the Pages workflow runs it before publishing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import hljs from 'highlight.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'docs');
const OUT = path.join(REPO, 'site/docs');
const GITHUB = 'https://github.com/joshmaster2165/controltower';
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

/** Sidebar: sections in reading order; each item is [file (without .md), label]. Order also drives previous / next. */
const SIDEBAR = [
  { title: 'Get Started', items: [['README', 'Overview'], ['getting-started', 'Quick start'], ['install', 'Deploy'], ['demo', 'Demo mode'], ['changelog', 'Changelog']] },
  {
    title: 'Gateway',
    items: [
      ['connect-agents', 'Client setup'],
      ['providers-and-models', 'Models & providers'],
      ['keys', 'Keys, budgets & rate limits'],
      ['mcp', 'MCP gateway'],
      ['http-apis', 'HTTP APIs & observed traffic'],
    ],
  },
  { title: 'Governance', items: [['airspace', 'Airspace, gates & approvals'], ['policy-as-code', 'Policy as code'], ['threat-model', 'What is enforced']] },
  { title: 'Operations', items: [['alerts', 'Alerting & approvals'], ['monitoring', 'Logging & metrics'], ['troubleshooting', 'Troubleshooting']] },
  { title: 'Reference', items: [['architecture', 'Architecture'], ['api', 'API reference'], ['configuration', 'CLI & environment'], ['config-file', 'Config file'], ['migrating-from-litellm', 'Migrating from LiteLLM']] },
];

const pages = SIDEBAR.flatMap((s) => s.items.map(([file, label]) => ({ file, label, section: s.title, url: file === 'README' ? 'index.html' : `${file}.html` })));
const missing = fs.readdirSync(SRC).filter((f) => f.endsWith('.md') && !pages.some((p) => `${p.file}.md` === f));
if (missing.length) throw new Error(`docs not in the sidebar: ${missing.join(', ')}`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** GitHub's heading anchors, so links written for GitHub work here too. */
const slug = (text) =>
  strip(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-');

function rewriteHref(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [p, frag] = href.split('#');
  if (/^(\.\/)?[\w-]+\.md$/.test(p)) {
    const name = p.replace(/^\.\//, '').replace(/\.md$/, '');
    return `${name === 'README' ? 'index' : name}.html${frag ? `#${frag}` : ''}`;
  }
  if (p.startsWith('images/')) return href;
  if (p.startsWith('media/')) return `../${href}`;
  if (p.startsWith('../')) {
    const rel = path.posix.normalize(p.slice(3));
    return `${GITHUB}/${rel.includes('.') ? 'blob' : 'tree'}/main/${rel}${frag ? `#${frag}` : ''}`;
  }
  return href;
}

function render(md) {
  const toc = [];
  const used = new Map();
  let title = '';
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(text);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 1 && !title) title = strip(inner);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: strip(inner) });
        return depth === 1 ? `<h1>${inner}</h1>\n` : `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang || '').split(/\s/)[0];
        const known = language && hljs.getLanguage(language);
        const body = known ? hljs.highlight(text, { language, ignoreIllegals: true }).value : esc(text);
        return `<div class="code"${language ? ` data-lang="${esc(language)}"` : ''}><pre><code class="hljs">${body}</code></pre></div>\n`;
      },
      link({ href, title: t, tokens }) {
        const url = rewriteHref(href);
        const ext = /^https?:/.test(url);
        return `<a href="${esc(url)}"${t ? ` title="${esc(t)}"` : ''}${ext ? ' target="_blank" rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title: t, text }) {
        const url = rewriteHref(href);
        return `<a class="shot" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(text)}" loading="lazy"${t ? ` title="${esc(t)}"` : ''}></a>`;
      },
      blockquote({ tokens }) {
        return `<div class="admonition"><div class="admonition-icon" aria-hidden="true">i</div><div>${this.parser.parse(tokens)}</div></div>\n`;
      },
      table(token) {
        const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  // Raw HTML anchors in the Markdown (<a id="…">) are kept.
  const html = marked.parse(md);
  return { html, toc, title };
}

function sidebarHtml(current) {
  return SIDEBAR.map((s) => {
    const open = s.items.some(([f]) => f === current.file);
    const items = s.items
      .map(([f, label]) => {
        const p = pages.find((x) => x.file === f);
        return `<li><a href="${p.url}"${f === current.file ? ' class="active" aria-current="page"' : ''}>${esc(label)}</a></li>`;
      })
      .join('');
    return `<div class="nav-section${open ? ' open' : ''}"><button class="nav-title" aria-expanded="${open}">${esc(s.title)}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><ul>${items}</ul></div>`;
  }).join('');
}

function pageHtml(page, { html, toc, title }) {
  const i = pages.indexOf(page);
  const prev = pages[i - 1];
  const next = pages[i + 1];
  const tocHtml = toc.length
    ? `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>${toc.map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>`
    : '';
  const pageTitle = page.file === 'README' ? 'Control Tower documentation' : `${title} · Control Tower docs`;
  const description = strip(html).replace(/\s+/g, ' ').trim().slice(title.length, title.length + 180).trim();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="../logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/docs.css">
<script>try{var t=localStorage.getItem('ct-docs-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
</head>
<body>
<header class="topbar">
  <button class="menu" aria-label="Menu" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
  <a class="brand" href="index.html"><img src="../logo.svg" alt="">Control Tower <span class="ver">v${esc(VERSION)}</span></a>
  <nav class="top-links"><a href="index.html"${page.section !== 'Reference' ? ' class="on"' : ''}>Docs</a><a href="getting-started.html">Get started</a><a href="configuration.html"${page.section === 'Reference' ? ' class="on"' : ''}>Reference</a><a href="../">Website</a></nav>
  <div class="search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off"><kbd>/</kbd><div class="results" role="listbox" hidden></div></div>
  <button class="theme" aria-label="Toggle dark mode"><svg class="sun" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><svg class="moon" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 12.5A6.5 6.5 0 017.5 4a6.5 6.5 0 108.5 8.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
  <a class="gh" href="${GITHUB}" aria-label="GitHub" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
</header>
<div class="layout">
  <aside class="sidebar" aria-label="Documentation">${sidebarHtml(page)}</aside>
  <main class="content">
    <nav class="crumbs" aria-label="Breadcrumbs"><a href="index.html" aria-label="Docs home"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7l6-5 6 5v7H10v-4H6v4H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></a><span>›</span><span>${esc(page.section)}</span><span>›</span><span class="here">${esc(page.label)}</span></nav>
    <article class="doc">${html}</article>
    <div class="edit"><a href="${GITHUB}/edit/main/docs/${page.file}.md" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2l3 3-8 8H3v-3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>Edit this page</a></div>
    <nav class="pager" aria-label="Pages">${prev ? `<a class="prev" href="${prev.url}"><span>Previous</span><b>« ${esc(prev.label)}</b></a>` : '<span></span>'}${next ? `<a class="next" href="${next.url}"><span>Next</span><b>${esc(next.label)} »</b></a>` : '<span></span>'}</nav>
  </main>
  ${tocHtml}
</div>
<footer class="footer"><div><img src="../logo.svg" alt="">Control Tower · Apache-2.0</div><div><a href="../">Website</a><a href="${GITHUB}" target="_blank" rel="noopener">GitHub</a><a href="${GITHUB}/releases" target="_blank" rel="noopener">Releases</a><a href="${GITHUB}/blob/main/SECURITY.md" target="_blank" rel="noopener">Security</a></div></footer>
<script src="assets/search-index.js"></script>
<script src="assets/docs.js"></script>
</body>
</html>
`;
}

// ------------------------------------------------------------ build
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.cpSync(path.join(SRC, 'images'), path.join(OUT, 'images'), { recursive: true });

const index = [];
for (const page of pages) {
  const md = fs.readFileSync(path.join(SRC, `${page.file}.md`), 'utf8');
  const r = render(md);
  fs.writeFileSync(path.join(OUT, page.url), pageHtml(page, r));
  const text = strip(r.html.replace(/<\/(td|th|li|p|h[1-6]|div|tr|pre)>|<br\s*\/?>/g, ' ')).replace(/\s+/g, ' ');
  index.push({ t: r.title || page.label, u: page.url, s: page.section, h: r.toc.map((x) => [x.text, x.id]), x: text.slice(0, 6000) });
}
fs.writeFileSync(path.join(OUT, 'assets/search-index.js'), `window.CT_DOCS_INDEX=${JSON.stringify(index)};\n`);
fs.copyFileSync(path.join(REPO, 'scripts/docs-site/docs.css'), path.join(OUT, 'assets/docs.css'));
fs.copyFileSync(path.join(REPO, 'scripts/docs-site/docs.js'), path.join(OUT, 'assets/docs.js'));
console.log(`docs site: ${pages.length} pages → ${path.relative(REPO, OUT)}/`);
