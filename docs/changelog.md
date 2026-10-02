# Changelog

Every release is on [GitHub Releases](https://github.com/joshmaster2165/controltower/releases) and as a container image, `ghcr.io/joshmaster2165/controltower:<version>`. Control Tower is in preview: minor versions may change APIs, and each release notes what to watch for.

## 0.2.8 — 2 October 2026

- **Laptops on Windows: Codex gets Control Tower's MCP tools again.** Codex on Windows no longer reads a per-person `managed_config.toml`, where the install script put Control Tower's MCP server, so Codex there had no Control Tower tools (model calls were unaffected). The script now adds the server to each profile's own `~\.codex\config.toml`, only where it's missing, and to the Default profile for people who sign in later. Found by the new real-machine test, which now checks Codex lists the server; it passes 13 of 13 on Windows and on macOS.

## 0.2.7 — 2 October 2026

- **Docs: [Rolling it out](rollout.md):** the rollout from both sides: who does what (admins, viewers, approvers, team admins, everyone else), what reaches each computer, what an employee sees the first time they open Claude and after, their questions, and a note to send them.
- **Laptops tested on real machines:** a workflow (manual, and weekly) installs the rollout files on Windows and macOS the way Intune and Jamf do, then runs the real Claude Code and Codex with nothing else configured, and checks their calls reach Control Tower as the person who signed in.

## 0.2.6 — 2 October 2026

- **Laptops: sign in with your identity provider.** ct-auth can sign people in to Okta, Entra ID or any OpenID Connect provider directly (its device flow) and hand the tools its ID tokens, which Control Tower checks through a trusted issuer under Agent identity. People need no Control Tower account; the issuer's rules (groups to keys) pick the key, and calls are recorded under the person's email. Choose it under **Laptops › Roll it out**. Tested end to end, refresh and sign-out included.
- **Seats include people signing in with your identity provider.** A trusted issuer can be marked as people (laptops, as opposed to workloads); each person it names uses a seat while seen in the last 30 days, counted once even if they also use single sign-on. When seats are full, a new person's token is refused and everyone else carries on. Workload issuers are unchanged.
- **Docs: [Enforcing the gateway on every computer](enforcement.md):** what each tool's managed settings enforce and what they can't, sign-in either way, blocking provider APIs at the network, and checking every computer (with a Jamf extension attribute).
- Laptop sign-ins can start 120 times a minute from one address (was 20): an office behind one address signs everyone in on rollout day.

## 0.2.5 — 2 October 2026

- **Laptops (Enterprise): Claude Code, Claude Desktop and Codex on people's computers, rolled out by MDM.** IT downloads the files from **Laptops** (a macOS profile and install script for Jamf, Intune or Kandji; an Intune script and registry file for Windows; a Linux script) and deploys them. Each tool then sends its model and MCP calls through Control Tower, signed in as the person. The first time, ct-auth opens **Connect your computer**, where they sign in as usual and approve (the OAuth device flow). Rules pick the key each tool's calls are made as, by team. Tokens last an hour; signing out a computer, or removing the person, applies at once. **Lock down** stops the tools using other providers or MCP servers. Tested with Claude Code and Codex themselves. See [Laptops](laptops.md).
- **Spend by person** in the Ledger: calls by people signed in on their computers, and by workloads presenting an identity provider's token, split by who made them.
- Single sign-on can return to a page other than the console's start (used by **Connect your computer**).

## 0.2.4 — 1 October 2026

- **Licensing:** `POST /admin/api/license/refresh` checks for a renewed key now (after buying more seats, say) instead of at the next daily check.
- **License service, tested end to end against a Stripe sandbox:** a purchase through Stripe Checkout, the key in Control Tower, a renewal, more seats (confirmed from the billing email and charged for the rest of the period), fewer seats (from the next renewal), cancellation, and a renewal whose payment fails, which no longer extends the license. Stripe's API version is pinned.
- **A renewal is issued only once it's paid.** Stripe moves a subscription to its next period about an hour before it charges the card. A server that checked in that hour was given the next period even if the payment then failed. The license service now waits for the renewal invoice to be paid, and seat changes need it paid too.
- **A refunded or immediately cancelled subscription ends the license then**, not at the end of the period paid for (then the usual 14-day grace period). Servers that reach the license service pick this up at their next check.
- **Seats:** with each renewal check, a server reports how many people use seats (a number). Seats can't be reduced below it. When more people use seats than the license has, the console says so.
- **Renewal checks:** daily as before, and hourly from a day before the end date until the renewal arrives.
- **Several servers on one database:** a license added, removed or renewed through one now applies on the others at once (it applied only after a restart).

## 0.2.3 — 30 September 2026

- **A clock set back is noticed (Enterprise licensing).** Each server remembers the latest time it has seen; a clock more than two days behind it is shown to admins in the console, recorded once in the audit log and reported with the next online renewal. It's never acted on: licenses keep working. An admin who knows the clock is right says so from the warning. See [Enterprise](enterprise.md).
- **Trial keys are emailed.** A trial asks for a work email and sends a link to the key there (the link works for 24 hours; opening it again shows the same key), so a trial needs a real mailbox. At most two trial emails a day go to one address. The license service reads the caller's address from Railway's `X-Real-IP`, not from `X-Forwarded-For`, which a client can write.

## 0.2.2 — 30 September 2026

- **Security: license keys signed with someone else's key are refused by every release build.** Until now, a server started with `NODE_ENV` set to anything but `production` also trusted a signing key named by `CT_LICENSE_PUBLIC_KEY` (meant for tests), so a self-signed key could turn Enterprise on. Release builds (the image and the npm package) no longer contain that path at all, and CI checks each image refuses a forged key. Upgrade from 0.2.0 and 0.2.1.
- **Trials end on their end date.** The 14-day grace period is for paid licenses while they renew; a trial now has none. Tested on a running server: at a trial's end, every Enterprise feature stops without a restart, passwords work again, and agents' traffic carries on.
- The Enterprise license files name Agent Control Tower as the licensor.

## 0.2.1 — 30 September 2026

- **A home of its own:** the website is now [agentcontroltower.app](https://agentcontroltower.app), and plans, checkout and trial keys are at [license.agentcontroltower.app](https://license.agentcontroltower.app). Servers renew their license from the new address. The old address keeps working, so 0.2.0 servers renew as before.

## 0.2.0 — 30 September 2026

**Control Tower Enterprise.** Everything a company needs to run Control Tower for many teams, in many places: single sign-on with SAML and SCIM, an audit log sent to your SIEM, agents signing in with your identity provider's tokens, secret managers and key rotation, organisations and team admins, request metering, and a multi-region control plane. Enterprise features are under the Elastic License 2.0 in `ee` directories and need a license key; everything else stays Apache-2.0.

To watch for: a new **member** role sees only their teams. Viewers and approvers no longer read token-issuer or secret-manager settings.

- **Multi-region, part 4 (Enterprise): tested across three continents.** A control plane in US West and regions in Virginia (two servers on their own Postgres and Redis), Amsterdam and Singapore. Configuration reaches every region in 1.5–6 seconds, the control plane's console answers across all three in about 0.3 s, and a call held in Singapore is approved from US West. Failure drills: a region's token revoked, a region gone, a region redeployed under traffic, and the control plane gone with a region restarted meanwhile. **Multi-region is now available.** See [Tested across regions](multi-region.md#tested-across-regions).
- **Multi-region, part 3 (Enterprise): global limits and budgets.** An agent's rate limits, a model's limits and a gate's limits count across every region together. A budget is one total, so a hard budget spent in one region stops the agent in all of them. The license's yearly request count includes every region's requests. Regions exchange what they let through and spent with the control plane every 2 seconds, and keep limiting on their own when it's out of reach. Calls at once are still counted per region. See [Limits and budgets across regions](multi-region.md#limits-and-budgets-across-regions).
- **Multi-region, part 2 (Enterprise): one console for every region.** The control plane's Flights, Tower, Airspace (live), Ledger, Flight Recorder and key *last used* include every region's calls, each marked with its region; a call held in a region is decided from the control plane's Tower. Regions answer over a link they open themselves (a long poll, outbound only); nothing they answer is stored on the control plane. Team scopes apply in every region, and a region that doesn't answer is named on the page. Idle-key retirement counts use in every region. See [Multi-region](multi-region.md#one-console-for-every-region).
- **Multi-region, part 1 (Enterprise).** The Control Tower you run can be the control plane for regions: each region is a Control Tower with its own database and Redis that takes its configuration from the control plane — keys, providers (credentials re-encrypted for the region's own master key), models, gates, tool servers, guardrails, exports, token issuers, secret managers, alerts, the license — as signed snapshots, and serves its own agents, whose calls stay in the region. A region keeps serving on the configuration it last received when the control plane is out of reach, even across a restart, and catches up when it's back. A new **Regions** page adds regions and shows whether each is in sync. The console across regions and budgets shared between them come next. See [Multi-region](multi-region.md).
- **Requests a year, metered (Enterprise).** **License** now shows the requests used this license year against the allowance, month by month, with the pace for the year. Every call through the gateway counts, across every instance. At 80% and 100%, a line at the top of the console says so and the audit log records it. Traffic is never slowed or stopped. With each daily key renewal, the year's request count (and nothing else) goes to the license service. Keys now carry when their subscription began, which starts each license year. See [Requests a year](enterprise.md#requests-a-year).
- **Organisations and team admins (Enterprise).** Teams are the `team` label keys carry, given people of their own; organisations group teams under admins of their own. Team admins manage their team's keys (create, change, rotate, disable, delete, limits and budgets) and people; team members decide its agents' held calls; organisation admins do so for every team in the organisation, add teams and set their budgets. A new **member** role sees only their teams, everywhere: keys, Flights, the Tower, the Ledger, the map and its live traffic are filtered on the server, and everything else answers `403`. Team memberships can come from identity-provider groups at each sign-in and SCIM change. A new **Teams** page. See [Organisations and teams](teams.md).
- **Viewers and approvers** no longer read token-issuer or secret-manager settings (admins only, as documented), and the map's gate, zone and setup tools show for admins only.
- **Secret managers and key rotation (Enterprise).** Credentials can stay in AWS Secrets Manager, HashiCorp Vault (token, AppRole or Kubernetes sign-in), Google Secret Manager or Azure Key Vault: anywhere a credential goes, write `secret://<manager>/<path>#<field>`. Values are held in memory only, read again every few minutes (a rotation in the manager reaches Control Tower on its own), and the last value read stays in use if a read fails. AWS, Google and Azure work with static credentials or the role Control Tower runs with (EKS web identity, ECS, EC2, GKE, managed identity). Agents' keys rotate with an overlap for the old secret, now or on a schedule, the new secret written into your secret manager before it's saved. The old secret can be stopped at once. See [Secret managers](secret-managers.md) and [Key rotation](key-rotation.md).
- **`--rotate-master-key`** re-encrypts every stored credential under a new master key in one transaction. See [Key rotation](key-rotation.md#the-master-key).
- **Audit log:** private keys (a pasted service account key, say) are now redacted from recorded requests whatever the field is called.
- **Agent identity: JWT authentication for agents (Enterprise).** Agents can authenticate with tokens from your identity provider instead of a key's secret: Kubernetes service account tokens, GitHub Actions OIDC tokens, and client-credentials tokens from Entra ID, Okta, Auth0 or Google. You trust an issuer, and its rules map a token's claims to the key whose permissions apply; the first match wins. Tokens must be signed with the issuer's published keys (asymmetric algorithms only), name the issuer and Control Tower's audience, be current, and not live longer than the limit you set. Signing keys are found through the issuer's OpenID configuration, fetched from a JWKS URL, or pasted in for air-gapped installs, and follow key rotation. Each call records who presented the token, and a key can refuse its secret and take tokens only. **Try a token** says which key a token would be used as, or why it's refused. See [Agent identity](agent-identity.md).
- **Audit log to your SIEM (Enterprise).** Any export destination can now receive the audit log as well as calls, or instead of them: Splunk (its own source type, and optionally its own index), Datadog (with its standard user, network and event attributes), OpenTelemetry log records, S3 and signed webhooks. Events are sent from the audit log itself, in order, with their chain hashes. A SIEM that's down, or a restart, loses nothing: sending picks up where it stopped. A new destination can start from new events or load the history still kept. With several instances, one sends to each destination and another takes over if it stops. Your SIEM can check the chain without access to Control Tower. See [Audit log to your SIEM](siem.md).
- **Docs and website:** a [pricing page](https://agentcontroltower.app/pricing.html) (open source and Enterprise, with a seat slider and a comparison table), a page mapping the [OWASP Top 10 for LLM applications](owasp-llm-top-10.md) to what Control Tower enforces, and screenshots for single sign-on, SCIM, the audit log, licensing, people, guardrail services and exports. The License page now marks Enterprise features still being built as *coming*.
- **SAML single sign-on and SCIM provisioning (Enterprise).** Identity providers can now be SAML 2.0 as well as OIDC. Control Tower publishes its metadata, and assertions must be signed, addressed to it, current, and answer the sign-in it started, once. Tampered, unsigned, foreign-signed, signature-wrapped, replayed and IdP-initiated responses are refused. With SCIM 2.0, Entra ID, Okta and other providers add, change, deactivate and remove people. Their groups set roles, deactivation signs people out at once, and provisioned people use seats. See [Single sign-on](sso.md#saml) and [SCIM provisioning](scim.md).
- **Control Tower Enterprise:** single sign-on and the audit log are Enterprise features, under the Elastic License 2.0 in `ee` directories, turned on by a license key. The key is checked on your server with no connection needed, so it works air-gapped. Seats cap how many people sign in with single sign-on. An ended license has a 14-day grace period; after it, Enterprise features stop, passwords work again so nobody is locked out, and gateway traffic is never affected. A new **License** page shows it all. See [Enterprise](enterprise.md).
- **Single sign-on:** people sign in to the console through any OpenID Connect provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, …). Their groups there decide their role (admin, approver or viewer) at every sign-in. Sign-ins can be limited to your email domains, and people can be created on first sign-in or only when an admin has added them. **Only single sign-on** turns passwords off, keeping the admin key as the way back in. The sign-in uses PKCE, state and nonce, and ID-token signatures are checked against the provider's keys. Every sign-in and refusal is in the audit log. See [Single sign-on](sso.md).
- **Audit log:** every change made in Control Tower, by a person, the admin key or a script, is recorded with who made it, what it touched and the outcome. So are refused attempts, sign-ins, setup and password changes. Secrets in requests are never recorded. Each event is chained to the one before it by hash, so **Verify** finds any event edited or removed outside Control Tower. Admins browse it under **Audit log** and export it as CSV or JSON Lines. It's kept 365 days (`CT_AUDIT_RETENTION_DAYS`). See [Audit log](audit.md).

## 0.1.8 — 28 September 2026

- **Helm chart:** `helm install controltower oci://ghcr.io/joshmaster2165/charts/controltower` runs one pod on SQLite, or several on Postgres and Redis. Pods run as an unprivileged user on a read-only root filesystem, with health probes, a clean shutdown, an optional ingress and a Prometheus ServiceMonitor. The chart refuses settings that would lose data, such as several pods on SQLite or Postgres without a shared master key. CI installs it on a Kubernetes cluster both ways before every release. See [Kubernetes](kubernetes.md).
- **Signed images:** every image CI publishes is signed with Sigstore cosign (keyless, tied to this repository's workflow) and carries an SBOM and full build provenance, plus GitHub's build attestation. The Helm chart is signed too. See [Verifying the image](install.md#verifying-the-image).
- **Support bundle:** `--support-bundle [file]` writes what someone helping you needs to know: version, settings by name, the database, health and the last day's error counts. It never includes keys, credentials, prompts, hostnames, or the names of agents and people.
- **Support:** [SUPPORT.md](https://github.com/joshmaster2165/controltower/blob/main/SUPPORT.md) says where to get help, and what paid support will include. SECURITY.md lists response targets.

## 0.1.7 — 28 September 2026

- **Security hardening.** Please read before upgrading a server that isn't set up yet:
  - **Setting up needs a setup code.** A server with no admin prints a setup code in its log (and an **Open** link that carries it). The setup page asks for it, so only someone who can read the server's log can claim a fresh server. Set your own with `CT_SETUP_TOKEN`. Only one setup can ever succeed. Setting `CT_ADMIN_KEY` works as before.
  - **Sign-ins are rate-limited:** `CT_LOGIN_RPM`, default 10 a minute per email and 20 per address. Over it, the answer is `429 rate_limited`.
  - **Sessions** are stored hashed, and end after `CT_SESSION_IDLE_MS` unused (default 12 hours). Cookies are `Secure` over https.
  - **Security headers:** the console and admin API send a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, and HSTS over https.
  - **Less said to strangers:** without signing in, `/admin/api/status` gives only whether setup is done, `/readyz` only `ok` and `shutting_down`, and `/health/readiness` no version. The details need the admin key. Someone still signed in with a one-time password can read nothing until they choose their own. Unexpected errors return a request id instead of the internal message.
  - The console's live connection refuses pages from other sites.
  - **Approvals are bound to the prompt.** An approved call can be retried only with the prompt that was approved, not with another under the same ticket.
  - **Each agent gets its own session** with each MCP tool server. One agent's upstream session is never used for another's calls.
  - **A2A push notifications** refuse every IPv6 form of a private address (IPv4-mapped, NAT64, 6to4, Teredo and more), and the address is checked again at delivery.
  - **Config imports** through the console or the admin API can't read the server's own secrets (its database and Redis URLs, master key, passwords) from the environment. A `--config` file loaded at start still can.
  - **The container image** keeps its app files read-only to the user it runs as; only `/data` is writable.

- **People and roles:** admins add people to the console as **admin**, **approver** (sees everything, decides approvals) or **viewer** (sees everything, changes nothing) — enforced by the server. New people and password resets get a one-time password to replace at first sign-in; a new role or password ends their sessions. Everyone can change their own password. See [People and roles](people.md).
- **Guardrail services:** inspect gates can ask Presidio, Lakera Guard, Amazon Bedrock Guardrails, Azure AI Content Safety (with Prompt Shields), OpenAI moderation (through a connected provider) or a signed URL of your own, alongside the built-in detectors. Findings get the gate's action; Presidio and your own URL can mask exactly. A new **Guardrails** page adds and tries them. See [Guardrail services](guardrails.md).
- **Exporting flights:** every call can be sent, as it completes, to OpenTelemetry (spans that join the agent's own trace through `traceparent`, or log records, with GenAI attributes), Datadog, Splunk, an S3 archive (gzipped JSON Lines) or a signed webhook — as metadata, never prompts or answers. Batched, retried and bounded, with delivery shown per destination. See [Exporting flights](exports.md).
- **Model health checks:** models are checked in the background (`CT_MODEL_HEALTH_INTERVAL_S`, every 5 minutes). A model whose provider stops answering, or that its provider no longer offers, shows in red on the map and in **Needs attention**, raises health alerts even with no traffic, and is tried last by its aliases. **Check** runs a real one-token call now. See [Health checks](providers-and-models.md#health-checks).
- **Response caching (opt-in):** a model can keep its answers for identical requests — per agent, or shared — in memory or Redis. Consulted only after gates and inspection; cached answers cost nothing and are marked in Flights. See [Caching answers](providers-and-models.md#caching-answers).
- **Retries and fallback models:** an alias (or a model called by its own name) can retry the same deployment on rate limits, timeouts and server errors, and fall back to other models when a prompt is too long for the model, when a provider refuses the content, or when everything else has failed. Deployments a prompt can't fit are skipped before the call. Fallbacks stay within the key's allowed models and your gates. See [When a call fails](providers-and-models.md#when-a-call-fails-retries-and-fallback-models).
- **A deployment's own limits:** requests and tokens per minute and calls at a time, across every agent; a call over them goes to the next deployment.
- **Regions and tags:** keys can be held to regions (`eu-*`) so their data is only ever served there; deployments have a region (or take their provider's) and can be reserved for requests carrying a tag.
- **Tags and customers:** `x-ct-tags` and `x-ct-customer` on a request (or its `user` field) are recorded on every flight. The Ledger shows spend by tag and by customer; customers can be blocked or given budgets.
- Config files now import `context_window_fallbacks`, `content_policy_fallbacks`, `default_fallbacks`, `num_retries`, `retry_policy`, and each model's `rpm`, `tpm`, `max_parallel_requests`, `region_name`, `tags`, `timeout` and `max_input_tokens`.
- **Images, audio and providers' own APIs:** `/v1/images/*`, `/v1/audio/*`, `/v1/moderations`, `/v1/rerank` and `/v1/completions` pass through to OpenAI-wire providers, and agents built on Google's Gen AI SDK or the AWS SDKs reach Gemini and Bedrock through `/gemini` and `/bedrock`. Each call is a flight with the agent's key, limits, budgets, gates and inspection, billed on what it made: images by quality and size, characters spoken, seconds of audio, searches, or tokens by modality where the provider reports them. See [Images, audio and providers' own APIs](model-apis.md).
- The price table is refreshed, and now carries image, speech, transcription, rerank and moderation prices.
- **Several instances:** Control Tower can keep its data in **Postgres** (`CT_DATABASE_URL`) instead of SQLite, and several instances can share it behind a load balancer, kept in step over **Redis** (`CT_REDIS_URL`): changes made through one are live on all at once, rate limits and budgets are shared, an approval decided on any instance releases the call held on another, and every console sees every instance's traffic. When an instance crashes the others close out what it left. `--copy-to-postgres <url>` moves an existing install's data across. See [Running several instances](scaling.md).
- The Docker image and the npm package include the Postgres driver: images built from `main` since Postgres support was added failed to start. CI now starts each image, on SQLite and on Postgres with Redis, before publishing it.
- Budgets write what was spent since the last write rather than the whole total, and reset once when a period rolls over — correct with one instance, and needed for several.
- **A2A push notifications come through Control Tower:** when a caller asks an agent for push notifications, the agent is given a Control Tower address and a token of its own. Each notification is recorded (`<slug>__PushNotification`, under the call that set it up), gated, inspected and delivered to the caller's webhook with the caller's own token or credentials; the agent never sees the webhook. Deliveries go only to public addresses (`CT_PUSH_ALLOW_PRIVATE=1` allows private ones); `CT_A2A_PUSH_RELAY=off` sends them straight to the webhook as before. See [Push notifications](a2a.md#push-notifications).
- **The map stays fast at any volume:** the Airspace, the data-flow export and the lists of HTTP routes and A2A methods now count from an hourly traffic summary (per agent, destination, tool, chain and gate) instead of every call of the last day. At 2.5 million calls a day the map's data takes 14 ms instead of 1.7 s. The last 24 hours now means the last 24 hours to the hour. Existing calls are summarised when you upgrade.
- **Hide idle destinations too:** **Show: Used today / Active (15 min)** on the Airspace (was **Agents**) now also leaves off models, tool servers, A2A agents, HTTP APIs and observed systems that nothing called in that window, so the map shows what is really in use on both sides. A destination that gets a call comes back on its own. See [Hide idle agents and destinations](airspace.md#hide-idle-agents-and-destinations).
- **MCP progress reaches the client:** a tool call that asks for progress (a `progressToken`) is answered as a stream: the tool server's progress notifications as they come, then the result. While the call waits for approval, the client hears *Waiting for a human to approve this call in Control Tower* every 5 seconds. Where an inspect gate reads a tool's replies, progress carries numbers only.
- **Stops and crashes leave nothing running:** a call still in flight when a graceful stop's grace period ends is recorded as stopped (`shutdown`), and after a crash Control Tower closes out, at start, the calls that were left without an outcome and the approvals of held calls no agent can come back to.
- Fixed: an A2A message could ask the agent for push notifications itself (`configuration.taskPushNotificationConfig`) and so get past a gate on `<slug>__CreateTaskPushNotificationConfig`. A message carrying a push configuration now passes the same allow-list and gates as the setup call.

## 0.1.6 — 27 September 2026

Approvals that keep up with busy agents, a map that shows only what is really in use, and agent chains tested end to end — with four agent frameworks (the OpenAI Agents SDK, LangGraph, the Claude Agent SDK and CrewAI), streaming, 16-minute chains, failures in the middle of a chain, eight agents deep and under load. That testing found three bugs, fixed here.

### Approvals

- **Approve the next N calls:** **Approve more…** on an approval card approves the call and lets the agent make the next 1–1,000 calls of the same kind — to the same target, through the same gate — for up to an hour, with any arguments or only the ones on the card. **Approved ahead** on the Tower lists open windows with what is left, and **End now** closes one; editing the gate closes its windows. See [Approve the next N calls](airspace.md#approve-the-next-n-calls).
- **Approvals for chained calls say whom they are for:** a held call an agent makes on another agent's behalf shows *For orchestrator-agent → planner-agent* on its card, in the Tower's history and in held alerts. The same call made for two different agents is two cards, and an approval window opened for one chain doesn't cover another.
- The Tower's countdown follows the gate's real hold time (it assumed 20 seconds), and its decisions table scrolls instead of overlapping on narrow screens.

### Agents that come and go

- **Hide idle agents on the Airspace:** **Agents: All / Used today / Active (15 min)** in the map controls draws only the agents that have made a call in that window. A chip counts the hidden agents and brings them back with **Show all**; a hidden agent that makes a call reappears on its own. See [Hide idle agents](airspace.md#hide-idle-agents-and-destinations).
- **Expiring keys leave the map:** keys can be created with an expiry for short-lived sub-agents, and an expired key is no longer drawn (its history stays in Flights and the Ledger).
- **Retire idle keys:** **Retire keys unused for 7 / 30 / 90 days** expires keys that have done nothing for that long. The Keys page filters **Used today**, **Idle 7+ days**, **Never used** and **Expired**, with **Disable all** and **Delete all** for each list. See [Agents that come and go](keys.md#agents-that-come-and-go).

### Gates and inspection

- **Allow with limits works:** the gate lets calls through within `config.limits` — `rpm` and `tpm` per agent on its path, and `max_tokens` capping a model's reply — and answers `429 rate_limit_exceeded` naming the gate over the rate. It was accepted before but let everything through. The gate editor offers it, with the three limits.
- **Inspect gates can ask a model:** *Also ask a model* on a prompt-injection gate sends the content to a model you choose, through Control Tower under a system key (**guardrail**), to catch paraphrased, translated or disguised injections the patterns miss. `config.model_check: { model, on_error }` in the API and policy files. See [How inspection works](airspace.md#how-inspection-works). The gate editor accepts an inspect gate that only asks a model.

### Fixes

- **MCP health checks no longer cut off tool calls:** the check that runs every minute reset the session live calls share, so a tool call in flight at that moment could fail with *no response for tools/call*. Checks now use a session of their own. Found when LangGraph drove a chain through Control Tower.
- **A2A failures are recorded as failures:** a reply that reports the task failed or rejected — well-formed JSON-RPC, so it looked like success — is now an error flight (`agent_task_failed`, `agent_task_rejected`) with the agent's message, for plain and streamed replies.
- **A2A health checks ask the endpoint,** not only the card: an agent whose card is fine but whose endpoint is gone shows as down, with the reason, and a call that finds the endpoint broken checks it again.
- The Codex CLI guide's terminal screenshots are re-recorded with Codex CLI 0.157.

### Upgrading

- Two database migrations run on start (approval windows, and the chain an approval window covers); nothing to do.
- An A2A agent whose endpoint doesn't answer a JSON-RPC `GetTask` (or `tasks/get` for 0.3) for a task that doesn't exist — any JSON-RPC reply counts, an error included — now shows as down. Check **A2A agents** after upgrading.
- In `POST /admin/api/approvals/<id>/decide`, `window.uses` is the number of calls allowed *after* the ones on the card, and a window now lets new calls through without a ticket.
- Identical held calls made for different agents no longer share one approval card.

## 0.1.5 — 25 September 2026

Agents calling agents, end to end: over MCP, HTTP and the A2A protocol, every call is linked to the call that led to it, gated on whom it is for, and charged to the agent that started the chain. Also: remote A2A agents behind the gateway, MCP resources and prompts as flights, and an Airspace that stays readable with a large fleet.

### Agents calling agents

- **Spend rolls up to the agent that started a chain:** a model call made on another agent's behalf is charged to its own budgets and the origin agent's (key, team, project). The inventory shows whom each path's calls were for and what was spent for each agent; new metrics `controltower_delegated_requests_total` and `controltower_delegated_spend_usd_total`.
- **Delegation tokens can be renewed** for tasks that outlast them: `POST /v1/delegation/renew` gives the agent a fresh token for the same chain, for up to 24 hours from the first.
- **Agent loops stop at the first repeat:** a call to an agent already earlier in the chain (A → B → A) is refused with `delegation_loop` and recorded, instead of going round until the chain is 8 agents deep.
- **Arcs on the Airspace open the calls behind them:** click an arc between two agents to see each call, what it led to, and a trace into Flights.
- **Agents calling agents:** a tool server or HTTP API can [front an agent](agent-to-agent.md); calls to it carry a signed delegation token the called agent passes on, so its calls are recorded — and can be gated — as made on the caller's behalf (`match.on_behalf_of`). Keys can be limited to acting on behalf of others. Flights show whom a call was for; the Airspace draws an arc from caller to callee.
- **Chains of calls in Flights:** each call records the call that led to it (`parent_flight_id`). Click an agent in a *for …* chain to see everything done for it, or **trace** to see one chain in call order, from the call that started it. API: `GET /admin/api/flights?for=<agent id>` and `?trace=<flight id>`; see [Agents calling agents](agent-to-agent.md#step-4-see-it).
- Refused delegated calls (`delegation_required`, `delegation_too_deep`) are recorded as rejected flights with their chain. A token an ordinary key presents that doesn't hold (expired, issued to another agent) is ignored, and the flight is flagged *delegation token ignored*.
- Fixed: gates that list `tools` apply only to tool calls, and gates that list `models` only to model calls, even with target `any`. Such gates used to hold every model call too.

### A2A

- **A2A agents:** Control Tower stands in front of [remote agents that speak A2A](a2a.md) (1.0 and 0.3, JSON-RPC). Register one by its Agent Card; callers use the card Control Tower publishes at `/a2a/<slug>/.well-known/agent-card.json` and their own key. Every message and task call is a flight, on the map as a destination with a row per method, and open to gates (`<slug>__SendMessage`), approvals and inspect gates; the agent is sent a delegation token so its own calls count as made on the caller's behalf. The key's **Connect** panel has an **A2A agents** tab. Tested with the official A2A JavaScript SDK on both sides, including its 0.3 compatibility client.
- **A2A hardening:** approvals for A2A calls work (the approval is bound to the message, so a retry is no longer a scope mismatch); streams end when the client leaves or the agent goes silent; replies are capped at 10 MB and cards at 1 MB; an agent's credentials are only sent to the origin that serves its card; without an **Agent ID** an A2A agent is a destination only and gets no delegation token.

### MCP

- **MCP resources and prompts are flights:** reading a resource and getting a prompt on `/mcp/<slug>` are recorded, gated (`<slug>__resources/read`, `<slug>__prompts/get`), inspected and carry delegation tokens; lists follow the key's `allowed_mcp`. They used to pass through unrecorded.
- Fixed: Codex in the ChatGPT desktop app lost its MCP tools on models reached through translation (Claude, Gemini, Bedrock, Vertex AI). Codex now sends each MCP server's tools as a group (a `namespace` tool); they are passed to the model as `<namespace>__<tool>` and its calls go back in Codex's shape.

### Airspace and console

- Fixed: a connection used for the first time while the console showed another page had no line on the Airspace until a later refresh; the map now refreshes when it opens and when a new connection appears.
- The map lays stations out below the top bar however many rows it wraps to.
- **Airspace top bar:** counters, actions and map controls share one left edge and wrap as groups on narrow screens.
- **Agent groups:** keys that share an [agent ID](keys.md#many-copies-of-one-agent) are one station on the map with a ×N count, and a gate or zone on it covers every copy (`match.groups`, `group:` members in policy files). The key form has an **Agent ID** field.
- Fixed: a newly created key's Connect panel showed the previous key's "Connected" status.
- **Matrix:** [every agent against every destination](airspace.md#matrix-every-agent-against-every-destination) — volume, live connections and which ones no gate can stop — with a click on any cell to gate that path.
- **Flows:** line thickness on the Airspace is volume — calls per minute on live lines, the last day's calls on idle ones — so where traffic goes reads at a glance at any fleet size. Live lines no longer pulse; the map redraws only when something changes (about 5 times a second under load, was every frame).
- **Attention:** [what needs a person](airspace.md#what-needs-attention) on the map — holds, blocks, direct provider calls, failing destinations, destructive tools with no gate, new connections and traffic spikes — plus the busiest stations, with everything else dimmed. Control Tower now records each connection's first and last use (kept 90 days after last use).
- **Views:** [named parts of the organization](airspace.md#views-one-part-of-the-organization-at-a-time) — Engineering, Marketing — each with a map, counters and approvals of its own, listed under Airspace. API: `/admin/api/airspace/views`.
- **Lighter map data:** the topology the map loads is summed per agent and team, drops unused per-key rows and is gzipped: 1.3 MB → 55 KB on the wire at 1,500 agents. The last minute of traffic it seeds the map with is now complete at any rate (it was capped at 2,000 calls).
- **Teams view and search:** with a large fleet the Airspace starts with [one station per team](airspace.md#large-fleets-teams-agents-and-search); open a team to see its agents, or switch to **Agents**. **Find** (or <kbd>/</kbd>) jumps to any team, agent, key, model, tool server or tool. Gates on a team (`match.teams`) cover every key in it; zones take `team:` members.
- **Large fleets:** the Airspace stays live with 1,500 agents at 300 requests a second. The console's live updates are a summary a second plus the full events of held, denied and failed flights — about 4 KB/s per open console at 300 calls a second (was 350 KB/s, and the browser fell behind) — and the map lays out large fleets without stalling. `pnpm load:fleet` drives a fleet against your own server and reports gateway overhead and map performance; see [Monitoring](monitoring.md#load-testing).
- The sign-in page shows an animated air-traffic scene (still with reduced motion), and the empty Airspace says what to do without covering the hub's label.

### Gateway, routing and clients

- **Codex and the Agents SDK on any model:** `/v1/responses` calls for models without a Responses API — Claude, Gemini, Bedrock, Vertex AI — are translated through Chat Completions and back, streamed or not, including tool calls and Codex's free-form tools. They used to be refused.
- **Client setup guides:** step-by-step pages with screenshots for [Claude Code](client-claude-code.md), [Claude Desktop](client-claude-desktop.md), [Codex in the ChatGPT desktop app](client-codex-desktop.md) and the [Codex CLI](client-codex-cli.md). The key's **Connect** panel has **Claude Desktop** and **Codex** tabs with the settings filled in.
- `/v1/models` answers in both the OpenAI and the Anthropic list shape, for Anthropic clients such as Claude Desktop's model picker.
- **Outbound proxy:** `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` route Control Tower's own calls to providers, MCP servers, HTTP APIs and alert channels through a corporate proxy.
- Fixed: weighted aliases pick only among the deployments with the best priority, so fallbacks are only tried when those fail. Config files with `settings.fallbacks` used to send half the traffic to the fallbacks.
- Fixed: least-cost aliases (`cost-based-routing`) order deployments by the price of a typical call, unknown prices last. They used to keep the listed order.
- Fixed: a model first used pinned (`openai/gpt-4.1-mini`) now also answers to its bare name (`gpt-4.1-mini`).
- Fixed: without `CT_PUBLIC_URL`, the approval link in a held call's error uses the port the server listens on; it always said 4000.
- Fixed: `/v1/models` answers `401 key_expired` or `key_disabled` like every other route, not `invalid_api_key`.
- Fixed: the policy JSON export (`?format=json`, `{doc, warnings}`) can be imported as it is.

## 0.1.4 — 25 September 2026

- **Flight Recorder:** [replay](airspace.md#flight-recorder-replay-past-traffic) the last hour, day or week on the map at up to 10,000×.
- **Data retention:** flights are kept 30 days (`CT_RETENTION_DAYS`), event trails 7 days; daily spend history is kept.
- Docs: [Architecture](architecture.md), [API reference](api.md), [Troubleshooting](troubleshooting.md).

## 0.1.3 — 24 September 2026

**Fix**
- The demo approver decides only demo agents' requests. It used to auto-decide every held request while the demo fleet ran — including a real agent held by a real gate. Upgrade if you run the demo beside a real setup.

**New**
- [Email approvals](alerts.md#approving-by-email): an Email alert channel; held requests arrive as *[Approval needed]* emails with a **Review & approve** button that opens the request in the console.
- [Team and project budgets](keys.md#team-and-project-budgets) on the Ledger, counting what was already spent this period.
- [`--policy`](policy-as-code.md#at-startup-gitops): apply a policy file at every start (merge, or replace with `CT_POLICY_MODE=replace`).
- This documentation site, and a [Railway](install.md#railway) deploy guide.

**Improved**
- Traffic from just before the map opened shows as active; native controls follow the console's light theme; several overflow and overlap fixes; a warning when `/data` isn't on a volume.

## 0.1.2 — 24 September 2026

**Security**
- One key check everywhere: the MCP gateway accepted expired keys, and model listing, key info and token counting accepted blocked or expired ones.

**New**
- [OpenAI Responses API](connect-agents.md#openai-agents-sdk-and-codex-responses-api) (`/v1/responses`) through the full pipeline — the OpenAI Agents SDK and Codex work with `OPENAI_BASE_URL`.
- [Policy as code](policy-as-code.md): export zones and gates as YAML, import with a preview.
- [Config file](config-file.md) applied at every start with `--config`, the [admin key](configuration.md#admin-key), the [key](keys.md#key-management-api) and model management APIs, SDKs pointed at the bare origin, Azure-style routes, health probes, `count_tokens`, wildcard models, MCP auth and Slack alerting from the config.

**Improved**
- A recording of the console in the README; username sign-in; built-in keys stay off the map until used.

## 0.1.1 — 23 September 2026

- **Five-minute setup:** a *Get started* guide, models added on first use, a Connect panel per key with a live "connected" check, clear startup output.
- **Demo on a switch** from the console, refusing to start when your setup uses its names.
- **Run it anywhere:** Render and Fly.io configurations; the image honours `PORT` and fixes root-owned volumes.
- **HTTP gateway** for plain REST APIs at `/http/<slug>`.

## 0.1.0 — 23 September 2026

The first public preview: the OpenAI-compatible and Anthropic gateway with the major providers, the MCP tool gateway, the live Airspace, gates (allow, deny, approval, limits, inspect), approvals with hold → ticket → grant (also from Slack), inspect gates for secrets, personal data and prompt injection, simulation against recorded traffic, observed traffic via `/v1/observe` and OpenTelemetry, the data-flow inventory, cost and budgets, alerts, Prometheus metrics, and demo mode.
