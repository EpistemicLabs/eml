/**
 * A one-time repair at the host's start, for homes that migrated jobs.json to version 2 before the migration
 * re-pointed the sessions of the jobs it dropped (application/job-migration.ts): such a session kept a version 1 job's
 * id as its ledger jobId, which names no record and no task. Every entry whose jobId is neither a record's id nor the
 * id of a version 1 job that still waits to move gets its task's id (a record's id is its task's id), or null when it
 * has no task. Safe to run at every start: a repaired entry names its task, and an entry that names its task already
 * is not counted, also when its record went.
 */

interface LedgerEntries {
  list(): ReadonlyArray<{ sessionId: string; jobId?: string | null; taskId?: string | null }>
  setJobId(sessionId: string, jobId: string | null): void
}

/** Re-point the stale entries; `known`: the id is a record's or a version 1 job's that waits. Returns how many changed. */
export function repairSessionJobIds(ledger: LedgerEntries, known: (jobId: string) => boolean): number {
  let repaired = 0
  for (const entry of ledger.list()) {
    if (!entry.jobId || known(entry.jobId)) continue
    const to = entry.taskId ?? null
    if (to === entry.jobId) continue
    ledger.setJobId(entry.sessionId, to)
    repaired += 1
  }
  return repaired
}
