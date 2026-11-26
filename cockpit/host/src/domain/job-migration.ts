import type { DelegationFields, ScheduleFields } from './delegation.js'
import { activeGrants, isOpenRun, JOB_LIMITS, type ChannelTrigger, type Job, type JobGrant, type JobRun, type ReplyChannel, type ReplyMode } from './job.js'
import { isScheduleTrigger, type JobV1, type ScheduleTrigger } from './job-v1.js'
import { firingOf, ownerOf } from './task-owner.js'
import { addCron, cronZoneRefusal, sameSchedule, scheduleText, SCHEDULE_LIMITS, setEndsAt, setPaused, setWake } from './task-schedule.js'

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
 *   - a one-time job whose time has passed and that never ran → dropped, with a journal line;
 *   - a paused job → with all of the task's timed jobs paused, the schedule is paused; a paused job next to running
 *     ones is left out, with a journal line (the one Pause is for the whole schedule, and it would run again);
 *   - its per-machine settings (who hears of a run, limited and lent tools, tool profile, reply mode, max runs, mail
 *     triggers, where a new session starts) → the task's record; its runs go on under the record.
 *
 * The task's schedule is built from its jobs alone: what the mirror left in the delegation is replaced. Not every
 * job moves:
 *
 *   - a job that has ended: only its runs stay, as history under its id;
 *   - a job whose task is closed or gone: dropped (a closed task gets a journal line and loses a mirrored schedule);
 *   - a job on a task another member owns (a shared space; domain/task-owner.ts firingOf, the rule the engine fires
 *     by): it is never dropped. Its times join the schedule the task has (which is its owner's: never replaced,
 *     paused or ended from here), its prompt joins the task's text, and the owner's cockpit fires it from then on.
 *     No record stays here; the journal and the report say so, and which per-machine settings did not move;
 *   - a job on a task no member owns: moved as this member's own, with a record here, which is what makes this
 *     cockpit fire it;
 *   - a job of a space whose kind is not known yet (the brain server has not said whether it is shared), or on a task
 *     whose owner cannot be told yet: left where it is, for a later pass;
 *   - a job in another space: left for that space's pass;
 *   - a job without a task: a task is made for it first (application/task-state-migration.ts routineTask); without
 *     a project of the brain it stays as it is, to be looked at.
 *
 * The plan is safe to make and write again: a job that moved is gone from the version 1 data, and a schedule, text
 * or record that is already there is not written twice.
 */

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
  now: number
  /** The task a job without one gets; null when its project is none of the brain's. */
  routineTaskOf(job: JobV1): NewRoutineTask | null
}

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
  /** Per job, what becomes of it. */
  jobs: Array<{ id: string; name: string; what: string }>
  /** The per-machine settings that move to the record, in words. */
  settings: string[]
}

export interface JobMigrationPlan {
  tasks: TaskMigration[]
  /** Jobs of other spaces: left for their space's pass. */
  elsewhere: number
}

const OPEN = new Set(['planned', 'active'])
const NOTE_CHARS = 2000
const iso = (at: number) => new Date(at).toISOString()
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
const nameOf = (task: JobMigrationTask) => task.properties?.display_title ?? task.title ?? task.id

/** The note of a run that was open when its job was dropped by the migration. */
export const MIGRATED_AWAY = 'its job ended when schedules moved onto tasks'

/** A cron job's paragraph in the task's text. */
export const cronParagraph = (cron: string, prompt: string) => `Every ${cron}: ${prompt.trim()}`

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
    jobs: jobs.map((j) => ({ id: j.id, name: j.name, what: j.endedAt ? 'had ended: its runs stay as history' : what(j) })),
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
 * One open task: its jobs onto it. `task` is the task as it is, or the one `create` will make. `handed`: the member
 * who owns the task when that is not this one — the times join the schedule the task has, nothing of it is replaced,
 * paused or ended, and no record is kept here: the owner's cockpit fires it. `ownerless`: no member owns it, so the
 * record kept here is what makes this cockpit fire it.
 */
function moved(task: JobMigrationTask, create: NewRoutineTask | null, jobs: readonly JobV1[], input: JobMigrationInput, handed: string | null = null, ownerless = false): TaskMigration {
  const now = input.now
  const taskId = create ? '' : task.id
  const live = jobs.filter((j) => !j.endedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const ended = jobs.filter((j) => j.endedAt)
  const lines: TaskMigration['jobs'] = ended.map((j) => ({ id: j.id, name: j.name, what: 'had ended: its runs stay as history' }))
  const journal: string[] = []
  const appended: string[] = []
  const say = (job: JobV1, what: string) => lines.push({ id: job.id, name: job.name, what })

  const repeating = live.filter((j) => scheduleTriggerOf(j)?.cron !== undefined)
  const once = live.filter((j) => scheduleTriggerOf(j)?.at !== undefined)
  const ahead = once.filter((j) => Date.parse(scheduleTriggerOf(j)!.at!) > now).sort((a, b) => Date.parse(scheduleTriggerOf(a)!.at!) - Date.parse(scheduleTriggerOf(b)!.at!))
  const timed = [...repeating, ...ahead]
  // One Pause for the whole schedule: it is paused when every timed job was; a paused job among running ones is left out.
  const allPaused = !handed && timed.length > 0 && timed.every((j) => j.paused)
  const leftOut = (job: JobV1) => job.paused && !allPaused

  const current = task.properties?.delegation?.schedule ?? null
  // Another member's task keeps the schedule it has: this cockpit's times join it.
  let schedule: ScheduleFields | null = handed ? current : null
  let content = create ? create.content : task.content ?? ''
  const kept: JobV1[] = []
  for (const job of repeating) {
    const trigger = scheduleTriggerOf(job)!
    const cron = trigger.cron!.trim()
    const note = `"${job.name}" (cron "${cron}", ${trigger.timeZone}): what it did: "${cut(flat(job.prompt), NOTE_CHARS)}"`
    if (leftOut(job)) {
      say(job, `cron "${cron}" (${trigger.timeZone}) → left out: it was paused while the task's other times run; noted in the journal`)
      journal.push(`A paused repeating job was not carried over when schedules moved onto tasks, since a task's schedule is paused as a whole. ${note}`)
      continue
    }
    const zone: string = cronZoneRefusal(schedule, trigger.timeZone) ?? trigger.timeZone
    if (trigger.timeZone !== zone) {
      say(job, `cron "${cron}" (${trigger.timeZone}) → left out: the task's repeating times are read in ${zone}; noted in the journal`)
      journal.push(`A repeating job in another time zone was not carried over when schedules moved onto tasks: the task's times are read in ${zone}. ${note}`)
      continue
    }
    const has = schedule?.crons?.includes(cron) ?? false
    if (!has && (schedule?.crons?.length ?? 0) >= SCHEDULE_LIMITS.crons) {
      say(job, `cron "${cron}" → left out: a task holds at most ${SCHEDULE_LIMITS.crons} repeating times; noted in the journal`)
      journal.push(`A repeating job was not carried over when schedules moved onto tasks: a task holds at most ${SCHEDULE_LIMITS.crons} repeating times. ${note}`)
      continue
    }
    try {
      schedule = addCron(schedule, cron, zone)
    } catch (err) {
      say(job, `cron "${cron}" → left out: ${(err as Error).message}; noted in the journal`)
      journal.push(`A repeating job was not carried over when schedules moved onto tasks: ${(err as Error).message}. ${note}`)
      continue
    }
    kept.push(job)
    const paragraph = cronParagraph(cron, job.prompt)
    const said = create !== null || content.includes(paragraph) || content.includes(job.prompt.trim()) || builtFromTask(job.prompt, task.id)
    if (!said) {
      content = content.trim() ? `${content.replace(/\s+$/, '')}\n\n${paragraph}` : paragraph
      appended.push(paragraph)
    }
    say(job, `cron "${cron}" (${zone}) → a repeating time of the task${has ? ' (it has that time already)' : ''}; its prompt ${said ? 'is in the task\'s text already' : 'is appended to the task\'s text'}`)
  }

  let wake: JobV1 | null = null
  for (const job of ahead) {
    const at = scheduleTriggerOf(job)!.at!
    if (leftOut(job)) {
      say(job, `once at ${at} → left out: it was paused while the task's other times run; noted in the journal`)
      journal.push(`A paused one-time run was not carried over when schedules moved onto tasks. "${job.name}", set for ${at}: "${cut(flat(job.prompt), NOTE_CHARS)}"`)
      continue
    }
    if (wake) {
      say(job, `once at ${at} → not the task's wake-up: "${wake.name}" comes earlier, and a task has one; its time and prompt are noted in the journal`)
      journal.push(`A later one-time run was set too, for ${at}; a task has one wake-up, so it is noted here: "${cut(flat(job.prompt), NOTE_CHARS)}"`)
      continue
    }
    if (handed && schedule?.at) {
      say(job, `once at ${at} → not the task's wake-up: the task has one already (${schedule.at}), and it is its owner's; its time and prompt are noted in the journal`)
      journal.push(`A one-time run was set too, for ${at}; the task already has a wake-up, and a task has one, so it is noted here: "${cut(flat(job.prompt), NOTE_CHARS)}"`)
      continue
    }
    wake = job
    const bySession = sessionOf(job)
    schedule = setWake(schedule, { at, why: job.prompt, bySession, timeZone: scheduleTriggerOf(job)!.timeZone })
    kept.push(job)
    say(job, `once at ${at} → the task's wake-up${bySession ? `, set by session ${bySession.slice(0, 8)}` : ''}; its prompt is the reason${job.prompt.trim().length > SCHEDULE_LIMITS.whyChars ? ` (cut to ${SCHEDULE_LIMITS.whyChars} characters)` : ''}`)
  }
  for (const job of once.filter((j) => !ahead.includes(j))) {
    const at = scheduleTriggerOf(job)!.at!
    if (neverRan(job, input.runs[job.id] ?? [])) {
      say(job, `once at ${at} → dropped: its time has passed and it never ran; noted in the journal`)
      journal.push(`The one-time run "${job.name}" set for ${at} never ran; it was dropped when schedules moved onto tasks.`)
    } else {
      say(job, `once at ${at} → it has run: no time to carry over`)
    }
  }
  for (const job of live.filter((j) => !scheduleTriggerOf(j))) say(job, `${describe(job)} → its channel wakes the task`)

  // The end: a time only when every time that moved had one (the latest of them), a number of runs only for a single job.
  const ends = kept.map((j) => (j.end?.at ? Date.parse(j.end.at) : NaN))
  const settings: string[] = []
  if (handed) {
    // The schedule's end and its pause are its owner's.
  } else if (schedule && ends.length > 0 && ends.every(Number.isFinite)) schedule = setEndsAt(schedule, iso(Math.max(...ends)))
  else if (ends.some(Number.isFinite)) settings.push('an end time of one job is not carried over: the task\'s other times have none')
  if (schedule && allPaused) schedule = setPaused(schedule, true)

  const setSchedule = create !== null ? schedule !== null : !sameSchedule(current, schedule)
  // The brain takes a rewrite of a task's text only with a line that says what happened.
  if (appended.length > 0) journal.unshift(`Schedules moved onto tasks: what ${appended.length === 1 ? 'its repeating job did was' : `its ${appended.length} repeating jobs did was`} added to the task's text, as "Every <cron>: …".`)
  if (handed && kept.length > 0) {
    // What this machine kept for the jobs stays behind: the owner's cockpit has its own record of the task.
    const notMoved = [
      ...(live.some((j) => j.limited) ? ['the limit on its sessions'] : []),
      ...(live.some((j) => j.toolProfile) ? ['its tool profile'] : []),
      ...[...new Set(live.flatMap(channelsOf).map((c) => c.type))].map((type) => `its ${type} trigger`),
      ...kept.filter((j) => j.end?.afterRuns !== undefined).map((j) => `an end after ${j.end!.afterRuns} runs`),
      ...(kept.some((j) => j.end?.at) ? ['an end time'] : []),
      ...[...new Set(live.map((j) => j.notify).filter((n) => n !== 'needs-me'))].map((n) => `who hears of a run (${n})`),
    ]
    journal.push(
      `Schedules moved onto tasks: a job on ${input.me}'s cockpit ran this task at its times. They are on the task now, and the cockpit of the task's owner (${handed}) fires them from here on.`
      + (schedule?.paused ? ' The task\'s schedule is paused: the times that joined it fire once its owner resumes it.' : '')
      + (notMoved.length > 0 ? ` What ${input.me}'s cockpit kept for the job did not move: ${notMoved.join(', ')}. Set them on ${handed}'s cockpit if they are wanted.` : ''),
    )
    settings.push(`nothing is kept on this machine: ${handed}'s cockpit fires the task`)
    if (notMoved.length > 0) settings.push(`did not move: ${notMoved.join(', ')}`)
  }
  const brain: TaskMigration['brain'] = setSchedule || appended.length > 0 || journal.length > 0
    ? { setSchedule, content: appended.length > 0 ? content : null, appended, journal }
    : null

  // The record: what this machine keeps for the task, from its oldest job; the stricter of two wins where it can.
  const primary = live[0]
  const allRuns = live.flatMap((j) => input.runs[j.id] ?? [])
  const triggers = live.flatMap(channelsOf)
  let record: Job | null = null
  if (primary && !handed && (schedule || triggers.length > 0 || allRuns.some(isOpenRun))) {
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
    record = {
      id: taskId, spaceId: input.space.key, taskId, createdBy: primary.createdBy, createdAt: primary.createdAt, updatedAt: iso(now),
      triggers, projectId: starts?.projectId ?? null, ...(starts?.provider ? { provider: starts.provider } : {}),
      toolProfile: primary.toolProfile, reply, end: counted ? { afterRuns: counted.end!.afterRuns! } : null, notify: primary.notify,
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
    if (record.toolProfile) settings.push('its tool profile')
    for (const trigger of triggers) settings.push(`wakes on ${trigger.type} (${trigger.match.length} sender${trigger.match.length === 1 ? '' : 's'})${record.pendingApproval ? ', waiting for the user\'s OK' : ''}`)
    for (const [channel, mode] of Object.entries(reply)) settings.push(`${channel} replies: ${mode}`)
    if (record.end) settings.push(`ends after ${record.end.afterRuns} runs (${record.runCount} so far)`)
    if (record.projectId) settings.push(`new sessions start in ${record.projectId}${record.provider ? ` with ${record.provider}` : ''}`)
    if (record.pausedReason) settings.push(`paused by the cockpit: ${record.pausedReason}`)
    if (ownerless) settings.push('no member owns the task: this cockpit fires it, because it keeps its record')
    if (live.length > 1) settings.push(`taken from its oldest job "${primary.name}"; limited, lent tools, reply mode and channels from all ${live.length}`)
    const open = allRuns.filter(isOpenRun).length
    if (allRuns.length > 0) settings.push(`${allRuns.length} run${allRuns.length === 1 ? '' : 's'} carried over${open ? ` (${open} open)` : ''}`)
  }
  const at = iso(now)
  return {
    taskId: create ? null : task.id, create, title: nameOf(task), outcome: 'moved',
    why: handed ? `the task is ${handed}'s: its schedule fires on their cockpit from now on` : null, schedule, brain, record,
    runs: record ? carried(allRuns, taskId) : [],
    keys: record ? Object.assign({}, ...live.map((j) => input.keys[j.id] ?? {})) as Record<string, string> : {},
    history: Object.fromEntries([
      ...ended.map((j) => [j.id, input.runs[j.id] ?? []] as const),
      ...(record ? [] : live.map((j) => [j.id, (input.runs[j.id] ?? []).map((r) => closed(r, at))] as const)),
    ]),
    settles: jobs.map((j) => j.id), renamed: record ? live.map((j) => j.id) : [],
    jobs: lines, settings,
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
    // The one rule, the engine's (domain/task-owner.ts firingOf): what is written here is what the owner's cockpit fires.
    const firing = firingOf(input.space.shared, task, input.me, input.members ?? null)
    if (firing === 'unknown') {
      const why = input.space.shared === null
        ? 'the brain server has not said yet whether this space is shared: nothing is planned until it has'
        : 'the members of this space could not be read, so it is not known whether a member owns the task: it waits'
      tasks.push({
        taskId, create: null, title: nameOf(task), outcome: 'left', why, schedule: task.properties?.delegation?.schedule ?? null, brain: null, record: null,
        runs: [], keys: {}, history: {}, settles: [], renamed: [], jobs: jobs.map((j) => ({ id: j.id, name: j.name, what: `${describe(j)} → waits` })), settings: [],
      })
      continue
    }
    const owner = firing === 'theirs' ? ownerOf(task) : null
    if (!OPEN.has(task.status)) {
      if (owner) {
        tasks.push(dropped(taskId, nameOf(task), jobs, input, `the task is closed (${task.status}) and ${owner}'s: nothing is written`, task.properties?.delegation?.schedule ?? null, null, (j) => `${describe(j)} → dropped: the task is closed`))
        continue
      }
      const live = jobs.filter((j) => !j.endedAt)
      const leftover = task.properties?.delegation?.schedule ?? null
      const journal = live.length > 0 ? [`${live.length === 1 ? 'A job' : `${live.length} jobs`} of this task (${live.map((j) => `"${j.name}": ${describe(j)}`).join('; ')}) ended when schedules moved onto tasks: the task is closed. Reopen it and set a schedule to bring ${live.length === 1 ? 'it' : 'them'} back.`] : []
      const brain = leftover || journal.length > 0 ? { setSchedule: leftover !== null, content: null, appended: [], journal } : null
      tasks.push(dropped(taskId, nameOf(task), jobs, input, `the task is closed (${task.status})`, null, brain, (j) => `${describe(j)} → dropped: the task is closed`))
      continue
    }
    if (owner) {
      tasks.push(moved(task, null, jobs, input, owner))
      continue
    }
    tasks.push(moved(task, null, jobs, input, null, firing === 'ownerless'))
  }
  for (const job of taskless) {
    if (job.endedAt) {
      tasks.push(dropped(null, job.name, [job], input, 'it had ended and has no task', null, null, () => ''))
      continue
    }
    const trigger = scheduleTriggerOf(job)
    if (trigger?.at !== undefined && Date.parse(trigger.at) <= input.now && channelsOf(job).length === 0 && !(input.runs[job.id] ?? []).some(isOpenRun)) {
      const ran = !neverRan(job, input.runs[job.id] ?? [])
      tasks.push(dropped(null, job.name, [job], input, ran ? 'it has run and has no task' : 'its time has passed, it never ran and has no task', null, null, (j) => `${describe(j)} → dropped`))
      continue
    }
    const create = input.routineTaskOf(job)
    if (!create) {
      tasks.push({
        taskId: null, create: null, title: job.name, outcome: 'left', why: 'it has no task and no project of the brain to make one in: it stays as it is, nothing fires it', schedule: null, brain: null, record: null,
        runs: [], keys: {}, history: {}, settles: [], renamed: [], jobs: [{ id: job.id, name: job.name, what: `${describe(job)} → left as it is` }], settings: [],
      })
      continue
    }
    tasks.push(moved({ id: '', status: 'active', title: create.title, content: create.content, properties: { display_title: create.display_title, assignee_ids: create.assignee_ids } }, create, [job], input))
  }
  return { tasks, elsewhere: input.jobs.length - mine.length }
}

/** A planned task's part as the store takes it (job-store.ts migrateV1), with the task's id filled in where it was made just now. */
export function stepOf(plan: TaskMigration, taskId: string | null): { jobIds: string[]; record: Job | null; runs: JobRun[]; keys: Record<string, string>; history: Record<string, JobRun[]> } {
  const record = plan.record && taskId ? { ...plan.record, id: taskId, taskId } : null
  return {
    jobIds: plan.settles, record,
    runs: record ? plan.runs.map((r) => ({ ...r, jobId: record.id })) : [],
    keys: record ? plan.keys : {},
    history: plan.history,
  }
}

/** The plan as Markdown, per task: which times, which text, which jobs go and why, which settings move. */
export function jobMigrationReport(plan: JobMigrationPlan, opts: { space: string; at: string; dryRun: boolean }): string {
  const out: string[] = [
    `# Schedules onto tasks — ${opts.dryRun ? 'dry run' : 'run'}`, '',
    `Space: ${opts.space} · ${opts.at}${opts.dryRun ? ' · nothing written.' : ''}`, '',
  ]
  const count = (outcome: MigrationOutcome) => plan.tasks.filter((t) => t.outcome === outcome).length
  const jobs = plan.tasks.reduce((sum, t) => sum + t.jobs.length, 0)
  out.push(`${jobs} job${jobs === 1 ? '' : 's'} on ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}: ${count('moved')} moved, ${count('dropped')} dropped, ${count('left')} left as they are.${plan.elsewhere ? ` ${plan.elsewhere} job${plan.elsewhere === 1 ? '' : 's'} of other spaces wait for their space.` : ''}`, '')
  for (const t of plan.tasks) {
    const id = t.taskId ? ` (${t.taskId.slice(0, 8)})` : t.create ? ' (a new task)' : ''
    out.push(`## ${t.title}${id} — ${t.outcome}${t.why ? `: ${t.why}` : ''}`, '')
    if (t.create) out.push(`- A task is made for it: "${t.create.display_title}" in ${t.create.scope}, with the job's prompt as its text.`)
    if (t.outcome === 'moved') {
      const s = t.schedule
      if (s) {
        out.push(`- Repeating times: ${s.crons?.length ? `${s.crons.join('; ')}${s.time_zone ? ` (${s.time_zone})` : ''}` : 'none'}`)
        out.push(`- Wake-up: ${s.at ? `${s.at}${s.by_session ? `, set by session ${s.by_session.slice(0, 8)}` : ''} — "${cut(flat(s.why ?? ''), 200)}"` : 'none'}`)
        if (s.paused) out.push('- The schedule is paused.')
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
  if (plan.tasks.length === 0) out.push('Nothing to move.', '')
  return `${out.join('\n')}`
}
