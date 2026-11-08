import { skipDraft } from '../domain/outbox'
import type { ChannelAccounts } from '../ports/channel'
import type { Clock } from '../ports/clock'
import type { OutboxStore } from '../ports/outbox-store'
import type { WakeQueue } from '../ports/wake-queue'

export interface SkipDraftDeps {
  outbox: OutboxStore
  channels: ChannelAccounts
  wakes: WakeQueue
  clock: Clock
}

export type SkipDraftResult =
  | { kind: 'skipped'; outboxId: string }
  | { kind: 'refused'; reason: 'unknown_draft' | 'not_a_draft' | 'unknown_account'; retryable: false }

/** A person decided against a draft: nothing is sent, and the job hears it. */
export async function skipOutboxDraft(deps: SkipDraftDeps, input: { outboxId: string }): Promise<SkipDraftResult> {
  const item = await deps.outbox.get(input.outboxId)
  if (!item) return { kind: 'refused', reason: 'unknown_draft', retryable: false }
  const decision = skipDraft(item)
  if (!decision.ok) return { kind: 'refused', reason: decision.reason, retryable: false }
  const account = deps.channels.account(item.accountId)
  if (!account) return { kind: 'refused', reason: 'unknown_account', retryable: false }
  await deps.outbox.update(decision.item)
  await deps.wakes.add({ jobId: item.jobId, space: account.space }, { kind: 'draft', outboxId: item.id, outcome: 'skipped' }, deps.clock.now())
  return { kind: 'skipped', outboxId: item.id }
}
