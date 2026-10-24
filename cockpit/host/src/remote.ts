import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { REMOTE_FILE } from './paths.js'
import { readRemoteAccess, writeRemoteAccess } from './remote-access.js'

/**
 * `eml-cockpit remote enable|disable|status` — reach this cockpit from the
 * other devices of your tailnet (laptop, phone) at https://<host>.<tailnet>.ts.net.
 *
 * enable asks tailscale for this machine's name and the signed-in user, has
 * `tailscale serve` proxy that https address to the cockpit on 127.0.0.1, and
 * lets exactly that origin and that user in (remote.json, remote-access.ts).
 * tailscale serve needs root or the tailscale operator; a user without either
 * (an agent account kept away from tailscale on purpose) has an admin start
 * the proxy once, and enable then finds it running.
 * More users: --user <login>, repeatable. disable stops the proxy and empties
 * the list. The cockpit itself never listens beyond 127.0.0.1.
 */

const PORT = Number(process.env.COCKPIT_PORT) || 4317
// Where the tailscale CLI is: on PATH (Linux, Windows, a Homebrew install), or inside the macOS app.
const TAILSCALE_CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

interface TailscaleSelf {
  dnsName: string
  login: string
  certDomains: string[]
}

function tailscaleBin(): string {
  for (const bin of TAILSCALE_CANDIDATES) {
    try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return bin } catch { /* next */ }
  }
  throw new Error('tailscale is not installed or not on PATH. Install it from https://tailscale.com/download and sign in first.')
}

function tailscale(bin: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString() }
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer; message?: string }
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() || (e.message ?? '') }
  }
}

/** This machine's tailnet name, its signed-in user and whether HTTPS certificates are on. */
export function parseTailscaleStatus(json: string): TailscaleSelf {
  const status = JSON.parse(json) as {
    BackendState?: string
    Self?: { DNSName?: string; UserID?: number }
    User?: Record<string, { LoginName?: string }>
    CertDomains?: string[] | null
  }
  if (status.BackendState !== 'Running' || !status.Self?.DNSName) {
    throw new Error('tailscale is not connected. Run `tailscale up` (or open the Tailscale app) and sign in first.')
  }
  const login = status.User?.[String(status.Self.UserID)]?.LoginName ?? ''
  if (!login) throw new Error('could not tell which tailnet user this machine belongs to (tailscale status).')
  return {
    dnsName: status.Self.DNSName.replace(/\.$/, '').toLowerCase(),
    login: login.toLowerCase(),
    certDomains: status.CertDomains ?? [],
  }
}

/** Whether `tailscale serve status --json` already proxies https port `httpsPort` to `target`. */
export function proxiesTo(json: string, httpsPort: number, target: string): boolean {
  try {
    const web = (JSON.parse(json) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {}
    return Object.entries(web).some(([hostPort, site]) =>
      hostPort.endsWith(`:${httpsPort}`) && Object.values(site.Handlers ?? {}).some((h) => h.Proxy === target))
  } catch { return false }
}

function originFor(dnsName: string, httpsPort: number): string {
  return httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`
}

function parseArgs(argv: string[]): { httpsPort: number; users: string[] } {
  let httpsPort = 443
  const users: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--https-port') httpsPort = Number(argv[++i])
    else if (argv[i] === '--user') users.push((argv[++i] ?? '').toLowerCase())
    else throw new Error(`unknown option ${argv[i]}`)
  }
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) throw new Error('--https-port takes a port number')
  if (users.some((u) => !u)) throw new Error('--user takes a Tailscale login, e.g. you@example.com')
  return { httpsPort, users }
}

function enable(argv: string[]): void {
  const { httpsPort, users } = parseArgs(argv)
  const bin = tailscaleBin()
  const status = tailscale(bin, ['status', '--json'])
  if (!status.ok) throw new Error(`tailscale status failed: ${status.out}`)
  const self = parseTailscaleStatus(status.out)

  const target = `http://127.0.0.1:${PORT}`
  const serving = tailscale(bin, ['serve', 'status', '--json'])
  const served = serving.ok && proxiesTo(serving.out, httpsPort, target)
  const serve = served ? { ok: true, out: '' } : tailscale(bin, ['serve', '--bg', `--https=${httpsPort}`, target])
  if (!serve.ok) {
    const hint = /access denied|permission|operator/i.test(serve.out)
      ? `\nThis user may not run tailscale serve. Start the proxy once as an admin, then run this again:\n  sudo tailscale serve --bg --https=${httpsPort} ${target}\n(or let this user run tailscale: sudo tailscale set --operator=$USER)`
      : /not enabled|visit|login\.tailscale\.com/i.test(serve.out)
        ? '\nServe and HTTPS certificates are off for your tailnet: open the link above, turn them on, then run this again.'
        : ''
    throw new Error(`tailscale serve failed:\n${serve.out}${hint}`)
  }

  const origin = originFor(self.dnsName, httpsPort)
  const current = readRemoteAccess()
  writeRemoteAccess({
    origins: [...new Set([...current.origins, origin])],
    users: [...new Set([...current.users, self.login, ...users])],
  })
  const access = readRemoteAccess()
  process.stdout.write(
    `remote access on\n` +
    `  open:  ${origin}  (from any device signed in to your tailnet)\n` +
    `  users: ${access.users.join(', ')}\n` +
    `  file:  ${REMOTE_FILE}\n` +
    `Only those users get in; anyone else on the tailnet is refused. Off again: eml-cockpit remote disable\n`,
  )
}

function disable(argv: string[]): void {
  const { httpsPort } = parseArgs(argv)
  writeRemoteAccess({ origins: [], users: [] })
  let note = ''
  try {
    const bin = tailscaleBin()
    const off = tailscale(bin, ['serve', `--https=${httpsPort}`, 'off'])
    if (!off.ok) note = `\nThe cockpit refuses remote requests now. The tailscale proxy still runs; stop it as an admin: sudo tailscale serve --https=${httpsPort} off`
  } catch { /* no tailscale: nothing to stop */ }
  process.stdout.write(`remote access off: only this machine reaches the cockpit.${note}\n`)
}

function status(): void {
  const access = readRemoteAccess()
  if (!access.origins.length) {
    process.stdout.write(`remote access: off${fs.existsSync(REMOTE_FILE) ? ` (${REMOTE_FILE} lists no origin)` : ''}\n`)
    return
  }
  process.stdout.write(
    `remote access: on\n` +
    `  origins: ${access.origins.join(', ')}\n` +
    `  users:   ${access.users.length ? access.users.join(', ') : 'every user of the tailnet'}\n` +
    `  file:    ${REMOTE_FILE}\n`,
  )
  try {
    const out = tailscale(tailscaleBin(), ['serve', 'status'])
    process.stdout.write(`tailscale serve:\n${out.out.split('\n').map((l) => `  ${l}`).join('\n')}\n`)
  } catch { process.stdout.write('tailscale: not found\n') }
}

/** Handle a `remote …` invocation; returns true if it consumed the args. */
export async function runRemoteCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'remote') return false
  // `remote status | head` closes stdout early; don't crash on the broken pipe.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0) })
  const sub = argv[1]
  if (sub === 'enable') enable(argv.slice(2))
  else if (sub === 'disable') disable(argv.slice(2))
  else if (sub === 'status') status()
  else throw new Error('usage: eml-cockpit remote <enable|disable|status> [--https-port <port>] [--user <tailscale login>]')
  return true
}
