import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmlApiError } from '@engramprotocol/mcp-server'
import { createJobMigration } from '../src/application/job-migration.js'
import { JobStore } from '../src/job-store.js'

const NOW = Date.parse('2026-11-26T10:00:00.000Z')
const AHEAD = '2026-11-27T02:00:00.000Z'
type Task = { id: string; type: string; status: string; title: string; content: string; properties: Record<string, unknown> }

const v1 = (id: string, patch: Record<string, unknown> = {}) => ({
  id, name: 'Daily brief', kind: 'routine', spaceId: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', taskId: 't1',
  prompt: 'Write the brief.', target: { type: 'worker', projectId: 'bp-ops' }, triggers: [{ type: 'schedule', cron: '0 8 * * 1-5', timeZone: 'UTC' }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: '2026-11-27T08:00:00.000Z', runCount: 1, failures: 0, ...patch,
})
const openRun = (jobId: string) => ({ id: `run-${jobId}`, jobId, trigger: 'schedule', number: 1, dueAt: '2026-11-26T08:00:00.000Z', createdAt: '2026-11-26T08:00:00.000Z', status: 'started', attempts: 1, nextAttemptAt: null, sessionId: 's1', startedAt: '2026-11-26T08:00:05.000Z', finishedAt: null, outcome: null, note: null })
const task = (id: string, properties: Record<string, unknown> = {}, status = 'active'): Task => ({ id, type: 'task', status, title: id, content: 'Keep the customer informed.', properties: { assignee_ids: ['lasse'], ...properties } })

function world(jobs: Array<Record<string, unknown>>, tasks: Task[], opts: { runs?: Record<string, unknown[]>; failOn?: string[]; down?: string[]; noBrain?: string[]; team?: boolean | null; members?: string[] | null } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-migration-')), 'jobs.json')
  const original = JSON.stringify({ version: 1, timeZone: 'UTC', jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), runs: opts.runs ?? {}, keys: {} })
  writeFileSync(file, original)
  const store = new JobStore(file)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ space: string; path: string; body: Record<string, unknown> }> = []
  const brainOf = (space: string) => ({
    async get(path: string, query?: Record<string, unknown>) {
      if (opts.down?.includes(space)) throw new Error('connect ECONNREFUSED')
      if (path === '/list' && query?.title === undefined) return { engrams: structuredClone([...byId.values()].filter((t) => t.status === query?.status)) }
      if (path === '/list') return { engrams: [...byId.values()].filter((t) => t.title === query?.title) }
      if (path === '/object/user') {
        if (opts.members === null) throw new Error('the users did not come')
        return { objects: (opts.members ?? ['lasse', 'dominik']).map((id) => ({ id })) }
      }
      const found = byId.get(decodeURIComponent(path.slice('/engram/'.length)))
      if (!found) throw new EmlApiError(404, { error: 'NOT_FOUND' }, 'not found')
      return structuredClone(found)
    },
    async post(path: string, body: Record<string, unknown>) {
      if (path === '/engram/task') {
        const made: Task = { id: `made-${byId.size}`, type: 'task', status: 'active', title: body.title as string, content: body.content as string, properties: { assignee_ids: body.assignee_ids } }
        byId.set(made.id, made)
        posts.push({ space, path, body })
        return made
      }
      const id = decodeURIComponent(/^\/task\/([^/]+)\/track$/.exec(path)![1])
      if (opts.failOn?.includes(id)) throw new Error('Invalid engram: delegation.schedule has an unknown key')
      // as the brain does (packages/core): a rewrite of the text needs a journal line
      if (body.content !== undefined && !body.text) throw new Error('Invalid engram: a content rewrite needs text')
      posts.push({ space, path, body })
      const t = byId.get(id)!
      for (const [k, v] of Object.entries(body)) {
        if (k === 'text') continue
        if (k === 'content') t.content = v as string
        else t.properties[k] = v
      }
      return t
    },
  })
  const moved: Array<[string, string]> = []
  const logs: string[] = []
  // The main space is local; the second one is local too unless a test says shared (true) or not known yet (null).
  const spaces = [{ id: 'main-id', name: 'Main', main: true, agent: 'atlas', shared: false }, { id: 'space-2', name: 'Team', main: false, agent: 'motti', shared: opts.team === undefined ? false : opts.team }]
  /** What the brain server says of the team space when it is asked again; the calls are counted. */
  const kind = { answer: null as boolean | null, asked: 0 }
  /** The channel bridge: whether it runs, and the renames it was asked for. */
  const bridge = { answer: 'renamed' as 'renamed' | 'off' | 'failed', asked: [] as Array<[string, string]> }
  const saved: string[] = []
  const notices: Array<Record<string, unknown>> = []
  const deps = {
    renameInBridge: async (from: string, to: string) => { bridge.asked.push([from, to]); return bridge.answer },
    saveReport: (markdown: string) => { saved.push(markdown); return '/home/someone/.eml-cockpit/jobs-migration-report.md' },
    notify: (input: Record<string, unknown>) => { notices.push(input) },
    spaceKind: async (space: { shared: boolean | null }) => { kind.asked += 1; return space.shared ?? kind.answer },
    store, spaces: () => spaces as never, brain: (space: { id: string }) => (opts.noBrain?.includes(space.id) ? null : brainOf(space.id)),
    me: 'lasse', moveSessions: (from: string, to: string) => { moved.push([from, to]) }, now: () => NOW, log: (line: string) => logs.push(line),
  }
  return { file, original, store, byId, posts, moved, logs, opts, kind, spaces, saved, notices, bridge, migration: createJobMigration(deps as never), restart: () => createJobMigration({ ...deps, store: new JobStore(file) } as never) }
}

describe('the migration of jobs.json to schedules on tasks', () => {
  it('writes each task in one brain call with everything else of its delegation unchanged, then the record, and moves the jobs\' sessions to it', async () => {
    const delegation = { agent: 'motti', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } }
    const w = world(
      [v1('j1', { notify: 'always' }), v1('j2', { triggers: [{ type: 'schedule', at: AHEAD, timeZone: 'UTC' }], prompt: 'Look again.', target: { type: 'session', sessionId: 'sess-1' }, runCount: 0 })],
      [task('t1', { delegation })], { runs: { j1: [openRun('j1')] } },
    )
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, dropped: 0, left: 0, failed: [] })
    expect(result.reports[0]).toContain('# Schedules onto tasks — run')
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/t1/track', body: {
      content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.',
      delegation: { agent: 'motti', checkpoint: 'after', requested_at: '2026-11-20T00:00:00.000Z', schedule: { crons: ['0 8 * * 1-5'], at: AHEAD, why: 'Look again.', by_session: 'sess-1', time_zone: 'UTC' } },
      // a rewrite of the task's text never goes without a journal line: the brain refuses it
      text: 'Schedules moved onto tasks: what its repeating job did was added to the task\'s text, as "Every <cron>: …".',
    } }])
    expect(w.store.list()).toMatchObject([{ id: 't1', taskId: 't1', spaceId: null, notify: 'always', projectId: 'bp-ops', cursor: '2026-11-26T10:00:00.000Z', firedWake: null, runCount: 1 }])
    expect(w.store.runs('t1')).toMatchObject([{ id: 'run-j1', jobId: 't1', status: 'started' }])
    expect(w.moved).toEqual([['j1', 't1'], ['j2', 't1']])
    expect(w.store.pendingV1()).toBeNull()
    // the version 1 file is kept next to the new one, as it was
    expect(readFileSync(`${w.file}.v1-backup`, 'utf8')).toBe(w.original)
    expect(JSON.parse(readFileSync(w.file, 'utf8'))).toMatchObject({ version: 2, timeZone: 'UTC' })
  })

  it('run twice it changes nothing the second time: in the same process, and after a restart', async () => {
    const w = world([v1('j1'), v1('j9', { taskId: 'closed' })], [task('t1'), task('closed', {}, 'resolved')])
    await w.migration.run()
    const posts = w.posts.length
    const file = readFileSync(w.file, 'utf8')
    expect(await w.migration.run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, leftovers: 0, reportFile: null, unlooked: 0 })
    expect(await w.restart().run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, leftovers: 0, reportFile: null, unlooked: 0 })
    expect(w.posts).toHaveLength(posts)
    expect(readFileSync(w.file, 'utf8')).toBe(file)
    expect(w.moved).toEqual([['j1', 't1']])
  })

  it('a pass under way is joined, not doubled: two calls write each task once and answer the same', async () => {
    const w = world([v1('j1'), v1('j2', { taskId: 't2' })], [task('t1'), task('t2')])
    const first = w.migration.run()
    const second = w.migration.run()
    expect(second).toBe(first)
    expect(await second).toMatchObject({ moved: 2, failed: [] })
    expect(w.posts.map((p) => p.path)).toEqual(['/task/t1/track', '/task/t2/track'])
    expect(w.moved).toEqual([['j1', 't1'], ['j2', 't2']])
    expect(w.saved).toHaveLength(1)
    // once it is over, a new call is a pass of its own
    const next = w.migration.run()
    expect(next).not.toBe(first)
    await next
  })

  it('a task without a delegation gets one for the space\'s agent with its schedule', async () => {
    const w = world([v1('j1')], [task('t1')])
    await w.migration.run()
    expect(w.posts[0].body.delegation).toEqual({ agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } })
  })

  it('a journal line without a change of the schedule is posted on its own: the text, and no delegation', async () => {
    // The task has its job's time and says what it is for already; its second job ran in another zone and is left out.
    const has = task('t1', { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } } })
    has.content = 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.'
    const w = world([v1('j1'), v1('j2', { name: 'Tokyo brief', createdAt: '2026-11-02T00:00:00.000Z', triggers: [{ type: 'schedule', cron: '0 9 * * *', timeZone: 'Asia/Tokyo' }] })], [has])
    expect(await w.migration.run()).toMatchObject({ moved: 1, failed: [] })
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/t1/track', body: { text: expect.stringContaining('The routine "Tokyo brief" NO LONGER FIRES') } }])
    expect(w.byId.get('t1')!.properties.delegation).toEqual({ agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } })
  })

  it('a task that has the schedule already gets only the text of what its time is for, with the journal line the brain asks for', async () => {
    const w = world([v1('j1')], [task('t1', { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } } })])
    expect(await w.migration.run()).toMatchObject({ moved: 1, failed: [] })
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/t1/track', body: {
      content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.',
      text: 'Schedules moved onto tasks: what its repeating job did was added to the task\'s text, as "Every <cron>: …".',
    } }])
    expect(w.store.get('t1')).toMatchObject({ id: 't1' })
  })

  it('a task whose write fails keeps its jobs for the next start; the others move', async () => {
    const w = world([v1('j1'), v1('j2', { taskId: 't2' })], [task('t1'), task('t2')], { failOn: ['t1'] })
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, failed: ['Main: "t1": Invalid engram: delegation.schedule has an unknown key'] })
    // what failed is said to the user by name, and in the log by id
    expect(w.logs).toContain('[jobs] migration: space main: task t1: Invalid engram: delegation.schedule has an unknown key')
    expect(Object.keys(w.store.pendingV1()!.jobs)).toEqual(['j1'])
    expect(w.store.list().map((r) => r.id)).toEqual(['t2'])
    expect(w.moved).toEqual([['j2', 't2']])
    // the next start, with the brain taking the write: the rest moves
    w.opts.failOn = []
    expect(await w.restart().run()).toMatchObject({ moved: 1, failed: [] })
    expect(new JobStore(w.file).pendingV1()).toBeNull()
  })

  it('a crash between a task\'s brain write and its record: the next start finds the schedule and the text as they should be and writes neither again', async () => {
    const w = world([v1('j1')], [task('t1')])
    const first = createJobMigration({
      store: { pendingV1: () => w.store.pendingV1(), migrateV1: () => { throw new Error('host stopped') } }, spaces: () => [{ id: 'main-id', name: 'Main', main: true, agent: 'atlas', shared: false }] as never,
      brain: () => ({ get: async (path: string) => structuredClone(w.byId.get(path.slice('/engram/'.length))!), post: async (_p: string, body: Record<string, unknown>) => { w.posts.push({ space: 'main-id', path: _p, body }); const t = w.byId.get('t1')!; t.content = body.content as string; t.properties.delegation = body.delegation; return t } }),
      me: 'lasse', moveSessions: () => {}, now: () => NOW, log: () => {},
    } as never)
    expect((await first.run()).failed).toEqual(['Main: "t1": host stopped'])
    expect(w.posts).toHaveLength(1)
    expect(await w.restart().run()).toMatchObject({ moved: 1, failed: [] })
    expect(w.posts).toHaveLength(1)
    expect(new JobStore(w.file).get('t1')).toMatchObject({ id: 't1' })
  })

  it('goes space by space: a space whose brain does not answer, or that has none, keeps its jobs; a job of a space that is gone stays', async () => {
    const jobs = [v1('j1'), v1('j2', { spaceId: 'space-2', taskId: 't2' }), v1('j3', { spaceId: 'space-gone', taskId: 't3' })]
    const w = world(jobs, [task('t1'), task('t2')], { down: ['space-2'] })
    const result = await w.migration.run()
    expect(result.moved).toBe(1)
    expect(result.failed).toEqual(['Team: its brain did not answer (connect ECONNREFUSED), its 1 job(s) wait', '1 job(s) of a space this cockpit no longer has stay as they are'])
    expect(Object.keys(w.store.pendingV1()!.jobs)).toEqual(['j2', 'j3'])
    w.opts.down = []
    w.opts.noBrain = ['space-2']
    expect((await w.restart().run()).failed[0]).toBe('Team: no brain to ask, its 1 job(s) wait')
    w.opts.noBrain = []
    const last = await w.restart().run()
    expect(last.moved).toBe(1)
    expect(w.posts.at(-1)).toMatchObject({ space: 'space-2', path: '/task/t2/track', body: { delegation: { agent: 'motti' } } })
    expect(new JobStore(w.file).get('t2')).toMatchObject({ spaceId: 'space-2' })
    expect(Object.keys(new JobStore(w.file).pendingV1()!.jobs)).toEqual(['j3'])
  })

  it('drops the jobs of a closed task and a gone one; only the closed one is written to', async () => {
    const w = world(
      [v1('j1', { taskId: 'closed' }), v1('j2', { taskId: 'gone' })],
      [task('closed', { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'] } } }, 'resolved')], { runs: { j2: [openRun('j2')] } },
    )
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 0, dropped: 2, failed: [] })
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/closed/track', body: { delegation: { agent: 'atlas' }, text: expect.stringContaining('the task is closed') } }])
    expect(w.store.list()).toEqual([])
    expect(w.moved).toEqual([])
    // its runs stay as history under the job's id, none of them open
    expect(w.store.runs('j2')).toMatchObject([{ id: 'run-j2', status: 'finished', note: 'its job ended when schedules moved onto tasks' }])
    expect(w.store.pendingV1()).toBeNull()
  })

  it('in a shared space a job on another member\'s task is written onto that task for the owner\'s cockpit, and no record stays here', async () => {
    const theirs = task('theirs', { assignee_ids: ['dominik'], delegation: { agent: 'motti', checkpoint: 'after', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } })
    const w = world(
      [v1('j1', { spaceId: 'space-2', taskId: 'theirs', limited: true }), v1('j2', { spaceId: 'space-2', taskId: 'agents' }), v1('j3', { spaceId: 'space-2', taskId: 'mine' })],
      [theirs, { ...task('agents', { assignee_ids: [] }), ingested_by: 'atlas' } as never, task('mine')], { team: true, runs: { j1: [openRun('j1')] } },
    )
    // The fake brain is one for every space: only the team space is this cockpit's here, so its tasks are not looked through as the main space's.
    w.spaces.shift()
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 3, dropped: 0, left: 0, failed: [] })
    // the owner's own time stays, mine joins it; the delegation is carried whole
    expect(w.posts[0]).toEqual({ space: 'space-2', path: '/task/theirs/track', body: {
      content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.',
      delegation: { agent: 'motti', checkpoint: 'after', schedule: { crons: ['0 7 * * *', '0 8 * * 1-5'], time_zone: 'UTC' } },
      text: expect.stringContaining('the cockpit of the task\'s owner (dominik) fires them from here on. What lasse\'s cockpit kept for the job did not move: the limit on its sessions.'),
    } })
    // a record for my task and for the one no member owns, none for the other member's
    expect(w.store.list().map((r) => r.id).sort()).toEqual(['agents', 'mine'])
    expect(w.moved).toEqual([['j2', 'agents'], ['j3', 'mine']])
    expect(w.store.runs('j1')).toMatchObject([{ status: 'finished', note: 'its job ended when schedules moved onto tasks' }])
    expect(result.reports[0]).toContain('nothing is kept on this machine: dominik\'s cockpit fires the task')
    expect(w.store.pendingV1()).toBeNull()
  })

  it('plans nothing for a space the brain server has not said the kind of: its jobs wait, and the next pass asks again', async () => {
    const w = world([v1('j1'), v1('j2', { spaceId: 'space-2', taskId: 't2' })], [task('t1'), task('t2', { assignee_ids: [] })], { team: null })
    const first = await w.migration.run()
    expect(first).toMatchObject({ moved: 1, dropped: 0, left: 0 })
    expect(first.failed).toEqual(['Team: the brain server has not said yet whether it is shared, its 1 job(s) wait'])
    expect(first.reports).toHaveLength(1)
    expect(w.posts.map((p) => p.space)).toEqual(['main-id'])
    expect(Object.keys(w.store.pendingV1()!.jobs)).toEqual(['j2'])
    expect(w.kind.asked).toBeGreaterThan(0)
    // the brain server answers: local, so the task is this member's
    w.kind.answer = false
    expect(await w.migration.run()).toMatchObject({ moved: 1, failed: [] })
    expect(w.store.get('t2')).toMatchObject({ spaceId: 'space-2' })
    expect(w.store.pendingV1()).toBeNull()
  })

  it('a task whose owner cannot be told because the members did not come waits; the others of the space move', async () => {
    const w = world(
      [v1('j1', { spaceId: 'space-2', taskId: 'agents' }), v1('j2', { spaceId: 'space-2', taskId: 'mine' })],
      [{ ...task('agents', { assignee_ids: [] }), ingested_by: 'atlas' } as never, task('mine')], { team: true, members: null },
    )
    expect(await w.migration.run()).toMatchObject({ moved: 1, left: 1 })
    expect(Object.keys(w.store.pendingV1()!.jobs)).toEqual(['j1'])
    expect(w.store.list().map((r) => r.id)).toEqual(['mine'])
  })

  it('makes a task for a job without one, once, and gives it the schedule and the record', async () => {
    const w = world([v1('job-12345678-loose', { taskId: null })], [])
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, failed: [] })
    expect(w.posts[0]).toMatchObject({ path: '/engram/task', body: { title: 'routine-daily-brief-job-1234', display_title: 'Daily brief', content: 'Write the brief.', scope: 'project.ops', assignee_ids: ['lasse'] } })
    expect(w.posts[1]).toEqual({ space: 'main-id', path: '/task/made-0/track', body: { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } } } })
    expect(w.store.get('made-0')).toMatchObject({ id: 'made-0', taskId: 'made-0', projectId: 'bp-ops' })
    expect(w.moved).toEqual([['job-12345678-loose', 'made-0']])
  })

  it('leaves a job it cannot place where it is, and says so at every start', async () => {
    const w = world([v1('j1', { taskId: null, target: { type: 'session', sessionId: 's1' } })], [])
    expect(await w.migration.run()).toMatchObject({ moved: 0, left: 1, failed: [] })
    expect(Object.keys(w.store.pendingV1()!.jobs)).toEqual(['j1'])
    // the log names the job by its id; its name is for the report
    expect(w.logs).toContain('[jobs] migration, space main: job j1 left as it is: it has no task and no project of the brain to make one in: it stays as it is, nothing fires it')
    expect(w.logs.filter((l) => l.includes('Daily brief') || l.includes('Main'))).toEqual([])
  })

  it('a home without version 1 jobs has nothing to do', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-migration-')), 'jobs.json')
    const migration = createJobMigration({ store: new JobStore(file), spaces: () => { throw new Error('not asked') }, brain: () => null, me: 'lasse', moveSessions: () => {}, now: () => NOW, log: () => {} })
    expect(await migration.run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, leftovers: 0, reportFile: null, unlooked: 0 })
    expect(existsSync(file)).toBe(false)
  })
})

describe('a schedule the old mirror left on a task without a job', () => {
  const stale = { delegation: { agent: 'atlas', checkpoint: 'after', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } }

  it('is removed in the first pass of its space, before the jobs move, with a journal line; a second pass looks for none', async () => {
    const w = world([v1('j1')], [task('t1'), task('left', stale), task('kept', stale)])
    // someone set this one's schedule here since the update: its record says so
    w.store.put({ id: 'kept', spaceId: null, taskId: 'kept', runCount: 0 } as never)
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, leftovers: 1, failed: [] })
    expect(w.posts[0]).toEqual({ space: 'main-id', path: '/task/left/track', body: {
      delegation: { agent: 'atlas', checkpoint: 'after' },
      text: 'A schedule without a job was left on this task (0 7 * * * (UTC)) from before schedules moved onto tasks. Nothing ran it then, so it is removed and nothing starts to run it now. Set a new time if the task should run at one.',
    } })
    expect(w.byId.get('kept')!.properties.delegation).toEqual(stale.delegation)
    expect(result.reports[0]).toContain('- A schedule without a job was left on this task (0 7 * * * (UTC)); removed.')
    expect(w.store.leftoversChecked(null)).toBe(true)
    expect(w.notices.map((n) => n.body)).toEqual(['Schedules moved onto their tasks: 1 moved, 0 not moved, 1 schedule without a job removed — see /home/someone/.eml-cockpit/jobs-migration-report.md'])
  })

  it('once a space was looked through, a schedule set on a jobless task later is never taken for a leftover, also while a job of the space still waits', async () => {
    // j9 can never move (no task, no project): the space is planned again at every pass
    const w = world([v1('j1'), v1('j9', { taskId: null, target: { type: 'session', sessionId: 's1' } })], [task('t1'), task('later')])
    await w.migration.run()
    expect(w.store.leftoversChecked(null)).toBe(true)
    // a schedule written to the brain directly, after the space was looked through: no record, no job
    w.byId.get('later')!.properties.delegation = structuredClone(stale.delegation)
    const again = await w.restart().run()
    expect(again).toMatchObject({ leftovers: 0, left: 1 })
    expect(w.byId.get('later')!.properties.delegation).toEqual(stale.delegation)
  })

  it('a removal the brain refuses is said and tried again at the next pass: the space is not marked as looked through', async () => {
    const w = world([v1('j1')], [task('t1'), task('left', stale)], { failOn: ['left'] })
    w.spaces.pop()
    const first = await w.migration.run()
    expect(first.failed).toEqual(['Main: "left": its schedule without a job could not be removed: Invalid engram: delegation.schedule has an unknown key'])
    expect(first).toMatchObject({ moved: 1, leftovers: 0 })
    expect(w.store.leftoversChecked(null)).toBe(false)
  })

})

describe('a space without version 1 jobs, in a home that was on version 1', () => {
  const stale = { delegation: { agent: 'atlas', checkpoint: 'after', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } }
  const NOTE = 'A schedule without a job was left on this task (0 7 * * * (UTC)) from before schedules moved onto tasks. Nothing ran it then, so it is removed and nothing starts to run it now. Set a new time if the task should run at one.'

  it('is looked through once all the same: a schedule left there without a job is removed, though the space is never planned for a job', async () => {
    // the only job is the team space's: the main space has none
    const w = world([v1('j2', { spaceId: 'space-2', taskId: 't2' })], [task('t2'), task('left', stale)])
    expect(w.store.awaitsLeftoverLook(null)).toBe(true)
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, leftovers: 1, failed: [], unlooked: 0 })
    expect(w.posts[0]).toEqual({ space: 'main-id', path: '/task/left/track', body: { delegation: { agent: 'atlas', checkpoint: 'after' }, text: NOTE } })
    expect(result.reports[0]).toContain('- A schedule without a job was left on this task (0 7 * * * (UTC)); removed.')
    expect([w.store.awaitsLeftoverLook(null), w.store.awaitsLeftoverLook('space-2')]).toEqual([false, false])
    expect(w.notices.map((n) => n.body)).toEqual(['Schedules moved onto their tasks: 1 moved, 0 not moved, 1 schedule without a job removed — see /home/someone/.eml-cockpit/jobs-migration-report.md'])
    // looked through once: a schedule set on a jobless task afterwards is real, in this process and after a restart
    w.byId.get('left')!.properties.delegation = structuredClone(stale.delegation)
    expect(await w.migration.run()).toMatchObject({ leftovers: 0, unlooked: 0, reports: [] })
    expect(await w.restart().run()).toMatchObject({ leftovers: 0, unlooked: 0, reports: [] })
    expect(w.byId.get('left')!.properties.delegation).toEqual(stale.delegation)
    expect(w.posts.filter((p) => p.path === '/task/left/track')).toHaveLength(1)
  })

  it('a version 1 file that holds no job at all: its spaces are looked through, and the file becomes version 2 with its backup', async () => {
    const w = world([], [task('left', stale), task('kept', stale)])
    w.store.put({ id: 'kept', spaceId: null, taskId: 'kept', runCount: 0 } as never)
    expect(w.store.pendingV1()).toBeNull()
    expect(await w.migration.run()).toMatchObject({ moved: 0, leftovers: 1, failed: [], unlooked: 0 })
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/left/track', body: { delegation: { agent: 'atlas', checkpoint: 'after' }, text: NOTE } }])
    expect(w.byId.get('kept')!.properties.delegation).toEqual(stale.delegation)
    expect(JSON.parse(readFileSync(w.file, 'utf8'))).toMatchObject({ version: 2, fromV1: true, leftoversChecked: ['', 'space-2'] })
    expect(existsSync(`${w.file}.v1-backup`)).toBe(true)
  })

  it('in a shared space the schedule is left as it is, logged and reported, and the space counts as looked through', async () => {
    const w = world([], [task('left', stale)], { team: true })
    w.spaces.shift()
    const result = await w.migration.run()
    expect(result).toMatchObject({ leftovers: 0, failed: [], unlooked: 0 })
    expect(w.posts).toEqual([])
    expect(w.logs).toContain('[jobs] migration, space space-2: task left has a schedule without a job; in a shared space it is left as it is')
    expect(result.reports[0]).toContain('In a shared space another member\'s cockpit may have put it there when its jobs moved, so it is left as it is and fires from now on')
    expect(w.saved).toHaveLength(1)
    expect(w.store.awaitsLeftoverLook('space-2')).toBe(false)
  })

  it('a space with nothing left over is marked without a report or a word to the user', async () => {
    const w = world([], [task('t1')])
    expect(await w.migration.run()).toMatchObject({ leftovers: 0, failed: [], reports: [], reportFile: null, unlooked: 0 })
    expect([w.saved, w.notices, w.posts]).toEqual([[], [], []])
    expect([w.store.awaitsLeftoverLook(null), w.store.awaitsLeftoverLook('space-2')]).toEqual([false, false])
  })

  it('a space whose kind is not known, or whose brain does not answer, is not looked through yet: it waits, said once in the log, and the pass says how many wait', async () => {
    const w = world([], [task('left', stale)], { team: null, down: ['main-id'] })
    const first = await w.migration.run()
    expect(first).toMatchObject({ leftovers: 0, failed: [], reports: [], unlooked: 2 })
    expect(w.posts).toEqual([])
    expect([w.store.awaitsLeftoverLook(null), w.store.awaitsLeftoverLook('space-2')]).toEqual([true, true])
    const said = w.logs.filter((l) => l.includes('not looked through yet'))
    expect(said).toEqual([
      '[jobs] migration, space main: not looked through yet for schedules left without a job: its brain did not answer (connect ECONNREFUSED)',
      '[jobs] migration, space space-2: not looked through yet for schedules left without a job: the brain server has not said yet whether it is shared',
    ])
    await w.migration.run()
    expect(w.logs.filter((l) => l.includes('not looked through yet'))).toEqual(said)
    // the brain answers: the main space is looked through, the other still waits
    w.opts.down = []
    expect(await w.migration.run()).toMatchObject({ leftovers: 1, unlooked: 1 })
    expect(w.posts.map((p) => [p.space, p.path])).toEqual([['main-id', '/task/left/track']])
  })

  it('a home that never had a version 1 file is not looked through: nothing there can be a leftover, and no space is asked', async () => {
    const w = world([], [task('later', stale)])
    writeFileSync(w.file, JSON.stringify({ version: 2, timeZone: null, jobs: {}, runs: {}, keys: {} }))
    expect(new JobStore(w.file).awaitsLeftoverLook(null)).toBe(false)
    expect(await w.restart().run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, leftovers: 0, reportFile: null, unlooked: 0 })
    expect(w.posts).toEqual([])
    expect(w.byId.get('later')!.properties.delegation).toEqual(stale.delegation)
  })
})

describe('the channel bridge follows a moved job\'s id', () => {
  const mail = { triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }], nextRunAt: null }

  it('after the store step, tells the bridge the new id of every job that moved to a record, and forgets the mapping once it has confirmed', async () => {
    const w = world([v1('j1', mail), v1('j2'), v1('j3', { taskId: 'gone' })], [task('t1')])
    await w.migration.run()
    // both jobs of the task: a job without a mail trigger now may have had one before
    expect(w.bridge.asked).toEqual([['j1', 't1'], ['j2', 't1']])
    expect(w.store.get('t1')).toBeDefined()
    expect(w.store.pendingRenames()).toEqual({})
    expect(JSON.parse(readFileSync(w.file, 'utf8'))).not.toHaveProperty('renames')
  })

  it('a bridge that does not run is not an error: the mapping stays in the file, and the next start asks again', async () => {
    const w = world([v1('j1', mail)], [task('t1')])
    w.bridge.answer = 'off'
    expect(await w.migration.run()).toMatchObject({ moved: 1, failed: [] })
    expect(w.store.pendingV1()).toBeNull()
    expect(JSON.parse(readFileSync(w.file, 'utf8')).renames).toEqual({ j1: 't1' })
    // a later pass in the same process, with nothing left to move, asks again
    await w.migration.run()
    expect(w.bridge.asked).toEqual([['j1', 't1'], ['j1', 't1']])
    // the next start: the bridge runs
    w.bridge.answer = 'renamed'
    const next = w.restart()
    expect(new JobStore(w.file).pendingV1()).toBeNull()
    await next.run()
    expect(w.bridge.asked).toHaveLength(3)
    expect(new JobStore(w.file).pendingRenames()).toEqual({})
    // confirmed: never asked again
    await w.restart().run()
    expect(w.bridge.asked).toHaveLength(3)
  })

  it('a rename the bridge could not make is kept and said in the log', async () => {
    const w = world([v1('j1', mail)], [task('t1')])
    w.bridge.answer = 'failed'
    await w.migration.run()
    expect(w.store.pendingRenames()).toEqual({ j1: 't1' })
    expect(w.logs.some((l) => l.includes('the channel bridge did not take the new id of 1 moved job(s)'))).toBe(true)
  })
})

describe('the report of a real run is kept, and the user is told of what did not move', () => {
  it('writes the whole report of the run to a file with its date, logs where, and tells nothing when every job moved', async () => {
    const w = world([v1('j1')], [task('t1')])
    const result = await w.migration.run()
    expect(result).toMatchObject({ jobs: { moved: 1, notMoved: 0 }, reportFile: '/home/someone/.eml-cockpit/jobs-migration-report.md' })
    expect(w.saved).toHaveLength(1)
    expect(w.saved[0].startsWith('# Run of 2026-11-26T10:00:00.000Z\n\nSchedules moved onto their tasks: 1 moved, 0 not moved.\n\n# Schedules onto tasks — run\n')).toBe(true)
    expect(w.saved[0]).toContain('- Job "Daily brief" (j1): cron "0 8 * * 1-5" (UTC) → a repeating time of the task')
    expect(w.logs).toContain('[jobs] migration: the report of this run is in /home/someone/.eml-cockpit/jobs-migration-report.md')
    expect(w.notices).toEqual([])
  })

  it('tells the user once, with the file, when a job did not move: one left out, one whose task is gone, one whose space did not answer', async () => {
    const w = world(
      [v1('j1'), v1('j2', { name: 'Tokyo brief', triggers: [{ type: 'schedule', cron: '0 9 * * *', timeZone: 'Asia/Tokyo' }] }), v1('j3', { taskId: 'gone' }), v1('j4', { spaceId: 'space-2', taskId: 't2' }), v1('j5', { taskId: 't1', endedAt: '2026-11-20T00:00:00.000Z' })],
      [task('t1'), task('t2')], { down: ['space-2'] },
    )
    const result = await w.migration.run()
    // j1 moved; j2 (another zone), j3 (task gone) and j4 (its brain did not answer) did not; j5 had ended: history
    expect(result.jobs).toEqual({ moved: 1, notMoved: 3 })
    expect(w.notices).toEqual([{
      kind: 'review', title: 'Schedules', jobId: 'jobs-migration-report', sessionId: null, spaceId: null,
      body: 'Schedules moved onto their tasks: 1 moved, 3 not moved — see /home/someone/.eml-cockpit/jobs-migration-report.md',
    }])
    expect(w.saved[0]).toContain('Schedules moved onto their tasks: 1 moved, 3 not moved.\n\nNot done in this run:\n- Team: its brain did not answer (connect ECONNREFUSED), its 1 job(s) wait\n')
    expect(w.saved[0]).toContain('NOT MOVED, IT NO LONGER FIRES')
    // a later pass that changes nothing writes no second report and tells nothing again
    await w.migration.run()
    expect(w.saved).toHaveLength(1)
    expect(w.notices).toHaveLength(1)
    // once the space answers, its pass is reported too
    w.opts.down = []
    expect((await w.migration.run()).jobs).toEqual({ moved: 1, notMoved: 0 })
    expect(w.saved).toHaveLength(2)
    expect(w.notices).toHaveLength(1)
  })

  it('a report that cannot be written does not stop the migration', async () => {
    const w = world([v1('j1')], [task('t1')])
    const migration = createJobMigration({
      store: w.store, spaces: () => [w.spaces[0]] as never, brain: () => ({ get: async (path: string) => (path === '/list' ? { engrams: [] } : structuredClone(w.byId.get(path.slice('/engram/'.length))!)), post: async () => ({}) }),
      me: 'lasse', moveSessions: () => {}, now: () => NOW, log: (line: string) => w.logs.push(line), saveReport: () => { throw new Error('disk full') },
    } as never)
    expect(await migration.run()).toMatchObject({ moved: 1, reportFile: null })
    expect(w.logs.some((l) => l.includes('its report could not be written: disk full'))).toBe(true)
  })
})
