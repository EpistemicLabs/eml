import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionRuntime } from '../src/domain/session-runtime.js'

// Signing in to a Claude chat session's MCP servers (sdk-runtime.ts) against a fake of the SDK's
// Query: the control requests the CLI's /mcp sign-in runs on (mcp_authenticate,
// mcp_oauth_callback_url), its server list and its reconnect. Every code, state and address is a placeholder.

// paths.ts reads the home at import time — set it before loading the modules.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-claude-sign-in-test-'))

type Status = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

const sdk = vi.hoisted(() => ({
  status: 'needs-auth' as string,
  authAnswer: undefined as unknown,
  submitted: [] as Array<[string, string]>,
  submitRefusal: null as string | null,
  reconnects: [] as string[],
  /** Old CLI: the query has no sign-in calls. */
  withoutSignIn: false,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const never = new Promise<never>(() => {})
    const query: Record<string, unknown> = {
      [Symbol.asyncIterator]: async function* () { await never },
      initializationResult: () => never,
      close: () => {},
      interrupt: async () => {},
      mcpServerStatus: async () => [{ name: 'linear', status: sdk.status, tools: sdk.status === 'connected' ? [{ name: 'a' }] : [] }],
      reconnectMcpServer: async (name: string) => { sdk.reconnects.push(name) },
    }
    if (!sdk.withoutSignIn) {
      query.mcpAuthenticate = async () => sdk.authAnswer
      query.mcpSubmitOAuthCallbackUrl = async (name: string, url: string) => {
        if (sdk.submitRefusal) throw new Error(sdk.submitRefusal)
        sdk.submitted.push([name, url])
      }
    }
    return query
  },
  getSessionMessages: async () => [],
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
}))

let createClaudeSdkRuntimes: typeof import('../src/infrastructure/providers/claude/sdk-runtime.js')['createClaudeSdkRuntimes']
let callbackAddress: typeof import('../src/infrastructure/providers/claude/sdk-runtime.js')['callbackAddress']

beforeAll(async () => {
  ;({ createClaudeSdkRuntimes, callbackAddress } = await import('../src/infrastructure/providers/claude/sdk-runtime.js'))
})

const LOCAL = { authUrl: 'https://auth.example.com/authorize?client_id=fake', requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', state: 'fake-state', callbackPort: 54321 }
const runtimes: SessionRuntime[] = []

function start(): { runtime: SessionRuntime; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = []
  const runtime = createClaudeSdkRuntimes().start({
    sessionId: 's1', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: {}, address: 'test',
    launch: { bin: 'claude', args: [], env: {}, keepRunning: false },
    space: { id: 'space', mcpToken: 't', files: { mcpConfig: '/m', settings: '/s', emlConfig: '/e' } },
    onEvent: (event) => events.push(event),
  })
  runtimes.push(runtime)
  return { runtime, events }
}
const notices = (events: RuntimeEvent[]) => events.flatMap((event) => (event.kind === 'notice' ? [event.text] : []))
const setStatus = (status: Status) => { sdk.status = status }

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  Object.assign(sdk, { status: 'needs-auth', authAnswer: undefined, submitted: [], submitRefusal: null, reconnects: [], withoutSignIn: false })
})

describe('callbackAddress', () => {
  const pending = { port: 54321, state: 'fake-state' }
  it('takes the address the sign-in page ended on as it is, or puts a code alone into the callback address', () => {
    expect(callbackAddress(' http://localhost:54321/callback?code=fake-code&state=fake-state ', pending)).toBe('http://localhost:54321/callback?code=fake-code&state=fake-state')
    expect(callbackAddress('fake-code', pending)).toBe('http://localhost:54321/callback?code=fake-code&state=fake-state')
  })
  it('refuses what is neither, and a code without a sign-in to put it into', () => {
    expect(callbackAddress('', pending)).toBeNull()
    expect(callbackAddress('two words', pending)).toBeNull()
    expect(callbackAddress('fake-code', undefined)).toBeNull()
    expect(callbackAddress('fake-code', { port: null, state: null })).toBeNull()
  })
})

describe('signing in to a tool server in a Claude chat session', () => {
  it('offers the sign-in, gives the page to open and says it takes the address back', async () => {
    sdk.authAnswer = LOCAL
    const { runtime } = start()
    expect(await runtime.signInToolServer('linear')).toEqual({ url: LOCAL.authUrl, takesCode: true })
  })

  it('notices a sign-in that ended in a browser on this machine (the CLI connects the server itself) and says so once', async () => {
    vi.useFakeTimers()
    sdk.authAnswer = LOCAL
    const { runtime, events } = start()
    await runtime.signInToolServer('linear')
    await vi.advanceTimersByTimeAsync(4_100)
    expect(notices(events)).toEqual([])
    setStatus('connected')
    await vi.advanceTimersByTimeAsync(2_100)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(notices(events)).toEqual(['Signed in to the tool server "linear".'])
    expect(sdk.reconnects).toEqual([])
  })

  it('stops looking after ten minutes', async () => {
    vi.useFakeTimers()
    sdk.authAnswer = LOCAL
    const { runtime, events } = start()
    await runtime.signInToolServer('linear')
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5_000)
    setStatus('connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(notices(events)).toEqual([])
  })

  it('hands a pasted address or code to the CLI, connects the server again and says so', async () => {
    sdk.authAnswer = LOCAL
    const { runtime, events } = start()
    await runtime.signInToolServer('linear')
    await runtime.finishToolServerSignIn('linear', 'fake-code')
    expect(sdk.submitted).toEqual([['linear', 'http://localhost:54321/callback?code=fake-code&state=fake-state']])
    expect(sdk.reconnects).toEqual(['linear'])
    expect(notices(events)).toEqual(['Signed in to the tool server "linear".'])
  })

  it('keeps the sign-in waiting when the CLI refuses what was pasted, for another try', async () => {
    sdk.authAnswer = LOCAL
    const { runtime } = start()
    await runtime.signInToolServer('linear')
    await expect(runtime.finishToolServerSignIn('linear', 'two words')).rejects.toThrow('Paste the whole address')
    sdk.submitRefusal = 'Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch)'
    await expect(runtime.finishToolServerSignIn('linear', 'http://localhost:54321/callback?code=fake-code&state=other')).rejects.toThrow('OAuth state mismatch')
    sdk.submitRefusal = null
    await runtime.finishToolServerSignIn('linear', 'fake-code')
    expect(sdk.submitted).toHaveLength(1)
  })

  it('takes a whole address without a sign-in it knows of (the CLI may still wait), but no code alone', async () => {
    const { runtime } = start()
    await expect(runtime.finishToolServerSignIn('linear', 'fake-code')).rejects.toThrow('No sign-in is under way')
    await runtime.finishToolServerSignIn('linear', 'http://localhost:54321/callback?code=fake-code&state=fake-state')
    expect(sdk.submitted).toHaveLength(1)
  })

  it('connects a claude.ai connector again while its sign-in on claude.ai is under way, without taking anything back', async () => {
    vi.useFakeTimers()
    sdk.authAnswer = { authUrl: 'https://claude.ai/fake-connector', requiresUserAction: true, callbackExpected: false }
    const { runtime, events } = start()
    expect(await runtime.signInToolServer('linear')).toEqual({ url: 'https://claude.ai/fake-connector' })
    await vi.advanceTimersByTimeAsync(10_100)
    expect(sdk.reconnects).toEqual(['linear'])
    setStatus('connected')
    await vi.advanceTimersByTimeAsync(10_100)
    expect(notices(events)).toEqual(['Signed in to the tool server "linear".'])
  })

  it('has nothing to open for a server still signed in, and says so once it is connected', async () => {
    vi.useFakeTimers()
    sdk.authAnswer = { requiresUserAction: false, callbackExpected: false }
    const { runtime, events } = start()
    expect(await runtime.signInToolServer('linear')).toBeNull()
    setStatus('connected')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(notices(events)).toEqual(['Signed in to the tool server "linear".'])
  })

  it('refuses a page that is not a web address', async () => {
    sdk.authAnswer = { ...LOCAL, authUrl: 'javascript:alert(1)' }
    const { runtime } = start()
    await expect(runtime.signInToolServer('linear')).rejects.toThrow('no page to sign in on')
  })

  it('points to the terminal where the CLI has no sign-in calls', async () => {
    sdk.withoutSignIn = true
    const { runtime } = start()
    await expect(runtime.signInToolServer('linear')).rejects.toThrow('run /mcp')
  })

  it('stops looking when the session closes', async () => {
    vi.useFakeTimers()
    sdk.authAnswer = LOCAL
    const { runtime, events } = start()
    await runtime.signInToolServer('linear')
    await runtime.close()
    setStatus('connected')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(notices(events)).toEqual([])
  })
})
