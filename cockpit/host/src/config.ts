import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, CONFIG_FILE } from './paths.js'
import { isSpaceColor, type SpaceColor } from './domain/space-color.js'

/**
 * Cockpit-local config: the loopback brain tokens (on-disk, chmod 600, never
 * exposed to the browser), the home's human and agents, and whether the
 * first-run onboarding session is still to be opened. Distinct from
 * ~/.eml-app/config (the web app's hosted-brain token) so the two never
 * clobber each other. The loopback baseUrl is NOT stored — it is a fresh
 * dynamic port each run, computed at boot.
 *
 * v0.21 (decision cockpit-identity-agent-brain): every agent is its own brain
 * (agents.ts), a space holds work only and binds one agent (`agent` on the
 * main space, `agent` on each entry of `spaces`). A home from before agent
 * brains has no `handle` and no `agents` until the agent upgrade sets them.
 */

export interface CockpitConfig {
  /** Token of the main brain (the one the home was provisioned with). */
  token: string
  /**
   * 'pending' from the first-run setup until the getting-started session has
   * opened (onboarding.ts). Absent on homes made before it existed = done.
   */
  onboarding?: 'pending' | 'done'
  /** Display name of the main space (Settings › Spaces); absent = "Main". */
  mainName?: string
  /** Colour of the main space (Settings › Spaces); absent = grey. */
  mainColor?: SpaceColor
  /**
   * The home's human: the handle every brain token is issued under, so
   * ingested_by names them in every brain. Set by the first-run setup or the
   * agent upgrade; absent before the upgrade.
   */
  handle?: string
  /** The agent the main space binds (an id of `agents`); absent = none bound. */
  agent?: string
  /**
   * Further local brain spaces (brain-space.ts): token, display name, the
   * bound agent and the colour the user chose for this cockpit (absent = grey)
   * each; which brain a token belongs to comes from control.db at boot.
   * Absent = main only.
   */
  spaces?: Array<{ token: string; name?: string; agent?: string; color?: SpaceColor }>
  /**
   * The home's agent brains (agents.ts): one brain per agent, named after the
   * agent id in control.db, with a token the host alone holds. `runtime`: the
   * agent runs in a runtime of its own (agent-runtime.ts), set by `agent
   * create`; a record gone missing then stops its sessions. Absent = the home's.
   */
  agents?: Array<{ id: string; token: string; runtime?: true }>
  /** What brain hygiene has offered per brain (brain id → state; brain-hygiene.ts). */
  hygiene?: Record<string, HygieneState>
}

/** When the hygiene banner was last started for one brain. */
export interface HygieneState {
  /** The brain schema whose migration findings were offered. */
  offeredSchema?: number
  /** When due reviews were last offered (ISO). */
  reviewsOfferedAt?: string
}

/**
 * An agent id: the brain's name in control.db, the agent.<id> scope and, after
 * the release merge, the id of the agent's runtime layer — one rule for all.
 */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A human handle: the token name and ingested_by, as the op log binds it (core HANDLE). */
export const HANDLE = /^[a-z0-9_-]{1,63}$/

const agentOf = (value: unknown): { agent: string } | Record<string, never> =>
  typeof value === 'string' && AGENT_ID.test(value) ? { agent: value } : {}

export async function readCockpitConfig(): Promise<CockpitConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CockpitConfig>
    if (!parsed.token) return null
    const spaces = Array.isArray(parsed.spaces)
      ? parsed.spaces
          .filter((s): s is { token: string; name?: string; agent?: string; color?: SpaceColor } => !!s && typeof s.token === 'string' && !!s.token)
          .map((s) => ({
            token: s.token,
            ...(typeof s.name === 'string' && s.name.trim() ? { name: s.name.trim() } : {}),
            ...agentOf(s.agent),
            ...(isSpaceColor(s.color) ? { color: s.color } : {}),
          }))
      : []
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents
          .filter((a): a is { id: string; token: string; runtime?: true } => !!a && typeof a.id === 'string' && AGENT_ID.test(a.id) && typeof a.token === 'string' && !!a.token)
          .map((a) => ({ id: a.id, token: a.token, ...(a.runtime === true ? { runtime: true as const } : {}) }))
      : []
    return {
      token: parsed.token,
      ...(parsed.onboarding === 'pending' || parsed.onboarding === 'done' ? { onboarding: parsed.onboarding } : {}),
      ...(typeof parsed.mainName === 'string' && parsed.mainName.trim() ? { mainName: parsed.mainName.trim() } : {}),
      ...(typeof parsed.handle === 'string' && HANDLE.test(parsed.handle) ? { handle: parsed.handle } : {}),
      ...agentOf(parsed.agent),
      ...(isSpaceColor(parsed.mainColor) ? { mainColor: parsed.mainColor } : {}),
      ...(spaces.length ? { spaces } : {}),
      ...(agents.length ? { agents } : {}),
      ...(readHygiene(parsed.hygiene) ?? {}),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function readHygiene(raw: unknown): { hygiene: Record<string, HygieneState> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, HygieneState> = {}
  for (const [brainId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const { offeredSchema, reviewsOfferedAt } = value as Record<string, unknown>
    out[brainId] = {
      ...(typeof offeredSchema === 'number' && Number.isInteger(offeredSchema) ? { offeredSchema } : {}),
      ...(typeof reviewsOfferedAt === 'string' ? { reviewsOfferedAt } : {}),
    }
  }
  return Object.keys(out).length ? { hygiene: out } : null
}

// Every write goes through one chain, so a read-modify-write (updateCockpitConfig)
// never interleaves with another write: two at once would each read the old file
// and the later write would drop the earlier change.
let writes: Promise<unknown> = Promise.resolve()

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = writes.then(fn, fn)
  writes = run.catch(() => {})
  return run
}

/** Replace the whole config (first-run provisioning). */
export function writeCockpitConfig(config: CockpitConfig): Promise<void> {
  return serialised(() => writeConfigFile(config))
}

/**
 * Change the config: `change` gets the current config (null when there is none)
 * and returns the new one, or null to leave the file as it is. Serialised with
 * every other write; resolves to what was written.
 */
export function updateCockpitConfig(change: (config: CockpitConfig | null) => CockpitConfig | null): Promise<CockpitConfig | null> {
  return serialised(async () => {
    const next = change(await readCockpitConfig())
    if (next) await writeConfigFile(next)
    return next
  })
}

async function writeConfigFile(config: CockpitConfig): Promise<void> {
  await fs.mkdir(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  // Write a temp file and rename it over the config: writeFile truncates first,
  // so a reader outside the write chain could otherwise see an empty file.
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, CONFIG_FILE)
  await fs.chmod(COCKPIT_HOME, 0o700).catch(() => {})
}
