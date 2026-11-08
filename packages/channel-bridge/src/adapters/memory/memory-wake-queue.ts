import { addToWake } from '../../domain/wake'
import type { Wake, WakeEntry, WakeOwner } from '../../domain/wake'
import type { PendingWake, WakeQueue } from '../../ports/wake-queue'

interface QueuedEntry {
  seq: number
  jobId: string
  space: string
  entry: WakeEntry
  at: string
  dead: boolean
}

export class MemoryWakeQueue implements WakeQueue {
  private readonly entries: QueuedEntry[] = []
  private readonly retries = new Map<string, { attempts: number; retryAt: string }>()
  private nextSeq = 1

  async add(owner: WakeOwner, entry: WakeEntry, at: string): Promise<void> {
    this.entries.push({ seq: this.nextSeq++, ...owner, entry, at, dead: false })
  }

  async pending(): Promise<PendingWake[]> {
    const byJob = new Map<string, PendingWake>()
    for (const queued of this.entries) {
      if (queued.dead) continue
      const current = byJob.get(queued.jobId)
      const wake: Wake = addToWake(current?.wake ?? null, queued.entry, queued.at, { jobId: queued.jobId, space: queued.space })
      byJob.set(queued.jobId, { wake, upTo: queued.seq })
    }
    for (const [jobId, pending] of byJob) {
      const retry = this.retries.get(jobId)
      if (retry) byJob.set(jobId, { ...pending, wake: { ...pending.wake, ...retry } })
    }
    return [...byJob.values()]
  }

  async delivered(jobId: string, upTo: number): Promise<void> {
    this.drop((queued) => queued.jobId === jobId && queued.seq <= upTo)
    this.retries.delete(jobId)
  }

  async retryLater(jobId: string, attempts: number, retryAt: string): Promise<void> {
    this.retries.set(jobId, { attempts, retryAt })
  }

  async dead(jobId: string, upTo: number): Promise<void> {
    for (const queued of this.entries) {
      if (queued.jobId === jobId && queued.seq <= upTo) queued.dead = true
    }
    this.retries.delete(jobId)
  }

  /** The entries no delivery could place, for a person to see. */
  deadEntries(): WakeEntry[] {
    return this.entries.filter((queued) => queued.dead).map((queued) => queued.entry)
  }

  private drop(predicate: (queued: QueuedEntry) => boolean): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const queued = this.entries[i]
      if (queued && predicate(queued)) this.entries.splice(i, 1)
    }
  }
}
