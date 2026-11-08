import { describe, it, expect, vi, afterEach } from 'vitest'
import { runBridgeTick, startBridgeLoop } from '../src/entrypoints/bridge-loop'
import { MemoryMessageStore } from '../src/adapters/memory/memory-message-store'
import { MemoryWakeQueue } from '../src/adapters/memory/memory-wake-queue'
import { MemoryJobDirectory } from '../src/adapters/memory/memory-job-directory'
import { FixedClock } from '../src/adapters/memory/fixed-clock'
import { RecordingCockpit } from '../src/adapters/memory/recording-cockpit'
import { ScriptedChannel } from '../src/adapters/fake-channel/scripted-channel'
import type { ChannelAccount } from '../src/ports/channel'

function setup() {
  const good = new ScriptedChannel('acc-good', 'support')
  const broken: ChannelAccount = {
    channel: 'mail', accountId: 'acc-broken', space: 'support',
    sync: async () => { throw new Error('token revoked') },
    send: async () => ({ kind: 'failed', reason: 'down', retryable: true }),
  }
  const logged: { event: string; fields: Record<string, unknown> }[] = []
  const deps = {
    store: new MemoryMessageStore(),
    wakes: new MemoryWakeQueue(),
    jobs: new MemoryJobDirectory([
      { jobId: 'job-1', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' } },
    ]),
    clock: new FixedClock('2026-11-08T10:00:00.000Z'),
    cockpit: new RecordingCockpit(['job-1']),
  }
  return { good, broken, logged, deps, log: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }) }
}

describe('runBridgeTick', () => {
  it('syncs every account, keeps going past a broken one, and dispatches due wakes', async () => {
    const s = setup()
    const options = { accounts: [s.broken, s.good], collectMs: 0, log: s.log }
    await runBridgeTick(s.deps, options)
    s.good.receive({
      channelMessageId: 'm-1', threadKey: 't-1', from: 'anna@customer.example', senderVerified: true, automated: false,
      receivedAt: '2026-11-08T10:00:00.000Z', subject: 'Order', text: 'Hello',
    })
    await runBridgeTick(s.deps, options)
    expect(s.deps.cockpit.requests).toHaveLength(1)
    expect(s.logged).toContainEqual({ event: 'sync.failed', fields: { accountId: 'acc-broken' } })
    expect(JSON.stringify(s.logged)).not.toContain('anna@')
  })
})

describe('startBridgeLoop', () => {
  afterEach(() => vi.useRealTimers())

  it('does not start a round while one is running, and stops when told', async () => {
    vi.useFakeTimers()
    const s = setup()
    let syncs = 0
    let finish: () => void = () => {}
    const slow: ChannelAccount = {
      channel: 'mail', accountId: 'acc-slow', space: 'support',
      sync: () => {
        syncs += 1
        return new Promise((resolve) => { finish = () => resolve({ messages: [], cursor: '0' }) })
      },
      send: async () => ({ kind: 'failed', reason: 'down', retryable: true }),
    }
    const loop = startBridgeLoop(s.deps, { accounts: [slow], collectMs: 0, log: s.log, everyMs: 1_000 })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(syncs).toBe(1)
    finish()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(syncs).toBe(2)
    loop.stop()
    finish()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(syncs).toBe(2)
  })
})
