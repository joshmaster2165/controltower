# Compliance: EU AI Act, NIST AI RMF, ISO/IEC 42001

**Compliance** (Enterprise, admins) sets your AI coding assistants and agents against three frameworks, using what Control Tower records: your inventory, each agent's permissions, your gates and approvals, your logs and audit trail. It shows where each requirement stands, says what to do about the gaps, and produces an evidence pack to hand your assessor.

- **EU AI Act**: Regulation (EU) 2024/1689. Record-keeping (Art. 12), human oversight (Art. 14), robustness and cybersecurity (Art. 15), the deployer duties of Art. 26 (oversight by competent people, monitoring, keeping logs at least six months), and the articles that are the organisation's to evidence (AI literacy, impact assessments, transparency).
- **NIST AI RMF 1.0** (NIST AI 100-1): the Govern, Measure and Manage subcategories a gateway gives evidence for, such as the AI system inventory (GOVERN 1.6), roles (GOVERN 2.1), security and resilience (MEASURE 2.7), and deactivation (MANAGE 2.4).
- **ISO/IEC 42001:2023**: monitoring (9.1), internal audit (9.2), and the Annex A controls for roles (A.3.2), resources (A.4.2), operation and monitoring (A.6.2.6), event logs (A.6.2.8), responsible and intended use (A.9.2, A.9.4), and suppliers (A.10.3). ISO's text isn't public, so requirements are described in our own words: check them against your copy of the standard.

This is evidence for an assessment, not a certification or legal advice. Which obligations apply depends on your role (provider or deployer) and your systems' risk class.

## Where each requirement stands

Each requirement is matched to checks computed from this installation's data for the period you choose (30 to 365 days):

| Check | Met when |
|---|---|
| Inventory | Agents and assistants go through Control Tower, and it lists them with the models, tools and people behind them |
| Ownership | Every agent has an owner (Keys) |
| Least privilege | Every active agent is limited to named models and tools |
| Human approval | At least one gate asks a person before an action goes through |
| Approvers | At least two people can approve and intervene; nobody approves their own request |
| Logging | Calls are recorded, with who made them |
| Log retention | Calls are kept at least six months (`CT_RETENTION_DAYS` 183 or more, or 0) |
| Audit trail | The audit log's hash chain verifies |
| Copy outside Control Tower | The audit log is sent to your SIEM |
| Data protection | An inspect gate checks what's sent to models and tools |
| Identity | People sign in through single sign-on |
| Monitoring | Alert rules send to a channel |
| Deactivation | Enforcement is on, so an agent, a laptop or a person can be stopped at once |
| Suppliers | The model providers in use are known, and agents reach no others through Control Tower |

A requirement is **met** when all its checks are, **partly met** when some are, and a **gap** when one is. Requirements no gateway can evidence (an impact assessment, staff training) are shown as **the organisation's**, so the register is complete. Click a requirement for its checks and what to do next.

## The evidence pack

**Evidence pack** downloads a Markdown document (print it to PDF, or paste it into your GRC tool's notes) for the framework and period on screen:

- the register: each requirement, its status and the evidence;
- each requirement in detail, with what to do about gaps;
- the records: every agent with its owner, team and permissions, the apps people used, each agent's paths with requests, refusals and holds, the gates, who approved and denied, the audit chain's verification, retention, single sign-on and alerts.

**JSON** gives the same, for a GRC tool or a script. Each download is recorded in the [audit log](audit.md) (`compliance.evidence_exported`) with who took it and the document's SHA-256 (also in the response's `x-ct-sha256` header), so a copy handed to an assessor can be checked against it.

## API

```
GET /admin/api/compliance?framework=eu-ai-act&days=90
GET /admin/api/compliance/evidence?framework=iso-42001&days=90&format=md|json
```

`framework` is `eu-ai-act`, `nist-ai-rmf` or `iso-42001`. Admins only; it needs an Enterprise license.

## Related

- [Inventory](airspace.md): the data-flow inventory, as CSV, Markdown or PDF, for anyone
- [Audit log](audit.md) and [Audit log to your SIEM](siem.md)
- [Laptops](laptops.md): coding assistants on people's computers, each person signed in
