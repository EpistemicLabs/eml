import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BACKUPS_DIR, BRAIN_WATCHDOG_JS, SERVER_JS, DATA_DIR, COCKPIT_HOME } from './paths.js'
import { getFreePort } from './ports.js'

/**
 * Launch the bundled loopback packages/server (spike Step 2). The server reads
 * control.db from --data-dir; provisioning must have run first. Health-poll /health.
 * stdin stays a pipe held by the host: the preloaded watchdog stops the server
 * once it closes, so a host that dies uncleanly never leaves an orphan behind.
 *
 * A pending brain migration runs before the server listens (backup + preflight
 * + migrate). The server announces it with a "[migrations] migrating" line;
 * from then on the host waits up to MIGRATION_WAIT_MS instead of the normal
 * STARTUP_WAIT_MS, so a long migration is never killed half-way.
 */

const STARTUP_WAIT_MS = 10_000
const MIGRATION_WAIT_MS = 5 * 60_000

export interface LoopbackServer {
  proc: ChildProcess
  port: number
  baseUrl: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function launchBrainServer(): Promise<LoopbackServer> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`

  // dist/ is built separately from a `tsx watch` dev host — without the
  // watchdog the server still runs, it just can't notice a dead host.
  const watchdog = existsSync(BRAIN_WATCHDOG_JS) ? ['--import', pathToFileURL(BRAIN_WATCHDOG_JS).href] : []
  if (!watchdog.length) process.stderr.write(`warning: ${BRAIN_WATCHDOG_JS} missing — run the host build\n`)
  const proc = spawn(
    'node',
    [...watchdog, SERVER_JS, '--port', String(port), '--host', '127.0.0.1', '--data-dir', DATA_DIR,
      '--backup-dir', BACKUPS_DIR],
    { cwd: COCKPIT_HOME, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const started = Date.now()
  let waitMs = STARTUP_WAIT_MS
  proc.stdout?.on('data', (d) => {
    if (String(d).includes('[migrations] migrating')) waitMs = MIGRATION_WAIT_MS
    process.stderr.write(`[brain] ${d}`)
  })
  proc.stderr?.on('data', (d) => process.stderr.write(`[brain!] ${d}`))

  let healthy = false
  while (Date.now() - started < waitMs) {
    if (proc.exitCode !== null) break
    try {
      const r = await fetch(`${baseUrl}/health`)
      if (r.ok) { healthy = true; break }
    } catch { /* not up yet */ }
    await sleep(200)
  }
  if (!healthy) {
    try { proc.kill('SIGTERM') } catch { /* best-effort */ }
    throw new Error('brain server did not become healthy')
  }
  return { proc, port, baseUrl }
}
