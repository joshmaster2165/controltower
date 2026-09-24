import { useEffect, useRef, useState } from 'react';
import type { AirspaceScene, SearchHit } from '../../airspace/scene';
import { Icon } from '../../components/Icon';

const KIND_LABEL: Record<SearchHit['kind'], string> = { team: 'Team', agent: 'Agent', key: 'Key', model: 'Model', mcp: 'Server', tool: 'Tool', observed: 'Outside' };

/**
 * Find anything on the map by name — a team, an agent, one key of an agent
 * with many copies, a model, a tool server or a single tool — and jump to it:
 * its team opens if it is folded into one, and it is centred and traced.
 * "/" focuses the box from anywhere on the map.
 */
export function MapSearch({ scene, onReveal, panelWidth }: { scene: () => AirspaceScene | null; onReveal: (stationId: string) => void; panelWidth: number }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHits(scene()?.search(q) ?? []);
    setActive(0);
  }, [q, scene]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    const id = scene()?.reveal(h.ref, panelWidth);
    if (id) onReveal(id);
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="map-search" role="search">
      <Icon name="search" size={14} />
      <input
        ref={input}
        value={q}
        placeholder="Find on the map"
        aria-label="Find on the map"
        aria-expanded={open && hits.length > 0}
        aria-controls="map-search-results"
        role="combobox"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(hits.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            pick(hits[active]);
          } else if (e.key === 'Escape') {
            setQ('');
            input.current?.blur();
          }
        }}
      />
      {q ? (
        <button className="map-search-clear" onClick={() => setQ('')} aria-label="Clear search">
          ×
        </button>
      ) : (
        <kbd>/</kbd>
      )}
      {open && q.trim() && (
        <div className="map-search-results" id="map-search-results" role="listbox">
          {hits.length === 0 && <div className="empty">Nothing on the map matches “{q.trim()}”</div>}
          {hits.map((h, i) => (
            <button
              key={h.ref}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h)}
            >
              <span className={`kind ${h.kind}`}>{KIND_LABEL[h.kind]}</span>
              <span className="label">{h.label}</span>
              <span className="sub">{h.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
