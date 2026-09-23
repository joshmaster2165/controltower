# Security policy

Control Tower sits in the path of your agents' model and tool traffic and holds provider credentials, so we treat security reports as the highest priority.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:
**[Report a vulnerability](https://github.com/joshmaster2165/controltower/security/advisories/new)** (Security tab → *Report a vulnerability*).

Include what you can of:

- the version or commit you tested,
- how to reproduce it (requests, config, or a minimal script),
- what an attacker gains, and any conditions it needs.

This is a young project maintained on a best-effort basis. You will get an acknowledgement as soon as a maintainer sees the report, we will keep you updated while we work on a fix, and we will credit you in the advisory unless you prefer otherwise. Please give us a reasonable window to ship a fix before disclosing publicly.

## What counts

Especially interesting:

- ways to get a call past a gate, approval or inspect rule that should have stopped it (including approving one call and redeeming the grant for a different one),
- reading or exfiltrating stored provider or MCP credentials, API keys or the master key,
- authentication or session flaws in the admin console, CSRF, or privilege problems between API keys,
- secrets or request bodies leaking into logs, flight events, alerts, metrics or exports.

Known, documented limits are not vulnerabilities in themselves — for example, an agent that calls a provider directly instead of through Control Tower is outside the gateway by design (it shows as *observed, not enforced*). See [docs/threat-model.md](docs/threat-model.md) for what is and isn't enforced.

## Supported versions

Only the latest release and `main` receive security fixes while the project is pre-1.0.
