import { describe, it, expect } from 'vitest'
import type { MessageStore } from '../../src/ports/message-store'
import type { WakeQueue } from '../../src/ports/wake-queue'
import type { OutboxStore } from '../../src/ports/outbox-store'
import type { InboundMessage } from '../../src/domain/inbound-message'
import type { OutboxItem } from '../../src/domain/outbox'

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'mail',
    accountId: 'acc-1',
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

const toJob = { kind: 'job', jobId: 'job-1', reason: 'domain' } as const
const toInbox = { kind: 'inbox', reason: 'no_match' } as const

/** What every MessageStore must do, run against the fake and each real adapter. */
export function messageStoreContract(name: string, make: () => MessageStore): void {
  describe(`MessageStore contract: ${name}`, () => {
    it('stores a message once per channel, account and channel id', async () => {
      const store = make()
      const first = await store.save(message(), toJob)
      expect(first.kind).toBe('stored')
      expect(await store.save(message({ text: 'changed' }), toJob)).toEqual({ kind: 'duplicate', id: first.kind === 'stored' ? first.id : '' })
      expect((await store.save(message({ accountId: 'acc-2' }), toJob)).kind).toBe('stored')
    })

    it('keeps the message and its routing as given', async () => {
      const store = make()
      const saved = await store.save(message({ subject: null }), toJob)
      if (saved.kind !== 'stored') throw new Error('expected stored')
      expect(await store.get(saved.id)).toEqual({ ...message({ subject: null }), id: saved.id, routing: toJob, read: false })
    })

    it('names the job a thread went to last, and none for an inbox thread', async () => {
      const store = make()
      await store.save(message({ threadKey: 't-inbox' }), toInbox)
      await store.save(message({ channelMessageId: 'm-2' }), toJob)
      await store.save(message({ channelMessageId: 'm-3' }), { kind: 'job', jobId: 'job-2', reason: 'thread' })
      expect(await store.threadOwner('acc-1', 't-1')).toBe('job-2')
      expect(await store.threadOwner('acc-1', 't-inbox')).toBeNull()
      expect(await store.threadOwner('acc-2', 't-1')).toBeNull()
    })

    it('knows who wrote to a job, regardless of case', async () => {
      const store = make()
      await store.save(message({ from: 'Anna@Customer.Example' }), toJob)
      expect(await store.senderKnownToJob('job-1', 'anna@customer.example')).toBe(true)
      expect(await store.senderKnownToJob('job-2', 'anna@customer.example')).toBe(false)
      expect(await store.senderKnownToJob('job-1', 'bob@customer.example')).toBe(false)
    })

    it('gets a message by id', async () => {
      const store = make()
      const saved = await store.save(message(), toJob)
      if (saved.kind !== 'stored') throw new Error('expected stored')
      expect((await store.get(saved.id))?.channelMessageId).toBe('m-1')
      expect(await store.get('no-such-id')).toBeNull()
    })

    it('hands out a job\'s unread messages until they are marked read', async () => {
      const store = make()
      const first = await store.save(message(), toJob)
      const second = await store.save(message({ channelMessageId: 'm-2' }), toJob)
      await store.save(message({ channelMessageId: 'm-3' }), toInbox)
      if (first.kind !== 'stored' || second.kind !== 'stored') throw new Error('expected stored')
      expect((await store.unreadForJob('job-1')).map((m) => m.id)).toEqual([first.id, second.id])
      await store.markRead([first.id])
      expect((await store.unreadForJob('job-1')).map((m) => m.id)).toEqual([second.id])
      expect((await store.get(first.id))?.channelMessageId).toBe('m-1')
    })

    it('keeps a cursor per account', async () => {
      const store = make()
      expect(await store.cursor('acc-1')).toBeNull()
      await store.setCursor('acc-1', '5')
      await store.setCursor('acc-1', '7')
      expect(await store.cursor('acc-1')).toBe('7')
      expect(await store.cursor('acc-2')).toBeNull()
    })
  })
}

/** What every WakeQueue must do. */
export function wakeQueueContract(name: string, make: () => WakeQueue): void {
  describe(`WakeQueue contract: ${name}`, () => {
    it('collects entries per job in order, from the first entry\'s time', async () => {
      const queue = make()
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z')
      await queue.add({ jobId: 'job-2', space: 'support' }, { kind: 'message', messageId: 'x' }, '2026-11-08T10:00:05.000Z')
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'draft', outboxId: 'o-1', outcome: 'sent' }, '2026-11-08T10:00:10.000Z')
      const pending = await queue.pending()
      const job1 = pending.find((p) => p.wake.jobId === 'job-1')
      expect(job1?.wake).toEqual({
        jobId: 'job-1',
        space: 'support',
        entries: [{ kind: 'message', messageId: 'a' }, { kind: 'draft', outboxId: 'o-1', outcome: 'sent' }],
        firstAt: '2026-11-08T10:00:00.000Z',
        draftAt: '2026-11-08T10:00:10.000Z',
        attempts: 0,
        retryAt: null,
      })
      expect(pending).toHaveLength(2)
    })

    it('keeps one live entry per message or draft decision', async () => {
      const queue = make()
      const owner = { jobId: 'job-1', space: 'support' }
      await queue.add(owner, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z')
      await queue.add(owner, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:05.000Z')
      await queue.add(owner, { kind: 'draft', outboxId: 'o-1', outcome: 'sent' }, '2026-11-08T10:00:06.000Z')
      await queue.add(owner, { kind: 'draft', outboxId: 'o-1', outcome: 'sent' }, '2026-11-08T10:00:07.000Z')
      expect((await queue.pending())[0]?.wake.entries).toHaveLength(2)
    })

    it('removes only what a delivery carried', async () => {
      const queue = make()
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z')
      const [first] = await queue.pending()
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'message', messageId: 'b' }, '2026-11-08T10:01:00.000Z')
      await queue.delivered('job-1', first?.upTo ?? 0)
      const [next] = await queue.pending()
      expect(next?.wake.entries).toEqual([{ kind: 'message', messageId: 'b' }])
      expect(next?.wake.firstAt).toBe('2026-11-08T10:01:00.000Z')
    })

    it('keeps the retry state until a delivery or a dead end clears it', async () => {
      const queue = make()
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z')
      await queue.retryLater('job-1', 2, '2026-11-08T10:05:00.000Z')
      expect((await queue.pending())[0]?.wake).toMatchObject({ attempts: 2, retryAt: '2026-11-08T10:05:00.000Z' })
      const [pending] = await queue.pending()
      await queue.dead('job-1', pending?.upTo ?? 0)
      expect(await queue.pending()).toEqual([])
      await queue.add({ jobId: 'job-1', space: 'support' }, { kind: 'message', messageId: 'b' }, '2026-11-08T10:06:00.000Z')
      expect((await queue.pending())[0]?.wake).toMatchObject({ attempts: 0, retryAt: null })
    })
  })
}

function item(over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'o-1', jobId: 'job-1', channel: 'mail', accountId: 'acc-1', to: 'anna@customer.example',
    threadKey: null, subject: null, text: 'Answer', idempotencyKey: 'k-1', state: 'draft',
    channelMessageId: null, failure: null, replyToMessageId: null, ...over,
  }
}

/** What every OutboxStore must do. */
export function outboxStoreContract(name: string, make: () => OutboxStore): void {
  describe(`OutboxStore contract: ${name}`, () => {
    it('finds an item by id and by its job and key', async () => {
      const outbox = make()
      await outbox.add(item())
      expect(await outbox.get('o-1')).toEqual(item())
      expect(await outbox.byKey('job-1', 'k-1')).toEqual(item())
      expect(await outbox.byKey('job-2', 'k-1')).toBeNull()
      expect(await outbox.get('o-2')).toBeNull()
    })

    it('moves an item on only from the state the caller saw', async () => {
      const outbox = make()
      await outbox.add(item())
      expect(await outbox.replace(item({ state: 'sending' }), 'draft')).toBe(true)
      expect(await outbox.replace(item({ state: 'skipped' }), 'draft')).toBe(false)
      expect((await outbox.get('o-1'))?.state).toBe('sending')
    })

    it('lists a job\'s drafts, oldest first', async () => {
      const outbox = make()
      await outbox.add(item())
      await outbox.add(item({ id: 'o-2', idempotencyKey: 'k-2', state: 'sent' }))
      await outbox.add(item({ id: 'o-3', idempotencyKey: 'k-3' }))
      await outbox.add(item({ id: 'o-4', jobId: 'job-2', idempotencyKey: 'k-4' }))
      expect((await outbox.draftsForJob('job-1')).map((entry) => entry.id)).toEqual(['o-1', 'o-3'])
    })

    it('keeps an update', async () => {
      const outbox = make()
      await outbox.add(item())
      await outbox.update(item({ state: 'sent', channelMessageId: 'cm-1' }))
      expect(await outbox.get('o-1')).toEqual(item({ state: 'sent', channelMessageId: 'cm-1' }))
    })
  })
}
