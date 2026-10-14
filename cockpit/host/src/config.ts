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

export async function writeCockpitConfig(config: CockpitConfig): Promise<void> {
  await fs.mkdir(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(COCKPIT_HOME, 0o700).catch(() => {})
  await fs.chmod(CONFIG_FILE, 0o600).catch(() => {})
}
