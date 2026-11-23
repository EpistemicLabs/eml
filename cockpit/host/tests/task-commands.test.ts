import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mirroredHandOver } from '../src/domain/hand-over.js'
import { createTaskCommands, TaskCommandStore, TOGETHER_GRACE_MS, TOGETHER_SCAN_MS, UNDO_WINDOW_MS, type TaskCommandsDeps } from '../src/application/task-commands.js'

const dir = mkdtempSync(join(tmpdir(), 'cockpit-task-commands-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Task = { id: string; status: string; scope?: string; title?: string; properties: Record<string, unknown>; relations?: Array<{ source_id: string; target_id: string; relation: string }> }

function world(tasks: Task[], opts: { bound?: string[] } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list' && query?.type === 'task' && !query.task_id) return { engrams: [...byId.values()].filter((t) => t.status === query.status) }
      if (path === '/list') return { engrams: query?.task_id ? (opts.bound ?? []).map((id) => ({ id })) : [] }
      const t = byId.get(path.slice('/engram/'.length))
      if (!t) throw new Error('not found')
      return { ...t, title: t.title ?? t.id, scope: t.scope ?? 'project.eml', relations: t.relations ?? [] }
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const t = byId.get(/^\/task\/([^/]+)\/track$/.exec(path)![1])!
      // As core mirrors it (task-state.ts): a delegation sets delegate and checkpoint, null clears all three.
      const { delegation, delegate, checkpoint, ...rest } = body
      const handOver = mirroredHandOver({ ...(delegation !== undefined ? { delegation } : {}), ...('delegate' in body ? { delegate } : {}), ...('checkpoint' in body ? { checkpoint } : {}) } as never)
      for (const [k, v] of Object.entries({ ...rest, ...handOver })) {
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
  const changed: string[] = []
  const space = { id: 'main', name: 'Main', shared: false }
  const store = new TaskCommandStore(join(dir, `${Math.random()}.json`))
  const deps: TaskCommandsDeps = {
    store,
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
    expect(w.posts).toEqual([{ path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' }, text: 'Handed to atlas with checkpoint after; the owner stays.' } }])
    expect(w.byId.get('t1')!.properties).toMatchObject({ delegate: 'atlas', checkpoint: 'after' })
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
    expect(w.posts[0].body).toMatchObject({ waits: null, status: 'planned' })
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

  it('work on it now happens at once, with the brief for the session the page opens; undo puts the task back', async () => {
    const w = world([owned('t1', { waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' } })])
    const r = await w.commands.submit({ opId: 'op-t', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Customers' } })
    expect(r).toMatchObject({ ok: true, command: { state: 'applied', brief: expect.stringContaining('Which list?') } })
    expect(w.posts[0].body).toMatchObject({ delegation: { agent: 'atlas', checkpoint: 'after', mode: 'together' }, waits: null })
    expect(w.byId.get('t1')!.properties).toMatchObject({ delegate: 'atlas', checkpoint: 'after' })
    expect(w.posts[0].body.text).toMatch(/^Working on it with atlas in desk Customers; the owner stays\./)
    expect(await w.commands.undo('op-t')).toEqual({ ok: true })
    expect(w.posts[1].body).toEqual({ delegate: null, checkpoint: null, waits: [{ id: 'waiting_on', who: 'lasse', kind: 'question', why: 'Which list?' }], status: 'planned', text: 'Hand-over undone; the task is back as it was.' })
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

  it('snooze hides an Inbox item at once and undo brings it back', async () => {
    const w = world([owned('t1')])
    await w.commands.submit({ opId: 'op-z', kind: 'snooze', spaceId: 'main', taskId: 't1', snooze: { key: 'task:t1@s', until: '2026-11-20T01:00:00Z' } })
    expect(w.commands.snoozes()).toEqual([{ key: 'task:t1@s', until: '2026-11-20T01:00:00Z' }])
    expect(await w.commands.undo('op-z')).toEqual({ ok: true })
    expect(w.commands.snoozes()).toEqual([])
  })

  it('close drops a task not needed after the window; undo inside it leaves the task as it was', async () => {
    const w = world([owned('t1', { delegate: 'atlas' }, 'active'), owned('t2')])
    await w.commands.submit({ opId: 'op-c1', kind: 'close', spaceId: 'main', taskId: 't1' })
    await w.commands.submit({ opId: 'op-c2', kind: 'close', spaceId: 'main', taskId: 't2' })
    expect(await w.commands.undo('op-c2')).toEqual({ ok: true })
    w.later(UNDO_WINDOW_MS + 1)
    await w.commands.tick()
    expect(w.posts.map((p) => p.path)).toEqual(['/task/t1/track'])
    expect(w.posts[0].body).toEqual({ status: 'invalidated', outcome: 'Closed by the owner on the task board', waiting_on: null, text: 'Closed on the task board by the owner: not needed.' })
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

  it('holds the runner off while the session is open, then releases the agent with a journal line once it is put away', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    expect(w.byId.get('t1')!.properties).toMatchObject({ delegate: 'atlas', checkpoint: 'after' })
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
    expect(w.posts.at(-1)).toEqual({ path: '/task/t1/track', body: { delegation: null, text: 'Worked on it together with atlas; the session was put away, so atlas is released and does not go on alone. Hand it to atlas to let it go on.' } })
    expect(w.byId.get('t1')!.properties.delegate).toBeUndefined()
    expect(w.commands.together('t1')).toBe(false)
    expect(w.commands.releasedAgent('t1')).toBe('atlas')
    await w.commands.tick()
    expect(w.posts).toHaveLength(2)
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
    expect(w.byId.get('t1')!.properties).toMatchObject({ delegate: 'atlas', checkpoint: 'after' })
    expect(w.posts.some((p) => p.body.delegation === null)).toBe(false)
    expect(w.byId.get('t1')!.properties.delegation).toMatchObject({ mode: 'alone' })
    expect(w.commands.delegatedAt('t1')).toBe(new Date(Date.parse('2026-11-19T10:00:00Z') + 60_000).toISOString())
    expect(w.commands.releasedAgent('t1')).toBeNull()
  })

  it('leaves a task whose delegate changed meanwhile, or that was undone, as it is', async () => {
    const w = together()
    await w.commands.submit({ opId: 'op-tg4', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: workOnItNow })
    // Handed to motti in a chat: core starts a new delegation (mode alone) for a new agent.
    Object.assign(w.byId.get('t1')!.properties, { delegate: 'motti', delegation: { agent: 'motti', checkpoint: 'after', mode: 'alone' } })
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

describe('the release keyed on delegation.mode', () => {
  const togetherTask = (id: string, props: Record<string, unknown> = {}) =>
    owned(id, { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', mode: 'together' }, ...props })

  const scanWorld = (tasks: Task[], sessions: Record<string, { total: number; open: number }>, shared = false) => {
    const w = world(tasks)
    const space = { id: 'main', name: 'Main', shared }
    const commands = createTaskCommands({
      ...w.deps,
      space: () => space as never,
      spaces: () => [space as never],
      me: 'lasse',
      sessionsSince: (taskId) => sessions[taskId] ?? { total: 0, open: 0 },
    })
    return { ...w, commands }
  }

  it('releases a together task no board command covers once its sessions here are put away, with a journal line', async () => {
    const w = scanWorld([togetherTask('closed'), togetherTask('open'), togetherTask('elsewhere'), owned('alone', { delegate: 'atlas', delegation: { agent: 'atlas', mode: 'alone' } })],
      { closed: { total: 1, open: 0 }, open: { total: 2, open: 1 }, alone: { total: 1, open: 0 } })
    await w.commands.tick()
    expect(w.posts).toEqual([{ path: '/task/closed/track', body: { delegation: null, text: 'Worked on it together with atlas; the session was put away, so atlas is released and does not go on alone. Hand it to atlas to let it go on.' } }])
    expect(w.byId.get('closed')!.properties).not.toHaveProperty('delegate')
    // Still open, no session on this cockpit, or alone: left as they are.
    expect(w.byId.get('open')!.properties.delegate).toBe('atlas')
    expect(w.byId.get('elsewhere')!.properties.delegate).toBe('atlas')
    expect(w.byId.get('alone')!.properties.delegate).toBe('atlas')
  })

  it('looks at most once a minute', async () => {
    const sessions = { t1: { total: 1, open: 1 } }
    const w = scanWorld([togetherTask('t1')], sessions)
    await w.commands.tick()
    sessions.t1 = { total: 1, open: 0 }
    w.later(1000)
    await w.commands.tick()
    expect(w.posts).toHaveLength(0)
    w.later(TOGETHER_SCAN_MS)
    await w.commands.tick()
    expect(w.posts).toHaveLength(1)
  })

  it('in a shared space, only this member\'s tasks', async () => {
    const w = scanWorld([togetherTask('theirs', { assignee_ids: ['dominik'] })], { theirs: { total: 1, open: 0 } }, true)
    await w.commands.tick()
    expect(w.posts).toHaveLength(0)
  })

  it('leaves a task an open Work on it now covers to that command', async () => {
    const w = scanWorld([owned('t1')], { t1: { total: 1, open: 0 } })
    await w.commands.submit({ opId: 'op-cov', kind: 'hand_over', spaceId: 'main', taskId: 't1', handOver: { mode: 'together', delegate: 'atlas', checkpoint: 'after', desk: 'Main' } })
    expect(w.byId.get('t1')!.properties.delegation).toMatchObject({ mode: 'together' })
    // sessionsSince answers the same for every since here: the command's own release puts it away, once.
    await w.commands.tick()
    expect(w.posts.filter((p) => p.body.delegation === null)).toHaveLength(1)
  })
})
