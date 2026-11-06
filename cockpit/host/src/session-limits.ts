import * as fs from 'node:fs'
import { COCKPIT_HOME, LIMITS_FILE } from './paths.js'
import type { SessionLimits } from './domain/session-memory.js'

/**
 * limits.json (Settings › Preferences › Sessions): how much the sessions of this cockpit may
 * hold. Read on every use, so a change applies without a restart: the idle
 * stop and the running cap at the next check, a memory ceiling at the session's
 * next start.
 */

export interface LimitSettings {
  /** RAM per session in GB; 0: no ceiling. */
  memoryGb: number
  /** A session nobody is looking at stops after this many quiet hours. */
  idleHours: number
  /** Sessions whose process runs at the same time; 0: no cap. */
  maxRunning: number
}

export const DEFAULT_LIMITS: LimitSettings = { memoryGb: 2, idleHours: 1, maxRunning: 8 }

// Swap a session may use on top of its RAM: enough for a short peak, too little to fill the swap.
const SWAP_BYTES = 512 * 1024 * 1024
const GB = 1024 ** 3
const HOUR = 60 * 60 * 1000

const BOUNDS: Record<keyof LimitSettings, { min: number; max: number }> = {
  memoryGb: { min: 0, max: 1024 },
  idleHours: { min: 0.25, max: 24 * 7 },
  maxRunning: { min: 0, max: 200 },
}

const valid = (key: keyof LimitSettings, value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= BOUNDS[key].min && value <= BOUNDS[key].max
  && (key !== 'maxRunning' || Number.isInteger(value))

/** The settings, a default for every value missing or out of range. */
export function readLimits(file = LIMITS_FILE): LimitSettings {
  let stored: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch { /* none yet */ }
  const out = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof LimitSettings>) {
    if (valid(key, stored[key])) out[key] = stored[key]
  }
  return out
}

/** Merge a patch from Settings; returns the new settings, or why the patch was refused. */
export function writeLimits(patch: Record<string, unknown>, file = LIMITS_FILE): LimitSettings | string {
  const next = readLimits(file)
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_LIMITS)) return `unknown setting ${key}`
    if (!valid(key as keyof LimitSettings, value)) return `${key} must be a number from ${BOUNDS[key as keyof LimitSettings].min} to ${BOUNDS[key as keyof LimitSettings].max}`
    next[key as keyof LimitSettings] = value as number
  }
  if (file === LIMITS_FILE) fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

export function sessionLimits(settings: LimitSettings): SessionLimits {
  return { memoryBytes: settings.memoryGb > 0 ? Math.round(settings.memoryGb * GB) : null, swapBytes: SWAP_BYTES }
}

export const idleMs = (settings: LimitSettings): number => settings.idleHours * HOUR
