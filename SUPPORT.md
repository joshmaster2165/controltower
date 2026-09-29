# Getting help with Control Tower

## Community (free)

- **Questions, ideas and bugs:** [open an issue](https://github.com/joshmaster2165/controltower/issues/new/choose). For a bug, include the version, how you run it, what you expected and what happened.
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

Community help is best effort, from the maintainers and other users.

## Paid support

For teams running Control Tower in production.

| | Business | Enterprise |
|---|---|---|
| Channel | Email | Email, and a shared Slack or Teams channel |
| First response, production down | TBD | TBD |
| First response, other questions | Next business day | TBD |
| Upgrade help and release notes before release | ✓ | ✓ |
| Deployment and configuration review | | ✓ |
| Security advisories before public disclosure | | ✓ |
| Named contact | | ✓ |
| Price | TBD | TBD |

To ask about paid support: TBD.

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

Control Tower is in preview. Fixes, security fixes included, go into the latest release and `main`. Upgrade to the latest release before reporting a problem, if you can. A longer support window per version will come with 1.0.
