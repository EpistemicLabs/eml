import type { JobIds, JobRenamed } from '../../ports/job-ids'
import type { MemoryMessageStore } from './memory-message-store'
import type { MemoryOutboxStore } from './memory-outbox-store'
import type { MemoryWakeQueue } from './memory-wake-queue'

/** Renames a job in the three in-memory stores that name one. */
export class MemoryJobIds implements JobIds {
  constructor(
    private readonly store: MemoryMessageStore,
    private readonly wakes: MemoryWakeQueue,
    private readonly outbox: MemoryOutboxStore,
  ) {}

  async rename(from: string, to: string): Promise<JobRenamed> {
    const messages = this.store.renameJob(from, to)
    const wakes = this.wakes.renameJob(from, to)
    const outbox = this.outbox.renameJob(from, to)
    return {
      messages,
      wakeEntries: wakes.entries,
      wakeRetries: wakes.retries,
      outbox: outbox.moved,
      clashes: [
        ...wakes.entryClashes.map((key) => ({ store: 'wake_entries' as const, key })),
        ...(wakes.retryClash ? [{ store: 'wake_retries' as const, key: from }] : []),
        ...outbox.clashes.map((key) => ({ store: 'outbox' as const, key })),
      ],
    }
  }
}
