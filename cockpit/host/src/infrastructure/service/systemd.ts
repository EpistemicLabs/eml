import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SERVICE_ENV, type Autostart, type AutostartSpec, type AutostartStatus } from '../../domain/autostart.js'

/**
 * Linux: a systemd user unit (~/.config/systemd/user/eml-cockpit-<port>.service).
 * Restart=always starts the host again after a crash and after the updater's
 * clean exit, as launchd's KeepAlive does; the unit name carries the port, so
 * 4317 (prod) and 4318 (dev) never collide.
 *
 * A user unit runs while its user is logged in. To start at boot and keep
 * running after the last logout (a server reached over SSH), the user needs
 * lingering (`loginctl enable-linger`), which takes root — install does not
 * ask for it, the status says when it is off.
 *
 * The unit runs the node that ran `service install` and puts its folder first
 * on PATH: the brain MCP server and the sessions start `node` from it. It names
 * that node by the path PATH reaches it through (a stable link such as
 * ~/.local/node/current/bin/node or /usr/bin/node) rather than by
 * process.execPath (the resolved, version-pinned folder), so a node update
 * behind the link carries over. Moving or removing that node means re-running
 * install.
 */

/** systemd expands %-specifiers in every value. */
const noSpecifiers = (s: string) => s.replace(/%/g, '%%')

/** One argument of ExecStart: quoted, and with $ kept from variable expansion. */
const execArg = (s: string) => `"${noSpecifiers(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`

const envLine = (key: string, value: string) =>
  `Environment="${key}=${noSpecifiers(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The unit file: the host's env, its log, and a restart after every exit. */
export function unitFile(spec: AutostartSpec, node: string): string {
  const pathEntries = [...new Set([path.dirname(node), '/usr/local/bin', '/usr/bin', '/bin'])]
  return [
    '# EML Cockpit autostart, written by `eml-cockpit service install`.',
    '[Unit]',
    `Description=EML Cockpit (port ${spec.port})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execArg(node)} ${execArg(spec.entry)}`,
    `WorkingDirectory=${noSpecifiers(spec.root)}`,
    envLine('COCKPIT_PORT', String(spec.port)),
    envLine('COCKPIT_NO_OPEN', '1'),
    envLine('EML_COCKPIT_HOME', spec.home),
    envLine(SERVICE_ENV, '1'),
    envLine('PATH', pathEntries.join(':')),
    `StandardOutput=append:${noSpecifiers(spec.log)}`,
    `StandardError=append:${noSpecifiers(spec.log)}`,
    // A clean exit is the updater switching versions: start the new one.
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer; message?: string }
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() || (e.message ?? '') }
  }
}

const systemctl = (args: string[]) => run('systemctl', ['--user', ...args])

/** The first `node` on PATH if it is the node running now, else process.execPath. */
export function stableNodePath(pathVar = process.env.PATH ?? '', running = process.execPath): string {
  let target: string
  try { target = fs.realpathSync(running) } catch { return running }
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'node')
    try { if (fs.realpathSync(candidate) === target) return candidate } catch { /* not here */ }
  }
  return running
}

/** Off when systemd knows the user has no lingering; null when it can't tell. */
function lingering(): boolean | null {
  const res = run('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'])
  if (!res.ok) return null
  return res.out.trim() === 'yes'
}

export function systemdAutostart(spec: AutostartSpec): Autostart {
  const label = `eml-cockpit-${spec.port}`
  const unitName = `${label}.service`
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const unit = path.join(configHome, 'systemd', 'user', unitName)

  const mustRun = (args: string[]) => {
    const res = systemctl(args)
    if (res.ok) return
    // No user manager to talk to: a `su`/`sudo -u` shell, or a container without systemd.
    const hint = /bus|XDG_RUNTIME_DIR/i.test(res.out)
      ? ' — systemd for this user is not reachable here; log in as this user (SSH or console), not through su or sudo'
      : ''
    throw new Error(`systemctl --user ${args.join(' ')} failed: ${res.out || 'unknown error'}${hint}`)
  }

  return {
    label,
    install() {
      fs.mkdirSync(path.dirname(unit), { recursive: true })
      fs.writeFileSync(unit, unitFile(spec, stableNodePath()))
      mustRun(['daemon-reload'])
      mustRun(['enable', unitName])
      // restart, not start: a reinstall over a running unit runs the new one.
      mustRun(['restart', unitName])
    },
    uninstall() {
      systemctl(['disable', '--now', unitName])
      fs.rmSync(unit, { force: true })
      systemctl(['daemon-reload'])
    },
    status(): AutostartStatus {
      const installed = fs.existsSync(unit)
      const res = installed ? systemctl(['show', unitName, '--property=ActiveState,MainPID']) : { ok: false, out: '' }
      const active = /^ActiveState=active$/m.test(res.out)
      const pid = active ? Number(res.out.match(/^MainPID=(\d+)$/m)?.[1]) || null : null
      const note = installed && lingering() === false
        ? `lingering is off: the cockpit runs only while you are logged in. To start it at boot: sudo loginctl enable-linger ${os.userInfo().username}`
        : undefined
      return { installed, running: pid !== null, pid, where: unit, note }
    },
  }
}
