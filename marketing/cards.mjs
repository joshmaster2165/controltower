/**
 * Branded images for posts, rendered from HTML in headless Chromium: cards
 * (feature, diagram, stat, release, contribute, statement, code), carousel
 * slides (LinkedIn documents, as one PDF), and the frames the screen
 * recordings are composited into.
 *
 * Text fields are plain text; `*word*` in a headline is drawn in the accent
 * colour. Everything is escaped — briefs are model-written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SIZES = { square: [1080, 1080], landscape: [1600, 900], portrait: [1080, 1350], wide: [1920, 1080] };
export const REPO_URL = 'github.com/joshmaster2165/controltower';
const REPO_SHORT = 'joshmaster2165/controltower';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rich = (s) => esc(s).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
const logo = () => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(REPO, 'ui/public/logo.svg')).toString('base64');
const img = (file) => (file && fs.existsSync(file) ? `data:image/${path.extname(file) === '.png' ? 'png' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}` : '');

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=block');
:root { --bg:#f4f6fa; --paper:#fff; --ink:#0f1b2d; --dim:#5b6b82; --faint:#8a98ad; --line:#e3e8f0; --line2:#d3dbe7; --accent:#1f5eff; --accent2:#4b7dff; --deep:#0b3d91; --soft:#e8efff; --ok:#1a9e6b; --warn:#d9860b; --danger:#d3374e; --night:#0a1222; }
* { box-sizing: border-box; }
html, body { margin: 0; width: var(--w); height: var(--h); overflow: hidden; }
body { font-family: Geist, Inter, system-ui, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; position: relative;
  background: radial-gradient(1100px 700px at 85% -10%, #dfe8ff 0%, transparent 60%), radial-gradient(900px 600px at -10% 110%, #e6ecf7 0%, transparent 60%), var(--bg); }
body::before { content: ''; position: absolute; inset: 0; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 48px 48px; opacity: .55; -webkit-mask-image: radial-gradient(ellipse at 50% 40%, #000 30%, transparent 85%); }
body.dark { color: #fff; background: radial-gradient(1200px 800px at 80% -10%, #1b3a86 0%, transparent 60%), radial-gradient(900px 700px at 0% 110%, #10224a 0%, transparent 60%), var(--night); }
body.dark::before { background-image: linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px); opacity: 1; }
.wrap { position: absolute; inset: 0; padding: var(--pad); display: flex; flex-direction: column; }
em { font-style: normal; color: var(--accent); }
body.dark em { color: #7fa4ff; }
.eyebrow { font: 600 calc(var(--u) * 1.05) / 1 'Geist Mono', monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); display: inline-flex; align-items: center; gap: .7em; }
body.dark .eyebrow { color: #7fa4ff; }
.eyebrow::before { content: ''; width: .65em; height: .65em; border-radius: 3px; background: currentColor; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 20%, transparent); }
h1 { font-size: calc(var(--u) * var(--hs, 4)); line-height: 1.02; letter-spacing: -.035em; font-weight: 750; margin: .45em 0 0; text-wrap: balance; }
.sub { font-size: calc(var(--u) * 1.6); line-height: 1.35; color: var(--dim); margin-top: .8em; text-wrap: pretty; max-width: 34ch; }
body.dark .sub { color: #b9c6da; }
.foot { margin-top: auto; gap: 1em; display: flex; align-items: center; justify-content: space-between; font-size: calc(var(--u) * 1.05); color: var(--dim); position: relative; z-index: 2; }
body.dark .foot { color: #b9c6da; }
.brand { display: flex; align-items: center; gap: .6em; font-weight: 700; white-space: nowrap; color: var(--ink); font-size: calc(var(--u) * 1.3); letter-spacing: -.01em; }
body.dark .brand { color: #fff; }
.brand img { width: 1.7em; height: 1.7em; }
.star { white-space: nowrap; font: 500 calc(var(--u) * .9) / 1 'Geist Mono', monospace; padding: .8em 1.1em; border-radius: .8em; background: var(--ink); color: #fff; display: inline-flex; gap: .6em; align-items: center; }
body.dark .star { background: linear-gradient(#3a72ff,#1f5eff); }
.window { border-radius: calc(var(--u) * .9); background: #fff; box-shadow: 0 40px 80px -20px rgba(15,27,45,.35), 0 0 0 1px rgba(15,27,45,.08); overflow: hidden; }
.window .bar { height: calc(var(--u) * 2.2); background: #f7f9fc; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: calc(var(--u) * .5); padding: 0 calc(var(--u) * .9); }
.window .bar i { width: calc(var(--u) * .7); height: calc(var(--u) * .7); border-radius: 50%; background: #d8dee8; display: block; }
.window .bar span { margin-left: calc(var(--u) * .8); font: 500 calc(var(--u) * .8) / 1 'Geist Mono', monospace; color: var(--faint); }
.window img { display: block; width: 100%; }
.chip { display: inline-flex; align-items: center; gap: .45em; font: 600 calc(var(--u) * .85) / 1 'Geist Mono', monospace; padding: .55em .8em; border-radius: .6em; background: var(--soft); color: var(--accent); border: 1px solid #c9d8ff; }
.bul { list-style: none; padding: 0; margin: 1.2em 0 0; display: grid; gap: .7em; font-size: calc(var(--u) * 1.45); }
.bul li { display: flex; gap: .7em; align-items: baseline; }
.bul li::before { content: '→'; color: var(--accent); font-weight: 700; }
body.dark .bul li::before { color: #7fa4ff; }
`;

function page(size, body, { dark = false, pad } = {}) {
  const [w, h] = SIZES[size] ?? SIZES.square;
  const u = Math.round(Math.min(w, h) / 38);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    :root { --w: ${w}px; --h: ${h}px; --u: ${u}px; --pad: ${pad ?? Math.round(u * 3.4)}px; }</style></head>
    <body class="${dark ? 'dark' : ''}">${body}</body></html>`;
}

const foot = (cta = true) => `<div class="foot"><div class="brand"><img src="${logo()}">Control Tower</div>${cta ? `<div class="star">★ ${REPO_SHORT}</div>` : '<div>agentcontroltower.app</div>'}</div>`;

// ---------------------------------------------------------------- templates

const T = {
  /** eyebrow, headline, sub, bullets[], still (file) */
  feature(c, size, ctx) {
    const shot = img(ctx.still(c.still));
    const land = size === 'landscape' || size === 'wide';
    return page(size, `<div class="wrap" style="${land ? 'flex-direction:row;gap:calc(var(--u)*2.5)' : ''}">
      <div style="${land ? 'width:42%;display:flex;flex-direction:column' : ''}">
        <div class="eyebrow">${esc(c.eyebrow ?? 'Open-source AI gateway')}</div>
        <h1 style="--hs:${land ? 3.3 : shot ? 3 : 3.6}">${rich(c.headline)}</h1>
        ${c.sub ? `<div class="sub">${rich(c.sub)}</div>` : ''}
        ${c.bullets?.length ? `<ul class="bul" style="${shot && !land ? 'font-size:calc(var(--u)*1.15);gap:.4em;margin-top:.9em' : ''}">${c.bullets.slice(0, shot && !land ? 3 : 4).map((b) => `<li>${rich(b)}</li>`).join('')}</ul>` : ''}
        ${land ? foot() : ''}
      </div>
      ${shot ? `<div style="${land ? 'flex:1;display:flex;align-items:center;margin-right:calc(var(--pad)*-1.6)' : 'margin:calc(var(--u)*1.4) calc(var(--pad)*-1.4) calc(var(--u)*1.2) 0;flex:1;min-height:40%'}">
        <div class="window" style="${land ? 'width:100%' : 'height:100%'};transform:perspective(2400px) rotateY(-7deg) rotateX(2deg);transform-origin:left center">
          <div class="bar"><i></i><i></i><i></i><span>controltower — ${esc(c.still ?? '')}</span></div>
          <img src="${shot}" style="${land ? '' : 'height:calc(100% - var(--u)*2.2);width:100%;object-fit:cover;object-position:0 45%'}">
        </div></div>` : ''}
      ${land ? '' : foot()}
    </div>`, { dark: c.dark });
  },

  /** headline, sub, agents[], destinations[{name, kind: model|mcp|tool|api|agent}], gates[{to, action: allow|deny|approve|inspect|limit}] */
  diagram(c, size) {
    const agents = (c.agents ?? ['support-triage', 'pr-reviewer', 'outbound-sdr']).slice(0, 5);
    const dests = (c.destinations ?? [{ name: 'Claude', kind: 'model' }, { name: 'GPT', kind: 'model' }, { name: 'Salesforce MCP', kind: 'mcp' }, { name: 'GitHub MCP', kind: 'mcp' }]).slice(0, 6);
    const gates = (c.gates ?? []).map((g) => ({ to: g.to, action: g.action }));
    const kindIcon = { model: '◆', mcp: '⚙', tool: '⚙', api: '⇄', agent: '●' };
    const node = (t, k, cls, i) => `<div class="dn ${cls}" data-i="${i}"><span class="ic">${kindIcon[k] ?? '●'}</span>${esc(t)}</div>`;
    // Nodes are laid out by flexbox; the connecting curves are drawn after layout, from the real boxes.
    const script = `(() => {
      const gates = ${JSON.stringify(gates).replace(/</g, '\\u003c')};
      const col = { allow: '#1a9e6b', deny: '#d3374e', approve: '#d9860b', inspect: '#1f5eff', limit: '#7a5cff' };
      const lab = { allow: 'allow', deny: 'deny', approve: 'needs approval', inspect: 'inspect', limit: 'limit' };
      const st = document.querySelector('.dstage'), R = st.getBoundingClientRect(), svg = st.querySelector('svg');
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - R.left, r: r.right - R.left, y: r.top - R.top + r.height / 2 }; };
      const hub = box(st.querySelector('.hub'));
      let out = '', labels = '';
      st.querySelectorAll('.dn.agent').forEach((el) => { const b = box(el); const m = (b.r + hub.l) / 2; out += '<path d="M' + b.r + ',' + b.y + ' C' + m + ',' + b.y + ' ' + m + ',' + hub.y + ' ' + hub.l + ',' + hub.y + '" stroke="#b8c6dc" stroke-width="3" fill="none"/>'; });
      st.querySelectorAll('.dn.dest').forEach((el) => {
        const b = box(el); const name = el.textContent.slice(1); const g = gates.find((x) => x.to === name);
        const c = g ? (col[g.action] || '#1f5eff') : '#b8c6dc'; const m = (hub.r + b.l) / 2;
        out += '<path d="M' + hub.r + ',' + hub.y + ' C' + m + ',' + hub.y + ' ' + m + ',' + b.y + ' ' + b.l + ',' + b.y + '" stroke="' + c + '" stroke-width="' + (g ? 5 : 3) + '" fill="none"' + (g && g.action === 'deny' ? ' stroke-dasharray="10 9"' : '') + '/>';
        if (g) labels += '<div class="glab" style="left:' + (b.l - 14) + 'px;top:' + b.y + 'px;color:' + c + ';border-color:' + c + '">' + (lab[g.action] || 'gate') + '</div>';
      });
      svg.innerHTML = out; st.insertAdjacentHTML('beforeend', labels);
    })();`;
    return page(size, `<style>
      .dstage { flex: 1; position: relative; display: flex; align-items: center; justify-content: space-between; margin: calc(var(--u)*1.2) calc(var(--pad)*-.35) calc(var(--u)*1.2); min-height: 0; }
      .dstage svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      .dcol { display: flex; flex-direction: column; justify-content: space-around; gap: calc(var(--u)*.7); height: 100%; position: relative; z-index: 1; }
      .dn { padding: calc(var(--u)*.55) calc(var(--u)*.8); border-radius: calc(var(--u)*.55); background: #fff; box-shadow: 0 14px 30px -14px rgba(15,27,45,.35), 0 0 0 1px var(--line2); font: 600 calc(var(--u)*.78)/1.2 Geist; white-space: nowrap; display: flex; gap: .5em; align-items: center; color: var(--ink); }
      .dn .ic { color: var(--accent); }
      .hub { position: relative; z-index: 1; padding: calc(var(--u)*1) calc(var(--u)*1.2); border-radius: calc(var(--u)*.9); background: linear-gradient(#1b3a86,#0a1222); color: #fff; font: 700 calc(var(--u)*.95)/1.2 Geist; display: flex; gap: .55em; align-items: center; box-shadow: 0 24px 50px -18px rgba(11,61,145,.6); white-space: nowrap; }
      .hub img { width: 1.8em; height: 1.8em; }
      .glab { position: absolute; z-index: 2; transform: translate(-100%, -50%); background: #fff; border: 2px solid; border-radius: 99px; padding: .3em .7em; font: 600 calc(var(--u)*.62)/1 'Geist Mono'; white-space: nowrap; }
    </style><div class="wrap">
      <div class="eyebrow">${esc(c.eyebrow ?? 'How it works')}</div>
      <h1 style="--hs:${size === 'square' || size === 'portrait' ? 2.7 : 2.6}">${rich(c.headline)}</h1>
      ${c.sub ? `<div class="sub" style="max-width:46ch;font-size:calc(var(--u)*1.25)">${rich(c.sub)}</div>` : ''}
      <div class="dstage"><svg></svg>
        <div class="dcol">${agents.map((a, i) => node(a, 'agent', 'agent', i)).join('')}</div>
        <div class="hub"><img src="${logo()}">Control Tower</div>
        <div class="dcol" style="padding-left:calc(var(--u)*3)">${dests.map((d, i) => node(d.name, d.kind, 'dest', i)).join('')}</div>
      </div>
      ${foot()}
    </div><script>addEventListener('load', () => document.fonts.ready.then(() => { ${script} document.body.dataset.ready = 1; }));</script>`, { dark: c.dark });
  },

  /** eyebrow, value, label, sub */
  stat(c, size) {
    return page(size, `<div class="wrap" style="justify-content:center">
      <div class="eyebrow">${esc(c.eyebrow ?? 'Control Tower')}</div>
      <div style="font-size:calc(var(--u)*11);font-weight:800;letter-spacing:-.05em;line-height:.95;margin-top:.25em;background:linear-gradient(120deg,var(--accent),#7fa4ff);-webkit-background-clip:text;color:transparent">${esc(c.value)}</div>
      <h1 style="--hs:2.8;margin-top:.3em">${rich(c.label)}</h1>
      ${c.sub ? `<div class="sub" style="max-width:40ch">${rich(c.sub)}</div>` : ''}
      <div style="position:absolute;left:var(--pad);right:var(--pad);bottom:var(--pad)">${foot()}</div>
    </div>`, { dark: c.dark ?? true });
  },

  /** version, date, headline, highlights[] */
  release(c, size) {
    return page(size, `<div class="wrap">
      <div style="display:flex;gap:12px;align-items:center"><span class="chip">v${esc(String(c.version ?? '').replace(/^v/, ''))}</span><span class="eyebrow" style="color:var(--faint)">${esc(c.date ?? 'New release')}</span></div>
      <h1 style="--hs:3.6">${rich(c.headline ?? "What's new")}</h1>
      <ul class="bul" style="margin-top:1.4em">${(c.highlights ?? []).slice(0, 5).map((b) => `<li>${rich(b)}</li>`).join('')}</ul>
      <div style="margin-top:1.6em" class="sub"><span style="font-family:'Geist Mono';font-size:.8em;background:var(--paper);border:1px solid var(--line2);padding:.5em .8em;border-radius:.6em;color:var(--ink)">docker run -p 4000:4000 ghcr.io/joshmaster2165/controltower</span></div>
      ${foot()}
    </div>`, { dark: c.dark });
  },

  /** headline, sub, issues[{number, title, labels[]}], stars */
  contribute(c, size) {
    const issues = (c.issues ?? []).slice(0, 4);
    return page(size, `<div class="wrap">
      <div class="eyebrow">${esc(c.eyebrow ?? 'Open source · Apache-2.0')}</div>
      <h1 style="--hs:3.5">${rich(c.headline ?? 'Build it *with* us')}</h1>
      ${c.sub ? `<div class="sub">${rich(c.sub)}</div>` : ''}
      <div style="display:grid;gap:14px;margin-top:1.6em">${issues.map((i) => `
        <div style="display:flex;gap:16px;align-items:center;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:16px 20px">
          <span style="font:600 18px 'Geist Mono';color:#7fa4ff">#${esc(i.number)}</span>
          <span style="font-size:20px;font-weight:550;flex:1">${esc(i.title)}</span>
          ${(i.labels ?? []).slice(0, 1).map((l) => `<span class="chip" style="background:rgba(127,164,255,.15);border-color:rgba(127,164,255,.4);color:#b9ccff">${esc(l)}</span>`).join('')}
        </div>`).join('')}</div>
      ${foot()}
    </div>`, { dark: c.dark ?? true });
  },

  /** eyebrow, statement, attribution */
  statement(c, size) {
    return page(size, `<div class="wrap" style="justify-content:center">
      <div class="eyebrow">${esc(c.eyebrow ?? 'Control Tower')}</div>
      <h1 style="--hs:${String(c.statement ?? '').length > 90 ? 3.2 : 4.2};margin-top:.5em">${rich(c.statement)}</h1>
      ${c.attribution ? `<div class="sub">— ${esc(c.attribution)}</div>` : ''}
      <div style="position:absolute;left:var(--pad);right:var(--pad);bottom:var(--pad)">${foot()}</div>
    </div>`, { dark: c.dark ?? true });
  },

  /** eyebrow, headline, code (multi-line), language, sub */
  code(c, size) {
    const lines = String(c.code ?? '').split('\n').map((l) => `<div>${esc(l).replace(/^(\s*)(#.*)$/, '$1<span style="color:#7d8aa3">$2</span>').replace(/^(\$ )/, '<span style="color:#7fa4ff">$ </span>') || '&nbsp;'}</div>`).join('');
    return page(size, `<div class="wrap">
      <div class="eyebrow">${esc(c.eyebrow ?? 'Try it in one command')}</div>
      <h1 style="--hs:3.3">${rich(c.headline)}</h1>
      ${c.sub ? `<div class="sub">${rich(c.sub)}</div>` : ''}
      <div style="margin-top:1.4em;border-radius:18px;background:#0a1222;color:#e6ecf7;font:500 calc(var(--u)*1.05)/1.6 'Geist Mono';padding:1.1em 1.3em;box-shadow:0 30px 60px -20px rgba(10,18,34,.5);overflow:hidden">
        <div style="display:flex;gap:8px;margin-bottom:.9em"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i></div>${lines}</div>
      ${foot()}
    </div>`, { dark: c.dark });
  },

  /** carousel cover: eyebrow, headline, sub */
  cover(c, size) {
    return page(size, `<div class="wrap" style="justify-content:center">
      <div class="eyebrow">${esc(c.eyebrow ?? 'Control Tower')}</div>
      <h1 style="--hs:4.4">${rich(c.headline)}</h1>
      ${c.sub ? `<div class="sub">${rich(c.sub)}</div>` : ''}
      <div style="margin-top:2em;font:500 calc(var(--u)*1)/1 'Geist Mono';color:#7fa4ff">Swipe →</div>
      <div style="position:absolute;left:var(--pad);right:var(--pad);bottom:var(--pad)">${foot(false)}</div>
    </div>`, { dark: true });
  },

  /** carousel closer: headline, sub */
  cta(c, size) {
    return page(size, `<div class="wrap" style="justify-content:center;align-items:center;text-align:center">
      <img src="${logo()}" style="width:120px;height:120px;filter:drop-shadow(0 16px 40px rgba(31,94,255,.5))">
      <h1 style="--hs:3.6">${rich(c.headline ?? 'Star it. Fork it. *Ship safer agents.*')}</h1>
      <div class="sub" style="margin-inline:auto">${rich(c.sub ?? 'Open source, self-hosted, Apache-2.0.')}</div>
      <div style="margin-top:1.6em;display:grid;gap:14px;justify-items:center">
        <div class="star" style="font-size:calc(var(--u)*1.3)">★ ${REPO_URL}</div>
        <div style="font:500 calc(var(--u)*1)/1 'Geist Mono';color:#b9c6da">agentcontroltower.app</div>
      </div>
    </div>`, { dark: true });
  },
};

export const TEMPLATES = Object.keys(T);

export async function renderCard(browser, spec, size, out, ctx) {
  const fn = T[spec.template];
  if (!fn) throw new Error(`unknown card template ${spec.template} (have ${TEMPLATES.join(', ')})`);
  const [w, h] = SIZES[size] ?? SIZES.square;
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(fn(spec, size, ctx), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForFunction(() => !document.querySelector('.dstage') || document.body.dataset.ready, null, { timeout: 5000 }).catch(() => {});
  await p.screenshot({ path: out, type: 'png' });
  await p.close();
}

/** Carousel slides → one PDF (LinkedIn document post) plus a PNG of each slide for the preview. */
export async function renderCarousel(browser, slides, out, pngPrefix, ctx) {
  const size = 'portrait';
  const [w, h] = SIZES[size];
  const htmls = slides.map((sl) => T[sl.template]?.(sl, size, ctx) ?? (() => { throw new Error(`unknown slide template ${sl.template}`); })());
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  const pngs = [];
  for (const [i, html] of htmls.entries()) {
    await p.setContent(html, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
  await p.waitForFunction(() => !document.querySelector('.dstage') || document.body.dataset.ready, null, { timeout: 5000 }).catch(() => {});
    const f = `${pngPrefix}-${i + 1}.png`;
    await p.screenshot({ path: f });
    pngs.push(f);
  }
  // One PDF page per slide image, exact size.
  const doc = `<!doctype html><html><head><style>@page{size:${w}px ${h}px;margin:0}body{margin:0}img{display:block;width:${w}px;height:${h}px;page-break-after:always}</style></head><body>${pngs.map((f) => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}">`).join('')}</body></html>`;
  await p.setContent(doc, { waitUntil: 'load' });
  await p.pdf({ path: out, width: `${w}px`, height: `${h}px`, printBackground: true });
  await p.close();
  return pngs;
}

/**
 * The frame a recording is composited into: branded background with the
 * headline, and a rounded-corner mask for the video window. Returns the
 * video rectangle.
 */
export async function renderVideoFrame(browser, { headline, sub }, size, bgOut, maskOut) {
  const [w, h] = SIZES[size];
  let vw, vh, vx, vy;
  if (size === 'square') { vw = 1040; vh = 585; vx = 20; vy = 262; }
  else if (size === 'portrait') { vw = 1000; vh = 562; vx = 40; vy = 400; }
  else { vw = 1536; vh = 864; vx = (w - 1536) / 2; vy = 176; }
  const titleSize = size === 'wide' ? 2.2 : 2.05;
  const body = `<div class="wrap" style="padding:${size === 'wide' ? '34px 192px' : 'var(--pad)'};">
    <div style="${size === 'wide' ? 'display:flex;align-items:baseline;gap:24px;justify-content:space-between' : ''}">
      <h1 style="--hs:${titleSize};margin:0">${rich(headline)}</h1>
      ${sub && size === 'portrait' ? `<div class="sub" style="margin-top:.5em;max-width:40ch">${rich(sub)}</div>` : ''}
      ${size === 'wide' ? `<div class="brand" style="flex:none"><img src="${logo()}">Control Tower</div>` : ''}
    </div>
    <div style="position:absolute;left:${vx}px;top:${vy}px;width:${vw}px;height:${vh}px;border-radius:22px;box-shadow:0 40px 90px -24px rgba(15,27,45,.45),0 0 0 1px rgba(15,27,45,.1);background:#0a1222"></div>
    ${size === 'wide' ? '' : `<div style="position:absolute;left:var(--pad);right:var(--pad);bottom:calc(var(--pad)*.8)">${foot()}</div>`}
  </div>`;
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(page(size, body), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: bgOut });
  await p.setContent(`<html><body style="margin:0;background:#000;width:${vw}px;height:${vh}px"><div style="width:${vw}px;height:${vh}px;border-radius:22px;background:#fff"></div></body></html>`);
  await p.setViewportSize({ width: vw, height: vh });
  await p.screenshot({ path: maskOut });
  await p.close();
  return { w, h, vw, vh, vx, vy };
}
