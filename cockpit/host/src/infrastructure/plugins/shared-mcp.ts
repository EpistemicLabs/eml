import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import type { Connection } from '../../domain/space-plugins.js'

/** The line a shared server writes once it listens (plugins/gmail/mcp/src/http.ts). */
const LISTENING = /^EML_MCP_LISTENING (\d+)\s*$/
const START_MS = 20_000

/** How a shared part's process starts for one sign-in (domain/space-plugins.ts stdioLaunch). */
export interface SharedLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SharedMcpDeps {
  /** Owner-only file with the secret the relay keys derive from; written on first use. */
  keyFile: string
  /** How the sign-in's server starts, or null when its plugin has no shared part (or lacks a secret). */
  launch(connection: Connection): Promise<SharedLaunch | null>
  spawn?: typeof spawnProcess
  log?: (line: string) => void
  startMs?: number
}

export interface SharedEndpoint {
  url: string
  /** The bearer key the process requires; only the relay knows it. */
  token: string
}

interface Running {
  fingerprint: string
  child: ChildProcess
  ready: Promise<SharedEndpoint>
}

/**
 * The cockpit's shared MCP servers (a stdio part with `shared`): one process per sign-in for every
 * session of the machine, instead of one per session. A process starts on the first request that needs
 * it, starts again after it ended, and restarts when the sign-in's values change. It ends with the
 * cockpit: its stdin closes. Sessions reach it through the relay with a key per sign-in that stays the
 * same across restarts, so the session files written before keep working.
 */
export class SharedMcpHost {
  private readonly running = new Map<string, Running>()
  private secret: Buffer | null = null

  constructor(private readonly deps: SharedMcpDeps) {
    process.once('exit', () => this.stopAll())
  }

  /** The key a session presents to the relay for this sign-in. */
  keyFor(connectionId: string): string {
    return createHmac('sha256', this.loadSecret()).update(`shared-mcp:${connectionId}`).digest('base64url')
  }

  /** Whether a sign-in's plugin runs a shared server. */
  async isShared(connection: Connection): Promise<boolean> {
    return (await this.deps.launch(connection)) !== null
  }

  /** Where the sign-in's server listens, started if it isn't; null when the sign-in has none. */
  async endpoint(connection: Connection): Promise<SharedEndpoint | null> {
    const launch = await this.deps.launch(connection)
    if (!launch) return null
    const fingerprint = JSON.stringify(launch)
    const current = this.running.get(connection.id)
    if (current && current.fingerprint === fingerprint && current.child.exitCode === null && current.child.signalCode === null) return current.ready
    if (current) this.stop(connection.id)
    const started = this.start(connection.id, launch, fingerprint)
    this.running.set(connection.id, started)
    return started.ready
  }

  /** Ends a sign-in's server that stopped answering; the next request starts a new one. */
  discard(connectionId: string): void {
    this.stop(connectionId)
  }

  /** Ends the servers of sign-ins no longer among these (removed, or their plugin gone). */
  retain(connectionIds: Iterable<string>): void {
    const keep = new Set(connectionIds)
    for (const id of [...this.running.keys()]) if (!keep.has(id)) this.stop(id)
  }

  /** How many shared servers run now. */
  count(): number {
    return this.running.size
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  private stop(id: string): void {
    const entry = this.running.get(id)
    if (!entry) return
    this.running.delete(id)
    entry.ready.catch(() => undefined)
    if (entry.child.exitCode === null) entry.child.kill('SIGTERM')
  }

  private start(id: string, launch: SharedLaunch, fingerprint: string): Running {
    const token = randomBytes(24).toString('base64url')
    const child = (this.deps.spawn ?? spawnProcess)(launch.command, launch.args, {
      env: { ...process.env, ...launch.env, EML_MCP_HTTP_KEY: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const log = this.deps.log ?? (() => undefined)
    const ready = new Promise<SharedEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the shared server did not start in time'))
        child.kill('SIGTERM')
      }, this.deps.startMs ?? START_MS)
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const port = LISTENING.exec(line)?.[1]
        if (!port) return
        clearTimeout(timer)
        resolve({ url: `http://127.0.0.1:${port}/mcp`, token })
      })
      createInterface({ input: child.stderr! }).on('line', (line) => log(`[shared-mcp ${id}] ${line.slice(0, 300)}`))
      child.once('error', (err) => { clearTimeout(timer); reject(err) })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`the shared server ended (${signal ?? code})`))
        if (this.running.get(id)?.child === child) this.running.delete(id)
        log(`[shared-mcp] the server of ${id} ended (${signal ?? code})`)
      })
    })
    ready.then(() => log(`[shared-mcp] started the server of ${id}`), () => undefined)
    // The child ends when its stdin closes: with the cockpit, even when the cockpit is killed.
    child.stdin?.on('error', () => undefined)
    return { fingerprint, child, ready }
  }

  private loadSecret(): Buffer {
    if (this.secret) return this.secret
    try {
      this.secret = Buffer.from(readFileSync(this.deps.keyFile, 'utf8').trim(), 'base64url')
    } catch {
      this.secret = Buffer.alloc(0)
    }
    if (this.secret.length < 32) {
      this.secret = randomBytes(32)
      mkdirSync(path.dirname(this.deps.keyFile), { recursive: true, mode: 0o700 })
      writeFileSync(this.deps.keyFile, `${this.secret.toString('base64url')}\n`, { mode: 0o600 })
    }
    return this.secret
  }
}
