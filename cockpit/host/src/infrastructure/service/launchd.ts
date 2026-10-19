import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SERVICE_ENV, type Autostart, type AutostartSpec, type AutostartStatus } from '../../domain/autostart.js'

/**
 * macOS: a LaunchAgent (gui/<uid>). KeepAlive restarts the host after a crash
 * and after the updater's exit; the label carries the port, so 4317 (prod) and
 * 4318 (dev) never collide.
 *
 * PATH note: launchd hands processes a minimal PATH without Homebrew, but the
 * host spawns `node`. install captures the absolute node dir now and bakes it
 * into the unit — so moving the repo or reinstalling node means re-running
 * install. Claude Code is not taken from PATH: the cockpit brings its own
 * (providers/claude/runtime.ts).
 */

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

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer }
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() }
  }
}

export function launchdAutostart(spec: AutostartSpec): Autostart {
  const uid = process.getuid?.() ?? 0
  const label = `io.engramprotocol.cockpit.${spec.port}`
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

  const plistText = (): string => {
    const nodeBin = resolveNodeBin()
    const pathEntries = [...new Set([path.dirname(nodeBin), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
    const rows: Array<[string, string]> = [
      ['COCKPIT_PORT', String(spec.port)],
      ['COCKPIT_NO_OPEN', '1'],
      ['EML_COCKPIT_HOME', spec.home],
      [SERVICE_ENV, '1'],
      ['PATH', pathEntries.join(':')],
    ]
    const env = rows.map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${spec.entry}</string>
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
  <string>${spec.root}</string>
  <key>StandardOutPath</key>
  <string>${spec.log}</string>
  <key>StandardErrorPath</key>
  <string>${spec.log}</string>
</dict>
</plist>
`
  }

  return {
    label,
    install() {
      fs.mkdirSync(path.dirname(plist), { recursive: true })
      // A prior unit must go before bootstrap, or launchd rejects the load.
      if (fs.existsSync(plist)) launchctl(['bootout', `gui/${uid}`, plist])
      fs.writeFileSync(plist, plistText())
      const res = launchctl(['bootstrap', `gui/${uid}`, plist])
      if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out || 'unknown error'}`)
    },
    uninstall() {
      launchctl(['bootout', `gui/${uid}`, plist])
      fs.rmSync(plist, { force: true })
    },
    status(): AutostartStatus {
      const installed = fs.existsSync(plist)
      const res = installed ? launchctl(['list', label]) : { ok: false, out: '' }
      const pid = res.ok ? Number(res.out.match(/"PID"\s*=\s*(\d+)/)?.[1]) || null : null
      return { installed, running: pid !== null, pid, where: plist }
    },
  }
}
