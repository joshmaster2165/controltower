# Security

Control Tower sits between your AI agents and the models, tools and APIs they call. It holds credentials and sees every call, so it's built to be trusted with that. This page is for anyone reviewing it: what leaves your network, how secrets and access are protected, how releases are built, and how to report a problem.

**In short:**
- Control Tower runs on your servers. Your prompts, responses, credentials, call records and users never reach us, and there's no telemetry.
- The only call to us is an optional daily license renewal: the license key and one number. Air-gapped servers turn it off.
- Credentials are encrypted at rest, and agents' keys are stored as hashes.
- Every release is signed, with an SBOM and build provenance you can check.

## Your data stays on your servers

You run Control Tower yourself, with Docker, Kubernetes or Node. Calls go from your servers straight to your providers and tools. Control Tower records them in your own database (SQLite, or your Postgres) and nowhere else.

The only connection to us is the **license renewal** (Enterprise only). Once a day, a server that can reach `license.agentcontroltower.app` sends:
- its license key;
- the year's request count;
- whether its clock was found set back, and by how much.

Nothing about your agents, calls, configuration or people is sent. Set `CT_LICENSE_SERVER=off` and it never calls out. License keys are checked offline, so it works fully air-gapped.

There is no usage telemetry, crash reporting or analytics, in the product or on our website.

## Secrets

- **Encrypted at rest:** provider credentials, tool-server and API credentials, identity-provider secrets, alert channels, guardrail services, export destinations and secret-manager settings are encrypted with AES-256-GCM under a master key you hold (`CT_MASTER_KEY`, or a key file). Each value is bound to its own row and column, so encrypted values can't be swapped between records.
- **Your secret manager:** credentials can stay in AWS Secrets Manager, HashiCorp Vault, Google Secret Manager or Azure Key Vault, referenced rather than copied. Control Tower holds them in memory only. See [Secret managers](secret-managers.md).
- **Kept out of logs:** secrets are never attached to a call record, an event, a log line or an error message, and error bodies from providers are scrubbed of common key formats.
- **Agents' keys** are stored as SHA-256 hashes. Their `ct_sk_` prefix and checksum let secret scanners spot a leaked one.
- **Rotation:** agents' keys rotate on a schedule with an overlap period, and the master key rotates with one command. See [Key rotation](key-rotation.md).
- **Agent identity:** agents can sign in with short-lived tokens from your identity provider instead of long-lived secrets. See [Agent identity](agent-identity.md).

## Access to the console

- **Sign-in:** single sign-on over OIDC or SAML 2.0, with people added and removed by SCIM ([Single sign-on](sso.md), [SCIM](scim.md)). Passwords can be turned off entirely.
- **Passwords**, where used, are stored as scrypt hashes, with sign-in attempts rate-limited per email and per address.
- **Roles:**
  - admins;
  - approvers, who decide held calls;
  - viewers;
  - team members, who see only their teams' agents, everywhere in the console ([Organisations and teams](teams.md)).
- **Sessions:** cookies are `HttpOnly`, `SameSite=Lax` and `Secure`, and stored only as hashes. A session ends after 12 hours idle or 7 days in all, and whenever the person's role or password changes.
- **The browser:** every change needs a CSRF token. The console sends a strict Content Security Policy, refuses to be framed, and sends HSTS over HTTPS.

## Accountability

Every change, refused attempt and sign-in goes into the [audit log](audit.md): who, what, when, from where, and the outcome. Secrets in requests are never recorded. Each event is chained to the one before it by hash, so an edited or deleted event is found by **Verify**. Events are kept 365 days by default and can be sent, in order and without gaps, to Splunk, Datadog, OpenTelemetry, S3 or a webhook ([Audit log to your SIEM](siem.md)).

## What it enforces

Gates, approvals, limits and budgets are enforced inside the gateway, on the call itself, so an agent can't skip a check that Control Tower is in the path for. Calls that go around the gateway can be observed but not stopped, and the console shows them that way. [What is enforced](threat-model.md) lists every guarantee and its limits. [OWASP LLM Top 10](owasp-llm-top-10.md) maps them to the common risks.

## How releases are built

- **Signed:** every image and Helm chart is signed in CI with Sigstore (keyless: the signature names this repository's workflow). Each image carries an SBOM and full build provenance, and GitHub's build attestation names the commit that built it. [Verifying the image](install.md#verifying-the-image) shows how to check all three.
- **Locked down at runtime:** the container runs as an unprivileged user, and the app's own files are read-only to it. Only `/data` is writable.
- **Tested before every release:**
  - type checking;
  - unit tests;
  - end-to-end tests in a browser, on SQLite and on Postgres;
  - tests of several instances sharing a database, and of multiple regions;
  - a Kubernetes install with the Helm chart.

  The image is also attacked with a forged license key, which it must refuse.

## License keys

Enterprise license keys are signed with Ed25519 and checked offline against the public key built into each release. Release builds trust no other key, whatever their environment says. A server whose clock has been set back reports it rather than quietly extending a license.

## Our own services

We run two small services, both on Railway:
- **The website** at agentcontroltower.app: static pages, with no cookies, analytics or tracking.
- **The license service** at license.agentcontroltower.app, which issues and renews keys. It keeps no database. Stripe processes payments, so card details never reach us. Trial keys are sent by Resend.

Our [privacy policy](https://agentcontroltower.app/privacy.html) lists exactly what these services collect, and our [data processing agreement](https://agentcontroltower.app/dpa.html) covers what you send us for support.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub](https://github.com/joshmaster2165/controltower/security/advisories/new). [SECURITY.md](https://github.com/joshmaster2165/controltower/blob/main/SECURITY.md) explains what to include, how quickly we respond, and what counts. Enterprise customers hear about fixes before public disclosure.

## For security reviews

We don't have a SOC 2 report. Because Control Tower runs entirely in your infrastructure, under your own access controls, encryption and monitoring, most of what a review covers is your environment rather than ours.

For questionnaires, or anything this page doesn't answer, write to sales@agentcontroltower.app. Our [terms](https://agentcontroltower.app/terms.html) and [DPA](https://agentcontroltower.app/dpa.html) are public.
