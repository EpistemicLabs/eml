import * as fs from 'node:fs'
import { AGENTS_FILE, COCKPIT_HOME } from './paths.js'
import { PROVIDER_IDS, type ProviderId } from './domain/agent-provider.js'

/**
 * agents.json: which agent CLI new sessions start with (Settings › Models),
 * next to the providers' own settings. Read on every use, so a change applies
 * to the next session without a restart.
 */

/** agents.json as it is. */
export function readAgentSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export const isProviderId = (value: unknown): value is ProviderId =>
  (PROVIDER_IDS as readonly unknown[]).includes(value)

/** The user's choice, or undefined when they never made one. */
export function readDefaultProvider(): ProviderId | undefined {
  const value = readAgentSettings().defaultProvider
  return isProviderId(value) ? value : undefined
}

/** Merge `patch` into agents.json. */
export function writeAgentSettings(patch: Record<string, unknown>): void {
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  fs.writeFileSync(AGENTS_FILE, JSON.stringify({ ...readAgentSettings(), ...patch }, null, 2) + '\n', { mode: 0o600 })
}

export function writeDefaultProvider(id: ProviderId): void {
  writeAgentSettings({ defaultProvider: id })
}
