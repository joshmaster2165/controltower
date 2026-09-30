# Enterprise

Control Tower is free and open source, and everything else in these docs works without a license. **Control Tower Enterprise** adds identity, compliance and scale features for companies, with support, and needs a license key.

## What's included

| Feature | Status |
|---|---|
| [Single sign-on](sso.md) over OIDC and SAML 2.0, with roles from your identity provider's groups | Available |
| [Audit log](audit.md): every change and refused attempt, hash-chained, exportable | Available |
| [SCIM provisioning](scim.md): your identity provider adds, changes, deactivates and removes people, and its groups set roles | Available |
| [Audit log to your SIEM](siem.md): Splunk, Datadog, OpenTelemetry, S3 or a webhook, in order, with nothing lost while the SIEM is down | Available |
| [Agent identity](agent-identity.md): agents authenticate with tokens from your identity provider (Kubernetes, GitHub Actions, Entra ID, Okta, Auth0, Google) instead of keys' secrets | Available |
| Secret managers (AWS, GCP, Azure, Vault) and key rotation | Coming |
| Organisations and team admins | Coming |
| Multi-region control plane | Coming |
| Self-hosted, air-gap available | Available: licenses are checked on your server, with no connection needed |
| 24/7 support with SLAs, dedicated support and onboarding | See [support](https://github.com/joshmaster2165/controltower/blob/main/SUPPORT.md) |
| Annual request capacity and volume discounts | In the license. Usage against it is shown; traffic is never stopped |

Features marked *Coming* are part of Enterprise when they ship; a license covers them without a new key.

## Licensing

A license key starts with `ctl1.` and says whom it is for, the plan, the seats, the requests a year included, the features, and the end date. It is signed by the licensor, and Control Tower checks the signature on your server against a public key built into each release. That check needs no connection, so it works air-gapped. A changed key, or one signed by anyone else, is refused.

Add the key in the console under **License**, or set `CT_LICENSE_KEY` on the server (it then can't be changed in the console).

![Adding a license key](images/license-add.png)

![The License page: who it's for, seats, requests a year, the end date, and what it turns on](images/license.png)

 Every instance sharing a database reads a key added in the console. With `CT_LICENSE_KEY`, set it on each instance.

**Seats** are the people who sign in with single sign-on or are provisioned by SCIM. Someone who already signs in that way never counts twice. When all seats are taken, new people are refused at sign-in with a clear message; people already signed in aren't affected. People with passwords don't use seats.

**Requests a year:** the console shows usage against the allowance. Going over is a conversation at renewal. It never slows or stops traffic.

## When a license ends

| When | What happens |
|---|---|
| 30 days before the end date | A banner in the console says when it ends |
| After the end date | A **14-day grace period**: everything keeps working, with a banner, while it renews |
| After the grace period | Enterprise features stop. Single sign-on is no longer offered, and **passwords work again** even if you'd turned them off, so nobody is locked out. The audit log stops recording, and you can read it again once a license is added. Gateway traffic, gates, approvals and everything open source carry on as before |

Adding a renewed key brings everything back, with the audit log's history and single sign-on settings as they were.

Without a license, each Enterprise feature says so where it would be:

![The audit log without a license](images/enterprise-notice.png)

## Buying and trying

- **Free trial:** 30 days, 5 seats, no card.
- **Enterprise:** a yearly subscription per deployment. The base plan includes 5 single sign-on seats and 100 million requests a year. Add seats as you grow: seats 6–25 and seats 26–100 each have their own price, and the per-seat price drops for the larger block. Monthly billing is available at a higher rate.
- **More than 100 seats, or over a billion requests a year:** contact sales for volume pricing.

Plans, checkout and trial keys are at the **[license service](https://license-production-9780.up.railway.app)** (also linked from **License** in the console). The key is shown as soon as payment completes. Once a day, a server that can reach the license service picks up a renewed key by itself: after each renewal, and when seats change. Air-gapped servers set `CT_LICENSE_SERVER=off`, and their key keeps working until its end date.

## API

| Method | Path | |
|---|---|---|
| GET | `/admin/api/license` | The license in force: `status` (`none`, `valid`, `expiring`, `grace`, `expired`, `invalid`), who it's for, seats and seats used, requests a year, features, end date. Never the key itself |
| PUT | `/admin/api/license` | `{key}`: add or replace the key (admins). Refused with a reason if it isn't valid |
| DELETE | `/admin/api/license` | Remove the key added in the console |

Enterprise routes without a license answer `402` with `{"error": {"code": "enterprise_required", "feature": "sso", …}}`.
