import { activeGrants, ENDED_BEFORE_START, type GrantTool, type Job } from '../domain/job.js'
import type { JobStore } from '../job-store.js'

/**
 * The owner ended a task's schedule (End schedule and close): what this cockpit keeps for the task (domain/job.ts)
 * ends with it. Its channels no longer wake it, lent tools go back, and a run that was due but had not started is
 * skipped: it would start on a closed task. An end after so many runs goes with the repeating times it counted for.
 * A run a session already has goes on. The record itself stays for its
 * runs; it goes by the rule for every record (domain/job.ts recordKeeping). Safe to call again.
 *
 * The pass calls it too for a task that was closed some other way (Close, Looks good, an agent's own close): a closed
 * task stops listening. `note` then says why a waiting run never started.
 */
export function endTaskRecord(
  store: Pick<JobStore<Job>, 'get' | 'put' | 'runs' | 'updateRun'>, taskId: string, now: number, onGrantEnd?: (record: Job, tools: GrantTool[]) => void,
  note: string = ENDED_BEFORE_START,
): void {
  const record = store.get(taskId)
  if (!record) return
  const at = new Date(now).toISOString()
  const lent = activeGrants(record, now).map((grant) => grant.tool)
  if (record.triggers.length > 0 || record.grants?.length || record.pendingApproval || record.end) {
    const { pendingApproval: _waited, ...rest } = record
    // An end after so many runs was for the repeating times that ended: a schedule set later starts without it.
    store.put({ ...rest, triggers: [], grants: [], end: null, updatedAt: at })
  }
  for (const run of store.runs(taskId)) {
    if (run.status === 'waiting') store.updateRun({ ...run, status: 'skipped', note, finishedAt: at })
  }
  if (lent.length > 0) onGrantEnd?.(store.get(taskId) ?? record, lent)
}

/**
 * The task's repeating times ended or were replaced: an end after so many runs (the record's `end`) was theirs and
 * goes with them, so a record that stays (a channel, a limit) never ends a schedule set later. Safe to call again.
 */
export function endRunCount(store: Pick<JobStore<Job>, 'get' | 'put'>, taskId: string, now: number): void {
  const record = store.get(taskId)
  if (record?.end) store.put({ ...record, end: null, updatedAt: new Date(now).toISOString() })
}
