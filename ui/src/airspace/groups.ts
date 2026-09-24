import type { TopologyKey } from '../api';

/**
 * Agent groups: keys that share an agent id are one agent running as several
 * copies (replicas, workers, one key per tenant). The map draws each group as
 * a single station, `group:<agent id>`, so 1,500 keys of 60 agents read as 60.
 */
export const GROUP_PREFIX = 'group:';
export const isGroup = (stationId: string): boolean => stationId.startsWith(GROUP_PREFIX);
export const groupStation = (agentId: string): string => `${GROUP_PREFIX}${agentId}`;

/** Agent id → its keys, for agent ids carried by more than one key. */
export function agentGroups(keys: TopologyKey[]): Map<string, TopologyKey[]> {
  const by = new Map<string, TopologyKey[]>();
  for (const k of keys) {
    if (!k.agent_id) continue;
    const list = by.get(k.agent_id);
    if (list) list.push(k);
    else by.set(k.agent_id, [k]);
  }
  for (const [id, list] of by) if (list.length < 2) by.delete(id);
  return by;
}

/** Key id → the station that draws it (its group, or the key itself). */
export function keyStations(keys: TopologyKey[], groups = agentGroups(keys)): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of keys) out.set(k.id, k.id);
  for (const [agentId, list] of groups) for (const k of list) out.set(k.id, groupStation(agentId));
  return out;
}

/**
 * Teams: at the organization level the map draws one station per team
 * (`team:<name>`), each opening into its agents.
 */
export const TEAM_PREFIX = 'team:';
export const isTeam = (stationId: string): boolean => stationId.startsWith(TEAM_PREFIX);
export const teamStation = (team: string): string => `${TEAM_PREFIX}${team}`;

/** How zones and gate drafts refer to an agent station. */
export const agentRef = (stationId: string): string => (isGroup(stationId) || isTeam(stationId) ? stationId : `key:${stationId}`);
