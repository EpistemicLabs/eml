import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { AgentSignIn, SignInAttempt } from '../../../domain/agent-provider.js'
import { CODEX_CONFIG_DIR } from '../../../paths.js'
import { AppServerClient, type AppServerProcess } from './app-server-client.js'
import { codexRuntime } from './runtime.js'

/**
 * Codex's sign-in through `codex app-server`, without a terminal: the account
 * it holds (`account/read`) and the ChatGPT device-code sign-in
 * (`account/login/start` with `chatgptDeviceCode`). The server answers with a
 * verification URL and a one-time code the user enters on that page; it signs
 * in by itself once the user has, and says so with `account/login/completed`.
 *
 * Each runs its own app-server process in the Codex home every session uses
 * (CODEX_CONFIG_DIR), with an environment of its own: no session, so none of a
 * session's variables. As in codex-cli 0.172.0 (the stable protocol surface).
 */

// The messages used here, in the shape the CLI generates them (`codex app-server generate-ts`).
// Kept beside protocol.ts, which is the chat runtime's.
type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string | null }
  | { type: string }
interface GetAccountResponse { account: Account | null; requiresOpenaiAuth: boolean }
type LoginAccountResponse = { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string } | { type: string }
interface AccountLoginCompletedNotification { loginId: string | null; success: boolean; error: string | null }

export interface CodexAccount {
  /** Sessions can reach their model: an account, or a model provider that needs none. */
  signedIn: boolean
  email: string | null
  plan: string | null
}

export type SpawnAccountServer = () => AppServerProcess

const CLIENT = { name: 'eml_cockpit', title: 'EML Cockpit', version: '1' }
// About as long as OpenAI keeps a device code good.
const ATTEMPT_TTL_MS = 15 * 60_000
const READ_TIMEOUT_MS = 15_000

export const spawnAccountServer: SpawnAccountServer = () => spawn(codexRuntime.bin, ['app-server'], {
  cwd: CODEX_CONFIG_DIR,
  env: {
    CODEX_HOME: CODEX_CONFIG_DIR,
    PATH: [codexRuntime.binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    // Reaching OpenAI from behind a proxy.
    ...Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .flatMap((key) => (process.env[key] !== undefined ? [[key, process.env[key] as string]] : []))),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

async function open(spawnServer: SpawnAccountServer): Promise<AppServerClient> {
  const client = new AppServerClient(spawnServer)
  try {
    await client.request('initialize', { clientInfo: CLIENT })
    client.notify('initialized')
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}

/** What Codex says of its sign-in, from a process of its own. */
export async function readCodexAccount(spawnServer: SpawnAccountServer = spawnAccountServer, timeoutMs = READ_TIMEOUT_MS): Promise<CodexAccount> {
  const client = await open(spawnServer)
  let timer: NodeJS.Timeout | undefined
  try {
    const answer = await Promise.race([
      client.request('account/read', { refreshToken: false }) as Promise<GetAccountResponse>,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Codex did not say whether it is signed in.')), timeoutMs) }),
    ])
    const account = answer?.account ?? null
    const chatgpt = account?.type === 'chatgpt' ? account as Extract<Account, { type: 'chatgpt' }> : null
    return {
      signedIn: account !== null || answer?.requiresOpenaiAuth === false,
      email: chatgpt?.email ?? null,
      plan: chatgpt?.planType ?? null,
    }
  } finally {
    clearTimeout(timer)
    await client.close()
  }
}

interface Running {
  attempt: SignInAttempt
  loginId: string
  client: AppServerClient
  expiry: NodeJS.Timeout
}

export interface CodexSignInDeps {
  /** A login was stored: cached answers about it are stale. */
  signedIn(): void
  spawn?: SpawnAccountServer
  attemptTtlMs?: number
}

export class CodexSignIn implements AgentSignIn {
  private current: Running | null = null
  private finished: SignInAttempt | null = null

  constructor(private deps: CodexSignInDeps) {}

  /** One Codex home serves every space: the space does not matter here. */
  async start(): Promise<SignInAttempt> {
    if (this.current) await this.cancel(this.current.attempt.id)
    this.finished = null
    const client = await open(this.deps.spawn ?? spawnAccountServer)
    let started: LoginAccountResponse
    try {
      started = await client.request('account/login/start', { type: 'chatgptDeviceCode' }) as LoginAccountResponse
    } catch (error) {
      await client.close()
      throw new Error(`Codex could not start its sign-in: ${(error as Error).message}`)
    }
    const device = started?.type === 'chatgptDeviceCode' ? started as Extract<LoginAccountResponse, { type: 'chatgptDeviceCode' }> : null
    if (!device || !/^https:\/\//.test(device.verificationUrl ?? '') || !device.userCode || !device.loginId) {
      await client.close()
      throw new Error('Codex answered the sign-in with something the cockpit does not know.')
    }
    const attempt: SignInAttempt = { id: randomUUID(), state: 'waiting', url: device.verificationUrl, userCode: device.userCode, takesCode: false, error: null }
    const running: Running = {
      attempt, loginId: device.loginId, client,
      expiry: setTimeout(() => void this.cancel(attempt.id), this.deps.attemptTtlMs ?? ATTEMPT_TTL_MS),
    }
    this.current = running
    client.onNotification((method, params) => {
      // A cancel is answered with a completion too, unsuccessful: it stays cancelled.
      if (method !== 'account/login/completed' || attempt.state !== 'waiting') return
      const done = params as AccountLoginCompletedNotification
      if (done?.loginId !== null && done?.loginId !== running.loginId) return
      if (done.success) {
        attempt.state = 'done'
        this.deps.signedIn()
      } else {
        attempt.state = 'failed'
        attempt.error = done.error || 'Codex did not finish the sign-in.'
      }
      void this.finish(running)
    })
    client.onExit(() => {
      if (attempt.state !== 'waiting') return
      attempt.state = 'failed'
      attempt.error = 'Codex stopped before the sign-in was finished. Start it again.'
      void this.finish(running)
    })
    return { ...attempt }
  }

  read(id: string): SignInAttempt | null {
    if (this.current?.attempt.id === id) return { ...this.current.attempt }
    return this.finished?.id === id ? { ...this.finished } : null
  }

  /** The device-code flow takes no code here: the user enters it on OpenAI's page. */
  async submitCode(id: string): Promise<SignInAttempt> {
    const attempt = this.read(id)
    if (!attempt) throw new Error('This sign-in is no longer open. Start it again.')
    if (attempt.state === 'waiting') throw new Error('Enter the code on the sign-in page; Codex signs in by itself once you have.')
    return attempt
  }

  async cancel(id: string): Promise<SignInAttempt | null> {
    const running = this.current
    if (!running || running.attempt.id !== id) return this.read(id)
    running.attempt.state = 'cancelled'
    await running.client.request('account/login/cancel', { loginId: running.loginId }).catch(() => { /* over already */ })
    await this.finish(running)
    return { ...running.attempt }
  }

  private async finish(running: Running): Promise<void> {
    clearTimeout(running.expiry)
    if (this.current === running) {
      this.current = null
      this.finished = running.attempt
    }
    await running.client.close()
  }
}
