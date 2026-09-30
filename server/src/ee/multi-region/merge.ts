/**
 * Combining what regions answer with the control plane's own (Enterprise): sums of traffic and spend, the map's
 * connections added up, lists merged. Regions share one configuration, so keys, models and tool servers carry the
 * same ids everywhere.
 */
type Row = Record<string, any>;
const n = (v: unknown) => Number(v ?? 0);

/** Sum rows that share a key, field by field. */
function sumBy(rows: Row[], key: (r: Row) => string, fields: string[], extra?: (into: Row, r: Row) => void): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const k = key(r);
    const cur = out.get(k);
    if (!cur) {
      out.set(k, { ...r });
      continue;
    }
    for (const f of fields) cur[f] = n(cur[f]) + n(r[f]);
    extra?.(cur, r);
  }
  return [...out.values()];
}

export function mergeLedger(local: Row, remotes: Row[]): Row {
  const all = [local, ...remotes];
  const byDeployment = sumBy(
    all.flatMap((s) => s.by_deployment ?? []),
    (r) => String(r.deployment_id),
    ['requests', 'cost_nanousd', 'in_tokens', 'out_tokens', 'lat_sum_ms', 'lat_count'],
  ).map((r) => ({ ...r, avg_ms: n(r.lat_count) > 0 ? n(r.lat_sum_ms) / n(r.lat_count) : null }));
  return {
    ...local,
    by_key: sumBy(all.flatMap((s) => s.by_key ?? []), (r) => String(r.key_id), ['requests', 'errors', 'denied', 'cost_nanousd', 'in_tokens', 'out_tokens']),
    by_deployment: byDeployment,
    series: sumBy(all.flatMap((s) => s.series ?? []), (r) => String(r.bucket), ['requests', 'cost_nanousd', 'errors']).sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
  };
}

export function mergeTopology(local: Row, remotes: Row[]): Row {
  const all = [local, ...remotes];
  // Connections: the same agent → target → tool, anywhere, summed; its last minute added bucket by bucket.
  const edges = sumBy(
    all.flatMap((t) => t.edges ?? []),
    (e) => `${e.key_id}>${e.target_id}|${e.tool ?? ''}`,
    ['requests', 'errors', 'denied', 'cost_nanousd'],
    (into, e) => {
      into.last_ts = Math.max(n(into.last_ts), n(e.last_ts));
      into.keys = Math.max(n(into.keys), n(e.keys));
      if (e.first_ts) into.first_ts = into.first_ts ? Math.min(n(into.first_ts), n(e.first_ts)) : e.first_ts;
      const buckets = new Map<number, number>((into.recent ?? []) as Array<[number, number]>);
      for (const [b, c] of (e.recent ?? []) as Array<[number, number]>) buckets.set(b, (buckets.get(b) ?? 0) + c);
      into.recent = [...buckets].sort((a, b) => a[0] - b[0]);
    },
  );
  // Agents: every install lists the same keys; a built-in key busy in a region shows up too.
  const keys = new Map<string, Row>();
  for (const t of all) for (const k of t.keys ?? []) if (!keys.has(k.id)) keys.set(k.id, k);
  // Tool servers: the routes and methods seen anywhere.
  const servers = new Map<string, Row>();
  for (const t of all)
    for (const s of t.mcp_servers ?? []) {
      const cur = servers.get(s.id);
      if (!cur) servers.set(s.id, { ...s, tools: [...(s.tools ?? [])] });
      else for (const tool of s.tools ?? []) if (!cur.tools.some((x: Row) => x.name === tool.name)) cur.tools.push(tool);
    }
  const delegations = sumBy(
    all.flatMap((t) => t.delegations ?? []),
    (d) => `${d.from}>${d.key_id}`,
    ['requests'],
    (into, d) => void (into.last_ts = Math.max(n(into.last_ts), n(d.last_ts))),
  );
  const since = all.map((t) => n(t.paths_since)).filter((x) => x > 0);
  return { ...local, keys: [...keys.values()], mcp_servers: [...servers.values()], edges, delegations, ...(since.length ? { paths_since: Math.min(...since) } : {}) };
}
