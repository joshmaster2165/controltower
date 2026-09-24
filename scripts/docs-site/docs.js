// Control Tower docs: theme toggle, sidebar sections, mobile menu, "On this page" tracking, copy buttons, search.
(() => {
  const root = document.documentElement;
  const store = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
    return null;
  };

  // Theme: follows the system until toggled.
  document.querySelector('.theme')?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store('ct-docs-theme', root.dataset.theme);
  });

  // Sidebar sections open and close; the current page's section starts open.
  for (const b of document.querySelectorAll('.nav-title')) {
    b.addEventListener('click', () => {
      const s = b.parentElement;
      s.classList.toggle('open');
      b.setAttribute('aria-expanded', String(s.classList.contains('open')));
    });
  }
  const menu = document.querySelector('.menu');
  menu?.addEventListener('click', () => {
    document.body.classList.toggle('nav-open');
    menu.setAttribute('aria-expanded', String(document.body.classList.contains('nav-open')));
  });
  document.querySelector('.sidebar .active')?.scrollIntoView({ block: 'center' });

  // Copy buttons on code blocks.
  for (const block of document.querySelectorAll('.code')) {
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(block.querySelector('code').innerText);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Press ⌘C';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
    block.appendChild(btn);
  }

  // "On this page": highlight the section being read.
  const links = [...document.querySelectorAll('.toc a')];
  const heads = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  const spy = () => {
    let current = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < 110) current = h;
    for (const a of links) a.classList.toggle('on', current && a.hash === `#${current.id}`);
  };
  if (heads.length) {
    addEventListener('scroll', spy, { passive: true });
    spy();
  }

  // Search over page titles, headings and text.
  const index = window.CT_DOCS_INDEX || [];
  const input = document.querySelector('.search input');
  const box = document.querySelector('.results');
  if (!input || !box) return;
  const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const mark = (s, terms) => {
    let out = escHtml(s);
    for (const t of terms) out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return out;
  };
  let sel = -1;
  const run = () => {
    const q = input.value.trim().toLowerCase();
    sel = -1;
    if (q.length < 2) return void (box.hidden = true);
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = [];
    for (const p of index) {
      const title = p.t.toLowerCase();
      const text = p.x.toLowerCase();
      if (terms.every((t) => title.includes(t) || text.includes(t))) {
        const i = text.indexOf(terms[0]);
        const snip = i < 0 ? p.x.slice(0, 140) : `${i > 50 ? '…' : ''}${p.x.slice(Math.max(0, i - 50), i + 110)}…`;
        hits.push({ score: terms.filter((t) => title.includes(t)).length * 10 + 1, url: p.u, sec: p.s, title: p.t, snip });
      }
      for (const [h, id] of p.h) {
        const hl = h.toLowerCase();
        if (terms.every((t) => hl.includes(t))) hits.push({ score: 20, url: `${p.u}#${id}`, sec: `${p.s} › ${p.t}`, title: h, snip: '' });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    box.innerHTML = hits.length
      ? hits.slice(0, 12).map((h) => `<a href="${h.url}" role="option"><div class="r-sec">${escHtml(h.sec)}</div><div class="r-title">${mark(h.title, terms)}</div>${h.snip ? `<div class="r-snip">${mark(h.snip, terms)}</div>` : ''}</a>`).join('')
      : '<div class="empty">No results</div>';
    box.hidden = false;
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('keydown', (e) => {
    const items = [...box.querySelectorAll('a')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(items.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((a, i) => a.classList.toggle('sel', i === sel));
      items[sel]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const a = items[sel] ?? items[0];
      if (a) location.href = a.getAttribute('href');
    } else if (e.key === 'Escape') {
      box.hidden = true;
      input.blur();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) box.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) {
      e.preventDefault();
      input.focus();
    }
  });
})();
