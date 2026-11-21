import { describe, it, expect } from 'vitest'
import type { InboundMessage } from '@engramprotocol/channel-bridge-sdk'
import { syncChannel } from '../src/application/sync-channel'
import { requestSend } from '../src/application/request-send'
import { skipOutboxDraft } from '../src/application/skip-outbox-draft'
import { MemoryMessageStore } from '../src/adapters/memory/memory-message-store'
import { MemoryWakeQueue } from '../src/adapters/memory/memory-wake-queue'
import { MemoryOutboxStore } from '../src/adapters/memory/memory-outbox-store'
import { MemoryJobDirectory } from '../src/adapters/memory/memory-job-directory'
import { FixedClock } from '../src/adapters/memory/fixed-clock'
import { SequentialIds } from '../src/adapters/memory/sequential-ids'
import { RecordingCockpit } from '../src/adapters/memory/recording-cockpit'
import { ScriptedChannel, ScriptedChannels } from '../src/adapters/fake-channel/scripted-channel'
import type { JobRoute } from '../src/domain/routing'

// No home space (plan item 5): an account belongs to every space where its plugin is on. Its
// messages are routed among the jobs of all of them, each wake goes to the job's own space, and
// what no job takes shows in the inbox of each of them.

const supportJob: JobRoute = { jobId: 'job-support', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' }, paused: false }
const salesJob: JobRoute = { jobId: 'job-sales', space: 'sales', matches: [{ kind: 'address', address: 'lead@prospect.example' }], reply: { mail: 'draft' }, paused: false }
const otherJob: JobRoute = { jobId: 'job-other', space: 'other', matches: [{ kind: 'address', address: 'x@elsewhere.example' }], reply: { mail: 'draft' }, paused: false }

function mail(id: string, from: string): Omit<InboundMessage, 'channel' | 'accountId'> {
  return { channelMessageId: id, threadKey: `t-${id}`, from, senderVerified: true, automated: false, receivedAt: '2026-11-21T10:00:00.000Z', subject: 'Hi', text: 'Hello' }
}

function world() {
  const channel = new ScriptedChannel('acc-1', ['support', 'sales'])
  return {
    channel,
    channels: new ScriptedChannels([channel]),
    store: new MemoryMessageStore(),
    wakes: new MemoryWakeQueue(),
    outbox: new MemoryOutboxStore(),
    jobs: new MemoryJobDirectory([supportJob, salesJob, otherJob]),
    clock: new FixedClock('2026-11-21T10:00:00.000Z'),
    ids: new SequentialIds('out'),
    cockpit: new RecordingCockpit(['job-support', 'job-sales']),
  }
}

describe('an account on in several spaces', () => {
  it('routes among the jobs of all its spaces and wakes each job in its own space', async () => {
    const w = world()
    await syncChannel(w, { account: w.channel })
    w.channel.receive(mail('m-1', 'anna@customer.example'))
    w.channel.receive(mail('m-2', 'lead@prospect.example'))
    // A job of a space the account is not on in never gets its messages.
    w.channel.receive(mail('m-3', 'x@elsewhere.example'))
    const summary = await syncChannel(w, { account: w.channel })
    expect(summary).toMatchObject({ stored: 3, toJobs: 2, toInbox: 1 })
    const owners = (await w.wakes.pending()).map((p) => ({ jobId: p.wake.jobId, space: p.wake.space }))
    expect(owners.sort((a, b) => a.jobId.localeCompare(b.jobId))).toEqual([
      { jobId: 'job-sales', space: 'sales' },
      { jobId: 'job-support', space: 'support' },
    ])
  })

  it('keeps an unmatched message once and shows it in the inbox of each of its spaces', async () => {
    const w = world()
    await syncChannel(w, { account: w.channel })
    w.channel.receive(mail('m-1', 'nobody@unknown.example'))
    await syncChannel(w, { account: w.channel })
    const inSupport = await w.store.inbox(w.channels.inSpace('support').map((a) => a.accountId), 10)
    const inSales = await w.store.inbox(w.channels.inSpace('sales').map((a) => a.accountId), 10)
    expect(inSupport.map((m) => m.channelMessageId)).toEqual(['m-1'])
    expect(inSales.map((m) => m.id)).toEqual(inSupport.map((m) => m.id))
    expect(await w.store.inbox(w.channels.inSpace('other').map((a) => a.accountId), 10)).toEqual([])
  })

  it('lets a job of any of its spaces send, refuses one of another space, and wakes a skipped draft in the job\'s space', async () => {
    const w = world()
    const send = (jobId: string, to: string, key: string) =>
      requestSend(w, { jobId, accountId: 'acc-1', to, threadKey: null, subject: 'Re', text: 'Thanks', idempotencyKey: key })
    const drafted = await send('job-sales', 'lead@prospect.example', 'k-1')
    expect(drafted.kind).toBe('drafted')
    expect(await send('job-other', 'x@elsewhere.example', 'k-2')).toMatchObject({ kind: 'refused', reason: 'unknown_account' })
    if (drafted.kind !== 'drafted') throw new Error('expected a draft')
    await skipOutboxDraft(w, { outboxId: drafted.outboxId })
    expect((await w.wakes.pending()).map((p) => p.wake.space)).toEqual(['sales'])
  })
})
