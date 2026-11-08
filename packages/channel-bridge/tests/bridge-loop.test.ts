import { describe, it, expect } from 'vitest'
import { runBridgeTick } from '../src/entrypoints/bridge-loop'
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
    cockpit: new RecordingCockpit(),
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
