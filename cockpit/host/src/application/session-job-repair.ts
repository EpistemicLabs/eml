import type { JobStore } from '../job-store.js'

/**
 * A ledger jobId names a record or a version 1 job that still waits; any other id is replaced at start by the
 * session's task id when it has one. An entry without a task keeps its id, so it stays as limited as it was. Nothing
 * changes while jobs.json could not be read: every id would look stale then. Safe at every start: an entry that names
 * its task already is not counted, also when its record went.
 */

interface LedgerEntries {
  list(): ReadonlyArray<{ sessionId: string; jobId?: string | null; taskId?: string | null }>
  setJobId(sessionId: string, jobId: string): void
}

/** Re-point the entries whose jobId names neither a record nor a waiting version 1 job. Returns how many changed. */
export function repairSessionJobIds(ledger: LedgerEntries, store: Pick<JobStore, 'get' | 'pendingV1' | 'notUsable'>): number {
  if (store.notUsable()) return 0
  const known = (id: string) => store.get(id) !== undefined || store.pendingV1()?.jobs[id] !== undefined
  let repaired = 0
  for (const entry of ledger.list()) {
    if (!entry.jobId || !entry.taskId || entry.taskId === entry.jobId || known(entry.jobId)) continue
    ledger.setJobId(entry.sessionId, entry.taskId)
    repaired += 1
  }
  return repaired
}
