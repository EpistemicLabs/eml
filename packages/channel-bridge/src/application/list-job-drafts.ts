import type { MessageStore } from '../ports/message-store'
import type { OutboxStore } from '../ports/outbox-store'

export interface ListJobDraftsDeps {
  outbox: OutboxStore
  store: MessageStore
}

/** A draft as a person reviews it: what would go out, and the message it answers. */
export interface DraftView {
  outboxId: string
  to: string
  subject: string | null
  text: string
  replyTo: { id: string; from: string; subject: string | null; receivedAt: string; text: string } | null
}

/** The job's drafts waiting for a person, oldest first, each with the message it answers. */
export async function listJobDrafts(deps: ListJobDraftsDeps, input: { jobId: string }): Promise<{ kind: 'drafts'; drafts: DraftView[] }> {
  const drafts: DraftView[] = []
  for (const item of await deps.outbox.draftsForJob(input.jobId)) {
    const original = item.replyToMessageId ? await deps.store.get(item.replyToMessageId) : null
    drafts.push({
      outboxId: item.id,
      to: item.to,
      subject: item.subject,
      text: item.text,
      replyTo: original
        ? { id: original.id, from: original.from, subject: original.subject, receivedAt: original.receivedAt, text: original.text }
        : null,
    })
  }
  return { kind: 'drafts', drafts }
}
