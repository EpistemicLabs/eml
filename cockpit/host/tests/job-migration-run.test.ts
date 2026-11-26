import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmlApiError } from '@engramprotocol/mcp-server'
import { createJobMigration } from '../src/application/job-migration.js'
import { pendingJobsOf } from '../src/job-migration-cli.js'
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

function world(jobs: Array<Record<string, unknown>>, tasks: Task[], opts: { runs?: Record<string, unknown[]>; failOn?: string[]; down?: string[]; noBrain?: string[] } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-migration-')), 'jobs.json')
  const original = JSON.stringify({ version: 1, timeZone: 'UTC', jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), runs: opts.runs ?? {}, keys: {} })
  writeFileSync(file, original)
  const store = new JobStore(file)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ space: string; path: string; body: Record<string, unknown> }> = []
  const brainOf = (space: string) => ({
    async get(path: string, query?: Record<string, unknown>) {
      if (opts.down?.includes(space)) throw new Error('connect ECONNREFUSED')
      if (path === '/list') return { engrams: [...byId.values()].filter((t) => t.title === query?.title) }
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
  const spaces = [{ id: 'main-id', name: 'Main', main: true, agent: 'atlas' }, { id: 'space-2', name: 'Team', main: false, agent: 'motti' }]
  const deps = {
    store, spaces: () => spaces as never, brain: (space: { id: string }) => (opts.noBrain?.includes(space.id) ? null : brainOf(space.id)),
    me: 'lasse', moveSessions: (from: string, to: string) => { moved.push([from, to]) }, now: () => NOW, log: (line: string) => logs.push(line),
  }
  return { file, original, store, byId, posts, moved, logs, opts, migration: createJobMigration(deps as never), restart: () => createJobMigration({ ...deps, store: new JobStore(file) } as never) }
}

describe('the migration of jobs.json to schedules on tasks', () => {
  it('the dry run plans and reports, and writes nothing: not to the brain, not to the file', async () => {
    const w = world([v1('j1'), v1('j2', { triggers: [{ type: 'schedule', at: AHEAD, timeZone: 'UTC' }], prompt: 'Look again.', target: { type: 'session', sessionId: 'sess-1' } })], [task('t1')])
    const dry = await w.migration.dryRun(w.store && ({ id: 'main-id', name: 'Main', main: true, agent: 'atlas' } as never))
    expect(dry?.plan.tasks).toHaveLength(1)
    expect(dry?.report).toContain('# Schedules onto tasks — dry run')
    expect(dry?.report).toContain('- Repeating times: 0 8 * * 1-5 (UTC)')
    expect(w.posts).toEqual([])
    expect(readFileSync(w.file, 'utf8')).toBe(w.original)
    expect(existsSync(`${w.file}.v1-backup`)).toBe(false)
    expect(w.migration.pending()).toBe(true)
    // a space without jobs has nothing to plan
    expect(await w.migration.dryRun({ id: 'space-2', name: 'Team', main: false, agent: 'motti' } as never)).toBeNull()
  })

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
    expect(await w.migration.run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [] })
    expect(await w.restart().run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [] })
    expect(w.posts).toHaveLength(posts)
    expect(readFileSync(w.file, 'utf8')).toBe(file)
    expect(w.moved).toEqual([['j1', 't1']])
  })

  it('a task without a delegation gets one for the space\'s agent with its schedule', async () => {
    const w = world([v1('j1')], [task('t1')])
    await w.migration.run()
    expect(w.posts[0].body.delegation).toEqual({ agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'UTC' } })
  })

  it('a task whose write fails keeps its jobs for the next start; the others move', async () => {
    const w = world([v1('j1'), v1('j2', { taskId: 't2' })], [task('t1'), task('t2')], { failOn: ['t1'] })
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 1, failed: ['Main: "t1": Invalid engram: delegation.schedule has an unknown key'] })
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
      store: { pendingV1: () => w.store.pendingV1(), migrateV1: () => { throw new Error('host stopped') } }, spaces: () => [{ id: 'main-id', name: 'Main', main: true, agent: 'atlas' }] as never,
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

  it('drops the jobs of a closed task, a gone one and another member\'s; only the closed one is written to', async () => {
    const w = world(
      [v1('j1', { taskId: 'closed' }), v1('j2', { taskId: 'gone' }), v1('j3', { taskId: 'theirs' })],
      [task('closed', { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'] } } }, 'resolved'), task('theirs', { assignee_ids: ['dominik'] })], { runs: { j3: [openRun('j3')] } },
    )
    const result = await w.migration.run()
    expect(result).toMatchObject({ moved: 0, dropped: 3, failed: [] })
    expect(w.posts).toEqual([{ space: 'main-id', path: '/task/closed/track', body: { delegation: { agent: 'atlas' }, text: expect.stringContaining('the task is closed') } }])
    expect(w.store.list()).toEqual([])
    expect(w.moved).toEqual([])
    // its runs stay as history under the job's id, none of them open
    expect(w.store.runs('j3')).toMatchObject([{ id: 'run-j3', status: 'finished', note: 'its job ended when schedules moved onto tasks' }])
    expect(w.store.pendingV1()).toBeNull()
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
    expect(w.logs.some((l) => l.includes('"Daily brief" left as it is'))).toBe(true)
  })

  it('a home without version 1 jobs has nothing to do', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-migration-')), 'jobs.json')
    const migration = createJobMigration({ store: new JobStore(file), spaces: () => { throw new Error('not asked') }, brain: () => null, me: 'lasse', moveSessions: () => {}, now: () => NOW, log: () => {} })
    expect(migration.pending()).toBe(false)
    expect(await migration.run()).toEqual({ moved: 0, dropped: 0, left: 0, failed: [], reports: [] })
    expect(existsSync(file)).toBe(false)
  })
})

describe('the jobs a dry run by hand reads from jobs.json', () => {
  it('are the jobs of a version 1 file, or what a version 2 file still holds of them', () => {
    const jobs = { j1: v1('j1') }
    expect(pendingJobsOf(JSON.stringify({ version: 1, jobs, runs: { j1: [] }, keys: {} }))).toEqual({ jobs, runs: { j1: [] }, keys: {} })
    expect(pendingJobsOf(JSON.stringify({ version: 2, jobs: { t1: {} }, runs: {}, keys: {}, v1: { jobs, runs: {}, keys: {} } }))?.jobs).toEqual(jobs)
    expect(pendingJobsOf(JSON.stringify({ version: 2, jobs: { t1: {} }, runs: {}, keys: {} }))).toBeNull()
    expect(pendingJobsOf(JSON.stringify({ version: 1, jobs: {}, runs: {}, keys: {} }))).toBeNull()
  })
})
