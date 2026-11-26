import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/job-store.js'
import { JobRunner, runProjectOf, type JobRunnerDeps, type RunnerSpace, type RunnerTask, type RunSessionState } from '../src/application/job-runner.js'
import { newRecord, type Job, type JobRun } from '../src/domain/job.js'
import type { ScheduleFields } from '../src/domain/delegation.js'
import { withSchedule } from '../src/domain/task-schedule.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'
import type { WorkerStatus } from '../src/domain/session-attention.js'
import { SCHEDULE_TASK_RULE } from '../src/domain/run-text.js'

// The engine fires the tasks' schedules: it reads the open tasks of each space, works out what is due against the
// task's local record, and carries a firing out by the four-line order. It starts only with room, retries a busy
// session, never fires a time twice, and records what came of each run.

const MIN = 60_000
const HOUR = 60 * MIN
const ZONE = 'Asia/Makassar'
const WEEKDAYS_8: ScheduleFields = { crons: ['0 8 * * 1-5'], time_zone: ZONE }
const HOURLY: ScheduleFields = { crons: ['0 * * * *'], time_zone: 'UTC' }

const MAIN: RunnerSpace = { key: null, name: 'Main', shared: false }
const TEAM: RunnerSpace = { key: 'team', name: 'Team', shared: true }

type WorldTask = RunnerTask & { space: string | null }

class World {
  now = Date.parse('2026-11-09T00:00:00Z') // Monday 08:00 in Asia/Makassar
  room = true
  me = 'lasse'
  spaces: RunnerSpace[] = [MAIN]
  /** Every task of every space, open or closed, by id; `space` says where it lives. */
  tasks = new Map<string, WorldTask>()
  /** Spaces whose brain cannot be asked. */
  unreadable = new Set<string | null>()
  /** Tasks whose version 1 jobs have not moved onto them yet. */
  unmoved = new Set<string>()
  /** Spaces whose first look for schedules left without a job is still to come (the jobs migration). */
  unchecked = new Set<string | null>()
  /** At most this many tasks come back from a list. */
  listLimit = Infinity
  listReads = 0
  taskReads: string[] = []
  /** `linked`: the session was started for the task's record (the ledger's jobId), so it has the bridge's tools. */
  sessions: Array<{ taskId: string; sessionId: string; working: boolean; linked: boolean }> = []
  elsewhere = new Set<string>()
  /** The people of a shared space; null: they cannot be read. */
  members: string[] | null = ['lasse', 'dominik']
  /** What the brain server says of a space of unknown kind when it is asked again, by key; the calls are counted. */
  kinds = new Map<string | null, boolean>()
  kindAsked = 0
  states = new Map<string, RunSessionState>()
  statuses = new Map<string, WorkerStatus>()
  started: Array<{ record: Job; task: RunnerTask; sessionId: string; text: string }> = []
  startProblem: string | null = null
  /** Tasks without a project a new session could start in. */
  noProject = new Set<string>()
  delivered: Array<{ sessionId: string; text: string }> = []
  deliveryOutcome: DeliveryOutcome = 'resumed'
  outcomes = new Map<string, DeliveryOutcome>()
  edits: Array<{ taskId: string; text?: string; schedule: ScheduleFields | null }> = []
  editFails = false
  alerts: string[] = []
  flagged: string[] = []
  ended: string[] = []
  store = new JobStore(join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.json'))

  task(id: string, schedule: ScheduleFields | null, patch: Partial<RunnerTask> & { space?: string | null; owner?: string[] } = {}): WorldTask {
    const { space = null, owner = ['lasse'], properties, ...rest } = patch
    const task: WorldTask = {
      id, title: `slug-${id}`, content: `Do the work of ${id}.`, status: 'active', scope: 'project.eml', ingested_by: 'lasse', space,
      properties: { assignee_ids: owner, display_title: `Task ${id}`, ...(schedule ? { delegation: { agent: 'atlas', checkpoint: 'none', schedule } } : {}), ...properties },
      ...rest,
    }
    this.tasks.set(id, task)
    return task
  }

  patch(id: string, patch: Partial<WorldTask>): void {
    this.tasks.set(id, { ...this.tasks.get(id)!, ...patch })
  }

  scheduleOf(id: string): ScheduleFields | null {
    return this.tasks.get(id)?.properties?.delegation?.schedule ?? null
  }

  setSchedule(id: string, schedule: ScheduleFields | null): void {
    const task = this.tasks.get(id)!
    const delegation = withSchedule(task.properties?.delegation ?? { agent: 'atlas' }, schedule)
    this.patch(id, { properties: { ...task.properties, delegation } })
  }

  session(taskId: string, sessionId: string, working = false, linked = true): void {
    this.sessions.unshift({ taskId, sessionId, working, linked })
    this.states.set(sessionId, working ? 'working' : 'idle')
  }

  wait(taskId: string, sessionId: string, kind: string): void {
    const task = this.tasks.get(taskId)!
    this.patch(taskId, { properties: { ...task.properties, waits: [{ id: sessionId, who: 'lasse', kind, why: 'asks', session_id: sessionId }] } })
  }

  deps(patch: Partial<JobRunnerDeps> = {}): JobRunnerDeps {
    return {
      store: this.store,
      now: () => this.now,
      me: this.me,
      spaces: () => this.spaces,
      openTasks: async (space) => {
        if (this.unreadable.has(space.key)) return null
        this.listReads += 1
        return [...this.tasks.values()].filter((t) => t.space === space.key && ['planned', 'active'].includes(t.status)).slice(0, this.listLimit).map((t) => structuredClone(t))
      },
      task: async (space, taskId) => {
        if (this.unreadable.has(space.key)) throw new Error('the brain does not answer')
        this.taskReads.push(taskId)
        const found = this.tasks.get(taskId)
        return found && found.space === space.key ? structuredClone(found) : null
      },
      waitsForMigration: (taskId) => this.unmoved.has(taskId),
      holdsFirstSight: (space) => this.unchecked.has(space.key),
      spaceKind: async (space) => { this.kindAsked += 1; return this.kinds.get(space.key) ?? null },
      members: async () => this.members,
      workingElsewhere: async (_space, taskId) => this.elsewhere.has(taskId),
      sessionsOf: (taskId) => this.sessions.filter((s) => s.taskId === taskId).map(({ sessionId, working, linked }) => ({ sessionId, working, linked })),
      editSchedule: async (_space, taskId, edit, text) => {
        if (this.editFails) throw new Error('the brain refused the write')
        const before = this.scheduleOf(taskId)
        const next = edit(before, this.tasks.get(taskId) as never)
        if (JSON.stringify(next) === JSON.stringify(before) && !text) return
        this.setSchedule(taskId, next)
        this.edits.push({ taskId, schedule: next, ...(text ? { text } : {}) })
      },
      hasRoom: () => this.room,
      sessionState: (id) => this.states.get(id) ?? 'queued',
      sessionRuns: (id) => ['working', 'idle'].includes(this.states.get(id) ?? ''),
      statusSince: (id) => { const kind = this.statuses.get(id); return kind ? { kind, reason: kind === 'review' ? 'Brief written' : null } : null },
      deliver: async (sessionId, text) => {
        this.delivered.push({ sessionId, text })
        return this.outcomes.get(sessionId) ?? this.deliveryOutcome
      },
      projectOf: (_record, task) => (this.noProject.has(task.id) ? null : 'eml'),
      startWorker: (record, task, sessionId, text) => {
        if (this.startProblem) return this.startProblem
        this.started.push({ record, task, sessionId, text })
        return null
      },
      notify: (input) => { this.alerts.push(`${input.kind}: ${input.title}: ${input.body}`) },
      flag: (_record, text) => { this.flagged.push(text) },
      log: () => {},
      timeZone: () => ZONE,
      onGrantEnd: (record, tools) => { this.ended.push(`${record.id}:${tools.join(',')}`) },
      // The tests move the clock themselves: every pass reads the tasks.
      deriveEveryMs: 0,
      ...patch,
    }
  }
}

let world: World
let runner: JobRunner
const runs = (id: string) => world.store.runs(id)
const statuses = (id: string) => runs(id).map((r) => r.status)
/** The first pass sees the schedule (its cursor is now); then the clock moves to `at` and a pass runs. */
const firstSeenThen = async (at: string) => {
  await runner.tick()
  world.now = Date.parse(at)
  await runner.tick()
}

beforeEach(() => {
  world = new World()
  runner = new JobRunner(world.deps())
})

describe('deriving what is due', () => {
  it('makes a record when a schedule is first seen, with the cursor at now: no time of the past fires', async () => {
    world.now = Date.parse('2026-11-09T00:30:00Z') // 08:30: today's 08:00 has passed
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    expect(world.store.get('daily')).toMatchObject({ id: 'daily', taskId: 'daily', spaceId: null, cursor: '2026-11-09T00:30:00.000Z', firedWake: null, runCount: 0, notify: 'needs-me' })
    expect(runs('daily')).toEqual([])
    expect(world.started).toEqual([])
  })

  it('starts a new session with the prompt built from the task and a line naming what fired, and not again for the same time', async () => {
    world.task('daily', WEEKDAYS_8)
    await firstSeenThen('2026-11-10T00:00:30Z')
    await runner.tick()
    await runner.tick()
    expect(world.started).toHaveLength(1)
    const text = world.started[0].text
    expect(text.split('\n')[0]).toBe('The task\'s schedule started you for "Task daily" (task daily).')
    expect(text).toContain('Do the work of daily.')
    // a run for a schedule is never told to close the task
    expect(text).toContain('No checkpoint: do this run to the end on your own; ask only when you cannot go on.')
    expect(text).not.toContain('Closing means')
    expect(text.split('\n\n').at(-1)).toBe(
      '[From the cockpit, not from your user: run 1 for task "Task daily" (daily). '
      + 'What fired: the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due Tue 10 Nov 08:00. '
      + `Nobody may be watching: end your turn with end_turn if you have it. ${SCHEDULE_TASK_RULE}]`,
    )
    expect(world.store.get('daily')).toMatchObject({ cursor: '2026-11-10T00:00:30.000Z', runCount: 1, lastRunAt: '2026-11-10T00:00:30.000Z' })
    expect(runs('daily')).toEqual([expect.objectContaining({
      status: 'started', number: 1, trigger: 'schedule', dueAt: '2026-11-10T00:00:00.000Z', sessionId: world.started[0].sessionId, newSession: true,
      fired: { crons: [{ cron: '0 8 * * 1-5', dueAt: '2026-11-10T00:00:00.000Z' }], timeZone: ZONE },
    })])
  })

  it('starts the session with the record\'s project and limits, for the task and the record', async () => {
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    world.store.put({ ...world.store.get('daily')!, projectId: 'bp-other', limited: true, toolProfile: { deny: ['Bash'] } as never })
    world.now = Date.parse('2026-11-10T00:00:30Z')
    await runner.tick()
    expect(world.started[0].record).toMatchObject({ id: 'daily', taskId: 'daily', projectId: 'bp-other', limited: true, toolProfile: { deny: ['Bash'] } })
    expect(world.started[0].task).toMatchObject({ id: 'daily', scope: 'project.eml' })
  })

  it('tells a run with a checkpoint what the checkpoint asks, and never to close the task itself', async () => {
    world.task('daily', WEEKDAYS_8, { properties: { delegation: { agent: 'atlas', checkpoint: 'after', schedule: WEEKDAYS_8 } } })
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started[0].text).toMatch(/Checkpoint after: /)
    expect(world.started[0].text).toContain('Never close the task yourself')
  })

  it('makes one firing of several times due at once, naming all of them: the wake-up and every repeating time', async () => {
    world.task('multi', { crons: ['0 8 * * 1-5', '0 8 * * 2'], at: '2026-11-09T23:30:00.000Z', why: 'Check the reply.', by_session: 'gone', time_zone: ZONE })
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toHaveLength(1)
    expect(runs('multi')).toHaveLength(1)
    expect(runs('multi')[0]).toMatchObject({ number: 1, dueAt: '2026-11-09T23:30:00.000Z' })
    const parts = world.started[0].text.split('\n\n')
    expect(parts.at(-2)).toContain('What fired: the wake-up set for Tue 10 Nov 07:30 (Asia/Makassar), 31 min late; the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due Tue 10 Nov 08:00; the repeating time every Tuesday at 08:00 (cron "0 8 * * 2", Asia/Makassar), due Tue 10 Nov 08:00.')
    expect(parts.at(-1)).toBe('The wake-up\'s reason: Check the reply.')
  })

  it('records a repeating time due longer ago than six hours as missed and tells; a wake-up fires late', async () => {
    world.task('daily', { crons: ['0 9 * * *'], time_zone: ZONE })
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check reply.' })
    await firstSeenThen('2026-11-09T09:00:00Z') // 17:00 local: the 09:00 time is 8 h late
    expect(statuses('daily')).toEqual(['missed'])
    expect(runs('daily')[0]).toMatchObject({ number: 0, dueAt: '2026-11-09T01:00:00.000Z', note: 'due 8 h ago while the cockpit was not running' })
    expect(world.alerts).toEqual([expect.stringMatching(/^missed: Task daily: Missed a run due 8 h ago while the cockpit was not running \(cron "0 9 \* \* \*"\)/)])
    expect(world.store.get('daily')).toMatchObject({ cursor: '2026-11-09T09:00:00.000Z', runCount: 0 })
    expect(statuses('once')).toEqual(['started'])
    expect(world.started[0].text).toMatch(/420 min late/)
  })

  it('fires a wake-up that was due before the schedule was first seen', async () => {
    world.now = Date.parse('2026-11-09T05:00:00Z')
    world.task('once', { at: '2026-11-09T02:00:00.000Z' })
    await runner.tick()
    expect(statuses('once')).toEqual(['started'])
  })

  it('reads the open tasks once per space and pass, and no task on its own', async () => {
    world.spaces = [MAIN, TEAM]
    for (let i = 0; i < 20; i++) world.task(`t${i}`, WEEKDAYS_8)
    world.task('theirs', WEEKDAYS_8, { space: 'team' })
    await firstSeenThen('2026-11-10T00:00:30Z')
    // two passes, two spaces: four lists
    expect(world.listReads).toBe(4)
    // a task is read on its own only when one of its runs is tried: two starts per pass
    expect(world.taskReads).toHaveLength(2)
  })

  it('reads the tasks at most once a minute, while every tick still settles and starts runs', async () => {
    runner = new JobRunner(world.deps({ deriveEveryMs: undefined }))
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    world.now += 30_000
    await runner.tick()
    expect(world.listReads).toBe(1)
    // the tick on the minute reads again, also when its timer fires a little early
    world.now += 29_900
    await runner.tick()
    expect(world.listReads).toBe(2)
  })

  it('leaves a space alone whose tasks cannot be read: nothing fires, and no record is touched', async () => {
    world.task('daily', WEEKDAYS_8)
    world.store.put({ ...newRecord({ id: 'old', spaceId: null }, '2026-11-01T00:00:00.000Z'), cursor: '2026-11-01T00:00:00.000Z' })
    world.unreadable.add(null)
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toEqual([])
    expect(world.store.get('daily')).toBeUndefined()
    expect(world.store.get('old')).toBeDefined()
    // once it can be read, the schedule is seen for the first time: from then on
    world.unreadable.clear()
    await runner.tick()
    expect(world.store.get('daily')?.cursor).toBe('2026-11-10T00:00:30.000Z')
    expect(world.started).toEqual([])
  })

  it('leaves a task alone while its version 1 jobs have not moved onto it: nothing is derived, its record is not touched; the others fire', async () => {
    world.task('unmoved', { ...WEEKDAYS_8, at: '2026-11-09T00:00:00.000Z' })
    world.task('old-record', null)
    world.store.put({ ...newRecord({ id: 'old-record', spaceId: null }, '2026-11-01T00:00:00.000Z'), cursor: '2026-11-01T00:00:00.000Z' })
    world.task('daily', WEEKDAYS_8)
    world.unmoved = new Set(['unmoved', 'old-record'])
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started.map((s) => s.task.id)).toEqual(['daily'])
    expect(world.store.get('unmoved')).toBeUndefined()
    expect(world.store.get('old-record')?.cursor).toBe('2026-11-01T00:00:00.000Z')
    // moved: seen for the first time now
    world.unmoved.clear()
    world.setSchedule('unmoved', WEEKDAYS_8)
    await runner.tick()
    expect(world.store.get('unmoved')?.cursor).toBe('2026-11-10T00:00:30.000Z')
    expect(world.store.get('old-record')).toBeUndefined()
    expect(world.started).toHaveLength(1)
  })

  it('while the jobs migration has not looked through a space for left-over schedules, a schedule is not taken up by being seen: only a task with a record fires', async () => {
    // a schedule the old mirror left on a task without a job: nothing ran it before, and its past wake-up must not fire now
    world.task('leftover', { ...HOURLY, at: '2026-11-08T00:00:00.000Z', why: 'An old check.' })
    // a schedule someone set here since the update: its record was made with it
    world.task('set-here', HOURLY)
    world.store.put(newRecord({ id: 'set-here', spaceId: null }, '2026-11-09T00:00:00.000Z'))
    world.unchecked.add(null)
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(world.started.map((s) => s.task.id)).toEqual(['set-here'])
    expect(world.store.get('leftover')).toBeUndefined()
    // the migration removed what was left over and is through with the space: from now on a schedule is taken up when seen
    world.setSchedule('leftover', null)
    world.task('new', HOURLY)
    world.unchecked.delete(null)
    world.now += MIN
    await runner.tick()
    expect(world.store.get('new')).toMatchObject({ cursor: '2026-11-09T01:01:10.000Z' })
    expect(world.store.get('leftover')).toBeUndefined()
  })

  it('a task whose schedule cannot be derived does not hold up the others', async () => {
    world.task('broken', HOURLY)
    world.task('fine', HOURLY)
    await runner.tick()
    // its schedule is due to end, and the brain refuses that write
    world.store.put({ ...world.store.get('broken')!, end: { afterRuns: 1 }, runCount: 1 })
    world.editFails = true
    world.now += HOUR
    await runner.tick()
    expect(world.started.map((s) => s.task.id)).toEqual(['fine'])
    expect(world.scheduleOf('broken')).toEqual(HOURLY)
    // the next read tries again
    world.editFails = false
    world.now += MIN
    await runner.tick()
    expect(world.scheduleOf('broken')).toBeNull()
  })

  it('honours a pause: nothing fires, and resumed it goes on from then without making up what fell due', async () => {
    world.task('daily', { ...WEEKDAYS_8, paused: true })
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toEqual([])
    expect(world.store.get('daily')?.cursor).toBeNull()
    // a pass over a paused schedule writes nothing more
    const before = world.store.get('daily')!.updatedAt
    world.now += MIN
    await runner.tick()
    expect(world.store.get('daily')!.updatedAt).toBe(before)
    world.setSchedule('daily', WEEKDAYS_8)
    world.now = Date.parse('2026-11-10T03:00:00Z')
    await runner.tick()
    expect(world.started).toEqual([])
    expect(world.store.get('daily')?.cursor).toBe('2026-11-10T03:00:00.000Z')
    world.now = Date.parse('2026-11-11T00:00:30Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
  })

  it('a pause seen after the schedule ran forgets the cursor, so the times of the pause are never made up', async () => {
    world.task('hourly', HOURLY)
    await runner.tick()
    world.setSchedule('hourly', { ...HOURLY, paused: true })
    world.now += 2 * HOUR + MIN
    await runner.tick()
    expect(world.store.get('hourly')?.cursor).toBeNull()
    world.setSchedule('hourly', HOURLY)
    world.now += 2 * HOUR
    await runner.tick()
    expect(runs('hourly')).toEqual([])
    world.now += HOUR
    await runner.tick()
    expect(statuses('hourly')).toEqual(['started'])
  })

  it('paused and resumed between two reads: a time that fell inside the pause does not run, though no read saw the pause', async () => {
    world.task('hourly', HOURLY)
    await runner.tick()
    expect(world.store.get('hourly')?.cursor).toBe('2026-11-09T00:00:00.000Z')
    // paused at 00:30 and resumed at 01:10, with no read in between: 01:00 fell inside the pause
    world.setSchedule('hourly', { ...HOURLY, paused: true })
    runner.paused('hourly')
    world.now += HOUR + 10 * MIN
    world.setSchedule('hourly', HOURLY)
    runner.resumed('hourly')
    expect(world.store.get('hourly')?.cursor).toBeNull()
    await runner.tick()
    expect(runs('hourly')).toEqual([])
    expect(world.store.get('hourly')?.cursor).toBe('2026-11-09T01:10:00.000Z')
    // it goes on from the resume: the next time runs
    world.now = Date.parse('2026-11-09T02:00:30Z')
    await runner.tick()
    expect(statuses('hourly')).toEqual(['started'])
  })

  it('fires a time that was due at the schedule\'s end when the pass comes just after it, once, and nothing after', async () => {
    world.task('ends', { ...HOURLY, ends_at: '2026-11-09T01:00:00.000Z' })
    await firstSeenThen('2026-11-09T01:00:25Z')
    expect(runs('ends')).toMatchObject([{ status: 'started', dueAt: '2026-11-09T01:00:00.000Z' }])
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now = Date.parse('2026-11-09T01:01:25Z')
    await runner.tick()
    world.now = Date.parse('2026-11-09T02:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
    // past its end the cursor is forgotten: nothing of that time is made up should the end be taken off
    expect(world.store.get('ends')?.cursor).toBeNull()
  })

  it('fires a time at the schedule\'s end itself, and nothing after it', async () => {
    world.task('ends', { ...HOURLY, ends_at: '2026-11-09T01:00:00.000Z' })
    await firstSeenThen('2026-11-09T01:00:00Z')
    expect(statuses('ends')).toEqual(['started'])
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now = Date.parse('2026-11-09T02:00:10Z')
    await runner.tick()
    expect(statuses('ends')).toEqual(['finished'])
    expect(world.started).toHaveLength(1)
  })

  it('ends the schedule on the task after the runs it was set to have; the task stays open', async () => {
    world.task('twice', HOURLY)
    await runner.tick()
    world.store.put({ ...world.store.get('twice')!, end: { afterRuns: 2 } })
    for (let hour = 1; hour <= 2; hour++) {
      world.now = Date.parse('2026-11-09T00:00:10Z') + hour * HOUR
      await runner.tick()
      if (hour === 1) world.statuses.set(world.started[0].sessionId, 'done')
    }
    expect(world.started).toHaveLength(2)
    // the second run is still open: the schedule ends once it is over
    world.states.set(world.started[1].sessionId, 'working')
    world.now += HOUR
    await runner.tick()
    expect(world.started).toHaveLength(2)
    expect(world.edits).toEqual([])
    world.statuses.set(world.started[1].sessionId, 'done')
    world.now += MIN
    await runner.tick()
    expect(world.edits).toEqual([{ taskId: 'twice', schedule: null, text: 'Its repeating times ended after the runs they were set to have.' }])
    expect(world.tasks.get('twice')!.status).toBe('active')
    // without a schedule, a channel or an open run the record goes with the next pass
    await runner.tick()
    expect(world.store.get('twice')).toBeUndefined()
    expect(world.started).toHaveLength(2)
  })

  it('max runs ends the repeating times only: a wake-up the last run set stays, and the count is over', async () => {
    world.task('routine', HOURLY)
    await runner.tick()
    world.store.put({ ...world.store.get('routine')!, end: { afterRuns: 1 } })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
    // the run's session ends its turn with a time: the task has a wake-up for tomorrow
    const wake = { at: '2026-11-10T01:00:00.000Z', why: 'Check whether the customer answered.', by_session: world.started[0].sessionId }
    world.setSchedule('routine', { ...HOURLY, ...wake })
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now += MIN
    await runner.tick()
    expect(world.scheduleOf('routine')).toEqual({ ...wake, time_zone: 'UTC' })
    expect(world.edits.at(-1)?.text).toBe('Its repeating times ended after the runs they were set to have.')
    expect(world.store.get('routine')?.end).toBeNull()
    // no repeating time fires any more; the wake-up fires at its time
    world.now = Date.parse('2026-11-09T05:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(1)
    world.now = Date.parse('2026-11-10T01:00:10Z')
    await runner.tick()
    expect(statuses('routine')).toEqual(['finished', 'started'])
    expect(world.delivered.at(-1)?.text ?? world.started.at(-1)?.text).toContain('Check whether the customer answered.')
  })

  it('max runs: while the last run is open no repeating time fires, and they go off the task once it is over', async () => {
    world.task('routine', HOURLY)
    await runner.tick()
    world.store.put({ ...world.store.get('routine')!, end: { afterRuns: 1 } })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    world.states.set(world.started[0].sessionId, 'working')
    world.now = Date.parse('2026-11-09T02:00:10Z')
    await runner.tick()
    expect(world.scheduleOf('routine')).toEqual(HOURLY)
    expect(statuses('routine')).toEqual(['started'])
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now += MIN
    await runner.tick()
    expect(world.scheduleOf('routine')).toBeNull()
    expect(world.started).toHaveLength(1)
  })

  it('a count left on a record whose task has no repeating time never ends a schedule set later', async () => {
    // the record stays for its tool profile; its repeating times were ended some other way
    world.task('follow', { at: '2026-11-10T00:00:00.000Z', why: 'Follow up.' })
    world.store.put({ ...newRecord({ id: 'follow', spaceId: null }, '2026-11-01T00:00:00.000Z'), toolProfile: { deniedTools: ['Bash'], mcpServers: null }, end: { afterRuns: 3 }, runCount: 3 })
    await runner.tick()
    expect(world.scheduleOf('follow')).toEqual({ at: '2026-11-10T00:00:00.000Z', why: 'Follow up.' })
    expect(world.edits).toEqual([])
    expect(world.store.get('follow')?.end).toBeNull()
    // and with no schedule at all
    world.task('bare', null)
    world.store.put({ ...newRecord({ id: 'bare', spaceId: null }, '2026-11-01T00:00:00.000Z'), limited: true, end: { afterRuns: 3 }, runCount: 3 })
    await runner.tick()
    expect(world.store.get('bare')).toMatchObject({ limited: true, end: null })
  })

  it('counts only the runs a repeating time fired toward max runs: not Run now, not a message, not a wake-up', async () => {
    world.task('routine', { ...HOURLY, at: '2026-11-09T00:30:00.000Z' })
    await runner.tick()
    world.store.put({ ...world.store.get('routine')!, end: { afterRuns: 1 }, triggers: [{ type: 'mail', match: [] }] })
    const finish = async () => { world.statuses.set(world.started.at(-1)!.sessionId, 'done'); world.now += MIN; await runner.tick() }
    world.now = Date.parse('2026-11-09T00:30:10Z')
    await runner.tick() // the wake-up
    await finish()
    expect(await runner.runNow(MAIN, world.tasks.get('routine')!)).toMatchObject({ trigger: 'manual' })
    await runner.tick()
    await finish()
    // a message the bridge has to bring again moves nothing
    world.room = false
    expect(await runner.wake(world.store.get('routine')!, 'mail', '1 new message', 'key-1')).toBe('retry')
    world.room = true
    expect(await runner.wake(world.store.get('routine')!, 'mail', '1 new message', 'key-1')).toBe('delivered')
    await finish()
    expect(world.started).toHaveLength(3)
    // one run of a repeating time is still left
    const record = world.store.get('routine')!
    expect(record.end!.afterRuns - record.runCount).toBe(1)
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(4)
    await finish()
    expect(world.scheduleOf('routine')).toBeNull()
  })
})

describe('who fires: the task\'s owner, by the one rule (the first assignee, else the author)', () => {
  beforeEach(() => {
    world.spaces = [TEAM]
  })

  const fires = async (id: string) => {
    await firstSeenThen('2026-11-10T00:00:30Z')
    return { record: world.store.get(id) !== undefined, started: world.started.some((s) => s.task.id === id) }
  }

  it('fires my task', async () => {
    world.task('mine', WEEKDAYS_8, { space: 'team', owner: ['lasse', 'dominik'], ingested_by: 'dominik' })
    expect(await fires('mine')).toEqual({ record: true, started: true })
    expect(world.store.get('mine')?.spaceId).toBe('team')
  })

  it('leaves another member\'s task to their cockpit: no record, no run', async () => {
    world.task('theirs', WEEKDAYS_8, { space: 'team', owner: ['dominik', 'lasse'], ingested_by: 'lasse' })
    expect(await fires('theirs')).toEqual({ record: false, started: false })
  })

  it('fires a task nobody is assigned to that I authored', async () => {
    world.task('authored', WEEKDAYS_8, { space: 'team', owner: [], ingested_by: 'lasse' })
    expect(await fires('authored')).toEqual({ record: true, started: true })
  })

  it('leaves a task nobody is assigned to that another member authored', async () => {
    world.task('their-own', WEEKDAYS_8, { space: 'team', owner: [], ingested_by: 'dominik' })
    expect(await fires('their-own')).toEqual({ record: false, started: false })
  })

  it('fires every task of a local space', async () => {
    world.spaces = [MAIN]
    world.task('local', WEEKDAYS_8, { owner: ['dominik'], ingested_by: 'dominik' })
    world.task('agents', WEEKDAYS_8, { owner: [], ingested_by: 'atlas' })
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started.map((s) => s.task.id).sort()).toEqual(['agents', 'local'])
  })

  it('fires nothing in a space whose kind is not known, touches none of its records, and asks again at every read until it is', async () => {
    const unsure: RunnerSpace = { key: 'team', name: 'Team', shared: null }
    world.spaces = [unsure, MAIN]
    world.task('mine', WEEKDAYS_8, { space: 'team' })
    world.task('closed', null, { space: 'team', status: 'resolved' })
    world.task('local', WEEKDAYS_8)
    world.store.put({ ...newRecord({ id: 'mine', spaceId: 'team' }, '2026-11-01T00:00:00.000Z'), cursor: '2026-11-09T00:00:00.000Z' })
    world.store.put({ ...newRecord({ id: 'closed', spaceId: 'team' }, '2026-11-01T00:00:00.000Z'), triggers: [{ type: 'mail', match: [] }] })
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started.map((s) => s.task.id)).toEqual(['local'])
    expect(world.store.get('mine')?.cursor).toBe('2026-11-09T00:00:00.000Z')
    expect(world.store.get('closed')?.triggers).toHaveLength(1)
    expect(world.kindAsked).toBe(2)
    // a message for a task of that space stays with the bridge
    expect(await runner.wake(world.store.get('closed')!, 'mail', '1 new message', 'k1')).toBe('refused')
    world.patch('closed', { status: 'active' })
    expect(await runner.wake(world.store.get('closed')!, 'mail', '1 new message', 'k1')).toBe('retry')
    // the brain server answers: the space is shared, and my task fires from the cursor it had
    world.kinds.set('team', true)
    world.now += MIN
    await runner.tick()
    expect(world.started.map((s) => s.task.id)).toEqual(['local', 'mine'])
  })

  describe('a task no member owns (nobody assigned, written by an agent)', () => {
    const ownerless = () => world.task('agents', WEEKDAYS_8, { space: 'team', owner: [], ingested_by: 'atlas' })

    it('does not fire by being seen, and gets no record', async () => {
      ownerless()
      expect(await fires('agents')).toEqual({ record: false, started: false })
    })

    it('fires on the cockpit that holds a record for it', async () => {
      ownerless()
      world.store.put(newRecord({ id: 'agents', spaceId: 'team' }, '2026-11-01T00:00:00.000Z'))
      expect(await fires('agents')).toEqual({ record: true, started: true })
    })

    it('its record is left alone while the members cannot be read: nothing fires, nothing is removed', async () => {
      ownerless()
      world.store.put({ ...newRecord({ id: 'agents', spaceId: 'team' }, '2026-11-01T00:00:00.000Z'), cursor: '2026-11-10T00:00:10.000Z' })
      world.members = null
      expect(await fires('agents')).toEqual({ record: true, started: false })
      expect(world.store.get('agents')?.cursor).toBe('2026-11-10T00:00:10.000Z')
      world.members = ['lasse', 'dominik']
      world.now = Date.parse('2026-11-11T00:00:30Z')
      await runner.tick()
      await runner.tick()
      expect(world.started.map((s) => s.task.id)).toEqual(['agents'])
    })

    it('a task nobody is assigned to that another member wrote is that member\'s, record or not', async () => {
      world.task('their-own', WEEKDAYS_8, { space: 'team', owner: [], ingested_by: 'dominik' })
      world.store.put({ ...newRecord({ id: 'their-own', spaceId: 'team' }, '2026-11-01T00:00:00.000Z'), limited: true })
      expect(await fires('their-own')).toEqual({ record: true, started: false })
    })
  })

  it('drops the record of a task that went to another member, once no run of it is open', async () => {
    world.task('moved', WEEKDAYS_8, { space: 'team' })
    await runner.tick()
    expect(world.store.get('moved')).toBeDefined()
    world.patch('moved', { properties: { ...world.tasks.get('moved')!.properties, assignee_ids: ['dominik'] } })
    await runner.tick()
    expect(world.store.get('moved')).toBeUndefined()
    expect(world.taskReads).toEqual([])
  })
})

describe('the four-line order', () => {
  it('a: skips a due time while a session of the task works, records it, and does not fire it later', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-work', true)
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toEqual([])
    expect(world.delivered).toEqual([])
    expect(runs('daily')).toEqual([expect.objectContaining({ status: 'skipped', number: 0, dueAt: '2026-11-10T00:00:00.000Z', note: 'a session of the task was working', fired: expect.objectContaining({ crons: [expect.objectContaining({ cron: '0 8 * * 1-5' })] }) })])
    expect(world.store.get('daily')).toMatchObject({ runCount: 0, cursor: '2026-11-10T00:00:30.000Z' })
    world.sessions[0].working = false
    world.now += MIN
    await runner.tick()
    expect(statuses('daily')).toEqual(['skipped'])
  })

  it('a: a wake-up due while a session works is not skipped: it stays due, pass after pass without a row, and fires once when the session stops', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.', by_session: 's-work' })
    world.session('once', 's-work', true)
    await firstSeenThen('2026-11-09T02:00:10Z')
    for (let pass = 0; pass < 3; pass++) {
      world.now += MIN
      await runner.tick()
    }
    expect(runs('once')).toEqual([])
    expect(world.scheduleOf('once')).toEqual({ at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.', by_session: 's-work' })
    expect(world.store.get('once')).toMatchObject({ firedWake: null, runCount: 0 })
    expect(world.edits).toEqual([])
    // the session stops: the first pass after it gives the wake-up to the session that set it
    world.sessions[0].working = false
    world.states.set('s-work', 'idle')
    world.now += MIN
    await runner.tick()
    expect(world.delivered).toEqual([{ sessionId: 's-work', text: expect.stringContaining('The wake-up\'s reason: Check the reply.') }])
    expect(world.scheduleOf('once')).toBeNull()
    world.now += MIN
    await runner.tick()
    await runner.tick()
    expect(world.delivered).toHaveLength(1)
    expect(statuses('once')).toEqual(['started'])
  })

  it('a wake-up that waited for hours gets its hour to start from when its run was made, not from the time it was set for', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.' })
    world.session('once', 's-work', true)
    await firstSeenThen('2026-11-09T02:00:10Z')
    // the session works for three hours, then stops; the machine has no room for a new session at that moment
    world.now = Date.parse('2026-11-09T05:00:10Z')
    world.sessions[0].working = false
    world.states.set('s-work', 'stopped')
    world.room = false
    await runner.tick()
    world.now += 2 * MIN
    await runner.tick()
    expect(runs('once').map((r) => [r.status, r.attempts])).toEqual([['waiting', 2]])
    expect(world.scheduleOf('once')?.at).toBe('2026-11-09T02:00:00.000Z')
    world.room = true
    world.now += 5 * MIN
    await runner.tick()
    expect(statuses('once')).toEqual(['started'])
    expect(world.started[0].text).toContain('The wake-up\'s reason: Check the reply.')
    expect(world.scheduleOf('once')).toBeNull()
  })

  it('a: repeating times and the wake-up due together while a session works: the times are skipped and recorded, the wake-up stays', async () => {
    world.task('mixed', { ...HOURLY, at: '2026-11-09T01:00:00.000Z', why: 'Check the reply.' })
    world.session('mixed', 's-work', true)
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(runs('mixed')).toEqual([expect.objectContaining({ status: 'skipped', number: 0, note: 'a session of the task was working', fired: { crons: [{ cron: '0 * * * *', dueAt: '2026-11-09T01:00:00.000Z' }], timeZone: 'UTC' } })])
    expect(world.scheduleOf('mixed')?.at).toBe('2026-11-09T01:00:00.000Z')
    world.now += MIN
    await runner.tick()
    expect(runs('mixed')).toHaveLength(1)
    world.sessions[0].working = false
    world.states.set('s-work', 'stopped')
    world.now += MIN
    await runner.tick()
    expect(statuses('mixed')).toEqual(['skipped', 'started'])
    expect(world.started[0].text).toContain('The wake-up\'s reason: Check the reply.')
    expect(world.scheduleOf('mixed')).toEqual(HOURLY)
  })

  it('a: a wake-up whose run finds a session working meanwhile is not used up: the run is taken back and the wake-up fires later', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.' })
    world.session('once', 's-late')
    // the session starts a turn between the read that made the run and the attempt to start it
    let asked = 0
    runner = new JobRunner(world.deps({ sessionsOf: () => [{ sessionId: 's-late', working: ++asked === 2 }] }))
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(asked).toBe(2)
    expect(runs('once')).toEqual([])
    expect(world.store.get('once')).toMatchObject({ firedWake: null, runCount: 0 })
    expect(world.scheduleOf('once')?.at).toBe('2026-11-09T02:00:00.000Z')
    world.now += MIN
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text).toContain('The wake-up\'s reason: Check the reply.')
    expect(world.scheduleOf('once')).toBeNull()
  })

  it('a wake-up due while a run of the task waits for room joins that run: its text names the reason, and only then is the wake-up off the task', async () => {
    world.task('mixed', { ...HOURLY, at: '2026-11-09T01:02:00.000Z', why: 'IMPORTANT follow-up.', by_session: 's-gone' })
    world.room = false
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(statuses('mixed')).toEqual(['waiting'])
    world.now = Date.parse('2026-11-09T01:02:10Z')
    await runner.tick()
    // no skipped row, and the wake-up is still the task's
    expect(statuses('mixed')).toEqual(['waiting'])
    expect(runs('mixed')[0].fired).toEqual({ crons: [{ cron: '0 * * * *', dueAt: '2026-11-09T01:00:00.000Z' }], wake: { at: '2026-11-09T01:02:00.000Z', why: 'IMPORTANT follow-up.', bySession: 's-gone' }, timeZone: 'UTC' })
    expect(world.scheduleOf('mixed')?.at).toBe('2026-11-09T01:02:00.000Z')
    expect(world.store.get('mixed')?.firedWake).toBeNull()
    world.now += MIN
    await runner.tick()
    expect(statuses('mixed')).toEqual(['waiting'])
    expect(world.edits).toEqual([])
    world.room = true
    world.now += 10 * MIN
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text).toContain('What fired: the wake-up set for Mon 9 Nov 01:02 (UTC), 11 min late; the repeating time every hour at :00 (cron "0 * * * *", UTC), due Mon 9 Nov 01:00, 13 min late.')
    expect(world.started[0].text).toContain('The wake-up\'s reason: IMPORTANT follow-up.')
    expect(world.scheduleOf('mixed')).toEqual(HOURLY)
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now += 10 * MIN
    await runner.tick()
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(statuses('mixed')).toEqual(['finished'])
  })

  it('a wake-up joins a run by hand that waits for room, and its text says both', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.' })
    await runner.tick()
    world.room = false
    world.now = Date.parse('2026-11-09T01:55:00Z')
    expect(await runner.runNow(MAIN, world.tasks.get('once')!)).toMatchObject({ trigger: 'manual' })
    await runner.tick()
    world.now = Date.parse('2026-11-09T02:00:10Z')
    await runner.tick()
    expect(statuses('once')).toEqual(['waiting'])
    world.room = true
    world.now += 5 * MIN
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text).toContain('What fired: the owner started it by hand (Run now); the wake-up set for Mon 9 Nov 10:00 (Asia/Makassar), 5 min late.')
    expect(world.started[0].text).toContain('The wake-up\'s reason: Check the reply.')
    expect(world.scheduleOf('once')).toBeNull()
  })

  it('a wake-up whose run fails is used up, as before: the failure is told, and it does not fire again', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.' })
    world.startProblem = 'the task has no project to run in'
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(statuses('once')).toEqual(['failed'])
    expect(world.scheduleOf('once')).toBeNull()
    world.startProblem = null
    world.now += MIN
    await runner.tick()
    expect(world.started).toEqual([])
  })

  it('a: skips a time while another member\'s session works on the task elsewhere', async () => {
    world.spaces = [TEAM]
    world.task('shared', WEEKDAYS_8, { space: 'team' })
    world.elsewhere.add('shared')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(statuses('shared')).toEqual(['skipped'])
  })

  it('skips a time while the task\'s previous run still waits to start, and says so', async () => {
    world.task('hourly', HOURLY)
    world.room = false
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(statuses('hourly')).toEqual(['waiting'])
    world.now = Date.parse('2026-11-09T01:59:50Z')
    await runner.tick()
    world.now = Date.parse('2026-11-09T02:00:05Z')
    await runner.tick()
    expect(runs('hourly').map((r) => [r.status, r.note])).toEqual([['waiting', expect.stringMatching(/^no room/)], ['skipped', 'the previous run had not started yet']])
  })

  it('b: a session that waits on its question continues and gets only the line; no new session', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-asks')
    world.wait('daily', 's-asks', 'question')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toEqual([])
    expect(world.delivered).toEqual([{ sessionId: 's-asks', text: expect.stringMatching(/^\[From the cockpit, not from your user: run 1 for task "Task daily".*What fired: the repeating time on weekdays at 08:00/) }])
    expect(world.delivered[0].text).not.toContain('Do the work of daily.')
    expect(runs('daily')[0]).toMatchObject({ status: 'started', sessionId: 's-asks', newSession: false })
  })

  it('b: a session that waits for the go continues too; a review does not count: a new session starts', async () => {
    world.task('go', WEEKDAYS_8)
    world.session('go', 's-go')
    world.wait('go', 's-go', 'go')
    world.task('review', WEEKDAYS_8)
    world.session('review', 's-review')
    world.wait('review', 's-review', 'review')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-go'])
    expect(world.started.map((s) => s.task.id)).toEqual(['review'])
  })

  it('c: the session that set the wake-up continues, with the wake-up\'s reason', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check whether the customer answered.', by_session: 's-set' })
    world.session('once', 's-set')
    world.session('once', 's-other')
    world.states.set('s-set', 'stopped')
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(world.started).toEqual([])
    expect(world.delivered).toHaveLength(1)
    expect(world.delivered[0].sessionId).toBe('s-set')
    expect(world.delivered[0].text.split('\n\n')).toEqual([expect.stringContaining('What fired: the wake-up set for Mon 9 Nov 10:00 (Asia/Makassar).'), 'The wake-up\'s reason: Check whether the customer answered.'])
  })

  it('c: a new session starts when the session that set the wake-up is gone', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z', why: 'Check the reply.', by_session: 's-gone' })
    world.session('once', 's-other')
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(world.delivered).toEqual([])
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text).toContain('The wake-up\'s reason: Check the reply.')
  })

  it('c: a new session starts when that session cannot be woken after all', async () => {
    world.task('once', null)
    world.session('once', 's-set')
    for (const outcome of ['refused', 'unknown'] as const) {
      world.outcomes.set('s-set', outcome)
      world.setSchedule('once', { at: new Date(world.now + HOUR).toISOString(), by_session: 's-set' })
      await runner.tick()
      world.now += HOUR + 10_000
      await runner.tick()
      world.statuses.set(world.started.at(-1)!.sessionId, 'done')
    }
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-set', 's-set'])
    expect(world.started).toHaveLength(2)
    expect(runs('once').map((r) => [r.attempts, r.newSession])).toEqual([[1, true], [1, true]])
  })

  it('b then d: a waiting session that takes no message is passed over, and a new session starts', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-asks')
    world.wait('daily', 's-asks', 'question')
    world.outcomes.set('s-asks', 'refused')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.delivered).toHaveLength(1)
    expect(world.started).toHaveLength(1)
  })

  it('d: a repeating time starts a new session beside idle sessions of the task', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-idle')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.delivered).toEqual([])
    expect(world.started).toHaveLength(1)
  })

  it('a firing that names the wake-up and a repeating time is one run, in the session that set the wake-up', async () => {
    world.task('both', { crons: ['0 8 * * 1-5'], at: '2026-11-09T23:59:00.000Z', why: 'Look again.', by_session: 's-set', time_zone: ZONE })
    world.session('both', 's-set')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.started).toEqual([])
    expect(world.delivered).toHaveLength(1)
    expect(world.delivered[0].text).toContain('the wake-up set for Tue 10 Nov 07:59 (Asia/Makassar); the repeating time on weekdays at 08:00')
    expect(runs('both')).toHaveLength(1)
  })

  it('a run that waited for room is skipped when a session of the task works by the time it can start', async () => {
    world.task('daily', WEEKDAYS_8)
    world.room = false
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(statuses('daily')).toEqual(['waiting'])
    world.room = true
    world.session('daily', 's-work', true)
    world.now += 2 * MIN
    await runner.tick()
    expect(runs('daily').map((r) => [r.status, r.number, r.note])).toEqual([['skipped', 1, 'a session of the task was working']])
  })
})

describe('the wake-up fires once', () => {
  it('remembers the wake-up it fired and clears it on the task; the repeating times stay', async () => {
    world.task('mixed', { crons: ['0 8 * * 1-5'], at: '2026-11-09T02:00:00.000Z', why: 'Check.', by_session: 's1', time_zone: ZONE })
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(world.started).toHaveLength(1)
    expect(world.scheduleOf('mixed')).toEqual({ crons: ['0 8 * * 1-5'], time_zone: ZONE })
    expect(world.edits).toHaveLength(1)
    // the next read finds it off the task: the record forgets it
    world.now += MIN
    await runner.tick()
    expect(world.store.get('mixed')?.firedWake).toBeNull()
    expect(world.started).toHaveLength(1)
  })

  it('does not fire it again when clearing it on the task failed, and clears it at the next read', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z' })
    world.editFails = true
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(world.started).toHaveLength(1)
    expect(world.scheduleOf('once')).toEqual({ at: '2026-11-09T02:00:00.000Z' })
    expect(world.store.get('once')?.firedWake).toBe('2026-11-09T02:00:00.000Z')
    world.now += MIN
    await runner.tick()
    expect(world.started).toHaveLength(1)
    world.editFails = false
    world.now += MIN
    await runner.tick()
    expect(world.scheduleOf('once')).toBeNull()
    expect(world.started).toHaveLength(1)
  })

  it('leaves a new wake-up the task got meanwhile alone, and fires that one at its time', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z' })
    // the brain write that clears the fired wake-up arrives after the session has set its next one
    runner = new JobRunner(world.deps({
      editSchedule: async (_space, taskId, edit) => {
        world.setSchedule(taskId, { at: '2026-11-09T04:00:00.000Z', why: 'Look again.' })
        world.setSchedule(taskId, edit(world.scheduleOf(taskId), world.tasks.get(taskId) as never))
      },
    }))
    await firstSeenThen('2026-11-09T02:00:10Z')
    expect(world.scheduleOf('once')).toEqual({ at: '2026-11-09T04:00:00.000Z', why: 'Look again.' })
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now = Date.parse('2026-11-09T04:00:10Z')
    await runner.tick()
    expect(world.started).toHaveLength(2)
    expect(world.started[1].text).toContain('The wake-up\'s reason: Look again.')
  })
})

describe('keeping the records in step with their tasks', () => {
  const mail: Job['triggers'] = [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }]

  it('removes a record when its task has no schedule, no channel trigger and no open run', async () => {
    world.task('once', { at: '2026-11-09T02:00:00.000Z' })
    await firstSeenThen('2026-11-09T02:00:10Z')
    const sessionId = world.started[0].sessionId
    world.states.set(sessionId, 'working')
    // the wake-up is off the task, but its run is open: the record stays
    world.now += MIN
    await runner.tick()
    expect(world.store.get('once')).toBeDefined()
    world.statuses.set(sessionId, 'done')
    world.now += MIN
    await runner.tick()
    expect(world.store.get('once')).toBeUndefined()
    expect(runs('once')).toEqual([])
    // the task was among the open ones listed: it was read on its own only to start its run
    expect(world.taskReads).toEqual(['once'])
  })

  it('keeps the record of a task that only a channel wakes, and forgets where its schedule stood', async () => {
    world.task('mail', WEEKDAYS_8)
    await runner.tick()
    world.store.put({ ...world.store.get('mail')!, triggers: mail, firedWake: '2026-11-01T00:00:00.000Z' })
    world.setSchedule('mail', null)
    world.now += MIN
    await runner.tick()
    expect(world.store.get('mail')).toMatchObject({ triggers: mail, cursor: null, firedWake: null })
    // a schedule set later counts from then
    world.setSchedule('mail', WEEKDAYS_8)
    world.now = Date.parse('2026-11-12T03:00:00Z')
    await runner.tick()
    expect(world.store.get('mail')?.cursor).toBe('2026-11-12T03:00:00.000Z')
    expect(runs('mail')).toEqual([])
  })

  it('keeps a limited record while its task is open, so a schedule set later starts no freer session', async () => {
    world.task('plain', null)
    world.store.put({ ...newRecord({ id: 'plain', spaceId: null }, '2026-11-01T00:00:00.000Z'), limited: true })
    await runner.tick()
    expect(world.store.get('plain')?.limited).toBe(true)
  })

  it('a closed task stops listening: its channel no longer wakes it, lent tools go back, and the record goes', async () => {
    world.task('mail', null)
    world.store.put({ ...newRecord({ id: 'mail', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: mail, pendingApproval: true, grants: [{ tool: 'chrome', until: '2026-11-10T00:00:00.000Z', reason: null }] })
    await runner.tick()
    expect(world.store.get('mail')?.triggers).toEqual(mail)
    // closed some other way than End schedule: Looks good, Close, or the agent itself
    world.patch('mail', { status: 'resolved' })
    world.now += MIN
    await runner.tick()
    expect(world.store.get('mail')).toBeUndefined()
    expect(world.ended).toEqual(['mail:chrome'])
    // the task's status was read once to tell closed from "not listed"
    expect(world.taskReads).toEqual(['mail'])
  })

  it('keeps a closed task\'s record while a session still has a run of it, without its channel; then it goes', async () => {
    world.task('mail', null)
    world.store.put({ ...newRecord({ id: 'mail', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: mail, runCount: 2 })
    const run = (id: string, status: JobRun['status'], sessionId: string | null): JobRun => ({
      id, jobId: 'mail', trigger: 'mail', number: id === 'r1' ? 1 : 2, dueAt: '2026-11-09T00:00:00.000Z', createdAt: '2026-11-09T00:00:00.000Z', status, attempts: 1,
      nextAttemptAt: null, sessionId, startedAt: sessionId ? '2026-11-09T00:00:00.000Z' : null, finishedAt: null, outcome: null, note: null,
    })
    world.store.addRun(run('r1', 'started', 's-run'))
    world.store.addRun(run('r2', 'waiting', null))
    world.states.set('s-run', 'working')
    world.patch('mail', { status: 'invalidated' })
    await runner.tick()
    expect(world.store.get('mail')).toMatchObject({ triggers: [] })
    expect(runs('mail').map((r) => [r.status, r.note])).toEqual([['started', null], ['skipped', 'its task was closed before it started']])
    world.statuses.set('s-run', 'done')
    world.now += MIN
    await runner.tick()
    expect(world.store.get('mail')).toBeUndefined()
  })

  it('removes the record of a task that is gone from the brain', async () => {
    world.store.put({ ...newRecord({ id: 'gone', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: mail })
    await runner.tick()
    expect(world.store.get('gone')).toBeUndefined()
  })

  it('still fires a scheduled task the list did not reach, as long as it has a record', async () => {
    world.task('first', null)
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    world.listLimit = 1
    world.now = Date.parse('2026-11-10T00:00:30Z')
    await runner.tick()
    expect(world.started.map((s) => s.task.id)).toEqual(['daily'])
  })

  it('lifts the pause the cockpit set after failures once the schedule runs again, whoever resumed it', async () => {
    world.task('hourly', { ...HOURLY, paused: true })
    world.store.put({ ...newRecord({ id: 'hourly', spaceId: null }, '2026-11-01T00:00:00.000Z'), pausedReason: '3 failed runs in a row', failures: 3 })
    await runner.tick()
    expect(world.store.get('hourly')).toMatchObject({ pausedReason: '3 failed runs in a row', failures: 3 })
    world.setSchedule('hourly', HOURLY)
    world.now += MIN
    await runner.tick()
    expect(world.store.get('hourly')).toMatchObject({ pausedReason: null, failures: 0, cursor: '2026-11-09T00:01:00.000Z' })
  })
})

describe('carrying a run out', () => {
  it('waits for room and tries again later, then fails after an hour and tells', async () => {
    world.task('once', { at: '2026-11-09T01:00:00.000Z' })
    world.room = false
    await firstSeenThen('2026-11-09T01:00:00Z')
    let run = runs('once')[0]
    expect(run).toMatchObject({ status: 'waiting', attempts: 1, note: expect.stringMatching(/^no room/) })
    expect(Date.parse(run.nextAttemptAt!)).toBe(world.now + MIN)
    world.now += 61 * MIN
    await runner.tick()
    run = runs('once')[0]
    expect(run.status).toBe('failed')
    expect(run.note).toMatch(/could not start within 1 h/)
    expect(world.alerts[0]).toMatch(/^failed: Task once: Run 1 failed: could not start within 1 h/)
    expect(world.flagged).toEqual([expect.stringMatching(/^"Task once": run 1 failed: could not start within 1 h/)])
    expect(world.store.get('once')?.failures).toBe(1)
  })

  it('needs no room to give a running session a message', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-asks')
    world.wait('daily', 's-asks', 'question')
    world.room = false
    world.deliveryOutcome = 'delivered'
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(statuses('daily')).toEqual(['started'])
  })

  it('retries while the session it goes to is busy', async () => {
    world.task('once', { at: '2026-11-09T01:00:00.000Z', by_session: 's-set' })
    world.session('once', 's-set')
    world.deliveryOutcome = 'busy'
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(runs('once')[0]).toMatchObject({ status: 'waiting', attempts: 1, note: expect.stringMatching(/its session was busy/) })
    world.deliveryOutcome = 'delivered'
    world.now += 2 * MIN
    await runner.tick()
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-set', 's-set'])
    expect(statuses('once')).toEqual(['started'])
  })

  it('records the session\'s status as the run\'s outcome, and tells when someone is needed', async () => {
    world.task('daily', { crons: ['0 9 * * *'], time_zone: ZONE })
    await firstSeenThen('2026-11-09T01:00:10Z')
    const sessionId = world.started[0].sessionId
    world.states.set(sessionId, 'working')
    world.now += 5 * MIN
    await runner.tick()
    expect(statuses('daily')).toEqual(['started'])
    world.statuses.set(sessionId, 'review')
    world.states.set(sessionId, 'idle')
    await runner.tick()
    expect(runs('daily')[0]).toMatchObject({ status: 'finished', outcome: 'review' })
    expect(world.alerts).toEqual(['review: Task daily: Run 1: Brief written'])
    // Its own session shows the review itself: nothing stands in for it.
    expect(world.flagged).toEqual([])
  })

  it('finishes a run whose session stopped working without a word, quietly when nobody is needed', async () => {
    world.task('daily', WEEKDAYS_8)
    await firstSeenThen('2026-11-10T00:00:30Z')
    world.states.set(world.started[0].sessionId, 'stopped')
    world.now += MIN
    await runner.tick()
    expect(statuses('daily')).toEqual(['started'])
    world.now += MIN
    await runner.tick()
    expect(runs('daily')[0]).toMatchObject({ status: 'finished', outcome: null, finishedAt: '2026-11-10T00:02:30.000Z' })
    expect(world.alerts).toEqual([])
  })

  it('hears of every run when the record says always, and of none when it says never', async () => {
    world.task('loud', WEEKDAYS_8)
    world.task('quiet', WEEKDAYS_8)
    await runner.tick()
    world.store.put({ ...world.store.get('loud')!, notify: 'always' })
    world.store.put({ ...world.store.get('quiet')!, notify: 'never' })
    world.now = Date.parse('2026-11-10T00:00:30Z')
    await runner.tick()
    for (const start of world.started) world.statuses.set(start.sessionId, start.task.id === 'loud' ? 'done' : 'question')
    await runner.tick()
    expect(world.alerts).toEqual(['done: Task loud: Run 1: done'])
  })

  it('fails a run whose session cannot be started, with the reason', async () => {
    world.task('daily', WEEKDAYS_8)
    world.startProblem = 'the task has no project to run in'
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(runs('daily')[0]).toMatchObject({ status: 'failed', note: 'the worker could not start: the task has no project to run in' })
  })

  it('pauses the task\'s schedule after three failures in a row, keeps why on the record, and says so', async () => {
    world.task('hourly', HOURLY)
    world.startProblem = 'no project'
    await runner.tick()
    for (let hour = 1; hour <= 3; hour++) {
      world.now = Date.parse('2026-11-09T00:00:10Z') + hour * HOUR
      await runner.tick()
    }
    expect(world.scheduleOf('hourly')).toEqual({ ...HOURLY, paused: true })
    expect(world.edits.at(-1)).toMatchObject({ taskId: 'hourly', text: expect.stringMatching(/^The cockpit paused its schedule after 3 failed runs in a row; last: run 3 failed/) })
    expect(world.store.get('hourly')).toMatchObject({ failures: 3, pausedReason: expect.stringMatching(/^3 failed runs in a row/) })
    expect(world.alerts.at(-1)).toMatch(/^paused: Task hourly: Paused itself after 3 failed runs in a row.*Resume it on the task once fixed\.$/)
    expect(world.flagged.at(-1)).toMatch(/^The schedule of "Task hourly" paused itself after 3 failed runs/)
    expect(runner.held(world.store.get('hourly')!)).toBe(true)
    world.now += HOUR
    await runner.tick()
    expect(runs('hourly')).toHaveLength(3)
    // the owner resumes it on the task: it runs again from now
    world.setSchedule('hourly', HOURLY)
    runner.resumed('hourly')
    expect(world.store.get('hourly')).toMatchObject({ failures: 0, pausedReason: null, cursor: null })
    world.startProblem = null
    await runner.tick()
    world.now += HOUR
    await runner.tick()
    expect(statuses('hourly').at(-1)).toBe('started')
  })

  it('keeps no pause reason while the pause is not on the task: the write is tried again at the next failure', async () => {
    world.task('hourly', HOURLY)
    world.startProblem = 'no project'
    world.editFails = true
    await runner.tick()
    for (let hour = 1; hour <= 3; hour++) {
      world.now = Date.parse('2026-11-09T00:00:10Z') + hour * HOUR
      await runner.tick()
    }
    expect(world.store.get('hourly')).toMatchObject({ failures: 3, pausedReason: null })
    world.editFails = false
    world.now += HOUR
    await runner.tick()
    expect(world.scheduleOf('hourly')?.paused).toBe(true)
    expect(world.store.get('hourly')?.pausedReason).toMatch(/^4 failed runs in a row/)
  })

  it('a run that ends as failed counts, and a good one starts the count anew', async () => {
    world.task('hourly', HOURLY)
    await runner.tick()
    const hour = async (status: WorkerStatus) => {
      world.now += HOUR
      await runner.tick()
      world.statuses.set(world.started.at(-1)!.sessionId, status)
      world.now += MIN
      await runner.tick()
    }
    await hour('failed')
    await hour('failed')
    expect(world.store.get('hourly')?.failures).toBe(2)
    await hour('done')
    expect(world.store.get('hourly')?.failures).toBe(0)
    expect(world.scheduleOf('hourly')?.paused).toBeUndefined()
  })

  it('starts at most two runs per pass', async () => {
    for (const id of ['a', 'b', 'c']) world.task(id, { at: '2026-11-09T01:00:00.000Z' })
    await firstSeenThen('2026-11-09T01:00:10Z')
    expect(world.started).toHaveLength(2)
    await runner.tick()
    expect(world.started).toHaveLength(3)
  })

  it('skips a run whose task was closed before it started, and counts no failure', async () => {
    world.task('daily', WEEKDAYS_8)
    world.room = false
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(statuses('daily')).toEqual(['waiting'])
    world.patch('daily', { status: 'resolved' })
    world.room = true
    world.now += 2 * MIN
    await runner.tick()
    expect(world.started).toEqual([])
    expect(world.alerts).toEqual([])
    // the record went with its closed task, and its runs with it
    expect(world.store.get('daily')).toBeUndefined()
  })

  it('retries a run a restart cut off while starting, once; a new session that got as far as existing has it', async () => {
    world.task('a', { at: '2026-11-09T01:00:00.000Z', by_session: 's-set' })
    world.session('a', 's-set')
    world.task('b', { at: '2026-11-09T01:00:00.000Z' })
    world.task('c', { at: '2026-11-09T01:00:00.000Z' })
    await firstSeenThen('2026-11-09T01:00:10Z')
    await runner.tick()
    const cut = (id: string, patch: Partial<JobRun>) => world.store.updateRun({ ...runs(id)[0], status: 'starting', startedAt: null, ...patch })
    cut('a', { attempts: 1 })
    cut('b', { attempts: 1 })
    world.states.set(runs('b')[0].sessionId!, 'idle')
    cut('c', { attempts: 2 })
    const after = new JobRunner(world.deps())
    after.recover()
    // a message to a session that existed: nobody knows whether it arrived
    expect(runs('a')[0]).toMatchObject({ status: 'waiting', sessionId: null, note: 'retried after a cockpit restart' })
    expect(runs('b')[0]).toMatchObject({ status: 'started', startedAt: '2026-11-09T01:00:10.000Z' })
    expect(runs('c')[0]).toMatchObject({ status: 'failed', note: 'cut off by a cockpit restart while starting' })
  })

  it('drops a grant once its time is up, and takes lent tools back when the session reports done', async () => {
    world.task('daily', { crons: ['0 9 * * *'], time_zone: ZONE })
    await runner.tick()
    world.store.put({ ...world.store.get('daily')!, limited: true, grants: [{ tool: 'chrome', until: '2026-11-09T00:30:00.000Z', reason: null }, { tool: 'SendMessage', until: '2026-11-09T03:00:00.000Z', reason: null }] })
    world.now = Date.parse('2026-11-09T01:00:10Z')
    await runner.tick()
    expect(world.ended).toEqual(['daily:chrome'])
    expect(world.store.get('daily')?.grants).toEqual([{ tool: 'SendMessage', until: '2026-11-09T03:00:00.000Z', reason: null }])
    world.statuses.set(world.started[0].sessionId, 'done')
    world.now += MIN
    await runner.tick()
    expect(world.ended).toEqual(['daily:chrome', 'daily:SendMessage'])
    expect(world.store.get('daily')?.grants).toEqual([])
  })
})

describe('the log', () => {
  it('names a task and a space by their ids, never by their names: a run, a skipped time, a record that goes, a space that is not read', async () => {
    const logs: string[] = []
    world.spaces = [MAIN, { key: 'team', name: 'Team', shared: null }]
    runner = new JobRunner(world.deps({ log: (line) => logs.push(line) }))
    world.task('aaaa1111-runs', HOURLY)
    world.task('bbbb2222-busy', HOURLY)
    world.task('cccc3333-ends', HOURLY)
    await runner.tick()
    world.session('bbbb2222-busy', 's-busy', true)
    world.setSchedule('cccc3333-ends', null)
    world.now = Date.parse('2026-11-09T01:00:30Z')
    await runner.tick()
    expect(logs).toContain('[jobs] task aaaa1111: run 1 is due')
    expect(logs).toContain('[jobs] task bbbb2222: a time due 2026-11-09T01:00:00.000Z is skipped, a session of the task was working')
    expect(logs).toContain('[jobs] task cccc3333: its record is removed (no schedule, no channel, no open run)')
    expect(logs).toContain('[jobs] space team: the brain server has not said yet whether it is shared: nothing fires here until it has')
    expect(logs.filter((line) => /Task |slug-|Main|Team/.test(line))).toEqual([])
  })
})

describe('where a new session of a task starts', () => {
  it('is the record\'s project, which wins over the task\'s own', () => {
    expect(runProjectOf({ projectId: 'bp-ops' }, { scope: 'project.sales' })).toBe('bp-ops')
    expect(runProjectOf({ projectId: 'bp-ops' }, {})).toBe('bp-ops')
  })

  it('is the project of the task\'s scope when the record names none', () => {
    expect(runProjectOf({ projectId: null }, { scope: 'project.sales' })).toBe('bp-sales')
  })

  it('is nowhere for a task without a project scope: no session can start for it', () => {
    expect(runProjectOf({ projectId: null }, { scope: 'global' })).toBeNull()
    expect(runProjectOf({ projectId: null }, { scope: null })).toBeNull()
    expect(runProjectOf({ projectId: null }, {})).toBeNull()
  })
})

describe('a run by hand', () => {
  const task = (id = 'daily') => world.tasks.get(id)!

  it('starts a run now by the four-line order, also on a paused schedule', async () => {
    world.task('daily', { ...WEEKDAYS_8, paused: true })
    const run = await runner.runNow(MAIN, task())
    expect(run).toMatchObject({ trigger: 'manual', number: 1 })
    await runner.tick()
    expect(world.started).toHaveLength(1)
    expect(world.started[0].text.split('\n')[0]).toBe('The task\'s owner (Run now) started you for "Task daily" (task daily).')
    expect(world.started[0].text).toContain('What fired: the owner started it by hand (Run now).')
  })

  it('goes to the session that waits on an answer', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-asks')
    world.wait('daily', 's-asks', 'go')
    await runner.runNow(MAIN, task())
    await runner.tick()
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-asks'])
  })

  it('is refused while the last run is open, while a session of the task works, and while its channel waits for the OK', async () => {
    world.task('daily', WEEKDAYS_8)
    expect(typeof await runner.runNow(MAIN, task())).toBe('object')
    expect(await runner.runNow(MAIN, task())).toBe('run_open')
    world.task('busy', WEEKDAYS_8)
    world.session('busy', 's-work', true)
    expect(await runner.runNow(MAIN, task('busy'))).toBe('task_working')
    expect(world.store.get('busy')).toBeUndefined()
    world.task('mail', null)
    world.store.put({ ...newRecord({ id: 'mail', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: [{ type: 'mail', match: [] }], pendingApproval: true })
    expect(await runner.runNow(MAIN, task('mail'))).toBe('needs_approval')
  })

  it('is refused before it starts when a new session would be needed and the task has no project to run in', async () => {
    world.task('daily', WEEKDAYS_8)
    world.noProject.add('daily')
    expect(await runner.runNow(MAIN, task())).toBe('no_project')
    // nothing was written: no record made for it, no run that would fail
    expect(world.store.get('daily')).toBeUndefined()
    expect(world.store.runs('daily')).toEqual([])
    // a session that waits on an answer continues: no new session, so no project is needed
    world.session('daily', 's-asks')
    world.wait('daily', 's-asks', 'go')
    expect(await runner.runNow(MAIN, task())).toMatchObject({ trigger: 'manual' })
    // with a project again it runs
    world.task('other', WEEKDAYS_8)
    expect(await runner.runNow(MAIN, task('other'))).toMatchObject({ trigger: 'manual' })
  })
})

describe('a channel message from the bridge', () => {
  const mail: Job['triggers'] = [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }]
  const listen = (patch: Partial<Job> = {}, schedule: ScheduleFields | null = null) => {
    world.task('mail', schedule)
    world.store.put({ ...newRecord({ id: 'mail', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: mail, ...patch })
    return world.store.get('mail')!
  }
  const wake = (key = 'k1') => runner.wake(world.store.get('mail')!, 'mail', '2 new mails from customer.example', key)

  it('d: starts a new session with the task\'s prompt, the line and the message; the same key wakes it once', async () => {
    listen()
    expect(await wake()).toBe('delivered')
    expect(await wake()).toBe('delivered')
    expect(world.started).toHaveLength(1)
    const parts = world.started[0].text.split('\n\n')
    expect(parts[0].split('\n')[0]).toBe('A new message on mail started you for "Task mail" (task mail).')
    expect(parts.at(-2)).toContain('What fired: a new message on mail.')
    expect(parts.at(-1)).toBe('2 new mails from customer.example')
    expect(runs('mail')).toEqual([expect.objectContaining({ status: 'started', trigger: 'mail', number: 1, idempotencyKey: 'k1' })])
    expect(await wake('k2')).toBe('delivered')
    expect(world.started).toHaveLength(2)
  })

  it('a: is never skipped: a working session gets it with its next turn', async () => {
    listen()
    world.session('mail', 's-work', true)
    world.deliveryOutcome = 'delivered'
    expect(await wake()).toBe('delivered')
    expect(world.started).toEqual([])
    expect(world.delivered).toEqual([{ sessionId: 's-work', text: expect.stringMatching(/a new message on mail[^]*\n\n2 new mails from customer\.example$/) }])
    expect(statuses('mail')).toEqual(['started'])
  })

  it('a: asks the bridge to retry when the working session cannot take it, and keeps no run of the try', async () => {
    listen()
    world.session('mail', 's-terminal', true)
    for (const outcome of ['busy', 'refused'] as const) {
      world.deliveryOutcome = outcome
      expect(await wake()).toBe('retry')
    }
    expect(world.started).toEqual([])
    expect(runs('mail')).toEqual([])
    expect(world.store.get('mail')?.runCount).toBe(0)
    // the bridge comes back with the same key once the session is free
    world.deliveryOutcome = 'delivered'
    expect(await wake()).toBe('delivered')
  })

  it('a: asks for a retry while another member\'s session works on the task', async () => {
    listen()
    world.elsewhere.add('mail')
    expect(await wake()).toBe('retry')
    expect(world.started).toEqual([])
  })

  it('b: goes to the session that waits on an answer', async () => {
    listen()
    world.session('mail', 's-asks')
    world.wait('mail', 's-asks', 'question')
    expect(await wake()).toBe('delivered')
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-asks'])
    expect(world.started).toEqual([])
  })

  it('never answers delivered unless a session linked to the record got the message, or one was started for it', async () => {
    const mail = () => runner.wake(world.store.get('mail')!, 'mail', '1 new message', `key-${world.now}`)
    world.task('mail', null)
    world.store.put({ ...newRecord({ id: 'mail', spaceId: null }, '2026-11-01T00:00:00.000Z'), triggers: [{ type: 'mail', match: [] }] })
    // the owner's own session on the task: it has no bridge tools, so it could not read or answer the mail
    world.session('mail', 's-own', true, false)
    expect(await mail()).toBe('retry')
    expect(world.delivered).toEqual([])
    expect(world.started).toEqual([])
    expect(runs('mail')).toEqual([])
    // it stops and waits on the owner's answer: the message still does not go to it; a session is started for the record
    world.sessions[0].working = false
    world.states.set('s-own', 'idle')
    world.wait('mail', 's-own', 'question')
    world.now += MIN
    expect(await mail()).toBe('delivered')
    expect(world.delivered).toEqual([])
    expect(world.started).toHaveLength(1)
    // that session is the record's: working, it gets the next message; the owner's own never does
    const linked = world.started[0].sessionId
    world.session('mail', linked, true, true)
    world.now += MIN
    expect(await mail()).toBe('delivered')
    expect(world.delivered.map((d) => d.sessionId)).toEqual([linked])
    // a linked session that takes no message, beside the owner's own: a new one starts, never the owner's
    world.sessions[0].working = false
    world.states.set(linked, 'stopped')
    world.wait('mail', linked, 'question')
    world.outcomes.set(linked, 'unknown')
    world.now += MIN
    expect(await mail()).toBe('delivered')
    expect(world.delivered.map((d) => d.sessionId)).toEqual([linked, linked])
    expect(world.started).toHaveLength(2)
    expect(world.delivered.some((d) => d.sessionId === 's-own')).toBe(false)
  })

  it('a time still continues the owner\'s own session that waits on an answer, linked or not', async () => {
    world.task('daily', WEEKDAYS_8)
    world.session('daily', 's-own', false, false)
    world.wait('daily', 's-own', 'question')
    await firstSeenThen('2026-11-10T00:00:30Z')
    expect(world.delivered.map((d) => d.sessionId)).toEqual(['s-own'])
    expect(world.started).toEqual([])
  })

  it('asks for a retry without room, and drops the run that never happened', async () => {
    listen()
    world.room = false
    expect(await wake()).toBe('retry')
    expect(runs('mail')).toEqual([])
    world.room = true
    expect(await wake()).toBe('delivered')
    expect(runs('mail')[0].number).toBe(1)
  })

  it('asks for a retry while the record waits for the user\'s OK, is paused after failures, or the task\'s schedule is paused', async () => {
    listen({ pendingApproval: true })
    expect(await wake()).toBe('retry')
    listen({ pausedReason: '3 failed runs in a row' })
    expect(await wake()).toBe('retry')
    listen({}, { ...WEEKDAYS_8, paused: true })
    expect(await wake()).toBe('retry')
    expect(runner.held(world.store.get('mail')!)).toBe(true)
    expect(world.started).toEqual([])
    expect(runs('mail')).toEqual([])
    listen({}, WEEKDAYS_8)
    expect(await wake()).toBe('delivered')
    expect(runner.held(world.store.get('mail')!)).toBe(false)
  })

  it('refuses a message for a task that is closed or gone, and asks for a retry while the brain cannot say', async () => {
    listen()
    world.patch('mail', { status: 'resolved' })
    expect(await wake()).toBe('refused')
    world.tasks.delete('mail')
    expect(await wake()).toBe('refused')
    world.unreadable.add(null)
    expect(await wake()).toBe('retry')
    expect(runs('mail')).toEqual([])
  })

  it('answers retry when the session could not be started; the failure counts', async () => {
    listen()
    world.startProblem = 'no project'
    expect(await wake()).toBe('retry')
    expect(statuses('mail')).toEqual(['failed'])
    expect(world.store.get('mail')?.failures).toBe(1)
  })
})

describe('what the engine knows of a task', () => {
  it('names a task as its last read had it, and by its id before that', async () => {
    expect(runner.nameOf('11111111-2222')).toBe('task 11111111')
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    expect(runner.nameOf('daily')).toBe('Task daily')
  })

  it('holds a record for the bridge as soon as the owner pauses the schedule, and no longer once resumed', async () => {
    world.task('daily', WEEKDAYS_8)
    await runner.tick()
    const record = world.store.get('daily')!
    expect(runner.held(record)).toBe(false)
    runner.paused('daily')
    expect(runner.held(record)).toBe(true)
    runner.resumed('daily')
    expect(runner.held(record)).toBe(false)
  })
})
