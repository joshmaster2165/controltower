import type { AppContext } from '../context.js';
import type { KeyRecord } from '../registry.js';
import { runInspectors, textOfValue, type CompiledInspector, type GateOutcome, type InspectAction, type InspectConfig } from './scan.js';
import { GUARDRAIL_KEY_ID } from './model-check.js';

type Gate<R> = { rule: R; compiled: CompiledInspector };
type Result<R> = { value: unknown; outcomes: Array<GateOutcome<R>>; blocked: GateOutcome<R> | undefined };

/**
 * Inspect gates on a value: their detectors first, then — for gates that ask
 * for it — the model-based injection check on what is left. A model's verdict
 * can't be masked word by word, so a masking gate withholds the content
 * instead (it blocks); on a reply already streamed, it can only flag.
 */
export async function inspect<R extends { id: string; name: string; config: InspectConfig }>(
  ctx: Pick<AppContext, 'modelChecker'>,
  key: KeyRecord | undefined,
  gates: Array<Gate<R>>,
  direction: 'input' | 'output',
  value: unknown,
  opts: { streamed: boolean } = { streamed: false },
): Promise<Result<R>> {
  const r = runInspectors(gates, direction, value, opts);
  // The guardrail's own calls are never checked by a model: that would ask the model about itself, forever.
  if (r.blocked || key?.id === GUARDRAIL_KEY_ID) return r;
  const withModel = gates.filter((g) => g.rule.config.model_check?.model && (g.compiled.direction === 'both' || g.compiled.direction === direction));
  if (!withModel.length) return r;
  const text = textOfValue(r.value);
  if (!text.trim()) return r;
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
    r.outcomes.push(o);
    if (action === 'block') return { ...r, blocked: o };
  }
  return r;
}
