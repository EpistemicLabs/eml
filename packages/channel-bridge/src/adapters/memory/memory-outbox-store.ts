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

  async draftsForJob(jobId: string): Promise<OutboxItem[]> {
    return [...this.items.values()].filter((item) => item.jobId === jobId && item.state === 'draft')
  }

  /** The job's items go to another job id (MemoryJobIds); one whose key the new id already holds stays. */
  renameJob(from: string, to: string): { moved: number; clashes: string[] } {
    const clashes: string[] = []
    let moved = 0
    for (const item of [...this.items.values()]) {
      if (item.jobId !== from) continue
      const held = [...this.items.values()].some((other) => other.jobId === to && other.idempotencyKey === item.idempotencyKey)
      if (held) clashes.push(item.idempotencyKey)
      else {
        this.items.set(item.id, { ...item, jobId: to })
        moved += 1
      }
    }
    return { moved, clashes }
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
