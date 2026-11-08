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

/**
 * A person approved a draft: it is sent, and the job hears what came of it. The approval may come
 * again (a retry, a second click): only the first moves the draft on, a cut-off send is finished,
 * and a finished one is answered with its outcome.
 */
export async function approveOutboxDraft(deps: ApproveDraftDeps, input: { outboxId: string }): Promise<ApproveDraftResult> {
  let item = await deps.outbox.get(input.outboxId)
  if (!item) return { kind: 'refused', reason: 'unknown_draft', retryable: false }
  const account = deps.channels.account(item.accountId)
  if (!account) return { kind: 'refused', reason: 'unknown_account', retryable: false }

  if (item.state === 'draft') {
    const decision = approveDraft(item)
    if (decision.ok && (await deps.outbox.replace(decision.item, 'draft'))) item = decision.item
    else item = (await deps.outbox.get(input.outboxId)) ?? item
  }
  if (item.state === 'draft' || item.state === 'skipped') return { kind: 'refused', reason: 'not_a_draft', retryable: false }

  const result: SendStepResult =
    item.state === 'sending'
      ? await sendOutboxItem(deps.outbox, account, item)
      : item.state === 'sent'
        ? { kind: 'sent', outboxId: item.id }
        : { kind: 'failed', outboxId: item.id, reason: item.failure ?? 'unknown', retryable: false }
  await deps.wakes.add({ jobId: item.jobId, space: account.space }, { kind: 'draft', outboxId: item.id, outcome: result.kind }, deps.clock.now())
  return result
}
