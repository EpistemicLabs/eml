import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CORE_INDEX, DATA_DIR } from './paths.js'
import { readCockpitConfig, updateCockpitConfig, writeCockpitConfig } from './config.js'

/**
 * Load or provision the persistent local brain.
 *
 * Source of truth = cockpit config token + control.db together. Reuse iff both
 * present; otherwise the host runs the first-run setup (setup.ts), which
 * provisions a fresh brain with the names the user gave and persists the
 * returned token. The token is captured in-process + on disk only.
 */

const require = createRequire(import.meta.url)

export interface ProvisionedBrain {
  token: string
  brainId?: string
  reused: boolean
  /** 'pending' until the getting-started session has opened (onboarding.ts). */
  onboarding: 'pending' | 'done'
}

/** The identity a fresh brain is provisioned with (setup.ts validates it). */
export interface BrainIdentity {
  userId: string
  userName: string
  agentId: string
  agentName: string
}

const controlPath = () => path.join(DATA_DIR, 'control.db')

export async function loadBrain(): Promise<ProvisionedBrain | null> {
  const config = await readCockpitConfig()
  if (!config || !fs.existsSync(controlPath())) return null
  return { token: config.token, reused: true, onboarding: config.onboarding ?? 'done' }
}

/**
 * A further local brain for a new space (Settings › Brain › New space): a
 * fresh brain seeded with the same user and agent as the main brain, owned
 * by the same control-plane user, with its own token. The brain's
 * control-plane name is the agent id, as for the main brain — the server
 * boots the agent of that name; `name` is the space's display name and goes
 * to the cockpit config with the token. The brain id comes back for the registry.
 */
export async function provisionSpace(name: string, identity: BrainIdentity): Promise<{ brainId: string; token: string }> {
  const config = await readCockpitConfig()
  if (!config) throw new Error('no cockpit config — the main brain is not provisioned')
  const core = require(CORE_INDEX)
  const control = core.initControlDatabase(controlPath())
  try {
    const res = core.provisionUser({
      email: `${identity.userId}@local`,
      agentId: identity.agentId,
      userId: identity.userId,
      agentName: identity.agentName,
      userName: identity.userName,
      control,
      dataDir: DATA_DIR,
      tokenName: identity.userId,
    })
    await updateCockpitConfig((current) => {
      if (!current) throw new Error('no cockpit config — the main brain is not provisioned')
      return { ...current, spaces: [...(current.spaces ?? []), { token: res.tokenPlaintext, name }] }
    })
    return { brainId: res.brainId, token: res.tokenPlaintext }
  } finally {
    control.close()
  }
}

export async function provisionBrain(identity: BrainIdentity): Promise<ProvisionedBrain> {
  // The brain name is the agent /boot loads, the token name is the
  // authorship handle (ingested_by): both are the slugs, fixed from here on.
  fs.mkdirSync(path.join(DATA_DIR, 'brains'), { recursive: true })
  const core = require(CORE_INDEX)
  const control = core.initControlDatabase(controlPath())
  try {
    const res = core.provisionUser({
      email: `${identity.userId}@local`,
      agentId: identity.agentId,
      userId: identity.userId,
      agentName: identity.agentName,
      userName: identity.userName,
      control,
      dataDir: DATA_DIR,
      tokenName: identity.userId,
    })
    await writeCockpitConfig({ token: res.tokenPlaintext, onboarding: 'pending' })
    return { token: res.tokenPlaintext, brainId: res.brainId, reused: false, onboarding: 'pending' }
  } finally {
    control.close()
  }
}
