/**
 * How a session's CLI (spawn-cli.ts, session-title-cli.ts) reaches the host:
 * an HTTP request to COCKPIT_URL with the per-boot COCKPIT_SPAWN_TOKEN, or —
 * without network (a sandboxed session) — the same request as a file in
 * COCKPIT_SPAWN_DIR (spawn-inbox.ts), whose `kind` tells the host what it is.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface HostAnswer<T> {
  status: number
  body: T & { error?: { message?: string } }
}

export function fail(cli: string, message: string): never {
  process.stderr.write(`${cli}: ${message}\n`)
  process.exit(1)
}

/** Null when the host is unreachable both ways. */
export async function requestHost<T>(
  cli: string,
  http: { method: string; path: string },
  request: Record<string, unknown> & { kind?: string },
): Promise<HostAnswer<T> | null> {
  const url = process.env.COCKPIT_URL
  const token = process.env.COCKPIT_SPAWN_TOKEN
  if (!url || !token) fail(cli, 'not inside a cockpit session (COCKPIT_URL / COCKPIT_SPAWN_TOKEN missing)')
  const { kind: _kind, ...payload } = request
  try {
    const res = await fetch(`${url}${http.path}`, {
      method: http.method,
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Token': token },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as HostAnswer<T>['body'] }
  } catch {
    // No network: a sandboxed session. Hand the request over as a file.
    return requestViaInbox<T>({ ...request, token })
  }
}

/**
 * The request as a file in the cockpit's spawn inbox (COCKPIT_SPAWN_DIR), for
 * a session whose sandbox blocks the network but may write there. Waits for
 * the host's answer. Null when there is no inbox or the host does not answer.
 */
async function requestViaInbox<T>(request: Record<string, unknown>): Promise<HostAnswer<T> | null> {
  const dir = process.env.COCKPIT_SPAWN_DIR
  if (!dir) return null
  const id = randomUUID()
  const file = path.join(dir, `${id}.json`)
  const result = path.join(dir, `${id}.result.json`)
  try {
    // Written under another name first: the host must never read half a request.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
  } catch {
    return null
  }
  for (let waited = 0; waited < 10_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      const { status, payload } = JSON.parse(fs.readFileSync(result, 'utf8')) as { status: number; payload: HostAnswer<T>['body'] }
      return { status, body: payload }
    } catch { /* not answered yet */ }
  }
  fs.rmSync(file, { force: true })
  return null
}
