import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgentRuntime, RuntimeResult, RuntimeState } from '../../domain/agent-provider.js'
import { platform } from '../platform/index.js'
import { FS_RETRY, renameWithRetry } from '../../fs-retry.js'

export type { RuntimeResult, RuntimeState }

/**
 * A cockpit-owned agent CLI (decision cockpit-self-contained-app): every app
 * home carries its own copy of the CLI and updates it itself. The user's local
 * install is never read, run or touched, and a local update can't reach the
 * cockpit — the 2026-10-06 incident (one cockpit's updater half-installed the
 * shared npm-global claude, and every cockpit stopped spawning) can't recur.
 *
 * Layout under the runtime dir:
 *   versions/<v>/…        one verified version, never modified after install
 *   current -> versions/<v>   the one thing an update switches (atomic rename;
 *                             a junction on Windows)
 *   bin/<name> -> ../current/<entry>   what sessions run (also first on their PATH);
 *                             on Windows, where a file link needs admin rights,
 *                             sessions run current/<entry> itself
 *   runtime.json          active/previous version, last check, last result
 *
 * Where a version comes from and how its origin is checked is the source's
 * business (RuntimeSource). Whatever it delivers must answer --version with the
 * version it claims before it becomes `current`; anything that fails leaves
 * `current` as it was.
 *
 * Never downgrades on its own: the first install takes the channel version or,
 * if the source knows a newer one this home already ran (floorVersion), that
 * one — transcripts written by a newer version are not resumed by an older one.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 60 * 1000

export interface RuntimeSource {
  /** Product name for logs and messages, e.g. "Claude Code". */
  label: string
  /** Prefix of the host log lines, e.g. "claude-runtime". */
  logTag: string
  /** The channel a fresh home follows. */
  channel: string
  /** The executable inside a version dir, e.g. "claude" or "bin/codex" (with .exe on Windows). */
  entry: string
  /** The version the channel currently names. */
  latestVersion(channel: string): Promise<string>
  /**
   * Put one version into `dir` (an empty staging dir) and verify where it came
   * from — checksum against the publisher's manifest, code signature. Throws on
   * any doubt; the staging dir is thrown away then.
   */
  fetch(version: string, dir: string, log: (line: string) => void): Promise<void>
  /** Environment for the --version self-test: neutral, the app's own config dir, updater off. */
  selfTestEnv(): NodeJS.ProcessEnv
  /** Arguments of the self-test; `--version` unless the source says otherwise. */
  selfTestArgs?: string[]
  /** The version in the --version output. */
  reportedVersion(stdout: string): string
  /** The newest version this home's config has already run — no automatic install below it. */
  floorVersion?(): string | null
}

export interface ManagedRuntimeOptions {
  /**
   * Whether host start and the background check install the CLI when this
   * home has none (true: sessions need it), or only keep an installed one up
   * to date (false: the user sets it up first).
   */
  installUnasked: boolean
}

// --- helpers shared with the sources ------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+$/

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION_RE.test(value)

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

export function maxVersion(versions: Array<string | null | undefined>): string | null {
  return versions.filter(isVersion).sort(compareVersions).pop() ?? null
}

/**
 * Release CDNs and the npm registry answer bursts with 429 and drop a connection now and then
 * (2026-10-22, CI smoke runs: "HTTP 429", "terminated"). Such a failure is retried with an
 * exponential, jittered backoff that honours Retry-After: a 408/429/5xx answer, a network
 * error (fetch rejects, or the body stream breaks off — undici raises both as TypeError), or a
 * request that stalls past its timeout (the same day: a Codex registry request on CI).
 * Anything else fails at once: another HTTP status, a bad checksum later on.
 *
 * The CDN's 429 phases outlast a few seconds and come without Retry-After (a burst lasted over
 * 30 s on CI), so the backoff runs about 5, 10, 20, 40, 60 s: some two minutes before giving
 * up. An install runs in the background; waiting that long beats failing a first install.
 */
export const NET_RETRY = {
  attempts: 6, baseDelayMs: 5_000, maxDelayMs: 60_000,
  textTimeoutMs: 30_000, downloadTimeoutMs: 15 * 60_000,
}

class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null) { super(message) }
}

// undici's network errors: fetch rejects with 'fetch failed', a body stream that breaks off with
// 'terminated'. Other TypeErrors are bugs and fail at once. Only our own AbortSignal.timeout
// aborts these requests, so an AbortError is a timeout too.
const NETWORK_ERRORS = new Set(['fetch failed', 'terminated'])
const transient = (e: unknown) =>
  e instanceof HttpError
    ? e.status === 408 || e.status === 429 || e.status >= 500
    : (e instanceof TypeError && NETWORK_ERRORS.has(e.message)) || ['TimeoutError', 'AbortError'].includes((e as Error)?.name)

/**
 * A lock older than the longest possible install is stale even if its pid is alive (the pid
 * may belong to another process by now): every download attempt at its timeout plus the
 * longest backoff, and a margin for metadata, unpacking and the self-test.
 */
const lockStaleMs = () => NET_RETRY.attempts * (NET_RETRY.downloadTimeoutMs + NET_RETRY.maxDelayMs) + 15 * 60_000

/** Retry-After in ms (seconds or an HTTP date), else the backoff for this attempt. */
function retryDelay(e: unknown, attempt: number): number {
  const header = e instanceof HttpError ? e.retryAfter : null
  const asked = header === null ? NaN : /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  const delay = Number.isFinite(asked) ? Math.max(0, asked) : NET_RETRY.baseDelayMs * 2 ** attempt * (0.5 + Math.random())
  return Math.min(delay, NET_RETRY.maxDelayMs)
}

async function withRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (e) {
      if (attempt + 1 >= NET_RETRY.attempts || !transient(e)) {
        throw attempt > 0 ? new Error(`${(e as Error).message} (after ${attempt + 1} attempts)`, { cause: e }) : e
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(e, attempt)))
    }
  }
}

const httpError = (what: string, res: Response) =>
  new HttpError(`${what} → HTTP ${res.status}`, res.status, res.headers.get('retry-after'))

export async function fetchText(url: string): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(NET_RETRY.textTimeoutMs) })
    if (!res.ok) throw httpError(`GET ${url}`, res)
    return (await res.text()).trim()
  })
}

/** A retry starts the file over: createWriteStream truncates what an aborted attempt left. */
export async function downloadTo(url: string, file: string, mode = 0o644): Promise<void> {
  await withRetry(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(NET_RETRY.downloadTimeoutMs) })
    if (!res.ok || !res.body) throw httpError('download', res)
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(file, { mode }))
  })
}

/** Run a binary with a clean env; `timeoutMs` for anything longer than a version check (unpacking a few hundred MB). */
export function run(file: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs }, (err, stdout, stderr) => {
      // err.code is the exit status for a process that ran, a string (ENOENT, …) when it didn't.
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function fileDigest(file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
  const hash = createHash(algorithm)
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest(encoding)
}

// --- the runtime ----------------------------------------------------------------

export class ManagedRuntime {
  private readonly versionsDir: string
  private readonly currentLink: string
  private readonly stateFile: string
  private readonly lockFile: string
  /** Prepended to every session's PATH, so the CLI typed inside a session is the cockpit's too. */
  readonly binDir: string
  /** What sessions run: a link chain into versions/<current> (Windows: through the current junction). */
  readonly bin: string
  private inFlight: Promise<RuntimeState> | null = null

  constructor(
    private readonly dir: string,
    binName: string,
    private readonly source: RuntimeSource,
    private readonly options: ManagedRuntimeOptions,
  ) {
    this.versionsDir = path.join(dir, 'versions')
    this.currentLink = path.join(dir, 'current')
    if (platform.linksFiles) {
      this.binDir = path.join(dir, 'bin')
      this.bin = path.join(this.binDir, platform.exe(binName))
    } else {
      this.bin = path.join(this.currentLink, source.entry)
      this.binDir = path.dirname(this.bin)
    }
    this.stateFile = path.join(dir, 'runtime.json')
    this.lockFile = path.join(dir, '.lock')
  }

  private log(line: string): void {
    process.stderr.write(`[${this.source.logTag}] ${line}\n`)
  }

  private entryOf(version: string): string {
    return path.join(this.versionsDir, version, this.source.entry)
  }

  // --- state ------------------------------------------------------------------

  readState(): RuntimeState {
    const fresh: RuntimeState = {
      channel: this.source.channel, autoUpdate: true, current: null, previous: null,
      skipVersion: null, lastCheckAt: null, lastResult: null,
    }
    try {
      return { ...fresh, ...(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<RuntimeState>) }
    } catch {
      return fresh
    }
  }

  private writeState(state: RuntimeState): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.stateFile}.${randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, this.stateFile)
  }

  private recordResult(patch: Partial<RuntimeState>, result: Omit<RuntimeResult, 'at'>): RuntimeState {
    const state = { ...this.readState(), ...patch, lastResult: { at: new Date().toISOString(), ...result } }
    this.writeState(state)
    return state
  }

  // --- install ----------------------------------------------------------------

  /** The binary answers --version with exactly the version it claims to be. */
  private async selfTest(bin: string, version: string): Promise<void> {
    const { code, stdout } = await run(bin, this.source.selfTestArgs ?? ['--version'], this.source.selfTestEnv())
    if (code !== 0 || this.source.reportedVersion(stdout) !== version) {
      throw new Error(`self-test failed: --version gave '${stdout.trim().slice(0, 80)}' (exit ${code}), expected ${version}`)
    }
  }

  /**
   * Bring one version into versions/<v>, verified end to end. The source fills
   * a private staging dir, which is renamed into place only after every check
   * passed, so versions/ never holds a partial install.
   */
  private async installVersion(version: string): Promise<void> {
    const target = path.join(this.versionsDir, version)
    if (fs.existsSync(this.entryOf(version))) {
      await this.selfTest(this.entryOf(version), version)
      return
    }
    fs.mkdirSync(this.versionsDir, { recursive: true })
    const staging = path.join(this.versionsDir, `.staging-${version}-${randomBytes(4).toString('hex')}`)
    fs.mkdirSync(staging)
    try {
      await this.source.fetch(version, staging, (line) => this.log(line))
      await this.selfTest(path.join(staging, this.source.entry), version)
      fs.rmSync(target, { recursive: true, force: true, ...FS_RETRY })
      await renameWithRetry(staging, target)
      this.log(`${this.source.label} ${version} verified and installed`)
    } finally {
      fs.rmSync(staging, { recursive: true, force: true, ...FS_RETRY })
    }
  }

  /** Point `current` at versions/<v> (platform.switchDirLink), and bin/ at current. */
  private switchCurrent(version: string): void {
    platform.switchDirLink(path.join(this.versionsDir, version), this.currentLink)
    if (!platform.linksFiles) return
    fs.mkdirSync(this.binDir, { recursive: true })
    if (!fs.existsSync(this.bin)) {
      try { fs.unlinkSync(this.bin) } catch { /* not there */ }
      fs.symlinkSync(path.join('..', 'current', this.source.entry), this.bin)
    }
  }

  /**
   * Keep the active and the previous version (rollback); drop older ones and
   * stale staging dirs. A version a running session still executes can't be
   * deleted on Windows: it stays until a later prune.
   */
  private prune(state: RuntimeState): void {
    const keep = new Set([state.current, state.previous].filter(Boolean) as string[])
    for (const name of fs.readdirSync(this.versionsDir)) {
      if (keep.has(name)) continue
      try {
        fs.rmSync(path.join(this.versionsDir, name), { recursive: true, force: true })
      } catch (e) {
        this.log(`could not remove ${name} yet: ${(e as Error).message}`)
      }
    }
  }

  // --- lock (one installer per home, also across processes) ---------------------

  /** A lock left by a host that was killed mid-install must not block sessions until it ages out. */
  private lockOwnerAlive(): boolean {
    const pid = Number(fs.readFileSync(this.lockFile, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      const age = Date.now() - fs.statSync(this.lockFile).mtimeMs
      if (age > lockStaleMs() || !this.lockOwnerAlive()) fs.rmSync(this.lockFile, { force: true })
    } catch { /* no lock */ }
    let fd: number
    try {
      fd = fs.openSync(this.lockFile, 'wx')
    } catch {
      return Promise.reject(new Error(`another ${this.source.label} install/update for this cockpit is running`))
    }
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return fn().finally(() => fs.rmSync(this.lockFile, { force: true }))
  }

  // --- public API ---------------------------------------------------------------

  /** The active version, or null when the runtime isn't usable. */
  currentVersion(): string | null {
    const state = this.readState()
    if (!state.current) return null
    return fs.existsSync(this.entryOf(state.current)) && fs.existsSync(this.bin) ? state.current : null
  }

  /** Why sessions can't start right now, or null when the runtime is ready. */
  problem(): string | null {
    if (this.currentVersion()) return null
    const { current, lastResult: result } = this.readState()
    const { label } = this.source
    if (current) return `${label} for the cockpit is damaged: version ${current} is missing from ${this.dir}.`
    return result?.outcome === 'failed' && result.error
      ? `${label} for the cockpit is not set up: ${result.error}`
      : `${label} for the cockpit is not set up yet.`
  }

  /**
   * Bring the runtime to the version it should run. `install` (host start) only
   * acts when nothing usable is installed; `update` checks the channel.
   */
  sync(mode: 'install' | 'update'): Promise<RuntimeState> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.withLock(async () => {
      const state = this.readState()
      const active = this.currentVersion()
      if (mode === 'install' && active) return state

      let channel: string
      try {
        channel = await this.source.latestVersion(state.channel)
      } catch (e) {
        return this.recordResult({ lastCheckAt: new Date().toISOString() }, { outcome: 'failed', from: active, error: (e as Error).message })
      }
      const floor = maxVersion([active, active ? null : this.source.floorVersion?.()])
      let target = maxVersion([channel, floor]) as string
      if (state.skipVersion && compareVersions(target, state.skipVersion) <= 0 && active) target = active

      if (active && compareVersions(target, active) <= 0) {
        return this.recordResult({ lastCheckAt: new Date().toISOString() }, { outcome: 'up_to_date', from: active, to: active })
      }
      try {
        await this.installVersion(target)
        this.switchCurrent(target)
        const next = this.recordResult(
          { current: target, previous: active ?? state.previous, lastCheckAt: new Date().toISOString() },
          { outcome: active ? 'updated' : 'installed', from: active, to: target },
        )
        this.prune(next)
        this.log(`${active ? `updated ${active} → ${target}` : `installed ${target}`} (new sessions use it; running ones keep theirs)`)
        return next
      } catch (e) {
        this.log(`install of ${target} failed: ${(e as Error).message}`)
        return this.recordResult({ lastCheckAt: new Date().toISOString() }, { outcome: 'failed', from: active, to: target, error: (e as Error).message })
      }
    }).catch((e) => this.recordResult({}, { outcome: 'failed', error: (e as Error).message }))
      .finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /** Host start: install when this home has none — if the runtime installs unasked. */
  async installAtStart(): Promise<void> {
    if (this.options.installUnasked) await this.sync('install')
  }

  /** Switch back to the previous version and don't take the abandoned one again. */
  async rollback(): Promise<RuntimeState> {
    const state = this.readState()
    const active = this.currentVersion()
    if (!active || !state.previous || !fs.existsSync(this.entryOf(state.previous))) {
      throw new Error('no previous version to go back to')
    }
    await this.selfTest(this.entryOf(state.previous), state.previous)
    this.switchCurrent(state.previous)
    return this.recordResult(
      { current: state.previous, previous: active, skipVersion: active },
      { outcome: 'rolled_back', from: active, to: state.previous },
    )
  }

  setAutoUpdate(autoUpdate: boolean): RuntimeState {
    const state = { ...this.readState(), autoUpdate }
    this.writeState(state)
    return state
  }

  /** Background updates: a first check shortly after start, then every few hours. */
  scheduleUpdates(): void {
    const tick = () => {
      const state = this.readState()
      if (state.autoUpdate && (this.options.installUnasked || state.current)) void this.sync('update')
    }
    setTimeout(tick, FIRST_CHECK_DELAY_MS).unref()
    setInterval(tick, CHECK_INTERVAL_MS).unref()
  }
}

/** A managed runtime as the provider port sees it. */
export function asAgentRuntime(runtime: ManagedRuntime, problemHint: string): AgentRuntime {
  return {
    version: () => runtime.currentVersion(),
    problem: () => runtime.problem(),
    problemHint,
    install: () => runtime.installAtStart(),
    lastError: () => runtime.readState().lastResult?.error ?? null,
    scheduleUpdates: () => runtime.scheduleUpdates(),
    state: () => runtime.readState(),
    check: () => runtime.sync('update'),
    rollback: () => runtime.rollback(),
    setAutoUpdate: (autoUpdate) => runtime.setAutoUpdate(autoUpdate),
  }
}
