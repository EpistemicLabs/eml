import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AppServerProcess } from '../src/infrastructure/providers/codex/app-server-client.js'
import { CodexSignIn, readCodexAccount } from '../src/infrastructure/providers/codex/account.js'

/**
 * Codex's account and device-code sign-in over `codex app-server`, against a
 * process that is none: it answers each request the way the server does, from a
 * table per method. All codes and ids are made up.
 */

type Answer = { result?: unknown; error?: { code: number; message: string } }

class FakeServer extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: Array<Record<string, unknown>> = []
  closed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; method?: string }
        this.written.push(message)
        if (message.id === undefined || !message.method) continue
        const answer = this.answers[message.method] ?? { result: {} }
        queueMicrotask(() => this.say({ id: message.id, ...answer }))
      }
    },
    end: () => { this.closed = true; queueMicrotask(() => this.emit('exit', 0, null)) },
  })

  constructor(private answers: Record<string, Answer>) { super() }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  }

  say(message: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`))
  }

  methods(): string[] {
    return this.written.map((message) => message.method as string)
  }
}

const INIT = { result: { userAgent: 'x', codexHome: '/codex', platformFamily: 'unix', platformOs: 'linux' } }
const DEVICE = { result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.example/codex/device', userCode: 'FAKE-0000' } }

function server(answers: Record<string, Answer>): { spawn: () => AppServerProcess; servers: FakeServer[] } {
  const servers: FakeServer[] = []
  return {
    servers,
    spawn: () => {
      const fake = new FakeServer({ initialize: INIT, ...answers })
      servers.push(fake)
      return fake as unknown as AppServerProcess
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('readCodexAccount', () => {
  it('reads the ChatGPT account and closes its process', async () => {
    const { spawn, servers } = server({ 'account/read': { result: { account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }, userId: null, requiresOpenaiAuth: true } } })
    expect(await readCodexAccount(spawn)).toEqual({ signedIn: true, email: 'user@example.com', plan: 'plus' })
    expect(servers[0].methods()).toEqual(['initialize', 'initialized', 'account/read'])
    expect(servers[0].closed).toBe(true)
  })

  it('is signed out without an account, unless the model provider needs none', async () => {
    const none = server({ 'account/read': { result: { account: null, userId: null, requiresOpenaiAuth: true } } })
    expect((await readCodexAccount(none.spawn)).signedIn).toBe(false)
    const own = server({ 'account/read': { result: { account: null, userId: null, requiresOpenaiAuth: false } } })
    expect((await readCodexAccount(own.spawn)).signedIn).toBe(true)
  })
})

describe('CodexSignIn', () => {
  it('starts the device-code sign-in and hands back the page and the code', async () => {
    const { spawn, servers } = server({ 'account/login/start': DEVICE })
    const signIn = new CodexSignIn({ signedIn: () => {}, spawn })
    const attempt = await signIn.start()
    expect(attempt).toMatchObject({ state: 'waiting', url: 'https://auth.example/codex/device', userCode: 'FAKE-0000', takesCode: false })
    expect(servers[0].written.find((m) => m.method === 'account/login/start')?.params).toEqual({ type: 'chatgptDeviceCode' })
    expect(servers[0].closed).toBe(false)
  })

  it('is done when the server says the login completed, and stops its process', async () => {
    const { spawn, servers } = server({ 'account/login/start': DEVICE })
    const signedIn = vi.fn()
    const signIn = new CodexSignIn({ signedIn, spawn })
    const { id } = await signIn.start()
    servers[0].say({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } })
    await tick()
    expect(signIn.read(id)?.state).toBe('done')
    expect(signedIn).toHaveBeenCalledTimes(1)
    expect(servers[0].closed).toBe(true)
  })

  it('reports a failed login in the server\'s words, and ignores another login\'s completion', async () => {
    const { spawn, servers } = server({ 'account/login/start': DEVICE })
    const signIn = new CodexSignIn({ signedIn: () => {}, spawn })
    const { id } = await signIn.start()
    servers[0].say({ method: 'account/login/completed', params: { loginId: 'other', success: true, error: null } })
    await tick()
    expect(signIn.read(id)?.state).toBe('waiting')
    servers[0].say({ method: 'account/login/completed', params: { loginId: 'login-1', success: false, error: 'Device code expired' } })
    await tick()
    expect(signIn.read(id)).toMatchObject({ state: 'failed', error: 'Device code expired' })
  })

  it('cancel asks the server to cancel and stays cancelled', async () => {
    const { spawn, servers } = server({ 'account/login/start': DEVICE, 'account/login/cancel': { result: { status: 'canceled' } } })
    const signIn = new CodexSignIn({ signedIn: () => {}, spawn })
    const { id } = await signIn.start()
    const cancelled = signIn.cancel(id)
    servers[0].say({ method: 'account/login/completed', params: { loginId: 'login-1', success: false, error: 'Login was not completed' } })
    expect((await cancelled)?.state).toBe('cancelled')
    expect(servers[0].written.find((m) => m.method === 'account/login/cancel')?.params).toEqual({ loginId: 'login-1' })
    expect(servers[0].closed).toBe(true)
  })

  it('fails when the process ends while waiting', async () => {
    const { spawn, servers } = server({ 'account/login/start': DEVICE })
    const signIn = new CodexSignIn({ signedIn: () => {}, spawn })
    const { id } = await signIn.start()
    servers[0].emit('exit', 1, null)
    await tick()
    expect(signIn.read(id)?.state).toBe('failed')
  })

  it('rejects a refused start and takes no code', async () => {
    const refused = server({ 'account/login/start': { error: { code: -32600, message: 'device code login is disabled' } } })
    await expect(new CodexSignIn({ signedIn: () => {}, spawn: refused.spawn }).start()).rejects.toThrow(/device code login is disabled/)
    expect(refused.servers[0].closed).toBe(true)
    const { spawn } = server({ 'account/login/start': DEVICE })
    const signIn = new CodexSignIn({ signedIn: () => {}, spawn })
    const { id } = await signIn.start()
    await expect(signIn.submitCode(id)).rejects.toThrow(/sign-in page/)
  })
})
