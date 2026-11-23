import { describe, it, expect } from 'vitest'
import { createTaskBoard, type TaskBoardDeps } from '../src/application/task-board.js'

type Row = { id: string; status: string; title?: string; scope?: string; parent_id?: string | null; origin_task_id?: string | null; updated_at?: string; latest_note?: { text: string; at: string } | null; properties?: Record<string, unknown> }

/** A brain with listed tasks and, by id only, tasks the lists leave out (closed long ago). */
function brainOf(rows: Row[], agents = ['atlas'], projects = [{ id: 'acme', name: 'Acme', goal: 'keep the customer' }], unlisted: Row[] = [], knowsOrigin = true) {
  const queries: Array<Record<string, unknown>> = []
  const fetched: string[] = []
  return {
    rows,
    queries,
    fetched,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/object/agent') return { objects: agents.map((id) => ({ id, name: id })) }
      if (path === '/object/project') return { objects: projects }
      if (path === '/list') {
        queries.push(query ?? {})
        if (!knowsOrigin && query && 'with_origin' in query) throw Object.assign(new Error('unknown query params'), { status: 400 })
        return { engrams: rows.filter((r) => r.status === query?.status).map((r) => ({ title: r.id, scope: 'project.acme', parent_id: null, origin_task_id: null, updated_at: '2026-11-19T09:00:00Z', properties: {}, ...r })) }
      }
      if (path.startsWith('/engram/')) {
        const id = path.slice('/engram/'.length)
        fetched.push(id)
        const row = [...rows, ...unlisted].find((r) => r.id === id)
        if (!row) throw new Error('engram not found')
        const relations = [
          ...(row.parent_id ? [{ relation: 'part_of', source_id: id, target_id: row.parent_id }] : []),
          ...(row.origin_task_id ? [{ relation: 'derived_from', source_id: id, target_id: row.origin_task_id, target_engram: { type: 'task' } }] : []),
        ]
        return { type: 'task', title: row.id, scope: 'project.acme', updated_at: '2026-01-01T00:00:00Z', ...row, relations }
      }
      throw new Error(`unexpected ${path}`)
    },
  }
}

function setup(opts: { main: Row[]; other?: Row[]; unlisted?: Row[]; oldBrain?: boolean; working?: string[]; jobs?: Record<string, string>; pending?: TaskBoardDeps['pendingCommands'] } ) {
  const main = { id: 'main', name: 'Main', shared: false }
  const ebisu = { id: 'ebisu', name: 'Ebisu', shared: true }
  const brains = new Map<string, ReturnType<typeof brainOf>>([['main', brainOf(opts.main, undefined, undefined, opts.unlisted, !opts.oldBrain)], ['ebisu', brainOf(opts.other ?? [], [])]])
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') }
  const sessions = (opts.working ?? []).map((taskId, i) => ({ sessionId: `s${i}`, taskId, working: true }))
  const deps: TaskBoardDeps = {
    spaces: () => [main as never, ebisu as never],
    brain: (space) => brains.get(space.id) ?? null,
    viewer: 'lasse',
    sessionsOn: (taskId) => sessions.filter((s) => s.taskId === taskId),
    nextRunOf: (taskId) => opts.jobs?.[taskId] ?? null,
    snoozes: () => [],
    pendingCommands: opts.pending ?? (() => []),
    now: () => clock.now,
    log: () => {},
  }
  const board = createTaskBoard(deps)
  return { board, brains, clock }
}

const mine = (id: string, props: Record<string, unknown> = {}, status = 'active'): Row => ({ id, status, properties: { assignee_ids: ['lasse'], ...props } })

describe('the task board', () => {
  it('puts every open task in its turn and counts Needs you once', async () => {
    const { board } = setup({
      main: [
        mine('asked', { delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'question', why: 'Count it?', since: '2026-11-19T09:30:00Z' } }),
        mine('review', { delegate: 'atlas', checkpoint: 'after', waiting_on: { who: 'lasse', kind: 'review', why: 'Review: done' } }),
        mine('working', { delegate: 'atlas', checkpoint: 'after' }),
        mine('at-nine', { delegate: 'atlas', checkpoint: 'after' }, 'planned'),
        mine('own'),
        mine('closed', {}, 'resolved'),
      ],
      working: ['working'],
      jobs: { 'at-nine': '2026-11-20T01:00:00Z' },
    })
    const model = await board.refresh()
    const turn = (id: string) => model.tasks.find((t) => t.id === id)
    expect(turn('asked')).toMatchObject({ turn: 'needs_you', group: 'asked', spaceName: 'Main', project: 'acme' })
    expect(turn('review')?.turn).toBe('review')
    expect(turn('working')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: ['s0'] })
    expect(turn('at-nine')).toMatchObject({ turn: 'agent_scheduled', group: 'at_time', nextRunAt: '2026-11-20T01:00:00Z' })
    expect(turn('own')).toMatchObject({ turn: 'needs_you', group: 'own' })
    expect(turn('closed')?.turn).toBe('done')
    expect(model.counts).toEqual({ needsYou: 2, inbox: 2 })
    expect(model.inbox.map((i) => [i.kind, i.taskId])).toEqual([['question', 'asked'], ['review', 'review']])
    expect(model.spaces).toEqual([{ id: 'main', name: 'Main', agents: ['atlas'] }, { id: 'ebisu', name: 'Ebisu', agents: [] }])
    expect(model.projects).toContainEqual({ spaceId: 'main', id: 'acme', name: 'Acme', goal: 'keep the customer' })
  })

  it('puts the tasks of every space on the board and in the counts, a shared one too', async () => {
    const { board } = setup({ main: [], other: [mine('portfolio', {}, 'planned')] })
    const model = await board.refresh()
    expect(model.tasks).toEqual([expect.objectContaining({ id: 'portfolio', spaceId: 'ebisu', turn: 'needs_you' })])
    expect(model.counts.needsYou).toBe(1)
  })

  it('reports turn changes since the last refresh as events, newest first', async () => {
    const { board, brains, clock } = setup({ main: [mine('t1', { delegate: 'atlas', checkpoint: 'after' }, 'planned')] })
    const seen: unknown[] = []
    board.onChange((events) => seen.push(...events))
    await board.refresh()
    expect(seen).toEqual([])
    brains.get('main')!.rows[0].properties!.waiting_on = { who: 'lasse', kind: 'question', why: 'Which list?' }
    clock.now += 60_000
    const model = await board.refresh()
    expect(seen).toEqual([{ at: '2026-11-19T10:01:00.000Z', taskId: 't1', spaceId: 'main', from: 'agent_scheduled', to: 'needs_you' }])
    expect(model.events[0]).toMatchObject({ taskId: 't1', to: 'needs_you' })
  })

  it('shows a pending hand-over or review at once, with its undo deadline', async () => {
    const { board } = setup({
      main: [mine('asked', { waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' } }), mine('done-soon', { waiting_on: { who: 'lasse', kind: 'review' } })],
      pending: () => [
        { opId: 'op-1', kind: 'hand_over', spaceId: 'main', taskId: 'asked', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } },
        { opId: 'op-2', kind: 'review', spaceId: 'main', taskId: 'done-soon', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '' },
      ],
    })
    const model = await board.refresh()
    expect(model.tasks.find((t) => t.id === 'asked')).toMatchObject({ delegate: 'atlas', turn: 'agent_scheduled', pending: { opId: 'op-1', kind: 'hand_over', undoUntil: '2026-11-19T10:00:08Z' } })
    expect(model.tasks.find((t) => t.id === 'done-soon')).toMatchObject({ turn: 'done', pending: { opId: 'op-2' } })
    expect(model.inbox).toEqual([])
  })

  it('says how a task hangs in its tree: sub-task under its parent, spun off from its origin', async () => {
    const { board } = setup({
      main: [mine('root'), mine('spun', {}, 'active'), mine('step', {}, 'planned')].map((r) =>
        r.id === 'spun' ? { ...r, origin_task_id: 'root' } : r.id === 'step' ? { ...r, parent_id: 'spun' } : r),
    })
    const model = await board.refresh()
    const task = (id: string) => model.tasks.find((t) => t.id === id)
    expect(task('root')).toMatchObject({ parentId: null, originId: null, rel: null })
    expect(task('spun')).toMatchObject({ parentId: null, originId: 'root', rel: 'spun' })
    expect(task('step')).toMatchObject({ parentId: 'spun', originId: null, rel: 'sub' })
  })

  it('asks every space\'s brain for origins', async () => {
    const { board, brains } = setup({ main: [mine('a')], other: [mine('b', {}, 'planned')] })
    await board.refresh()
    expect(brains.get('main')!.queries.every((q) => q.with_origin === 'true')).toBe(true)
    expect(brains.get('ebisu')!.queries.every((q) => q.with_origin === 'true')).toBe(true)
  })

  it('fetches the closed ancestors of a task with a session, so its tree reaches its origin', async () => {
    const { board, brains } = setup({
      main: [{ ...mine('child'), parent_id: 'old-parent' }, { ...mine('lonely', {}, 'planned'), parent_id: 'gone' }],
      unlisted: [
        { id: 'old-parent', status: 'resolved', origin_task_id: 'oldest' },
        { id: 'oldest', status: 'invalidated', scope: 'project.other' },
        { id: 'gone', status: 'resolved' },
      ],
      working: ['child'],
    })
    const model = await board.refresh()
    expect(model.lineage).toEqual([
      { id: 'old-parent', spaceId: 'main', project: 'acme', title: 'old-parent', status: 'resolved', parentId: null, originId: 'oldest' },
      { id: 'oldest', spaceId: 'main', project: 'other', title: 'oldest', status: 'invalidated', parentId: null, originId: null },
    ])
    expect(brains.get('main')!.fetched).not.toContain('gone')
  })

  it('carries the display title and the status line from the newest handoff; the Inbox reads the display title', async () => {
    const at = '2026-11-19T09:30:00Z'
    const { board, brains } = setup({
      main: [
        { ...mine('named', { display_title: 'Ship the Acme widget release', waiting_on: { who: 'lasse', kind: 'review', why: 'Review: done', since: at } }), latest_note: { text: '### Handoff\nResult: Release published. Deploy runs.\nNext: check the live file.', at } },
        { ...mine('plain'), latest_note: null },
      ],
    })
    const model = await board.refresh()
    expect(brains.get('main')!.queries.every((q) => q.with_latest_note === 'true')).toBe(true)
    expect(model.tasks.find((t) => t.id === 'named')).toMatchObject({ displayTitle: 'Ship the Acme widget release', statusLine: { now: 'Release published', next: 'check the live file', at } })
    const plain = model.tasks.find((t) => t.id === 'plain')!
    expect(plain).not.toHaveProperty('displayTitle')
    expect(plain).not.toHaveProperty('statusLine')
    expect(model.inbox.find((i) => i.taskId === 'named')?.title).toBe('Ship the Acme widget release')
  })

  it('still lists the tasks when the brain server does not know with_origin yet', async () => {
    const { board } = setup({ main: [mine('a'), { ...mine('b'), parent_id: 'a' }], oldBrain: true })
    const model = await board.refresh()
    expect(model.tasks.map((t) => [t.id, t.rel, t.originId])).toEqual([['a', null, null], ['b', 'sub', null]])
  })
})
