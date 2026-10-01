# Getting help with Control Tower

## Community (free)

- **Questions, ideas and bugs:** [open an issue](https://github.com/joshmaster2165/controltower/issues/new/choose). For a bug, include the version, how you run it, what you expected and what happened.
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

Community help is best effort, from the maintainers and other users.

## Enterprise support

Included in every [Control Tower Enterprise](docs/enterprise.md) subscription, for the teams running it in production.

- **Where:** email to support@agentcontroltower.app, or a shared Slack or Teams channel.
- **When:** Monday to Friday, 9:00–18:00 US Eastern time, outside US public holidays.
- **A named contact**, who knows your deployment.
- **Onboarding:** a call to review your deployment and configuration, when you start and after a major change.
- **Upgrades:** release notes before each release, and help planning upgrades.
- **Security advisories** before public disclosure.

### How quickly we respond

| Severity | Example | First response |
|---|---|---|
| **1 — Production down** | Agents' calls fail, or nobody can sign in | Within 4 business hours |
| **2 — Seriously impaired** | A feature you depend on is broken and there's no workaround | Within 1 business day |
| **3 — Everything else** | Questions, minor bugs, requests | Within 2 business days |

These are targets for a first response from someone who can act on the problem, measured in support hours. A fix may take longer; we'll keep you updated until it's resolved. You set the severity when you write; if we see it differently, we'll agree it with you.

Larger deployments can ask for 24/7 cover for production-down problems and response-time commitments with service credits: write to sales@agentcontroltower.app.

## What to include

A **support bundle** answers most first questions. It covers the version, settings (by name only), the database, health, and the last day's error counts. It never includes keys, credentials, prompts, answers, hostnames, or the names of your agents and people. Run it where Control Tower runs:

```bash
docker exec <container> node dist/server.mjs --support-bundle > support-bundle.json
```

```bash
kubectl exec deploy/<release>-controltower -- node dist/server.mjs --support-bundle > support-bundle.json
```

Read it before you send it. Add what you did, what you expected, and what happened, including the `x-ct-flight-id` of a failing call if there is one.

## Versions

Control Tower is in preview. Fixes, security fixes included, go into the latest release and `main`. Enterprise support covers the latest release and the one before it. Upgrade to the latest release before reporting a problem, if you can. A longer support window per version will come with 1.0.
