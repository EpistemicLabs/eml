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
  /** The message it answers, or null for a new conversation. */
  replyToMessageId: string | null
}

export type DraftDecision = { ok: true; item: OutboxItem } | { ok: false; reason: 'not_a_draft' }

export function approveDraft(item: OutboxItem): DraftDecision {
  if (item.state !== 'draft') return { ok: false, reason: 'not_a_draft' }
  return { ok: true, item: { ...item, state: 'sending' } }
}

/** A person changed a draft's text before deciding on it. */
export function editDraft(item: OutboxItem, text: string): DraftDecision {
  if (item.state !== 'draft') return { ok: false, reason: 'not_a_draft' }
  return { ok: true, item: { ...item, text } }
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

/** A refusal that may pass later keeps the item sending, so the same request sends it again. */
export function markRetryableFailure(item: OutboxItem, failure: string): OutboxItem {
  return { ...item, state: 'sending', failure }
}

/** What an earlier item means for a request that names it again; an item still sending is finished by the caller. */
export type OutboxOutcome =
  | { kind: 'drafted'; outboxId: string }
  | { kind: 'sent'; outboxId: string }
  | { kind: 'failed'; outboxId: string; reason: string; retryable: false }

export function outcomeOf(item: OutboxItem): OutboxOutcome {
  switch (item.state) {
    case 'draft':
      return { kind: 'drafted', outboxId: item.id }
    case 'failed':
      return { kind: 'failed', outboxId: item.id, reason: item.failure ?? 'unknown', retryable: false }
    case 'skipped':
      return { kind: 'failed', outboxId: item.id, reason: 'skipped', retryable: false }
    case 'sending':
    case 'sent':
      return { kind: 'sent', outboxId: item.id }
  }
}
