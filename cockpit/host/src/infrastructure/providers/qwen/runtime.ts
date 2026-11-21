import * as fs from 'node:fs'
import * as path from 'node:path'
import { QWEN_CONFIG_DIR, QWEN_RUNTIME_DIR } from '../../../paths.js'
import {
  ManagedRuntime, compareVersions, downloadTo, fetchText, fileDigest, isVersion, run,
  type RuntimeSource,
} from '../managed-runtime.js'
import { platform } from '../../platform/index.js'

/**
 * The cockpit's own Qwen Code (managed-runtime.ts), under <home>/qwen.
 *
 * Source: the npm registry, where the Qwen team publishes `@qwen-code/qwen-code`.
 * The package is a JavaScript bundle with no dependencies it needs at run time;
 * its tarball unpacks to `package/`, which becomes versions/<v>/package. Sessions
 * run its `cli-entry.js` with the host's node (index.ts, launch).
 *
 * Checked: the tarball against the sha512 the registry lists for that version.
 * A JavaScript package carries no code signature, so there is no second check
 * independent of the registry as Codex has. Instead a version is only taken
 * once it has been on the registry for COOLDOWN_MS: a version published from a
 * stolen npm account is usually found and pulled within hours.
 *
 * Not installed unasked: the first install is the user's choice (Settings ›
 * Models › Qwen Code). Once installed it updates like Codex. Qwen Code's own
 * update check stays off in sessions (general.disableAutoUpdate in the app's
 * settings.json).
 */

const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE = '@qwen-code/qwen-code'
export const COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000

interface Packument {
  'dist-tags'?: Record<string, string>
  time?: Record<string, string>
}

interface RegistryVersion {
  version?: string
  dist?: { tarball?: string; integrity?: string }
}

/**
 * The newest release version up to the one `channel` names that has been
 * published for at least COOLDOWN_MS; null when there is none.
 */
export function settledVersion(packument: Packument, channel: string, now: number): string | null {
  const tagged = packument['dist-tags']?.[channel]
  if (!isVersion(tagged)) return null
  const candidates = Object.entries(packument.time ?? {})
    .filter(([version, at]) => isVersion(version) && compareVersions(version, tagged) <= 0 && now - Date.parse(at) >= COOLDOWN_MS)
    .map(([version]) => version)
    .sort(compareVersions)
  return candidates.pop() ?? null
}

const source: RuntimeSource = {
  label: 'Qwen Code',
  logTag: 'qwen-runtime',
  // An npm dist-tag.
  channel: 'latest',
  entry: path.join('package', 'cli-entry.js'),

  async latestVersion(channel) {
    const packument = JSON.parse(await fetchText(`${REGISTRY}/${PACKAGE}`)) as Packument
    const version = settledVersion(packument, channel, Date.now())
    if (!version) throw new Error(`npm dist-tag '${channel}' of ${PACKAGE} names no release version published more than two days ago`)
    return version
  },

  async fetch(version, dir, log) {
    const { dist } = JSON.parse(await fetchText(`${REGISTRY}/${PACKAGE}/${version}`)) as RegistryVersion
    const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(dist?.integrity ?? '')?.[1]
    if (!dist?.tarball?.startsWith(`${REGISTRY}/${PACKAGE}/-/`) || !integrity) {
      throw new Error(`no tarball of Qwen Code ${version} on the npm registry`)
    }

    const tarball = path.join(dir, 'package.tgz')
    log(`downloading Qwen Code ${version}…`)
    await downloadTo(dist.tarball, tarball)
    if ((await fileDigest(tarball, 'sha512', 'base64')) !== integrity) throw new Error('checksum does not match the npm registry')
    const tar = await run(platform.tarBin(), ['-xzf', tarball, '-C', dir], platform.minimalEnv(), 5 * 60_000)
    if (tar.code !== 0) throw new Error(`could not unpack the Qwen Code package: ${tar.stderr.trim().slice(0, 200)}`)
    fs.rmSync(tarball, { force: true })
    if (!fs.existsSync(path.join(dir, source.entry))) {
      throw new Error(`the Qwen Code package does not have the expected layout (${source.entry})`)
    }
  },

  // A neutral env: the app's own Qwen home, and the host's node for the entry's `#!/usr/bin/env node`.
  selfTestEnv: () => {
    const env = platform.minimalEnv()
    return { ...env, PATH: [path.dirname(process.execPath), env.PATH].join(path.delimiter), QWEN_HOME: QWEN_CONFIG_DIR }
  },

  // "0.27.4"
  reportedVersion: (stdout) => stdout.trim().split(/\s+/).pop() ?? '',
}

export const qwenRuntime = new ManagedRuntime(QWEN_RUNTIME_DIR, 'qwen', source, { installUnasked: false })
