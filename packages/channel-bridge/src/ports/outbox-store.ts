import type { OutboxItem } from '../domain/outbox'

export interface OutboxStore {
  add(item: OutboxItem): Promise<void>
  get(id: string): Promise<OutboxItem | null>
  byKey(jobId: string, idempotencyKey: string): Promise<OutboxItem | null>
  update(item: OutboxItem): Promise<void>
}
