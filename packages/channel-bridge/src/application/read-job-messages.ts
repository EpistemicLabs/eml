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

/** Hands a job the messages it has not read yet, once. */
export async function readJobMessages(deps: ReadJobMessagesDeps, input: { jobId: string }): Promise<ReadJobMessagesResult> {
  if (!(await deps.jobs.route(input.jobId))) return { kind: 'refused', reason: 'unknown_job', retryable: false }
  const unread = await deps.store.unreadForJob(input.jobId)
  await deps.store.markRead(unread.map((message) => message.id))
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
