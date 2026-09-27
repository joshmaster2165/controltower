# Running several instances

One Control Tower instance handles a lot — hundreds of calls a second with about a millisecond of its own overhead — and keeps its data in SQLite in its data directory. Run several instances behind a load balancer when you need more than one machine's worth, or want traffic to keep flowing while one restarts. They share a **Postgres** database and keep in step over **Redis**.

## Quick reference

| Setting | What it is |
|---|---|
| `CT_DATABASE_URL` | Postgres, shared by every instance (`postgres://user:password@host:5432/controltower`) |
| `CT_REDIS_URL` | Redis, shared by every instance (`redis://host:6379`) |
| `CT_MASTER_KEY` | The same master key on every instance — it encrypts provider credentials and signs delegation tokens |
| `CT_PUBLIC_URL` | The load balancer's address, the same on every instance (links in alerts, A2A cards, push notifications) |
| `CT_INSTANCE_ID` | Optional: this instance's name in the cluster (default: host, process and a random suffix) |
| `CT_DB_POOL` | Optional: Postgres connections per instance (default 20) |

Any load balancer works, with no sticky sessions: each request carries its key, and what an instance keeps in memory is kept in step with the others.

## Step 1: Postgres and Redis

Any Postgres 14 or later and Redis 6 or later. Create an empty database; Control Tower creates its tables when the first instance starts, and instances starting together wait for each other.

## Step 2: Move your data (optional)

To bring an existing install along — keys, providers, gates, history — copy its SQLite database into the empty Postgres database, once, with Control Tower stopped:

```bash
docker run --rm -v ct-data:/data ghcr.io/joshmaster2165/controltower:latest --copy-to-postgres postgres://user:password@host:5432/controltower
```

The copy refuses a database that already has data. Your install's master key comes along with it: its stored credentials are encrypted with that key, so start every instance with it — it is in `/data/master.key` if you didn't set `CT_MASTER_KEY`.

## Step 3: Start the instances

Start each with the same settings:

```bash
docker run -d -p 4000:4000 \
  -e CT_DATABASE_URL=postgres://user:password@db:5432/controltower \
  -e CT_REDIS_URL=redis://cache:6379 \
  -e CT_MASTER_KEY=… -e CT_ADMIN_KEY=… \
  -e CT_PUBLIC_URL=https://controltower.example.com \
  ghcr.io/joshmaster2165/controltower:latest
```

Each says so in its log: *instance a1b2…: sharing Postgres and Redis with other instances*. An instance with a different master key refuses to start rather than fail later on every secret.

## What the instances share

- **Everything stored:** keys, providers, models, gates, zones, approvals, flights, the Ledger, budgets, alerts, views.
- **Changes, at once:** a key, gate or server added, changed or removed through one instance is live on all of them straight away — a key made through one works through another on its next request.
- **Rate limits,** exactly: a key's 10 requests a minute are 10 across all instances, and its concurrency limit too. If Redis can't be reached, each instance limits on its own until it can.
- **Budgets:** spend through every instance counts against the one budget. Instances exchange spend every 3 seconds, so a hard budget can be overshot by what is spent in those seconds.
- **Approvals:** a call held by one instance is released the moment a person decides on any instance.
- **The console:** a console connected to any instance sees every instance's live traffic, approvals and alerts, and the map draws all of it.

## What stays with each instance

- **Held calls:** `CT_MAX_HELD` and the 5-per-agent limit on calls waiting for approval count per instance.
- **Alert thresholds** (*N times in M minutes*) count the calls each instance served.
- **Gateway overhead and `/metrics`** are per instance: scrape each one.

## When an instance stops

- **Gracefully** (a deploy, a scale-down): it stops taking new calls, gives calls in flight `CT_SHUTDOWN_GRACE_MS` to finish, hands calls held for approval a ticket to retry with, and records anything still unfinished as stopped.
- **Crashing:** the others notice within 90 seconds that it has stopped saying it is alive, and close out what it left: its unfinished calls are marked stopped, and approvals nobody can come back to are expired.

## Postgres with one instance

`CT_DATABASE_URL` without `CT_REDIS_URL` runs one instance on Postgres — for a database you already back up and monitor. The log says so; add Redis before starting a second one.
