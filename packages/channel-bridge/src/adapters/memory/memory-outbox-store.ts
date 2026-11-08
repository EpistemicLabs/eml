import type { OutboxItem, OutboxState } from '../../domain/outbox'
import type { OutboxStore } from '../../ports/outbox-store'

export class MemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, OutboxItem>()

  async add(item: OutboxItem): Promise<void> {
    this.items.set(item.id, item)
  }

  async get(id: string): Promise<OutboxItem | null> {
    return this.items.get(id) ?? null
  }

  async byKey(jobId: string, idempotencyKey: string): Promise<OutboxItem | null> {
    for (const item of this.items.values()) {
      if (item.jobId === jobId && item.idempotencyKey === idempotencyKey) return item
    }
    return null
  }

  async update(item: OutboxItem): Promise<void> {
    this.items.set(item.id, item)
  }

  async replace(item: OutboxItem, expected: OutboxState): Promise<boolean> {
    if (this.items.get(item.id)?.state !== expected) return false
    this.items.set(item.id, item)
    return true
  }
}
