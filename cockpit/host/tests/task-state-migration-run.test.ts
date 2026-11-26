import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStateMigration, makeRoutineTask, MIGRATION_MARKER, routineTask, routineTitle, type TaskStateMigrationDeps } from '../src/application/task-state-migration.js'

// paths.ts reads the home at import time — set it before loading the modules that use it.
const home = mkdtempSync(join(tmpdir(), 'cockpit-migration-run-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const NOW = Date.parse('2026-11-24T12:00:00.000Z')
type Task = { id: string; status: string; title: string; properties: Record<string, unknown> }

function world(tasks: Task[], opts: { snoozes?: Array<{ key: string; until: string }>; failOn?: string[] } = {}) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const notes: Array<{ title: string; created_at: string }> = []
  let snoozes = opts.snoozes ?? []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list' && query?.type === 'note') return { engrams: notes.filter((n) => n.title === query.title) }
      if (path === '/list' && query?.title) return { engrams: [...byId.values()].filter((t) => t.title === query.title) }
      if (path === '/list') return { engrams: [...byId.values()].filter((t) => t.status === query?.status) }
      throw new Error(`unexpected ${path}`)
    },
    async post(path: string, body: Record<string, unknown>) {
      if (path === '/engram/note') {
        const note = { title: body.title as string, created_at: new Date(NOW).toISOString() }
        notes.push(note)
        return note
      }
      posts.push({ path, body })
      if (path === '/engram/task') {
        const made = { id: `made-${byId.size}`, status: 'active', title: body.title as string, properties: {} }
        byId.set(made.id, made)
        return made
      }
      const id = /^\/task\/([^/]+)\/track$/.exec(path)![1]
      if (opts.failOn?.includes(id)) throw new Error('brain down')
      const t = byId.get(id)!
      for (const [k, v] of Object.entries(body)) if (k !== 'text') { if (v === null) delete t.properties[k]; else t.properties[k] = v }
      // core keeps the flat fields mirrored with the delegation
      const d = body.delegation as { agent?: string; checkpoint?: string } | undefined
      if (d?.checkpoint) t.properties.checkpoint = d.checkpoint
      return t
    },
  }
  const heldWaitsFile = join(home, `held-${Math.random()}.json`)
  const deps: TaskStateMigrationDeps = {
    space: (id) => (id === 'main' ? ({ id: 'main', name: 'Main', main: true } as never) : undefined),
    brain: () => brain,
    viewer: 'lasse',
    snoozes: () => snoozes,
    setSnoozes: (next) => { snoozes = next },
    heldWaitsFile,
    liveSessions: () => [],
    now: () => NOW,
    log: () => {},
  }
  return { migration: createTaskStateMigration(deps), brain, posts, notes, byId, snoozes: () => snoozes, heldWaitsFile }
}

const waits = [{ id: 's1', who: 'lasse', kind: 'question', why: 'Which?', since: '2026-11-23T09:00:00.000Z' }]

describe('the task state migration run', () => {
  it('leaves its marker before it writes a task; a second run gives no start request, so a task it gave a checkpoint never starts', async () => {
    const w = world([
      { id: 'legacy', status: 'planned', title: 'legacy', properties: { assignee_ids: ['lasse'], delegate: 'atlas', checkpoint: 'after' } },
      { id: 'unasked', status: 'planned', title: 'unasked', properties: { assignee_ids: ['lasse'], delegate: 'motti' } },
    ])
    const first = await w.migration.run('main')
    expect(first).toMatchObject({ ok: true, written: 2 })
    expect(w.notes.map((n) => n.title)).toEqual([MIGRATION_MARKER])
    expect(w.byId.get('legacy')!.properties.delegation).toMatchObject({ requested_at: '2026-11-24T12:00:00.000Z' })
    // 'unasked' now has a delegate and a checkpoint and no request, like 'legacy' had: the second run leaves it so
    const dry = await w.migration.dryRun('main')
    expect(dry).toMatchObject({ ok: true, ranBefore: '2026-11-24T12:00:00.000Z', plan: { changes: [] } })
    if (dry.ok) expect(dry.report).toContain('it gives no start requests again')
    const second = await w.migration.run('main')
    expect(second).toMatchObject({ ok: true, written: 0 })
    expect(w.byId.get('unasked')!.properties.delegation).toEqual({ agent: 'motti', checkpoint: 'after' })
    expect(w.notes).toHaveLength(1)
  })

  it('the dry run writes nothing; the run writes one track call per change with its journal line', async () => {
    const w = world([
      { id: 'd', status: 'planned', title: 'd', properties: { assignee_ids: ['lasse'], delegate: 'atlas' } },
      { id: 'b', status: 'active', title: 'b', properties: { assignee_ids: ['lasse'], blockers: ['vendor'] } },
      { id: 'plain', status: 'active', title: 'plain', properties: {} },
    ])
    const dry = await w.migration.dryRun('main')
    expect(dry.ok).toBe(true)
    expect(w.posts).toEqual([])

    const run = await w.migration.run('main')
    expect(run).toMatchObject({ ok: true, written: 2, failed: [] })
    expect(w.posts.map((p) => p.path)).toEqual(['/task/d/track', '/task/b/track'])
    expect(w.posts[0].body).toEqual({
      delegation: { agent: 'atlas', checkpoint: 'after' },
      text: 'Task state migration (schema 23): handed to atlas with checkpoint after, not started: the board offers "Hand to atlas".',
    })
    // run again: the brain has the changes, so nothing is planned twice
    await w.migration.run('main')
    expect(w.posts.filter((p) => p.path === '/task/b/track')).toHaveLength(1)
  })

  it('collects a failed write, keeps the snooze of a task it could not park, and drops the one it moved', async () => {
    const w = world([
      { id: 'z', status: 'active', title: 'z', properties: { waits } },
      { id: 'down', status: 'active', title: 'down', properties: { waits } },
    ], {
      failOn: ['down'],
      snoozes: [{ key: 'task:z@2026-11-23T09:00:00.000Z', until: '2026-11-30T00:00:00.000Z' }, { key: 'task:down@2026-11-23T09:00:00.000Z', until: '2026-11-30T00:00:00.000Z' }],
    })
    const run = await w.migration.run('main')
    expect(run).toMatchObject({ ok: true, written: 1, failed: [expect.stringContaining('down: brain down')] })
    expect(w.snoozes()).toEqual([{ key: 'task:down@2026-11-23T09:00:00.000Z', until: '2026-11-30T00:00:00.000Z' }])
  })

  it('a routine without a task gets one, named after it, and a retry finds it again instead of making a second', async () => {
    const w = world([])
    const routine = { id: 'job-1234567890', name: 'Daily brief', prompt: 'write the brief' }
    const task = routineTask(routine, 'bp-ops', 'member')!
    expect(task).toEqual({ title: routineTitle(routine), display_title: 'Daily brief', content: 'write the brief', scope: 'project.ops', status: 'active', assignee_ids: ['member'] })
    expect(task.title).toBe('routine-daily-brief-job-1234')
    // a task belongs to a project of the brain
    expect(routineTask(routine, null, 'member')).toBeNull()
    expect(routineTask(routine, 'some-folder', 'member')).toBeNull()

    expect(await makeRoutineTask(w.brain, task)).toEqual({ id: 'made-0', made: true })
    expect(w.posts).toEqual([{ path: '/engram/task', body: task }])
    // the answer never arrived: the retry finds the task by its title
    expect(await makeRoutineTask(w.brain, task)).toEqual({ id: 'made-0', made: false })
    expect(w.posts.filter((p) => p.path === '/engram/task')).toHaveLength(1)
  })

  it('refuses an unknown space, and a second run while one is writing', async () => {
    const w = world([{ id: 'd', status: 'planned', title: 'd', properties: { delegate: 'atlas' } }])
    expect(await w.migration.run('nope')).toEqual({ ok: false, refusal: 'unknown_space' })
    const [a, b] = await Promise.all([w.migration.run('main'), w.migration.run('main')])
    expect(a.ok).toBe(true)
    expect(b).toMatchObject({ ok: false, refusal: 'in_flight' })
  })

  it('lists the tasks of held-waits.json in the dry run', async () => {
    const w = world([])
    writeFileSync(w.heldWaitsFile, JSON.stringify({ t1: [{ who: 'lasse' }], t2: [] }))
    const dry = await w.migration.dryRun('main')
    expect(dry.ok && dry.plan.elsewhere.heldWaits).toEqual([{ taskId: 't1', count: 1 }])
  })
})
