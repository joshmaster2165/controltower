import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';
import { runInspectors, skipLeaf, textOfValue, type CompiledInspector, type GateOutcome, type InspectAction, type InspectConfig } from './scan.js';
import { GUARDRAIL_KEY_ID } from './model-check.js';
import { textLeaves } from './service-registry.js';

type Gate<R> = { rule: R; compiled: CompiledInspector };
type Result<R> = { value: unknown; outcomes: Array<GateOutcome<R>>; blocked: GateOutcome<R> | undefined };

/**
 * Inspect gates on a value: their detectors first, then — for gates that ask
 * for it — the model-based injection check on what is left. A model's verdict
 * can't be masked word by word, so a masking gate withholds the content
 * instead (it blocks); on a reply already streamed, it can only flag.
 */
export async function inspect<R extends { id: string; name: string; config: InspectConfig }>(
  ctx: Pick<AppContext, 'modelChecker'> & Partial<Pick<AppContext, 'guardrails' | 'registry'>>,
  key: KeyRecord | undefined,
  gates: Array<Gate<R>>,
  direction: 'input' | 'output',
  value: unknown,
  opts: { streamed: boolean } = { streamed: false },
): Promise<Result<R>> {
  const r = runInspectors(gates, direction, value, opts);
  // The guardrail's own calls are never checked by a model: that would ask the model about itself, forever.
  if (r.blocked || key?.id === GUARDRAIL_KEY_ID) return r;
  const served = await askServices(ctx, key, gates, direction, r, opts);
  if (served.blocked) return served;
  const withModel = gates.filter((g) => g.rule.config.model_check?.model && (g.compiled.direction === 'both' || g.compiled.direction === direction));
  if (!withModel.length) return served;
  const text = textOfValue(served.value);
  if (!text.trim()) return served;
  for (const g of withModel) {
    const mc = g.rule.config.model_check!;
    const v = await ctx.modelChecker.check(mc.model, text);
    if (v.verdict === 'clean') continue;
    const failed = v.verdict === 'error';
    const gateAction: InspectAction = g.compiled.action === 'mask' ? 'block' : g.compiled.action;
    const action: InspectAction = opts.streamed ? 'flag' : failed ? (mc.on_error === 'block' ? 'block' : 'flag') : gateAction;
    const o: GateOutcome<R> = {
      ruleId: g.rule.id,
      ruleName: g.rule.name,
      action,
      findings: failed ? { model_check_failed: 1 } : { injection_model: 1 },
      truncated: false,
      reason: failed ? v.reason : `${g.rule.config.reason ? `${g.rule.config.reason}. ` : ''}The check model said: ${v.reason}`,
      rule: g.rule,
    };
    served.outcomes.push(o);
    if (action === 'block') return { ...served, blocked: o };
  }
  return served;
}

/**
 * Gates that ask guardrail services: all of a gate's services at once, on the texts the value holds. A service
 * that flags something applies the gate's action; masking works where the service says exactly what to mask
 * (Presidio's offsets, a webhook's texts) and otherwise withholds the content. A service that can't be reached
 * is flagged — or blocks, when the gate says so.
 */
async function askServices<R extends { id: string; name: string; config: InspectConfig }>(
  ctx: Partial<Pick<AppContext, 'guardrails' | 'registry'>>,
  key: KeyRecord | undefined,
  gates: Array<Gate<R>>,
  direction: 'input' | 'output',
  r: Result<R>,
  opts: { streamed: boolean },
): Promise<Result<R>> {
  const svcGates = gates.filter((g) => g.rule.config.services?.length && (g.compiled.direction === 'both' || g.compiled.direction === direction));
  if (!svcGates.length || !ctx.guardrails) return r;
  let value = r.value;
  for (const g of svcGates) {
    let { texts, rebuild } = textLeaves(value, skipLeaf);
    if (!texts.some((t) => t.trim())) continue;
    let maskedOnce = false;
    const results = await Promise.all(
      g.rule.config.services!.map((id) =>
        ctx.guardrails!.check(id, texts, {
          direction,
          agent: key ? { name: key.name, agent_id: key.agentId, team: key.team } : undefined,
          provider: (slug) => ctx.registry?.providersBySlug.get(slug),
        }),
      ),
    );
    for (let res of results) {
      if (!res || res.verdict === 'clean') continue;
      // A second service masking works on what the first already masked: ask it again about that.
      if (maskedOnce && res.masked && g.compiled.action === 'mask') {
        const again = await ctx.guardrails.check(res.service.id, texts, { direction, agent: key ? { name: key.name, agent_id: key.agentId, team: key.team } : undefined, provider: (slug) => ctx.registry?.providersBySlug.get(slug) });
        if (!again || again.verdict === 'clean') continue;
        res = again;
      }
      const failed = res.verdict === 'error';
      let action: InspectAction = failed ? (g.rule.config.services_on_error === 'block' ? 'block' : 'flag') : g.compiled.action;
      // Masking needs the service to say exactly what; otherwise the content is withheld.
      if (action === 'mask' && !res.masked) action = 'block';
      if (opts.streamed) action = 'flag';
      const o: GateOutcome<R> = {
        ruleId: g.rule.id,
        ruleName: g.rule.name,
        action,
        findings: failed ? { [`${res.service.kind === 'openai_moderation' ? 'openai' : res.service.kind}:unavailable`]: 1 } : res.findings,
        truncated: false,
        reason: failed ? `${res.service.name} could not be reached: ${res.reason}` : `${g.rule.config.reason ? `${g.rule.config.reason}. ` : ''}${res.reason ?? `${res.service.name} flagged it`}`,
        rule: g.rule,
      };
      r.outcomes.push(o);
      if (action === 'block') return { value: r.value, outcomes: r.outcomes, blocked: o };
      if (action === 'mask' && res.masked) {
        value = rebuild(res.masked);
        ({ texts, rebuild } = textLeaves(value, skipLeaf));
        maskedOnce = true;
      }
    }
  }
  return { value, outcomes: r.outcomes, blocked: undefined };
}
