import { editDraft } from '../domain/outbox'
import type { OutboxStore } from '../ports/outbox-store'

export type EditDraftResult =
  | { kind: 'edited'; outboxId: string }
  | { kind: 'refused'; reason: 'unknown_draft' | 'not_a_draft'; retryable: false }

/** A person changed a draft's text; only a draft no one has decided on yet can change. */
export async function editOutboxDraft(deps: { outbox: OutboxStore }, input: { outboxId: string; text: string }): Promise<EditDraftResult> {
  const item = await deps.outbox.get(input.outboxId)
  if (!item) return { kind: 'refused', reason: 'unknown_draft', retryable: false }
  const decision = editDraft(item, input.text)
  if (!decision.ok || !(await deps.outbox.replace(decision.item, 'draft'))) {
    return { kind: 'refused', reason: 'not_a_draft', retryable: false }
  }
  return { kind: 'edited', outboxId: item.id }
}
