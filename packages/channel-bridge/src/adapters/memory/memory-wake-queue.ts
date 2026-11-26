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

  /**
   * The job's entries and retry state go to another job id (MemoryJobIds). An entry the new id already holds stays.
   * Of two retry states the one that comes due earlier is kept under the new id; the other goes.
   */
  renameJob(from: string, to: string): { entries: number; retries: number; entryClashes: string[] } {
    const entryClashes: string[] = []
    let entries = 0
    for (const queued of this.entries) {
      if (queued.jobId !== from) continue
      const key = wakeEntryKey(queued.entry)
      // Only live entries are unique per job; a dead one moves whatever the new id holds.
      const held = !queued.dead && this.entries.some((other) => !other.dead && other.jobId === to && wakeEntryKey(other.entry) === key)
      if (held) entryClashes.push(key)
      else {
        queued.jobId = to
        entries += 1
      }
    }
    const retry = this.retries.get(from)
    const held = this.retries.get(to)
    const moves = retry !== undefined && (held === undefined || retry.retryAt < held.retryAt)
    this.retries.delete(from)
    if (retry && moves) this.retries.set(to, retry)
    return { entries, retries: moves ? 1 : 0, entryClashes }
  }

  /** The entries no delivery could place, for a person to see. */
  deadEntries(): WakeEntry[] {
    return this.entries.filter((queued) => queued.dead).map((queued) => queued.entry)
  }
}
