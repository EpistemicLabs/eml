import * as fs from 'node:fs'
import * as path from 'node:path'
import { CODEX_CONFIG_DIR, CODEX_RUNTIME_DIR } from '../../../paths.js'
import {
  ManagedRuntime, downloadTo, fetchText, fileDigest, isVersion, run,
  type RuntimeSource,
} from '../managed-runtime.js'
import { platform } from '../../platform/index.js'

/**
 * The cockpit's own Codex CLI (managed-runtime.ts), under <home>/codex.
 *
 * Source: the npm registry, where OpenAI publishes Codex. `@openai/codex` is a
 * small launcher; the CLI itself is one package per platform, published as the
 * version `<v>-<platform>` of the same name. Its tarball holds
 * `package/vendor/<target>/` with `bin/codex` and the files it needs next to it
 * (codex-path, codex-resources) — that directory becomes versions/<v>.
 *
 * Checked: the tarball against the sha512 the registry lists for that version,
 * and on macOS the binary's code signature against OpenAI's team id. The npm
 * launcher is not used: it only locates and starts the binary.
 *
 * Not installed unasked: the first install is the user's choice (Settings ›
 * Models › Codex), the download is a few hundred MB. Once installed it updates
 * like Claude Code. Codex's own update check stays off in sessions
 * (check_for_update_on_startup in the app's config.toml).
 */

const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE = '@openai/codex'
const OPENAI_TEAM_ID = '2DC432GLL2'
const UNPACK_TIMEOUT_MS = 5 * 60_000

interface RegistryVersion {
  version?: string
  dist?: { tarball?: string; integrity?: string }
}

const source: RuntimeSource = {
  label: 'Codex',
  logTag: 'codex-runtime',
  // An npm dist-tag.
  channel: 'latest',
  entry: path.join('bin', platform.exe('codex')),

  async latestVersion(channel) {
    const { version } = JSON.parse(await fetchText(`${REGISTRY}/${PACKAGE}/${channel}`)) as RegistryVersion
    if (!isVersion(version)) throw new Error(`npm dist-tag '${channel}' of ${PACKAGE} names no release version`)
    return version
  },

  async fetch(version, dir, log) {
    const platformKey = platform.runtimeKey()
    const { dist } = JSON.parse(await fetchText(`${REGISTRY}/${PACKAGE}/${version}-${platformKey}`)) as RegistryVersion
    const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(dist?.integrity ?? '')?.[1]
    if (!dist?.tarball?.startsWith(`${REGISTRY}/${PACKAGE}/-/`) || !integrity) {
      throw new Error(`no ${platformKey} build of Codex ${version} on the npm registry`)
    }

    const tarball = path.join(dir, 'package.tgz')
    const unpacked = path.join(dir, 'unpacked')
    log(`downloading Codex ${version} (${platformKey})…`)
    await downloadTo(dist.tarball, tarball)
    if ((await fileDigest(tarball, 'sha512', 'base64')) !== integrity) throw new Error('checksum does not match the npm registry')

    fs.mkdirSync(unpacked)
    // The package unpacks to a few hundred MB: minutes on a slow disk, not the
    // 30 s of a version check.
    const tar = await run(platform.tarBin(), ['-xzf', tarball, '-C', unpacked], platform.minimalEnv(), UNPACK_TIMEOUT_MS)
    if (tar.code !== 0) throw new Error(`could not unpack the Codex package: ${tar.stderr.trim().slice(0, 200)}`)
    const vendor = path.join(unpacked, 'package', 'vendor')
    const targets = fs.existsSync(vendor) ? fs.readdirSync(vendor) : []
    if (targets.length !== 1 || !fs.existsSync(path.join(vendor, targets[0], source.entry))) {
      throw new Error(`the Codex package does not have the expected layout (vendor/<target>/${source.entry})`)
    }
    // versions/<v>/ = the target directory itself: bin/, codex-path/, codex-resources/.
    for (const name of fs.readdirSync(path.join(vendor, targets[0]))) {
      fs.renameSync(path.join(vendor, targets[0], name), path.join(dir, name))
    }
    fs.rmSync(unpacked, { recursive: true, force: true })
    fs.rmSync(tarball, { force: true })
    await platform.verifyCodeSignature(path.join(dir, source.entry), OPENAI_TEAM_ID, 'OpenAI')
  },

  // A neutral env: the app's own Codex home, never the user's ~/.codex.
  selfTestEnv: () => ({ ...platform.minimalEnv(), CODEX_HOME: CODEX_CONFIG_DIR }),

  // "codex-cli 0.162.1"
  reportedVersion: (stdout) => stdout.trim().split(/\s+/).pop() ?? '',
}

export const codexRuntime = new ManagedRuntime(CODEX_RUNTIME_DIR, 'codex', source, { installUnasked: false })
