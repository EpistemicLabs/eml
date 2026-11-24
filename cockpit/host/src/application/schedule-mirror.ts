import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { Job } from '../domain/job.js'
import type { DelegationFields, ScheduleFields } from '../domain/delegation.js'
import { sameSchedule, scheduleOfJobs } from '../domain/task-schedule.js'

/**
 * Mirrors this cockpit's jobs' timing into their tasks' delegation.schedule (domain/task-schedule.ts), so a task's
 * schedule lives in the brain: every member sees when it runs next, and the runner holds it meanwhile.
 *
 * Per task with a job here: the schedule its jobs give it (the running job due first). It is written when it differs
 * from what the task has; a task none of whose jobs has a time left loses its schedule. A task without a delegation
 * gets one for the space's agent (no checkpoint, no request: the job starts it, not the runner). Only tasks with a job on
 * this cockpit and owned by its member (or by nobody) are touched — another member's schedules are theirs. The brain is read only when a task's schedule here
 * changed since the last sync, or every RECHECK_MS.
 */

export interface ScheduleMirrorDeps {
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** This cockpit's jobs. */
  jobs(): Job[]
  /** The agent the space's sessions run as. */
  agentOf(space: BrainSpace): string | null
  /** This cockpit's member: it writes the schedule only of the tasks it owns, so a schedule has one writer. */
  me: string
  now(): number
  log(line: string): void
}

const RECHECK_MS = 10 * 60 * 1000

interface Task {
  id: string
  status: string
  properties?: { delegation?: DelegationFields; delegate?: string; checkpoint?: string; assignee_ids?: string[] }
}

export interface ScheduleMirror {
  sync(): Promise<void>
  every(ms: number): () => void
}

export function createScheduleMirror(deps: ScheduleMirrorDeps): ScheduleMirror {
  /** Per task: the schedule last found in the brain or written, and when. */
  const known = new Map<string, { schedule: ScheduleFields | null; at: number }>()
  /** Tasks this cockpit mirrored a schedule into: one whose jobs are all gone loses it. */
  const mirrored = new Set<string>()
  let running: Promise<void> | null = null

  const syncSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>, now: number) => {
    const byTask = new Map<string, Job[]>()
    for (const job of deps.jobs()) {
      if ((job.spaceId ?? null) !== (space.main ? null : space.id) || !job.taskId) continue
      byTask.set(job.taskId, [...(byTask.get(job.taskId) ?? []), job])
    }
    for (const taskId of mirrored) if (!byTask.has(taskId)) byTask.set(taskId, [])
    for (const [taskId, jobs] of byTask) {
      const wanted = scheduleOfJobs(jobs)
      const seen = known.get(taskId)
      if (seen && sameSchedule(seen.schedule, wanted) && now - seen.at < RECHECK_MS) continue
      try {
        const task = await brain.get(`/engram/${encodeURIComponent(taskId)}`) as Task
        if (task.status !== 'planned' && task.status !== 'active') { known.set(taskId, { schedule: wanted, at: now }); mirrored.delete(taskId); continue }
        // One writer per schedule: the owner's cockpit (the first person in assignee_ids). Another member's job on the
        // task runs on that member's cockpit but leaves the shared schedule to the owner's.
        const owner = task.properties?.assignee_ids?.[0]
        if (owner && owner !== deps.me) {
          if (!seen) deps.log(`[schedule] task ${taskId.slice(0, 8)} is ${owner}'s: its schedule is theirs to write, not this cockpit's`)
          known.set(taskId, { schedule: wanted, at: now })
          continue
        }
        const d = task.properties?.delegation ?? (task.properties?.delegate ? { agent: task.properties.delegate, ...(task.properties.checkpoint ? { checkpoint: task.properties.checkpoint } : {}) } : undefined)
        const current = d?.schedule ?? null
        if (!sameSchedule(current, wanted)) {
          if (wanted) {
            const agent = d?.agent ?? deps.agentOf(space)
            if (!agent) { deps.log(`[schedule] task ${taskId.slice(0, 8)}: no agent to hold its schedule`); continue }
            const { schedule: _old, ...rest } = d ?? { agent }
            await brain.post(`/task/${taskId}/track`, { delegation: { ...rest, agent, schedule: wanted }, text: 'Its schedule, as the job on the owner\'s cockpit runs it.' })
          } else if (d) {
            const { schedule: _old, ...rest } = d
            await brain.post(`/task/${taskId}/track`, { delegation: rest, text: 'No job runs it at a time any more: its schedule is cleared.' })
          }
        }
        known.set(taskId, { schedule: wanted, at: now })
        if (wanted) mirrored.add(taskId)
        else mirrored.delete(taskId)
      } catch (err) {
        // Looked at again after RECHECK_MS, not every sync: a job whose task is gone would log every minute.
        known.set(taskId, { schedule: wanted, at: now })
        deps.log(`[schedule] task ${taskId.slice(0, 8)}: ${(err as Error).message}`)
      }
    }
  }

  const syncOnce = async () => {
    const now = deps.now()
    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      if (brain) await syncSpace(space, brain, now)
    }
  }

  const mirror: ScheduleMirror = {
    async sync() {
      while (running) await running
      running = syncOnce().finally(() => { running = null })
      return running
    },
    every(ms) {
      const timer = setInterval(() => { void mirror.sync() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
  return mirror
}
