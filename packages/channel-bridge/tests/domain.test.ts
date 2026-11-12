import { describe, it, expect } from 'vitest'
import { normalizeMailAddress, domainOf } from '../src/domain/address'
import { routeMessage } from '../src/domain/routing'
import type { JobRoute } from '../src/domain/routing'
import type { InboundMessage } from '../src/domain/inbound-message'
import { decideSend } from '../src/domain/send-policy'
import { replySubject, replyKey, newMailKey } from '../src/domain/reply'
import { approveDraft, skipDraft, markSent, markFailed, editDraft } from '../src/domain/outbox'
import type { OutboxItem } from '../src/domain/outbox'
import { addToWake, wakeDueAt, afterFailedDelivery, describeWake, MAX_DELIVERY_ATTEMPTS } from '../src/domain/wake'

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

const customerJob: JobRoute = {
  jobId: 'job-customer',
  space: 'support',
  matches: [{ kind: 'domain', domain: 'customer.example' }],
  reply: { mail: 'draft' },
  paused: false,
}
const personJob: JobRoute = {
  jobId: 'job-person',
  space: 'support',
  matches: [{ kind: 'address', address: 'anna@customer.example' }],
  reply: { mail: 'send' },
  paused: false,
}

describe('address', () => {
  it('normalises a mail address to lower case without spaces', () => {
    expect(normalizeMailAddress('  Anna@Customer.Example ')).toBe('anna@customer.example')
  })
  it('takes the domain after the last @', () => {
    expect(domainOf('anna@customer.example')).toBe('customer.example')
    expect(domainOf('no-at-sign')).toBeNull()
  })
})

describe('routeMessage', () => {
  it('routes by domain when the sender is verified', () => {
    expect(routeMessage(message(), { routes: [customerJob], threadOwner: null })).toEqual({
      kind: 'job', jobId: 'job-customer', reason: 'domain',
    })
  })

  it('sends an unverified sender at a matching domain to the inbox', () => {
    expect(routeMessage(message({ senderVerified: false }), { routes: [customerJob], threadOwner: null })).toEqual({
      kind: 'inbox', reason: 'sender_unverified',
    })
  })

  it('prefers an address match over a domain match', () => {
    expect(routeMessage(message(), { routes: [customerJob, personJob], threadOwner: null })).toEqual({
      kind: 'job', jobId: 'job-person', reason: 'address',
    })
  })

  it('prefers the job that already owns the thread', () => {
    const routing = routeMessage(message({ from: 'other@elsewhere.example' }), {
      routes: [customerJob, personJob], threadOwner: 'job-customer',
    })
    expect(routing).toEqual({ kind: 'job', jobId: 'job-customer', reason: 'thread' })
  })

  it('ignores a thread owner that is no longer a job', () => {
    const routing = routeMessage(message({ from: 'other@elsewhere.example' }), { routes: [customerJob], threadOwner: 'job-gone' })
    expect(routing).toEqual({ kind: 'inbox', reason: 'no_match' })
  })

  it('sends a message two jobs match equally to the inbox', () => {
    const second: JobRoute = { ...customerJob, jobId: 'job-second' }
    expect(routeMessage(message(), { routes: [customerJob, second], threadOwner: null })).toEqual({
      kind: 'inbox', reason: 'ambiguous',
    })
  })

  it('prefers the open job when an open and a paused job match equally', () => {
    const paused: JobRoute = { ...customerJob, jobId: 'job-paused', paused: true }
    expect(routeMessage(message(), { routes: [paused, customerJob], threadOwner: null })).toEqual({
      kind: 'job', jobId: 'job-customer', reason: 'domain',
    })
  })

  it('routes to a paused job that alone matches, so its mail waits for it', () => {
    const paused: JobRoute = { ...customerJob, paused: true }
    expect(routeMessage(message(), { routes: [paused], threadOwner: null })).toEqual({
      kind: 'job', jobId: 'job-customer', reason: 'domain',
    })
  })

  it('never routes automated mail', () => {
    expect(routeMessage(message({ automated: true }), { routes: [customerJob], threadOwner: 'job-customer' })).toEqual({
      kind: 'ignored', reason: 'automated',
    })
  })

  it('matches addresses and domains regardless of case', () => {
    const routing = routeMessage(message({ from: 'ANNA@Customer.Example' }), { routes: [personJob], threadOwner: null })
    expect(routing).toEqual({ kind: 'job', jobId: 'job-person', reason: 'address' })
  })

  it('does not match a subdomain or a look-alike domain', () => {
    for (const from of ['x@mail.customer.example', 'x@customer.example.evil', 'x@evilcustomer.example']) {
      expect(routeMessage(message({ from }), { routes: [customerJob], threadOwner: null })).toEqual({
        kind: 'inbox', reason: 'no_match',
      })
    }
  })
})

describe('decideSend', () => {
  it('drafts when the job replies on this channel as drafts', () => {
    expect(decideSend({ route: customerJob, channel: 'mail', recipient: 'anna@customer.example', knownToJob: false })).toEqual({
      kind: 'draft',
    })
  })

  it('sends when the job may send on this channel', () => {
    expect(decideSend({ route: personJob, channel: 'mail', recipient: 'anna@customer.example', knownToJob: false })).toEqual({
      kind: 'send',
    })
  })

  it('refuses a recipient outside the job, even for a job that may send', () => {
    expect(decideSend({ route: personJob, channel: 'mail', recipient: 'someone@elsewhere.example', knownToJob: false })).toEqual({
      kind: 'refused', reason: 'not_job_contact', retryable: false,
    })
  })

  it('allows a recipient who wrote to the job before', () => {
    expect(decideSend({ route: personJob, channel: 'mail', recipient: 'someone@elsewhere.example', knownToJob: true })).toEqual({
      kind: 'send',
    })
  })

  it('refuses a channel the job has no reply setting for', () => {
    const noReply: JobRoute = { ...customerJob, reply: {} }
    expect(decideSend({ route: noReply, channel: 'mail', recipient: 'anna@customer.example', knownToJob: false })).toEqual({
      kind: 'refused', reason: 'channel_not_attached', retryable: false,
    })
  })
})

describe('outbox', () => {
  const draft: OutboxItem = {
    id: 'o-1', jobId: 'job-customer', channel: 'mail', accountId: 'acc-1', to: 'anna@customer.example',
    threadKey: 't-1', subject: 'Re: Question', text: 'Answer', idempotencyKey: 'k-1', state: 'draft',
    channelMessageId: null, failure: null, replyToMessageId: null,
  }

  it('approving a draft makes it sending, skipping makes it skipped', () => {
    expect(approveDraft(draft)).toEqual({ ok: true, item: { ...draft, state: 'sending' } })
    expect(skipDraft(draft)).toEqual({ ok: true, item: { ...draft, state: 'skipped' } })
  })

  it('refuses to approve or skip anything but a draft', () => {
    const sent: OutboxItem = { ...draft, state: 'sent' }
    expect(approveDraft(sent)).toEqual({ ok: false, reason: 'not_a_draft' })
    expect(skipDraft(sent)).toEqual({ ok: false, reason: 'not_a_draft' })
  })

  it('edits a draft\'s text, and nothing else', () => {
    expect(editDraft(draft, 'Better answer')).toEqual({ ok: true, item: { ...draft, text: 'Better answer' } })
    expect(editDraft({ ...draft, state: 'sent' }, 'x')).toEqual({ ok: false, reason: 'not_a_draft' })
  })

  it('records the channel id when sent and the reason when failed', () => {
    const sending: OutboxItem = { ...draft, state: 'sending' }
    expect(markSent(sending, 'cm-9')).toEqual({ ...sending, state: 'sent', channelMessageId: 'cm-9' })
    expect(markFailed(sending, 'rejected')).toEqual({ ...sending, state: 'failed', failure: 'rejected' })
  })
})

describe('wake', () => {
  const collectMs = 120_000
  const owner = { jobId: 'job-1', space: 'support' }

  it('is due one collect window after its first entry, however many follow', () => {
    let wake = addToWake(null, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z', owner)
    wake = addToWake(wake, { kind: 'message', messageId: 'b' }, '2026-11-08T10:01:30.000Z', owner)
    expect(wake.entries).toHaveLength(2)
    expect(wakeDueAt(wake, collectMs)).toBe('2026-11-08T10:02:00.000Z')
  })

  it('is due at once when it holds a draft decision', () => {
    let wake = addToWake(null, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z', owner)
    wake = addToWake(wake, { kind: 'draft', outboxId: 'o-1', outcome: 'sent' }, '2026-11-08T10:00:10.000Z', owner)
    expect(wakeDueAt(wake, collectMs)).toBe('2026-11-08T10:00:10.000Z')
  })

  it('backs off after a failed delivery and gives up after the last attempt', () => {
    const wake = addToWake(null, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z', owner)
    const first = afterFailedDelivery(wake, '2026-11-08T10:02:00.000Z')
    expect(first).toMatchObject({ kind: 'retry', wake: { attempts: 1, retryAt: '2026-11-08T10:02:30.000Z' } })
    let current = wake
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      const next = afterFailedDelivery(current, '2026-11-08T10:02:00.000Z')
      if (next.kind !== 'retry') throw new Error('gave up too early')
      current = next.wake
    }
    expect(afterFailedDelivery(current, '2026-11-08T10:02:00.000Z')).toEqual({ kind: 'dead' })
  })

  it('a retry is due at its retry time, not at the collect window', () => {
    const wake = addToWake(null, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z', owner)
    const next = afterFailedDelivery(wake, '2026-11-08T10:05:00.000Z')
    if (next.kind !== 'retry') throw new Error('expected a retry')
    expect(wakeDueAt(next.wake, collectMs)).toBe('2026-11-08T10:05:30.000Z')
  })

  it('tells the session what arrived without quoting any message', () => {
    let wake = addToWake(null, { kind: 'message', messageId: 'a' }, '2026-11-08T10:00:00.000Z', owner)
    wake = addToWake(wake, { kind: 'message', messageId: 'b' }, '2026-11-08T10:00:01.000Z', owner)
    wake = addToWake(wake, { kind: 'draft', outboxId: 'o-1', outcome: 'skipped' }, '2026-11-08T10:00:02.000Z', owner)
    const text = describeWake(wake)
    expect(text).toContain('2 new messages')
    expect(text).toContain('1 draft decided')
    expect(text).toContain('msg_read')
  })
})

describe('reply', () => {
  it('answers a subject with one Re:', () => {
    expect(replySubject('Order')).toBe('Re: Order')
    expect(replySubject('Re: Order')).toBe('Re: Order')
    expect(replySubject('RE: Order')).toBe('RE: Order')
    expect(replySubject(null)).toBeNull()
  })

  it('names a reply by the message it answers and its text', () => {
    expect(replyKey('msg-1', 'Thanks')).toBe(replyKey('msg-1', 'Thanks'))
    expect(replyKey('msg-1', 'Thanks')).not.toBe(replyKey('msg-1', 'Thanks!'))
    expect(replyKey('msg-1', 'Thanks')).not.toBe(replyKey('msg-2', 'Thanks'))
  })
})

describe('newMailKey', () => {
  it('names a new mail by its recipient, subject and text', () => {
    expect(newMailKey('a@b.example', 'Hi', 'Text')).toBe(newMailKey('A@B.example', 'Hi', 'Text'))
    expect(newMailKey('a@b.example', 'Hi', 'Text')).not.toBe(newMailKey('a@b.example', 'Hi', 'Other'))
    expect(newMailKey('a@b.example', 'Hi', 'Text')).not.toBe(newMailKey('c@b.example', 'Hi', 'Text'))
  })
})
