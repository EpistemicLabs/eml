import { newMailKey } from '../domain/reply'
import { requestSend } from './request-send'
import type { RequestSendDeps, SendRequestResult } from './request-send'

export type StartConversationResult =
  | SendRequestResult
  | { kind: 'refused'; reason: 'no_account' | 'several_accounts'; retryable: false }

/**
 * A job writes a new mail, not an answer: from the mail account of its space, to one of its own
 * contacts. It goes out or waits as a draft as the job's reply setting says, like a reply. The same
 * mail asked for twice is one mail.
 */
export async function startConversation(
  deps: RequestSendDeps,
  input: { jobId: string; to: string; subject: string; text: string },
): Promise<StartConversationResult> {
  const answer = await deps.jobs.route(input.jobId)
  if (answer.kind === 'unavailable') return answer
  if (!answer.route) return { kind: 'refused', reason: 'unknown_job', retryable: false }
  const accounts = deps.channels.inSpace(answer.route.space).filter((account) => account.channel === 'mail')
  if (accounts.length > 1) return { kind: 'refused', reason: 'several_accounts', retryable: false }
  const [account] = accounts
  if (!account) return { kind: 'refused', reason: 'no_account', retryable: false }
  return requestSend(deps, {
    jobId: input.jobId,
    accountId: account.accountId,
    to: input.to,
    threadKey: null,
    subject: input.subject,
    text: input.text,
    idempotencyKey: newMailKey(input.to, input.subject, input.text),
    replyToMessageId: null,
  })
}
