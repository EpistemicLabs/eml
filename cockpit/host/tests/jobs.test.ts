import { describe, it, expect, beforeEach } from 'vitest'
import { EmlApiError } from '@engramprotocol/mcp-server'
import { JobStore } from '../src/job-store.js'
import { Jobs, type JobCaller } from '../src/application/jobs.js'
import { newRecord, type JobRun } from '../src/domain/job.js'
import type { ToolTask } from '../src/domain/schedule-tool.js'
import type { ScheduleFields } from '../src/domain/delegation.js'

const ZONE = 'Asia/Makassar' // UTC+8
const WEEKDAYS_8 = '0 8 * * 1-5'

/** A space's brain: its tasks, and what the tool's writes do to them. */
class Brain {
  tasks = new Map<string, ToolTask>()
  posts: Array<{ path: string; body: Record<string, unknown> }> = []
  down = false
  private made = 0

  constructor(private prefix: string) {}

  add(name: string, schedule?: ScheduleFields | null, more: Partial<ToolTask> = {}): ToolTask {
    this.made += 1
    const id = `${this.prefix}${String(this.made).padStart(7, '0')}-0000-4000-8000-000000000000`
    const task: ToolTask = {
      id, type: 'task', title: `kebab-${id}`, content: 'Text of the task.', status: 'active', scope: 'project.eml', ...more,
      properties: { display_title: name, assignee_ids: ['kim'], ...(schedule ? { delegation: { agent: 'atlas', checkpoint: 'after', schedule } } : {}), ...more.properties },
    }
    this.tasks.set(id, task)
    return task
  }

  schedule(id: string): ScheduleFields | null { return this.tasks.get(id)?.properties?.delegation?.schedule ?? null }

  async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
    if (this.down) throw new Error('the brain does not answer')
    if (path === '/list') {
      const all = [...this.tasks.values()].filter((task) => (!query?.status || task.status === query.status) && (!query?.title || task.title === query.title))
      return { engrams: structuredClone(all) }
    }
    const task = this.tasks.get(decodeURIComponent(path.slice('/engram/'.length)))
    if (!task) throw new EmlApiError(404, null, 'not found')
    return structuredClone(task)
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.down) throw new Error('the brain does not answer')
    this.posts.push({ path, body })
    if (path === '/engram/task') {
      const { title, display_title, content, scope, status, assignee_ids } = body as Record<string, never>
      const task = this.add(display_title, null, { title, content, scope, status })
      task.properties = { display_title, assignee_ids }
      return { id: task.id }
    }
    const task = this.tasks.get(decodeURIComponent(path.split('/')[2]))!
    if (typeof body.content === 'string') {
      if (!body.text) throw new EmlApiError(400, null, 'a content rewrite needs text')
      task.content = body.content
    }
    if (typeof body.goal === 'string') task.properties = { ...task.properties, goal: body.goal }
    if (body.delegation) task.properties = { ...task.properties, delegation: body.delegation as never }
    return {}
  }
}

class World {
  now = Date.parse('2026-11-09T00:00:00Z') // Monday 08:00 in Asia/Makassar
  store = new JobStore(null)
  main = new Brain('a')
  other = new Brain('b')
  ended: string[] = []
  engine: string[] = []
  runNow: JobRun | 'run_open' | 'task_working' | 'needs_approval' | 'no_project' = { number: 1 } as JobRun
  moving = new Set<string>()
  changed = 0
  agent: string | null = 'atlas'
}

const caller: JobCaller = { sessionId: 'maker', spaceId: null, projectId: 'bp-eml', toolProfile: null }
const elsewhere: JobCaller = { sessionId: 'other-caller', spaceId: 'space-b', projectId: 'bp-eml', toolProfile: null }

function setup(opts: { sharedSpaces?: string[] } = {}) {
  const world = new World()
  const jobs = new Jobs({
    store: world.store, now: () => world.now, me: 'kim',
    brain: (spaceId) => (spaceId === null ? world.main : spaceId === 'space-b' || spaceId === 'team' ? world.other : null),
    agent: () => world.agent,
    engine: {
      runNow: async (_space, task) => { world.engine.push(`run ${task.id}`); return world.runNow },
      paused: (id) => { world.engine.push(`paused ${id}`) },
      resumed: (id) => { world.engine.push(`resumed ${id}`) },
    },
    moving: (id) => world.moving.has(id),
    resolveProject: async (_space, input) => (input === 'eml' ? 'bp-eml' : input === 'folder' ? 'plain-folder' : null),
    projectName: (_space, id) => (id === 'bp-eml' ? 'EML' : id),
    providerKnown: (id) => id === 'claude',
    defaultTimeZone: () => ZONE,
    onGrantEnd: (record, tools) => { world.ended.push(`${record.id}:${tools.join(',')}`) },
    sharedSpace: (spaceId) => !!spaceId && (opts.sharedSpaces ?? []).includes(spaceId),
    changed: () => { world.changed += 1 },
  })
  return { world, jobs }
}

let world: World
let jobs: Jobs
beforeEach(() => { ({ world, jobs } = setup()) })

const act = (input: Record<string, unknown>, who: JobCaller = caller) => jobs.handle(who, input)
const create = (input: Record<string, unknown>, who: JobCaller = caller) => act({ action: 'create', prompt: 'Write the daily brief.', ...input }, who)

describe('create: a repeating time', () => {
  it('makes a task from name and prompt when the call names none, with the time on it', async () => {
    const answer = await create({ name: 'Daily brief', cron: WEEKDAYS_8 })
    expect(answer.status, answer.text).toBe(201)
    const task = world.main.tasks.get(answer.taskId!)!
    // The task as the routine-task creation makes it: the member's, in the caller's project, the prompt as its text.
    expect(task).toMatchObject({ content: 'Write the daily brief.', scope: 'project.eml', status: 'active', properties: { display_title: 'Daily brief', assignee_ids: ['kim'] } })
    expect(task.title).toMatch(/^routine-daily-brief-[0-9a-f]{8}$/)
    // Not delegated yet: the space's agent holds its schedule.
    expect(task.properties?.delegation).toEqual({ agent: 'atlas', schedule: { crons: [WEEKDAYS_8], time_zone: ZONE } })
    expect(answer.schedule).toEqual({ crons: [WEEKDAYS_8], time_zone: ZONE })
    // The prompt is the new task's text: nothing is appended to it.
    expect(world.main.posts.filter((p) => 'content' in p.body && p.path !== '/engram/task')).toEqual([])
    expect(world.store.get(task.id)).toMatchObject({ id: task.id, taskId: task.id, spaceId: null, createdBy: 'maker', cursor: null, notify: 'needs-me', toolProfile: null, projectId: null })
    expect(world.changed).toBe(1)
  })

  it('answers with the next runs in words', async () => {
    const answer = await create({ name: 'Daily brief', cron: WEEKDAYS_8 })
    expect(answer.text).toBe(`Made task "Daily brief" (${answer.taskId!.slice(0, 8)}) with its schedule.\n"Daily brief" (${answer.taskId!.slice(0, 8)}): cron "0 8 * * 1-5" (Asia/Makassar)\n  next: Tue 10 Nov 08:00, Wed 11 Nov 08:00, Thu 12 Nov 08:00`)
  })

  it('adds the time to a task that exists and says what it is for in the task\'s text, once', async () => {
    const task = world.main.add('Keep Acme happy')
    const answer = await create({ task_id: task.id, cron: WEEKDAYS_8, prompt: 'Look for new mail from Acme.' })
    expect(answer.status, answer.text).toBe(201)
    expect(answer.text).toMatch(/^Scheduled "Keep Acme happy" \(a0000001\)\./)
    expect(world.main.tasks.get(task.id)!.content).toBe('Text of the task.\n\nEvery 0 8 * * 1-5: Look for new mail from Acme.')
    // One write: the schedule, the text and the journal line that a rewrite of the text needs.
    expect(world.main.posts).toEqual([{ path: `/task/${task.id}/track`, body: {
      content: 'Text of the task.\n\nEvery 0 8 * * 1-5: Look for new mail from Acme.',
      delegation: { agent: 'atlas', schedule: { crons: [WEEKDAYS_8], time_zone: ZONE } },
      text: 'The schedule tool added the repeating time "0 8 * * 1-5". The schedule tool added what a time is for to the task\'s text.',
    } }])
    // The same call again adds nothing: no second time, no second paragraph.
    const again = await create({ task_id: task.id, cron: WEEKDAYS_8, prompt: 'Look for new mail from Acme.' })
    expect(again.text).toContain('The task already has that repeating time.')
    expect(world.main.posts).toHaveLength(1)
    // Another time joins the list, with its own paragraph.
    await create({ task_id: task.id, cron: '0 18 * * 1-5', prompt: 'Sum the day up.' })
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8, '0 18 * * 1-5'], time_zone: ZONE })
    expect(world.main.tasks.get(task.id)!.content).toBe('Text of the task.\n\nEvery 0 8 * * 1-5: Look for new mail from Acme.\n\nEvery 0 18 * * 1-5: Sum the day up.')
  })

  it('keeps the delegation of a task as it is, and its wake-up', async () => {
    const task = world.main.add('Mission', { at: '2026-11-13T02:00:00.000Z', why: 'Look again', by_session: 's9' })
    await create({ task_id: task.id, cron: WEEKDAYS_8 })
    expect(world.main.tasks.get(task.id)!.properties?.delegation).toEqual({
      agent: 'atlas', checkpoint: 'after', schedule: { crons: [WEEKDAYS_8], at: '2026-11-13T02:00:00.000Z', why: 'Look again', by_session: 's9', time_zone: ZONE },
    })
  })

  it('reads a task\'s repeating times in one zone: a cron written in another is refused, never joined at other hours', async () => {
    const task = world.main.add('Berlin routine', { crons: ['0 9 * * *'], time_zone: 'Europe/Berlin' })
    // Without a zone the cron is written in the user's (Asia/Makassar here), like every time a session gives the cockpit.
    for (const input of [{}, { timezone: 'Asia/Makassar' }]) {
      expect(await create({ task_id: task.id, cron: '0 18 * * *', ...input })).toMatchObject({
        status: 400, text: 'the task\'s repeating times are read in Europe/Berlin, and this cron was written in Asia/Makassar: write it in Europe/Berlin and pass timezone "Europe/Berlin"',
      })
    }
    const joined = await create({ task_id: task.id, cron: '0 18 * * *', timezone: 'Europe/Berlin' })
    expect(joined.schedule).toEqual({ crons: ['0 9 * * *', '0 18 * * *'], time_zone: 'Europe/Berlin' })
    expect(joined.text).toContain('(Europe/Berlin)')
    // The wake-up is an instant: it is read in the user's zone whatever zone the task's repeating times have, and shown in theirs.
    const woken = await create({ task_id: task.id, at: '2026-11-13T10:00' })
    expect(woken.schedule).toMatchObject({ at: '2026-11-13T02:00:00.000Z', time_zone: 'Europe/Berlin' })
    expect(woken.text).toContain('once, Fri 13 Nov 03:00 (Europe/Berlin)')
  })
})

describe('create: the wake-up', () => {
  const onTask = (task: ToolTask): JobCaller => ({ ...caller, taskId: task.id })

  it('sets the wake-up of the caller\'s own task for target self, with the prompt as its reason and the session that set it', async () => {
    const task = world.main.add('Refund', { crons: [WEEKDAYS_8], time_zone: ZONE })
    const answer = await create({ at: '2026-11-13T10:00', target: 'self', prompt: 'Check whether the refund arrived.' }, onTask(task))
    expect(answer.status, answer.text).toBe(201)
    expect(answer.taskId).toBe(task.id)
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8], at: '2026-11-13T02:00:00.000Z', why: 'Check whether the refund arrived.', by_session: 'maker', time_zone: ZONE })
    // A wake-up's prompt is its reason: the task's text stays.
    expect(world.main.tasks.get(task.id)!.content).toBe('Text of the task.')
    expect(answer.text).toContain('cron "0 8 * * 1-5" + once, Fri 13 Nov 10:00 (Asia/Makassar)')
    expect(answer.text).toContain('the wake-up continues the session that set it')
  })

  it('replaces the wake-up the task had and never touches a repeating time', async () => {
    const task = world.main.add('Refund', { crons: [WEEKDAYS_8], at: '2026-11-11T02:00:00.000Z', why: 'Old reason', by_session: 'someone', time_zone: ZONE })
    await create({ task_id: task.id, at: '2026-11-13T10:00', prompt: 'New reason.' })
    // Set from a session that does not work on the task: a new session starts for it.
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8], at: '2026-11-13T02:00:00.000Z', why: 'New reason.', time_zone: ZONE })
  })

  it('names the task with task_id before the caller\'s own; without either it makes one', async () => {
    const [own, named] = [world.main.add('Own task'), world.main.add('Named task')]
    expect((await create({ at: '2026-11-13T10:00', target: 'self', task_id: named.id }, onTask(own))).taskId).toBe(named.id)
    expect((await create({ at: '2026-11-13T10:00', task_id: named.id.slice(0, 8) }, onTask(own))).taskId).toBe(named.id)
    // The default target is a new session: without task_id the time gets a task of its own, also from a session that has one.
    const fresh = await create({ at: '2026-11-13T10:00', name: 'Check Acme reply' }, onTask(own))
    expect(fresh.status, fresh.text).toBe(201)
    expect(fresh.taskId).not.toBe(own.id)
    expect(world.main.schedule(own.id)).toBeNull()
    // Target self from a session without a task: a task is made too.
    expect((await create({ at: '2026-11-13T10:00', target: 'self' })).text).toMatch(/^name is required for a new task/)
    expect((await create({ at: '2026-11-13T10:00', target: 'self', name: 'Later' })).status).toBe(201)
  })
})

describe('create: what it refuses', () => {
  it('refuses schedules it cannot keep', async () => {
    const make = (input: Record<string, unknown>) => create({ name: 'x', ...input })
    expect((await make({})).text).toMatch(/exactly one of cron/)
    expect((await make({ cron: '0 8 * * *', at: '2026-11-10T08:00' })).text).toMatch(/exactly one of cron/)
    expect((await make({ cron: '*/5 * * * *' })).text).toMatch(/at most every 15 min/)
    expect((await make({ cron: 'daily' })).text).toMatch(/^cron: /)
    expect((await make({ at: '2026-11-08T08:00' })).text).toMatch(/has passed/)
    expect((await make({ at: '2028-01-01T08:00' })).text).toMatch(/a year ahead/)
    expect((await make({ cron: '0 8 * * *', timezone: 'Mars/Olympus' })).text).toMatch(/unknown time zone/)
    expect((await make({ cron: '0 8 * * *', project: 'nope' })).text).toMatch(/unknown project/)
    expect((await make({ cron: '0 8 * * *', provider: 'nope' })).text).toMatch(/unknown provider/)
    expect((await make({ cron: '0 8 * * *', notify: 'sometimes' })).text).toMatch(/notify must be/)
    expect((await make({ cron: '0 8 * * *', max_runs: 0 })).text).toMatch(/max_runs is a whole number from 1/)
    expect((await make({ cron: '0 8 * * *', ends_at: '2026-11-01T00:00' })).text).toBe('that schedule has no run before its end')
    expect((await make({ cron: '0 8 * * *', prompt: 'x'.repeat(2001) })).text).toMatch(/^prompt is required \(at most 2000 characters\)/)
    expect((await act({ action: 'create', name: 'x', cron: '0 8 * * *' })).text).toMatch(/^prompt is required/)
    expect((await make({ cron: '0 8 * * *', name: undefined })).text).toMatch(/^name is required for a new task/)
    expect((await act({ action: 'nonsense' })).text).toMatch(/^action must be one of create, list/)
    // Nothing was made on the way.
    expect(world.main.tasks.size).toBe(0)
    expect(world.store.list()).toEqual([])
  })

  it('refuses another session as the target: a schedule belongs to a task', async () => {
    for (const input of [{ target: 'session', session: 'eml-other' }, { session: 'eml-other' }]) {
      const answer = await create({ name: 'x', cron: '0 8 * * *', ...input })
      expect(answer.status).toBe(400)
      expect(answer.text).toBe('a schedule belongs to a task, not to a session: name the task instead (task_id); target self means the task this session works on')
    }
    expect((await create({ name: 'x', cron: '0 8 * * *', target: 'job-session' })).text).toBe('target must be worker or self')
  })

  it('refuses a task that is closed, one that is not there and a name a scheduled task already has', async () => {
    const closed = world.main.add('Done', null, { status: 'resolved' })
    expect((await create({ task_id: closed.id, cron: '0 8 * * *' })).text).toBe('"Done" is closed, and nothing fires on a closed task: reopen it or name another')
    expect(await create({ task_id: 'zzzzzzzz-0000-0000', cron: '0 8 * * *' })).toMatchObject({ status: 404, text: 'No task "zzzzzzzz-0000-0000" in this space. The list action shows the ones with a schedule.' })
    await create({ name: 'Daily brief', cron: WEEKDAYS_8 })
    expect((await create({ name: 'daily BRIEF', cron: '0 9 * * *' })).text).toBe('a task named "daily BRIEF" already has a schedule; pass its task_id to add a time to it, or pick another name')
  })

  it('makes no task where none can hold a schedule: a folder that is no project of the brain, a space without an agent', async () => {
    expect((await create({ name: 'x', cron: '0 8 * * *', project: 'folder' })).text).toBe('a new task needs a project of the brain: pass project, or put the time on a task that exists (task_id)')
    world.agent = null
    expect((await create({ name: 'x', cron: '0 8 * * *' })).text).toBe('this space has no agent to hold a schedule')
    expect(world.main.tasks.size).toBe(0)
  })

  it('waits while the task\'s jobs from before are still moving onto it', async () => {
    const task = world.main.add('Old routine', { crons: [WEEKDAYS_8], time_zone: ZONE })
    world.moving.add(task.id)
    for (const input of [{ action: 'create', task_id: task.id, cron: '0 18 * * *', prompt: 'p' }, { action: 'update', job: task.id, at: '2026-11-13T10:00' }, { action: 'pause', job: task.id }, { action: 'finish', job: task.id }]) {
      expect(await act(input), JSON.stringify(input)).toMatchObject({ status: 503, text: '"Old routine" still has jobs from before that are moving onto it; try again in a minute' })
    }
    expect(world.main.posts).toEqual([])
  })

  it('says so when the brain cannot be asked', async () => {
    world.main.down = true
    expect(await create({ name: 'x', cron: '0 8 * * *' })).toEqual({ status: 502, text: 'the task\'s schedule could not be read or written (the brain does not answer); try again' })
    expect(await act({ action: 'list' }, { ...caller, spaceId: 'gone' })).toMatchObject({ status: 503 })
  })
})

describe('create: the settings', () => {
  it('sets the task\'s goal when it has none, and keeps the one it has', async () => {
    const task = world.main.add('Refund')
    await create({ task_id: task.id, at: '2026-11-13T10:00', goal: 'Refund on the card' })
    expect(world.main.tasks.get(task.id)!.properties?.goal).toBe('Refund on the card')
    const kept = await create({ task_id: task.id, at: '2026-11-14T10:00', goal: 'Something else' })
    expect(world.main.tasks.get(task.id)!.properties?.goal).toBe('Refund on the card')
    expect(kept.text).toContain('The task keeps its goal ("Refund on the card").')
    expect(kept.text).toContain('  goal: Refund on the card')
    expect((await create({ task_id: task.id, at: '2026-11-14T10:00', goal: 'x'.repeat(501) })).text).toBe('goal: at most 500 characters')
  })

  it('puts the end at a time on the schedule, and the rest on this cockpit\'s record', async () => {
    const answer = await create({ name: 'Daily brief', cron: WEEKDAYS_8, ends_at: '2026-12-01T00:00', max_runs: 3, notify: 'always', provider: 'claude', project: 'eml' })
    expect(answer.schedule).toEqual({ crons: [WEEKDAYS_8], time_zone: ZONE, ends_at: '2026-11-30T16:00:00.000Z' })
    expect(answer.record).toMatchObject({ end: { afterRuns: 3 }, notify: 'always', provider: 'claude', projectId: 'bp-eml' })
    expect(answer.text).toContain('  ends: after 3 more runs, at Tue 1 Dec 00:00')
    expect(answer.text).toContain('  new sessions start in: EML')
  })

  it('counts an end after so many runs from now on a task that ran before', async () => {
    const task = world.main.add('Old routine', { crons: [WEEKDAYS_8], time_zone: ZONE })
    world.store.put({ ...newRecord({ id: task.id, spaceId: null }, '2026-11-01T00:00:00.000Z'), runCount: 7 })
    const answer = await act({ action: 'update', job: task.id, max_runs: 2 })
    expect(answer.record?.end).toEqual({ afterRuns: 9 })
    expect(answer.text).toContain('  ends: after 2 more runs')
    expect((await act({ action: 'update', job: task.id, max_runs: null })).record?.end).toBeNull()
  })

  it('starts the sessions of a task without a project of its own where its maker works', async () => {
    const task = world.main.add('Loose task', null, { scope: 'global' })
    expect((await create({ task_id: task.id, cron: WEEKDAYS_8 })).record?.projectId).toBe('bp-eml')
  })

  it('gives the task\'s sessions at most the maker\'s tools, and never widens a record that exists', async () => {
    const narrow: JobCaller = { ...caller, toolProfile: { deniedTools: ['Bash'], mcpServers: ['gmail'] } }
    const answer = await create({ name: 'x', cron: '0 8 * * *', deny_tools: ['WebFetch'] }, narrow)
    expect(answer.record!.toolProfile).toEqual({ deniedTools: ['Bash', 'WebFetch'], mcpServers: ['gmail'] })
    // A caller with every tool adds a time: the task's sessions keep what they had.
    const wide = await create({ task_id: answer.taskId, cron: '0 18 * * *' })
    expect(wide.record!.toolProfile).toEqual({ deniedTools: ['Bash', 'WebFetch'], mcpServers: ['gmail'] })
    expect((await create({ name: 'y', cron: '0 8 * * *', deny_tools: 'Bash' })).text).toBe('deny_tools is a list of tool names')
  })

  it('starts every task free: a session cannot limit it or lend it a tool', async () => {
    const answer = await create({ name: 'Brief', cron: '0 8 * * *', limited: true, grants: [{ tool: 'chrome', until: '2099-01-01T00:00:00Z' }] })
    expect(answer.record!.limited).toBeUndefined()
    expect(answer.record).not.toHaveProperty('grants')
    expect((await act({ action: 'update', job: answer.taskId, notify: 'never', limited: true, reply: { mail: 'send' } })).record).toMatchObject({ notify: 'never', reply: {} })
    expect(world.store.get(answer.taskId!)!.limited).toBeUndefined()
  })
})

describe('the limit per space', () => {
  it('takes 100 tasks with a schedule and refuses the 101st until one has ended; another space is not counted', async () => {
    for (let n = 1; n <= 99; n++) world.main.add(`Task ${n}`, { crons: ['0 8 * * *'], time_zone: ZONE })
    expect((await create({ name: 'Elsewhere', cron: '0 8 * * *' }, elsewhere)).status).toBe(201)
    for (let n = 1; n <= 5; n++) world.main.add(`Closed ${n}`, { crons: ['0 8 * * *'], time_zone: ZONE }, { status: 'resolved' })
    const hundredth = await create({ name: 'Task 100', cron: '0 8 * * *' })
    expect(hundredth.status, hundredth.text).toBe(201)
    const refused = await create({ name: 'Task 101', cron: '0 8 * * *' })
    expect(refused).toMatchObject({ status: 400, text: 'this space already has 100 tasks with a schedule; end one first (at most 100)' })
    // Nothing was made for the refused one.
    expect([...world.main.tasks.values()].some((task) => task.properties?.display_title === 'Task 101')).toBe(false)
    // A task without a schedule cannot get its first time either, by create or by update.
    const plain = world.main.add('Plain')
    expect((await create({ task_id: plain.id, at: '2026-11-13T10:00' })).status).toBe(400)
    expect((await act({ action: 'update', job: plain.id, at: '2026-11-13T10:00' })).status).toBe(400)
    // One that has a schedule takes another time: it is counted once.
    expect((await create({ task_id: hundredth.taskId, cron: '0 18 * * *' })).status).toBe(201)
    expect((await create({ task_id: hundredth.taskId, at: '2026-11-13T10:00' })).status).toBe(201)
    expect((await act({ action: 'finish', job: 'Task 1' })).status).toBe(200)
    expect((await create({ name: 'Task 101', cron: '0 8 * * *' })).status).toBe(201)
  })
})

describe('list and the job argument', () => {
  it('keeps the tasks in their space', async () => {
    const made = await create({ name: 'Main routine', cron: '0 8 * * *' })
    expect((await act({ action: 'list' }, elsewhere)).text).toBe('No task in this space has a schedule.')
    expect((await act({ action: 'delete', job: 'Main routine' }, elsewhere)).status).toBe(404)
    expect((await act({ action: 'delete', job: made.taskId }, elsewhere)).status).toBe(404)
    expect((await act({ action: 'list' })).text).toMatch(/^- "Main routine"/)
    expect(world.main.schedule(made.taskId!)).not.toBeNull()
  })

  it('lists the open tasks that have a schedule or listen on a channel, by name', async () => {
    world.main.add('Zebra', { crons: ['0 8 * * *'], time_zone: ZONE })
    world.main.add('No schedule')
    world.main.add('Closed', { crons: ['0 8 * * *'], time_zone: ZONE }, { status: 'resolved' })
    const mail = world.main.add('Acme mail')
    world.store.put({ ...newRecord({ id: mail.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'acme.example' }] }] })
    const text = (await act({ action: 'list' })).text
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      `- "Acme mail" (${mail.id.slice(0, 8)}): on mail from acme.example`,
      '- "Zebra" (a0000001): cron "0 8 * * *" (Asia/Makassar)',
    ])
  })

  it('takes the task\'s id, the first 8 characters of it, or its exact name', async () => {
    const task = world.main.add('Daily brief', { crons: [WEEKDAYS_8], time_zone: ZONE })
    for (const job of [task.id, task.id.slice(0, 8), 'daily brief']) {
      expect((await act({ action: 'pause', job })).status, job).toBe(200)
      expect((await act({ action: 'resume', job })).status, job).toBe(200)
    }
    expect((await act({ action: 'pause', job: 'Daily' })).status).toBe(404)
    expect((await act({ action: 'pause' })).text).toBe('job is required: the task\'s id (or its first 8 characters) or its exact name')
    world.main.add('Twin', { crons: ['0 8 * * *'], time_zone: ZONE })
    world.main.add('Twin', { crons: ['0 9 * * *'], time_zone: ZONE })
    expect((await act({ action: 'pause', job: 'Twin' })).text).toBe('"Twin" fits 2 tasks; use the id')
  })
})

describe('update', () => {
  it('replaces the repeating times with the one cron, and says what it is for when a prompt comes with it', async () => {
    const task = world.main.add('Daily brief', { crons: [WEEKDAYS_8, '0 18 * * 1-5'], at: '2026-11-13T02:00:00.000Z', why: 'Look again', time_zone: ZONE })
    const answer = await act({ action: 'update', job: 'Daily brief', cron: '30 8 * * 1-5', prompt: 'Write the brief half an hour later.' })
    expect(answer.status, answer.text).toBe(200)
    expect(world.main.schedule(task.id)).toEqual({ crons: ['30 8 * * 1-5'], at: '2026-11-13T02:00:00.000Z', why: 'Look again', time_zone: ZONE })
    expect(world.main.tasks.get(task.id)!.content).toBe('Text of the task.\n\nEvery 30 8 * * 1-5: Write the brief half an hour later.')
    expect(answer.text).toMatch(/^Updated the schedule of "Daily brief"\.\n"Daily brief" \(a0000001\): cron "30 8 \* \* 1-5" \+ once, Fri 13 Nov 10:00 \(Asia\/Makassar\)\n {2}next: Mon 9 Nov 08:30, Tue 10 Nov 08:30, Wed 11 Nov 08:30$/)
    expect((await act({ action: 'update', job: task.id, cron: '*/5 * * * *' })).text).toMatch(/at most every 15 min/)
  })

  it('replaces the wake-up; its reason stays unless a prompt gives a new one', async () => {
    const task = world.main.add('Refund', { crons: [WEEKDAYS_8], at: '2026-11-11T02:00:00.000Z', why: 'Check the card', by_session: 'someone', time_zone: ZONE })
    await act({ action: 'update', job: task.id, at: '2026-11-18T09:00' })
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8], at: '2026-11-18T01:00:00.000Z', why: 'Check the card', time_zone: ZONE })
    // From the session that works on the task: it is the one that continues.
    await act({ action: 'update', job: task.id, at: '2026-11-19T09:00', prompt: 'Ask the bank.' }, { ...caller, taskId: task.id })
    expect(world.main.schedule(task.id)).toMatchObject({ at: '2026-11-19T01:00:00.000Z', why: 'Ask the bank.', by_session: 'maker' })
    expect((await act({ action: 'update', job: task.id, at: '2026-11-08T09:00' })).text).toMatch(/has passed/)
  })

  it('gives a task that has no schedule its first time', async () => {
    const task = world.main.add('Plain')
    const answer = await act({ action: 'update', job: task.id, at: '2026-11-18T09:00' })
    expect(answer.status, answer.text).toBe(200)
    expect(world.main.tasks.get(task.id)!.properties?.delegation).toEqual({ agent: 'atlas', schedule: { at: '2026-11-18T01:00:00.000Z', time_zone: ZONE } })
    expect(world.store.get(task.id)).toMatchObject({ createdBy: 'maker' })
  })

  it('changes the zone, and sets and takes off the end', async () => {
    const task = world.main.add('Daily brief', { crons: [WEEKDAYS_8], time_zone: ZONE })
    await act({ action: 'update', job: task.id, timezone: 'Europe/Berlin', ends_at: '2026-12-01T00:00' })
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8], time_zone: 'Europe/Berlin', ends_at: '2026-11-30T23:00:00.000Z' })
    await act({ action: 'update', job: task.id, ends_at: '' })
    expect(world.main.schedule(task.id)).toEqual({ crons: [WEEKDAYS_8], time_zone: 'Europe/Berlin' })
    // A cron that replaces the list brings the zone it is written in: the user's, unless the call names one.
    await act({ action: 'update', job: task.id, cron: '0 7 * * *' })
    expect(world.main.schedule(task.id)).toEqual({ crons: ['0 7 * * *'], time_zone: ZONE })
    expect((await act({ action: 'update', job: world.main.add('Plain').id, ends_at: '2026-12-01T00:00' })).text).toBe('the task has no schedule to end at a time: give cron or at')
  })

  it('refuses what it cannot change, a prompt without a time and a call that changes nothing', async () => {
    const task = world.main.add('Daily brief', { crons: [WEEKDAYS_8], time_zone: ZONE })
    expect((await act({ action: 'update', job: task.id, name: 'Brief', target: 'self' })).text)
      .toBe('update cannot change name, target: a task is renamed with the brain\'s task tools, and a time for another task is a new create')
    expect((await act({ action: 'update', job: task.id, prompt: 'Do more.' })).text).toMatch(/^prompt goes with cron or at/)
    expect((await act({ action: 'update', job: task.id })).text).toMatch(/^nothing to update/)
    const closed = world.main.add('Done', { crons: [WEEKDAYS_8], time_zone: ZONE }, { status: 'resolved' })
    expect((await act({ action: 'update', job: closed.id, at: '2026-11-18T09:00' })).text).toBe('"Done" is closed, and nothing fires on a closed task')
    expect(world.main.posts).toEqual([])
  })

  it('changes a setting of the record without writing to the task', async () => {
    const task = world.main.add('Daily brief', { crons: [WEEKDAYS_8], time_zone: ZONE })
    const answer = await act({ action: 'update', job: task.id, notify: 'never' })
    expect(answer.record).toMatchObject({ notify: 'never' })
    expect(world.main.posts).toEqual([])
  })
})

describe('pause, resume, delete and finish', () => {
  it('pauses and resumes the task\'s whole schedule, and tells the engine', async () => {
    const task = world.main.add('Daily', { crons: ['0 8 * * *'], at: '2026-11-13T02:00:00.000Z', time_zone: ZONE })
    const paused = await act({ action: 'pause', job: 'daily' })
    expect(paused.schedule).toMatchObject({ paused: true, crons: ['0 8 * * *'], at: '2026-11-13T02:00:00.000Z' })
    expect(paused.text).toBe('Paused the schedule of "Daily".\n"Daily" (a0000001): cron "0 8 * * *" + once, Fri 13 Nov 10:00 (Asia/Makassar)\n  state: paused')
    expect(world.main.posts.at(-1)!.body.text).toBe('Its schedule was paused with the schedule tool.')
    world.now += 3 * 24 * 60 * 60_000
    const resumed = await act({ action: 'resume', job: 'Daily' })
    expect(resumed.schedule).toEqual({ crons: ['0 8 * * *'], at: '2026-11-13T02:00:00.000Z', time_zone: ZONE })
    // It goes on from now: the next run is the next one ahead.
    expect(resumed.text).toContain('  next: Fri 13 Nov 08:00, Fri 13 Nov 10:00, Sat 14 Nov 08:00')
    expect(world.engine).toEqual([`paused ${task.id}`, `resumed ${task.id}`])
  })

  it('refuses to pause or resume a task without a schedule; resume lifts a hold the cockpit set after failures', async () => {
    const plain = world.main.add('Plain')
    expect((await act({ action: 'pause', job: plain.id })).text).toBe('"Plain" has no schedule to pause')
    expect((await act({ action: 'resume', job: plain.id })).text).toBe('"Plain" has no schedule to resume')
    world.store.put({ ...newRecord({ id: plain.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [] }], pausedReason: 'run 3 failed' })
    expect((await act({ action: 'resume', job: plain.id })).status).toBe(200)
    expect(world.engine).toEqual([`resumed ${plain.id}`])
  })

  it('cannot resume past the user\'s OK: the record still waits for it', async () => {
    const task = world.main.add('Acme mail', { crons: ['0 8 * * *'], time_zone: ZONE, paused: true })
    world.store.put({ ...newRecord({ id: task.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [] }], pendingApproval: true })
    await act({ action: 'resume', job: task.id })
    expect(world.store.get(task.id)!.pendingApproval).toBe(true)
    world.runNow = 'needs_approval'
    expect((await act({ action: 'run_now', job: task.id })).text).toBe('"Acme mail" waits for the user\'s OK on the task first')
  })

  it.each(['delete', 'finish'])('%s ends the schedule: cleared on the task, which stays open', async (action) => {
    const task = world.main.add('Refund', { crons: [WEEKDAYS_8], at: '2026-11-13T02:00:00.000Z', by_session: 's1', time_zone: ZONE })
    const answer = await act({ action, job: 'Refund' })
    expect(answer).toMatchObject({ status: 200, schedule: null, text: 'Ended the schedule of "Refund": nothing wakes it any more. The task stays open; a new time (update with cron or at) brings its schedule back.' })
    // The delegation is written whole without its schedule; agent and checkpoint stay.
    expect(world.main.posts).toEqual([{ path: `/task/${task.id}/track`, body: {
      delegation: { agent: 'atlas', checkpoint: 'after' },
      text: 'Its schedule (0 8 * * 1-5 (Asia/Makassar), wake-up 2026-11-13T02:00:00.000Z) was ended with the schedule tool: nothing wakes it any more. The task stays open.',
    } }])
    expect(world.main.tasks.get(task.id)!.status).toBe('active')
    // Ending what has ended is safe, and a new time brings the schedule back.
    expect(await act({ action, job: task.id })).toMatchObject({ status: 200, text: '"Refund" has no schedule: nothing to end.' })
    expect((await act({ action: 'update', job: task.id, at: '2026-11-18T09:00' })).schedule).toMatchObject({ at: '2026-11-18T01:00:00.000Z' })
  })

  it('ends what this cockpit kept with it: the channel stops, lent tools go back, a run that had not started is skipped', async () => {
    const task = world.main.add('Returns', { crons: [WEEKDAYS_8], time_zone: ZONE })
    world.store.put({ ...newRecord({ id: task.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [] }], limited: true, grants: [{ tool: 'chrome', until: '2026-11-09T01:00:00.000Z', reason: null }] })
    world.store.addRun({ id: 'r1', jobId: task.id, trigger: 'schedule', number: 1, dueAt: '2026-11-09T00:00:00.000Z', createdAt: '2026-11-09T00:00:00.000Z', status: 'waiting', attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null })
    expect((await act({ action: 'finish', job: task.id })).status).toBe(200)
    expect(world.store.get(task.id)).toMatchObject({ triggers: [], grants: [], limited: true })
    expect(world.store.runs(task.id)[0]).toMatchObject({ status: 'skipped', note: 'its job was ended before it started' })
    expect(world.ended).toEqual([`${task.id}:chrome`])
  })

  it('ends a task that only listens on a channel, and writes nothing to a closed task', async () => {
    const mail = world.main.add('Acme mail')
    world.store.put({ ...newRecord({ id: mail.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [] }] })
    expect((await act({ action: 'delete', job: mail.id })).status).toBe(200)
    expect(world.store.get(mail.id)!.triggers).toEqual([])
    const closed = world.main.add('Done', { crons: [WEEKDAYS_8], time_zone: ZONE }, { status: 'resolved' })
    expect((await act({ action: 'finish', job: closed.id })).text).toBe('"Done" is closed: nothing fires on a closed task.')
    expect(world.main.posts).toEqual([])
  })
})

describe('run_now', () => {
  it('starts a run through the engine, and says why when it cannot', async () => {
    const task = world.main.add('Daily', { crons: ['0 8 * * *'], time_zone: ZONE })
    world.runNow = { number: 4 } as JobRun
    expect(await act({ action: 'run_now', job: 'Daily' })).toMatchObject({ status: 202, text: 'Run 4 of "Daily" starts as soon as there is room.' })
    expect(world.engine).toEqual([`run ${task.id}`])
    world.runNow = 'run_open'
    expect(await act({ action: 'run_now', job: 'Daily' })).toEqual({ status: 409, text: '"Daily" has a run still going; wait for it to finish.' })
    world.runNow = 'task_working'
    expect(await act({ action: 'run_now', job: 'Daily' })).toEqual({ status: 409, text: 'A session of "Daily" is working right now: nothing is started beside it.' })
    world.runNow = 'no_project'
    expect(await act({ action: 'run_now', job: 'Daily' })).toEqual({ status: 409, text: '"Daily" has no project to run in, so no session can start for it: move the task into a project first.' })
  })

  it('runs nothing on a task without a schedule or a channel, or on a closed one', async () => {
    expect((await act({ action: 'run_now', job: world.main.add('Plain').id })).text).toBe('"Plain" has no schedule to run')
    expect((await act({ action: 'run_now', job: world.main.add('Done', { crons: ['0 8 * * *'] }, { status: 'resolved' }).id })).text).toBe('"Done" is closed, and nothing fires on a closed task')
    expect(world.engine).toEqual([])
  })
})

describe('mail', () => {
  const createMail = (mail: unknown, extra: Record<string, unknown> = {}, who: JobCaller = caller) =>
    act({ action: 'create', name: 'Acme mail', prompt: 'Draft replies to Acme.', mail, ...extra }, who)

  it('makes a task that listens on mail, drafts, and waits for the user\'s OK', async () => {
    const answer = await createMail({ domains: ['Acme.example'], addresses: ['boss@partner.example'] })
    expect(answer.status, answer.text).toBe(201)
    expect(answer.schedule).toBeNull()
    expect(world.main.tasks.get(answer.taskId!)).toMatchObject({ content: 'Draft replies to Acme.', properties: { display_title: 'Acme mail' } })
    expect(answer.record).toMatchObject({
      pendingApproval: true, reply: { mail: 'draft' },
      triggers: [{ type: 'mail', match: [{ kind: 'address', address: 'boss@partner.example' }, { kind: 'domain', domain: 'acme.example' }] }],
    })
    expect(answer.text).toBe(`Made task "Acme mail" (${answer.taskId!.slice(0, 8)}) with its schedule.\n"Acme mail" (${answer.taskId!.slice(0, 8)}): on mail from boss@partner.example, acme.example\n  state: waiting for the user's OK on the task\nIt reacts to mail only after the user's OK on the task in the cockpit; until then mail for it waits. Replies are drafts the user approves.`)
    expect((await createMail({ domains: ['@acme.example'] }, { name: 'x' })).text).toMatch(/not a mail address or domain: @acme.example/)
  })

  it('says what the mail is for in the text of a task that existed, with or without a time', async () => {
    const task = world.main.add('Keep Acme happy')
    await createMail({ domains: ['acme.example'] }, { task_id: task.id, name: undefined })
    expect(world.main.tasks.get(task.id)!.content).toBe('Text of the task.\n\nOn mail: Draft replies to Acme.')
    expect(world.main.schedule(task.id)).toBeNull()
    const both = await createMail({ domains: ['acme.example'] }, { name: 'Acme watch', cron: WEEKDAYS_8 })
    expect(both.schedule).toEqual({ crons: [WEEKDAYS_8], time_zone: ZONE })
    expect(both.record!.triggers).toHaveLength(1)
  })

  it('asks for the OK again when addresses grow, not when they shrink', async () => {
    const made = await createMail({ domains: ['acme.example', 'acme.test'] })
    const { pendingApproval: _ok, ...approved } = world.store.get(made.taskId!)!
    world.store.put(approved)
    await act({ action: 'update', job: made.taskId, mail: { domains: ['acme.example'] } })
    expect(world.store.get(made.taskId!)!.pendingApproval).toBeUndefined()
    const grown = await act({ action: 'update', job: made.taskId, mail: { domains: ['acme.example', 'other.example'] } })
    expect(grown.record!.pendingApproval).toBe(true)
    expect(grown.text).toContain('It reacts to mail only after the user\'s OK on the task in the cockpit')
  })

  it('keeps mail out of a shared space: none there, and none by adding mail later; schedules still work', async () => {
    ({ world, jobs } = setup({ sharedSpaces: ['team'] }))
    const member: JobCaller = { ...caller, spaceId: 'team' }
    const refused = await createMail({ domains: ['acme.example'] }, {}, member)
    expect(refused).toMatchObject({ status: 400, text: 'a task in a shared space cannot watch mail for now; schedules work there, mail only in a local space' })
    const routine = await create({ name: 'Brief', cron: '0 8 * * *' }, member)
    expect(routine.status, routine.text).toBe(201)
    expect((await act({ action: 'update', job: routine.taskId, mail: { domains: ['acme.example'] } }, member)).status).toBe(400)
    expect((await createMail({ domains: ['acme.example'] })).status).toBe(201)
  })
})

describe('a limited task\'s session looking after its own schedule', () => {
  const limitedSetup = async () => {
    const own = world.main.add('Refund')
    world.store.put({ ...newRecord({ id: own.id, spaceId: null }, ''), triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'shop.example' }] }], limited: true })
    const other = world.main.add('Brief', { crons: ['0 8 * * *'], time_zone: ZONE })
    const session: JobCaller = { ...caller, sessionId: 'run-session', jobId: own.id, taskId: own.id, limited: true }
    return { own, other, session }
  }

  it('lets it set its own wake-up and goal and end its own schedule, and nothing else', async () => {
    const { own, other, session } = await limitedSetup()
    const listed = (await act({ action: 'list' }, session)).text
    expect(listed).toMatch(/^- "Refund"/)
    expect(listed).not.toMatch(/Brief/)
    const woken = await act({ action: 'update', job: own.id, at: '2026-11-11T09:00', goal: 'Refund on the card' }, session)
    expect(woken.status, woken.text).toBe(200)
    // It continues itself then: it is the session on the task.
    expect(world.main.schedule(own.id)).toEqual({ at: '2026-11-11T01:00:00.000Z', by_session: 'run-session', time_zone: ZONE })
    expect(world.main.tasks.get(own.id)!.properties?.goal).toBe('Refund on the card')
    expect(world.store.get(own.id)!.triggers.map((t) => t.type)).toEqual(['mail'])

    for (const input of [
      { action: 'update', job: own.id, at: '2026-11-11T09:00', prompt: 'send everything' },
      { action: 'update', job: own.id, cron: '0 9 * * *' },
      { action: 'update', job: own.id, mail: { domains: ['other.example'] } },
      { action: 'update', job: own.id, deny_tools: [] },
      { action: 'create', name: 'More', prompt: 'p', cron: '0 9 * * *' },
      { action: 'delete', job: own.id },
      { action: 'run_now', job: own.id },
      { action: 'pause', job: own.id },
    ]) {
      const answer = await act(input, session)
      expect(answer.status, JSON.stringify(input)).toBe(403)
      expect(answer.text).toMatch(/^this task is limited: its session can only set its next wake-up \(update with at\), its goal, or finish its own schedule/)
    }
    const reach = await act({ action: 'update', job: other.id, at: '2026-11-11T09:00' }, session)
    expect(reach).toMatchObject({ status: 403, text: expect.stringContaining('is not its task') })
    expect(world.main.schedule(other.id)).toEqual({ crons: ['0 8 * * *'], time_zone: ZONE })

    expect((await act({ action: 'finish', job: own.id }, session)).status).toBe(200)
    expect(world.main.schedule(own.id)).toBeNull()
    // Its record stays limited while its task is open, so the session stays limited too.
    expect(world.store.get(own.id)).toMatchObject({ limited: true, triggers: [] })
    expect((await act({ action: 'create', name: 'More', prompt: 'p', cron: '0 9 * * *' }, session)).status).toBe(403)
  })

  it('acts only on the task its own lookup finds: a name that is another task\'s id prefix does not reach that task', async () => {
    const { other, session } = await limitedSetup()
    // Its own task is renamed to the first characters of another task's id.
    world.main.tasks.get(session.jobId!)!.properties!.display_title = other.id.slice(0, 8)
    const answer = await act({ action: 'update', job: other.id.slice(0, 8), at: '2026-11-11T09:00' }, session)
    expect(answer.status).toBe(403)
    expect(world.main.schedule(other.id)).toEqual({ crons: ['0 8 * * *'], time_zone: ZONE })
  })

  it('refuses everything to a session whose task is closed or gone', async () => {
    const { own, session } = await limitedSetup()
    world.main.tasks.get(own.id)!.status = 'resolved'
    for (const who of [session, { ...session, jobId: 'deleted-task' }]) {
      const answer = await act({ action: 'create', name: 'Escape', prompt: 'p', cron: '0 9 * * *' }, who)
      expect(answer).toEqual({ status: 403, text: 'this session\'s task is closed or gone' })
      expect((await act({ action: 'list' }, who)).status).toBe(403)
    }
  })

  it('does not hold a free session to its task because its record went: an open task without a record was not limited', async () => {
    // A wake-up fired and was cleared, the run ended, the record went (domain/job.ts recordKeeping): the host then
    // reads the session as limited (sessionJobFacts fails closed), and the tool looks the task up.
    const task = world.main.add('Mission')
    const session: JobCaller = { ...caller, sessionId: 'run-session', jobId: task.id, taskId: task.id, limited: true }
    expect((await act({ action: 'list' }, session)).status).toBe(200)
    expect((await act({ action: 'create', target: 'self', at: '2026-11-13T10:00', prompt: 'Look again.' }, session)).status).toBe(201)
    expect((await act({ action: 'create', name: 'Another', prompt: 'p', cron: '0 9 * * *' }, session)).status).toBe(201)
  })
})
