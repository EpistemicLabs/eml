import * as fs from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { COCKPIT_HOME, REMOTE_FILE } from './paths.js'

/**
 * Remote access through `tailscale serve` (eml-cockpit remote …, remote.ts).
 * The host stays bound to 127.0.0.1; tailscale on the same machine proxies
 * https://<host>.<tailnet>.ts.net to it and names the tailnet user of every
 * request in Tailscale-User-Login. remote.json (chmod 600) says what may come
 * in that way:
 *
 *   origins  the https origins the cockpit's page may be served from
 *   users    the Tailscale logins let in; empty = every user of the tailnet
 *
 * Off by default: no file, no remote request. It changes only from the command
 * line or the file, never from the browser, so nobody who is already in can
 * open it further. Read on every request (cached by mtime), so enable and
 * disable apply without a restart.
 */

export interface RemoteAccess {
  origins: string[]
  users: string[]
}

const EMPTY: RemoteAccess = { origins: [], users: [] }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The non-empty strings of a list, trimmed, normalized, each once. */
const strings = (v: unknown, normalize: (s: string) => string): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => normalize(s.trim())))] : []

let cache: { mtimeMs: number; value: RemoteAccess } | null = null

export function readRemoteAccess(file = REMOTE_FILE): RemoteAccess {
  let mtimeMs: number
  try { mtimeMs = fs.statSync(file).mtimeMs } catch { cache = null; return EMPTY }
  if (cache && cache.mtimeMs === mtimeMs && file === REMOTE_FILE) return cache.value
  let value = EMPTY
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { origins?: unknown; users?: unknown }
    value = {
      // An origin is scheme://host[:port], lowercase, nothing after it.
      origins: strings(raw.origins, (o) => o.toLowerCase().replace(/\/+$/, '')).filter((o) => /^https:\/\/[^/\s]+$/.test(o)),
      users: strings(raw.users, (u) => u.toLowerCase()),
    }
  } catch { /* unreadable or broken: nothing comes in */ }
  if (file === REMOTE_FILE) cache = { mtimeMs, value }
  return value
}

export function writeRemoteAccess(access: RemoteAccess, file = REMOTE_FILE): void {
  cache = null
  if (!access.origins.length && !access.users.length) { fs.rmSync(file, { force: true }); return }
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
}

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v ?? '').trim()
}

/**
 * Whether a request may reach the cockpit, and which origins its page may
 * write from. Local: Host is a loopback name and nothing proxied it — the
 * cockpit's own origins, as before. Anything else is remote and needs all of:
 * remote access on for exactly this host, a tailnet user (tailscale serve sets
 * Tailscale-User-Login; a Funnel request from the internet has none and is
 * marked), and that user in the list when there is one. A Host that is neither
 * (a DNS-rebinding page) is refused.
 */
export function requestGate(
  req: IncomingMessage,
  localOrigins: string[],
  remote: RemoteAccess = readRemoteAccess(),
): { allowed: true; origins: string[] } | { allowed: false } {
  const host = header(req, 'host').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  const login = header(req, 'tailscale-user-login').toLowerCase()
  const proxied = login !== '' || header(req, 'x-forwarded-for') !== '' || header(req, 'tailscale-funnel-request') !== ''
  if (LOOPBACK.has(hostname) && !proxied) return { allowed: true, origins: localOrigins }

  if (!remote.origins.includes(`https://${host}`)) return { allowed: false }
  if (header(req, 'tailscale-funnel-request') !== '' || login === '') return { allowed: false }
  if (remote.users.length && !remote.users.includes(login)) return { allowed: false }
  return { allowed: true, origins: remote.origins }
}
