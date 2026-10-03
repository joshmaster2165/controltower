import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { describeFindings, type Findings } from '../guardrails/scan.js';
import type { GatewayError } from './errors.js';

/**
 * What a person sees when Control Tower decides about their call.
 *
 * Agents read Control Tower's refusals as structured errors (403, a code, a ticket to retry with). A person in Claude
 * Desktop, Claude Code or Codex reads what their app shows them, and these apps treat a 403 as a sign-in problem
 * ("Authentication failed", or waiting on a retry that never comes). So for those apps a refusal is sent as a 400,
 * which they show as it is, with a message written for the person: what decided, why, and what to do next. The codes
 * and the machine-readable details stay in the body.
 */

/** The apps people use, as a laptop's sign-in names them. */
export const PERSON_APPS = new Set(['claude-desktop', 'claude-code', 'codex']);

/** The app a call came from: the laptop's sign-in says, or failing that, the app's own User-Agent. */
export function clientOf(req: FastifyRequest): string | undefined {
  if (req.ctClient && req.ctClient !== 'other') return req.ctClient;
  const ua = String(req.headers['user-agent'] ?? '');
  // Claude Desktop runs Claude Code: claude-cli/2.1.286 (external, claude-desktop-3p, agent-sdk/0.3.286)
  if (/^claude-cli\//.test(ua)) return /claude-desktop/.test(ua) ? 'claude-desktop' : 'claude-code';
  if (/^codex[_ -]/i.test(ua)) return 'codex';
  return undefined;
}

const REFUSALS = new Set(['policy_denied', 'approval_required', 'content_blocked']);

/** The refusal as the person's app should get it; anything else, and anyone else's, unchanged. */
export function forPerson(ge: GatewayError, f: { client: string | undefined; decision?: { ruleId?: string | undefined; reason?: string | undefined } | undefined }, ctx: Pick<AppContext, 'config' | 'policy'>): GatewayError {
  if (!f.client || !PERSON_APPS.has(f.client)) return ge;
  // Any other 403 (a model the key may not use, say) still mustn't read as a failed sign-in.
  if (!REFUSALS.has(ge.code)) return ge.status === 403 ? { ...ge, status: 400 } : ge;
  const label = ctx.config.noticeLabel;
  const ruleId = (typeof ge.extra?.rule_id === 'string' ? ge.extra.rule_id : undefined) ?? f.decision?.ruleId;
  const rule = ruleId ? ctx.policy.rule?.(ruleId) : undefined;
  const gate = rule ? ` (gate “${rule.name}”)` : '';
  const ct = (ge.extra?.ct ?? {}) as { status?: string; console_url?: string };
  let message: string;
  if (ge.code === 'content_blocked') {
    const what = ge.extra?.findings ? describeFindings(ge.extra.findings as Findings) : 'something a gate here does not allow';
    const why = rule?.config.reason ? ` ${sentence(rule.config.reason)}` : '';
    message = /withheld/.test(ge.message)
      ? `${label} withheld the answer: it contained ${what}${gate}.${why} Ask your administrator if you need it.`
      : `${label} blocked this message: it contains ${what}${gate}.${why} Remove it and send your message again.`;
  } else if (ge.code === 'policy_denied') {
    // An approver's decision reads "Denied by <who>: <note>."; a gate's is its reason, or "Blocked by gate …".
    const byApprover = /^Denied by /.test(ge.message);
    const withdrawn = /^Denied by Control Tower: /.test(ge.message);
    message = withdrawn
      ? `${label}: your request was withdrawn: ${ge.message.replace(/^Denied by Control Tower: /, '').replace(/\.$/, '')}.`
      : byApprover ? `${label}: your request was ${lowerFirst(ge.message.replace(/\.$/, ''))}${gate}.` : rule?.config.reason ? `${label} blocked this request${gate}: ${sentence(rule.config.reason)}` : `${label} blocked this request${gate}.`;
  } else if (ct.status === 'expired') {
    message = `${label}: this request needed approval${gate}, and nobody approved it in time. Send your message again to ask again.`;
  } else {
    // Still waiting for an approver: the card stays open, and once approved, sending the same message again goes through.
    message = `${label}: this request needs approval${gate}. An approver has been asked; once they approve, send the same message again.${ct.console_url ? ` Status: ${ct.console_url}` : ''}`;
  }
  return { ...ge, status: 400, type: 'invalid_request_error', message };
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
