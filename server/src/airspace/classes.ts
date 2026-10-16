/**
 * Trust classes: how deep each system sits, and where data could leave.
 *
 * Every system an agent reaches (a model provider, an MCP server, an HTTP API, a remote agent, or a system seen
 * outside the gateway) is given a class, like controlled airspace: A is production, B restricted data (customers,
 * payments, records), C the company's internal systems, D vendors and SaaS outside it, E the public internet.
 * Agents live in C. Defaults come from what the system is; an admin can set any of them.
 *
 * Exfiltration risk is the shape that matters: an agent that reaches an inner class (A or B) and can send to an outer
 * one (D or E: a vendor's model, a SaaS API, an unknown host). Each such pair is a risk path. It's mitigated when
 * something stands on the outbound path (an inspect gate, a person's approval, a block), and at its worst when the
 * outbound call goes around the gateway entirely (seen outside, not enforced).
 */

export type TrustClass = 'A' | 'B' | 'C' | 'D' | 'E';
export const CLASSES: TrustClass[] = ['A', 'B', 'C', 'D', 'E'];
export const CLASS_INFO: Record<TrustClass, { name: string; about: string }> = {
  A: { name: 'Production', about: 'Live systems: deploys, infrastructure, production data stores' },
  B: { name: 'Restricted data', about: 'Customer, payment, financial and personal records' },
  C: { name: 'Internal', about: "The company's own tools and code, and its agents" },
  D: { name: 'Vendors & SaaS', about: 'Outside the company: model providers and SaaS APIs' },
  E: { name: 'Public internet', about: 'Unknown or public hosts' },
};
/** Depth: A is the innermost (0), E the outermost (4). */
export const depth = (c: TrustClass) => CLASSES.indexOf(c);
export const isClass = (v: unknown): v is TrustClass => typeof v === 'string' && (CLASSES as string[]).includes(v);

export type SystemKind = 'model' | 'mcp' | 'http' | 'a2a' | 'observed';
export interface SystemFacts {
  /** provider:<id>, tool:<mcp/http/a2a id>, observed:<target id> */
  id: string;
  kind: SystemKind;
  name: string;
  /** A URL or host, when there is one. */
  url?: string | undefined;
  /** For models: the provider's kind (openai, anthropic, openai-compatible…). For observed: its kind (model, saas, database, http…). */
  subkind?: string | undefined;
}

const PRODUCTION = /\b(prod|production|deploy(?:ment|s)?|k8s|kubernetes|terraform|infra(?:structure)?|aws|gcp|azure[- ]?(?:rm|resource)|ci[- ]?cd|release)\b/i;
const RESTRICTED = /(salesforce|hubspot|zendesk|intercom|freshdesk|crm|customer|payment|payout|billing|stripe|adyen|ledger|finance|accounting|payroll|\bhr\b|workday|bamboohr|patient|health|medical|ssn|database|postgres|mysql|mongo|snowflake|bigquery|redshift|warehouse|\bdb\b|-db\b|_db\b|orders)/i;
const INTERNAL = /(github|gitlab|bitbucket|jira|confluence|notion|slack|teams|drive|sharepoint|docs|wiki|sentry|datadog|grafana|pagerduty|linear|status\.internal|internal)/i;

/** Whether a URL or host is inside the company network. */
export function internalHost(url: string | undefined): boolean {
  if (!url) return false;
  let host = url;
  try {
    host = new URL(url.includes('://') ? url : `http://${url}`).hostname;
  } catch {
    /* a bare name */
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /\.(internal|local|lan|corp|intranet|home\.arpa)$/.test(host) ||
    !host.includes('.')
  );
}

/** A system's class when nobody has set one, and why. */
export function defaultClass(s: SystemFacts): { class: TrustClass; reason: string } {
  const text = `${s.name} ${s.url ?? ''}`;
  if (s.kind === 'model') {
    if ((s.subkind === 'openai-compatible' || s.subkind === 'ollama') && internalHost(s.url)) return { class: 'C', reason: 'A model running inside the company' };
    return { class: 'D', reason: 'A model provider outside the company: prompts leave it' };
  }
  if (PRODUCTION.test(text)) return { class: 'A', reason: 'Its name says production or infrastructure' };
  if (RESTRICTED.test(text) || s.subkind === 'database') return { class: 'B', reason: 'It holds customer, payment or other restricted data' };
  if (s.kind === 'observed') {
    if (s.subkind === 'model') return { class: 'D', reason: 'A model provider, called directly' };
    if (INTERNAL.test(text) || internalHost(s.url ?? s.name)) return { class: 'C', reason: 'An internal system' };
    if (s.subkind === 'saas') return { class: 'D', reason: 'A SaaS service outside the company' };
    if (s.subkind === 'queue' || s.subkind === 'rpc') return { class: 'C', reason: 'Internal infrastructure' };
    return { class: 'E', reason: 'An outside host nobody has classified' };
  }
  if (INTERNAL.test(text) || internalHost(s.url)) return { class: 'C', reason: 'An internal tool' };
  return { class: 'D', reason: 'A service outside the company' };
}

export type Op = 'read' | 'write' | 'admin' | 'unknown' | 'model';
export interface Link {
  agent_id: string;
  system_id: string;
  calls: number;
  /** The most consequential operation seen on the link. */
  op: Op;
  /** Every call on it is held for a person, blocked, or inspected; or none is. */
  mitigated: boolean;
  /** What stands on it, in words ("inspected by Mask customer data", "held: Deletes need approval"). */
  mitigation: string | null;
  /** Seen outside the gateway: not enforced. */
  outside: boolean;
  /** The gateway's own decision on it: allow, hold (approval) or deny. */
  state: 'allow' | 'hold' | 'deny';
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export interface Risk {
  agent_id: string;
  /** The innermost system the agent reaches: where data could come from. */
  source_id: string;
  source_class: TrustClass;
  /** Where it could go. */
  dest_id: string;
  dest_class: TrustClass;
  level: RiskLevel;
  reason: string;
  mitigation: string | null;
  outside: boolean;
  calls: number;
}
const RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const worstRisk = (risks: Risk[]): RiskLevel | null => risks.reduce<RiskLevel | null>((w, r) => (w === null || RANK[r.level] < RANK[w] ? r.level : w), null);

/**
 * Each agent's risk paths: from the innermost class it reaches to every outer, outside-the-company system it sends to.
 *   critical  restricted or production data within reach, and a way out that goes around the gateway
 *   high      the same, out through the gateway with nothing on the way (no inspection, approval or block)
 *   medium    internal data within reach, out to the public internet unchecked
 *   low       a way out with something on it (listed so the coverage is visible)
 */
export function exfilRisks(links: Link[], classOf: (systemId: string) => TrustClass): Risk[] {
  const byAgent = new Map<string, Link[]>();
  for (const l of links) byAgent.set(l.agent_id, [...(byAgent.get(l.agent_id) ?? []), l]);
  const out: Risk[] = [];
  for (const [agent, ls] of byAgent) {
    // Where data could come from: the innermost system it reaches (models aren't a source of the company's data).
    const sources = ls.filter((l) => l.op !== 'model' && depth(classOf(l.system_id)) <= depth('C') && l.state !== 'deny');
    if (!sources.length) continue;
    const source = sources.reduce((a, b) => (depth(classOf(b.system_id)) < depth(classOf(a.system_id)) || (depth(classOf(b.system_id)) === depth(classOf(a.system_id)) && b.calls > a.calls) ? b : a));
    const sc = classOf(source.system_id);
    for (const l of ls) {
      const dc = classOf(l.system_id);
      if (depth(dc) < depth('D') || l === source) continue;
      let level: RiskLevel | null;
      let reason: string;
      if (depth(sc) <= depth('B')) {
        level = l.outside ? 'critical' : l.mitigated ? 'low' : 'high';
        reason = l.outside
          ? `${CLASS_INFO[sc].name} within reach, and calls to ${CLASS_INFO[dc].name.toLowerCase()} that go around the gateway`
          : l.mitigated
            ? `${CLASS_INFO[sc].name} within reach; what it sends out is checked`
            : `${CLASS_INFO[sc].name} within reach, sent out to ${CLASS_INFO[dc].name.toLowerCase()} with nothing on the way`;
      } else if (dc === 'E' && !l.mitigated) {
        level = l.outside ? 'high' : 'medium';
        reason = `Internal systems within reach, and calls to the public internet${l.outside ? ' around the gateway' : ' with nothing on the way'}`;
      } else level = null;
      if (!level) continue;
      out.push({ agent_id: agent, source_id: source.system_id, source_class: sc, dest_id: l.system_id, dest_class: dc, level, reason: reason!, mitigation: l.mitigation, outside: l.outside, calls: l.calls });
    }
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level] || b.calls - a.calls);
}
