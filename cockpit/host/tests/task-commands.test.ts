import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskCommands, firstLine, MESSAGE_MAX, SCHEDULE_ON, TaskCommandStore, TOGETHER_GRACE_MS, UNDO_WINDOW_MS, type TaskCommandsDeps } from '../src/application/task-commands.js'
import { hasSchedule } from '../src/domain/task-schedule.js'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-task-commands-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Task = { id: string; status: string; scope?: string; title?: string; properties: Record<string, unknown>; relations?: Array<{ source_id: string; target_id: string; relation: string }> }

function world(tasks: Task[], opts: { bound?: string[]; candidates?: Array<{ id: string; type: string; title: string | null; status: string }> } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') return { engrams: query?.task_id ? (opts.bound ?? []).map((id) => ({ id })) : [] }
      const t = byId.get(path.slice('/engram/'.length))
      if (!t) throw new Error('not found')
      return { ...t, title: t.title ?? t.id, scope: t.scope ?? 'project.eml', relations: t.relations ?? [] }
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      if (path === '/relate') return { ok: true }
      if (path === '/engram/task') {
        const { title, status, scope, ...props } = body
        const made: Task = { id: `new-${byId.size}`, status: status as string, scope: scope as string, title: title as string, properties: props }
        byId.set(made.id, made)
        return made
      }
      const t = byId.get(/^\/task\/([^/]+)\/track$/.exec(path)![1])!
      for (const [k, v] of Object.entries(body)) {
        if (k === 'text' || k === 'outcome') continue
        if (k === 'status') t.status = v as string
        else if (v === null) delete t.properties[k]
        else t.properties[k] = v
      }
      return body.status === 'active' && opts.candidates ? { ...t, reopen_candidates: opts.candidates } : t
    },
  }
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') }
  const jobs: Array<{ taskId: string; spec: unknown; prompt: string }> = []
  const changed: string[] = []
  const space = { id: 'main', name: 'Main', shared: false }
  const store = new TaskCommandStore(join(dir, `${Math.random()}.json`))
  const deps: TaskCommandsDeps = {
    store,
    viewer: 'lasse',
    space: (id) => (id === 'main' ? (space as never) : undefined),
    brain: () => brain,
    agentsOf: async () => ['atlas', 'motti'],
    createJob: async (_space, task, spec, prompt) => { jobs.push({ taskId: task.id, spec, prompt }); return { jobId: `job-${jobs.length}` } },
    changed: (spaceId) => changed.push(spaceId),
    now: () => clock.now,
    log: () => {},
  }
  const commands = createTaskCommands(deps)
  const later = (ms: number) => { clock.now += ms }
  return { commands, posts, byId, clock, later, jobs, changed, store, deps }
}

const owned = (id: string, props: Record<string, unknown> = {}, status = 'planned'): Task => ({ id, status, properties: { assignee_ids: ['lasse'], ...props } })

describe('hand over', () => {
  it('waits out the undo window, then writes the delegation with its request and the journal once', async () => {
    const w = world([owned('t1')])
    const r = await w.commands.submit({ opId: 'op-1', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'pending', undoUntil: new Date(w.clock.now + UNDO_WINDOW_MS).toISOString() } })
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.commands.held('t1')).toBe(true)

    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    await w.commands.tick()
    // requested when it is applied: the runner's trigger; the status is left alone
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: new Date(w.clock.now).toISOString() }, text: 'Handed to atlas with checkpoint after; the owner stays.' } }])
    expect(w.commands.held('t1')).toBe(false)
    expect(w.changed).toContain('main')
  })

  it('Start fresh is the latest Delegate now\'s choice: its delegate starts in a new session, and the journal says so', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-f', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after', fresh: true } })
    expect(w.commands.startFresh('t1')).toBe(true)
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body.text).toBe('Handed to atlas with checkpoint after; the owner stays. It starts in a new session (Start fresh).')
    w.later(1000)
    await w.commands.submit({ opId: 'op-c', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(w.commands.startFresh('t1')).toBe(false)
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
    expect(w.posts[0].body).toMatchObject({ waits: null })
    expect(w.posts[0].body).not.toHaveProperty('status')
    expect(w.posts[0].body.text).toContain('Handed over with the open question: "Count it?"')
    expect(w.commands.briefOf('t1')).toContain('Count it?')
  })

  it('schedule makes a job on the task when the window is over', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-s', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' } } })
    expect(w.jobs).toEqual([])
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.jobs).toEqual([{ taskId: 't1', spec: { at: '2026-11-20T09:00', timeZone: 'Asia/Singapore' }, prompt: expect.stringContaining('Checkpoint after') }])
    expect(w.posts[0].body.text).toMatch(/^Scheduled atlas for 2026-11-20T09:00/)
  })

  it('work on it now happens at once, writes no delegation, with the brief for the session the page opens; undo puts the task back', async () => {
    const w = world([owned('t1', { waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' } })])
    const r = await w.commands.submit({ opId: 'op-t', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Customers' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'applied', brief: expect.stringContaining('Which list?') } })
    expect(w.posts[0].body).toMatchObject({ status: 'active', waits: null })
    expect(w.posts[0].body).not.toHaveProperty('delegation')
    expect(w.posts[0].body.text).toMatch(/^Working on it with atlas in desk Customers; the owner stays\./)
    expect(await w.commands.undo('op-t')).toEqual({ ok: true })
    expect(w.posts[1].body).toEqual({ delegation: null, waits: [{ id: 'waiting_on', who: 'lasse', kind: 'question', why: 'Which list?' }], status: 'planned', text: 'Hand-over undone; the task is back as it was.' })
  })

  it('refuses what cannot be handed over, with a reason', async () => {
    const w = world([owned('t1'), owned('done', {}, 'resolved')])
    const go = (taskId: string, delegate = 'atlas') => w.commands.submit({ opId: `op-${taskId}-${delegate}`, kind: 'hand_over', spaceId: 'main', taskId, handOver: { mode: 'now', delegate, checkpoint: 'after' } })
    expect(await go('missing')).toEqual({ ok: false, refusal: 'unknown_task' })
    expect(await go('done')).toEqual({ ok: false, refusal: 'task_closed' })
    expect(await go('t1', 'scout')).toEqual({ ok: false, refusal: 'delegate_not_in_space' })
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

describe('looks good, snooze, close', () => {
  it('looks good closes the task after the window; a task with bound decisions or notes is closed in chat', async () => {
    const w = world([owned('t1', { delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'review' } }, 'active')])
    await w.commands.submit({ opId: 'op-ok', kind: 'review', spaceId: 'main', taskId: 't1' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body).toEqual({ status: 'resolved', outcome: 'Reviewed and closed by the owner', waits: null, text: 'Looks good: the owner reviewed the result and closed the task.' })

    const bound = world([owned('t2', {}, 'active')], { bound: ['d1'] })
    expect(await bound.commands.submit({ opId: 'op-b', kind: 'review', spaceId: 'main', taskId: 't2' })).toMatchObject({ ok: false, refusal: 'bound_items' })
  })

  it('parking puts snoozed_until on the task\'s wait in the brain at once, and undo takes it off (v0.23)', async () => {
    const waits = [
      { id: 's1', who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T09:00:00.000Z', session_id: 's1' },
      { id: 'kim', who: 'kim', kind: 'outside', why: 'reply', since: '2026-11-19T09:00:00.000Z' },
    ]
    const w = world([owned('t1', { waits }, 'active')])
    const r = await w.commands.submit({ opId: 'op-z', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@2026-11-19T09:00:00.000Z', until: '2026-11-20T01:00:00Z' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'applied', taskId: 't1' } })
    // only the viewer's wait is parked; nothing goes into this cockpit's own store
    expect(w.byId.get('t1')!.properties.waits).toEqual([{ ...waits[0], snoozed_until: '2026-11-20T01:00:00Z' }, waits[1]])
    expect(w.posts[0].body.text).toBe('Parked by the owner until 2026-11-20T01:00:00Z.')
    expect(w.commands.snoozes()).toEqual([])
    expect(await w.commands.undo('op-z')).toEqual({ ok: true })
    expect(w.byId.get('t1')!.properties.waits).toEqual(waits)

    // Bring back now: until "now" takes the snooze off the wait, with its journal line
    await w.commands.submit({ opId: 'op-z2', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@2026-11-19T09:00:00.000Z', until: '2026-11-21T01:00:00Z' } })
    await w.commands.submit({ opId: 'op-back', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@2026-11-19T09:00:00.000Z', until: 'now' } })
    expect(w.byId.get('t1')!.properties.waits).toEqual(waits)
    expect(w.posts.at(-1)!.body.text).toBe('Unparked by the owner.')

    // open-ended, and refusals
    await w.commands.submit({ opId: 'op-open', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@', until: 'open' } })
    expect((w.byId.get('t1')!.properties.waits as Array<Record<string, string>>)[0].snoozed_until).toBe('open')
    expect(await w.commands.submit({ opId: 'op-bad', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@', until: 'someday' } })).toEqual({ ok: false, refusal: 'invalid' })
    expect(await w.commands.submit({ opId: 'op-none', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@2001-01-01', until: 'open' } })).toEqual({ ok: false, refusal: 'unknown_task' })
  })

  it('close drops a task not needed after the window; undo inside it leaves the task as it was', async () => {
    const w = world([owned('t1', { delegate: 'atlas' }, 'active'), owned('t2')])
    await w.commands.submit({ opId: 'op-c1', kind: 'close', spaceId: 'main', taskId: 't1' })
    await w.commands.submit({ opId: 'op-c2', kind: 'close', spaceId: 'main', taskId: 't2' })
    expect(await w.commands.undo('op-c2')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts.map((p) => p.path)).toEqual(['/task/t1/track'])
    expect(w.posts[0].body).toEqual({ status: 'invalidated', outcome: 'Closed by the owner on the task board', waits: null, text: 'Closed on the task board by the owner: not needed.' })
    expect(w.byId.get('t2')!.status).toBe('planned')
  })

  it('refuses to close a closed task, one with open steps, or one with bound decisions or notes', async () => {
    const steps = { relations: [{ source_id: 's1', target_id: 'p1', relation: 'part_of' }, { source_id: 's2', target_id: 'p1', relation: 'part_of' }] }
    const w = world([{ ...owned('p1', {}, 'active'), ...steps }, owned('s1', {}, 'resolved'), owned('s2'), owned('done', {}, 'resolved')])
    expect(await w.commands.submit({ opId: 'op-1', kind: 'close', spaceId: 'main', taskId: 'done' })).toMatchObject({ ok: false, refusal: 'task_closed' })
    expect(await w.commands.submit({ opId: 'op-2', kind: 'close', spaceId: 'main', taskId: 'p1' })).toMatchObject({ ok: false, refusal: 'open_steps' })
    w.byId.get('s2')!.status = 'invalidated'
    expect(await w.commands.submit({ opId: 'op-3', kind: 'close', spaceId: 'main', taskId: 'p1' })).toMatchObject({ ok: true })

    const bound = world([owned('t3', {}, 'active')], { bound: ['n1'] })
    expect(await bound.commands.submit({ opId: 'op-4', kind: 'close', spaceId: 'main', taskId: 't3' })).toMatchObject({ ok: false, refusal: 'bound_items' })
  })
})

describe('reopen', () => {
  it('a reopen drops a delegation request, so nothing starts without a new Delegate now (v0.23)', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-19T09:00:00.000Z' }
    const w = world([owned('t1', { delegate: 'atlas', checkpoint: 'after', delegation }, 'resolved')])
    await w.commands.submit({ opId: 'op-rq', kind: 'reopen', spaceId: 'main', taskId: 't1' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body).toEqual({ status: 'active', waits: null, delegation: { agent: 'atlas', checkpoint: 'after' }, text: 'Reopened on the task board by the owner.' })
  })

  it('reopens a closed task as active after the window: wait cleared, delegate and checkpoint kept, nothing started', async () => {
    const w = world([owned('t1', { delegate: 'atlas', checkpoint: 'after', waiting_on: { who: 'lasse', kind: 'review' } }, 'resolved')])
    const r = await w.commands.submit({ opId: 'op-r', kind: 'reopen', spaceId: 'main', taskId: 't1', reason: 'Lasse found a bug' })
    expect(r).toMatchObject({ ok: true, command: { state: 'pending', kind: 'reopen' } })
    await w.commands.tick()
    expect(w.posts).toEqual([])
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { status: 'active', waits: null, text: 'Reopened on the task board by the owner. Why: Lasse found a bug' } }])
    expect(w.byId.get('t1')).toMatchObject({ status: 'active', properties: { delegate: 'atlas', checkpoint: 'after' } })
    // waits: null clears the wait; core clears waiting_on with it (packages/core task-state.ts)
    expect(w.jobs).toEqual([])
  })

  it('undo inside the window leaves the task closed; the same opId twice reopens once', async () => {
    const w = world([owned('t1', {}, 'invalidated'), owned('t2', {}, 'resolved')])
    await w.commands.submit({ opId: 'op-u', kind: 'reopen', spaceId: 'main', taskId: 't1' })
    expect(await w.commands.undo('op-u')).toEqual({ ok: true })
    await w.commands.submit({ opId: 'op-2', kind: 'reopen', spaceId: 'main', taskId: 't2' })
    await w.commands.submit({ opId: 'op-2', kind: 'reopen', spaceId: 'main', taskId: 't2' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts.map((p) => p.path)).toEqual(['/task/t2/track'])
    expect(w.byId.get('t1')!.status).toBe('invalidated')
  })

  it('refuses an open task, an unknown one, another owner\'s, a replaced one and one under a closed parent', async () => {
    const w = world([
      owned('open', {}, 'active'),
      { id: 'theirs', status: 'resolved', properties: { assignee_ids: ['dominik'] } },
      { ...owned('old', {}, 'resolved'), relations: [{ source_id: 'new', target_id: 'old', relation: 'supersedes' }] },
      { ...owned('new', { display_title: 'The new plan' }, 'active') },
      owned('gone', {}, 'superseded'),
      { ...owned('step', {}, 'resolved'), relations: [{ source_id: 'step', target_id: 'parent', relation: 'part_of' }] },
      owned('parent', { display_title: 'Big parent' }, 'resolved'),
    ])
    const reopen = (taskId: string) => w.commands.submit({ opId: `op-${taskId}`, kind: 'reopen', spaceId: 'main', taskId })
    expect(await reopen('open')).toMatchObject({ ok: false, refusal: 'task_open' })
    expect(await reopen('nope')).toMatchObject({ ok: false, refusal: 'unknown_task' })
    expect(await reopen('theirs')).toMatchObject({ ok: false, refusal: 'not_owner', message: expect.stringContaining('dominik') })
    expect(await reopen('old')).toMatchObject({ ok: false, refusal: 'superseded', message: expect.stringContaining('The new plan') })
    expect(await reopen('gone')).toMatchObject({ ok: false, refusal: 'superseded' })
    expect(await reopen('step')).toMatchObject({ ok: false, refusal: 'parent_closed', message: expect.stringContaining('Big parent') })
    // Once the replacement is dropped and the parent is open again, both may come back.
    w.byId.get('new')!.status = 'invalidated'
    w.byId.get('parent')!.status = 'active'
    expect(await reopen('old')).toMatchObject({ ok: true })
    expect(await reopen('step')).toMatchObject({ ok: true })
    expect(w.posts).toEqual([])
  })

  it('leaves closed steps closed and lists what closed with the task for the chat', async () => {
    const steps = { relations: [{ source_id: 's1', target_id: 'p1', relation: 'part_of' }, { source_id: 's2', target_id: 'p1', relation: 'part_of' }] }
    const w = world([{ ...owned('p1', {}, 'resolved'), ...steps }, owned('s1', {}, 'resolved'), owned('s2', {}, 'invalidated')],
      { candidates: [{ id: 'd1', type: 'decision', title: 'use-postgres', status: 'resolved' }] })
    await w.commands.submit({ opId: 'op-p', kind: 'reopen', spaceId: 'main', taskId: 'p1' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body.text).toBe('Reopened on the task board by the owner. 2 closed steps stay closed.')
    expect(w.posts[1].body.text).toContain('decision use-postgres (d1)')
    expect(w.byId.get('s1')!.status).toBe('resolved')
    expect(w.commands.reopenedWith('p1')).toEqual([{ id: 'd1', type: 'decision', title: 'use-postgres' }])
  })

  it('fails instead of reopening when the task changed in the window', async () => {
    const w = world([owned('t1', {}, 'resolved')])
    await w.commands.submit({ opId: 'op-f', kind: 'reopen', spaceId: 'main', taskId: 't1' })
    w.byId.get('t1')!.status = 'active'
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.store.get('op-f')).toMatchObject({ state: 'failed', error: 'task_open' })
  })
})

describe('work on it now ends (B2)', () => {
  /** A world whose sessions on the task are listed by `sessions` (createdAt, archived). */
  const together = (props: Record<string, unknown> = {}, status = 'planned') => {
    const w = world([owned('t1', props, status)])
    const sessions: Array<{ createdAt: string; archived: boolean }> = []
    const commands = createTaskCommands({
      ...w.deps,
      sessionsSince: (_taskId, since) => {
        const on = sessions.filter((s) => Date.parse(s.createdAt) >= Date.parse(since))
        return { total: on.length, open: on.filter((s) => !s.archived).length }
      },
    })
    const open = () => { sessions.push({ createdAt: new Date(w.clock.now + 1000).toISOString(), archived: false }); return sessions.at(-1)! }
    return { ...w, commands, sessions, open }
  }
  const workOnItNow = { mode: 'together' as const, delegate: 'atlas', checkpoint: 'after', desk: 'Main' }

  it('holds the runner off while the session is open, then records the release once it is put away (no delegation to clear)', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    expect(w.byId.get('t1')!.properties.delegate).toBeUndefined()
    expect(w.byId.get('t1')!.properties.delegation).toBeUndefined()
    expect(w.commands.together('t1')).toBe(true)
    // Before the page opened the pane, and while it is open: nothing is released.
    await w.commands.tick()
    const pane = w.open()
    w.later(60_000)
    await w.commands.tick()
    expect(w.posts).toHaveLength(1)
    expect(w.commands.together('t1')).toBe(true)

    pane.archived = true
    await w.commands.tick()
    // Work on it now wrote no delegation, so nothing is written on its end; the board offers "Hand to atlas".
    expect(w.posts).toHaveLength(1)
    expect(w.commands.together('t1')).toBe(false)
    expect(w.commands.releasedAgent('t1')).toBe('atlas')
    await w.commands.tick()
    expect(w.posts).toHaveLength(1)
  })

  it('take over opens the task\'s own session: no desk needed, the delegation goes, and it lasts while that session is open', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-19T09:00:00.000Z' }
    const base = together({ delegate: 'atlas', delegation }, 'active')
    let open = true
    const commands = createTaskCommands({ ...base.deps, ownSession: (id) => (id === 't1' ? 'desk-1' : null), sessionOpen: (id) => id === 'desk-1' && open })
    const r = await commands.submit({ opId: 'op-take', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'applied', tookOver: 'desk-1' } })
    expect(base.posts[0].body).toMatchObject({ delegation: null })
    expect(base.posts[0].body.text).toBe('Taken over by the owner in its session. atlas is no longer delegated, so it does not go on alone; a turn it is in finishes first.')
    expect(commands.together('t1')).toBe(true)
    // no session opened since, but the one it took over is open: it outlasts the grace time
    base.later(TOGETHER_GRACE_MS + 1000)
    await commands.tick()
    expect(commands.together('t1')).toBe(true)
    open = false
    await commands.tick()
    expect(commands.together('t1')).toBe(false)
    expect(commands.releasedAgent('t1')).toBe('atlas')
  })

  it('work on it now on a task without an own session still needs a desk: without one it is refused as no_session', async () => {
    const w = together()
    const commands = createTaskCommands({ ...w.deps, ownSession: () => null })
    expect(await commands.submit({ opId: 'op-nodesk', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas' } }))
      .toEqual({ ok: false, refusal: 'no_session' })
  })

  it('releases it when no session ever opened, after the grace time', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg2', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    w.later(TOGETHER_GRACE_MS - 1000)
    await w.commands.tick()
    expect(w.commands.together('t1')).toBe(true)
    w.later(2000)
    await w.commands.tick()
    expect(w.commands.together('t1')).toBe(false)
    expect(w.byId.get('t1')!.properties.delegate).toBeUndefined()
  })

  it('a later Delegate now replaces it: the agent is not released and the runner may start it', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg3', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    const pane = w.open()
    w.later(60_000)
    await w.commands.submit({ opId: 'op-now', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    expect(w.commands.together('t1')).toBe(false)
    w.later(UNDO_WINDOW_MS + 1)
    pane.archived = true
    await w.commands.tick()
    expect(w.byId.get('t1')!.properties.delegation).toMatchObject({ agent: 'atlas', checkpoint: 'after' })
    expect(w.posts.some((p) => p.body.delegation === null || p.body.delegate === null)).toBe(false)
    expect(w.commands.delegatedAt('t1')).toBe(new Date(Date.parse('2026-11-19T10:00:00Z') + 60_000).toISOString())
    expect(w.commands.releasedAgent('t1')).toBeNull()
  })

  it('leaves a task whose delegate changed meanwhile, or that was undone, as it is', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg4', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    w.byId.get('t1')!.properties.delegate = 'motti'
    w.open().archived = true
    await w.commands.tick()
    expect(w.byId.get('t1')!.properties.delegate).toBe('motti')
    expect(w.commands.together('t1')).toBe(false)

    const u = together()
    await u.commands.submit({ opId: 'op-tg5', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    expect(await u.commands.undo('op-tg5')).toEqual({ ok: true })
    expect(u.commands.together('t1')).toBe(false)
  })

  it('keeps an open Work on it now past the week other commands are kept', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg6', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    w.open()
    w.later(8 * 24 * 60 * 60 * 1000)
    await w.commands.submit({ opId: 'op-snooze', kind: 'snooze', spaceId: 'main', snooze: { key: 'x', until: new Date(w.clock.now + 60_000).toISOString() } })
    expect(w.commands.together('t1')).toBe(true)
  })
})

describe('send in a closed task\'s chat', () => {
  const chatWorld = (tasks: Task[], opts: { newest?: string | null; delivers?: boolean; starts?: string | null } = {}) => {
    const w = world(tasks)
    const delivered: Array<{ sessionId: string; text: string }> = []
    const started: Array<{ taskId: string; prompt: string }> = []
    const commands = createTaskCommands({
      ...w.deps,
      newestSessionOn: () => opts.newest === undefined ? 's-newest' : opts.newest,
      deliver: async (sessionId, text) => { delivered.push({ sessionId, text }); return opts.delivers ?? true },
      startOnTask: async (_space, taskId, prompt) => { started.push({ taskId, prompt }); return opts.starts === undefined ? 's-started' : opts.starts },
    })
    return { ...w, commands, delivered, started }
  }

  it('reopens after the undo window, then gives the message to the newest session', async () => {
    const w = chatWorld([owned('t1', { delegate: 'atlas', checkpoint: 'before' }, 'resolved')])
    const r = await w.commands.submit({ opId: 'op-s', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'One more thing:\nthe badge is off' })
    expect(r).toMatchObject({ ok: true, command: { state: 'pending' } })
    await w.commands.tick()
    expect(w.delivered).toEqual([])
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.byId.get('t1')!.status).toBe('active')
    expect(w.posts[0].body.text).toBe('Reopened by writing in its chat: "One more thing:".')
    expect(w.delivered).toEqual([{ sessionId: 's-newest', text: 'One more thing:\nthe badge is off' }])
    expect(w.started).toEqual([])
    expect(w.store.get('op-s')).toMatchObject({ state: 'applied', continued: { sessionId: 's-newest', how: 'delivered' } })
  })

  it('undo inside the window: the task stays closed and no session gets the message', async () => {
    const w = chatWorld([owned('t1', {}, 'resolved')])
    await w.commands.submit({ opId: 'op-u', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'hello' })
    expect(await w.commands.undo('op-u')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.byId.get('t1')!.status).toBe('resolved')
    expect(w.delivered).toEqual([])
  })

  it('starts a session with the message when the task has none, or the newest can\'t take it', async () => {
    const none = chatWorld([owned('t1', {}, 'resolved')], { newest: null })
    await none.commands.submit({ opId: 'op-n', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'go on' })
    none.later(UNDO_WINDOW_MS + 1)
    await none.commands.tick()
    expect(none.started).toEqual([{ taskId: 't1', prompt: 'go on' }])
    expect(none.store.get('op-n')).toMatchObject({ continued: { sessionId: 's-started', how: 'started' } })

    const refused = chatWorld([owned('t1', {}, 'resolved')], { delivers: false, starts: null })
    await refused.commands.submit({ opId: 'op-f', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'go on' })
    refused.later(UNDO_WINDOW_MS + 1)
    await refused.commands.tick()
    expect(refused.byId.get('t1')!.status).toBe('active')
    expect(refused.store.get('op-f')).toMatchObject({ state: 'applied', continued: { how: 'failed' } })
  })

  it('after a crash between the reopen and the delivery, the retry still gives the message once', async () => {
    const w = chatWorld([owned('t1', {}, 'active')])
    // As the store holds it when the host died right after the reopen was recorded.
    w.store.put({ opId: 'op-c', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'go on', createdAt: '', undoUntil: new Date(w.clock.now - 1).toISOString(), state: 'pending', reopened: { items: [], closedSteps: 0 } }, w.clock.now)
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.delivered).toEqual([{ sessionId: 's-newest', text: 'go on' }])
    expect(w.store.get('op-c')).toMatchObject({ state: 'applied', continued: { how: 'delivered' } })
  })

  it('refuses an empty or oversized message with what to change, and keeps the reopen rules', async () => {
    const w = chatWorld([owned('t1', {}, 'resolved'), { id: 'theirs', status: 'resolved', properties: { assignee_ids: ['dominik'] } }])
    expect(await w.commands.submit({ opId: 'a', kind: 'reopen', spaceId: 'main', taskId: 't1', message: '  ' })).toMatchObject({ ok: false, refusal: 'invalid', message: expect.stringContaining(`at most ${MESSAGE_MAX}`) })
    expect(await w.commands.submit({ opId: 'b', kind: 'reopen', spaceId: 'main', taskId: 't1', message: 'x'.repeat(MESSAGE_MAX + 1) })).toMatchObject({ ok: false, refusal: 'invalid' })
    expect(await w.commands.submit({ opId: 'c', kind: 'reopen', spaceId: 'main', taskId: 'theirs', message: 'hi' })).toMatchObject({ ok: false, refusal: 'not_owner' })
  })

  it('firstLine is the flat first line, cut at 120 characters', () => {
    expect(firstLine('  a   b\nsecond')).toBe('a b')
    expect(firstLine('y'.repeat(200))).toHaveLength(120)
  })
})

describe('as follow-up', () => {
  it('makes a planned task in the same project with owner, delegate and checkpoint, linked to the one it follows', async () => {
    const w = world([{ ...owned('t1', { delegate: 'atlas', checkpoint: 'before', display_title: 'Build the fold' }, 'resolved'), scope: 'project.ui', title: 'build-fold' }])
    const r = await w.commands.submit({ opId: 'op-f', kind: 'follow_up', spaceId: 'main', taskId: 't1', message: 'Now the phone layout' })
    expect(r).toMatchObject({ ok: true, command: { state: 'pending', kind: 'follow_up' } })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    const created = w.posts.find((p) => p.path === '/engram/task')!.body
    expect(created).toEqual({
      title: 'follow-up-build-fold', display_title: 'Follow-up: Build the fold', content: 'Now the phone layout', scope: 'project.ui', status: 'planned',
      assignee_ids: ['lasse'], delegate: 'atlas', checkpoint: 'before',
    })
    const id = w.store.get('op-f')!.followUp!.taskId
    expect(w.posts.find((p) => p.path === '/relate')!.body).toMatchObject({ source_id: id, target_id: 't1', relation: 'derived_from' })
    expect(w.posts.filter((p) => p.path.endsWith('/track')).map((p) => p.path)).toEqual([`/task/${id}/track`, '/task/t1/track'])
    expect(w.byId.get('t1')!.status).toBe('resolved')
    expect(w.store.get('op-f')).toMatchObject({ state: 'applied', followUp: { taskId: id, linked: true, journaled: true } })
  })

  it('refuses without a message, an unknown task, or someone else\'s task; undo makes nothing', async () => {
    const w = world([owned('t1', {}, 'resolved'), { id: 'theirs', status: 'resolved', properties: { assignee_ids: ['dominik'] } }])
    expect(await w.commands.submit({ opId: 'a', kind: 'follow_up', spaceId: 'main', taskId: 't1' })).toMatchObject({ ok: false, refusal: 'invalid' })
    expect(await w.commands.submit({ opId: 'b', kind: 'follow_up', spaceId: 'main', taskId: 'nope', message: 'x' })).toMatchObject({ ok: false, refusal: 'unknown_task' })
    expect(await w.commands.submit({ opId: 'c', kind: 'follow_up', spaceId: 'main', taskId: 'theirs', message: 'x' })).toMatchObject({ ok: false, refusal: 'not_owner' })
    await w.commands.submit({ opId: 'd', kind: 'follow_up', spaceId: 'main', taskId: 't1', message: 'x' })
    await w.commands.undo('d')
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([])
  })
})

describe('writing in a closed task\'s session', () => {
  it('reopens a closed task, leaves an open one, and journals why one that can\'t reopen stays closed', async () => {
    const w = world([
      owned('done', {}, 'resolved'),
      owned('open', {}, 'active'),
      { id: 'theirs', status: 'resolved', properties: { assignee_ids: ['dominik'] } },
    ])
    expect(await w.commands.reopenByWriting('main', 'done')).toBe('reopened')
    expect(w.byId.get('done')!.status).toBe('active')
    expect(w.posts[0]).toEqual({ path: '/task/done/track', body: { status: 'active', waits: null, text: 'Reopened by writing in its chat.' } })
    expect(await w.commands.reopenByWriting('main', 'open')).toBe('open')
    expect(await w.commands.reopenByWriting('main', 'theirs')).toBe('refused')
    expect(w.byId.get('theirs')!.status).toBe('resolved')
    expect(w.posts.at(-1)!.body.text).toContain('stays closed')
    expect(await w.commands.reopenByWriting('elsewhere', 'done')).toBe('refused')
  })
})

// A task whose schedule is still on is not closed: Looks good approves one run, Close is refused,
// End schedule ends its jobs and closes it, and a run that comes due on a closed task reopens it.
describe('a task whose schedule is still on', () => {
  type TestJob = { id: string; name: string; endedAt?: string }
  /** The world with this cockpit's jobs per task; whether a task's schedule is on is the domain's rule (hasSchedule). */
  const scheduledWorld = (tasks: Task[], jobsByTask: Record<string, TestJob[]> = {}, opts: Parameters<typeof world>[1] = {}) => {
    const w = world(tasks, opts)
    const jobs = new Map(Object.entries(jobsByTask))
    const ended: string[] = []
    w.deps.scheduled = (task) => hasSchedule({ jobs: (jobs.get(task.id) ?? []).map((j) => ({ endedAt: j.endedAt ?? null })), schedule: task.properties?.delegation?.schedule, owner: task.properties?.assignee_ids?.[0] }, w.deps.viewer, w.clock.now)
    w.deps.openJobsOf = (taskId) => (jobs.get(taskId) ?? []).filter((j) => !j.endedAt).map(({ id, name }) => ({ id, name }))
    const end = (jobId: string) => { for (const list of jobs.values()) for (const j of list) if (j.id === jobId) j.endedAt = new Date(w.clock.now).toISOString() }
    w.deps.endJob = (jobId) => { ended.push(jobId); end(jobId) }
    return { ...w, scheduledJobs: jobs, ended, end }
  }
  const job = (id = 'j1', name = 'Daily brief'): TestJob[] => [{ id, name }]
  const review = { id: 's1', who: 'lasse', kind: 'review', why: 'Review: brief written', since: '2026-11-19T08:00:00.000Z', session_id: 's1' }
  const question = { id: 's2', who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T08:30:00.000Z', session_id: 's2' }
  const outside = { id: 'kim', who: 'kim', kind: 'review', why: 'Kim reads the draft', since: '2026-11-19T07:00:00.000Z' }
  const mirrored = { cron: '0 8 * * *', time_zone: 'UTC' }

  it('looks good approves that one run: the owner\'s review is answered, other waits stay, the task stays open', async () => {
    const w = scheduledWorld([owned('daily', { delegate: 'atlas', waits: [review, question, outside] }, 'active')], { daily: job() }, { bound: ['d1'] })
    // What would stop a close (bound decisions) does not stop a review that closes nothing.
    expect(await w.commands.submit({ opId: 'op-r', kind: 'review', spaceId: 'main', taskId: 'daily' }))
      .toMatchObject({ ok: true, command: { runOnly: true, approves: [{ id: 's1', since: review.since }] } })
    await w.commands.tick()
    expect(w.posts).toEqual([])
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    await w.commands.tick()
    expect(w.posts).toEqual([{ path: '/task/daily/track', body: { waits: [question, outside], text: 'Run reviewed by the owner: looks good.' } }])
    expect(w.byId.get('daily')!.status).toBe('active')
    expect(w.store.get('op-r')!.state).toBe('applied')
  })

  it('looks good on a scheduled task without a review to answer writes nothing; undo leaves no trace', async () => {
    const w = scheduledWorld([owned('daily', { waits: [question] }, 'active'), owned('weekly', { waits: [review] }, 'active')], { daily: job(), weekly: job('j2') })
    await w.commands.submit({ opId: 'op-1', kind: 'review', spaceId: 'main', taskId: 'daily' })
    await w.commands.submit({ opId: 'op-2', kind: 'review', spaceId: 'main', taskId: 'weekly' })
    expect(await w.commands.undo('op-2')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.store.get('op-1')!.state).toBe('applied')
    expect(w.byId.get('weekly')!.properties.waits).toEqual([review])
  })

  it('approving a run applied twice (a crash before it was recorded) writes once, and never takes off a later run\'s review', async () => {
    const w = scheduledWorld([owned('daily', { waits: [review, question] }, 'active')], { daily: job() })
    await w.commands.submit({ opId: 'op-r', kind: 'review', spaceId: 'main', taskId: 'daily' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toHaveLength(1)
    // The host stopped after the write and before the command was recorded as applied; meanwhile the next run of
    // the same session handed its result over for review.
    const next = { ...review, why: 'Review: next brief written', since: '2026-11-20T08:00:00.000Z' }
    w.byId.get('daily')!.properties.waits = [question, next]
    w.store.put({ ...w.store.get('op-r')!, state: 'pending' }, w.clock.now)
    const restarted = createTaskCommands({ ...w.deps, store: new TaskCommandStore(w.store.file) })
    await restarted.tick()
    expect(w.posts).toHaveLength(1)
    expect(w.byId.get('daily')!.properties.waits).toEqual([question, next])

    // A review that came in inside the undo window is not what the owner approved either.
    const late = scheduledWorld([owned('weekly', { waits: [review] }, 'active')], { weekly: job() })
    await late.commands.submit({ opId: 'op-l', kind: 'review', spaceId: 'main', taskId: 'weekly' })
    late.byId.get('weekly')!.properties.waits = [review, { ...next, id: 's9', session_id: 's9' }]
    late.later(UNDO_WINDOW_MS + 1)
    await late.commands.tick()
    expect(late.posts.map((p) => p.body.waits)).toEqual([[{ ...next, id: 's9', session_id: 's9' }]])
  })

  it('looks good answers what the Inbox shows as a review: a wait from before kinds existed whose why says so', async () => {
    const w = scheduledWorld([owned('daily', { waiting_on: { who: 'lasse', why: 'Review: brief written' } }, 'active')], { daily: job() })
    await w.commands.submit({ opId: 'op-r', kind: 'review', spaceId: 'main', taskId: 'daily' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([{ path: '/task/daily/track', body: { waits: null, text: 'Run reviewed by the owner: looks good.' } }])
  })

  it('whether it closes is decided when it is applied: a schedule on at either end of the undo window keeps the task open', async () => {
    // On when chosen, its job ended by the time it applies: still one run's review.
    const ended = scheduledWorld([owned('t1', { waits: [review] }, 'active')], { t1: job() })
    await ended.commands.submit({ opId: 'op-1', kind: 'review', spaceId: 'main', taskId: 't1' })
    ended.end('j1')
    ended.later(UNDO_WINDOW_MS + 1)
    await ended.commands.tick()
    expect(ended.byId.get('t1')!.status).toBe('active')
    expect(ended.posts[0].body).toEqual({ waits: null, text: 'Run reviewed by the owner: looks good.' })

    // Not on when chosen, a job made inside the window: not closed either.
    const added = scheduledWorld([owned('t2', { waits: [review] }, 'active')])
    await added.commands.submit({ opId: 'op-2', kind: 'review', spaceId: 'main', taskId: 't2' })
    added.scheduledJobs.set('t2', job())
    added.later(UNDO_WINDOW_MS + 1)
    await added.commands.tick()
    expect(added.byId.get('t2')!.status).toBe('active')
    expect(added.posts[0].body).toEqual({ waits: null, text: 'Run reviewed by the owner: looks good.' })

    // No schedule at all: Looks good closes it.
    const plain = scheduledWorld([owned('t3', { waits: [review] }, 'active')])
    await plain.commands.submit({ opId: 'op-3', kind: 'review', spaceId: 'main', taskId: 't3' })
    plain.later(UNDO_WINDOW_MS + 1)
    await plain.commands.tick()
    expect(plain.posts[0].body).toEqual({ status: 'resolved', outcome: 'Reviewed and closed by the owner', waits: null, text: 'Looks good: the owner reviewed the result and closed the task.' })
  })

  it('refuses Close while its schedule is on, and does not close one that got a job inside the undo window', async () => {
    const w = scheduledWorld([owned('daily', {}, 'active'), owned('once', {}, 'active')], { daily: job() })
    expect(SCHEDULE_ON).toBe('Its schedule is still on: use End schedule and close.')
    expect(await w.commands.submit({ opId: 'op-1', kind: 'close', spaceId: 'main', taskId: 'daily' })).toEqual({ ok: false, refusal: 'scheduled', message: SCHEDULE_ON })
    expect(await w.commands.submit({ opId: 'op-2', kind: 'close', spaceId: 'main', taskId: 'once' })).toMatchObject({ ok: true })
    w.scheduledJobs.set('once', job('j2'))
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts).toEqual([])
    expect(w.byId.get('once')!.status).toBe('active')
    expect(w.store.get('op-2')).toMatchObject({ state: 'failed', error: SCHEDULE_ON })
  })

  it('a task with a one-time job that has not run is scheduled; once the job ran and ended it closes like any other', async () => {
    const w = scheduledWorld([owned('once', { waits: [review] }, 'active'), owned('twice', {}, 'active')], { once: job('j1', 'Check reply'), twice: job('j2', 'Check again') })
    expect(await w.commands.submit({ opId: 'op-1', kind: 'close', spaceId: 'main', taskId: 'once' })).toMatchObject({ ok: false, refusal: 'scheduled' })
    w.end('j1')
    w.end('j2')
    expect(await w.commands.submit({ opId: 'op-2', kind: 'review', spaceId: 'main', taskId: 'once' })).toMatchObject({ ok: true, command: { kind: 'review' } })
    expect(w.store.get('op-2')!.runOnly).toBeUndefined()
    expect(await w.commands.submit({ opId: 'op-3', kind: 'close', spaceId: 'main', taskId: 'twice' })).toMatchObject({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.byId.get('once')!.status).toBe('resolved')
    expect(w.byId.get('twice')!.status).toBe('invalidated')
  })

  it('End schedule ends every open job of the task after the window, then closes it as done and takes the mirrored schedule off', async () => {
    const jobs = { daily: [{ id: 'j1', name: 'Daily brief' }, { id: 'j2', name: 'Check reply' }], other: [{ id: 'j9', name: 'Other' }] }
    const delegation = { agent: 'atlas', checkpoint: 'after', schedule: mirrored }
    const w = scheduledWorld([owned('daily', { delegation, waits: [review] }, 'active'), owned('other', {}, 'active')], jobs)
    expect(await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' }))
      .toMatchObject({ ok: true, command: { state: 'pending', undoUntil: new Date(w.clock.now + UNDO_WINDOW_MS).toISOString() } })
    await w.commands.tick()
    expect(w.ended).toEqual([])
    expect(w.posts).toEqual([])

    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    await w.commands.tick()
    expect(w.ended).toEqual(['j1', 'j2'])
    // One write closes it and clears the schedule its jobs mirrored into it: the mirror leaves a closed task alone.
    expect(w.posts).toEqual([{ path: '/task/daily/track', body: {
      status: 'resolved', outcome: 'Schedule ended and task closed by the owner', waits: null, delegation: { agent: 'atlas', checkpoint: 'after' },
      text: 'The owner ended its schedule (2 jobs: Daily brief, Check reply) and closed the task.',
    } }])
    expect(w.byId.get('daily')!.status).toBe('resolved')
    expect(w.store.get('op-e')).toMatchObject({ state: 'applied', endedJobs: [{ id: 'j1', name: 'Daily brief' }, { id: 'j2', name: 'Check reply' }] })
    expect(await w.commands.undo('op-e')).toEqual({ ok: false, refusal: 'undo_expired' })
  })

  it('End schedule undone inside the window ends no job and leaves the task open; the same opId twice does it once', async () => {
    const w = scheduledWorld([owned('daily', {}, 'active')], { daily: job() })
    await w.commands.submit({ opId: 'op-u', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' })
    expect(await w.commands.undo('op-u')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.ended).toEqual([])
    expect(w.posts).toEqual([])

    await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' })
    await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.ended).toEqual(['j1'])
    expect(w.posts.map((p) => p.body.text)).toEqual(['The owner ended its schedule (1 job: Daily brief) and closed the task.'])
  })

  it('End schedule cut off by a crash after its jobs ended still closes the task and names them', async () => {
    const w = scheduledWorld([owned('daily', {}, 'active')], { daily: job() })
    await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' })
    w.later(UNDO_WINDOW_MS + 1)
    // The host stopped after the jobs were listed and ended, before the task was closed.
    w.store.put({ ...w.store.get('op-e')!, endedJobs: [{ id: 'j1', name: 'Daily brief' }] }, w.clock.now)
    w.end('j1')
    const restarted = createTaskCommands({ ...w.deps, store: new TaskCommandStore(w.store.file) })
    await restarted.tick()
    expect(w.ended).toEqual(['j1'])
    expect(w.posts.map((p) => p.body.text)).toEqual(['The owner ended its schedule (1 job: Daily brief) and closed the task.'])
    expect(w.byId.get('daily')!.status).toBe('resolved')
  })

  it('End schedule takes a task whose only job is paused or woken by mail only: no run is coming up, but the job could come back', async () => {
    const w = scheduledWorld([owned('paused', {}, 'active')], { paused: job('j1', 'Paused job') })
    // Its schedule is on, so it is not closed any other way.
    expect(await w.commands.submit({ opId: 'op-c', kind: 'close', spaceId: 'main', taskId: 'paused' })).toMatchObject({ ok: false, refusal: 'scheduled' })
    expect(await w.commands.submit({ opId: 'op-p', kind: 'end_schedule', spaceId: 'main', taskId: 'paused' })).toMatchObject({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.ended).toEqual(['j1'])
    expect(w.byId.get('paused')!.status).toBe('resolved')
  })

  it('refuses End schedule for a task without a job, a closed one, another owner\'s, and what stops a close', async () => {
    const steps = { relations: [{ source_id: 'step', target_id: 'parent', relation: 'part_of' }] }
    const w = scheduledWorld([
      owned('plain', {}, 'active'), owned('done', {}, 'resolved'),
      { id: 'theirs', status: 'active', properties: { assignee_ids: ['dominik'] } },
      { ...owned('parent', {}, 'active'), ...steps }, owned('step'),
    ], { theirs: job('j1'), parent: job('j2'), done: job('j3') })
    const end = (taskId: string) => w.commands.submit({ opId: `op-${taskId}`, kind: 'end_schedule', spaceId: 'main', taskId })
    expect(await end('plain')).toEqual({ ok: false, refusal: 'not_scheduled', message: 'It has no schedule to end: close it instead.' })
    expect(await end('done')).toEqual({ ok: false, refusal: 'task_closed' })
    expect(await end('theirs')).toEqual({ ok: false, refusal: 'not_owner', message: 'Only its owner (dominik) can end its schedule.' })
    expect(await end('parent')).toMatchObject({ ok: false, refusal: 'open_steps' })
    expect(await end('gone')).toEqual({ ok: false, refusal: 'unknown_task' })

    const bound = scheduledWorld([owned('daily', {}, 'active')], { daily: job() }, { bound: ['d1'] })
    expect(await bound.commands.submit({ opId: 'op-b', kind: 'end_schedule', spaceId: 'main', taskId: 'daily' })).toMatchObject({ ok: false, refusal: 'bound_items' })
    expect(w.ended).toEqual([])
  })

  it('a schedule left on the owner\'s own task without a job does not hold it: it closes, and End schedule sends on to Close', async () => {
    // The job ended (or was deleted) and the mirror has not cleared the schedule yet, or never will.
    const stale = { agent: 'atlas', schedule: mirrored }
    const w = scheduledWorld([owned('ended', { delegation: stale, waits: [review] }, 'active'), owned('deleted', { delegation: stale }, 'active'), owned('ask', { delegation: stale }, 'active')], { ended: [{ id: 'j1', name: 'Daily brief', endedAt: '2026-11-19T09:59:00.000Z' }] })
    expect(await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'ask' })).toEqual({ ok: false, refusal: 'not_scheduled', message: 'It has no schedule to end: close it instead.' })
    expect(await w.commands.submit({ opId: 'op-r', kind: 'review', spaceId: 'main', taskId: 'ended' })).toMatchObject({ ok: true })
    expect(w.store.get('op-r')!.runOnly).toBeUndefined()
    expect(await w.commands.submit({ opId: 'op-c', kind: 'close', spaceId: 'main', taskId: 'deleted' })).toMatchObject({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.byId.get('ended')!.status).toBe('resolved')
    expect(w.byId.get('deleted')!.status).toBe('invalidated')
  })

  it('a schedule another member\'s cockpit fires holds their task here: Close is refused, and End schedule is theirs', async () => {
    const theirs: Task = { id: 'theirs', status: 'active', properties: { assignee_ids: ['dominik'], delegation: { agent: 'atlas', schedule: mirrored } } }
    const w = scheduledWorld([theirs])
    expect(await w.commands.submit({ opId: 'op-c', kind: 'close', spaceId: 'main', taskId: 'theirs' })).toEqual({ ok: false, refusal: 'scheduled', message: SCHEDULE_ON })
    expect(await w.commands.submit({ opId: 'op-e', kind: 'end_schedule', spaceId: 'main', taskId: 'theirs' })).toMatchObject({ ok: false, refusal: 'not_owner' })
    // A cockpit that does not know who is at the page checks no owner: it still ends no schedule that is not its own.
    const anyone = scheduledWorld([{ ...theirs, properties: { ...theirs.properties } }])
    anyone.deps.viewer = undefined
    const commands = createTaskCommands(anyone.deps)
    expect(await commands.submit({ opId: 'op-a', kind: 'end_schedule', spaceId: 'main', taskId: 'theirs' })).toEqual({ ok: false, refusal: 'schedule_elsewhere', message: 'Its schedule runs in another cockpit: end it there.' })
  })

  it('a reopened task loses a schedule no job runs any more, and keeps the one of a job that is still on', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-18T09:00:00.000Z', schedule: mirrored }
    const w = scheduledWorld([owned('ended', { delegation }, 'resolved'), owned('running', { delegation }, 'resolved'), owned('written', { delegation: { agent: 'atlas', schedule: mirrored } }, 'resolved')], { ended: [{ id: 'j1', name: 'Daily brief', endedAt: '2026-11-19T09:00:00.000Z' }], running: job('j2') })
    await w.commands.submit({ opId: 'op-1', kind: 'reopen', spaceId: 'main', taskId: 'ended' })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts[0].body).toMatchObject({ status: 'active', delegation: { agent: 'atlas', checkpoint: 'after' } })
    expect(w.byId.get('ended')!.properties.delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    // Open again, it closes like any task: nothing counts as scheduled without a job.
    expect(await w.commands.submit({ opId: 'op-2', kind: 'close', spaceId: 'main', taskId: 'ended' })).toMatchObject({ ok: true })

    // A run of a job that is still on reopens its task: the schedule is that job's and stays.
    expect(await w.commands.reopenForRun('main', 'running', { number: 2, jobId: 'j2', job: 'Daily brief' })).toBe('reopened')
    expect(w.byId.get('running')!.properties.delegation).toEqual({ agent: 'atlas', checkpoint: 'after', schedule: mirrored })
    // Writing in its chat reopens it by the same rules.
    expect(await w.commands.reopenByWriting('main', 'written')).toBe('reopened')
    expect(w.byId.get('written')!.properties.delegation).toEqual({ agent: 'atlas' })
  })

  it('a run that comes due on a closed task reopens it, with what a reopen takes off a delegation', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-18T09:00:00.000Z' }
    const w = world([owned('closed', { delegation, waits: [review] }, 'resolved'), owned('dropped', {}, 'invalidated'), owned('open', {}, 'active')])
    const run = { number: 7, jobId: 'job-1234-5678', job: 'Daily brief' }
    expect(await w.commands.reopenForRun('main', 'closed', run)).toBe('reopened')
    expect(w.posts).toEqual([{ path: '/task/closed/track', body: {
      status: 'active', waits: null, delegation: { agent: 'atlas', checkpoint: 'after' },
      text: 'Reopened: run 7 of "Daily brief" came due while the task was closed. End its schedule to stop it.',
    } }])
    expect(w.changed).toContain('main')
    expect(await w.commands.reopenForRun('main', 'dropped', run)).toBe('reopened')
    expect(w.byId.get('dropped')!.status).toBe('active')
    // Open already (the next run, or a retry of this one): nothing is written.
    const before = w.posts.length
    expect(await w.commands.reopenForRun('main', 'open', run)).toBe('open')
    expect(await w.commands.reopenForRun('main', 'closed', run)).toBe('open')
    expect(w.posts).toHaveLength(before)
  })

  it('leaves a task another one replaced, one that is gone, one under a closed parent and another owner\'s closed, and logs why by code, without names', async () => {
    const logs: string[] = []
    const w = world([
      owned('replaced', {}, 'superseded'),
      { ...owned('old', {}, 'resolved'), relations: [{ source_id: 'new', target_id: 'old', relation: 'supersedes' }] }, owned('new', { display_title: 'The new plan' }, 'active'),
      { ...owned('step', {}, 'resolved'), relations: [{ source_id: 'step', target_id: 'parent', relation: 'part_of' }] }, owned('parent', { display_title: 'Parent' }, 'resolved'),
      { id: 'theirs', status: 'resolved', properties: { assignee_ids: ['dominik'] } },
      owned('closed', {}, 'resolved'),
    ])
    w.deps.log = (line) => logs.push(line)
    const run = { number: 2, jobId: 'job-1234-5678', job: 'Check reply' }
    for (const id of ['replaced', 'old', 'step', 'theirs', 'gone']) expect(await w.commands.reopenForRun('main', id, run)).toBe('refused')
    expect(await w.commands.reopenForRun('elsewhere', 'old', run)).toBe('refused')
    expect(await w.commands.reopenForRun('main', 'closed', run)).toBe('reopened')
    expect(w.posts).toHaveLength(1)
    expect(logs).toEqual([
      '[commands] task replaced, run 2 of job job-1234: the task stays closed (superseded)',
      '[commands] task old, run 2 of job job-1234: the task stays closed (superseded)',
      '[commands] task step, run 2 of job job-1234: the task stays closed (parent_closed)',
      '[commands] task theirs, run 2 of job job-1234: the task stays closed (not_owner)',
      '[commands] task gone, run 2 of job job-1234: the task stays closed (unknown_task)',
      '[commands] task old, run 2 of job job-1234: no brain to check whether the task is closed',
      '[commands] task closed, run 2 of job job-1234: the task was closed and is reopened',
    ])
  })

  it('a task that stays closed when its chat gets a message has the reason in words in its journal', async () => {
    const w = world([{ ...owned('old', {}, 'resolved'), relations: [{ source_id: 'new', target_id: 'old', relation: 'supersedes' }] }, owned('new', { display_title: 'The new plan' }, 'active')])
    expect(await w.commands.reopenByWriting('main', 'old')).toBe('refused')
    expect(w.posts).toEqual([{ path: '/task/old/track', body: { text: 'Its chat got a message, but the task stays closed: "The new plan" replaced this task: go on there.' } }])
  })

  it('a brain that fails while reopening is logged, not thrown: the run starts anyway', async () => {
    const logs: string[] = []
    const w = world([owned('closed', {}, 'resolved')])
    w.deps.log = (line) => logs.push(line)
    const brain = w.deps.brain({} as never)!
    w.deps.brain = () => ({ get: brain.get, post: async () => { throw new Error('brain is down') } })
    expect(await w.commands.reopenForRun('main', 'closed', { number: 1, jobId: 'job-1234-5678', job: 'Daily brief' })).toBe('refused')
    expect(logs.at(-1)).toContain('reopening the task failed: brain is down')
  })

  it('a job the hand-over makes does not restate what every run of it reads in its header: the rule is written once', async () => {
    const { JOB_TASK_RULE } = await import('../src/domain/job.js')
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-s', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'schedule', delegate: 'atlas', checkpoint: 'none', schedule: { cron: '0 8 * * 1-5', timeZone: 'UTC' } } })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.jobs[0].prompt).not.toContain(JOB_TASK_RULE)
    expect(w.jobs[0].prompt).not.toMatch(/never close/i)
  })
})
