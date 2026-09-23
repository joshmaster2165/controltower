import type { FlightBus } from '../events/bus.js';
import { describeFindings, type GateOutcome } from './scan.js';

/** One flight.decision per inspect gate that found something. */
export function emitInspectOutcomes(bus: FlightBus, flightId: string, outcomes: Array<GateOutcome<unknown>>, where: string, streamed = false): void {
  for (const o of outcomes) {
    const what = describeFindings(o.findings);
    const verb = o.action === 'block' ? 'blocked' : o.action === 'mask' ? 'masked' : 'flagged';
    bus.emit({
      t: 'flight.decision',
      flight_id: flightId,
      ts: Date.now(),
      decision: o.action === 'block' ? 'deny' : o.action === 'mask' ? 'mutate' : 'flagged',
      rule_id: o.ruleId,
      reason: `${verb} ${where}: ${what}${streamed ? ' (streamed reply: checked after delivery)' : ''}${o.truncated ? ' (partly scanned: over size limit)' : ''}`,
    });
  }
}

/** The message an agent (a model, and its developer) reads when content is blocked. */
export function blockedMessage(o: GateOutcome<unknown>, where: 'request' | 'response' | 'tool arguments' | 'tool result'): string {
  const what = describeFindings(o.findings);
  const lead =
    where === 'response' || where === 'tool result'
      ? `CONTROL_TOWER_CONTENT_BLOCKED: the ${where} was withheld because it contained ${what}.`
      : `CONTROL_TOWER_CONTENT_BLOCKED: this ${where === 'request' ? 'request' : 'tool call'} contains ${what}, which the gate "${o.ruleName}" does not allow.`;
  const tail = where === 'response' || where === 'tool result' ? ' Ask a human if you need this information.' : ' Remove that content and retry. Do not encode, split or obfuscate it to get past this check.';
  return `${lead}${o.reason ? ` ${o.reason}.` : ''}${tail}`;
}
