import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * v0.19 (B3): who writes — stamped by the server on every engram and entry.
 *
 * - session: the cockpit's session id (COCKPIT_SESSION_ID) inside the cockpit,
 *   else Claude Code's (CLAUDE_CODE_SESSION_ID); both are inherited by this
 *   stdio process. Without either, one id per server process, so "one log per
 *   session" still holds per process.
 * - harness: the MCP client's name from the initialize handshake.
 * - model: asked per write (/model can switch mid-session) — in the cockpit
 *   from the host, which reads it from the session transcript; outside from
 *   Claude Code's transcript (CLAUDE_CONFIG_DIR). Unknown stays unknown: the
 *   model is never guessed.
 */

export interface ProvenanceEnv {
  COCKPIT_SESSION_ID?: string
  CLAUDE_CODE_SESSION_ID?: string
  COCKPIT_URL?: string
  COCKPIT_SPAWN_TOKEN?: string
  CLAUDE_CONFIG_DIR?: string
}

const MODEL_CACHE_MS = 15_000
const HOST_TIMEOUT_MS = 800
/** Only the tail of a transcript is read for the last assistant message. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

export class Provenance {
  readonly sessionId: string
  private harnessName: string | null = null
  private cached: { at: number, model: string | null } | null = null

  constructor(private env: ProvenanceEnv = process.env as ProvenanceEnv, private fetchImpl: typeof fetch = fetch) {
    this.sessionId = env.COCKPIT_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || `process-${randomUUID()}`
  }

  /** Set from the MCP client's name once the handshake is done. */
  setHarness(name: string | undefined | null): void {
    if (name && name.trim()) this.harnessName = name.trim()
  }

  get harness(): string | null {
    return this.harnessName
  }

  async model(): Promise<string | null> {
    if (this.cached && Date.now() - this.cached.at < MODEL_CACHE_MS) return this.cached.model
    const model = (await this.fromCockpit()) ?? this.fromTranscript()
    this.cached = { at: Date.now(), model }
    return model
  }

  /** The headers the EML API reads (server.ts writeCtx). */
  async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'X-EML-Session': this.sessionId, 'X-EML-Ingestion': 'mcp' }
    if (this.harnessName) h['X-EML-Harness'] = this.harnessName
    const model = await this.model().catch(() => null)
    if (model) h['X-EML-Model'] = model
    return h
  }

  private async fromCockpit(): Promise<string | null> {
    const { COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: token, COCKPIT_SESSION_ID: id } = this.env
    if (!url || !token || !id) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HOST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(`${url.replace(/\/+$/, '')}/api/session-model/${encodeURIComponent(id)}`, {
        headers: { 'x-cockpit-token': token, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return null
      const body = await res.json() as { model?: unknown }
      return typeof body.model === 'string' && body.model ? body.model : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Claude Code keeps the transcript at <config dir>/projects/<cwd as dashes>/<session id>.jsonl. */
  private fromTranscript(): string | null {
    const id = this.env.CLAUDE_CODE_SESSION_ID
    if (!id) return null
    const configDir = this.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const file = path.join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
    return lastModelIn(file)
  }
}

/** The model of the last assistant message in a JSONL transcript, or null. */
export function lastModelIn(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line || !line.includes('"model"')) continue
      try {
        const record = JSON.parse(line) as { message?: { model?: unknown } }
        if (typeof record.message?.model === 'string' && record.message.model) return record.message.model
      } catch { /* a cut first line or a partial write */ }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}
