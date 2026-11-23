import type { OutboxItem, OutboxState } from '../domain/outbox'

export interface OutboxStore {
  add(item: OutboxItem): Promise<void>
  get(id: string): Promise<OutboxItem | null>
  byKey(jobId: string, idempotencyKey: string): Promise<OutboxItem | null>
  update(item: OutboxItem): Promise<void>
  /** The job's items still waiting as drafts, oldest first. */
  draftsForJob(jobId: string): Promise<OutboxItem[]>
  /** Stores the item only if it is still in the expected state; says whether it was. */
  replace(item: OutboxItem, expected: OutboxState): Promise<boolean>
}
