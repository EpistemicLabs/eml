import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_RUNTIME_DIR, CONFIG_DIR } from '../../../paths.js'
import {
  ManagedRuntime, downloadTo, fetchText, fileDigest, isVersion, maxVersion,
  type RuntimeSource,
} from '../managed-runtime.js'
import { platform } from '../../platform/index.js'

export { compareVersions, type RuntimeResult, type RuntimeState } from '../managed-runtime.js'

/**
 * The cockpit's own Claude Code (managed-runtime.ts), under <home>/claude.
 *
 * Source: Anthropic's release channel that claude.ai/install.sh uses — the
 * channel file names the version, <v>/manifest.json carries each platform's
 * sha256 + size, <v>/<platform>/claude is the standalone binary. Every binary
 * is checked against the manifest (and on macOS against Anthropic's code
 * signature). Claude's own updater stays off in every session
 * (DISABLE_AUTOUPDATER) — without it a cockpit-run claude installs a native
 * copy into the user's ~/.local.
 */

const RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW'

const source: RuntimeSource = {
  label: 'Claude Code',
  logTag: 'claude-runtime',
  channel: 'stable',
  entry: platform.exe('claude'),

  async latestVersion(channel) {
    const version = await fetchText(`${RELEASES}/${channel}`)
    if (!isVersion(version)) throw new Error(`release channel '${channel}' returned no version`)
    return version
  },

  async fetch(version, dir, log) {
    const platformKey = platform.runtimeKey({ musl: true })
    const manifest = JSON.parse(await fetchText(`${RELEASES}/${version}/manifest.json`)) as {
      platforms?: Record<string, { binary?: string; checksum?: string; size?: number }>
    }
    const entry = manifest.platforms?.[platformKey]
    if (!entry?.checksum || !/^[a-f0-9]{64}$/.test(entry.checksum)) {
      throw new Error(`no ${platformKey} build in the ${version} manifest`)
    }
    // The manifest names the file (claude, claude.exe); the version dir holds it as the entry.
    const binary = entry.binary ?? 'claude'
    if (binary !== source.entry) throw new Error(`unexpected binary '${binary}' in the ${version} manifest`)
    const bin = path.join(dir, source.entry)
    log(`downloading Claude Code ${version} (${platformKey}${entry.size ? `, ${Math.round(entry.size / 1e6)} MB` : ''})…`)
    await downloadTo(`${RELEASES}/${version}/${platformKey}/${binary}`, bin, 0o755)
    if (entry.size && fs.statSync(bin).size !== entry.size) throw new Error('size does not match the manifest')
    if ((await fileDigest(bin, 'sha256', 'hex')) !== entry.checksum) throw new Error('checksum does not match the manifest')
    await platform.verifyCodeSignature(bin, ANTHROPIC_TEAM_ID, 'Anthropic')
  },

  // A neutral env: no user HOME config, the app's own config dir, updater off.
  selfTestEnv: () => ({
    ...platform.minimalEnv(),
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    DISABLE_AUTOUPDATER: '1',
  }),

  reportedVersion: (stdout) => stdout.trim().split(/\s+/)[0],

  /**
   * The newest Claude Code this home's config has already run — written by Claude
   * Code itself into the cockpit's own .claude.json (never the user's). The floor
   * for the first install: no automatic downgrade below it.
   */
  floorVersion() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, '.claude.json'), 'utf8')) as Record<string, unknown>
      return maxVersion([cfg.lastOnboardingVersion, cfg.lastReleaseNotesSeen, cfg.firstStartVersion] as string[])
    } catch {
      return null
    }
  },
}

/** Sessions need Claude Code, so a home without one installs it on host start. */
export const claudeRuntime = new ManagedRuntime(CLAUDE_RUNTIME_DIR, 'claude', source, { installUnasked: true })

/** What sessions run (managed-runtime.ts, ManagedRuntime.bin). */
export const CLAUDE_BIN = claudeRuntime.bin
/** Prepended to every session's PATH, so `claude` inside a session is the cockpit's too. */
export const CLAUDE_BIN_DIR = claudeRuntime.binDir

export const readRuntimeState = () => claudeRuntime.readState()
export const currentVersion = () => claudeRuntime.currentVersion()
export const runtimeProblem = () => claudeRuntime.problem()
export const syncRuntime = (mode: 'install' | 'update') => claudeRuntime.sync(mode)
export const rollbackRuntime = () => claudeRuntime.rollback()
export const setAutoUpdate = (autoUpdate: boolean) => claudeRuntime.setAutoUpdate(autoUpdate)
export const scheduleRuntimeUpdates = () => claudeRuntime.scheduleUpdates()
