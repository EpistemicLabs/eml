import { approveDraft } from '../domain/outbox'
import type { ChannelAccounts } from '../ports/channel'
import type { Clock } from '../ports/clock'
import type { OutboxStore } from '../ports/outbox-store'
import type { WakeQueue } from '../ports/wake-queue'
import { sendOutboxItem } from './send-outbox-item'
import type { SendStepResult } from './send-outbox-item'

export interface ApproveDraftDeps {
  outbox: OutboxStore
  channels: ChannelAccounts
  wakes: WakeQueue
  clock: Clock
}

export type ApproveDraftResult =
  | SendStepResult
  | { kind: 'refused'; reason: 'unknown_draft' | 'not_a_draft' | 'unknown_account'; retryable: false }

/** A person approved a draft: it is sent, and the job hears what came of it. */
export async function approveOutboxDraft(deps: ApproveDraftDeps, input: { outboxId: string }): Promise<ApproveDraftResult> {
  const item = await deps.outbox.get(input.outboxId)
  if (!item) return { kind: 'refused', reason: 'unknown_draft', retryable: false }
  const decision = approveDraft(item)
  if (!decision.ok) return { kind: 'refused', reason: decision.reason, retryable: false }
  const account = deps.channels.account(item.accountId)
  if (!account) return { kind: 'refused', reason: 'unknown_account', retryable: false }

  await deps.outbox.update(decision.item)
  const result = await sendOutboxItem(deps.outbox, account, decision.item)
  await deps.wakes.add(item.jobId, { kind: 'draft', outboxId: item.id, outcome: result.kind }, deps.clock.now())
  return result
}
