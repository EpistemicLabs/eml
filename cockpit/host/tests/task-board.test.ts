import { describe, it, expect } from 'vitest'
import { createTaskBoard, type TaskBoardDeps } from '../src/application/task-board.js'

type Row = { id: string; status: string; title?: string; scope?: string; parent_id?: string | null; updated_at?: string; properties?: Record<string, unknown> }

function brainOf(rows: Row[], agents = ['atlas'], projects = [{ id: 'verapur', name: 'Verapur', goal: 'keep the customer' }]) {
  return {
    rows,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/object/agent') return { objects: agents.map((id) => ({ id, name: id })) }
      if (path === '/object/project') return { objects: projects }
      if (path === '/list') return { engrams: rows.filter((r) => r.status === query?.status).map((r) => ({ title: r.id, scope: 'project.verapur', parent_id: null, updated_at: '2026-11-19T09:00:00Z', properties: {}, ...r })) }
      throw new Error(`unexpected ${path}`)
    },
  }
}

function setup(opts: { main: Row[]; other?: Row[]; working?: string[]; jobs?: Record<string, string>; pending?: TaskBoardDeps['pendingCommands'] } ) {
  const main = { id: 'main', name: 'Main', taskSystem: true, shared: false }
  const ebisu = { id: 'ebisu', name: 'Ebisu', taskSystem: false, shared: false }
  const brains = new Map<string, ReturnType<typeof brainOf>>([['main', brainOf(opts.main)], ['ebisu', brainOf(opts.other ?? [], [])]])
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') }
  const sessions = (opts.working ?? []).map((taskId, i) => ({ sessionId: `s${i}`, taskId, working: true }))
  const deps: TaskBoardDeps = {
    spaces: () => [main as never, ebisu as never],
    brain: (space) => brains.get(space.id) ?? null,
    viewer: 'lasse',
    sessionsOn: (taskId) => sessions.filter((s) => s.taskId === taskId),
    nextRunOf: (taskId) => opts.jobs?.[taskId] ?? null,
    pendingTriage: () => [],
    triagePending: () => false,
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
  it('puts every open task of a task-system space in its turn and counts Needs you once', async () => {
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
    expect(turn('asked')).toMatchObject({ turn: 'needs_you', group: 'asked', onBoard: true, spaceName: 'Main', project: 'verapur' })
    expect(turn('review')?.turn).toBe('review')
    expect(turn('working')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: ['s0'] })
    expect(turn('at-nine')).toMatchObject({ turn: 'agent_scheduled', group: 'at_time', nextRunAt: '2026-11-20T01:00:00Z' })
    expect(turn('own')).toMatchObject({ turn: 'needs_you', group: 'own' })
    expect(turn('closed')?.turn).toBe('done')
    expect(model.counts).toEqual({ needsYou: 2, inbox: 2 })
    expect(model.inbox.map((i) => [i.kind, i.taskId])).toEqual([['question', 'asked'], ['review', 'review']])
    expect(model.spaces).toEqual([{ id: 'main', name: 'Main', taskSystem: true, agents: ['atlas'] }, { id: 'ebisu', name: 'Ebisu', taskSystem: false, agents: [] }])
    expect(model.projects).toContainEqual({ spaceId: 'main', id: 'verapur', name: 'Verapur', goal: 'keep the customer' })
  })

  it('shows other spaces in Plan only: not on the board, not in the counts', async () => {
    const { board } = setup({ main: [], other: [mine('portfolio', {}, 'planned')] })
    const model = await board.refresh()
    expect(model.tasks).toEqual([expect.objectContaining({ id: 'portfolio', spaceId: 'ebisu', onBoard: false, turn: 'needs_you' })])
    expect(model.counts.needsYou).toBe(0)
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
})
