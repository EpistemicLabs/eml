import type { DelegationFields, ScheduleFields } from './delegation.js'
import { activeGrants, isOpenRun, JOB_LIMITS, type ChannelTrigger, type Job, type JobGrant, type JobNotify, type JobRun, type ReplyChannel, type ReplyMode } from './job.js'
import { isScheduleTrigger, type JobV1, type ScheduleTrigger } from './job-v1.js'
import { everyParagraph, isOpenTask, nameOfTask, narrowedProfile, withParagraph } from './schedule-tool.js'
import { firesHere, firingOf, ownerOf } from './task-owner.js'
import type { ToolProfile } from './tool-profile.js'
import { addCron, cronZoneRefusal, sameSchedule, scheduleOf, scheduleText, SCHEDULE_LIMITS, setEndsAt, setPaused, setWake } from './task-schedule.js'

/**
 * The migration of jobs.json version 1 to version 2 (brain schema 24: a task holds its schedule). Before, a job had
 * its own schedule, prompt and target, and a task's delegation.schedule was a mirror of one of its jobs. Now the task
 * is the only place a schedule lives, and this cockpit keeps one local record per task (domain/job.ts).
 *
 * This plans it for one space, purely, from the version 1 jobs, their runs and the tasks as the brain has them now;
 * jobMigrationReport lists the plan for a dry run, and application/job-migration.ts writes it. Per task, its jobs
 * that have not ended give:
 *
 *   - a repeating job → its cron into the task's crons, read in the zone of the task's first repeating job; its
 *     prompt appended to the task's text as "Every <cron>: <prompt>" unless the text says it already (or the prompt
 *     was built from the task itself, as a scheduled hand-over's is);
 *   - a one-time job still ahead → the task's wake-up: at, why (its prompt) and by_session (the session it wakes).
 *     A task has one wake-up: of two, the earlier one is it, the later one's time and prompt go into the journal;
 *   - a one-time job whose time has passed and that never ran → not dropped: it is the task's wake-up with its past
 *     time, which the engine fires late; when the task gets its wake-up from another job, its prompt goes into the
 *     journal, and the report says so. One that has run has nothing to carry over;
 *   - a paused job → the pause wins: with all of the task's timed jobs paused, or one of its repeating jobs, the
 *     whole schedule is paused with every repeating time on it, and the journal says why and how to resume. A paused
 *     one-time job next to running ones is left out, with a journal line;
 *   - a repeating job in another time zone than the task's first → left out (a task's times are read in one zone),
 *     and said loudly: the journal and the report say that it no longer fires and give the schedule-tool call that
 *     puts it on a task of its own;
 *   - its per-machine settings (who hears of a run, limited and lent tools, tool profile, reply mode, max runs, mail
 *     triggers, where a new session starts) → the task's record; its runs go on under the record. Of several jobs
 *     on one task the strictest wins: the narrowest tools, the limit, the draft reply; and the loudest telling.
 *
 * The task's schedule is built from its jobs alone: what the mirror left in the delegation is replaced. Not every
 * job moves:
 *
 *   - a job that has ended: only its runs stay, as history under its id;
 *   - a job whose task is closed or gone: dropped (a closed task gets a journal line and loses a mirrored schedule);
 *   - a job on a task another member owns (a shared space; domain/task-owner.ts firingOf, the rule the engine fires
 *     by): it is not moved, and nothing is written to that task, which this cockpit does not fire: no schedule, no
 *     text, no journal line. The job leaves the version 1 data (nothing fires it any more), and the report says so
 *     loudly, with the schedule-tool call by which the task's owner brings it back;
 *   - a job on a task no member owns: moved as this member's own, with a record here, which is what makes this
 *     cockpit fire it;
 *   - a job of a space whose kind is not known yet (the brain server has not said whether it is shared), or on a task
 *     whose owner cannot be told yet: left where it is, for a later pass;
 *   - a job in another space: left for that space's pass;
 *   - a job without a task: a task is made for it first (application/task-state-migration.ts routineTask); without
 *     a project of the brain it stays as it is, to be looked at.
 *
 * A schedule the mirror left on a task that has no job at all (not even an ended one) was run by nothing before, and
 * would start to fire now that the task is the truth. In the first pass of a space such a schedule is removed, with a
 * journal line: on an open task this cockpit fires, that has no local record (a record means someone set the schedule
 * here since). The rule is the same in a local and in a shared space. A task this cockpit does not fire is never
 * touched and not named: what stands on it is its owner's cockpit's to judge.
 *
 * The plan is safe to make and write again: a job that moved is gone from the version 1 data, and a schedule, text
 * or record that is already there is not written twice.
 */

/** The brain schema from which a task holds its schedule: a space's jobs are planned against a brain at it, never an older one. */
export const SCHEDULES_ON_TASKS_SCHEMA = 24

/**
 * A stored schedule as a brain at schema 24 holds it, from either shape. Schema 23 held one `cron` and a `session`;
 * the brain's own step to 24 (packages/core v0.24_migrate.sql) makes the cron a list of one, keeps at, time_zone and
 * paused, and drops the rest; a schedule with neither a cron nor an at is none. A schedule in the new shape is
 * returned as it is. For a reader of a brain file that may still be at 23 (the dry run by hand); the host itself only
 * plans against a brain at 24.
 */
export function scheduleAtSchema24(stored: unknown): ScheduleFields | null {
  if (!stored || typeof stored !== 'object') return null
  const raw = stored as Record<string, unknown>
  if (!('cron' in raw) && !('session' in raw)) return raw as ScheduleFields
  const cron = typeof raw.cron === 'string' ? raw.cron.trim() : ''
  const at = typeof raw.at === 'string' ? raw.at : null
  if (!cron && at === null) return null
  return {
    ...(cron ? { crons: [cron] } : {}),
    ...(at !== null ? { at } : {}),
    ...(typeof raw.time_zone === 'string' && raw.time_zone.trim() ? { time_zone: raw.time_zone } : {}),
    ...(typeof raw.paused === 'boolean' ? { paused: raw.paused } : {}),
  }
}

export interface JobMigrationTask {
  id: string
  status: string
  title?: string | null
  content?: string
  /** The task's author: its owner when nobody is assigned (domain/task-owner.ts ownerOf). */
  ingested_by?: string | null
  properties?: { delegation?: DelegationFields | null; assignee_ids?: string[]; display_title?: string } | null
}

/** A task to make for a job without one (application/task-state-migration.ts routineTask). */
export interface NewRoutineTask { title: string; display_title: string; content: string; scope: string; status: 'active'; assignee_ids: string[] }

export interface JobMigrationInput {
  /** The version 1 jobs not migrated yet, of every space. */
  jobs: readonly JobV1[]
  runs: Readonly<Record<string, JobRun[]>>
  keys: Readonly<Record<string, Record<string, string>>>
  /**
   * The space planned: `key` is what its jobs carry as spaceId (null for the main space). `shared`: false for a local
   * brain, where every task is this member's; true for a shared one; null while the brain server has not said: then
   * nothing is planned, every job is left for a later pass.
   */
  space: { key: string | null; name: string; shared: boolean | null }
  /** The people of a shared space (its brain's users); null or absent: they could not be read. Not asked in a local space. */
  members?: readonly string[] | null
  /** The task of each job of the space, as the brain has it now; null: the brain has no such task. */
  tasks: Readonly<Record<string, JobMigrationTask | null>>
  /** This cockpit's member: whose cockpit fires a task is decided by domain/task-owner.ts firingOf, the engine's rule. */
  me: string
  /**
   * The space's open tasks that have a schedule, given only in the first pass of the space (while none of its jobs has
   * moved): then the plan names the schedules left without a job. Absent: none is looked for.
   */
  scheduled?: readonly JobMigrationTask[]
  /** The tasks this cockpit holds a local record for: their schedule was set here, and is no leftover. */
  records?: ReadonlySet<string>
  now: number
  /** The task a job without one gets; null when its project is none of the brain's. */
  routineTaskOf(job: JobV1): NewRoutineTask | null
}

/** What becomes of one job (TaskMigration.jobs). */
export type JobFate = 'moved' | 'lost' | 'waits' | 'history'

/** moved: onto its task. dropped: it ends here, with `why`. left: it stays in the version 1 data, with `why`. */
export type MigrationOutcome = 'moved' | 'dropped' | 'left'

export interface TaskMigration {
  /** The task; null: `create` makes it first. */
  taskId: string | null
  create: NewRoutineTask | null
  /** The task's name for the report. */
  title: string
  outcome: MigrationOutcome
  why: string | null
  /** The schedule the task has afterwards (null: none); for a task that is not written to, the one it has. */
  schedule: ScheduleFields | null
  /** What is written to the task in the brain, in one call; null: nothing. */
  brain: {
    /** `schedule` differs from what the task has: it is written. */
    setSchedule: boolean
    /** The task's text with `appended` added; null: unchanged. */
    content: string | null
    appended: string[]
    journal: string[]
  } | null
  /** The task's local record; its id and taskId are '' until the task exists (stepOf fills them in). */
  record: Job | null
  /** The runs that go on under the record. */
  runs: JobRun[]
  keys: Record<string, string>
  /** Runs kept for history under their job's id. */
  history: Record<string, JobRun[]>
  /** The version 1 jobs this settles; empty for an outcome of left. */
  settles: string[]
  /** The jobs whose sessions work for the task's record from now on (the ledger's jobId moves to the task's id). */
  renamed: string[]
  /**
   * Per job, what becomes of it. `kind`: moved (it goes on firing, on its task), lost (it does not: left out, or
   * dropped while it still had something to do), waits (it stays in the version 1 data for a later pass), history
   * (it was over already: it had ended or had run).
   */
  jobs: Array<{ id: string; name: string; what: string; kind: JobFate }>
  /** The per-machine settings that move to the record, in words. */
  settings: string[]
  /** The schedule is paused because one of the task's repeating jobs was, while others ran: the report says how to resume. */
  pausedByJob?: boolean
}

/** A schedule on an open task this cockpit fires that has no job at all and no record: the old mirror left it, and it is removed. */
export interface LeftoverSchedule {
  taskId: string
  title: string
  schedule: ScheduleFields
}

/** The journal line of a left-over schedule that is removed. */
export const leftoverNote = (schedule: ScheduleFields) =>
  `A schedule without a job was left on this task (${scheduleText(schedule)}) from before schedules moved onto tasks. Nothing ran it then, so it is removed and nothing starts to run it now. Set a new time if the task should run at one.`

export interface JobMigrationPlan {
  tasks: TaskMigration[]
  /** The schedules left without a job; absent or empty when none was looked for or found. */
  leftovers?: LeftoverSchedule[]
  /** Jobs of other spaces: left for their space's pass. */
  elsewhere: number
}

const NOTE_CHARS = 2000
const iso = (at: number) => new Date(at).toISOString()
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Who hears of a run, loudest first: of several jobs on one task the loudest wins, so no run goes untold that one of them told. */
const LOUDEST: readonly JobNotify[] = ['always', 'needs-me', 'never']

/** The note of a run that was open when its job was dropped by the migration. */
export const MIGRATED_AWAY = 'its job ended when schedules moved onto tasks'

/** The prompt a scheduled hand-over gave its job: built from the task itself (application/task-runner.ts stepPrompt), so the task's text says it already. */
const builtFromTask = (prompt: string, taskId: string) => prompt.startsWith('A scheduled job started you for "') && prompt.includes(`(task ${taskId})`)

const scheduleTriggerOf = (job: JobV1): ScheduleTrigger | undefined => job.triggers.find(isScheduleTrigger)
const channelsOf = (job: JobV1): ChannelTrigger[] => job.triggers.filter((t): t is ChannelTrigger => !isScheduleTrigger(t))
const neverRan = (job: JobV1, runs: readonly JobRun[]) => job.runCount === 0 && !runs.some((r) => r.number > 0)
const sessionOf = (job: JobV1): string | null => (job.target.type === 'worker' ? null : job.target.sessionId)

const closed = (run: JobRun, at: string): JobRun => {
  if (!isOpenRun(run)) return run
  return { ...run, status: run.status === 'started' ? 'finished' : 'skipped', note: MIGRATED_AWAY, finishedAt: at }
}

/** The runs that go on under a record: every open one, and the newest of the others up to the history limit. */
function carried(runs: JobRun[], recordId: string): JobRun[] {
  const sorted = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => ({ ...r, jobId: recordId }))
  let over = sorted.length - JOB_LIMITS.history
  return sorted.filter((r) => isOpenRun(r) || over-- <= 0)
}

function dropped(taskId: string | null, title: string, jobs: readonly JobV1[], input: JobMigrationInput, why: string, schedule: ScheduleFields | null, brain: TaskMigration['brain'], what: (job: JobV1) => string): TaskMigration {
  const at = iso(input.now)
  return {
    taskId, create: null, title, outcome: 'dropped', why, schedule, brain, record: null, runs: [], keys: {},
    history: Object.fromEntries(jobs.map((j) => [j.id, (input.runs[j.id] ?? []).map((r) => closed(r, at))])),
    settles: jobs.map((j) => j.id), renamed: [],
    jobs: jobs.map((j) => (j.endedAt ? { id: j.id, name: j.name, what: 'had ended: its runs stay as history', kind: 'history' as const } : { id: j.id, name: j.name, what: what(j), kind: 'lost' as const })),
    settings: [],
  }
}

const describe = (job: JobV1): string => {
  const t = scheduleTriggerOf(job)
  const when = !t ? 'no time' : t.cron !== undefined ? `cron "${t.cron}" (${t.timeZone})` : `once at ${t.at}`
  const channels = channelsOf(job).map((c) => c.type)
  return [when, ...(channels.length ? [`woken by ${channels.join(', ')}`] : []), ...(job.paused ? ['paused'] : [])].join(', ')
}

/**
 * An open task another member owns: its jobs are not moved, and nothing is written to the task, since this cockpit
 * does not fire it. They end here; each one that still had something to do is named loudly, with the way back.
 */
function notMine(task: JobMigrationTask, owner: string, jobs: readonly JobV1[], input: JobMigrationInput): TaskMigration {
  const name = nameOfTask(task)
  const plan = dropped(task.id, name, jobs, input, `the task is ${owner}'s: this cockpit does not fire it and writes nothing to it`, task.properties?.delegation?.schedule ?? null, null, () => '')
  const lines: TaskMigration['jobs'] = jobs.map((job) => {
    if (job.endedAt) return { id: job.id, name: job.name, what: 'had ended: its runs stay as history', kind: 'history' }
    const trigger = scheduleTriggerOf(job)
    if (trigger?.at !== undefined && Date.parse(trigger.at) <= input.now && !neverRan(job, input.runs[job.id] ?? [])) return { id: job.id, name: job.name, what: `once at ${trigger.at} → it has run: no time to carry over`, kind: 'history' }
    const prompt = cut(flat(job.prompt), NOTE_CHARS)
    const back = !trigger
      ? `To bring it back, ${owner} sets it up on the task on their own cockpit: a channel is kept per machine.`
      : `To bring it back, ${owner} sets the time on the task with the schedule tool: action "create", task_id "${task.id}", ${trigger.cron !== undefined ? `cron "${trigger.cron.trim()}"` : `at "${trigger.at}"`}, timezone "${trigger.timeZone}", prompt "${prompt}"`
    return { id: job.id, name: job.name, what: `NOT MOVED, IT NO LONGER FIRES: the task "${name}" (${task.id}) is ${owner}'s, and this cockpit writes nothing to a task it does not fire. The job (${describe(job)}) had the prompt "${prompt}" ${back}`, kind: 'lost' }
  })
  return { ...plan, jobs: lines }
}

/**
 * One open task this cockpit fires: its jobs onto it. `task` is the task as it is, or the one `create` will make.
 * `ownerless`: no member owns it, so the record kept here is what makes this cockpit fire it.
 */
function moved(task: JobMigrationTask, create: NewRoutineTask | null, jobs: readonly JobV1[], input: JobMigrationInput, ownerless = false): TaskMigration {
  const now = input.now
  const taskId = create ? '' : task.id
  const live = jobs.filter((j) => !j.endedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const ended = jobs.filter((j) => j.endedAt)
  const lines: TaskMigration['jobs'] = ended.map((j) => ({ id: j.id, name: j.name, what: 'had ended: its runs stay as history', kind: 'history' }))
  const journal: string[] = []
  const appended: string[] = []
  const say = (job: JobV1, what: string, kind: JobFate = 'moved') => lines.push({ id: job.id, name: job.name, what, kind })

  const repeating = live.filter((j) => scheduleTriggerOf(j)?.cron !== undefined)
  const once = live.filter((j) => scheduleTriggerOf(j)?.at !== undefined)
  const byTime = (a: JobV1, b: JobV1) => Date.parse(scheduleTriggerOf(a)!.at!) - Date.parse(scheduleTriggerOf(b)!.at!)
  const ahead = once.filter((j) => Date.parse(scheduleTriggerOf(j)!.at!) > now).sort(byTime)
  // A one-time job whose time has passed and that never ran still has its run to do: it is a wake-up that fires late.
  const overdueOnce = once.filter((j) => !ahead.includes(j) && neverRan(j, input.runs[j.id] ?? [])).sort(byTime)
  const timed = [...repeating, ...ahead, ...overdueOnce]
  // One Pause for the whole schedule, and the pause wins: it is paused when every timed job was, and when one of its
  // repeating jobs was (its time is never left out, and would run again unpaused). A paused one-time job among
  // running ones is left out.
  const pausedCrons = repeating.filter((j) => j.paused)
  const allPaused = timed.length > 0 && (timed.every((j) => j.paused) || pausedCrons.length > 0)
  const leftOut = (job: JobV1) => job.paused && !allPaused

  const current = task.properties?.delegation?.schedule ?? null
  let schedule: ScheduleFields | null = null
  let content = create ? create.content : task.content ?? ''
  const kept: JobV1[] = []
  for (const job of repeating) {
    const trigger = scheduleTriggerOf(job)!
    const cron = trigger.cron!.trim()
    const note = `"${job.name}" (cron "${cron}", ${trigger.timeZone}): what it did: "${cut(flat(job.prompt), NOTE_CHARS)}"`
    const zone: string = cronZoneRefusal(schedule, trigger.timeZone) ?? trigger.timeZone
    if (trigger.timeZone !== zone) {
      // Loud, with the way back: this routine stops, and nothing else will say so.
      const call = `To bring it back on a task of its own, call the schedule tool: action "create", name "${job.name}", cron "${cron}", timezone "${trigger.timeZone}", prompt "${cut(flat(job.prompt), NOTE_CHARS)}"`
      say(job, `cron "${cron}" (${trigger.timeZone}) → NOT MOVED, IT NO LONGER FIRES: the task's repeating times are read in ${zone}, and a task has one zone. ${call}`, 'lost')
      journal.push(`The routine "${job.name}" NO LONGER FIRES: it ran in another time zone (cron "${cron}", ${trigger.timeZone}) than the task's repeating times (${zone}), and a task's times are read in one zone, so it was not carried over when schedules moved onto tasks. ${call}`)
      continue
    }
    const has = schedule?.crons?.includes(cron) ?? false
    if (!has && (schedule?.crons?.length ?? 0) >= SCHEDULE_LIMITS.crons) {
      say(job, `cron "${cron}" → left out: a task holds at most ${SCHEDULE_LIMITS.crons} repeating times; noted in the journal`, 'lost')
      journal.push(`A repeating job was not carried over when schedules moved onto tasks: a task holds at most ${SCHEDULE_LIMITS.crons} repeating times. ${note}`)
      continue
    }
    try {
      schedule = addCron(schedule, cron, zone)
    } catch (err) {
      say(job, `cron "${cron}" → left out: ${(err as Error).message}; noted in the journal`, 'lost')
      journal.push(`A repeating job was not carried over when schedules moved onto tasks: ${(err as Error).message}. ${note}`)
      continue
    }
    kept.push(job)
    // The schedule tool's paragraph and its way of adding it: what either wrote, the other finds in the text.
    const paragraph = everyParagraph(cron, job.prompt)
    const said = create !== null || content.includes(paragraph) || content.includes(job.prompt.trim()) || builtFromTask(job.prompt, task.id)
    if (!said) {
      content = withParagraph(content, paragraph) ?? content
      appended.push(paragraph)
    }
    say(job, `cron "${cron}" (${zone}) → a repeating time of the task${has ? ' (it has that time already)' : ''}${job.paused && pausedCrons.includes(job) ? '; it was paused, so the task\'s whole schedule is paused' : ''}; its prompt ${said ? 'is in the task\'s text already' : 'is appended to the task\'s text'}`)
  }

  let wake: JobV1 | null = null
  for (const job of [...ahead, ...overdueOnce]) {
    const at = scheduleTriggerOf(job)!.at!
    const late = overdueOnce.includes(job)
    const quoted = `"${cut(flat(job.prompt), NOTE_CHARS)}"`
    if (leftOut(job)) {
      say(job, `once at ${at} → left out: it was paused while the task's other times run; noted in the journal`, 'lost')
      journal.push(`A paused one-time run was not carried over when schedules moved onto tasks. "${job.name}", set for ${at}: ${quoted}`)
      continue
    }
    if (wake && late) {
      say(job, `once at ${at} → not the task's wake-up: its time has passed, it never ran, and the task gets its wake-up from "${wake.name}"; its prompt is noted in the journal`, 'lost')
      journal.push(`A one-time run set for ${at} never ran, and the task has another wake-up (${schedule?.at}); what it was to do is noted here: ${quoted}`)
      continue
    }
    if (wake) {
      say(job, `once at ${at} → not the task's wake-up: "${wake.name}" comes earlier, and a task has one; its time and prompt are noted in the journal`, 'lost')
      journal.push(`A later one-time run was set too, for ${at}; a task has one wake-up, so it is noted here: ${quoted}`)
      continue
    }
    wake = job
    const bySession = sessionOf(job)
    schedule = setWake(schedule, { at, why: job.prompt, bySession, timeZone: scheduleTriggerOf(job)!.timeZone })
    kept.push(job)
    const cutNote = job.prompt.trim().length > SCHEDULE_LIMITS.whyChars ? ` (cut to ${SCHEDULE_LIMITS.whyChars} characters)` : ''
    say(job, late
      ? `once at ${at} → the task's wake-up, though its time has passed: it never ran, so it fires late, at the cockpit's next look${bySession ? `; set by session ${bySession.slice(0, 8)}` : ''}; its prompt is the reason${cutNote}`
      : `once at ${at} → the task's wake-up${bySession ? `, set by session ${bySession.slice(0, 8)}` : ''}; its prompt is the reason${cutNote}`)
  }
  for (const job of once.filter((j) => !ahead.includes(j) && !overdueOnce.includes(j))) say(job, `once at ${scheduleTriggerOf(job)!.at!} → it has run: no time to carry over`, 'history')
  for (const job of live.filter((j) => !scheduleTriggerOf(j))) say(job, `${describe(job)} → its channel wakes the task`)

  // The end: a time only when every time that moved had one (the latest of them), a number of runs only for a single job.
  const ends = kept.map((j) => (j.end?.at ? Date.parse(j.end.at) : NaN))
  const settings: string[] = []
  if (schedule && ends.length > 0 && ends.every(Number.isFinite)) schedule = setEndsAt(schedule, iso(Math.max(...ends)))
  else if (ends.some(Number.isFinite)) settings.push('an end time of one job is not carried over: the task\'s other times have none')
  if (schedule && allPaused) schedule = setPaused(schedule, true)
  // Paused because of one repeating job, with others that ran: said where the owner reads it, with the way out.
  if (schedule?.paused && pausedCrons.length > 0 && !timed.every((j) => j.paused)) {
    const which = pausedCrons.map((j) => `"${j.name}" (cron "${scheduleTriggerOf(j)!.cron!.trim()}")`).join(', ')
    journal.push(`Its schedule is paused as a whole: its repeating job${pausedCrons.length === 1 ? '' : 's'} ${which} ${pausedCrons.length === 1 ? 'was' : 'were'} paused when schedules moved onto tasks, and a task has one Pause for all its times. Nothing fires until it is resumed: Resume in the task's Schedule section, or the schedule tool's resume. To keep ${pausedCrons.length === 1 ? 'that one time' : 'those times'} off, remove ${pausedCrons.length === 1 ? 'it' : 'them'} there first.`)
  }

  const setSchedule = create !== null ? schedule !== null : !sameSchedule(current, schedule)
  // The brain takes a rewrite of a task's text only with a line that says what happened.
  if (appended.length > 0) journal.unshift(`Schedules moved onto tasks: what ${appended.length === 1 ? 'its repeating job did was' : `its ${appended.length} repeating jobs did was`} added to the task's text, as "Every <cron>: …".`)
  const brain: TaskMigration['brain'] = setSchedule || appended.length > 0 || journal.length > 0
    ? { setSchedule, content: appended.length > 0 ? content : null, appended, journal }
    : null

  // The record: what this machine keeps for the task. Of several jobs the strictest wins: the tools are the narrowest
  // of all (the schedule tool's rule, a job without a profile widens nothing), a limit and a draft reply hold if any
  // had them; runs are told as the loudest of them said. Where a new session starts comes from the oldest job.
  const primary = live[0]
  const allRuns = live.flatMap((j) => input.runs[j.id] ?? [])
  const triggers = live.flatMap(channelsOf)
  let record: Job | null = null
  if (primary && (schedule || triggers.length > 0 || allRuns.some(isOpenRun))) {
    const starts = live.find((j) => j.target.type !== 'session')?.target as Extract<JobV1['target'], { projectId: string }> | undefined
    const reply: Partial<Record<ReplyChannel, ReplyMode>> = {}
    for (const job of live) for (const [channel, mode] of Object.entries(job.reply) as Array<[ReplyChannel, ReplyMode]>) reply[channel] = reply[channel] === 'draft' ? 'draft' : mode
    const grants = new Map<string, JobGrant>()
    for (const grant of live.flatMap((j) => activeGrants(j, now))) if (!grants.has(grant.tool) || grants.get(grant.tool)!.until < grant.until) grants.set(grant.tool, grant)
    const counted = kept.length === 1 && kept[0].end?.afterRuns !== undefined ? kept[0] : null
    if (!counted && kept.some((j) => j.end?.afterRuns !== undefined)) settings.push('a number of runs to end after is not carried over: the task has more than one time')
    // A repeating time that came due before the migration (the cockpit was down) is still seen as due or missed.
    const overdue = kept.filter((j) => !allPaused && scheduleTriggerOf(j)?.cron !== undefined && j.nextRunAt && Date.parse(j.nextRunAt) <= now).map((j) => Date.parse(j.nextRunAt!))
    const started = allRuns.map((r) => r.startedAt).filter((s): s is string => Boolean(s)).sort()
    const reason = allPaused ? timed.find((j) => j.pausedReason)?.pausedReason ?? null : null
    const toolProfile = live.reduce<ToolProfile | null>((kept, j) => narrowedProfile(kept, j.toolProfile, undefined) as ToolProfile | null, null)
    const notify = LOUDEST.find((n) => live.some((j) => j.notify === n)) ?? primary.notify
    record = {
      id: taskId, spaceId: input.space.key, taskId, createdBy: primary.createdBy, createdAt: primary.createdAt, updatedAt: iso(now),
      triggers, projectId: starts?.projectId ?? null, ...(starts?.provider ? { provider: starts.provider } : {}),
      toolProfile, reply, end: counted ? { afterRuns: counted.end!.afterRuns! } : null, notify,
      pausedReason: reason,
      ...(live.some((j) => j.pendingApproval) ? { pendingApproval: true } : {}),
      ...(live.some((j) => j.limited) ? { limited: true } : {}),
      ...(grants.size > 0 ? { grants: [...grants.values()] } : {}),
      cursor: iso(overdue.length > 0 ? Math.min(...overdue) - 1 : now), firedWake: null, lastRunAt: started.at(-1) ?? null,
      runCount: counted ? counted.runCount : live.reduce((sum, j) => sum + j.runCount, 0),
      failures: Math.max(0, ...live.map((j) => j.failures)),
    }
    settings.push(`tells ${record.notify}`)
    if (record.limited) settings.push(`limited${record.grants?.length ? `, lent ${record.grants.map((g) => g.tool).join(', ')}` : ''}`)
    if (record.toolProfile) settings.push(live.length > 1 ? `its tool profile (the narrowest of its ${live.length} jobs)` : 'its tool profile')
    for (const trigger of triggers) settings.push(`wakes on ${trigger.type} (${trigger.match.length} sender${trigger.match.length === 1 ? '' : 's'})${record.pendingApproval ? ', waiting for the user\'s OK' : ''}`)
    for (const [channel, mode] of Object.entries(reply)) settings.push(`${channel} replies: ${mode}`)
    if (record.end) settings.push(`ends after ${record.end.afterRuns} runs (${record.runCount} so far)`)
    if (record.projectId) settings.push(`new sessions start in ${record.projectId}${record.provider ? ` with ${record.provider}` : ''}`)
    if (record.pausedReason) settings.push(`paused by the cockpit: ${record.pausedReason}`)
    if (ownerless) settings.push('no member owns the task: this cockpit fires it, because it keeps its record')
    if (live.length > 1) settings.push(`from its ${live.length} jobs: new sessions start where the oldest one ("${primary.name}") started them; the tools are the narrowest, a limit and draft replies hold if any had them, runs are told as the loudest of them said, lent tools and channels are those of all`)
    const open = allRuns.filter(isOpenRun).length
    if (allRuns.length > 0) settings.push(`${allRuns.length} run${allRuns.length === 1 ? '' : 's'} carried over${open ? ` (${open} open)` : ''}`)
  }
  const at = iso(now)
  return {
    taskId: create ? null : task.id, create, title: nameOfTask(task), outcome: 'moved',
    why: null, schedule, brain, record,
    runs: record ? carried(allRuns, taskId) : [],
    keys: record ? Object.assign({}, ...live.map((j) => input.keys[j.id] ?? {})) as Record<string, string> : {},
    history: Object.fromEntries([
      ...ended.map((j) => [j.id, input.runs[j.id] ?? []] as const),
      ...(record ? [] : live.map((j) => [j.id, (input.runs[j.id] ?? []).map((r) => closed(r, at))] as const)),
    ]),
    settles: jobs.map((j) => j.id), renamed: record ? live.map((j) => j.id) : [],
    jobs: lines, settings,
    ...(schedule?.paused && pausedCrons.length > 0 && !timed.every((j) => j.paused) ? { pausedByJob: true } : {}),
  }
}

export function planJobMigration(input: JobMigrationInput): JobMigrationPlan {
  const mine = input.jobs.filter((j) => (j.spaceId ?? null) === input.space.key)
  const byTask = new Map<string, JobV1[]>()
  const taskless: JobV1[] = []
  for (const job of mine) {
    if (job.taskId) byTask.set(job.taskId, [...(byTask.get(job.taskId) ?? []), job])
    else taskless.push(job)
  }
  const tasks: TaskMigration[] = []
  for (const [taskId, jobs] of byTask) {
    const task = input.tasks[taskId] ?? null
    if (!task) {
      tasks.push(dropped(taskId, taskId.slice(0, 8), jobs, input, 'its task is gone', null, null, (j) => `${describe(j)} → dropped: its task is gone`))
      continue
    }
    // The one rule, the engine's (domain/task-owner.ts firingOf): this cockpit writes only to a task it fires.
    const firing = firingOf(input.space.shared, task, input.me, input.members ?? null)
    if (firing === 'unknown') {
      const why = input.space.shared === null
        ? 'the brain server has not said yet whether this space is shared: nothing is planned until it has'
        : 'the members of this space could not be read, so it is not known whether a member owns the task: it waits'
      tasks.push({
        taskId, create: null, title: nameOfTask(task), outcome: 'left', why, schedule: task.properties?.delegation?.schedule ?? null, brain: null, record: null,
        runs: [], keys: {}, history: {}, settles: [], renamed: [], jobs: jobs.map((j) => ({ id: j.id, name: j.name, what: `${describe(j)} → waits`, kind: 'waits' as const })), settings: [],
      })
      continue
    }
    const owner = firing === 'theirs' ? ownerOf(task) : null
    if (!isOpenTask(task)) {
      if (owner) {
        tasks.push(dropped(taskId, nameOfTask(task), jobs, input, `the task is closed (${task.status}) and ${owner}'s: nothing is written`, task.properties?.delegation?.schedule ?? null, null, (j) => `${describe(j)} → dropped: the task is closed`))
        continue
      }
      const live = jobs.filter((j) => !j.endedAt)
      const leftover = task.properties?.delegation?.schedule ?? null
      const journal = live.length > 0 ? [`${live.length === 1 ? 'A job' : `${live.length} jobs`} of this task (${live.map((j) => `"${j.name}": ${describe(j)}`).join('; ')}) ended when schedules moved onto tasks: the task is closed. Reopen it and set a schedule to bring ${live.length === 1 ? 'it' : 'them'} back.`] : []
      const brain = leftover || journal.length > 0 ? { setSchedule: leftover !== null, content: null, appended: [], journal } : null
      tasks.push(dropped(taskId, nameOfTask(task), jobs, input, `the task is closed (${task.status})`, null, brain, (j) => `${describe(j)} → dropped: the task is closed`))
      continue
    }
    if (owner) {
      tasks.push(notMine(task, owner, jobs, input))
      continue
    }
    tasks.push(moved(task, null, jobs, input, firing === 'ownerless'))
  }
  for (const job of taskless) {
    if (job.endedAt) {
      tasks.push(dropped(null, job.name, [job], input, 'it had ended and has no task', null, null, () => ''))
      continue
    }
    const trigger = scheduleTriggerOf(job)
    // A one-time job that has run has nothing left to do. One that never ran still has: it gets a task like any other.
    if (trigger?.at !== undefined && Date.parse(trigger.at) <= input.now && channelsOf(job).length === 0 && !(input.runs[job.id] ?? []).some(isOpenRun) && !neverRan(job, input.runs[job.id] ?? [])) {
      tasks.push({ ...dropped(null, job.name, [job], input, 'it has run and has no task', null, null, (j) => `${describe(j)} → it has run: nothing to carry over`), jobs: [{ id: job.id, name: job.name, what: `${describe(job)} → it has run: nothing to carry over`, kind: 'history' }] })
      continue
    }
    const create = input.routineTaskOf(job)
    if (!create) {
      tasks.push({
        taskId: null, create: null, title: job.name, outcome: 'left', why: 'it has no task and no project of the brain to make one in: it stays as it is, nothing fires it', schedule: null, brain: null, record: null,
        runs: [], keys: {}, history: {}, settles: [], renamed: [], jobs: [{ id: job.id, name: job.name, what: `${describe(job)} → left as it is`, kind: 'waits' }], settings: [],
      })
      continue
    }
    tasks.push(moved({ id: '', status: 'active', title: create.title, content: create.content, properties: { display_title: create.display_title, assignee_ids: create.assignee_ids } }, create, [job], input))
  }
  // A schedule on a task no job of the version 1 data names: nothing ran it before, so it must not start to fire.
  const leftovers: LeftoverSchedule[] = []
  for (const task of input.scheduled ?? []) {
    const schedule = scheduleOf(task)
    if (!schedule || !isOpenTask(task) || byTask.has(task.id) || input.records?.has(task.id)) continue
    // Only a task this cockpit fires (the one rule, in every space; none of these has a record): never another
    // member's, nor one no member owns.
    if (!firesHere(firingOf(input.space.shared, task, input.me, input.members ?? null), false)) continue
    leftovers.push({ taskId: task.id, title: nameOfTask(task), schedule })
  }
  return { tasks, leftovers, elsewhere: input.jobs.length - mine.length }
}

/** A planned task's part as the store takes it (job-store.ts migrateV1), with the task's id filled in where it was made just now. */
export function stepOf(plan: TaskMigration, taskId: string | null): { jobIds: string[]; record: Job | null; runs: JobRun[]; keys: Record<string, string>; history: Record<string, JobRun[]>; renames: Record<string, string> } {
  const record = plan.record && taskId ? { ...plan.record, id: taskId, taskId } : null
  return {
    jobIds: plan.settles, record,
    // Every job that goes on under the record: the channel bridge may hold messages, wakes or drafts under its id,
    // also when its channel trigger was taken off before.
    renames: record ? Object.fromEntries(plan.renamed.map((jobId) => [jobId, record.id])) : {},
    runs: record ? plan.runs.map((r) => ({ ...r, jobId: record.id })) : [],
    keys: record ? plan.keys : {},
    history: plan.history,
  }
}

/** How many of the planned jobs go on firing (moved), do not (lost), wait for a later pass (waits), or were over already (history). */
export function jobFates(plan: Pick<JobMigrationPlan, 'tasks'>): Record<JobFate, number> {
  const fates: Record<JobFate, number> = { moved: 0, lost: 0, waits: 0, history: 0 }
  for (const task of plan.tasks) for (const job of task.jobs) fates[job.kind] += 1
  return fates
}

/** The plan as Markdown, per task: which times, which text, which jobs go and why, which settings move. */
export function jobMigrationReport(plan: JobMigrationPlan, opts: { space: string; at: string; dryRun: boolean }): string {
  const out: string[] = [
    `# Schedules onto tasks — ${opts.dryRun ? 'dry run' : 'run'}`, '',
    `Space: ${opts.space} · ${opts.at}${opts.dryRun ? ' · nothing written.' : ''}`, '',
  ]
  const count = (outcome: MigrationOutcome) => plan.tasks.filter((t) => t.outcome === outcome).length
  const jobs = plan.tasks.reduce((sum, t) => sum + t.jobs.length, 0)
  const fate = jobFates(plan)
  // A task counts as moved also when one of its jobs was left out: the count by job says what does not fire any more.
  const byJob = fate.lost + fate.waits > 0 ? ` Of the jobs, ${fate.moved} moved and ${fate.lost + fate.waits} did not.` : ''
  const stale = plan.leftovers?.length ?? 0
  const leftLine = stale > 0 ? ` ${stale} schedule${stale === 1 ? '' : 's'} without a job ${stale === 1 ? 'was' : 'were'} left on ${stale === 1 ? 'a task' : 'tasks'}.` : ''
  out.push(`${jobs} job${jobs === 1 ? '' : 's'} on ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}: ${count('moved')} moved, ${count('dropped')} dropped, ${count('left')} left as they are.${byJob}${leftLine}${plan.elsewhere ? ` ${plan.elsewhere} job${plan.elsewhere === 1 ? '' : 's'} of other spaces wait for their space.` : ''}`, '')
  for (const t of plan.tasks) {
    const id = t.taskId ? ` (${t.taskId.slice(0, 8)})` : t.create ? ' (a new task)' : ''
    out.push(`## ${t.title}${id} — ${t.outcome}${t.why ? `: ${t.why}` : ''}`, '')
    if (t.create) out.push(`- A task is made for it: "${t.create.display_title}" in ${t.create.scope}, with the job's prompt as its text.`)
    if (t.outcome === 'moved') {
      const s = t.schedule
      if (s) {
        out.push(`- Repeating times: ${s.crons?.length ? `${s.crons.join('; ')}${s.time_zone ? ` (${s.time_zone})` : ''}` : 'none'}`)
        out.push(`- Wake-up: ${s.at ? `${s.at}${s.by_session ? `, set by session ${s.by_session.slice(0, 8)}` : ''} — "${cut(flat(s.why ?? ''), 200)}"` : 'none'}`)
        if (s.paused) out.push(t.pausedByJob ? '- The schedule is paused: one of its repeating jobs was. Resume it on the task (its Schedule section, or the schedule tool\'s resume).' : '- The schedule is paused.')
        if (s.ends_at) out.push(`- It ends at ${s.ends_at}.`)
        out.push(t.brain?.setSchedule ? '- That schedule is written to the task.' : '- The task has that schedule already: it is not written again.')
      } else out.push(t.brain?.setSchedule ? '- No time moves onto the task; the schedule it still shows is cleared.' : '- No time moves onto the task: it has no schedule.')
    } else if (t.brain?.setSchedule) out.push('- The schedule the task still shows is cleared.')
    else if (t.schedule) out.push(`- The task's schedule stays as it is: ${scheduleText(t.schedule)}.`)
    for (const text of t.brain?.appended ?? []) out.push(`- Appended to the task's text: "${cut(flat(text), 400)}"`)
    for (const line of t.brain?.journal ?? []) out.push(`- Journal: ${cut(line, 400)}`)
    for (const job of t.jobs) if (job.what) out.push(`- Job "${job.name}" (${job.id.slice(0, 8)}): ${job.what}`)
    if (t.settings.length > 0) out.push(`- On this machine: ${t.settings.join('; ')}.`)
    out.push('')
  }
  const leftovers = plan.leftovers ?? []
  for (const left of leftovers) {
    out.push(`## ${left.title} (${left.taskId.slice(0, 8)}) — a schedule without a job`, '')
    out.push(`- A schedule without a job was left on this task (${scheduleText(left.schedule)}); removed.`)
    out.push('')
  }
  if (plan.tasks.length === 0 && leftovers.length === 0) out.push('Nothing to move.', '')
  return `${out.join('\n')}`
}
