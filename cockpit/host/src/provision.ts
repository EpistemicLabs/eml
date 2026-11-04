import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CORE_INDEX, DATA_DIR } from './paths.js'
import { readCockpitConfig, updateCockpitConfig, writeCockpitConfig } from './config.js'

/**
 * Load or provision the home's brains.
 *
 * Source of truth = cockpit config token + control.db together. Reuse iff both
 * present; otherwise the host runs the first-run setup (setup.ts), which
 * provisions a fresh home with the names the user gave and persists the
 * returned tokens. Tokens are captured in-process + on disk only.
 *
 * v0.21 (decision cockpit-identity-agent-brain): a home has one human (the
 * handle) and any number of agents. An agent is a regular brain in control.db,
 * named after the agent id, seeded with its persona, its default rules and
 * its view of the human (core default-brain.ts); its token the host alone
 * holds (agents.ts). A space (the main brain, a further local brain) holds
 * work only: it gets the agent and user objects, no identity. Every token is
 * issued under the handle, so ingested_by names the human in every brain and
 * the host stamps the agent (brain-mcp.ts, x-eml-agent).
 */

const require = createRequire(import.meta.url)

export interface ProvisionedBrain {
  token: string
  brainId?: string
  reused: boolean
  /** 'pending' until the getting-started session has opened (onboarding.ts). */
  onboarding: 'pending' | 'done'
}

/** The names a fresh home is set up with (setup.ts validates them): the human and the first agent. */
export interface BrainIdentity {
  userId: string
  userName: string
  agentId: string
  agentName: string
}

/** The home's human as the brains know them: the handle (user id, token name) and the display name. */
export interface Human {
  handle: string
  name: string
}

/** An agent as the brains know it: the id (brain name, agent.<id> scope) and the display name. */
export interface AgentNames {
  id: string
  name: string
}

const controlPath = () => path.join(DATA_DIR, 'control.db')

export async function loadBrain(): Promise<ProvisionedBrain | null> {
  const config = await readCockpitConfig()
  if (!config || !fs.existsSync(controlPath())) return null
  return { token: config.token, reused: true, onboarding: config.onboarding ?? 'done' }
}

interface ProvisionOne {
  agent: AgentNames
  human: Human
  /** brains.name in control.db: the agent id for an agent brain, the space's name for a space. */
  name: string
  /** Seed the agent's identity (an agent brain) or the objects only (a space). */
  identity: boolean
}

/** The core module (bundled for the host; tests pass the workspace package). */
export type Core = {
  initControlDatabase: (path: string) => ControlDb
  provisionUser: (opts: Record<string, unknown>) => { brainId: string; tokenPlaintext: string }
  provisionBrain: (opts: Record<string, unknown>) => { brainId: string; tokenPlaintext: string }
  issueToken: (control: ControlDb, opts: { userId: string; brainId: string; name?: string | null }) => { tokenId: string; plaintext: string }
  revokeToken: (control: ControlDb, tokenId: string) => boolean
}
type ControlDb = { close(): void }
export const bundledCore = (): Core => require(CORE_INDEX) as Core

/** One control.db transaction's worth of work, the handle closed after it. */
function withControl<T>(core: Core, fn: (control: ControlDb) => T): T {
  fs.mkdirSync(path.join(DATA_DIR, 'brains'), { recursive: true })
  const control = core.initControlDatabase(controlPath())
  try {
    return fn(control)
  } finally {
    control.close()
  }
}

function provisionOne(opts: ProvisionOne, core: Core): { brainId: string; token: string } {
  return withControl(core, (control) => {
    const res = core.provisionUser({
      email: `${opts.human.handle}@local`,
      agentId: opts.agent.id,
      userId: opts.human.handle,
      agentName: opts.agent.name,
      userName: opts.human.name,
      control,
      dataDir: DATA_DIR,
      tokenName: opts.human.handle,
      name: opts.name,
      seedIdentity: opts.identity,
    })
    return { brainId: res.brainId, token: res.tokenPlaintext }
  })
}

/** A space's entry in the cockpit config: its token, display name and bound agent. */
export interface SpaceEntry {
  token: string
  name: string
  agent: string
}

/** The config gains a space (its token, name and agent); the home must have a config. */
export async function addSpaceToConfig(entry: SpaceEntry): Promise<void> {
  await updateCockpitConfig((current) => {
    if (!current) throw new Error('no cockpit config — the main brain is not provisioned')
    return { ...current, spaces: [...(current.spaces ?? []), entry] }
  })
}

/**
 * v0.21: the empty brain a shared space starts from (team-space.ts): control
 * rows and a token under the given id — the team brain's, from its creation
 * grant or its invite link — no seed, no genesis (core provisionBrain; the
 * relay's create or join brings the genesis). The token's name is the member
 * handle, so ingested_by in that brain names the member. Not added to the
 * config: that happens once the server took the brain (team-space.ts), and a
 * brain the server refused is discarded again.
 */
export function provisionTeamBrain(brainId: string, name: string, handle: string, core: Core = bundledCore()): { brainId: string; token: string } {
  return withControl(core, (control) => {
    const res = core.provisionBrain({ email: `${handle}@local`, brainId, name, control, dataDir: DATA_DIR, tokenName: handle })
    return { brainId: res.brainId, token: res.tokenPlaintext }
  })
}

/**
 * A token for a brain the host has none for (the boot sweep, team-space.ts):
 * issued under the brain's owner, revoked by the caller once it is done.
 */
export function issueBrainToken(brainId: string, ownerId: string, core: Core = bundledCore()): { tokenId: string; token: string } {
  return withControl(core, (control) => {
    const res = core.issueToken(control, { userId: ownerId, brainId, name: 'cockpit sweep' })
    return { tokenId: res.tokenId, token: res.plaintext }
  })
}

export function revokeBrainToken(tokenId: string, core: Core = bundledCore()): void {
  withControl(core, (control) => core.revokeToken(control, tokenId))
}

/**
 * A new agent of this home: its brain, named after the agent id and seeded
 * with the default persona, rules and the human's profile, and its host-only
 * token. Added to the cockpit config when the home has one; the first-run
 * setup writes the whole config itself (provisionBrain).
 */
export async function provisionAgent(agent: AgentNames, human: Human, core: Core = bundledCore()): Promise<{ brainId: string; token: string }> {
  const res = provisionOne({ agent, human, name: agent.id, identity: true }, core)
  await updateCockpitConfig((current) => current && { ...current, agents: [...(current.agents ?? []), { id: agent.id, token: res.token }] })
  return res
}

/**
 * A further local brain for a new space (Settings › Brain › New space): a
 * fresh brain owned by the same control-plane user, with its own token, no
 * identity of its own (that lives in the bound agent's brain) — the agent and
 * user objects only, so engrams in their scopes can be written here. Its
 * control-plane name is the space's name; the token goes to the cockpit config
 * with the name and the bound agent. The brain id comes back for the registry.
 */
export async function provisionSpace(name: string, agent: AgentNames, human: Human, core: Core = bundledCore()): Promise<{ brainId: string; token: string }> {
  const config = await readCockpitConfig()
  if (!config) throw new Error('no cockpit config — the main brain is not provisioned')
  const res = provisionOne({ agent, human, name, identity: false }, core)
  await addSpaceToConfig({ token: res.token, name, agent: agent.id })
  return res
}

/**
 * First run (setup.ts): the first agent's brain and the main space, then the
 * config naming the human, the agent and both tokens. The two names become the
 * ids — the agent's brain name and scope, the human's handle — fixed from here on.
 */
export async function provisionBrain(identity: BrainIdentity, core: Core = bundledCore()): Promise<ProvisionedBrain> {
  const human: Human = { handle: identity.userId, name: identity.userName }
  const agent: AgentNames = { id: identity.agentId, name: identity.agentName }
  const agentBrain = await provisionAgent(agent, human, core)
  const main = provisionOne({ agent, human, name: 'Main', identity: false }, core)
  await writeCockpitConfig({
    token: main.token,
    onboarding: 'pending',
    handle: human.handle,
    agent: agent.id,
    agents: [{ id: agent.id, token: agentBrain.token }],
  })
  return { token: main.token, brainId: main.brainId, reused: false, onboarding: 'pending' }
}
