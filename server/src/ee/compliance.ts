// Control Tower Enterprise — Elastic License 2.0 (see ee/LICENSE).
import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import type { PolicyService } from '../policy/policy.js';
import { BUILT_IN_KEYS } from '../admin/key-lifecycle.js';
import { buildInventory } from '../admin/export.js';

/**
 * Compliance: what Control Tower can show about the AI coding assistants and agents it governs, set against the
 * requirements of the EU AI Act, the NIST AI Risk Management Framework and ISO/IEC 42001.
 *
 * Each requirement is matched to checks computed from this installation's live data (its inventory, its keys and
 * gates, its approvals, logs and audit trail), and an evidence pack collects that data for the period. What no
 * gateway can show (an impact assessment, staff training, a risk policy) is listed as the organisation's, so the
 * register is complete. Requirements are described in our own words: the EU AI Act and the NIST AI RMF are public,
 * ISO/IEC 42001 is not, so for it only clause and control numbers are given. This is evidence for an assessment,
 * not a certification or legal advice.
 */

export type CheckStatus = 'met' | 'partial' | 'gap';
export type RequirementStatus = CheckStatus | 'organizational';

export interface CheckResult {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** One line: what was found. */
  summary: string;
  /** The numbers behind it. */
  facts: Record<string, string | number | boolean>;
  /** What to do about a gap or a partial. */
  next?: string | undefined;
}

export type CheckId =
  | 'inventory'
  | 'ownership'
  | 'least_privilege'
  | 'human_oversight'
  | 'approvers'
  | 'logging'
  | 'log_retention'
  | 'audit_trail'
  | 'audit_offsite'
  | 'data_protection'
  | 'identity'
  | 'monitoring'
  | 'deactivation'
  | 'suppliers';

export interface Requirement {
  /** As the framework numbers it: "Art. 12", "GOVERN 1.6", "A.6.2.8". */
  ref: string;
  title: string;
  /** What it asks, in our words, as it applies to AI assistants and agents. */
  asks: string;
  checks: CheckId[];
  /** What stays with the organisation even where Control Tower provides evidence. */
  note?: string;
}

export interface Framework {
  id: FrameworkId;
  name: string;
  version: string;
  /** Who it applies to and how, in a sentence or two. */
  scope: string;
  requirements: Requirement[];
}

export type FrameworkId = 'eu-ai-act' | 'nist-ai-rmf' | 'iso-42001';

export const FRAMEWORKS: Framework[] = [
  {
    id: 'eu-ai-act',
    name: 'EU AI Act',
    version: 'Regulation (EU) 2024/1689',
    scope:
      'Obligations depend on your role (provider or deployer) and the system\'s risk class; the record-keeping, oversight and logging duties below are written for high-risk systems, and are good practice for any AI that acts on your systems. Article 4 applies to every organisation using AI.',
    requirements: [
      { ref: 'Art. 4', title: 'AI literacy', asks: 'Staff who operate or use AI systems have sufficient knowledge of them.', checks: [], note: 'Training and awareness are the organisation\'s.' },
      { ref: 'Art. 9', title: 'Risk management system', asks: 'Risks are identified and reduced with appropriate measures, throughout the system\'s life.', checks: ['least_privilege', 'human_oversight', 'data_protection'], note: 'Control Tower supplies the measures and their evidence; the risk assessment itself is the organisation\'s.' },
      { ref: 'Art. 12', title: 'Record-keeping', asks: 'Events are logged automatically over the system\'s lifetime, so its use can be traced.', checks: ['logging', 'audit_trail'] },
      { ref: 'Art. 14', title: 'Human oversight', asks: 'People can oversee the system while it is used, intervene, and stop it.', checks: ['human_oversight', 'approvers', 'deactivation'] },
      { ref: 'Art. 15', title: 'Accuracy, robustness and cybersecurity', asks: 'The system resists misuse and attempts to change its behaviour, and is secured.', checks: ['data_protection', 'least_privilege', 'identity'], note: 'Model accuracy is the provider\'s; Control Tower covers how it is reached and used.' },
      { ref: 'Art. 26(1)–(2)', title: 'Deployers: use and oversight', asks: 'Deployers use systems as intended, with oversight assigned to people with the competence and authority for it.', checks: ['least_privilege', 'approvers', 'ownership'] },
      { ref: 'Art. 26(5)', title: 'Deployers: monitoring', asks: 'Deployers monitor operation, and suspend use and report when a risk appears.', checks: ['monitoring', 'deactivation'] },
      { ref: 'Art. 26(6)', title: 'Deployers: keeping logs', asks: 'Deployers keep the logs under their control for at least six months.', checks: ['log_retention', 'audit_offsite'] },
      { ref: 'Art. 27', title: 'Fundamental rights impact assessment', asks: 'Certain deployers assess the impact on people before first use.', checks: [], note: 'The assessment is the organisation\'s; the inventory is a useful input.' },
      { ref: 'Art. 50', title: 'Transparency to people', asks: 'People are told when they interact with AI, and AI-generated content is marked where required.', checks: [], note: 'Applies to what your products show people; not covered by a gateway.' },
    ],
  },
  {
    id: 'nist-ai-rmf',
    name: 'NIST AI RMF',
    version: 'AI RMF 1.0 (NIST AI 100-1)',
    scope: 'A voluntary framework of four functions (Govern, Map, Measure, Manage). The subcategories below are the ones a gateway in front of AI assistants and agents gives evidence for.',
    requirements: [
      { ref: 'GOVERN 1.1', title: 'Legal and regulatory requirements', asks: 'Requirements that apply to AI are understood, managed and documented.', checks: [], note: 'The organisation\'s; this register is part of the documentation.' },
      { ref: 'GOVERN 1.6', title: 'Inventory of AI systems', asks: 'Mechanisms are in place to inventory AI systems, resourced to the organisation\'s risk priorities.', checks: ['inventory', 'ownership'] },
      { ref: 'GOVERN 2.1', title: 'Roles and responsibilities', asks: 'Roles, responsibilities and lines of communication for AI risks are documented and clear.', checks: ['ownership', 'approvers'] },
      { ref: 'GOVERN 6.1', title: 'Third-party policies', asks: 'Policies address risks from third-party AI, including suppliers\' models.', checks: ['suppliers'], note: 'The policy is the organisation\'s; Control Tower shows which providers are used and enforces which may be.' },
      { ref: 'MAP 1.1', title: 'Intended purpose and context', asks: 'Intended purposes, uses and settings are understood and documented.', checks: [], note: 'The organisation\'s; keys can record each agent\'s team, project and owner.' },
      { ref: 'MEASURE 2.7', title: 'Security and resilience', asks: 'Security and resilience are evaluated and documented.', checks: ['data_protection', 'least_privilege', 'identity', 'audit_trail'] },
      { ref: 'MEASURE 2.8', title: 'Transparency and accountability', asks: 'Risks to transparency and accountability are examined and documented.', checks: ['logging', 'audit_trail', 'ownership'] },
      { ref: 'MEASURE 3.1', title: 'Tracking risks', asks: 'Approaches and people are in place to identify and track risks as the system is used.', checks: ['monitoring', 'logging'] },
      { ref: 'MANAGE 2.4', title: 'Disengage or deactivate', asks: 'Mechanisms exist to supersede, disengage or deactivate AI that behaves outside its intended use.', checks: ['deactivation', 'human_oversight'] },
      { ref: 'MANAGE 3.1', title: 'Monitoring third-party AI', asks: 'Risks from third-party resources are regularly monitored, with controls applied.', checks: ['suppliers', 'monitoring'] },
      { ref: 'MANAGE 4.1', title: 'Post-deployment monitoring', asks: 'Monitoring after deployment is in place, with ways to capture and act on what it finds.', checks: ['monitoring', 'logging', 'log_retention'] },
    ],
  },
  {
    id: 'iso-42001',
    name: 'ISO/IEC 42001',
    version: 'ISO/IEC 42001:2023',
    scope: 'An AI management system standard. Below, the clauses and Annex A controls a gateway gives evidence for, described in our own words; check them against your copy of the standard.',
    requirements: [
      { ref: '6.1', title: 'AI risk and impact assessment', asks: 'AI risks are assessed and treated, and the impact of AI systems is assessed.', checks: [], note: 'The assessments are the organisation\'s; gates and guardrails are treatments they can point to.' },
      { ref: '9.1', title: 'Monitoring and measurement', asks: 'What is monitored and measured is decided, and the results are kept.', checks: ['monitoring', 'logging'] },
      { ref: '9.2', title: 'Internal audit', asks: 'Internal audits are carried out, with evidence retained.', checks: ['audit_trail', 'audit_offsite'], note: 'The audit programme is the organisation\'s; this is the evidence it reviews.' },
      { ref: 'A.3.2', title: 'AI roles and responsibilities', asks: 'Roles and responsibilities for AI are defined and allocated.', checks: ['ownership', 'approvers'] },
      { ref: 'A.4.2', title: 'Resource documentation', asks: 'The resources AI systems use (tools, data, models, systems) are identified and documented.', checks: ['inventory', 'suppliers'] },
      { ref: 'A.5', title: 'AI system impact assessment', asks: 'The impact of AI systems on people and society is assessed and documented.', checks: [], note: 'The organisation\'s.' },
      { ref: 'A.6.2.6', title: 'Operation and monitoring', asks: 'AI systems are operated and monitored as intended, with the ability to intervene.', checks: ['monitoring', 'human_oversight', 'deactivation'] },
      { ref: 'A.6.2.8', title: 'Event logs', asks: 'AI systems record event logs, and the logs are kept.', checks: ['logging', 'log_retention', 'audit_trail'] },
      { ref: 'A.9.2', title: 'Responsible use', asks: 'Processes for the responsible use of AI systems are defined and followed.', checks: ['least_privilege', 'human_oversight', 'data_protection'] },
      { ref: 'A.9.4', title: 'Intended use', asks: 'AI systems are used only as intended.', checks: ['least_privilege', 'identity'] },
      { ref: 'A.10.3', title: 'Suppliers', asks: 'Suppliers of AI (models, services) are chosen and managed so their use stays responsible.', checks: ['suppliers'] },
    ],
  },
];

export const frameworkById = (id: string) => FRAMEWORKS.find((f) => f.id === id);

const DAY = 86_400_000;
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** An allow-list that lets everything through: one with `*` in it (an empty list allows nothing). */
const unrestricted = (list: string[]) => list.includes('*');

/** The checks, computed from this installation's data for the last `days` days. */
export async function runChecks(ctx: AppContext, days: number): Promise<{ checks: Record<CheckId, CheckResult>; evidence: Evidence }> {
  const since = Date.now() - days * DAY;
  const policy = ctx.policy as PolicyService;
  const db = ctx.db.read;
  // Everything in the installation, demo data too (its traffic is in the logs as well): the pack says so when present.
  const keys = [...ctx.registry.keysById.values()].filter((k) => !BUILT_IN_KEYS.has(k.id));
  const demo = keys.some((k) => k.demo);
  const live = keys.filter((k) => k.enabled && (!k.expiresAt || k.expiresAt > Date.now()));
  const rules = policy.rules;
  const enabled = rules.filter((r) => r.enabled);
  const inventory = await buildInventory(ctx, Math.min(720, days * 24));

  const count = async (q: Promise<{ n: number | string | bigint } | undefined>) => Number((await q)?.n ?? 0);
  const flights = await count(db.selectFrom('flights').select((eb) => eb.fn.countAll<number>().as('n')).where('ts', '>=', since).executeTakeFirst());
  const byPerson = await count(db.selectFrom('flights').select((eb) => eb.fn.countAll<number>().as('n')).where('ts', '>=', since).where('principal', 'is not', null).executeTakeFirst());
  const refused = await count(db.selectFrom('flights').select((eb) => eb.fn.countAll<number>().as('n')).where('ts', '>=', since).where('decision', '=', 'deny').executeTakeFirst());
  const held = await count(db.selectFrom('flights').select((eb) => eb.fn.countAll<number>().as('n')).where('ts', '>=', since).where('decision', '=', 'hold').executeTakeFirst());
  const people = await count(sql<{ n: number }>`SELECT COUNT(DISTINCT principal) AS n FROM flights WHERE ts >= ${since} AND principal IS NOT NULL`.execute(db).then((r) => r.rows[0]));
  const apps = (await sql<{ client: string; n: number }>`SELECT client, COUNT(*) AS n FROM flights WHERE ts >= ${since} AND client IS NOT NULL GROUP BY client`.execute(db)).rows;
  const decided = await db.selectFrom('approvals').select(['status', 'resolved_by']).where('requested_at', '>=', since).where('status', 'in', ['approved', 'denied']).execute();
  const approvers = await db.selectFrom('admins').select(['email', 'role']).where('role', 'in', ['admin', 'approver']).where('disabled', '=', 0).execute();
  const ssoProviders = await db.selectFrom('identity_providers').select(['name', 'kind', 'scim_token_hash']).where('enabled', '=', 1).execute();
  const alertRules = await db.selectFrom('alert_rules').select(['name', 'channels', 'enabled']).where('enabled', '=', 1).execute();
  const sinks = await db.selectFrom('export_destinations').select(['name', 'kind', 'send_audit', 'enabled']).where('enabled', '=', 1).where('send_audit', '=', 1).execute();
  const revoked = await count(db.selectFrom('device_sessions').select((eb) => eb.fn.countAll<number>().as('n')).where('revoked_at', '>=', since).executeTakeFirst());
  const verify = ctx.audit ? await ctx.audit.verify() : undefined;
  const providers = [...new Set(inventory.models.map((m) => m.provider_kind || m.provider).filter(Boolean))].sort();

  const checks = {} as Record<CheckId, CheckResult>;
  const put = (c: Omit<CheckResult, 'id'> & { id: CheckId }) => void (checks[c.id] = c);

  put({
    id: 'inventory',
    title: 'Inventory of AI assistants and agents',
    status: keys.length ? 'met' : 'gap',
    summary: keys.length
      ? `${plural(keys.length, 'agent')} on record, using ${plural(inventory.totals.models, 'model')} and ${plural(inventory.totals.mcp_servers, 'tool server')}; ${plural(people, 'person', 'people')} in ${plural(apps.length, 'app')} made calls in the period.`
      : 'No agents or assistants go through Control Tower yet.',
    facts: { agents: keys.length, models: inventory.totals.models, tool_servers: inventory.totals.mcp_servers, paths: inventory.totals.paths, people, apps: apps.map((a) => a.client).join(', ') },
    next: keys.length ? undefined : 'Point your assistants and agents at Control Tower (Laptops, or a key each), so they are inventoried as they are used.',
  });
  const owned = keys.filter((k) => k.owner);
  put({
    id: 'ownership',
    title: 'Each agent has an owner',
    status: !keys.length ? 'gap' : owned.length === keys.length ? 'met' : owned.length ? 'partial' : 'gap',
    summary: keys.length ? `${owned.length} of ${keys.length} agents have an owner (${pct(owned.length, keys.length)}%); ${keys.filter((k) => k.team).length} have a team.` : 'No agents yet.',
    facts: { agents: keys.length, with_owner: owned.length, with_team: keys.filter((k) => k.team).length },
    next: owned.length < keys.length ? `Set an owner on ${keys.length - owned.length} agent${keys.length - owned.length === 1 ? '' : 's'} under Keys: ${keys.filter((k) => !k.owner).slice(0, 5).map((k) => k.name).join(', ')}${keys.length - owned.length > 5 ? '…' : ''}.` : undefined,
  });
  const scoped = live.filter((k) => !unrestricted(k.allowedModels) && !unrestricted(k.allowedMcp));
  const partlyScoped = live.filter((k) => !unrestricted(k.allowedModels) || !unrestricted(k.allowedMcp));
  put({
    id: 'least_privilege',
    title: 'Least privilege: each agent reaches only what it needs',
    status: !live.length ? 'gap' : scoped.length === live.length ? 'met' : partlyScoped.length ? 'partial' : enabled.some((r) => r.effect === 'deny') ? 'partial' : 'gap',
    summary: live.length
      ? `${scoped.length} of ${live.length} active agents are limited to named models and tools${partlyScoped.length > scoped.length ? `, ${partlyScoped.length - scoped.length} more to one or the other` : ''}; ${plural(enabled.filter((r) => r.effect === 'deny').length, 'gate')} block${enabled.filter((r) => r.effect === 'deny').length === 1 ? 's' : ''} paths outright.`
      : 'No active agents yet.',
    facts: { active_agents: live.length, models_and_tools_limited: scoped.length, partly_limited: partlyScoped.length - scoped.length, unrestricted: live.length - partlyScoped.length, deny_gates: enabled.filter((r) => r.effect === 'deny').length, limit_gates: enabled.filter((r) => r.effect === 'allow_with_limits').length },
    next: scoped.length < live.length ? `Limit the models and tools of ${live.length - scoped.length} agent${live.length - scoped.length === 1 ? '' : 's'} under Keys (allowed models, allowed tools), starting with ${live.filter((k) => unrestricted(k.allowedModels) && unrestricted(k.allowedMcp)).slice(0, 3).map((k) => k.name).join(', ') || 'the unrestricted ones'}.` : undefined,
  });
  const approvalGates = enabled.filter((r) => r.effect === 'require_approval');
  const approved = decided.filter((d) => d.status === 'approved').length;
  put({
    id: 'human_oversight',
    title: 'Human approval for sensitive actions',
    status: approvalGates.length ? 'met' : 'gap',
    summary: approvalGates.length
      ? `${plural(approvalGates.length, 'approval gate')}; ${plural(held, 'call')} held for a person in the period, ${approved} approved and ${decided.length - approved} denied by ${plural(new Set(decided.map((d) => d.resolved_by).filter(Boolean)).size, 'approver')}.`
      : 'No gate asks a person to approve anything.',
    facts: { approval_gates: approvalGates.length, held, approved, denied: decided.length - approved, approvers_who_decided: new Set(decided.map((d) => d.resolved_by).filter(Boolean)).size },
    next: approvalGates.length ? undefined : 'Add a "require approval" gate on the paths that matter (writes to production, deleting records, sending email) on the Airspace.',
  });
  put({
    id: 'approvers',
    title: 'Named people can approve and intervene',
    status: approvers.length >= 2 ? 'met' : approvers.length ? 'partial' : 'gap',
    summary: `${plural(approvers.length, 'person', 'people')} can approve or deny held requests (${plural(approvers.filter((a) => a.role === 'approver').length, 'approver')}, ${plural(approvers.filter((a) => a.role === 'admin').length, 'admin')}); nobody can approve their own.`,
    facts: { approvers: approvers.filter((a) => a.role === 'approver').length, admins: approvers.filter((a) => a.role === 'admin').length },
    next: approvers.length >= 2 ? undefined : 'Give at least two people the approver role under People, so oversight doesn\'t depend on one person.',
  });
  put({
    id: 'logging',
    title: 'Every call is logged',
    status: flights ? 'met' : 'gap',
    summary: flights ? `${plural(flights, 'call')} recorded in the period (who, which agent, model or tool, the decision, cost); ${pct(byPerson, flights)}% made as a named person.` : 'No calls recorded in the period.',
    facts: { calls: flights, as_a_person: byPerson, refused, held },
  });
  const keepDays = ctx.config.retention.flightsDays;
  put({
    id: 'log_retention',
    title: 'Logs kept at least six months',
    status: keepDays === 0 || keepDays >= 183 ? 'met' : sinks.length ? 'partial' : 'gap',
    summary: `Calls are kept ${keepDays === 0 ? 'forever' : `${keepDays} days`} (CT_RETENTION_DAYS); the audit log ${ctx.config.retention.auditDays === 0 ? 'forever' : `${ctx.config.retention.auditDays} days`}.${sinks.length ? ` The audit log is also sent to ${sinks.map((s) => s.name).join(', ')}.` : ''}`,
    facts: { call_retention_days: keepDays, audit_retention_days: ctx.config.retention.auditDays, offsite_copies: sinks.length },
    next: keepDays === 0 || keepDays >= 183 ? undefined : 'Set CT_RETENTION_DAYS to 183 or more (or 0 to keep everything), or send calls to your SIEM.',
  });
  put({
    id: 'audit_trail',
    title: 'Tamper-evident audit trail',
    status: !verify ? 'gap' : verify.ok && verify.events ? 'met' : verify.ok ? 'partial' : 'gap',
    summary: !verify
      ? 'The audit log is off (it needs an Enterprise license).'
      : verify.ok
        ? `${plural(verify.events, 'audit event')}, hash-chained; the chain verifies${verify.first_seq != null ? ` (events ${verify.first_seq}–${verify.last_seq})` : ''}.`
        : `The audit chain does NOT verify: ${verify.reason ?? 'broken'} at event ${verify.broken_at}.`,
    facts: verify ? { events: verify.events, verifies: verify.ok, ...(verify.broken_at != null ? { broken_at: verify.broken_at } : {}) } : { enabled: false },
    next: verify && !verify.ok ? 'Investigate the break: an event was changed or removed. Compare with your SIEM copy.' : undefined,
  });
  put({
    id: 'audit_offsite',
    title: 'A copy kept outside Control Tower',
    status: sinks.length ? 'met' : 'partial',
    summary: sinks.length ? `The audit log is sent to ${sinks.map((s) => `${s.name} (${s.kind})`).join(', ')}.` : 'The audit log is kept only in Control Tower\'s database.',
    facts: { destinations: sinks.length },
    next: sinks.length ? undefined : 'Send the audit log to your SIEM (Exports), so evidence survives someone with database access.',
  });
  const inspect = enabled.filter((r) => r.effect === 'inspect');
  const detectors = [...new Set(inspect.flatMap((r) => r.config.detectors ?? []))];
  const guardrailsUsed = new Set(inspect.flatMap((r) => r.config.guardrails ?? []));
  put({
    id: 'data_protection',
    title: 'Secrets and personal data kept from models and tools',
    status: inspect.length ? 'met' : 'gap',
    summary: inspect.length ? `${plural(inspect.length, 'inspect gate')} (${detectors.slice(0, 6).join(', ') || 'custom checks'}${guardrailsUsed.size ? `, ${plural(guardrailsUsed.size, 'guardrail')}` : ''}); ${plural(refused, 'call')} refused in the period.` : 'Nothing inspects what is sent to models and tools.',
    facts: { inspect_gates: inspect.length, detectors: detectors.join(', '), guardrails: guardrailsUsed.size, refused },
    next: inspect.length ? undefined : 'Add an inspect gate that blocks secrets and masks personal data (Guardrails, or the Airspace).',
  });
  const people_ = await count(db.selectFrom('admins').select((eb) => eb.fn.countAll<number>().as('n')).where('disabled', '=', 0).executeTakeFirst());
  put({
    id: 'identity',
    title: 'People sign in as themselves',
    status: ssoProviders.length ? 'met' : people_ > 1 || byPerson ? 'partial' : 'gap',
    summary: `${ssoProviders.length ? `Single sign-on through ${ssoProviders.map((p) => p.name).join(', ')}${ssoProviders.some((p) => p.scim_token_hash) ? ', with SCIM provisioning' : ''}` : 'No single sign-on'}; ${pct(byPerson, flights)}% of calls in the period made as a named person.`,
    facts: { sso_providers: ssoProviders.length, scim: ssoProviders.some((p) => p.scim_token_hash), console_people: people_, calls_as_a_person: byPerson },
    next: ssoProviders.length ? undefined : 'Connect your identity provider (single sign-on), and roll laptops out with each person signed in (Laptops).',
  });
  const wired = alertRules.filter((r) => (JSON.parse(r.channels || '[]') as unknown[]).length);
  put({
    id: 'monitoring',
    title: 'Monitored, with alerts to people',
    status: wired.length ? 'met' : alertRules.length ? 'partial' : 'gap',
    summary: wired.length ? `${plural(wired.length, 'alert rule')} send to a channel (${wired.slice(0, 4).map((r) => r.name).join(', ')}).` : alertRules.length ? `${plural(alertRules.length, 'alert rule')}, none sending anywhere.` : 'No alerts: nobody is told when a gate blocks or an agent misbehaves.',
    facts: { alert_rules: alertRules.length, sending: wired.length },
    next: wired.length ? undefined : 'Add alert rules for refusals, spend and held requests, sent to Slack or email (Alerts).',
  });
  const off = keys.filter((k) => !k.enabled).length;
  put({
    id: 'deactivation',
    title: 'An agent or person can be stopped at once',
    status: ctx.config.mode === 'off' ? 'gap' : 'met',
    summary: ctx.config.mode === 'off'
      ? 'Enforcement is OFF (CT_MODE=off): gates are not applied.'
      : `Any agent's key can be turned off, a laptop signed out or a person removed, effective at once; ${plural(off, 'agent')} turned off, ${plural(revoked, 'laptop sign-in')} ended in the period.`,
    facts: { enforcement: ctx.config.mode !== 'off', agents_turned_off: off, laptop_sign_ins_ended: revoked },
    next: ctx.config.mode === 'off' ? 'Turn enforcement on (unset CT_MODE).' : undefined,
  });
  put({
    id: 'suppliers',
    title: 'Model and tool suppliers known and controlled',
    status: providers.length ? 'met' : 'gap',
    summary: providers.length ? `${plural(providers.length, 'model provider')} in use (${providers.join(', ')}), and ${plural(inventory.totals.mcp_servers, 'tool server')}; agents reach no others through Control Tower.` : 'No model providers connected.',
    facts: { providers: providers.join(', '), tool_servers: inventory.totals.mcp_servers },
  });

  return {
    checks,
    evidence: {
      inventory,
      agents: keys.map((k) => ({ name: k.name, team: k.team ?? null, owner: k.owner ?? null, enabled: k.enabled, models: k.allowedModels, tools: k.allowedMcp, expires_at: k.expiresAt ?? null })),
      gates: rules.map((r) => ({ name: r.name, effect: r.effect, enabled: r.enabled, reason: r.config.reason ?? null })),
      approvals: { approved, denied: decided.length - approved, by: [...new Set(decided.map((d) => d.resolved_by).filter((x): x is string => !!x))] },
      approvers: approvers.map((a) => ({ email: a.email, role: a.role ?? 'admin' })),
      audit: verify ?? null,
      retention: ctx.config.retention,
      identity: { sso: ssoProviders.map((p) => ({ name: p.name, kind: p.kind, scim: !!p.scim_token_hash })) },
      alerts: alertRules.map((r) => r.name),
      audit_destinations: sinks.map((s) => ({ name: s.name, kind: s.kind })),
      apps: apps.map((a) => ({ app: a.client, calls: Number(a.n) })),
      demo,
    },
  };
}

export interface Evidence {
  inventory: Awaited<ReturnType<typeof buildInventory>>;
  agents: Array<{ name: string; team: string | null; owner: string | null; enabled: boolean; models: string[]; tools: string[]; expires_at: number | null }>;
  gates: Array<{ name: string; effect: string; enabled: boolean; reason: string | null }>;
  approvals: { approved: number; denied: number; by: string[] };
  approvers: Array<{ email: string; role: string }>;
  audit: { ok: boolean; events: number; first_seq: number | null; last_seq: number | null; broken_at?: number; reason?: string } | null;
  retention: { flightsDays: number; eventsDays: number; auditDays: number };
  identity: { sso: Array<{ name: string; kind: string; scim: boolean }> };
  alerts: string[];
  audit_destinations: Array<{ name: string; kind: string }>;
  apps: Array<{ app: string; calls: number }>;
  /** Demo data is in the installation (and so in this evidence). */
  demo: boolean;
}

const WORST: Record<CheckStatus, number> = { met: 0, partial: 1, gap: 2 };

export interface FrameworkReport {
  framework: { id: FrameworkId; name: string; version: string; scope: string };
  period_days: number;
  generated_at: string;
  control_tower: string;
  summary: Record<RequirementStatus, number>;
  requirements: Array<Requirement & { status: RequirementStatus; results: CheckResult[] }>;
}

/** A framework's requirements with their status: the worst of their checks, or the organisation's when none apply. */
export function frameworkReport(f: Framework, checks: Record<CheckId, CheckResult>, days: number, version: string): FrameworkReport {
  const requirements = f.requirements.map((r) => {
    const results = r.checks.map((id) => checks[id]);
    const status: RequirementStatus = !results.length ? 'organizational' : (['met', 'partial', 'gap'] as CheckStatus[])[Math.max(...results.map((c) => WORST[c.status]))]!;
    return { ...r, status, results };
  });
  const summary = { met: 0, partial: 0, gap: 0, organizational: 0 } as Record<RequirementStatus, number>;
  for (const r of requirements) summary[r.status]++;
  return { framework: { id: f.id, name: f.name, version: f.version, scope: f.scope }, period_days: days, generated_at: new Date().toISOString(), control_tower: version, summary, requirements };
}

const LABEL: Record<RequirementStatus, string> = { met: 'Met', partial: 'Partly met', gap: 'Gap', organizational: 'Organisation\'s' };
const md = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The evidence pack, as a document: the register, then each requirement's evidence, then the records themselves. */
export function evidenceMarkdown(report: FrameworkReport, evidence: Evidence, by: string): string {
  const f = report.framework;
  const out: string[] = [];
  out.push(`# ${f.name}: evidence from Control Tower`, '');
  out.push(`${f.version}. Period: the last ${report.period_days} days, to ${report.generated_at.slice(0, 10)}. Generated by ${by} with Control Tower ${report.control_tower}.`, '');
  out.push(`> ${f.scope}`, '');
  if (evidence.demo) out.push('> **This installation has demo data in it**, and so does this pack. Clear the demo (Get started) before using it as evidence.', '');
  out.push('> This pack is evidence for an assessment, drawn from Control Tower\'s records. It is not a certification or legal advice, and requirements marked as the organisation\'s need evidence from elsewhere.', '');
  out.push('## Summary', '');
  out.push('| Met | Partly met | Gap | Organisation\'s |', '|---|---|---|---|', `| ${report.summary.met} | ${report.summary.partial} | ${report.summary.gap} | ${report.summary.organizational} |`, '');
  out.push('## Register', '');
  out.push('| Requirement | Status | Evidence |', '|---|---|---|');
  for (const r of report.requirements) out.push(`| **${md(r.ref)}** ${md(r.title)} | ${LABEL[r.status]} | ${md(r.results.map((c) => c.summary).join(' ') || r.note || '')} |`);
  out.push('');
  out.push('## Requirements', '');
  for (const r of report.requirements) {
    out.push(`### ${r.ref}: ${r.title} — ${LABEL[r.status]}`, '', r.asks, '');
    for (const c of r.results) {
      out.push(`- **${c.title}** (${LABEL[c.status]}): ${c.summary}`);
      if (c.next) out.push(`  - To do: ${c.next}`);
    }
    if (r.note) out.push(`- ${r.note}`);
    out.push('');
  }
  out.push('## Records', '');
  out.push(`### Agents and assistants (${evidence.agents.length})`, '', '| Agent | Team | Owner | Active | Models | Tools |', '|---|---|---|---|---|---|');
  for (const a of evidence.agents) out.push(`| ${md(a.name)} | ${md(a.team ?? '—')} | ${md(a.owner ?? '—')} | ${a.enabled ? 'yes' : 'no'} | ${md(a.models.join(', ') || 'none')} | ${md(a.tools.join(', ') || 'none')} |`);
  out.push('');
  if (evidence.apps.length) {
    out.push('### Apps people used', '', '| App | Calls |', '|---|---|');
    for (const a of evidence.apps) out.push(`| ${md(a.app)} | ${a.calls} |`);
    out.push('');
  }
  out.push(`### Paths in the period (${evidence.inventory.paths.length})`, '', '| Agent | Reaches | Requests | Refused | Held | Access |', '|---|---|---|---|---|---|');
  for (const p of evidence.inventory.paths.slice(0, 200)) out.push(`| ${md(p.agent)} | ${md(p.target)}${p.tool ? ` → ${md(p.tool)}` : ''} | ${p.requests} | ${p.blocked} | ${p.held} | ${md(p.access)}${p.access_gate ? ` (${md(p.access_gate)})` : ''} |`);
  out.push('');
  out.push(`### Gates (${evidence.gates.length})`, '', '| Gate | Effect | On | Reason |', '|---|---|---|---|');
  for (const g of evidence.gates) out.push(`| ${md(g.name)} | ${md(g.effect)} | ${g.enabled ? 'yes' : 'no'} | ${md(g.reason ?? '')} |`);
  out.push('');
  out.push('### Human oversight', '', `- Approved in the period: ${evidence.approvals.approved}; denied: ${evidence.approvals.denied}.`, `- Decided by: ${evidence.approvals.by.join(', ') || 'nobody'}.`, `- Who can approve: ${evidence.approvers.map((a) => `${a.email} (${a.role})`).join(', ') || 'nobody'}.`, '');
  out.push('### Logs and audit trail', '');
  out.push(`- Calls kept: ${evidence.retention.flightsDays === 0 ? 'forever' : `${evidence.retention.flightsDays} days`}; audit events kept: ${evidence.retention.auditDays === 0 ? 'forever' : `${evidence.retention.auditDays} days`}.`);
  out.push(evidence.audit ? `- Audit chain: ${evidence.audit.ok ? 'verifies' : `BROKEN at event ${evidence.audit.broken_at} (${evidence.audit.reason ?? ''})`}; ${evidence.audit.events} events${evidence.audit.first_seq != null ? `, ${evidence.audit.first_seq}–${evidence.audit.last_seq}` : ''}.` : '- Audit log: off.');
  out.push(`- Copies outside Control Tower: ${evidence.audit_destinations.map((d) => `${d.name} (${d.kind})`).join(', ') || 'none'}.`, '');
  out.push('### Identity and monitoring', '', `- Single sign-on: ${evidence.identity.sso.map((s) => `${s.name} (${s.kind}${s.scim ? ', SCIM' : ''})`).join(', ') || 'none'}.`, `- Alert rules: ${evidence.alerts.join(', ') || 'none'}.`, '');
  return `${out.join('\n')}\n`;
}

/** A digest of the pack, recorded in the audit log when it's exported: a later copy can be checked against it. */
export const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
