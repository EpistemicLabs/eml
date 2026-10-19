import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME, HOST_ROOT } from './paths.js'
import { CURRENT_HOST_ROOT, isManaged } from './app-update.js'
import { platform } from './infrastructure/platform/index.js'
import type { Autostart, AutostartSpec } from './domain/autostart.js'
import { launchdAutostart } from './infrastructure/service/launchd.js'
import { windowsAutostart } from './infrastructure/service/windows.js'

/**
 * `eml-cockpit service install|uninstall|status` — run the cockpit as a
 * per-user autostart service so it comes back after a reboot, a crash or an
 * update's restart (domain/autostart.ts).
 *
 * macOS: a launchd LaunchAgent; Windows: the user's Run key with a small
 * supervisor (infrastructure/service/). Linux (systemd --user) is a TODO. The
 * service is scoped to one cockpit home + port, so 4317 (prod) and 4318 (dev)
 * never collide. Only the built host is served; the dev cockpit (tsx watch)
 * stays a manual `pnpm cockpit:dev`.
 */

const PORT = Number(process.env.COCKPIT_PORT) || 4317
// An installed app (<home>/app/versions/<v>) runs through the `current` link, so
// an update only switches the link and restarts; a source checkout runs as is.
const SERVICE_ROOT = isManaged() ? CURRENT_HOST_ROOT : HOST_ROOT
const SPEC: AutostartSpec = {
  home: COCKPIT_HOME,
  port: PORT,
  entry: path.join(SERVICE_ROOT, 'dist', 'index.js'),
  root: SERVICE_ROOT,
  log: path.join(COCKPIT_HOME, 'host.log'),
}

function autostart(): Autostart {
  if (platform.os === 'darwin') return launchdAutostart(SPEC)
  if (platform.os === 'win32') return windowsAutostart(SPEC)
  throw new Error('service install is for macOS and Windows for now; Linux systemd --user is a TODO.')
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

function install(service: Autostart): void {
  if (!fs.existsSync(SPEC.entry)) {
    throw new Error(`built host not found at ${SPEC.entry} — run \`pnpm -F eml-cockpit build\` first.`)
  }
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  service.install()
  process.stdout.write(
    `installed ${service.label}\n` +
    `  home: ${COCKPIT_HOME}\n  port: ${PORT}\n  entry: ${SPEC.entry}\n  log: ${SPEC.log}\n` +
    `  registered: ${service.status().where}\nStarts now and on every login. Check: eml-cockpit service status\n`,
  )
}

function uninstall(service: Autostart): void {
  const { installed, where } = service.status()
  if (!installed) { process.stdout.write(`no service for port ${PORT} (${service.label})\n`); return }
  service.uninstall()
  process.stdout.write(`uninstalled ${service.label} (${where})\n`)
}

async function status(service: Autostart): Promise<void> {
  const { installed, running, pid, where } = service.status()
  const responds = await portResponds()
  process.stdout.write(
    `service ${service.label}\n` +
    `  installed: ${installed ? 'yes' : 'no'} (${where})\n` +
    `  running:   ${running ? 'yes' : 'no'}${pid ? ` (pid ${pid})` : ''}\n` +
    `  port ${PORT}: ${responds ? 'responds' : 'no response'}\n`,
  )
  try {
    const lines = fs.readFileSync(SPEC.log, 'utf8').trimEnd().split(/\r?\n/).slice(-8)
    process.stdout.write(`  last log (${SPEC.log}):\n${lines.map((l) => `    ${l}`).join('\n')}\n`)
  } catch { /* no log yet */ }
}

/** Handle a `service …` invocation; returns true if it consumed the args. */
export async function runServiceCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'service') return false
  // `service status | head` closes stdout early; don't crash on the broken pipe.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0) })
  const service = autostart()
  const sub = argv[1]
  if (sub === 'install') install(service)
  else if (sub === 'uninstall') uninstall(service)
  else if (sub === 'status') await status(service)
  else throw new Error('usage: eml-cockpit service <install|uninstall|status>')
  return true
}
