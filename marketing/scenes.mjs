/**
 * Scenes the recorder can play. Each is a short (15–35 s) clip of the real
 * console or website, with captions, ending on the star-us end card.
 *
 * A brief picks one by id and may override its captions:
 *   { "scene": "gate", "captions": [["Draw a gate", "Drag agent → tool"], ...] }
 *
 * Or composes its own from steps (see `steps` below) when no named scene fits.
 * Captions given in a brief replace the defaults in order; missing ones keep
 * the default.
 */

/** Caption i: the brief's override if it gave one, else the default. */
const cap = (o, i, def) => o.captions?.[i] ?? def;

export const SCENES = {
  airspace: {
    about: 'The live Airspace map: every agent, model, MCP server/tool and API on one canvas, with connection states. Slow zoom-in and hover across agents.',
    async setup(s) {
      await s.go('airspace');
      await s.wait(15000); // the demo fleet builds up traffic
      await s.fitMap();
    },
    async play(s, o) {
      const [t, sub] = cap(o, 0, ['Every agent flow, on one live map', 'Agents, models, MCP tools and APIs — through one gateway']);
      await s.caption(null, t, sub);
      await s.wait(3200);
      for (const a of ['support-triage', 'pr-reviewer', 'outbound-sdr']) {
        const [x, y] = await s.stationAt(a);
        await s.glide(x, y, 900);
        await s.wait(1100);
      }
      const [t2, sub2] = cap(o, 1, ['State, not noise', 'Active, idle, unused, holding, blocked — readable at hundreds of agents']);
      await s.caption(null, t2, sub2);
      await s.page.evaluate(() => { const sc = window.__ctScene; const c = sc.getCamera(); sc.setCamera({ ...c, k: c.k * 1.35, x: c.x - 250, y: c.y - 120 }); });
      await s.wait(3200);
      await s.fitMap();
      await s.wait(1500);
    },
  },

  trace: {
    about: 'Click an agent on the map to trace everything it reaches — models, MCP tools, APIs — with 24h counts, cost and errors in the focus panel.',
    async setup(s) {
      await s.go('airspace');
      await s.wait(15000);
      await s.fitMap();
    },
    async play(s, o) {
      const agent = o.agent ?? 'support-triage';
      const [t, sub] = cap(o, 0, ['Where does this agent go?', 'Click it — every model, tool and API it reaches lights up']);
      await s.caption(null, t, sub);
      await s.wait(1800);
      const [x, y] = await s.stationAt(agent);
      await s.glide(x, y, 1000);
      await s.wait(800);
      await s.clickAt(x, y, 200);
      await s.wait(3500);
      const [t2, sub2] = cap(o, 1, ['Cost, tokens and failures per path', 'The map doubles as living documentation of your agent estate']);
      await s.caption(null, t2, sub2);
      await s.wait(3500);
      await s.page.keyboard.press('Escape');
      await s.wait(600);
    },
  },

  gate: {
    about: 'The signature flow: drag from an agent to an MCP tool to add a require-approval gate; the next call is held at the gate and a human approves it in the Tower.',
    async setup(s) {
      await s.go('airspace');
      await s.wait(18000);
      await s.fitMap();
    },
    async play(s, o) {
      const { page } = s;
      await s.caption(1, ...cap(o, 0, ['Your agent calls Salesforce', 'support-triage → search_contacts, dozens of times an hour']));
      const [ax, ay] = await s.stationAt('support-triage');
      await s.glide(ax, ay, 900);
      await s.wait(2000);
      await s.caption(2, ...cap(o, 1, ['Draw a gate', 'Drag from the agent to the tool — block, require approval or inspect']));
      await s.clickEl(page.getByRole('button', { name: 'Add gate' }), 800);
      await s.wait(500);
      const [sx, sy] = await s.stationAt('support-triage');
      const [tx, ty] = await s.stationAt('Salesforce', 50, 16);
      await s.glide(sx, sy, 600);
      await page.mouse.down();
      await s.glide(tx, ty, 1000);
      await page.mouse.up();
      await s.wait(700);
      const pop = page.locator('.popover').filter({ hasText: 'New gate' });
      const tool = pop.locator('select').filter({ has: page.locator('option', { hasText: 'search_contacts' }) }).first();
      const opt = (await tool.locator('option').allTextContents()).find((x) => x.includes('search_contacts'));
      await s.hoverEl(tool, 500);
      await tool.selectOption({ label: opt });
      await s.wait(500);
      await s.clickEl(pop.getByRole('button', { name: 'Require approval', exact: true }), 500);
      await s.wait(400);
      const addBtn = pop.getByRole('button', { name: 'Add gate', exact: true });
      await s.clickEl(addBtn, 600);
      await s.wait(300);
      await page.getByRole('button', { name: 'Add gate', exact: true }).first().click();
      await s.caption(3, ...cap(o, 2, ['The next call waits for a human', 'Held at the gate — not a log line after the fact']));
      await s.clickEl(page.getByRole('button', { name: /^Approvals/ }), 900);
      const card = page.locator('.tower-drawer .approval').filter({ hasText: 'support-triage' }).first();
      await card.waitFor({ timeout: 25000 });
      await s.wait(1600);
      await s.caption(4, ...cap(o, 3, ['Approve it in the Tower', 'The agent carries on. Deny, and it gets a 403.']));
      await s.clickEl(card.getByRole('button', { name: 'Approve', exact: true }), 800);
      await s.wait(2600);
      await page.keyboard.press('Escape');
    },
  },

  ledger: {
    about: 'The Ledger: spend, tokens and latency by agent, team and model across providers (Claude, GPT, Gemini).',
    async setup(s) {
      await s.go('airspace');
      await s.wait(20000); // let spend accumulate
      await s.go('ledger');
      await s.wait(1500);
    },
    async play(s, o) {
      await s.caption(null, ...cap(o, 0, ['What is every agent costing you?', 'Spend, tokens and latency by agent, team and model']));
      await s.wait(3000);
      await s.glide(800, 500, 800);
      await s.scroll(700, 3500);
      await s.caption(null, ...cap(o, 1, ['Claude, GPT and Gemini on one bill', 'Budgets and limits are gates too']));
      await s.wait(2000);
      await s.scroll(700, 3500);
      await s.wait(1500);
    },
  },

  flights: {
    about: 'Flights: every model call and MCP tool call through the gateway, live, with status, agent, target, tokens and cost; filter to blocked or held.',
    async setup(s) {
      await s.go('airspace');
      await s.wait(15000);
      await s.go('flights');
    },
    async play(s, o) {
      const { page } = s;
      await s.caption(null, ...cap(o, 0, ['Every call is a flight', 'Model calls and MCP tool calls, live, with who, where, tokens and cost']));
      await s.wait(3500);
      await s.glide(800, 420, 800);
      await s.scroll(500, 2500);
      await s.wait(800);
      const blocked = page.locator('.seg button, .tabs button, button').filter({ hasText: /^Blocked/ }).first();
      if (await blocked.count()) {
        await s.caption(null, ...cap(o, 1, ['Filter to what was stopped', 'Blocked and held flights, with the gate that stopped them']));
        await s.clickEl(blocked, 800);
        await s.wait(3000);
      }
    },
  },

  inventory: {
    about: 'The Inventory report: every agent, every path it takes and every gate on it — a printable, always-current document of the agent estate.',
    async setup(s) {
      await s.go('airspace');
      await s.wait(15000);
      await s.go('report');
    },
    async play(s, o) {
      await s.caption(null, ...cap(o, 0, ['Documentation that writes itself', 'Every agent, every path, every gate — always current, printable']));
      await s.wait(3000);
      await s.glide(800, 500, 800);
      await s.scroll(900, 4500);
      await s.wait(800);
      await s.scroll(900, 4500);
      await s.wait(1200);
    },
  },

  website: {
    about: 'The agentcontroltower.app landing page, scrolled top to bottom.',
    async setup(s) {
      await s.page.goto(s.site.url + '/');
      await s.wait(1500);
    },
    async play(s, o) {
      await s.caption(null, ...cap(o, 0, ['Control Tower', 'The open-source AI gateway that shows you where your agents go']));
      await s.wait(2500);
      await s.caption(null);
      await s.glide(800, 450, 600);
      for (let i = 0; i < 5; i++) {
        await s.scroll(750, 2200);
        await s.wait(900);
      }
    },
  },

  docs: {
    about: 'A page of the docs site (site/docs/<page>.html), scrolled with captions. Pass "page": one of the docs/*.md basenames, e.g. "airspace", "mcp", "a2a", "threat-model", "policy-as-code", "owasp-llm-top-10".',
    async setup(s, o) {
      await s.page.goto(`${s.site.url}/docs/${o.page ?? 'airspace'}.html`);
      await s.wait(1500);
    },
    async play(s, o) {
      await s.caption(null, ...cap(o, 0, ['Read how it works', 'Docs at agentcontroltower.app/docs']));
      await s.wait(2500);
      await s.glide(900, 450, 600);
      for (let i = 0; i < 4; i++) {
        await s.scroll(650, 2400);
        await s.wait(1000);
      }
    },
  },

  /**
   * Composed from the brief's own steps. Each step is one of:
   *   { "go": "<console route>" }            airspace, tower, alerts, report, ledger, flights, keys, mcp, guardrails, playground…
   *   { "site": "/docs/mcp.html" }           a website/docs path
   *   { "caption": ["Title", "subtitle"] }   or { "caption": null } to hide
   *   { "wait": 2000 }
   *   { "scroll": 600, "ms": 2500 }
   *   { "hover": "Button or link text" }     { "click": "Button or link text" }
   *   { "station": "support-triage" }        glide to a map station;  { "focus": "support-triage" } click it
   *   { "fit": true }
   * The first `go`/`site` step and any wait before the first caption happen before recording starts.
   */
  steps: {
    about: 'Your own sequence of steps (see scenes.mjs) when no named scene fits.',
    async setup(s, o) {
      const first = o.steps?.[0];
      if (first?.go) { await s.go(first.go); if (first.go === 'airspace') { await s.wait(15000); await s.fitMap(); } }
      else if (first?.site) { await s.page.goto(s.site.url + first.site); await s.wait(1500); }
    },
    async play(s, o) {
      const steps = o.steps ?? [];
      for (const [i, st] of steps.entries()) {
        if (i === 0 && (st.go || st.site)) continue;
        if (st.go) { await s.go(st.go); if (st.go === 'airspace') { await s.wait(4000); await s.fitMap(); } }
        else if (st.site) { await s.page.goto(s.site.url + st.site); await s.wait(1200); }
        else if ('caption' in st) await (st.caption ? s.caption(null, st.caption[0], st.caption[1]) : s.caption(null));
        else if (st.wait) await s.wait(Math.min(st.wait, 10000));
        else if (st.scroll) await s.scroll(st.scroll, st.ms ?? 2500);
        else if (st.hover) await s.hoverEl(s.page.getByText(st.hover, { exact: false }).first(), 800);
        else if (st.click) await s.clickEl(s.page.getByRole('button', { name: st.click }).or(s.page.getByRole('link', { name: st.click })).first(), 800);
        else if (st.station) { const [x, y] = await s.stationAt(st.station); await s.glide(x, y, 900); }
        else if (st.focus) { const [x, y] = await s.stationAt(st.focus); await s.clickAt(x, y, 900); }
        else if (st.fit) await s.fitMap();
      }
      await s.wait(1200);
    },
  },
};

/** Stills the card templates can use, by name: console route or site path, captured after the demo fleet warms up. */
export const STILLS = {
  airspace: { go: 'airspace', warm: 15000, fit: true },
  'airspace-trace': { go: 'airspace', warm: 15000, fit: true, focus: 'support-triage' },
  ledger: { go: 'ledger' },
  flights: { go: 'flights' },
  inventory: { go: 'report' },
  tower: { go: 'tower' },
  guardrails: { go: 'guardrails' },
  mcp: { go: 'mcp' },
  keys: { go: 'keys' },
  website: { site: '/' },
};
