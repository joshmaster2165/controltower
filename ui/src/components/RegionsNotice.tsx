/**
 * On a control plane with regions (Enterprise): the regions whose calls a page couldn't include just now, named —
 * so nothing is missing without saying so.
 */
export function RegionsNotice({ regions }: { regions?: Record<string, string> | undefined }) {
  const missing = Object.entries(regions ?? {}).filter(([, v]) => v !== 'ok').map(([k]) => k);
  if (!missing.length) return null;
  return (
    <div className="notice-row" role="status">
      <span>
        {missing.length === 1 ? `Region ${missing[0]} didn't answer: its calls aren't included here.` : `Regions ${missing.join(', ')} didn't answer: their calls aren't included here.`} They keep serving; this fills in once they're reachable.
      </span>
    </div>
  );
}
