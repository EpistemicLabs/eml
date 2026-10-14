import { execFileSync } from 'node:child_process'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { COCKPIT_HOME, HOST_ROOT } from './paths.js'
import { CURRENT_HOST_ROOT, isManaged } from './app-update.js'

/**
 * `eml-cockpit service install|uninstall|status` — run the cockpit as a
 * per-user autostart service so it comes back after a reboot or crash.
 *
 * macOS launchd (LaunchAgent) today; Linux (systemd --user) is a TODO. The
 * service is scoped to one cockpit home + port, so 4317 (prod) and 4318 (dev)
 * never collide — the label carries the port. Only the built host is served;
 * the dev cockpit (tsx watch) stays a manual `pnpm cockpit:dev`.
 *
 * PATH note: launchd hands processes a minimal PATH without Homebrew, but the
 * host spawns `node`. install captures the absolute node dir now and bakes it
 * into the unit — so moving the repo or reinstalling node means re-running
 * install. Claude Code is not taken from PATH: the cockpit brings its own
 * (providers/claude/runtime.ts).
 */

const uid = process.getuid?.() ?? 0
const PORT = Number(process.env.COCKPIT_PORT) || 4317
const LABEL = `io.engramprotocol.cockpit.${PORT}`
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
// An installed app (<home>/app/versions/<v>) runs through the `current` link, so
// an update only switches the link and restarts; a source checkout runs as is.
const SERVICE_ROOT = isManaged() ? CURRENT_HOST_ROOT : HOST_ROOT
const ENTRY = path.join(SERVICE_ROOT, 'dist', 'index.js')
const LOG = path.join(COCKPIT_HOME, 'host.log')

function whichDir(bin: string): string | null {
  try {
    const found = execFileSync('/usr/bin/which', [bin], {
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    }).toString().trim()
    return found ? path.dirname(found) : null
  } catch { return null }
}

// Prefer `which node` (the stable symlink, e.g. /opt/homebrew/bin/node) over
// process.execPath (a version-pinned Cellar path that a `brew upgrade node`
// deletes), so the unit survives node upgrades. Fall back to execPath.
function resolveNodeBin(): string {
  const dir = whichDir('node')
  return dir ? path.join(dir, 'node') : process.execPath
}

function servicePlist(): string {
  const nodeBin = resolveNodeBin()
  const nodeDir = path.dirname(nodeBin)
  const pathEntries = [...new Set([nodeDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
  const rows: Array<[string, string]> = [
    ['COCKPIT_PORT', String(PORT)],
    ['COCKPIT_NO_OPEN', '1'],
    ['EML_COCKPIT_HOME', COCKPIT_HOME],
    ['PATH', pathEntries.join(':')],
  ]
  const env = rows.map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${ENTRY}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${SERVICE_ROOT}</string>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
`
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer }
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() }
  }
}

function portResponds(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1')
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(1000)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

function servicePid(): string | null {
  const res = launchctl(['list', LABEL])
  if (!res.ok) return null
  const match = res.out.match(/"PID"\s*=\s*(\d+)/)
  return match ? match[1] : '-' // loaded but not running (e.g. between throttled restarts)
}

function install(): void {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`built host not found at ${ENTRY} — run \`pnpm -F eml-cockpit build\` first.`)
  }
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  // A prior unit must go before bootstrap, or launchd rejects the load.
  if (fs.existsSync(PLIST)) launchctl(['bootout', `gui/${uid}`, PLIST])
  fs.writeFileSync(PLIST, servicePlist())
  const res = launchctl(['bootstrap', `gui/${uid}`, PLIST])
  if (!res.ok) {
    throw new Error(`launchctl bootstrap failed: ${res.out || 'unknown error'}`)
  }
  process.stdout.write(
    `installed ${LABEL}\n` +
    `  home: ${COCKPIT_HOME}\n  port: ${PORT}\n  entry: ${ENTRY}\n  log: ${LOG}\n` +
    `  plist: ${PLIST}\nStarts now and on every login. Check: eml-cockpit service status\n`,
  )
}

function uninstall(): void {
  if (!fs.existsSync(PLIST)) { process.stdout.write(`no service for port ${PORT} (${LABEL})\n`); return }
  launchctl(['bootout', `gui/${uid}`, PLIST])
  fs.rmSync(PLIST)
  process.stdout.write(`uninstalled ${LABEL} (${PLIST})\n`)
}

async function status(): Promise<void> {
  const loaded = fs.existsSync(PLIST)
  const pid = loaded ? servicePid() : null
  const responds = await portResponds()
  process.stdout.write(
    `service ${LABEL}\n` +
    `  installed: ${loaded ? 'yes' : 'no'} (${PLIST})\n` +
    `  loaded:    ${pid !== null ? 'yes' : 'no'}${pid && pid !== '-' ? ` (pid ${pid})` : ''}\n` +
    `  port ${PORT}: ${responds ? 'responds' : 'no response'}\n`,
  )
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-8)
    process.stdout.write(`  last log (${LOG}):\n${lines.map((l) => `    ${l}`).join('\n')}\n`)
  } catch { /* no log yet */ }
}

/** Handle a `service …` invocation; returns true if it consumed the args. */
export async function runServiceCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'service') return false
  // `service status | head` closes stdout early; don't crash on the broken pipe.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0) })
  if (process.platform !== 'darwin') {
    throw new Error('service install is macOS-only for now (launchd); Linux systemd --user is a TODO.')
  }
  const sub = argv[1]
  if (sub === 'install') install()
  else if (sub === 'uninstall') uninstall()
  else if (sub === 'status') await status()
  else throw new Error('usage: eml-cockpit service <install|uninstall|status>')
  return true
}
