/** A row the new id already held under the same unique key: that row stays, and the old id's row is left where it was. */
export interface RenameClash {
  store: 'wake_entries' | 'wake_retries' | 'outbox'
  /** The key both ids hold: a wake entry's key, the old job id for a retry state, an outbox item's idempotency key. */
  key: string
}

/** How many rows went to the new id per store, and what could not go. */
export interface JobRenamed {
  messages: number
  wakeEntries: number
  wakeRetries: number
  outbox: number
  clashes: RenameClash[]
}

/**
 * The job ids the bridge's stores hold. The cockpit owns the jobs and may give one a new id (a job that became
 * its task's record); what the bridge keeps for it has to follow, or its messages, wakes and drafts are filed
 * under an id the cockpit no longer knows.
 */
export interface JobIds {
  /**
   * Everything stored under `from` goes under `to`: its messages (with their routing), its wake entries and retry
   * state, its outbox. All of it or none (one transaction). Renaming again finds nothing left and changes nothing.
   * A row that would break a unique key (the new id holds the same wake entry, retry state or idempotency key)
   * is not moved: the new id's row is kept and the clash is named. Nothing is ever deleted.
   */
  rename(from: string, to: string): Promise<JobRenamed>
}
