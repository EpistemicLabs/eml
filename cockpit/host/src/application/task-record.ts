import { activeGrants, isOpenRun, newRecord, type GrantTool, type Job, type JobRun, type ReplyChannel, type ReplyMode } from '../domain/job.js'
import type { WorkerStatus } from '../domain/session-attention.js'
import type { JobStore } from '../job-store.js'

/**
 * The user's per-machine settings of a scheduled task, on the task's record here (domain/job.ts): their OK for new
 * channel addresses, send or draft per channel, the Limited switch, and tools lent for a while. Only the page reaches
 * them (tasks-api.ts), never a session's tool: a session never approves its own senders, widens its replies or lifts
 * its own limit.
 *
 * A record is this cockpit's alone, so nothing here is written to the brain. Limiting a task that has no record yet
 * makes one; every other setting needs the record (a channel, a limit) it is about.
 */

export type RecordRefusal = 'unknown_space' | 'unknown_task' | 'task_closed' | 'no_brain' | 'no_record' | 'invalid'

export type RecordAnswer =
  | { ok: true; text: string; record: Job | null }
  | { ok: false; refusal: RecordRefusal; message: string }

/** A run as the page shows it: with its session as it stands now. */
export type RunView = JobRun & { session: { projectId: string | null; chat: boolean; attention: WorkerStatus | null } | null }

export interface TaskRecordView {
  /** The record, or null: this cockpit keeps nothing for the task. */
  record: Job | null
  /** Its newest runs first, at most 20; missed and skipped times are among them (number 0). */
  runs: RunView[]
  /** It holds still for the channel bridge: waiting for the user's OK, paused after failures, or the schedule is paused. */
  held: boolean
  /** A run of it waits to start or has a session. */
  running: boolean
}

export interface TaskRecordsDeps {
  store: JobStore
  now(): number
  /** What the space's records carry as spaceId (null: the main space); undefined when there is no such space. */
  spaceKey(spaceId: string): string | null | undefined
  /** The task's status in that space's brain; null when the brain has no such task. Throws when it cannot be asked. */
  taskStatus(spaceId: string, taskId: string): Promise<string | null>
  /** The record holds still for the bridge (application/job-runner.ts held). */
  held?(record: Job): boolean
  /** A run's session as it stands now; null when unknown. */
  sessionInfo?(sessionId: string): RunView['session']
  /** A grant was stored: the task's newest run session picks the tool up (application/lend-job-tool.ts). */
  onGrant?(record: Job, tool: GrantTool): void
  /** The user took a lent tool back, or limited no more: the host takes it from the sessions (application/take-back-job-tools.ts). */
  onGrantEnd?(record: Job, tools: GrantTool[]): void
}

export const GRANT_MINUTES = { min: 5, max: 24 * 60, default: 60 } as const
const RUNS_SHOWN = 20

export function createTaskRecords(deps: TaskRecordsDeps) {
  const refuse = (refusal: RecordRefusal, message: string): RecordAnswer => ({ ok: false, refusal, message })

  /** The task's record in that space, or why there is none to change. */
  const find = (spaceId: string, taskId: string): Job | Extract<RecordAnswer, { ok: false }> => {
    const key = deps.spaceKey(spaceId)
    if (key === undefined) return { ok: false, refusal: 'unknown_space', message: 'No such space.' }
    const record = deps.store.get(taskId)
    // Another space's record is answered like none at all.
    if (!record || (record.spaceId ?? null) !== key) return { ok: false, refusal: 'no_record', message: 'This cockpit keeps no schedule settings for the task yet.' }
    return record
  }

  const put = (record: Job, text: string): RecordAnswer => {
    const next = { ...record, updatedAt: new Date(deps.now()).toISOString() }
    deps.store.put(next)
    return { ok: true, text, record: next }
  }

  return {
    /** What this cockpit keeps for the task and its last runs. */
    view(spaceId: string, taskId: string): TaskRecordView | Extract<RecordAnswer, { ok: false }> {
      const found = find(spaceId, taskId)
      if ('ok' in found) return found.refusal === 'no_record' ? { record: null, runs: [], held: false, running: false } : found
      const runs = deps.store.runs(found.id)
      return {
        record: found,
        runs: [...runs].reverse().slice(0, RUNS_SHOWN).map((run) => ({ ...run, session: run.sessionId ? deps.sessionInfo?.(run.sessionId) ?? null : null })),
        held: deps.held?.(found) ?? false,
        running: runs.some(isOpenRun),
      }
    },

    /** The user's OK: the record's channel addresses may wake the task. */
    approve(spaceId: string, taskId: string): RecordAnswer {
      const record = find(spaceId, taskId)
      if ('ok' in record) return record
      if (!record.pendingApproval) return { ok: true, text: 'It needs no OK.', record }
      const { pendingApproval: _waited, ...rest } = record
      return put(rest, 'Approved: its channel wakes the task from now.')
    },

    /** Send freely or draft for review, per channel. */
    setReply(spaceId: string, taskId: string, channel: ReplyChannel, mode: ReplyMode): RecordAnswer {
      const record = find(spaceId, taskId)
      if ('ok' in record) return record
      if (!record.triggers.some((t) => t.type === channel)) return refuse('invalid', `The task does not listen on ${channel}.`)
      return put({ ...record, reply: { ...record.reply, [channel]: mode } }, `It ${mode === 'send' ? 'sends' : 'drafts'} ${channel} replies.`)
    },

    /** Limited or free. Limiting a task without a record makes its record; the task has to be open. */
    async setLimited(spaceId: string, taskId: string, limited: boolean): Promise<RecordAnswer> {
      let record = find(spaceId, taskId)
      if ('ok' in record) {
        if (record.refusal !== 'no_record') return record
        if (!limited) return { ok: true, text: 'It is not limited.', record: null }
        // A record under this id in another space is another space's task: never written over.
        if (deps.store.get(taskId)) return refuse('unknown_task', 'No such task in this space.')
        let status: string | null
        try {
          status = await deps.taskStatus(spaceId, taskId)
        } catch (err) {
          return refuse('no_brain', `The task could not be read (${(err as Error).message}); try again.`)
        }
        if (status === null) return refuse('unknown_task', 'No such task in this space.')
        if (status !== 'planned' && status !== 'active') return refuse('task_closed', 'The task is closed.')
        record = newRecord({ id: taskId, spaceId: deps.spaceKey(spaceId) ?? null }, new Date(deps.now()).toISOString())
      }
      // Free again: what was lent for the limit goes back with it.
      const lent = limited ? [] : activeGrants(record, deps.now()).map((g) => g.tool)
      const answer = put({ ...record, limited, ...(limited ? {} : { grants: [] }) }, `Its sessions are ${limited ? 'limited' : 'no longer limited'}.`)
      if (lent.length > 0 && answer.ok && answer.record) deps.onGrantEnd?.(answer.record, lent)
      return answer
    },

    /** Lend a tool for `minutes`. */
    grant(spaceId: string, taskId: string, tool: GrantTool, minutes: number, reason: string | null): RecordAnswer {
      const record = find(spaceId, taskId)
      if ('ok' in record) return record
      if (!Number.isFinite(minutes) || minutes < GRANT_MINUTES.min || minutes > GRANT_MINUTES.max) return refuse('invalid', `minutes is from ${GRANT_MINUTES.min} to ${GRANT_MINUTES.max}`)
      const now = deps.now()
      const until = new Date(now + minutes * 60_000).toISOString()
      const answer = put({ ...record, grants: [...activeGrants(record, now).filter((g) => g.tool !== tool), { tool, until, reason }] }, `Its sessions may use ${tool} until ${until}.`)
      if (answer.ok && answer.record) deps.onGrant?.(answer.record, tool)
      return answer
    },

    /** Take a lent tool back. */
    revoke(spaceId: string, taskId: string, tool: GrantTool): RecordAnswer {
      const record = find(spaceId, taskId)
      if ('ok' in record) return record
      const had = activeGrants(record, deps.now()).some((g) => g.tool === tool)
      const answer = put({ ...record, grants: (record.grants ?? []).filter((g) => g.tool !== tool) }, `Its sessions no longer have ${tool}.`)
      if (had && answer.ok && answer.record) deps.onGrantEnd?.(answer.record, [tool])
      return answer
    },
  }
}

export type TaskRecords = ReturnType<typeof createTaskRecords>
