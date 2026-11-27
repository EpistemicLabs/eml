import { randomUUID } from 'node:crypto'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { ProviderId } from '../domain/agent-provider.js'
import type { ScheduleFields } from '../domain/delegation.js'
import { JOB_LIMITS, mailKeys, newRecord, type ChannelTrigger, type Job, type JobNotify, type JobRun, type GrantTool, type RunNowRefusal } from '../domain/job.js'
import { isTimeZone, parseAt, unknownTimeZone } from '../domain/schedule.js'
import {
  APPROVAL_NOTE, describeTask, everyParagraph, findTask, ID_PREFIX, isJobAction, isOpenTask, JOB_ACTIONS, limitRefusal, mailParagraph, mailTrigger,
  nameOfTask, narrowedProfile, readAt, scheduledCount, withParagraph, type ToolTask,
} from '../domain/schedule-tool.js'
import {
  addCron, cronRefusal, cronZoneRefusal, hasSchedule, isReminder, wakeOwnerText, nextRunOfSchedule, sameSchedule, ScheduleError, SCHEDULE_LIMITS, scheduleOf, scheduleText, setCrons, setEndsAt, setPaused, setWake,
} from '../domain/task-schedule.js'
import type { ToolProfile } from '../domain/tool-profile.js'
import type { JobStore } from '../job-store.js'
import { endTaskRecord } from './end-task-record.js'
import { limitedJobRefusal, sessionScope } from './limited-job-scope.js'
import { openTasks, taskById } from './task-read.js'
import { editTaskSchedule, ScheduleWriteError, writeTaskSchedule } from './task-schedule-write.js'
import { makeRoutineTask, routineTask } from './task-state-migration.js'

/**
 * The schedule tool: what a session does with the schedules of its space's tasks (the chat's tool, its CLI, the
 * spawn inbox and POST /api/jobs all end here). A schedule lives on a task (domain/task-schedule.ts): repeating
 * times and at most one wake-up. So every action names a task:
 *
 *   create   adds a repeating time (cron) to the task, or sets its wake-up (at, which replaces the one it had).
 *            The task is task_id, else the caller's own for target self, else a new task made from name and prompt.
 *   update   replaces the repeating times with one cron, or the wake-up; sets the end, the goal, the settings.
 *            timezone says how a call's own times are read; only a cron that sets all of a task's repeating times
 *            brings the zone they are read in.
 *   pause, resume   the task's whole schedule.
 *   delete, finish  end the schedule: it is cleared on the task, which stays open.
 *   run_now  one run now, through the engine (application/job-runner.ts).
 *   list     the space's open tasks that have a schedule or listen on a channel.
 *
 * What a time is for is said in the task's text: a cron's prompt becomes its own paragraph there, a wake-up's prompt
 * is its reason. What only this machine needs (who hears of a run, an end after so many runs, the mail channel, the
 * tools of the task's sessions, where a new session starts) goes on the task's record (domain/job.ts), written after
 * the schedule so the record is never left without what keeps it.
 *
 * A session reaches only the tasks of its own space and never widens what a task's sessions may use. A limited
 * task's session reaches only its own task (limited-job-scope.ts). Answers are text the agent reads.
 */

export { JOB_ACTIONS, type JobAction } from '../domain/schedule-tool.js'

export interface JobCaller {
  /** Null: the user, from the page. */
  sessionId: string | null
  spaceId: string | null
  /** The caller's project: a new task is made there unless the call names another. */
  projectId: string | null
  toolProfile: ToolProfile | null
  /**
   * The ledger's jobId: what started the caller's session, if a run did: a record, or a version 1 job that still waits.
   * Its record is read by limited-job-scope.ts recordOfSession.
   */
  jobId?: string | null
  /** Its task is limited, or its record is gone (checked again here): the caller reaches only it (limited-job-scope.ts). */
  limited?: boolean
  /** The brain task the caller works on: target self means this task. */
  taskId?: string | null
}

/** What the tool asks of the engine that fires the schedules (application/job-runner.ts). */
export interface ScheduleEngine {
  /** One run of the task now; a word when it cannot start. */
  runNow(spaceId: string | null, task: ToolTask): Promise<JobRun | RunNowRefusal>
  /** The task's schedule was paused or resumed: the engine knows before its next read. */
  paused(taskId: string): void
  resumed(taskId: string): void
}

export interface JobsDeps {
  store: JobStore
  now?: () => number
  /** This cockpit's member: a task the tool makes is theirs. */
  me: string
  /** The brain of the space; null: none to ask. */
  brain(spaceId: string | null): Pick<EmlApi, 'get' | 'post'> | null
  /** The space's agent: it holds the schedule of a task that is not delegated yet. */
  agent(spaceId: string | null): string | null
  engine: ScheduleEngine
  /** The task still has jobs of before brain schema 24 that are moving onto it: its schedule is not written until they have. */
  moving?(taskId: string): boolean
  /** A project of the space as a session names it (registry id, brain project id or name, known folder). */
  resolveProject(spaceId: string | null, input: string): Promise<string | null>
  /** A project's name as the user sees it; the id when unknown. */
  projectName?(spaceId: string | null, projectId: string): string
  providerKnown(id: string): id is ProviderId
  /** A shared space (or one the host could not ask about): its tasks get no channel, so no mail reaches its brain's other members. */
  sharedSpace?(spaceId: string | null): boolean
  /** The zone times read in when neither the call nor the task names one: the user's. */
  defaultTimeZone(): string
  /** Lent tools went back with the schedule's end: the host takes them from the session. */
  onGrantEnd?(record: Job, tools: GrantTool[]): void
  /** A task's schedule changed: whatever shows it is built again. */
  changed?(spaceId: string | null): void
}

export interface JobAnswer {
  status: number
  text: string
  /** The task the action was about. */
  taskId?: string
  /** Its schedule after the action; null: none. */
  schedule?: ScheduleFields | null
  /** Its record after the action, when this cockpit keeps one. */
  record?: Job
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const bad = (text: string): JobAnswer => ({ status: 400, text })
const iso = (at: number) => new Date(at).toISOString()

const SHARED_NO_CHANNEL = 'a task in a shared space cannot watch mail for now; schedules work there, mail only in a local space'
const ONE_TIME = 'give exactly one of cron (repeating) or at (one time)'
const TARGET_SESSION = 'a schedule belongs to a task, not to a session: name the task instead (task_id); target self means the task this session works on'
const NO_BRAIN: JobAnswer = { status: 503, text: 'this space has no brain to hold a schedule right now; try again' }
/** What update may not change: said by the brain's task tools, or by a new create. */
const NOT_UPDATED = ['name', 'task_id', 'target', 'session'] as const

/** A refusal on the way through an action: caught at the top and answered. */
class Refusal extends Error {
  constructor(readonly answer: JobAnswer) { super(answer.text) }
}
const refuse = (text: string, status = 400): never => { throw new Refusal({ status, text }) }

export class Jobs {
  private readonly now: () => number

  constructor(private deps: JobsDeps) {
    this.now = deps.now ?? Date.now
  }

  async handle(caller: JobCaller, input: Record<string, unknown>): Promise<JobAnswer> {
    try {
      return await this.act(caller, input)
    } catch (err) {
      if (err instanceof Refusal) return err.answer
      if (err instanceof ScheduleError || err instanceof ScheduleWriteError) return bad(err.message)
      return { status: 502, text: `the task's schedule could not be read or written (${(err as Error).message}); try again` }
    }
  }

  private async act(caller: JobCaller, input: Record<string, unknown>): Promise<JobAnswer> {
    const action = input.action
    if (!isJobAction(action)) return bad(`action must be one of ${JOB_ACTIONS.join(', ')}`)
    const brain = this.deps.brain(caller.spaceId)
    if (!brain) return NO_BRAIN
    const tasks = await openTasks<ToolTask>(brain)
    // Its own task, looked up as a task: the record of a task with only a wake-up comes and goes, the task stays. A
    // limited record stays while its task is open (domain/job.ts recordKeeping): an open task without a record (or a
    // waiting version 1 job) was not limited. A task that is closed or gone fails closed: its session reaches nothing.
    const scope = caller.limited ? sessionScope(caller, this.deps.store) : null
    const own = scope?.ownTaskId ? tasks.find((task) => task.id === scope.ownTaskId) : undefined
    const kept = scope?.limits
    if (caller.limited && (kept ? kept.limited === true : !own)) {
      // The same lookup the action uses, so a key reaches its own task or nothing.
      const refusal = own
        ? limitedJobRefusal(input, (key) => { const found = findTask(tasks, key, (task) => this.listed(task)); return 'id' in found && found.id === own.id })
        : 'this session\'s task is closed or gone'
      if (refusal) return { status: 403, text: refusal }
      if (action === 'list') return { status: 200, text: `- ${this.describe(own!)}` }
    }
    if (action === 'create') return this.create(caller, brain, tasks, input)
    if (action === 'list') return this.list(tasks)
    const task = await this.taskOf(brain, tasks, input.job)
    if (this.deps.moving?.(task.id)) refuse(`"${nameOfTask(task)}" still has jobs from before that are moving onto it; try again in a minute`, 503)
    switch (action) {
      case 'update': return this.update(caller, brain, tasks, task, input)
      case 'pause': return this.setPaused(caller, brain, task, true)
      case 'resume': return this.setPaused(caller, brain, task, false)
      case 'run_now': return this.runNow(caller, task)
      default: return this.end(caller, brain, task)
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** The tool lists it: it has a schedule, or this cockpit's record of it listens on a channel. */
  private listed(task: ToolTask): boolean {
    return hasSchedule(task) || (this.deps.store.get(task.id)?.triggers.length ?? 0) > 0
  }

  /** The task a key names: its id (or the first 8 characters) or its exact display title. Refuses when none or several fit. */
  private async taskOf(brain: Pick<EmlApi, 'get'>, tasks: ToolTask[], input: unknown, what = 'job'): Promise<ToolTask> {
    const key = str(input)
    if (!key) return refuse(`${what} is required: the task's id (or its first ${ID_PREFIX} characters) or its exact name`)
    const found = findTask(tasks, key, (task) => this.listed(task))
    if ('id' in found) return found
    if ('many' in found) return refuse(`"${key}" fits ${found.many} tasks; use the id`)
    // Not among the open tasks: a closed one is named by its whole id, so the answer can say it is closed.
    const closed = /^[\w-]{16,}$/.test(key) ? await taskById<ToolTask>(brain, key) : null
    if (closed) return closed
    return refuse(`No task "${key}" in this space. The list action shows the ones with a schedule.`, 404)
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  private async create(caller: JobCaller, brain: Pick<EmlApi, 'get' | 'post'>, tasks: ToolTask[], input: Record<string, unknown>): Promise<JobAnswer> {
    const prompt = str(input.prompt)
    if (!prompt || prompt.length > SCHEDULE_LIMITS.whyChars) return bad(`prompt is required (at most ${SCHEDULE_LIMITS.whyChars} characters): what the run should do. It becomes part of the task's text, or the wake-up's reason`)
    const target = str(input.target) ?? (input.session !== undefined ? 'session' : 'worker')
    if (target === 'session') return bad(TARGET_SESSION)
    if (target !== 'worker' && target !== 'self') return bad('target must be worker or self')
    if (target === 'self' && !caller.sessionId) return bad('target self needs a session')

    const mail = mailTrigger(input.mail)
    if (typeof mail === 'string') return bad(mail)
    if (mail && this.deps.sharedSpace?.(caller.spaceId)) return bad(SHARED_NO_CHANNEL)
    const [wantsCron, wantsAt] = [input.cron !== undefined, input.at !== undefined]
    // A mail channel needs no time; with one the task is woken by both.
    if (wantsCron && wantsAt || (!mail && !wantsCron && !wantsAt)) return bad(ONE_TIME)
    const settings = await this.settings(caller, input)
    const goal = this.goal(input)

    const named = str(input.task_id) ?? (target === 'self' ? caller.taskId ?? undefined : undefined)
    let task = named ? await this.taskOf(brain, tasks, named, 'task_id') : null
    if (task && !isOpenTask(task)) return bad(`"${nameOfTask(task)}" is closed, and nothing fires on a closed task: reopen it or name another`)
    if (task && this.deps.moving?.(task.id)) return { status: 503, text: `"${nameOfTask(task)}" still has jobs from before that are moving onto it; try again in a minute` }
    const name = str(input.name)
    if (!task) {
      if (!name || name.length > JOB_LIMITS.nameChars) return bad(`name is required for a new task (at most ${JOB_LIMITS.nameChars} characters); to put the time on a task that exists, pass task_id`)
      if (tasks.some((t) => this.listed(t) && nameOfTask(t).toLowerCase() === name.toLowerCase())) return bad(`a task named "${name}" already has a schedule; pass its task_id to add a time to it, or pick another name`)
    }

    const current = task ? scheduleOf(task) : null
    const zone = this.zone(input)
    const cron = wantsCron ? this.cron(input, current, zone) : null
    const at = wantsAt ? this.at(input, zone) : null
    const endsAt = this.endsAt(input, zone)
    if ((cron || at) && !current) {
      const full = limitRefusal(scheduledCount(tasks), JOB_LIMITS.perSpace)
      if (full) return bad(full)
    }
    // A wake-up continues the session that set it when that session works on the task; any other one starts anew.
    const bySession = task && caller.sessionId && caller.taskId === task.id ? caller.sessionId : null
    const by = at ? this.by(caller, input) : null
    const edit = (schedule: ScheduleFields | null): ScheduleFields | null => {
      const timed = cron ? addCron(schedule, cron, zone) : at ? setWake(schedule, { at, why: prompt, by, bySession: isReminder(by, { me: this.deps.me, owners: task?.properties?.assignee_ids }) ? null : bySession, timeZone: zone }) : schedule
      return endsAt !== undefined && timed ? setEndsAt(timed, endsAt) : timed
    }
    const planned = edit(current)
    if ((cron || at) && planned && !planned.paused && nextRunOfSchedule(planned, this.now()) === null) return bad('that schedule has no run before its end')
    if (endsAt && !planned) return bad('ends_at needs a time to end: give cron or at')

    const made = !task
    if (!task) {
      if (!this.deps.agent(caller.spaceId)) return bad('this space has no agent to run a new task\'s schedule')
      const draft = routineTask({ id: randomUUID(), name: name!, prompt }, settings.projectId ?? caller.projectId, this.deps.me)
      if (!draft) return bad('a new task needs a project of the brain: pass project, or put the time on a task that exists (task_id)')
      task = (await taskById<ToolTask>(brain, (await makeRoutineTask(brain, draft)).id)) ?? refuse('the new task could not be read back; try again', 502)
    }
    // What the time is for goes into the task's text: a new task has the prompt as its text already.
    const paragraph = made ? null : cron ? everyParagraph(cron, prompt) : !at ? mailParagraph(prompt) : null
    const content = paragraph ? withParagraph(task.content, paragraph, prompt) : null
    const setGoal = goal && !task.properties?.goal ? goal : null
    // A repeating time the task already has is not added twice: then only its text may still be new.
    const same = sameSchedule(planned, current)
    const what = same ? null : cron ? `added the repeating time "${cron}"` : at ? `set the wake-up for ${at}${by ? ` (${wakeOwnerText(by, { me: this.deps.me, owners: task.properties?.assignee_ids })})` : ''}` : null
    const said = [what ? `The schedule tool ${what}.` : null, content ? 'The schedule tool added what a time is for to the task\'s text.' : null].filter(Boolean).join(' ')
    const written = await editTaskSchedule(brain, task.id, edit, {
      ...(said ? { text: said } : {}),
      fields: { ...(content ? { content } : {}), ...(setGoal ? { goal: setGoal } : {}) },
    })
    const after = taskWithSchedule({ ...task, ...(content ? { content } : {}), properties: { ...task.properties, ...(setGoal ? { goal: setGoal } : {}) } }, written.schedule)
    // The schedule is on the task: now what this cockpit keeps for it.
    const { record, waits } = this.keep(caller, after, settings, mail ?? undefined, true)
    this.deps.changed?.(caller.spaceId)
    const notes = [
      ...(cron && same && !made ? ['The task already has that repeating time.'] : []),
      ...(goal && !setGoal ? [`The task keeps its goal ("${task.properties?.goal}").`] : []),
      ...(waits ? [APPROVAL_NOTE] : []),
    ]
    const opening = made ? `Made task "${nameOfTask(after)}" (${after.id.slice(0, ID_PREFIX)}) with its schedule.` : `Scheduled "${nameOfTask(after)}" (${after.id.slice(0, ID_PREFIX)}).`
    return { status: 201, taskId: after.id, schedule: written.schedule, record, text: [opening, this.describe(after), ...notes].join('\n') }
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  private async update(caller: JobCaller, brain: Pick<EmlApi, 'get' | 'post'>, tasks: ToolTask[], task: ToolTask, input: Record<string, unknown>): Promise<JobAnswer> {
    if (!isOpenTask(task)) return bad(`"${nameOfTask(task)}" is closed, and nothing fires on a closed task`)
    const fixed = NOT_UPDATED.filter((key) => input[key] !== undefined)
    if (fixed.length) return bad(`update cannot change ${fixed.join(', ')}: a task is renamed with the brain's task tools, and a time for another task is a new create`)
    const [wantsCron, wantsAt] = [input.cron !== undefined, input.at !== undefined]
    const prompt = str(input.prompt)
    if (prompt !== undefined && prompt.length > SCHEDULE_LIMITS.whyChars) return bad(`prompt: at most ${SCHEDULE_LIMITS.whyChars} characters`)
    if (prompt !== undefined && !wantsCron && !wantsAt) return bad('prompt goes with cron or at: it says what that time is for. The task\'s own text you change with the brain\'s task tools')
    const read = input.mail === undefined ? undefined : mailTrigger(input.mail)
    if (typeof read === 'string') return bad(read)
    // undefined: the call says nothing of mail; null: it takes the channel off.
    const mail = read
    if (mail && this.deps.sharedSpace?.(caller.spaceId)) return bad(SHARED_NO_CHANNEL)
    const settings = await this.settings(caller, input)
    const goal = this.goal(input)

    const current = scheduleOf(task)
    // The call's zone says how its own times are read. It becomes the zone of the task's repeating times only with a
    // cron, which replaces them all: a wake-up or an end read in another zone never moves when the routine runs.
    const zone = this.zone(input)
    const cron = wantsCron ? this.cron(input, null, zone) : null
    const at = wantsAt ? this.at(input, zone) : null
    const endsAt = this.endsAt(input, zone)
    if ((cron || at) && !current) {
      const full = limitRefusal(scheduledCount(tasks), JOB_LIMITS.perSpace)
      if (full) return bad(full)
    }
    const bySession = caller.sessionId && caller.taskId === task.id ? caller.sessionId : null
    const by = at ? this.by(caller, input, current?.by) : null
    const edit = (schedule: ScheduleFields | null): ScheduleFields | null => {
      let next = schedule
      // The one cron replaces the list, so the zone it is written in is the zone the task's repeating times are read in.
      if (cron) next = setCrons(next, [cron], zone)
      // Only a task without a schedule takes the wake-up's zone (setWake never gives one to repeating times).
      if (at) next = setWake(next, { at, why: prompt ?? next?.why ?? null, by, bySession: isReminder(by, { me: this.deps.me, owners: task?.properties?.assignee_ids }) ? null : bySession, ...(next ? {} : { timeZone: zone }) })
      if (endsAt !== undefined) next = next ? setEndsAt(next, endsAt) : next
      return next
    }
    const planned = edit(current)
    if (endsAt && !planned) return bad('the task has no schedule to end at a time: give cron or at')
    if ((cron || at) && planned && !planned.paused && nextRunOfSchedule(planned, this.now()) === null) return bad('that schedule has no run before its end')
    const changesTask = cron !== null || at !== null || endsAt !== undefined || goal !== null
    const changesRecord = mail !== undefined || Object.values(settings.given).some(Boolean)
    if (!changesTask && !changesRecord) return bad('nothing to update: give cron, at, ends_at, goal, max_runs, notify, mail, deny_tools, project or provider')

    const paragraph = cron && prompt ? everyParagraph(cron, prompt) : null
    const content = paragraph ? withParagraph(task.content, paragraph, prompt) : null
    const setGoal = goal && !task.properties?.goal ? goal : null
    let schedule = current
    if (changesTask) {
      const what = [cron ? `set the repeating time "${cron}" (it replaces the ones before)` : null, at ? `set the wake-up for ${at}${by ? ` (${wakeOwnerText(by, { me: this.deps.me, owners: task.properties?.assignee_ids })})` : ''}` : null].filter(Boolean).join(' and ')
      const said = [what ? `The schedule tool ${what}.` : null, content ? 'The schedule tool added what a time is for to the task\'s text.' : null].filter(Boolean).join(' ')
      const written = await editTaskSchedule(brain, task.id, edit, {
        ...(said ? { text: said } : {}),
        fields: { ...(content ? { content } : {}), ...(setGoal ? { goal: setGoal } : {}) },
      })
      schedule = written.schedule
    }
    const after = taskWithSchedule({ ...task, ...(content ? { content } : {}), properties: { ...task.properties, ...(setGoal ? { goal: setGoal } : {}) } }, schedule)
    const { record, waits } = this.keep(caller, after, settings, mail, changesRecord || cron !== null || at !== null, cron !== null)
    this.deps.changed?.(caller.spaceId)
    const notes = [...(goal && !setGoal ? [`The task keeps its goal ("${task.properties?.goal}").`] : []), ...(waits ? [APPROVAL_NOTE] : [])]
    return { status: 200, taskId: task.id, schedule, ...(record ? { record } : {}), text: [`Updated the schedule of "${nameOfTask(task)}".`, this.describe(after), ...notes].join('\n') }
  }

  // ── The other actions ──────────────────────────────────────────────────────

  private list(tasks: ToolTask[]): JobAnswer {
    const listed = tasks.filter((task) => this.listed(task)).sort((a, b) => nameOfTask(a).localeCompare(nameOfTask(b)))
    if (listed.length === 0) return { status: 200, text: 'No task in this space has a schedule.' }
    return { status: 200, text: listed.map((task) => `- ${this.describe(task)}`).join('\n') }
  }

  private async setPaused(caller: JobCaller, brain: Pick<EmlApi, 'get' | 'post'>, task: ToolTask, paused: boolean): Promise<JobAnswer> {
    const name = nameOfTask(task)
    if (!isOpenTask(task)) return bad(`"${name}" is closed, and nothing fires on a closed task`)
    // A task without a schedule can still be held: the cockpit paused its channel after failures.
    const heldAfterFailures = (this.deps.store.get(task.id)?.pausedReason ?? null) !== null
    if (!hasSchedule(task) && !(heldAfterFailures && !paused)) return bad(`"${name}" has no schedule to ${paused ? 'pause' : 'resume'}`)
    const written = await editTaskSchedule(brain, task.id, (schedule) => setPaused(schedule, paused), {
      text: paused ? 'Its schedule was paused with the schedule tool.' : 'Its schedule was resumed with the schedule tool: it goes on from now.',
    })
    // Resumed, it goes on from now: what fell due during the pause is not made up. A channel still waits for the user's OK.
    if (paused) this.deps.engine.paused(task.id)
    else this.deps.engine.resumed(task.id)
    this.deps.changed?.(caller.spaceId)
    const after = taskWithSchedule(task, written.schedule)
    return { status: 200, taskId: task.id, schedule: written.schedule, text: `${paused ? 'Paused' : 'Resumed'} the schedule of "${name}".\n${this.describe(after)}` }
  }

  /**
   * delete and finish: the task's schedule ends. It is cleared on the task, its channels no longer wake it, lent
   * tools go back and a run that was due but had not started is skipped; a run a session already has goes on. The
   * task stays open: its owner closes it. Ending what has ended is safe.
   */
  private async end(caller: JobCaller, brain: Pick<EmlApi, 'get' | 'post'>, task: ToolTask): Promise<JobAnswer> {
    const name = nameOfTask(task)
    const had = scheduleOf(task)
    if (!had && !this.listed(task)) return { status: 200, taskId: task.id, schedule: null, text: `"${name}" has no schedule: nothing to end.` }
    if (!isOpenTask(task)) {
      // A closed task is not written to: what this cockpit kept for it ends, and nothing fires on it anyway.
      endTaskRecord(this.deps.store, task.id, this.now(), this.deps.onGrantEnd)
      return { status: 200, taskId: task.id, schedule: had, text: `"${name}" is closed: nothing fires on a closed task.` }
    }
    if (had) await writeTaskSchedule(brain, task.id, null, { text: `Its schedule (${scheduleText(had)}) was ended with the schedule tool: nothing wakes it any more. The task stays open.` })
    endTaskRecord(this.deps.store, task.id, this.now(), this.deps.onGrantEnd)
    this.deps.changed?.(caller.spaceId)
    return { status: 200, taskId: task.id, schedule: null, text: `Ended the schedule of "${name}": nothing wakes it any more. The task stays open; a new time (update with cron or at) brings its schedule back.` }
  }

  private async runNow(caller: JobCaller, task: ToolTask): Promise<JobAnswer> {
    const name = nameOfTask(task)
    if (!isOpenTask(task)) return bad(`"${name}" is closed, and nothing fires on a closed task`)
    if (!this.listed(task)) return bad(`"${name}" has no schedule to run`)
    const run = await this.deps.engine.runNow(caller.spaceId, task)
    if (run === 'needs_approval') return bad(`"${name}" waits for the user's OK on the task first`)
    if (run === 'run_open') return { status: 409, text: `"${name}" has a run still going; wait for it to finish.` }
    if (run === 'task_working') return { status: 409, text: `A session of "${name}" is working right now: nothing is started beside it.` }
    if (run === 'no_project') return { status: 409, text: `"${name}" has no project to run in, so no session can start for it: move the task into a project first.` }
    return { status: 202, taskId: task.id, text: `Run ${run.number} of "${name}" starts as soon as there is room.` }
  }

  // ── The parts of a call ────────────────────────────────────────────────────

  /**
   * Who a wake-up the call sets is for (schedule.by): the agent by default, so the cockpit runs it on the task then;
   * the user's handle (or "user") makes it a reminder, a do-ask in their Inbox at that time. `kept`: the one the
   * task's wake-up has, which an update without by keeps.
   */
  private by(caller: JobCaller, input: Record<string, unknown>, kept?: string): string | null {
    const agent = this.deps.agent(caller.spaceId)
    const given = str(input.by)
    if (!given) return kept ?? agent ?? (caller.sessionId ? null : this.deps.me)
    const h = given.replace(/^@/, '').toLowerCase()
    if (h === this.deps.me.toLowerCase() || h === 'user' || h === 'owner') return this.deps.me
    if (['self', 'me', 'agent', 'myself'].includes(h) || (agent && h === agent.toLowerCase())) return agent
    return refuse(`by is who the wake-up is for: leave it out (or "self") for yourself, the agent, or name the user (${this.deps.me}) for a reminder in their Inbox`)
  }

  /** The zone the call's times read in: its own, else the user's (a session writes every time in it). */
  private zone(input: Record<string, unknown>): string {
    const zone = str(input.timezone) ?? this.deps.defaultTimeZone()
    return isTimeZone(zone) ? zone : refuse(unknownTimeZone(zone))
  }

  /**
   * The call's cron, checked. `current`: the schedule it joins. A task's repeating times are read in one zone, so a
   * cron written in another is refused instead of joining it silently at other hours.
   */
  private cron(input: Record<string, unknown>, current: ScheduleFields | null, zone: string): string {
    const cron = str(input.cron) ?? refuse('cron: five fields (minute hour day-of-month month day-of-week)')
    const joined = cronZoneRefusal(current, zone)
    if (joined) refuse(`the task's repeating times are read in ${joined}, and this cron was written in ${zone}: write it in ${joined} and pass timezone "${joined}"`)
    const refusal = cronRefusal(cron, zone, this.now(), JOB_LIMITS.minGapMs)
    return refusal ? refuse(refusal) : cron
  }

  private at(input: Record<string, unknown>, zone: string): string {
    const read = readAt(str(input.at) ?? '', zone, this.now(), JOB_LIMITS.maxAheadMs)
    return 'error' in read ? refuse(read.error) : read.at
  }

  /** The schedule's end from the call: an instant, null to take it off, undefined when the call says nothing. */
  private endsAt(input: Record<string, unknown>, zone: string): string | null | undefined {
    if (input.ends_at === undefined) return undefined
    const text = str(input.ends_at)
    if (!text) return null
    const at = parseAt(text, zone)
    return at === null ? refuse(`ends_at: "${text}" is not a date and time`) : iso(at)
  }

  private goal(input: Record<string, unknown>): string | null {
    const goal = str(input.goal)
    if (goal && goal.length > JOB_LIMITS.goalChars) refuse(`goal: at most ${JOB_LIMITS.goalChars} characters`)
    return goal ?? null
  }

  /** What of a call goes on the task's record; `given` says which of them the call names. */
  private async settings(caller: JobCaller, input: Record<string, unknown>) {
    const notify = input.notify === undefined || input.notify === null ? undefined : input.notify
    if (notify !== undefined && notify !== 'needs-me' && notify !== 'always' && notify !== 'never') refuse('notify must be needs-me, always or never')
    let maxRuns: number | null | undefined
    if (input.max_runs !== undefined) {
      if (input.max_runs !== null && (!Number.isInteger(input.max_runs) || (input.max_runs as number) < 1)) refuse('max_runs is a whole number from 1')
      maxRuns = input.max_runs as number | null
    }
    if (narrowedProfile(null, null, input.deny_tools) === 'invalid') refuse('deny_tools is a list of tool names')
    const projectInput = str(input.project)
    const projectId = projectInput ? await this.deps.resolveProject(caller.spaceId, projectInput) ?? refuse(`unknown project "${projectInput}"`) : null
    const named = str(input.provider)
    const provider = named === undefined ? undefined : this.deps.providerKnown(named) ? named : refuse(`unknown provider "${named}"`)
    return {
      notify: notify as JobNotify | undefined, maxRuns, deny: input.deny_tools, projectId, provider,
      given: { notify: notify !== undefined, maxRuns: maxRuns !== undefined, deny: input.deny_tools !== undefined && input.deny_tools !== null, project: projectId !== null, provider: provider !== undefined },
    }
  }

  /**
   * Bring the task's record in line with the call. Called after the schedule is on the task: a record with nothing
   * that keeps it (a schedule, a channel, a limit) goes at the engine's next read. `make`: the task gets a record
   * when it has none; without it only one that exists is changed. `cronsReplaced`: the call replaced the task's
   * repeating times, so an end after so many runs that was set for the old ones is off unless the call sets a new one.
   */
  private keep(caller: JobCaller, task: ToolTask, settings: Awaited<ReturnType<Jobs['settings']>>, mail: ChannelTrigger | null | undefined, make: boolean, cronsReplaced = false): { record?: Job; waits: boolean } {
    const before = this.deps.store.get(task.id)
    if (!before && !make) return { waits: false }
    const at = iso(this.now())
    const base = before ?? newRecord({ id: task.id, spaceId: caller.spaceId }, at, caller.sessionId)
    // A session never widens what the task's sessions may use: the record keeps the narrowest of what it had, what the caller has, and what the call denies.
    const toolProfile = narrowedProfile(before ? before.toolProfile : undefined, caller.toolProfile, settings.deny) as ToolProfile | null
    // A task without a project of its own starts its sessions where its maker works.
    const ownProject = task.scope?.startsWith('project.') === true
    let next: Job = {
      ...base, toolProfile,
      projectId: settings.projectId ?? base.projectId ?? (ownProject ? null : caller.projectId),
      ...(settings.provider ? { provider: settings.provider } : {}),
      ...(settings.notify ? { notify: settings.notify } : {}),
      // An end after so many runs counts from now: the runs the task had before are not part of it.
      ...(settings.maxRuns !== undefined ? { end: settings.maxRuns === null ? null : { afterRuns: base.runCount + settings.maxRuns } } : cronsReplaced ? { end: null } : {}),
    }
    let waits = false
    if (mail !== undefined) {
      next = { ...next, triggers: [...next.triggers.filter((t) => t.type !== 'mail'), ...(mail ? [mail] : [])] }
      // Drafts until the user switches the channel to send on the task; a session never can.
      if (mail) next.reply = { ...next.reply, mail: next.reply.mail ?? 'draft' }
      // Fewer addresses need nobody's OK; a new one does.
      const had = mailKeys(base)
      if ([...mailKeys(next)].some((key) => !had.has(key))) {
        next.pendingApproval = true
        waits = true
      }
    }
    if (before && JSON.stringify(before) === JSON.stringify(next)) return { record: before, waits }
    next = { ...next, updatedAt: at }
    this.deps.store.put(next)
    return { record: next, waits }
  }

  /** One task's schedule in a few lines (domain/schedule-tool.ts describeTask). */
  private describe(task: ToolTask): string {
    const record = this.deps.store.get(task.id)
    const spaceId = record?.spaceId ?? null
    const project = record?.projectId ? this.deps.projectName?.(spaceId, record.projectId) ?? record.projectId : null
    return describeTask(task, record, this.deps.store.runs(task.id), this.now(), this.deps.defaultTimeZone(), project)
  }
}

/** The task with this schedule, for describing it after a write. */
function taskWithSchedule(task: ToolTask, schedule: ScheduleFields | null): ToolTask {
  return { ...task, properties: { ...task.properties, schedule } }
}
