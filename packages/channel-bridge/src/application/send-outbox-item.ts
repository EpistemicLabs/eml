import { markFailed, markRetryableFailure, markSent } from '../domain/outbox'
import type { OutboxItem } from '../domain/outbox'
import type { ChannelAccount } from '../ports/channel'
import type { OutboxStore } from '../ports/outbox-store'

export type SendStepResult =
  | { kind: 'sent'; outboxId: string }
  | { kind: 'failed'; outboxId: string; reason: string; retryable: boolean }

/**
 * Hands an item in state sending to its channel and records what came of it. A refusal that may
 * pass later leaves it sending, so asking again sends it again.
 */
export async function sendOutboxItem(outbox: OutboxStore, account: ChannelAccount, item: OutboxItem): Promise<SendStepResult> {
  const outcome = await account.send({
    to: item.to,
    threadKey: item.threadKey,
    subject: item.subject,
    text: item.text,
    idempotencyKey: item.idempotencyKey,
  })
  if (outcome.kind === 'sent') {
    await outbox.update(markSent(item, outcome.channelMessageId))
    return { kind: 'sent', outboxId: item.id }
  }
  await outbox.update(outcome.retryable ? markRetryableFailure(item, outcome.reason) : markFailed(item, outcome.reason))
  return { kind: 'failed', outboxId: item.id, reason: outcome.reason, retryable: outcome.retryable }
}
