import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentSignIn, SessionSpace, SignInAttempt } from '../../../domain/agent-provider.js'
import { platform } from '../../platform/index.js'
import { CLAUDE_BIN } from './runtime.js'

/**
 * Claude Code's own sign-in (`claude auth login`) driven by the host, so the
 * user never needs a terminal for it. As Claude Code 2.1 does it without a
 * terminal: it prints "If the browser didn't open, visit: <url>", then waits
 * on stdin after "Paste code here if prompted >". The page at the url ends
 * with a code; the user pastes it into the cockpit, the host writes it to the
 * CLI's stdin, and the CLI exits 0 once it stored the login, else 1 with
 * "Couldn't log in: …" on stderr. Meanwhile it also listens on localhost for
 * the browser it tried to open: a sign-in finished that way ends the process
 * with 0 on its own, and the attempt is done without a code.
 *
 * The login lands in the config folder the space's sessions use (the shared
 * one, or the folder of the space's own agent), where Claude Code keeps it as
 * after /login. The code goes to the CLI's stdin and nowhere else: not into a
 * log, a file or an error message.
 */

/** What the host needs of the CLI's process (a ChildProcess is one; tests pass a fake). */
export interface LoginProcess {
  stdin: { write(chunk: string): unknown; end(): unknown; on(event: 'error', listener: (error: Error) => void): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnLogin = (bin: string, args: string[], env: Record<string, string>) => LoginProcess

export interface ClaudeSignInDeps {
  /** The config folder of the space's sessions; throws with a message for the UI when it has none. */
  configDirFor(space: SessionSpace): string
  /** A login was stored in this folder: cached answers about it are stale. */
  signedIn(configDir: string): void
  spawn?: SpawnLogin
  /** How long the CLI may take to print the link. */
  urlTimeoutMs?: number
  /** How long the CLI may take to answer a pasted code. */
  codeTimeoutMs?: number
  /** How long an attempt waits for the user before it is given up. */
  attemptTtlMs?: number
}

// The CLI's environment: what it needs to run and reach Anthropic (the same
// allowlist idea as a session's, pty-bridge.ts) — nothing else of the host's.
const ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // Windows: what a process needs to find its profile and temp folder.
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP',
] as const

const URL_LINE = /visit:\s*(https:\/\/\S+)/
const URL_TIMEOUT_MS = 20_000
const CODE_TIMEOUT_MS = 60_000
// About as long as the page keeps its code good.
const ATTEMPT_TTL_MS = 10 * 60_000
// What a pasted code may look like: one line of visible characters.
const CODE_SHAPE = /^[\x21-\x7e]{1,2048}$/
const MAX_ERROR = 300

const defaultSpawn: SpawnLogin = (bin, args, env) => spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })

export function loginEnv(configDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: '1',
    // The link opens in the user's browser from the page, which may be on
    // another device: no browser window pops up on the host's screen.
    ...(platform.os === 'win32' ? {} : { BROWSER: 'true' }),
  }
}

interface Running {
  attempt: SignInAttempt
  configDir: string
  process: LoginProcess
  exited: Promise<number | null>
  stderr: string
  /** The pasted code, kept only to take it out of what the CLI says. */
  code: string | null
  expiry: NodeJS.Timeout
}

export class ClaudeSignIn implements AgentSignIn {
  private current: Running | null = null
  // A finished attempt stays readable until the next one starts.
  private finished: SignInAttempt | null = null
  private spawnLogin: SpawnLogin

  constructor(private deps: ClaudeSignInDeps) {
    this.spawnLogin = deps.spawn ?? defaultSpawn
  }

  async start(space: SessionSpace): Promise<SignInAttempt> {
    const configDir = this.deps.configDirFor(space)
    await this.cancel(this.current?.attempt.id ?? '')
    this.finished = null
    const child = this.spawnLogin(CLAUDE_BIN, ['auth', 'login', '--claudeai'], loginEnv(configDir))
    let stdout = ''
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    child.stdin?.on('error', () => { /* gone: its exit says so */ })
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code did not show a sign-in link. Try again.')) }, this.deps.urlTimeoutMs ?? URL_TIMEOUT_MS)
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
        const found = URL_LINE.exec(stdout)
        if (found) { clearTimeout(timer); resolve(found[1]) }
      })
      void exited.then(() => { clearTimeout(timer); reject(new Error('Claude Code ended before it showed a sign-in link. Is it set up (Settings › Models › Claude Code)?')) })
    })
    const attempt: SignInAttempt = { id: randomUUID(), state: 'waiting', url, userCode: null, takesCode: true, error: null }
    const running: Running = {
      attempt, configDir, process: child, exited, stderr: '', code: null,
      expiry: setTimeout(() => void this.cancel(attempt.id), this.deps.attemptTtlMs ?? ATTEMPT_TTL_MS),
    }
    child.stderr?.on('data', (chunk) => { running.stderr = (running.stderr + chunk.toString()).slice(-2_000) })
    this.current = running
    void exited.then((code) => this.ended(running, code))
    return { ...attempt }
  }

  read(id: string): SignInAttempt | null {
    if (this.current?.attempt.id === id) return { ...this.current.attempt }
    return this.finished?.id === id ? { ...this.finished } : null
  }

  async submitCode(id: string, raw: string): Promise<SignInAttempt> {
    const running = this.current
    if (!running || running.attempt.id !== id) {
      const over = this.read(id)
      if (over) return over
      throw new Error('This sign-in is no longer open. Start it again.')
    }
    if (running.attempt.state !== 'waiting') return { ...running.attempt }
    const code = raw.trim()
    if (!CODE_SHAPE.test(code)) throw new Error('Paste the code from the sign-in page, in one line.')
    running.code = code
    running.attempt.state = 'checking'
    running.process.stdin?.write(`${code}\n`)
    const timer = setTimeout(() => running.process.kill(), this.deps.codeTimeoutMs ?? CODE_TIMEOUT_MS)
    await running.exited
    clearTimeout(timer)
    return this.read(id) ?? { ...running.attempt }
  }

  async cancel(id: string): Promise<SignInAttempt | null> {
    const running = this.current
    if (!running || running.attempt.id !== id) return this.read(id)
    running.attempt.state = 'cancelled'
    this.finish(running)
    running.process.kill()
    await running.exited
    return { ...running.attempt }
  }

  private ended(running: Running, code: number | null): void {
    if (this.current !== running) return
    const attempt = running.attempt
    if (attempt.state === 'cancelled') return
    if (code === 0) {
      attempt.state = 'done'
      this.deps.signedIn(running.configDir)
    } else {
      attempt.state = 'failed'
      attempt.error = errorText(running.stderr, running.code)
    }
    this.finish(running)
  }

  private finish(running: Running): void {
    clearTimeout(running.expiry)
    running.code = null
    if (this.current === running) {
      this.current = null
      this.finished = running.attempt
    }
  }
}

/** The CLI's own words for a refused sign-in, without the code it was given. */
function errorText(stderr: string, code: string | null): string {
  let line = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (code) line = line.split(code).join('…')
  line = line.replace(/^Couldn't log in:\s*/i, '')
  if (!line) return 'Claude Code did not accept the sign-in. Start it again.'
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR)}…` : line
}
