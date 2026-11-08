import type { Channel } from './address'

/**
 * draft     waits for a person
 * sending   approved, or sent directly; on its way to the channel
 * sent      the channel took it
 * skipped   a person decided against it
 * failed    the channel refused it
 */
export type OutboxState = 'draft' | 'sending' | 'sent' | 'skipped' | 'failed'

export interface OutboxItem {
  id: string
  jobId: string
  channel: Channel
  accountId: string
  to: string
  /** The conversation it answers, or null for a new one. */
  threadKey: string | null
  subject: string | null
  text: string
  /** Named by the job: the same key twice is the same message. */
  idempotencyKey: string
  state: OutboxState
  channelMessageId: string | null
  failure: string | null
}

export type DraftDecision = { ok: true; item: OutboxItem } | { ok: false; reason: 'not_a_draft' }

export function approveDraft(item: OutboxItem): DraftDecision {
  if (item.state !== 'draft') return { ok: false, reason: 'not_a_draft' }
  return { ok: true, item: { ...item, state: 'sending' } }
}

export function skipDraft(item: OutboxItem): DraftDecision {
  if (item.state !== 'draft') return { ok: false, reason: 'not_a_draft' }
  return { ok: true, item: { ...item, state: 'skipped' } }
}

export function markSent(item: OutboxItem, channelMessageId: string): OutboxItem {
  return { ...item, state: 'sent', channelMessageId }
}

export function markFailed(item: OutboxItem, failure: string): OutboxItem {
  return { ...item, state: 'failed', failure }
}
