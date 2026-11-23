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

function setup(opts: { main: Row[]; other?: Row[]; unlisted?: Row[]; oldBrain?: boolean; working?: string[]; jobs?: Record<string, string>; pending?: TaskBoardDeps['pendingCommands']; released?: Record<string, string>; head?: TaskBoardDeps['head']; log?: string[]; runs?: Array<Record<string, unknown>> } ) {
  const main = { id: 'main', name: 'Main', shared: false }
  const ebisu = { id: 'ebisu', name: 'Ebisu', shared: true }
  const brains = new Map<string, ReturnType<typeof brainOf>>([['main', brainOf(opts.main, undefined, undefined, opts.unlisted, !opts.oldBrain)], ['ebisu', brainOf(opts.other ?? [], [])]])
  if (opts.runs) {
    const brain = brains.get('main')!
    const get = brain.get.bind(brain)
    brain.get = async (path, query) => path === '/object/run' ? { objects: opts.runs } : get(path, query)
  }
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
    releasedAgent: (taskId) => opts.released?.[taskId] ?? null,
    now: () => clock.now,
    log: (line) => { opts.log?.push(line) },
    ...(opts.head ? { head: opts.head } : {}),
  }
  const board = createTaskBoard(deps)
  return { board, brains, clock }
}

const mine = (id: string, props: Record<string, unknown> = {}, status = 'active'): Row => ({ id, status, properties: { assignee_ids: ['lasse'], ...props } })

describe('the task board', () => {
  it('reads other members\' runs with a live lease and a next run mirrored into the delegation (step 3)', async () => {
    const run = (id: string, task_id: string, state: string, lease_until: string | null) => ({ id, task_id, member: 'dominik', agent: 'motti', state, lease_until })
    const delegated = { delegate: 'atlas', checkpoint: 'after' }
    const { board } = setup({
      main: [
        mine('elsewhere', delegated),
        mine('between-turns', delegated),
        mine('lease-over', delegated),
        mine('ended', delegated),
        mine('local', delegated),
        mine('their-job', { ...delegated, delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone', next_run_at: '2026-11-20T08:00:00.000Z' } }, 'planned'),
        mine('past-job', { ...delegated, delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone', next_run_at: '2026-11-19T08:00:00.000Z' } }, 'planned'),
      ],
      working: ['local'],
      runs: [
        run('r1', 'elsewhere', 'running', '2026-11-19T10:10:00.000Z'),
        run('r2', 'between-turns', 'idle', '2026-11-19T10:10:00.000Z'),
        run('r3', 'lease-over', 'running', '2026-11-19T09:59:00.000Z'),
        run('r4', 'ended', 'ended', '2026-11-19T10:10:00.000Z'),
        // this host's own session on it: counted once, from the ledger
        { ...run('s0', 'local', 'idle', '2026-11-19T10:10:00.000Z'), member: 'lasse' },
      ],
    })
    const model = await board.refresh()
    const byId = new Map(model.tasks.map((t) => [t.id, t]))
    expect(byId.get('elsewhere')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: [] })
    expect(byId.get('between-turns')).toMatchObject({ turn: 'agent_working', working: false })
    expect(byId.get('lease-over')).toMatchObject({ turn: 'needs_you', reason: 'stopped' })
    expect(byId.get('ended')).toMatchObject({ turn: 'needs_you', reason: 'stopped' })
    expect(byId.get('local')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: ['s0'] })
    expect(byId.get('their-job')).toMatchObject({ turn: 'agent_scheduled', group: 'at_time', nextRunAt: '2026-11-20T08:00:00.000Z' })
    expect(byId.get('past-job')).toMatchObject({ turn: 'agent_scheduled', group: 'runner', nextRunAt: null })
  })

  it('offers to hand a task to the agent Work on it now released, only while nobody is delegated (B2)', async () => {
    const { board } = setup({
      main: [mine('released'), mine('handed-again', { delegate: 'atlas', checkpoint: 'after' }, 'planned'), mine('plain')],
      released: { released: 'atlas', 'handed-again': 'atlas' },
    })
    const model = await board.refresh()
    const byId = new Map(model.tasks.map((t) => [t.id, t]))
    expect(byId.get('released')).toMatchObject({ handTo: 'atlas', turn: 'needs_you', group: 'own' })
    expect(byId.get('handed-again')!.handTo).toBeUndefined()
    expect(byId.get('plain')!.handTo).toBeUndefined()
  })

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

  it('reads the turn from the most urgent of a task\'s waits, and lists each wait on the viewer in the Inbox', async () => {
    const waits = [
      { id: 's1', who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T08:00:00.000Z', session_id: 's1' },
      { id: 's2', who: 'lasse', kind: 'review', why: 'Review: draft', since: '2026-11-19T09:00:00.000Z', session_id: 's2' },
    ]
    const { board } = setup({
      main: [
        // waiting_on as an older core left it: the list wins.
        mine('two', { delegate: 'atlas', waits, waiting_on: { who: 'lasse', kind: 'question', why: 'stale' } }),
        mine('asked-and-handed', { waits: [waits[0], { id: 'kim', who: 'kim', kind: 'outside', why: 'reply' }] }),
      ],
      pending: () => [
        { opId: 'op-h', kind: 'hand_over', spaceId: 'main', taskId: 'asked-and-handed', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } },
      ],
    })
    const model = await board.refresh()
    expect(model.tasks.find((t) => t.id === 'two')).toMatchObject({ turn: 'review', waitingOn: { kind: 'review', session_id: 's2' } })
    expect(model.inbox.map((i) => [i.kind, i.sessionId])).toEqual([['review', 's2'], ['question', 's1']])
    // The pending hand-over takes the owner's question off; the customer's wait stays.
    expect(model.tasks.find((t) => t.id === 'asked-and-handed')).toMatchObject({ turn: 'waiting_on_others', waitingOn: { who: 'kim' } })
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

describe('live updates', () => {
  const until = async (check: () => boolean, ms = 2000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('tells the pages when a new task appears or one leaves, not when nothing changed', async () => {
    const { board, brains } = setup({ main: [mine('t1')] })
    let told = 0
    board.onChange(() => { told++ })
    await board.refresh()
    await board.refresh()
    expect(told).toBe(0)
    brains.get('main')!.rows.push(mine('t2', {}, 'planned'))
    expect((await board.refresh()).tasks.map((t) => t.id)).toContain('t2')
    expect(told).toBe(1)
    brains.get('main')!.rows.pop()
    await board.refresh()
    expect(told).toBe(2)
  })

  it('tells the pages about a new title too', async () => {
    const { board, brains } = setup({ main: [mine('t1')] })
    let told = 0
    board.onChange(() => { told++ })
    await board.refresh()
    brains.get('main')!.rows[0].properties!.display_title = 'A clearer name'
    await board.refresh()
    expect(told).toBe(1)
  })

  it('a refresh asked for during a build gets a build after it, which sees the write', async () => {
    const { board, brains } = setup({ main: [mine('t1')] })
    await board.refresh()
    const brain = brains.get('main')!
    const plainGet = brain.get.bind(brain)
    let wrote: () => void = () => {}
    const written = new Promise<void>((resolve) => { wrote = resolve })
    brain.get = async (path: string, query?: Record<string, unknown>) => {
      const answer = await plainGet(path, query)
      // the split writes its task right after the running build read the open tasks
      if (path === '/list' && query?.status === 'planned' && !brain.rows.some((r) => r.id === 'split-off')) { brain.rows.push(mine('split-off', {}, 'planned')); wrote() }
      return answer
    }
    const running = board.refresh()
    await written
    const asked = board.refresh()
    expect((await running).tasks.map((t) => t.id)).not.toContain('split-off')
    expect((await asked).tasks.map((t) => t.id)).toContain('split-off')
  })

  it('get waits for a build under way instead of answering the cached board', async () => {
    const { board, brains } = setup({ main: [mine('t1')] })
    await board.get(5000)
    brains.get('main')!.rows.push(mine('t2', {}, 'planned'))
    void board.refresh()
    expect((await board.get(5000)).tasks.map((t) => t.id)).toContain('t2')
  })

  it('refreshes soon after a space\'s log head moves, and the pages hear of it', async () => {
    let seq = 10
    let release: (() => void) | null = null
    const head: TaskBoardDeps['head'] = async (space, after) => {
      if (space.id !== 'main' || after === null) return space.id === 'main' ? seq : 1
      if (after !== seq) return seq
      await new Promise<void>((resolve) => { release = resolve })
      return seq
    }
    const { board, brains } = setup({ main: [mine('t1')], head })
    let told = 0
    board.onChange(() => { told++ })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, settleMs: 10, restMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    await until(() => release !== null)
    brains.get('main')!.rows.push(mine('from-an-agent', {}, 'planned'))
    seq = 11
    release!()
    await until(() => told > 0)
    expect((await board.get(60_000)).tasks.map((t) => t.id)).toContain('from-an-agent')
    stop()
    release?.()
  })

  it('falls back to the newest task for a brain without /head, and one failing space holds up no other', async () => {
    const log: string[] = []
    const head: TaskBoardDeps['head'] = async (space) => {
      if (space.id === 'main') throw Object.assign(new Error('Not found'), { status: 404 })
      throw new Error('fetch failed')
    }
    const { board, brains } = setup({ main: [mine('t1')], head, log })
    const list = brains.get('main')!
    const plainGet = list.get.bind(list)
    list.get = async (path: string, query?: Record<string, unknown>) =>
      path === '/list' && query?.limit === 1 ? { engrams: list.rows.slice(-1).map((r) => ({ id: r.id, updated_at: r.updated_at ?? 'x' })) } : plainGet(path, query)
    let told = 0
    board.onChange(() => { told++ })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, settleMs: 10, probeMs: 5, restMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    await until(() => log.some((l) => l.includes('Main: its brain has no /head')))
    await new Promise((r) => setTimeout(r, 20))
    list.rows.push(mine('t2', {}, 'planned'))
    await until(() => told > 0)
    expect(log.some((l) => l.includes('watching Ebisu failed'))).toBe(true)
    stop()
  })

  const quickSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))

  it('rests instead of spinning when a brain answers at once without a change', async () => {
    let calls = 0
    const rests: number[] = []
    const head: TaskBoardDeps['head'] = async () => { calls++; return 3 }
    const { board } = setup({ main: [mine('t1')], head })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, restMs: 7, sleep: (ms) => { rests.push(ms); return quickSleep(ms) } })
    await until(() => rests.filter((ms) => ms === 7).length >= 3)
    stop()
    expect(calls).toBeLessThan(20)
  })

  it('a brain that fails for a moment is asked again, not given up on', async () => {
    const log: string[] = []
    let fails = 2
    let seen = 0
    const head: TaskBoardDeps['head'] = async (space, after) => {
      if (space.id !== 'main') return 1
      if (fails > 0) { fails--; throw Object.assign(new Error('Reading the log head failed'), { status: 500, body: { code: 'HEAD_READ_FAILED' } }) }
      seen++
      return after === null ? 4 : 4
    }
    const { board } = setup({ main: [mine('t1')], head, log })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, restMs: 5, sleep: quickSleep })
    await until(() => seen >= 2)
    stop()
    expect(log.some((l) => l.includes('no /head'))).toBe(false)
    expect(log.filter((l) => l.includes('watching Main failed'))).toHaveLength(2)
  })

  it('falls back on NO_LOG and tries /head again later', async () => {
    const log: string[] = []
    let noLog = true
    let headCalls = 0
    const head: TaskBoardDeps['head'] = async (space) => {
      if (space.id !== 'main') return 1
      headCalls++
      if (noLog) throw Object.assign(new Error('no op log'), { status: 501, body: { code: 'NO_LOG' } })
      return 9
    }
    const { board, clock } = setup({ main: [mine('t1')], head, log })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 10 * 60_000, probeMs: 5, restMs: 5, headRetryMs: 60_000, sleep: quickSleep })
    await until(() => log.some((l) => l.includes('Main: its brain has no /head')))
    const before = headCalls
    noLog = false
    clock.now += 60_000
    await until(() => headCalls > before)
    stop()
  })
})

