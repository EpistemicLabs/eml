import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SERVICE_ENV, type Autostart, type AutostartSpec, type AutostartStatus } from '../../domain/autostart.js'

/**
 * Windows: a value under the user's Run key (HKCU\…\CurrentVersion\Run), the
 * per-user autostart that needs no admin rights (a logon-triggered scheduled
 * task may), starting a small PowerShell supervisor (<home>\service\run.ps1):
 * it runs the host, and starts it again after an exit — at once after the
 * updater's clean exit, 10 s after a crash — as launchd's KeepAlive does.
 *
 * The supervisor runs with a hidden window, so the host has no console: it
 * writes its output to COCKPIT_LOG_FILE (log-file.ts). The supervisor's pid is
 * kept in <home>\service\supervisor.pid, so uninstall can stop it and the host.
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

function reg(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('reg.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer }
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The supervisor script: the host's env, then run it again whenever it exits. */
export function supervisorScript(spec: AutostartSpec, node: string, pidFile: string): string {
  const env: Array<[string, string]> = [
    ['COCKPIT_PORT', String(spec.port)],
    ['COCKPIT_NO_OPEN', '1'],
    ['EML_COCKPIT_HOME', spec.home],
    [SERVICE_ENV, '1'],
    ['COCKPIT_LOG_FILE', spec.log],
  ]
  return [
    '# EML Cockpit autostart supervisor, written by `eml-cockpit service install`.',
    ...env.map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
    `Set-Content -LiteralPath ${psQuote(pidFile)} -Value $PID`,
    `Set-Location -LiteralPath ${psQuote(spec.root)}`,
    'while ($true) {',
    `  & ${psQuote(node)} ${psQuote(spec.entry)}`,
    '  # A clean exit is the updater switching versions: start the new one at once.',
    '  if ($LASTEXITCODE -eq 0) { Start-Sleep -Seconds 1 } else { Start-Sleep -Seconds 10 }',
    '}',
    '',
  ].join('\r\n')
}

export function windowsAutostart(spec: AutostartSpec): Autostart {
  const label = `EML Cockpit ${spec.port}`
  const dir = path.join(spec.home, 'service')
  const script = path.join(dir, 'run.ps1')
  const pidFile = path.join(dir, 'supervisor.pid')
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script]
  // What the Run key starts at login: a command line, quoted the way Windows parses one.
  const commandLine = [powershell, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')

  const supervisorPid = (): number | null => {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
    } catch { return null }
  }

  const stop = () => {
    const pid = supervisorPid()
    // /T: the supervisor, the host it runs and the host's brain server.
    if (pid) try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
    fs.rmSync(pidFile, { force: true })
  }

  return {
    label,
    install() {
      fs.mkdirSync(dir, { recursive: true })
      stop()
      // With a BOM: Windows PowerShell 5.1 reads a script without one as ANSI,
      // which breaks every path with a character beyond ASCII (a user folder "Jürgen").
      fs.writeFileSync(script, `\ufeff${supervisorScript(spec, process.execPath, pidFile)}`, 'utf8')
      const res = reg(['add', RUN_KEY, '/v', label, '/t', 'REG_SZ', '/d', commandLine, '/f'])
      if (!res.ok) throw new Error(`could not register the autostart: ${res.out || 'reg.exe failed'}`)
      // Start now, as login will: through Start-Process, which gives the
      // supervisor a console of its own (then hidden). A detached child of node
      // gets none, and Windows PowerShell exits at once without one.
      const argList = args.map((a) => psQuote(/\s/.test(a) ? `"${a}"` : a)).join(',')
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath ${psQuote(powershell)} -WindowStyle Hidden -ArgumentList ${argList}`], { stdio: 'ignore' })
      const until = Date.now() + 15_000
      while (!supervisorPid()) {
        if (Date.now() > until) throw new Error(`the autostart is registered, but its supervisor did not start (${script})`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      }
    },
    uninstall() {
      stop()
      reg(['delete', RUN_KEY, '/v', label, '/f'])
      fs.rmSync(script, { force: true })
    },
    status(): AutostartStatus {
      const installed = reg(['query', RUN_KEY, '/v', label]).ok
      const pid = supervisorPid()
      return { installed, running: pid !== null, pid, where: `${RUN_KEY}\\${label}` }
    },
  }
}
