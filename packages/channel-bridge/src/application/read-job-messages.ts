import type { JobDirectory } from '../ports/job-directory'
import type { MessageStore } from '../ports/message-store'

export interface ReadJobMessagesDeps {
  jobs: JobDirectory
  store: MessageStore
}

/** What a job session sees of a message. */
export interface JobMessageView {
  id: string
  from: string
  subject: string | null
  receivedAt: string
  threadKey: string
  text: string
}

export type ReadJobMessagesResult =
  | { kind: 'messages'; messages: JobMessageView[] }
  | { kind: 'refused'; reason: 'unknown_job'; retryable: false }

/**
 * Hands a job the messages it has not confirmed yet. The job confirms what it got with its next
 * read, so a read whose answer was lost shows the same messages again. A job confirms only its own.
 */
export async function readJobMessages(
  deps: ReadJobMessagesDeps,
  input: { jobId: string; ack: string[] },
): Promise<ReadJobMessagesResult> {
  if (!(await deps.jobs.route(input.jobId))) return { kind: 'refused', reason: 'unknown_job', retryable: false }
  const confirmed = new Set(input.ack)
  const unconfirmed = await deps.store.unreadForJob(input.jobId)
  await deps.store.markRead(unconfirmed.filter((message) => confirmed.has(message.id)).map((message) => message.id))
  const unread = unconfirmed.filter((message) => !confirmed.has(message.id))
  return {
    kind: 'messages',
    messages: unread.map((message) => ({
      id: message.id,
      from: message.from,
      subject: message.subject,
      receivedAt: message.receivedAt,
      threadKey: message.threadKey,
      text: message.text,
    })),
  }
}
