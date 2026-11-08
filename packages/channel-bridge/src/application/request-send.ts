import { normalizeMailAddress } from '../domain/address'
import { outcomeOf } from '../domain/outbox'
import type { OutboxItem } from '../domain/outbox'
import { decideSend } from '../domain/send-policy'
import type { ChannelAccounts } from '../ports/channel'
import type { IdSource } from '../ports/id-source'
import type { JobDirectory } from '../ports/job-directory'
import type { MessageStore } from '../ports/message-store'
import type { OutboxStore } from '../ports/outbox-store'
import { sendOutboxItem } from './send-outbox-item'
import type { SendStepResult } from './send-outbox-item'

export interface RequestSendDeps {
  jobs: JobDirectory
  channels: ChannelAccounts
  store: MessageStore
  outbox: OutboxStore
  ids: IdSource
}

export interface SendRequest {
  jobId: string
  accountId: string
  to: string
  threadKey: string | null
  subject: string | null
  text: string
  idempotencyKey: string
}

export type SendRequestResult =
  | SendStepResult
  | { kind: 'drafted'; outboxId: string }
  | { kind: 'refused'; reason: 'unknown_job' | 'unknown_account' | 'not_job_contact' | 'channel_not_attached'; retryable: false }

/**
 * A job asks to send a message. It goes out now, waits as a draft for a person, or is refused,
 * as the job's reply setting and its contacts say. The job names the request; asking again with
 * the same name answers with what came of the first, and finishes a send that was cut off.
 */
export async function requestSend(deps: RequestSendDeps, request: SendRequest): Promise<SendRequestResult> {
  const route = await deps.jobs.route(request.jobId)
  if (!route) return { kind: 'refused', reason: 'unknown_job', retryable: false }
  const account = deps.channels.account(request.accountId)
  if (!account || account.space !== route.space) return { kind: 'refused', reason: 'unknown_account', retryable: false }

  const earlier = await deps.outbox.byKey(request.jobId, request.idempotencyKey)
  if (earlier?.state === 'sending') return sendOutboxItem(deps.outbox, account, earlier)
  if (earlier) return outcomeOf(earlier)

  const to = normalizeMailAddress(request.to)
  const decision = decideSend({
    route,
    channel: account.channel,
    recipient: to,
    knownToJob: await deps.store.senderKnownToJob(request.jobId, to),
  })
  if (decision.kind === 'refused') return decision

  const item: OutboxItem = {
    id: deps.ids.next(),
    jobId: request.jobId,
    channel: account.channel,
    accountId: account.accountId,
    to,
    threadKey: request.threadKey,
    subject: request.subject,
    text: request.text,
    idempotencyKey: request.idempotencyKey,
    state: decision.kind === 'draft' ? 'draft' : 'sending',
    channelMessageId: null,
    failure: null,
  }
  await deps.outbox.add(item)
  if (decision.kind === 'draft') return { kind: 'drafted', outboxId: item.id }
  return sendOutboxItem(deps.outbox, account, item)
}

