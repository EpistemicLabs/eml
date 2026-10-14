import * as fs from 'node:fs'
import * as path from 'node:path'
import { SPAWN_INBOX_DIR } from './paths.js'
import { requestSpawn, type SpawnDeps, type SpawnOutcome } from './spawn-api.js'

/**
 * Worker requests as files. A session whose sandbox has no network (Codex)
 * cannot reach POST /api/spawn; its sandbox may write to this folder instead.
 * `cockpit-spawn` drops <id>.json here, the host reads and deletes it, handles
 * it exactly like the HTTP request, and answers in <id>.result.json for the
 * CLI to pick up.
 *
 * Same guard as the HTTP way: the request carries the per-boot spawn token
 * from the session's env. The folder is owner-only; a request file exists for
 * moments only.
 */

const REQUEST = /^([0-9a-f-]{36})\.json$/
const RESULT_TTL_MS = 60_000
const SCAN_INTERVAL_MS = 2000

const log = (line: string) => process.stderr.write(`[spawn-inbox] ${line}\n`)

async function handle(deps: SpawnDeps, id: string): Promise<void> {
  const file = path.join(SPAWN_INBOX_DIR, `${id}.json`)
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return // being written, or already taken
  } finally {
    fs.rmSync(file, { force: true })
  }
  const outcome: SpawnOutcome = body.token === deps.spawnToken
    ? await requestSpawn(deps, body)
    : { status: 403, payload: { error: { code: 'FORBIDDEN', message: 'Spawning is only possible from a cockpit session' } } }
  const result = path.join(SPAWN_INBOX_DIR, `${id}.result.json`)
  fs.writeFileSync(`${result}.tmp`, JSON.stringify(outcome), { mode: 0o600 })
  fs.renameSync(`${result}.tmp`, result)
  setTimeout(() => fs.rmSync(result, { force: true }), RESULT_TTL_MS).unref()
  if (outcome.status >= 400) log(`request ${id} refused (${outcome.status})`)
}

/** Start taking requests from the inbox. Leftovers of an earlier boot are dropped — their token is gone. */
export function watchSpawnInbox(deps: SpawnDeps): void {
  fs.mkdirSync(SPAWN_INBOX_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(SPAWN_INBOX_DIR, 0o700)
  for (const name of fs.readdirSync(SPAWN_INBOX_DIR)) fs.rmSync(path.join(SPAWN_INBOX_DIR, name), { force: true })

  const busy = new Set<string>()
  const scan = () => {
    let names: string[]
    try { names = fs.readdirSync(SPAWN_INBOX_DIR) } catch { return }
    for (const name of names) {
      const id = REQUEST.exec(name)?.[1]
      if (!id || busy.has(id)) continue
      busy.add(id)
      void handle(deps, id).catch((err) => log(`request ${id} failed: ${(err as Error).message}`)).finally(() => busy.delete(id))
    }
  }
  try { fs.watch(SPAWN_INBOX_DIR, scan).unref() } catch { /* the interval below covers it */ }
  setInterval(scan, SCAN_INTERVAL_MS).unref()
}
