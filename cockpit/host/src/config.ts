import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, CONFIG_FILE } from './paths.js'

/**
 * Cockpit-local config: the loopback brain tokens (on-disk, chmod 600, never
 * exposed to the browser) and whether the first-run onboarding session is
 * still to be opened. Distinct from ~/.eml-app/config (the web app's
 * hosted-brain token) so the two never clobber each other. The loopback baseUrl is
 * NOT stored — it is a fresh dynamic port each run, computed at boot.
 */

export interface CockpitConfig {
  /** Token of the main brain (the one the home was provisioned with). */
  token: string
  /**
   * 'pending' from the first-run setup until the getting-started session has
   * opened (onboarding.ts). Absent on homes made before it existed = done.
   */
  onboarding?: 'pending' | 'done'
  /** Display name of the main space (Settings › Brain); absent = "Main". */
  mainName?: string
  /**
   * Further local brain spaces (brain-space.ts): token + display name each;
   * which brain a token belongs to comes from control.db at boot. Absent = main only.
   */
  spaces?: Array<{ token: string; name?: string }>
}

export async function readCockpitConfig(): Promise<CockpitConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CockpitConfig>
    if (!parsed.token) return null
    const spaces = Array.isArray(parsed.spaces)
      ? parsed.spaces
          .filter((s): s is { token: string; name?: string } => !!s && typeof s.token === 'string' && !!s.token)
          .map((s) => ({ token: s.token, ...(typeof s.name === 'string' && s.name.trim() ? { name: s.name.trim() } : {}) }))
      : []
    return {
      token: parsed.token,
      ...(parsed.onboarding === 'pending' || parsed.onboarding === 'done' ? { onboarding: parsed.onboarding } : {}),
      ...(typeof parsed.mainName === 'string' && parsed.mainName.trim() ? { mainName: parsed.mainName.trim() } : {}),
      ...(spaces.length ? { spaces } : {}),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
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
