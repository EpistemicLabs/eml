import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { restartDelay, failuresAfterExit, STEADY_MS } from '../src/domain/child-restart.js'
import { superviseChannelBridge, type BridgeChild } from '../src/infrastructure/channel-bridge/channel-bridge-process.js'

describe('restart policy', () => {
  it('waits longer after each crash, up to a minute', () => {
    expect([1, 2, 3, 4, 10].map(restartDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 60_000])
  })

  it('counts crashes in a row, and starts again after a run that held', () => {
    expect(failuresAfterExit(3, 5_000)).toBe(4)
    expect(failuresAfterExit(3, STEADY_MS)).toBe(1)
  })
})

class FakeChild extends EventEmitter implements BridgeChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed: string | null = null
  kill(signal: string): boolean { this.killed = signal; return true }
}

describe('superviseChannelBridge', () => {
  afterEach(() => vi.useRealTimers())

  function setup() {
    const children: FakeChild[] = []
    const starts: { args: string[]; env: Record<string, string | undefined> }[] = []
    const lines: string[] = []
    const settings = {
      script: '/app/dist/channel-bridge.cjs', home: '/home/x/channel-bridge', port: 4401,
      cockpitUrl: 'http://127.0.0.1:4317', tokensDir: '/home/x/job-tokens', accountsFile: '/home/x/channel-bridge/accounts.json',
    }
    const bridge = superviseChannelBridge(settings, {
      spawn: (args, env) => { starts.push({ args, env }); const child = new FakeChild(); children.push(child); return child },
      log: (line) => lines.push(line),
    })
    return { bridge, children, starts, lines }
  }

  it('starts the bridge with its settings and says where it listens', () => {
    const { bridge, starts } = setup()
    expect(bridge.url).toBe('http://127.0.0.1:4401')
    expect(starts[0]?.args.at(-1)).toBe('/app/dist/channel-bridge.cjs')
    expect(starts[0]?.env).toMatchObject({
      CHANNEL_BRIDGE_HOME: '/home/x/channel-bridge', CHANNEL_BRIDGE_PORT: '4401', COCKPIT_URL: 'http://127.0.0.1:4317',
      COCKPIT_JOB_TOKENS_DIR: '/home/x/job-tokens', CHANNEL_BRIDGE_ACCOUNTS_FILE: '/home/x/channel-bridge/accounts.json',
    })
    bridge.stop()
  })

  it('starts it again after a crash, waiting longer each time', async () => {
    vi.useFakeTimers()
    const { bridge, children, lines } = setup()
    children[0]?.emit('exit', 1, null)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(2)
    children[1]?.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(3)
    expect(lines.some((line) => line.includes('exited') && line.includes('restart in'))).toBe(true)
    bridge.stop()
  })

  it('stops the running bridge and starts no other', async () => {
    vi.useFakeTimers()
    const { bridge, children } = setup()
    bridge.stop()
    expect(children[0]?.killed).toBe('SIGTERM')
    children[0]?.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('passes the bridge\'s log lines on with a prefix', () => {
    const { bridge, children, lines } = setup()
    children[0]?.stdout.emit('data', Buffer.from('{"event":"bridge.started"}\n'))
    expect(lines).toContain('[bridge] {"event":"bridge.started"}')
    bridge.stop()
  })
})
