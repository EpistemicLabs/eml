import { activeGrants, ENDED_BEFORE_START, type GrantTool, type Job } from '../domain/job.js'
import type { JobStore } from '../job-store.js'

/**
 * The owner ended a task's schedule (End schedule and close): what this cockpit keeps for the task (domain/job.ts)
 * ends with it. Its channels no longer wake it, lent tools go back, and a run that was due but had not started is
 * skipped: it would start on a closed task. A run a session already has goes on. The record itself stays for its
 * runs; it goes by the rule for every record (no schedule, no channel trigger, no open run). Safe to call again.
 */
export function endTaskRecord(
  store: Pick<JobStore<Job>, 'get' | 'put' | 'runs' | 'updateRun'>, taskId: string, now: number, onGrantEnd?: (record: Job, tools: GrantTool[]) => void,
): void {
  const record = store.get(taskId)
  if (!record) return
  const at = new Date(now).toISOString()
  const lent = activeGrants(record, now).map((grant) => grant.tool)
  if (record.triggers.length > 0 || record.grants?.length || record.pendingApproval) {
    const { pendingApproval: _waited, ...rest } = record
    store.put({ ...rest, triggers: [], grants: [], updatedAt: at })
  }
  for (const run of store.runs(taskId)) {
    if (run.status === 'waiting') store.updateRun({ ...run, status: 'skipped', note: ENDED_BEFORE_START, finishedAt: at })
  }
  if (lent.length > 0) onGrantEnd?.(store.get(taskId) ?? record, lent)
}
