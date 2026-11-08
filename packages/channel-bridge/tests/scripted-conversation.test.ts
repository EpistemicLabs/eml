import { describe, it, expect } from 'vitest'
import { syncChannel } from '../src/application/sync-channel'
import { dispatchWakes } from '../src/application/dispatch-wakes'
import { requestSend } from '../src/application/request-send'
import { approveOutboxDraft } from '../src/application/approve-outbox-draft'
import { openBridgeDatabase } from '../src/adapters/sqlite/bridge-database'
import { SqliteMessageStore } from '../src/adapters/sqlite/sqlite-message-store'
import { SqliteWakeQueue } from '../src/adapters/sqlite/sqlite-wake-queue'
import { SqliteOutboxStore } from '../src/adapters/sqlite/sqlite-outbox-store'
import { MemoryJobDirectory } from '../src/adapters/memory/memory-job-directory'
import { FixedClock } from '../src/adapters/memory/fixed-clock'
import { SequentialIds } from '../src/adapters/memory/sequential-ids'
import { RecordingCockpit } from '../src/adapters/memory/recording-cockpit'
import { ScriptedChannel, ScriptedChannels } from '../src/adapters/fake-channel/scripted-channel'

const COLLECT_MS = 120_000

// A standing customer job on one mailbox, end to end over the real store: two mails from the
// customer's domain, a newsletter and a stranger; one wake; a draft; approval; the outcome wakes
// the job again; a reply in the same thread from a colleague outside the domain still reaches it.
describe('scripted conversation: a standing customer job', () => {
  it('runs from first mail to sent reply', async () => {
    const db = openBridgeDatabase(':memory:')
    const mailbox = new ScriptedChannel('support-mailbox', 'support')
    const w = {
      channels: new ScriptedChannels([mailbox]),
      store: new SqliteMessageStore(db),
      wakes: new SqliteWakeQueue(db),
      outbox: new SqliteOutboxStore(db),
      jobs: new MemoryJobDirectory([
        { jobId: 'job-customer', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' } },
      ]),
      clock: new FixedClock('2026-11-08T10:00:00.000Z'),
      ids: new SequentialIds('out'),
      cockpit: new RecordingCockpit(),
    }
    await syncChannel(w, { account: mailbox })

    const base = { senderVerified: true, automated: false, receivedAt: w.clock.now(), subject: 'Order', text: 'Where is it?' }
    mailbox.receive({ ...base, channelMessageId: 'm-1', threadKey: 't-1', from: 'anna@customer.example' })
    mailbox.receive({ ...base, channelMessageId: 'm-2', threadKey: 't-2', from: 'ben@customer.example' })
    mailbox.receive({ ...base, channelMessageId: 'm-3', threadKey: 't-3', from: 'news@shop.example', automated: true })
    mailbox.receive({ ...base, channelMessageId: 'm-4', threadKey: 't-4', from: 'x@customer.example', senderVerified: false })
    expect(await syncChannel(w, { account: mailbox })).toEqual({ stored: 4, duplicates: 0, toJobs: 2, toInbox: 1, ignored: 1 })

    w.clock.advance(COLLECT_MS)
    await dispatchWakes(w, { collectMs: COLLECT_MS })
    expect(w.cockpit.requests.map((r) => r.text)).toEqual([expect.stringContaining('2 new messages')])

    const drafted = await requestSend(w, {
      jobId: 'job-customer', accountId: 'support-mailbox', to: 'anna@customer.example', threadKey: 't-1',
      subject: 'Re: Order', text: 'It ships today.', idempotencyKey: 'reply-t-1',
    })
    expect(drafted).toEqual({ kind: 'drafted', outboxId: 'out-1' })
    expect(mailbox.sent).toEqual([])

    expect(await approveOutboxDraft(w, { outboxId: 'out-1' })).toEqual({ kind: 'sent', outboxId: 'out-1' })
    expect(mailbox.sent).toHaveLength(1)
    await dispatchWakes(w, { collectMs: COLLECT_MS })
    expect(w.cockpit.requests[1]?.text).toContain('1 draft decided')

    mailbox.receive({ ...base, channelMessageId: 'm-5', threadKey: 't-1', from: 'colleague@partner.example' })
    expect(await syncChannel(w, { account: mailbox })).toMatchObject({ toJobs: 1 })
    expect((await w.store.unreadForJob('job-customer')).map((m) => m.channelMessageId)).toEqual(['m-1', 'm-2', 'm-5'])
  })
})
