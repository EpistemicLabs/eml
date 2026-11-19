import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskCommands, TaskCommandStore, UNDO_WINDOW_MS, type TaskCommandsDeps } from '../src/application/task-commands.js'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-task-commands-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Task = { id: string; status: string; scope?: string; title?: string; properties: Record<string, unknown> }

function world(tasks: Task[], opts: { runner?: boolean; bound?: string[] } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') return { engrams: query?.task_id ? (opts.bound ?? []).map((id) => ({ id })) : [] }
      const t = byId.get(path.slice('/engram/'.length))
      if (!t) throw new Error('not found')
      return { ...t, title: t.title ?? t.id, scope: t.scope ?? 'project.eml', relations: [] }
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const t = byId.get(/^\/task\/([^/]+)\/track$/.exec(path)![1])!
      for (const [k, v] of Object.entries(body)) {
        if (k === 'text' || k === 'outcome') continue
        if (k === 'status') t.status = v as string
        else if (v === null) delete t.properties[k]
        else t.properties[k] = v
      }
      return t
    },
  }
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') }
  const jobs: Array<{ taskId: string; spec: unknown; prompt: string }> = []
  const triaged: string[] = []
  const changed: string[] = []
  const space = { id: 'main', name: 'Main', taskSystem: true, shared: false }
  const store = new TaskCommandStore(join(dir, `${Math.random()}.json`))
  const deps: TaskCommandsDeps = {
    store,
    space: (id) => (id === 'main' ? (space as never) : undefined),
    brain: () => brain,
    agentsOf: async () => ['atlas', 'motti'],
    runner: () => opts.runner ?? true,
    createJob: async (_space, task, spec, prompt) => { jobs.push({ taskId: task.id, spec, prompt }); return { jobId: `job-${jobs.length}` } },
    triage: {
      accept: async (id) => { triaged.push(`accept ${id}`); return { taskId: 'new-task' } as never },
      merge: async (id, into) => { triaged.push(`merge ${id} ${into}`); return { taskId: into } as never },
      close: (id) => { triaged.push(`close ${id}`); return {} as never },
    },
    changed: (spaceId) => changed.push(spaceId),
    now: () => clock.now,
    log: () => {},
  }
  const commands = createTaskCommands(deps)
  const later = (ms: number) => { clock.now += ms }
  return { commands, posts, byId, clock, later, jobs, triaged, changed, store, deps }
}

const owned = (id: string, props: Record<string, unknown> = {}, status = 'planned'): Task => ({ id, status, properties: { assignee_ids: ['lasse'], ...props } })

describe('hand over', () => {
  it('waits out the undo window, then writes delegate, checkpoint and the journal once', async () => {
    const w = world([owned('t1')])
    const r = await w.commands.submit({ opId: 'op-1', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'pending', undoUntil: new Date(w.clock.now + UNDO_WINDOW_MS).toISOString() } })
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.commands.held('t1')).toBe(true)

    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    await w.commands.tick()
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegate: 'atlas', checkpoint: 'after', text: 'Handed to atlas with checkpoint after; the owner stays.' } }])
    expect(w.commands.held('t1')).toBe(false)
    expect(w.changed).toContain('main')
  })

  it('does the work once for the same operation id', async () => {
    const w = world([owned('t1')])
    const input = { opId: 'op-twice', kind: 'hand_over' as const, spaceId: 'main', taskId: 't1', handOver: { mode: 'now' as const, delegate: 'atlas', checkpoint: 'after' } }
    const first = await w.commands.submit(input)
    const second = await w.commands.submit(input)
    expect(second).toEqual(first)
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toHaveLength(1)
  })

  it('undo inside the window leaves no trace; after it, undo is refused', async () => {
    const w = world([owned('t1'), owned('t2')])
    await w.commands.submit({ opId: 'op-u', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(await w.commands.undo('op-u')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([])

    await w.commands.submit({ opId: 'op-late', kind: 'hand_over', spaceId: 'main', taskId: 't2', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(await w.commands.undo('op-late')).toEqual({ ok: false, refusal: 'undo_expired' })
    expect(await w.commands.undo('nope')).toEqual({ ok: false, refusal: 'unknown_command' })
  })

  it('carries an open question into the journal and the brief, then clears the wait', async () => {
    const w = world([owned('t1', { delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'question', why: 'Count it?' } }, 'active')])
    const r = await w.commands.submit({ opId: 'op-q', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(r).toMatchObject({ ok: true, command: { carriedQuestion: 'Count it?' } })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body).toMatchObject({ waiting_on: null, status: 'planned' })
    expect(w.posts[0].body.text).toContain('Handed over with the open question: "Count it?"')
    expect(w.commands.briefOf('t1')).toContain('Count it?')
  })

  it('schedule makes a job on the task when the window is over', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-s', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Makassar' } } })
    expect(w.jobs).toEqual([])
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.jobs).toEqual([{ taskId: 't1', spec: { at: '2026-11-20T09:00', timeZone: 'Asia/Makassar' }, prompt: expect.stringContaining('Checkpoint after') }])
    expect(w.posts[0].body.text).toMatch(/^Scheduled atlas for 2026-11-20T09:00/)
  })

  it('work on it now happens at once, with the brief for the session the page opens; undo puts the task back', async () => {
    const w = world([owned('t1', { waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' } })])
    const r = await w.commands.submit({ opId: 'op-t', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Customers' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'applied', brief: expect.stringContaining('Which list?') } })
    expect(w.posts[0].body).toMatchObject({ delegate: 'atlas', waiting_on: null })
    expect(w.posts[0].body.text).toMatch(/^Working on it with atlas in desk Customers; the owner stays\./)
    expect(await w.commands.undo('op-t')).toEqual({ ok: true })
    expect(w.posts[1].body).toEqual({ delegate: null, checkpoint: null, waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' }, status: 'planned', text: 'Hand-over undone; the task is back as it was.' })
  })

  it('refuses what cannot be handed over, with a reason', async () => {
    const w = world([owned('t1'), owned('done', {}, 'resolved')])
    const go = (taskId: string, delegate = 'atlas') => w.commands.submit({ opId: `op-${taskId}-${delegate}`, kind: 'hand_over', spaceId: 'main', taskId, handOver: { mode: 'now', delegate, checkpoint: 'after' } })
    expect(await go('missing')).toEqual({ ok: false, refusal: 'unknown_task' })
    expect(await go('done')).toEqual({ ok: false, refusal: 'task_closed' })
    expect(await go('t1', 'scout')).toEqual({ ok: false, refusal: 'delegate_not_in_space' })
    expect(await world([owned('t1')], { runner: false }).commands.submit({ opId: 'x', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } }))
      .toEqual({ ok: false, refusal: 'space_has_no_runner' })
    expect(await w.commands.submit({ opId: 'y', kind: 'hand_over', spaceId: 'other', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } }))
      .toEqual({ ok: false, refusal: 'unknown_space' })
  })

  it('a pending command survives a restart and is applied by the next host', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-r', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    const reopened = createTaskCommands({ ...w.deps, store: new TaskCommandStore((w.store as unknown as { file: string }).file) })
    w.later(UNDO_WINDOW_MS + 1)
    await reopened.tick()
    expect(w.posts).toHaveLength(1)
  })
})

describe('looks good, snooze, triage', () => {
  it('looks good closes the task after the window; a task with bound decisions or notes is closed in chat', async () => {
    const w = world([owned('t1', { delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'review' } }, 'active')])
    await w.commands.submit({ opId: 'op-ok', kind: 'review', spaceId: 'main', taskId: 't1' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body).toEqual({ status: 'resolved', outcome: 'Reviewed and closed by the owner', waiting_on: null, text: 'Looks good: the owner reviewed the result and closed the task.' })

    const bound = world([owned('t2', {}, 'active')], { bound: ['d1'] })
    expect(await bound.commands.submit({ opId: 'op-b', kind: 'review', spaceId: 'main', taskId: 't2' })).toMatchObject({ ok: false, refusal: 'bound_items' })
  })

  it('snooze hides an Inbox item at once and undo brings it back', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-z', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@s', until: '2026-11-20T01:00:00Z' } })
    expect(w.commands.snoozes()).toEqual([{ key: 'task:t1@s', until: '2026-11-20T01:00:00Z' }])
    expect(await w.commands.undo('op-z')).toEqual({ ok: true })
    expect(w.commands.snoozes()).toEqual([])
  })

  it('triage accept, merge and close wait out the window too', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-a', kind: 'triage', spaceId: 'main', pendingId: 'pending-1', triage: { action: 'accept' } })
    await w.commands.submit({ opId: 'op-m', kind: 'triage', spaceId: 'main', pendingId: 'pending-2', triage: { action: 'merge', intoTaskId: 't1' } })
    await w.commands.submit({ opId: 'op-c', kind: 'triage', spaceId: 'main', pendingId: 'pending-3', triage: { action: 'close' } })
    expect(w.commands.triagePending('pending-1')).toBe(true)
    await w.commands.undo('op-c')
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.triaged).toEqual(['accept pending-1', 'merge pending-2 t1'])
  })
})
