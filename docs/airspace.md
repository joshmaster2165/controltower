# The Airspace: map, gates and approvals

The Airspace is a live map of every agentic data flow: agents on the left, the tower (Control Tower) in the middle, and the models, MCP tool servers and HTTP APIs they reach on the right. It is also where you enforce policy — you draw rules on it.

![The Airspace with the demo fleet](images/airspace.png)

## Reading the map

| On the map | Meaning |
|---|---|
| **Station** | An agent (one key, or every key sharing an [agent ID](keys.md#many-copies-of-one-agent), drawn once with a ×N count), a model, an MCP tool server with its tools, an HTTP API with its routes, or a system seen outside the gateway |
| **Line** | A path an agent uses. **Solid** = through the gateway, enforceable. **Dashed** = reported by the agent's SDK or OpenTelemetry, *seen but not enforced* |
| Line state | **active** (last minute) · **idle** (last 24 h) · **no traffic** · **holding** (waiting for approval) · **blocked** |
| **Zone** | A coloured region grouping stations — *Sales*, *AI Labs sandbox*, *Frontier models* |
| **Gate** | An icon on a path: red = deny, amber = approval, blue = inspect. The badge counts what it did recently |
| Top bar | Flights, spend, blocked · errors, active links and requests holding right now |

- **All / Active / Gateway / Outside** filters what's drawn.
- **Drag** stations to arrange the map; the arrangement is saved for everyone. Drag the canvas or scroll to pan, ⌘/Ctrl + scroll to zoom, **Fit** to see everything.
- **Hover** a line or tool for its requests, spend, errors and gates.

**Click a station** to trace it: everything it connects to is highlighted, with requests, spend and errors per connection.

![Tracing one agent: what it reaches, how often, at what cost](images/airspace-trace.png)

A red dashed line from an agent straight to a model provider means that agent is calling the provider directly, skipping the gateway, its gates and its budgets. **Bring it inside** on that station shows how to route it through Control Tower. See [HTTP APIs and observed traffic](http-apis.md).

## Large fleets: teams, agents and search

With hundreds of agents the map starts at the **organization level**: one station per team (the key's **Team** label), with a count of its agents and a stack look. **Teams / Agents** in the map controls switches between that and one station per agent; the map picks Teams on its own once there are more agents than fit on screen, and remembers your choice.

- **Open a team** with the arrow on its card: its agents take its place under a header, and the map scrolls to them. Click the header to fold the team back.
- A team with a single agent is always drawn as that agent.
- **Copies of one agent** (keys sharing an [agent ID](keys.md#many-copies-of-one-agent)) are one station with a ×N count at every level.
- Gates and zones work at every level. A gate drawn on a team covers every key in that team, including keys added later; a gate drawn on a group covers every copy.

**Find** (or press <kbd>/</kbd>) searches teams, agents, single keys, models, tool servers and tools by name. Pick a result and the map opens the team it is folded into, centres it and traces its connections.

## What needs attention

**Attention** in the toolbar lists what needs a person on the map you are looking at — the whole organization or a [view](#views-one-part-of-the-organization-at-a-time) — most urgent first, and dims everything else while it is open. The badge counts the items that matter most.

| Item | When |
|---|---|
| **Waiting for approval** | Calls held at a gate right now |
| **Blocked now** | Calls denied by a gate in the last minute |
| **Outside the gateway** | Agents calling a model provider directly: no gates or budgets apply (see [HTTP APIs and observed traffic](http-apis.md)) |
| **Failing** | A model or tool server with at least 5% of its calls failing in the last minute |
| **Destructive tools with no gate** | A delete, merge, payment or other destructive tool in use that no gate can deny, hold or inspect |
| **New connections** | An agent that reached a model or tool it had not used before, in the last day. Needs a day of history first, so a new install doesn't flag everything |
| **Unusual traffic** | A station at 30 calls a minute or more and over three times its usual rate. Needs an hour of history |

Pick an item to jump to it: its team opens if it is folded, and it is centred and traced; close the trace to come back to the list. **Busiest now** lists the stations with the most calls in the last minute.

## Views: one part of the organization at a time

A **view** is a named part of the organization, such as *Engineering* or *Marketing*: a set of teams with a map of its own. Create one with **+ New view** under Airspace in the sidebar: name it, pick a colour and tick its teams. Each view is then a link under Airspace, and everyone sees it.

In a view:

- The map shows only its teams' agents and the models, tool servers, tools and outside systems they reach. Until its agents have made any calls, every model and tool server is shown, so a first gate can be drawn.
- **Flights**, **Spend**, **Blocked · errors** and **Holding** count only its traffic, from the moment the view is opened; the approvals drawer lists only its requests.
- Live traffic from other teams is left out, and search finds only what is in the view.
- Teams / Agents, opening teams, gates and zones work as on the whole map. A view with a single team always shows its agents.

The header shows the view's name; **⋯** edits it and **×** returns to the whole organization. Each view has its own link (`#/airspace/<view id>`) to share. Views decide what the map shows, not who may see it.

## Flight Recorder: replay past traffic

**Replay** plays a past window — the last hour, 6 hours, 24 hours or 7 days — back on the map: every recorded call travels its path again, holds wait at their gates and blocked calls turn red, compressed 10× to 10,000×. Play, pause, change speed or drag the scrubber to any moment; quiet stretches are skipped. Live traffic waits while you watch and the map returns to it with **Back to live**.

![Replaying the last hour on the Airspace](images/replay.png)

It's the quickest way to see what an agent did overnight, or what a gate changed since it was added. Replay covers the flights still [retained](architecture.md#data-and-retention) (30 days by default); like the live map, it shows who called what and what happened, never request contents. API: `GET /admin/api/replay?from=&to=`.

## Put a gate on a path

**Add gate**, then drag from an agent to a model, a tool server or a single tool — or click any line or tool row. Right-clicking a station works too.

![The gate composer: support-triage → Salesforce → search_contacts, require approval](images/gate-composer.png)

| Effect | What the agent gets |
|---|---|
| **Block** | `403 policy_denied` with the reason you give (for MCP, an error tool result the model can read) |
| **Require approval** | The request waits at the gate for a human, up to the hold time (default 20 s) |
| **Inspect** | Scans what passes for secrets, personal data or prompt injection — and masks, blocks or flags it |
| **Allow** | An explicit exception above broader gates |

A gate can cover one agent, a whole zone, or every agent; one model, a zone of models, a tool server, one tool, a tool glob (`github__merge_*`), or an operation class — read, write or destructive (deletes, merges, payments; `admin` in the API). Gates are checked in priority order; the first access gate that matches decides, and every matching inspect gate runs as well.

Tick **Alert me** to be told when the gate fires; see [Alerts](alerts.md).

### Simulate before you enforce

**Simulate on last 24 h** replays yesterday's recorded traffic through the current gates plus your draft and shows only what would change: how many requests would be blocked or held, from which agents, to which targets, and the spend involved. The affected paths are highlighted on the map.

![Simulating a draft gate against the last 24 hours](images/gate-simulate.png)

On an existing gate, click its icon for **Impact in the last 24 h**, or change its effect and **Simulate this change**. Tool arguments and bodies are not stored, so argument conditions and inspect gates can't be replayed; the result says so.

## Approvals: the Tower

When a request hits an approval gate it **holds**: the agent's HTTP request stays open, the flight orbits the gate on the map, and a card appears in the **Approvals** drawer and on the **Tower** page.

![A held call in the Approvals drawer](images/approvals-drawer.png)

The card shows exactly what would happen — the agent, the model or tool, and the **actual arguments** of the call — and a plain statement of the scope: *Approve this ONE call to salesforce__search_contacts with exactly these arguments*. Identical retries attach to the same card (*2 waiting*) instead of piling up.

![The Tower: waiting requests and recent decisions](images/tower.png)

- **Approve** within the hold time and the request simply continues; the agent never knows it waited.
- **Deny** and the agent gets a `403` with the reason.
- **Nobody answers** in time: the agent gets `403 approval_required` with a **ticket**. Once someone approves, the agent retries the same call with `x-ct-approval: <ticket>` and it goes through **once**. A retry with different arguments is refused and raised as a security event (`scope_mismatch`).
- Held alerts by [email](alerts.md#approving-by-email), in Slack or to a webhook link straight to the card. Approving is always an authenticated action in the console — a link click never approves anything.

## Zones

Zones name groups of stations so gates can be written once for all of them: *every agent in AI Labs sandbox → anything in Code hosting: deny*.

**Draw zone**, then drag a lasso around the stations that belong together, name it and pick a colour.

![Drawing a zone around two agents](images/zone-create.png)

A zone can also match by attribute — every key of a team or project, keys with a tag, or every model of a provider kind — so new agents join it automatically (set this through the API or a [policy file](policy-as-code.md)). Click a zone's label to rename it, add a gate from it, or delete it (with its gates).

## Policy as code

Everything drawn here can be exported as YAML for review and Git, and applied back with a preview. See [Policy as code](policy-as-code.md).

![Export: map image, inventory, and policy as YAML](images/export-menu.png)

## What is enforced — and what isn't

Control Tower enforces traffic that goes through it: model calls to `/v1`, tool calls to `/mcp` and API calls to `/http`. A path drawn solid is one the gateway is actually on. An agent that changes its own base URL bypasses the gateway; a tool the agent can't see through `/mcp` needs no approval, which is why tool filtering is the stronger control. Traffic reported through `/v1/observe` or OpenTelemetry is *seen*, never enforced, and is drawn dashed. See the [threat model](threat-model.md).
