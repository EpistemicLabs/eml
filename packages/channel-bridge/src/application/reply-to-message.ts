import { replyKey, replySubject } from '../domain/reply'
import { requestSend } from './request-send'
import type { RequestSendDeps, SendRequestResult } from './request-send'

export type ReplyResult = SendRequestResult | { kind: 'refused'; reason: 'unknown_message'; retryable: false }

/**
 * A job answers one of its messages: to its sender, in its thread, from the account it came in
 * on. The same text to the same message is one reply, however often the job asks.
 */
export async function replyToMessage(
  deps: RequestSendDeps,
  input: { jobId: string; messageId: string; text: string },
): Promise<ReplyResult> {
  const message = await deps.store.get(input.messageId)
  if (!message || message.routing.kind !== 'job' || message.routing.jobId !== input.jobId) {
    return { kind: 'refused', reason: 'unknown_message', retryable: false }
  }
  return requestSend(deps, {
    jobId: input.jobId,
    accountId: message.accountId,
    to: message.from,
    threadKey: message.threadKey,
    subject: replySubject(message.subject),
    text: input.text,
    idempotencyKey: replyKey(message.id, input.text),
  })
}
