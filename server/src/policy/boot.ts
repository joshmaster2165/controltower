import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { applyPolicyImport, planPolicyImport } from './yaml.js';

export class BootPolicyError extends Error {}

/**
 * --policy / CT_POLICY: a policy YAML applied at every start, after the config
 * file and the admin key (it may name the models and agents they create).
 * merge (default) adds and updates the zones and gates it names; replace
 * (CT_POLICY_MODE=replace) makes the policy match the file. A file with
 * errors stops startup, so a bad policy is never half-applied.
 */
export async function loadBootPolicy(ctx: AppContext): Promise<void> {
  const file = ctx.config.policyFile;
  if (!file) return;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BootPolicyError(`Cannot read the policy file ${file}: ${(err as Error).message}`);
  }
  const plan = planPolicyImport(ctx, text, ctx.config.policyMode);
  if (plan.errors.length) throw new BootPolicyError(`The policy file ${file} has errors; nothing was applied:\n  - ${plan.errors.join('\n  - ')}`);
  for (const w of plan.warnings) ctx.log.warn(w);
  const n = (c: { create: string[]; update: string[]; remove: string[] }) => ({ added: c.create.length, changed: c.update.length, removed: c.remove.length });
  if ([plan.zones, plan.gates].some((c) => c.create.length + c.update.length + c.remove.length)) await applyPolicyImport(ctx, plan);
  ctx.log.info({ file, mode: plan.mode, zones: n(plan.zones), gates: n(plan.gates) }, 'policy loaded');
}
