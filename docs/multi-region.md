# Multi-region

**Enterprise:** several regions need a [Control Tower Enterprise](enterprise.md) license on the control plane.

**Status:** in progress. Available now: one control plane configures every region, regions keep serving through a control-plane outage, and calls stay in their region. Still to come: the console showing every region's calls, spend, map and held calls in one place, and budgets and rate limits shared across regions. [What that means today](#what-isnt-there-yet).

Run Control Tower close to your agents, in as many regions as you need, and configure it in one place:

- **The control plane** is the Control Tower you already run. It holds the configuration, the console, the audit log, the license and single sign-on. It can serve agents too.
- **Each region** is a Control Tower with its own database and Redis. It takes its configuration from the control plane and serves the agents near it. **Their calls stay in the region**: the flights, events, spend and held calls.

Your load balancer or DNS sends each agent to its region.

![Two regions, in sync with the control plane](images/regions.png)

## What a region takes from the control plane

Everything agents are served with:
- keys (hashes only; built-in keys stay each install's own);
- providers and their credentials;
- models and aliases;
- gates and zones;
- tool servers, HTTP APIs and A2A agents;
- guardrail services;
- exports;
- token issuers and secret managers;
- alert rules and channels;
- customers;
- budget limits;
- the license.

What a region measures itself stays its own: health checks, delivery counters, and spend so far.

**Credentials** are re-encrypted for each region's own master key before they leave the control plane, so a region's configuration is useless to anyone without that key. Credentials kept in a [secret manager](secret-managers.md) are read by the region itself, with its own access (for example, the cloud role it runs with).

**Every snapshot is signed** with the region's token, and a region refuses one that isn't. A region can't change configuration: its admin API refuses changes (`409 managed_by_control_plane`), and its console says where to go.

## Set it up

1. On the control plane, set `CT_PUBLIC_URL` to the URL regions reach it at.
2. Open **Regions** and add one (for example `eu-west`). You're shown, once, what its servers start with:

   ```
   CT_ROLE=region
   CT_REGION=eu-west
   CT_CONTROL_PLANE_URL=https://controltower.acme.com
   CT_REGION_TOKEN=ctr_…
   CT_MASTER_KEY=…
   ```

   Keep them in your secret store.

3. Start the region's servers with those settings, plus their own `CT_DATABASE_URL` and `CT_REDIS_URL` (a region can run [several instances](scaling.md), like any install) and `CT_ADMIN_KEY` for its own console. With [Helm](kubernetes.md), put the region's name and URL in the chart's `env`, and the token and master key in a Secret of your own, passed with `envFrom`.
4. **Regions** shows each region's state:
   - **in sync**: it has the current configuration;
   - **catching up**: a change hasn't reached it yet;
   - **not heard from**: nothing for a minute.

   It also shows which server last checked in, its version, and any error it reported.

**New token** replaces a region's token; the old one stops at once, so restart the region's servers with the new one. **Remove** stops the control plane answering that region.

Models are added on the control plane. A region doesn't add a model the first time an agent names it, because its configuration is the control plane's.

## When the control plane is out of reach

A region keeps serving on the configuration it last received: keys, gates, limits and approvals all work as they did. It keeps that configuration in its own database, so it serves even after a restart during the outage.

Changes made on the control plane meanwhile arrive when it's reachable again. Regions check every 5 seconds (`CT_CONFIG_POLL_S`). The region's console says it can't reach the control plane, and why.

A region that has never received any configuration serves nothing until it does.

## What isn't there yet

Each of these is the next step, not a design choice. Until then:

- **The control plane's console shows its own calls only.** Each region's flights, Ledger and map are in that region's console (sign in with its `CT_ADMIN_KEY`). The same goes for held calls: they're decided in the region's Tower, or from Slack or email links, which open the region's console.
- **Budgets and rate limits are counted per region.** A key's budget applies in each region separately.
- **Key retirement** (retiring keys unused for N days) sees use on the control plane only. Leave it off if agents use keys only in regions.
- **The audit log** is the control plane's: changes are made there. A region records nothing of its own.

## Environment

| Variable | On | |
|---|---|---|
| `CT_ROLE=region` | regions | This install is a region |
| `CT_REGION` | regions | Its name, as added on the control plane |
| `CT_CONTROL_PLANE_URL` | regions | The control plane's URL |
| `CT_REGION_TOKEN` | regions | How it signs in to the control plane |
| `CT_MASTER_KEY` | regions | The region's own master key, from the control plane (not the control plane's) |
| `CT_CONFIG_POLL_S` | regions | How often it checks for changes (default 5) |
| `CT_PUBLIC_URL` | control plane | The URL regions reach it at |

## API

On the control plane, for admins:

| Method | Path | |
|---|---|---|
| GET | `/admin/api/regions` | Regions with `status` (`waiting`, `in_sync`, `behind`, `unreachable`), `last_seen`, `instance`, `version`, `applied_at`, `error` |
| POST | `/admin/api/regions` | `{name}`: answers `env`, the settings the region starts with (shown once) |
| POST | `/admin/api/regions/:id/token` | A new token (the old one stops at once) |
| DELETE | `/admin/api/regions/:id` | |

Regions call `GET /cp/v1/config` with their token. It answers `304` when nothing changed, or a signed snapshot. On a region, `GET /admin/api/status` includes `region`: its name, its control plane, the configuration applied and when, the last contact, and any error.
