import { SimClient, type SimCallLog } from './client.js'
import type { TeamKey } from './types.js'

export const TEAM_WORLD_NAME = 'team1experiment'

/**
 * Create-or-join a world by name. Public endpoint; repeating the same normalised name
 * (lowercase, whitespace removed) returns the same world and the same reusable key.
 */
export async function mintWorld(baseUrl: string, teamName: string): Promise<TeamKey> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName }),
  })
  if (!response.ok) throw new Error(`POST /api/keys failed for "${teamName}": ${response.status} ${await response.text()}`)
  return (await response.json()) as TeamKey
}

export function normaliseTeamName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

export interface ComparisonWorlds {
  runId: string
  baseline: SimClient
  conductor: SimClient
  keys: { baseline: TeamKey; conductor: TeamKey }
}

/** Mint the two identical-seed worlds one comparison run needs. Never reuses a name, so every run starts at 08:00 with fresh seed data. */
export async function mintComparisonWorlds(
  baseUrl: string,
  runId: string,
  options: { prefix?: string; onCall?: (log: SimCallLog) => void } = {},
): Promise<ComparisonWorlds> {
  const prefix = options.prefix ?? 'homeward'
  const [baselineKey, conductorKey] = await Promise.all([
    mintWorld(baseUrl, `${prefix}-${runId}-baseline`),
    mintWorld(baseUrl, `${prefix}-${runId}-conductor`),
  ])
  const make = (key: TeamKey) =>
    new SimClient({ baseUrl, apiKey: key.apiKey, world: key.teamName, ...(options.onCall ? { onCall: options.onCall } : {}) })
  return {
    runId,
    baseline: make(baselineKey),
    conductor: make(conductorKey),
    keys: { baseline: baselineKey, conductor: conductorKey },
  }
}
