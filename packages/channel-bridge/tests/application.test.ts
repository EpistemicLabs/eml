import { describe, it, expect, beforeEach } from 'vitest'
import { syncChannel } from '../src/application/sync-channel'
import { dispatchWakes } from '../src/application/dispatch-wakes'
import { requestSend } from '../src/application/request-send'
import { approveOutboxDraft } from '../src/application/approve-outbox-draft'
import { skipOutboxDraft } from '../src/application/skip-outbox-draft'
import { readJobMessages } from '../src/application/read-job-messages'
import { replyToMessage } from '../src/application/reply-to-message'
import { MemoryMessageStore } from '../src/adapters/memory/memory-message-store'
import { MemoryWakeQueue } from '../src/adapters/memory/memory-wake-queue'
import { MemoryOutboxStore } from '../src/adapters/memory/memory-outbox-store'
import { MemoryJobDirectory } from '../src/adapters/memory/memory-job-directory'
import { FixedClock } from '../src/adapters/memory/fixed-clock'
import { SequentialIds } from '../src/adapters/memory/sequential-ids'
import { RecordingCockpit } from '../src/adapters/memory/recording-cockpit'
import { ScriptedChannel, ScriptedChannels } from '../src/adapters/fake-channel/scripted-channel'
import type { JobRoute } from '../src/domain/routing'
import type { InboundMessage } from '../src/domain/inbound-message'

const COLLECT_MS = 120_000

const customerJob: JobRoute = {
  jobId: 'job-customer',
  space: 'support',
  matches: [{ kind: 'domain', domain: 'customer.example' }],
  reply: { mail: 'draft' },
}

function mail(over: Partial<Omit<InboundMessage, 'channel' | 'accountId'>> = {}): Omit<InboundMessage, 'channel' | 'accountId'> {
  return {
    channelMessageId: 'm-1',
    threadKey: 't-1',
    from: 'anna@customer.example',
    senderVerified: true,
    automated: false,
    receivedAt: '2026-11-08T10:00:00.000Z',
    subject: 'Question',
    text: 'Hello',
    ...over,
  }
}

function world() {
  const channel = new ScriptedChannel('acc-1', 'support')
  const deps = {
    channel,
    channels: new ScriptedChannels([channel]),
    store: new MemoryMessageStore(),
    wakes: new MemoryWakeQueue(),
    outbox: new MemoryOutboxStore(),
    jobs: new MemoryJobDirectory([customerJob]),
    clock: new FixedClock('2026-11-08T10:00:00.000Z'),
    ids: new SequentialIds('out'),
    cockpit: new RecordingCockpit(),
  }
  return deps
}

describe('syncChannel', () => {
  let w: ReturnType<typeof world>
  beforeEach(async () => {
    w = world()
    await syncChannel(w, { account: w.channel })
  })

  it('starts from now: the first sync stores nothing and keeps the cursor', async () => {
    expect(await w.store.cursor('acc-1')).toBe('0')
  })

  it('stores a matching message once and queues one wake for its job', async () => {
    w.channel.receive(mail())
    const first = await syncChannel(w, { account: w.channel })
    expect(first).toEqual({ stored: 1, duplicates: 0, toJobs: 1, toInbox: 0, ignored: 0 })
    await w.store.setCursor('acc-1', '0')
    const again = await syncChannel(w, { account: w.channel })
    expect(again).toEqual({ stored: 0, duplicates: 1, toJobs: 0, toInbox: 0, ignored: 0 })
    const pending = await w.wakes.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.wake.entries).toHaveLength(1)
  })

  it('keeps a message from an unknown domain in the inbox without waking anything', async () => {
    w.channel.receive(mail({ from: 'x@elsewhere.example' }))
    const result = await syncChannel(w, { account: w.channel })
    expect(result).toMatchObject({ stored: 1, toInbox: 1, toJobs: 0 })
    expect(await w.wakes.pending()).toEqual([])
  })

  it('routes a reply in a known thread to the thread\'s job, whoever sends it', async () => {
    w.channel.receive(mail())
    w.channel.receive(mail({ channelMessageId: 'm-2', from: 'colleague@partner.example' }))
    const result = await syncChannel(w, { account: w.channel })
    expect(result).toMatchObject({ toJobs: 2 })
  })

  it('stores nothing and keeps the cursor when the job directory cannot answer', async () => {
    w.channel.receive(mail())
    const failing = { ...w, jobs: { routesInSpace: async () => { throw new Error('cockpit away') }, route: async () => null } }
    await expect(syncChannel(failing, { account: w.channel })).rejects.toThrow('cockpit away')
    expect(await w.store.cursor('acc-1')).toBe('0')
    expect(await syncChannel(w, { account: w.channel })).toMatchObject({ stored: 1, toJobs: 1 })
  })

  it('sees only the jobs of the account\'s own space', async () => {
    w.jobs.set([{ ...customerJob, space: 'errands' }])
    w.channel.receive(mail())
    expect(await syncChannel(w, { account: w.channel })).toMatchObject({ toInbox: 1, toJobs: 0 })
  })
})

describe('dispatchWakes', () => {
  let w: ReturnType<typeof world>
  beforeEach(async () => {
    w = world()
    await syncChannel(w, { account: w.channel })
    w.channel.receive(mail())
    w.channel.receive(mail({ channelMessageId: 'm-2' }))
    await syncChannel(w, { account: w.channel })
  })

  it('waits for the collect window, then wakes the job once for everything that came', async () => {
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 0, retrying: 0, dead: 0 })
    w.clock.advance(COLLECT_MS)
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 1, retrying: 0, dead: 0 })
    expect(w.cockpit.requests).toHaveLength(1)
    expect(w.cockpit.requests[0]).toMatchObject({ jobId: 'job-customer', space: 'support' })
    expect(w.cockpit.requests[0]?.text).toContain('2 new messages')
    expect(w.cockpit.requests[0]?.text).not.toContain('Hello')
    expect(await w.wakes.pending()).toEqual([])
  })

  it('names each wake so the cockpit can tell a retry from a new wake', async () => {
    w.clock.advance(COLLECT_MS)
    w.cockpit.answer('job-customer', 'retry')
    await dispatchWakes(w, { collectMs: COLLECT_MS })
    w.clock.advance(60_000)
    await dispatchWakes(w, { collectMs: COLLECT_MS })
    const keys = w.cockpit.requests.map((request) => request.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('retries later when the cockpit has no room, and not before the retry time', async () => {
    w.clock.advance(COLLECT_MS)
    w.cockpit.answer('job-customer', 'retry')
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 0, retrying: 1, dead: 0 })
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 0, retrying: 0, dead: 0 })
    w.cockpit.answer('job-customer', 'delivered')
    w.clock.advance(30_000)
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 1, retrying: 0, dead: 0 })
  })

  it('keeps a wake the job refuses as dead, for a person to see', async () => {
    w.clock.advance(COLLECT_MS)
    w.cockpit.answer('job-customer', 'refused')
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toEqual({ delivered: 0, retrying: 0, dead: 1 })
    expect(await w.wakes.pending()).toEqual([])
    expect(w.wakes.deadEntries()).toHaveLength(2)
  })

  it('a message that arrives during delivery waits for the next wake', async () => {
    w.clock.advance(COLLECT_MS)
    const pendingBefore = await w.wakes.pending()
    await w.wakes.add({ jobId: 'job-customer', space: 'support' }, { kind: 'message', messageId: 'late' }, w.clock.now())
    await w.wakes.delivered('job-customer', pendingBefore[0]?.upTo ?? 0)
    const after = await w.wakes.pending()
    expect(after).toHaveLength(1)
    expect(after[0]?.wake.entries).toEqual([{ kind: 'message', messageId: 'late' }])
  })
})

describe('sending', () => {
  let w: ReturnType<typeof world>
  beforeEach(async () => {
    w = world()
    await syncChannel(w, { account: w.channel })
  })

  const reply = {
    jobId: 'job-customer',
    accountId: 'acc-1',
    to: 'anna@customer.example',
    threadKey: 't-1',
    subject: 'Re: Question',
    text: 'Answer',
    idempotencyKey: 'reply-1',
  }

  it('holds a draft for a job that replies as drafts, and sends nothing', async () => {
    expect(await requestSend(w, reply)).toEqual({ kind: 'drafted', outboxId: 'out-1' })
    expect(w.channel.sent).toEqual([])
  })

  it('sends at once for a job that may send', async () => {
    w.jobs.set([{ ...customerJob, reply: { mail: 'send' } }])
    expect(await requestSend(w, reply)).toEqual({ kind: 'sent', outboxId: 'out-1' })
    expect(w.channel.sent).toHaveLength(1)
  })

  it('answers the same request twice with the first result', async () => {
    await requestSend(w, reply)
    expect(await requestSend(w, reply)).toEqual({ kind: 'drafted', outboxId: 'out-1' })
  })

  it('finishes a send that was cut off, and the channel sends it once', async () => {
    w.jobs.set([{ ...customerJob, reply: { mail: 'send' } }])
    await w.outbox.add({
      id: 'out-cut', jobId: 'job-customer', channel: 'mail', accountId: 'acc-1', to: 'anna@customer.example',
      threadKey: 't-1', subject: 'Re: Question', text: 'Answer', idempotencyKey: 'reply-1', state: 'sending',
      channelMessageId: null, failure: null,
    })
    expect(await requestSend(w, reply)).toEqual({ kind: 'sent', outboxId: 'out-cut' })
    expect(await requestSend(w, reply)).toEqual({ kind: 'sent', outboxId: 'out-cut' })
    expect(w.channel.sent).toHaveLength(1)
  })

  it('refuses a recipient outside the job', async () => {
    expect(await requestSend(w, { ...reply, to: 'someone@elsewhere.example' })).toEqual({
      kind: 'refused', reason: 'not_job_contact', retryable: false,
    })
  })

  it('refuses an unknown job and an account of another space', async () => {
    expect(await requestSend(w, { ...reply, jobId: 'job-gone' })).toEqual({
      kind: 'refused', reason: 'unknown_job', retryable: false,
    })
    w.jobs.set([{ ...customerJob, space: 'errands' }])
    expect(await requestSend(w, reply)).toEqual({ kind: 'refused', reason: 'unknown_account', retryable: false })
  })

  it('approving a draft sends it and wakes the job at once with the outcome', async () => {
    await requestSend(w, reply)
    expect(await approveOutboxDraft(w, { outboxId: 'out-1' })).toEqual({ kind: 'sent', outboxId: 'out-1' })
    expect(w.channel.sent).toHaveLength(1)
    expect(await dispatchWakes(w, { collectMs: COLLECT_MS })).toMatchObject({ delivered: 1 })
    expect(w.cockpit.requests[0]?.text).toContain('1 draft decided')
  })

  it('approving twice sends once', async () => {
    await requestSend(w, reply)
    await approveOutboxDraft(w, { outboxId: 'out-1' })
    expect(await approveOutboxDraft(w, { outboxId: 'out-1' })).toEqual({ kind: 'refused', reason: 'not_a_draft', retryable: false })
    expect(w.channel.sent).toHaveLength(1)
  })

  it('skipping a draft sends nothing and tells the job', async () => {
    await requestSend(w, reply)
    expect(await skipOutboxDraft(w, { outboxId: 'out-1' })).toEqual({ kind: 'skipped', outboxId: 'out-1' })
    expect(w.channel.sent).toEqual([])
    expect((await w.wakes.pending())[0]?.wake.entries).toEqual([{ kind: 'draft', outboxId: 'out-1', outcome: 'skipped' }])
  })

  it('reports a channel refusal with whether a retry can help', async () => {
    w.jobs.set([{ ...customerJob, reply: { mail: 'send' } }])
    w.channel.refuseSends('rate_limited', true)
    expect(await requestSend(w, reply)).toEqual({ kind: 'failed', outboxId: 'out-1', reason: 'rate_limited', retryable: true })
    expect((await w.outbox.get('out-1'))?.state).toBe('failed')
  })
})

describe('reading and replying', () => {
  let w: ReturnType<typeof world>
  beforeEach(async () => {
    w = world()
    await syncChannel(w, { account: w.channel })
    w.channel.receive(mail())
    w.channel.receive(mail({ channelMessageId: 'm-2', from: 'x@elsewhere.example', threadKey: 't-9' }))
    await syncChannel(w, { account: w.channel })
  })

  it('hands a job its unread messages once', async () => {
    const first = await readJobMessages(w, { jobId: 'job-customer' })
    expect(first.kind === 'messages' && first.messages.map((m) => m.from)).toEqual(['anna@customer.example'])
    expect(await readJobMessages(w, { jobId: 'job-customer' })).toEqual({ kind: 'messages', messages: [] })
  })

  it('refuses to read for an unknown job', async () => {
    expect(await readJobMessages(w, { jobId: 'job-gone' })).toEqual({ kind: 'refused', reason: 'unknown_job', retryable: false })
  })

  it('replies in the message\'s thread, to its sender, from its account', async () => {
    const read = await readJobMessages(w, { jobId: 'job-customer' })
    const id = read.kind === 'messages' ? read.messages[0]?.id ?? '' : ''
    expect(await replyToMessage(w, { jobId: 'job-customer', messageId: id, text: 'It ships today.' })).toEqual({
      kind: 'drafted', outboxId: 'out-1',
    })
    expect(await w.outbox.get('out-1')).toMatchObject({
      to: 'anna@customer.example', threadKey: 't-1', subject: 'Re: Question', accountId: 'acc-1', state: 'draft',
    })
    expect(await replyToMessage(w, { jobId: 'job-customer', messageId: id, text: 'It ships today.' })).toEqual({
      kind: 'drafted', outboxId: 'out-1',
    })
  })

  it('refuses to reply to a message of another job or the inbox', async () => {
    const inbox = (await w.store.forJob('job-customer')).length
    expect(inbox).toBe(1)
    expect(await replyToMessage(w, { jobId: 'job-customer', messageId: 'msg-2', text: 'Hi' })).toEqual({
      kind: 'refused', reason: 'unknown_message', retryable: false,
    })
  })
})
