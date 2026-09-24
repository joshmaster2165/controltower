import type { AttentionItem, StationKind } from '../../airspace/scene';
import { Icon } from '../../components/Icon';

const GROUPS: Array<{ kind: AttentionItem['kind']; label: string; hint: string }> = [
  { kind: 'holding', label: 'Waiting for approval', hint: 'Held at a gate until someone decides' },
  { kind: 'blocked', label: 'Blocked now', hint: 'Calls denied by a gate in the last minute' },
  { kind: 'bypass', label: 'Outside the gateway', hint: 'Agents calling a provider directly: no gates or budgets apply' },
  { kind: 'errors', label: 'Failing', hint: 'Destinations with failed calls in the last minute' },
  { kind: 'ungated', label: 'Destructive tools with no gate', hint: 'Deletes, merges, payments and the like, in use, that nothing can stop or hold' },
  { kind: 'new', label: 'New connections', hint: 'An agent reached a model or tool it had not used before, in the last day' },
  { kind: 'spike', label: 'Unusual traffic', hint: 'Far above its usual rate' },
];

export type Attention = { items: AttentionItem[]; busiest: Array<{ id: string; label: string; kind: StationKind; rpm: number }> };

/**
 * What needs a person on this map, most urgent first. Picking an item opens
 * the team it is folded into, centres it and traces it; closing the trace
 * comes back here.
 */
export function AttentionPanel({ data, onPick, onPickStation, onClose }: { data: Attention; onPick: (item: AttentionItem) => void; onPickStation: (id: string) => void; onClose: () => void }) {
  const n = data.items.length;
  return (
    <div className="tower-drawer">
      <div className="card attention-panel">
        <div className="attention-head">
          <div>
            <div className="hint attention-kicker">Needs attention</div>
            <div className="attention-count">{n ? `${n} item${n === 1 ? '' : 's'}` : 'All clear'}</div>
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {n === 0 && (
          <div className="drawer-empty">
            <Icon name="check" size={14} /> Nothing needs attention right now
          </div>
        )}
        {GROUPS.map((g) => {
          const list = data.items.filter((i) => i.kind === g.kind);
          if (!list.length) return null;
          return (
            <section key={g.kind} className={`attention-group ${g.kind}`}>
              <h3 title={g.hint}>
                <i /> {g.label} <span className="hint">{list.length}</span>
              </h3>
              {list.slice(0, 12).map((it) => (
                <button key={`${it.kind}:${it.ref}:${it.title}`} className="attention-item" onClick={() => onPick(it)}>
                  <span className="t">{it.title}</span>
                  <span className="d">{it.detail}</span>
                </button>
              ))}
              {list.length > 12 && <div className="hint attention-more">and {list.length - 12} more</div>}
            </section>
          );
        })}
        {data.busiest.length > 0 && (
          <section className="attention-group busiest">
            <h3 title="The stations with the most calls in the last minute">Busiest now</h3>
            {data.busiest.map((b) => (
              <button key={b.id} className="attention-item row" onClick={() => onPickStation(b.id)}>
                <span className="t">{b.label}</span>
                <span className="rpm">{b.rpm.toLocaleString()}/min</span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
