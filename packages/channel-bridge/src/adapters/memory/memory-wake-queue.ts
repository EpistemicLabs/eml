import { pendingWakes, wakeEntryKey } from '../../domain/wake'
import type { PendingWake, QueuedWakeEntry, WakeEntry, WakeOwner, WakeRetry } from '../../domain/wake'
import type { WakeQueue } from '../../ports/wake-queue'

export class MemoryWakeQueue implements WakeQueue {
  private readonly entries: (QueuedWakeEntry & { dead: boolean })[] = []
  private readonly retries = new Map<string, WakeRetry>()
  private nextSeq = 1

  async add(owner: WakeOwner, entry: WakeEntry, at: string): Promise<void> {
    const key = wakeEntryKey(entry)
    const held = this.entries.some((queued) => !queued.dead && queued.jobId === owner.jobId && wakeEntryKey(queued.entry) === key)
    if (held) return
    this.entries.push({ seq: this.nextSeq++, ...owner, entry, at, dead: false })
  }

  async pending(): Promise<PendingWake[]> {
    return pendingWakes(this.entries.filter((queued) => !queued.dead), this.retries)
  }

  async delivered(jobId: string, upTo: number): Promise<void> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const queued = this.entries[i]
      if (queued && queued.jobId === jobId && queued.seq <= upTo) this.entries.splice(i, 1)
    }
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
}
