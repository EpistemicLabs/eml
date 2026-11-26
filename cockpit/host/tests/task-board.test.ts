import { describe, it, expect } from 'vitest'
import { createTaskBoard, type TaskBoardDeps } from '../src/application/task-board.js'

type Row = { id: string; status: string; title?: string; scope?: string; parent_id?: string | null; origin_task_id?: string | null; updated_at?: string; latest_note?: { text: string; at: string } | null; properties?: Record<string, unknown> }

/** A brain with listed tasks and, by id only, tasks the lists leave out (closed long ago). */
function brainOf(rows: Row[], agents = ['atlas'], projects = [{ id: 'acme', name: 'Acme', goal: 'keep the customer' }], unlisted: Row[] = [], knowsOrigin = true, runs: Array<Record<string, unknown>> = []) {
  const queries: Array<Record<string, unknown>> = []
  const fetched: string[] = []
  return {
    rows,
    queries,
    fetched,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/object/agent') return { objects: agents.map((id) => ({ id, name: id })) }
      // As core answers: latest=N is the newest N runs of each task, newest first per task; else the open runs.
      if (path === '/object/run' && query?.latest) {
        const n = query.latest === 'true' ? 1 : Number(query.latest)
        const byTask = new Map<string, Array<Record<string, unknown>>>()
        for (const r of runs) byTask.set(String(r.task_id), [...(byTask.get(String(r.task_id)) ?? []), r])
        return { objects: [...byTask.values()].flatMap((list) => [...list].sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? ''))).slice(0, n)) }
      }
      if (path === '/object/run') return { objects: runs.filter((r) => r.state !== 'ended') }
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
        if (!row) throw Object.assign(new Error('engram not found'), { status: 404 })
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

function setup(opts: { main: Row[]; other?: Row[]; unlisted?: Row[]; oldBrain?: boolean; working?: string[]; jobs?: Record<string, string>; openJobs?: string[]; pending?: TaskBoardDeps['pendingCommands']; released?: Record<string, string>; head?: TaskBoardDeps['head']; log?: string[]; busy?: string[]; held?: string[]; ledger?: Record<string, string[]>; runs?: Array<Record<string, unknown>>; schedules?: Record<string, Record<string, unknown>>; started?: Record<string, number>; own?: Record<string, { sessionId: string; continues: true }>; heldFor?: string[]; commands?: Record<string, Array<Array<{ description: string; since: string }>>>; scheduleFacts?: Record<string, { cursor?: string | null; firedWake?: string | null; waitingRunDueAt?: string | null; needsOk?: boolean }> } ) {
  const main = { id: 'main', name: 'Main', shared: false, main: true }
  const ebisu = { id: 'ebisu', name: 'Ebisu', shared: true }
  // A planned task handed over with the flat fields has the delegation core mirrors, with a request (v0.23).
  const requested = (rows: Row[]) => rows.map((r) => {
    const p = r.properties ?? {}
    return r.status === 'planned' && p.delegate && p.checkpoint && !p.delegation
      ? { ...r, properties: { ...p, delegation: { agent: p.delegate, checkpoint: p.checkpoint, requested_at: '2026-11-19T09:00:00.000Z' } } } : r
  })
  // The task holds its schedule: `jobs` gives a task a wake-up at that time, `openJobs` a paused repeating time,
  // `schedules` the schedule as written.
  const scheduled = (rows: Row[]) => rows.map((r) => {
    const schedule = opts.schedules?.[r.id] ?? (opts.jobs?.[r.id] ? { at: opts.jobs[r.id] } : (opts.openJobs ?? []).includes(r.id) ? { crons: ['0 8 * * *'], time_zone: 'UTC', paused: true } : null)
    if (!schedule) return r
    const p = r.properties ?? {}
    return { ...r, properties: { ...p, delegation: { agent: p.delegate ?? 'atlas', ...(p.checkpoint ? { checkpoint: p.checkpoint } : {}), ...(p.delegation as Record<string, unknown> | undefined), schedule } } } as Row
  })
  const brains = new Map<string, ReturnType<typeof brainOf>>([['main', brainOf(requested(scheduled(opts.main)), undefined, undefined, opts.unlisted, !opts.oldBrain, opts.runs)], ['ebisu', brainOf(requested(opts.other ?? []), [])]])
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') }
  const sessions: Array<{ sessionId: string; taskId: string; working: boolean; commands?: Array<{ description: string; since: string }> }> = (opts.working ?? []).map((taskId, i) => ({ sessionId: `s${i}`, taskId, working: true }))
  // Sessions whose turn is over while the background commands they started still run, per task.
  for (const [taskId, lists] of Object.entries(opts.commands ?? {})) lists.forEach((commands, i) => sessions.push({ sessionId: `${taskId}-c${i}`, taskId, working: false, commands }))
  const deps: TaskBoardDeps = {
    spaces: () => [main as never, ebisu as never],
    brain: (space) => brains.get(space.id) ?? null,
    viewer: 'lasse',
    sessionsOn: (taskId) => sessions.filter((s) => s.taskId === taskId),
    snoozes: () => [],
    pendingCommands: opts.pending ?? (() => []),
    releasedAgent: (taskId) => opts.released?.[taskId] ?? null,
    ownSessionOf: (taskId) => opts.own?.[taskId] ?? null,
    now: () => clock.now,
    log: (line) => { opts.log?.push(line) },
    ...(opts.head ? { head: opts.head } : {}),
    runnerBusy: (taskId, runs) => (opts.busy?.includes(taskId) ?? false) || (runs ?? []).some((r) => r.state === 'running'),
    runnerHeld: (taskId, requestedAt) => (opts.held?.includes(taskId) ?? false) || (Boolean(requestedAt) && (opts.heldFor?.includes(requestedAt!) ?? false)),
    runnerStartedAt: (taskId) => opts.started?.[taskId] ?? null,
    ...(opts.ledger ? { ledgerSessionsOn: (taskId: string) => opts.ledger![taskId] ?? [] } : {}),
    ...(opts.scheduleFacts ? { scheduleFacts: (taskId: string) => opts.scheduleFacts![taskId] ?? {} } : {}),
  }
  const board = createTaskBoard(deps)
  return { board, brains, clock }
}

const mine = (id: string, props: Record<string, unknown> = {}, status = 'active'): Row => ({ id, status, properties: { assignee_ids: ['lasse'], ...props } })

describe('the task board', () => {
  it('gives a task the commands its sessions still run, oldest first, and none to a closed task', async () => {
    const tests = { description: 'Run the tests', since: '2026-11-19T09:40:00.000Z' }
    const build = { description: 'Build the app', since: '2026-11-19T09:10:00.000Z' }
    const { board } = setup({
      main: [mine('r', { delegate: 'atlas' }), mine('q'), mine('done', {}, 'resolved')],
      commands: { r: [[tests], [build]], done: [[tests]] },
    })
    const tasks = (await board.refresh()).tasks
    const r = tasks.find((x) => x.id === 'r')!
    expect(r.commands).toEqual([build, tests])
    // Display only: a task whose session waits for a command is not working.
    expect(r.working).toBe(false)
    expect(tasks.find((x) => x.id === 'q')!.commands).toBeUndefined()
    expect(tasks.find((x) => x.id === 'done')!.commands).toBeUndefined()
  })

  it('sends a task\'s ended sessions, newest first, at most ten, without the one still running', async () => {
    const ended = (id: string, member: string, started: string, reason: string, result: string | null) =>
      ({ id, task_id: 'r', member, agent: member === 'lasse' ? 'atlas' : 'motti', state: 'ended', started_at: started, ended_at: started, end_reason: reason, result })
    const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}T08:00:00.000Z`
    const older = Array.from({ length: 10 }, (_, i) => ended(`old-${i + 1}`, 'lasse', day(i + 1), 'finished', null))
    const { board } = setup({
      main: [mine('r', { delegate: 'atlas' })],
      runs: [...older, ended('mon', 'lasse', day(16), 'finished', '4 mails need you'), ended('tue', 'dominik', day(17), 'crashed', null),
        { id: 'now', task_id: 'r', member: 'lasse', agent: 'atlas', state: 'running', started_at: day(18), last_activity_at: day(18) }],
    })
    const t = (await board.refresh()).tasks.find((x) => x.id === 'r')!
    expect(t.earlierRuns).toHaveLength(10)
    expect(t.earlierRuns!.slice(0, 2)).toEqual([
      { id: 'tue', member: 'dominik', agent: 'motti', startedAt: day(17), endedAt: day(17), endReason: 'crashed', result: null, here: false },
      { id: 'mon', member: 'lasse', agent: 'atlas', startedAt: day(16), endedAt: day(16), endReason: 'finished', result: '4 mails need you', here: true },
    ])
    expect(t.earlierRuns!.map((r) => r.id)).not.toContain('now')
  })

  it('names a task\'s own session and whether Delegate continues it; a session continued after a delegation counts once', async () => {
    const at = (h: number) => `2026-11-18T${String(h).padStart(2, '0')}:00:00.000Z`
    const { board } = setup({
      main: [mine('o', { delegate: 'atlas' }), mine('n')],
      own: { o: { sessionId: 'desk-1', continues: true } },
      runs: [
        { id: `desk-1_${Date.parse(at(9))}`, task_id: 'o', member: 'lasse', agent: 'atlas', state: 'running', started_at: at(9), last_activity_at: at(9) },
        { id: 'desk-1', task_id: 'o', member: 'lasse', agent: 'atlas', state: 'ended', started_at: at(8), ended_at: at(9), end_reason: 'finished' },
      ],
    })
    const tasks = (await board.refresh()).tasks
    const o = tasks.find((x) => x.id === 'o')!
    expect(o.ownSession).toEqual({ sessionId: 'desk-1', continues: true })
    expect(o.runs?.map((r) => r.id)).toEqual(['desk-1'])
    expect(o.earlierRuns).toBeUndefined()
    expect(tasks.find((x) => x.id === 'n')!.ownSession).toBeUndefined()
  })

  it('names no own session for a closed task, and asks the held check with the task\'s request time', async () => {
    const { board } = setup({
      main: [
        mine('done', {}, 'resolved'),
        mine('fresh', { delegate: 'atlas', checkpoint: 'none', delegation: { agent: 'atlas', checkpoint: 'none', requested_at: '2026-11-19T09:59:00.000Z' } }),
      ],
      own: { done: { sessionId: 'old', continues: true } },
      // a worker is about to start on it: held by its request time before its id is known
      heldFor: ['2026-11-19T09:59:00.000Z'],
    })
    const tasks = (await board.refresh()).tasks
    expect(tasks.find((x) => x.id === 'done')?.ownSession).toBeUndefined()
    expect(tasks.find((x) => x.id === 'fresh')).toMatchObject({ group: 'blocked', runner: { kind: 'held' } })
  })

  it('sends the task\'s goal and its schedule: a wake-up a session set for itself is a mission, a repeating time makes it a routine', async () => {
    const { board } = setup({
      main: [
        mine('m', { goal: 'Orders sync both ways', delegate: 'atlas', delegation: { agent: 'atlas', schedule: { at: '2026-11-20T09:00:00.000Z', why: 'Check the reply', by_session: 's1' } } }),
        mine('both', { delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 9 * * 1'], at: '2026-11-19T12:00:00.000Z', by_session: 's1', time_zone: 'UTC' } } }),
      ],
    })
    const tasks = (await board.refresh()).tasks
    expect(tasks.find((x) => x.id === 'm')).toMatchObject({ goal: 'Orders sync both ways', schedule: { at: '2026-11-20T09:00:00.000Z', why: 'Check the reply', by_session: 's1' }, group: 'mission', nextRunAt: '2026-11-20T09:00:00.000Z' })
    // the next run is the earliest of its times
    expect(tasks.find((x) => x.id === 'both')).toMatchObject({ group: 'routine', nextRunAt: '2026-11-19T12:00:00.000Z' })
  })

  it('shows a time that is due and not fired yet, and a run that waits to start, as the next run, by what this cockpit\'s record says', async () => {
    const hourly = { crons: ['0 * * * *'], time_zone: 'UTC' }
    const scheduled = (id: string, schedule: Record<string, unknown>) => mine(id, { delegate: 'atlas', delegation: { agent: 'atlas', schedule } })
    const { board } = setup({
      main: [
        scheduled('due-wake', { at: '2026-11-19T09:58:00.000Z' }), scheduled('fired-wake', { at: '2026-11-19T09:58:00.000Z' }),
        scheduled('due-cron', hourly), scheduled('ahead', hourly), scheduled('waiting', hourly), scheduled('paused', { at: '2026-11-19T09:58:00.000Z', paused: true }),
        mine('mail', { delegate: 'atlas' }),
        mine('closed', { delegate: 'atlas', delegation: { agent: 'atlas', schedule: { at: '2026-11-19T09:58:00.000Z' } } }, 'resolved'),
      ],
      scheduleFacts: {
        'fired-wake': { firedWake: '2026-11-19T09:58:00.000Z' },
        // the cursor stands before the hour: this pass has not fired 10:00 yet
        'due-cron': { cursor: '2026-11-19T09:59:30.000Z' },
        ahead: { cursor: '2026-11-19T10:00:00.000Z' },
        waiting: { cursor: '2026-11-19T10:00:00.000Z', waitingRunDueAt: '2026-11-19T09:00:00.000Z' },
        // a channel message waits for room: no schedule, still a run coming up
        mail: { waitingRunDueAt: '2026-11-19T09:59:00.000Z' },
        closed: { waitingRunDueAt: '2026-11-19T09:59:00.000Z' },
      },
    })
    const model = await board.refresh()
    const next = (id: string) => [...model.tasks, ...(model.closed ?? [])].find((t) => t.id === id)?.nextRunAt
    expect(next('due-wake')).toBe('2026-11-19T09:58:00.000Z')
    // fired already: clearing it on the task has not arrived, and nothing else is coming
    expect(next('fired-wake')).toBeNull()
    expect(next('due-cron')).toBe('2026-11-19T10:00:00.000Z')
    expect(next('ahead')).toBe('2026-11-19T11:00:00.000Z')
    expect(next('waiting')).toBe('2026-11-19T09:00:00.000Z')
    expect(next('paused')).toBeNull()
    expect(next('mail')).toBe('2026-11-19T09:59:00.000Z')
    // nothing fires on a closed task
    expect(next('closed') ?? null).toBeNull()
    expect(model.tasks.find((t) => t.id === 'due-wake')).toMatchObject({ turn: 'agent_scheduled' })
  })

  it('says which open tasks wait for the user\'s OK on a channel, from this cockpit\'s record', async () => {
    const { board } = setup({
      main: [
        mine('mail', { delegate: 'atlas' }), mine('plain', { delegate: 'atlas' }),
        mine('scheduled', { delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 * * * *'], time_zone: 'UTC' } } }),
        mine('closed', { delegate: 'atlas' }, 'resolved'),
      ],
      scheduleFacts: { mail: { needsOk: true }, scheduled: { cursor: '2026-11-19T10:00:00.000Z', needsOk: true }, plain: { cursor: null }, closed: { needsOk: true } },
    })
    const model = await board.refresh()
    const task = (id: string) => [...model.tasks, ...(model.closed ?? [])].find((t) => t.id === id)!
    expect(task('mail').needsOk).toBe(true)
    expect(task('scheduled').needsOk).toBe(true)
    // absent, not false: most tasks have nothing waiting
    expect(task('plain')).not.toHaveProperty('needsOk')
    // a closed task's record stops listening: nothing waits for an OK
    expect(task('closed')).not.toHaveProperty('needsOk')
  })

  it('offers "Hand to <agent>" for a delegated task that was never handed over, in Needs you', async () => {
    const { board } = setup({ main: [mine('never', { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' } }, 'planned')] })
    const model = await board.refresh()
    expect(model.tasks.find((t) => t.id === 'never')).toMatchObject({ turn: 'needs_you', group: 'nobody', reason: 'not_handed_over', handTo: 'atlas' })
  })

  it('shows the schedule of a task another member owns as scheduled, with its next run', async () => {
    const { board } = setup({
      main: [
        mine('theirs-weekly', { assignee_ids: ['other'], delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 9 * * 1'], time_zone: 'UTC' } } }),
        mine('paused', { assignee_ids: ['other'], delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 9 * * 1'], time_zone: 'UTC', paused: true } } }),
      ],
    })
    const model = await board.refresh()
    // a repeat rule is a routine; the board carries the schedule for the card
    expect(model.tasks.find((t) => t.id === 'theirs-weekly')).toMatchObject({ turn: 'agent_scheduled', group: 'routine', nextRunAt: '2026-11-23T09:00:00.000Z', schedule: { crons: ['0 9 * * 1'] } })
    expect(model.tasks.find((t) => t.id === 'paused')!.nextRunAt).toBeNull()
  })

  it('the task is the truth for its schedule: an open task shows it whoever owns it, a closed task shows none and no next run', async () => {
    const schedule = { at: '2026-11-19T20:40:00.000Z', by_session: 's1', time_zone: 'UTC' }
    const { board } = setup({
      main: [
        mine('own-open', { delegate: 'atlas', delegation: { agent: 'atlas', schedule } }),
        mine('own-closed', { delegate: 'atlas', delegation: { agent: 'atlas', schedule } }, 'resolved'),
        mine('theirs-closed', { assignee_ids: ['dominik'], delegate: 'atlas', delegation: { agent: 'atlas', schedule } }, 'resolved'),
        mine('theirs-open', { assignee_ids: ['dominik'], delegate: 'atlas', delegation: { agent: 'atlas', schedule } }),
      ],
    })
    const model = await board.refresh()
    const of = (id: string) => model.tasks.find((t) => t.id === id)
    for (const id of ['own-closed', 'theirs-closed']) {
      expect(of(id)?.nextRunAt, id).toBeNull()
      expect(of(id)?.schedule, id).toBeUndefined()
      expect(of(id)?.hasSchedule, id).toBe(false)
    }
    expect(of('own-open')).toMatchObject({ nextRunAt: '2026-11-19T20:40:00.000Z', schedule, hasSchedule: true })
    expect(of('theirs-open')).toMatchObject({ nextRunAt: '2026-11-19T20:40:00.000Z', schedule, hasSchedule: true })
  })

  it('says per task it read whether it is open and which sessions its waits came from, for the session lists', async () => {
    const wait = (session: string) => ({ id: session, who: 'lasse', kind: 'question', why: 'Which one?', since: '2026-11-19T08:00:00.000Z', session_id: session })
    const { board } = setup({
      main: [
        mine('asks', { waits: [wait('s1')], waiting_on: wait('s1') }),
        mine('done', { waits: [wait('s2')] }, 'resolved'),
        mine('quiet'),
      ],
    })
    expect(board.waitsSeen(null, 'asks')).toBeNull()
    await board.refresh()
    expect(board.waitsSeen(null, 'asks')).toEqual({ open: true, sessions: new Set(['s1']), at: '2026-11-19T10:00:00.000Z' })
    expect(board.waitsSeen('main', 'asks')?.sessions.has('s1')).toBe(true)
    expect(board.waitsSeen(null, 'done')).toMatchObject({ open: false })
    expect(board.waitsSeen(null, 'quiet')).toMatchObject({ open: true, sessions: new Set() })
    // Spaces are kept apart, and a task no build read is unknown.
    expect(board.waitsSeen('ebisu', 'asks')).toBeNull()
    expect(board.waitsSeen(null, 'never-read')).toBeNull()
  })

  it('reads other members\' open runs: a working one shows as working and holds the runner, a stale one does not work, an idle one is the owner\'s move', async () => {
    const run = (id: string, task_id: string, state: string, at: string) => ({ id, task_id, member: 'dominik', agent: 'motti', state, last_activity_at: at })
    const delegated = { delegate: 'atlas', checkpoint: 'after' }
    const { board } = setup({
      main: [mine('elsewhere', delegated), mine('between-turns', delegated), mine('stale', delegated), mine('ended', delegated), mine('local', delegated), mine('queued', delegated, 'planned')],
      working: ['local'],
      runs: [
        run('r1', 'elsewhere', 'running', '2026-11-19T09:55:00.000Z'),
        run('r2', 'between-turns', 'idle', '2026-11-19T09:00:00.000Z'),
        run('r3', 'stale', 'running', '2026-11-19T08:30:00.000Z'),
        run('r4', 'ended', 'ended', '2026-11-19T09:59:00.000Z'),
        // this host's own session on it: counted once, from the ledger
        { ...run('s0', 'local', 'idle', '2026-11-19T09:59:00.000Z'), member: 'lasse' },
        run('r5', 'queued', 'running', '2026-11-19T09:59:00.000Z'),
      ],
    })
    const model = await board.refresh()
    const byId = new Map(model.tasks.map((t) => [t.id, t]))
    expect(byId.get('elsewhere')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: [] })
    expect(byId.get('between-turns')).toMatchObject({ turn: 'needs_you', group: 'nobody', reason: 'idle', working: false })
    expect(byId.get('stale')).toMatchObject({ turn: 'agent_working', working: false })
    expect(byId.get('ended')).toMatchObject({ turn: 'needs_you', reason: 'stopped' })
    expect(byId.get('local')).toMatchObject({ turn: 'agent_working', working: true, sessionIds: ['s0'] })
    // the open runs go to the card and the panel: whose, their state, and whether they are this cockpit's
    expect(byId.get('elsewhere')!.runs).toEqual([{ id: 'r1', member: 'dominik', agent: 'motti', state: 'running', lastActivityAt: '2026-11-19T09:55:00.000Z', here: false }])
    expect(byId.get('stale')!.runs![0].state).toBe('stale')
    expect(byId.get('ended')!.runs).toBeUndefined()
    expect(byId.get('queued')).toMatchObject({ turn: 'agent_working', working: true })
  })

  it('says whether a task is handed to an agent, from the last board; null for a task it does not hold', async () => {
    const { board } = setup({ main: [mine('handed', { delegate: 'atlas', checkpoint: 'after' }), mine('mine-only')] })
    expect(board.delegated('handed')).toBeNull()
    await board.get(60_000)
    expect(board.delegated('handed')).toBe(true)
    expect(board.delegated('mine-only')).toBe(false)
    expect(board.delegated('unknown')).toBeNull()
  })

  it('names a task as the tasks card does, from open, closed and lineage tasks, and builds a board when none is there yet', async () => {
    const log: string[] = []
    const { board, brains } = setup({
      main: [mine('fix-stock', { display_title: 'Fix the stock answers' }), mine('plain-anchor'), mine('session-2026-11-24-a609860b'), mine('done-one', { display_title: 'Done one' }, 'resolved')],
      log,
    })
    // No board yet: no name, and one build starts (not one per call).
    expect(board.nameOf('fix-stock')).toBeNull()
    expect(board.nameOf('fix-stock')).toBeNull()
    await board.get(60_000)
    expect(brains.get('main')!.queries.filter((q) => q.status === 'active')).toHaveLength(1)
    expect(board.nameOf('fix-stock')).toBe('Fix the stock answers')
    expect(board.nameOf('plain-anchor')).toBe('Plain anchor')
    expect(board.nameOf('session-2026-11-24-a609860b')).toBeNull()
    expect(board.nameOf('done-one')).toBe('Done one')
    expect(board.nameOf('unknown')).toBeNull()
    expect(log).toEqual([])
  })

  it('gives a task closed in the Done window its put-away sessions, so its chat shows; an open task only its live ones', async () => {
    const { board } = setup({
      main: [mine('just-done', {}, 'resolved'), mine('open')],
      working: ['open'],
      ledger: { 'just-done': ['s-archived', 's-older'], open: ['s0', 's-archived-open'] },
    })
    const model = await board.refresh()
    expect(model.tasks.find((t) => t.id === 'just-done')!.sessionIds).toEqual(['s-archived', 's-older'])
    expect(model.tasks.find((t) => t.id === 'open')!.sessionIds).toEqual(['s0'])
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
    expect(turn('at-nine')).toMatchObject({ turn: 'agent_scheduled', group: 'at_time', nextRunAt: '2026-11-20T01:00:00.000Z' })
    expect(turn('own')).toMatchObject({ turn: 'needs_you', group: 'own' })
    expect(turn('closed')?.turn).toBe('done')
    expect(model.counts).toEqual({ needsYou: 2, inbox: 2 })
    expect(model.inbox.map((i) => [i.kind, i.taskId])).toEqual([['question', 'asked'], ['review', 'review']])
    expect(model.spaces).toEqual([{ id: 'main', name: 'Main', agents: ['atlas'] }, { id: 'ebisu', name: 'Ebisu', agents: [] }])
    expect(model.projects).toContainEqual({ spaceId: 'main', id: 'acme', name: 'Acme', goal: 'keep the customer' })
  })

  it('says why the runner does not start a delegated task, from the runner\'s own checks', async () => {
    const step = (id: string, props: Record<string, unknown> = {}, extra: Partial<Row> = {}): Row => ({ ...mine(id, { delegate: 'atlas', checkpoint: 'after', ...props }, 'planned'), ...extra })
    const { board } = setup({
      main: [
        mine('pr', { delegate: 'atlas', checkpoint: 'after', display_title: 'Open PR #252', waiting_on: { who: 'lasse', kind: 'review', why: 'Review: PR #252 is open against alpha' } }),
        step('after-review', { depends_on: ['pr'] }),
        step('after-dropped', { depends_on: ['dropped'] }),
        mine('dropped', {}, 'invalidated'),
        step('after-old', { depends_on: ['old-done'] }),
        step('next'),
        step('busy'),
        step('held'),
        step('nowhere', {}, { scope: 'global' }),
        mine('parked', {}, 'planned'),
        step('in-parked', {}, { parent_id: 'parked' }),
        step('in-closed', {}, { parent_id: 'closed-parent' }),
      ],
      unlisted: [{ id: 'old-done', status: 'resolved' }, { id: 'closed-parent', status: 'resolved' }],
      busy: ['busy'],
      held: ['held'],
    })
    const model = await board.refresh()
    const of = (id: string) => model.tasks.find((t) => t.id === id)!
    expect(of('after-review')).toMatchObject({
      turn: 'agent_scheduled', group: 'blocked',
      runner: { kind: 'depends', stepId: 'pr', title: 'Open PR #252', status: 'active', step: { turn: 'review', waitingOn: { who: 'lasse', kind: 'review' } } },
    })
    expect(of('after-dropped')).toMatchObject({ turn: 'needs_you', group: 'nobody', reason: 'step_dropped', runner: { kind: 'depends', status: 'invalidated' } })
    // A step resolved long ago (beyond the resolved list) is fetched by id and counts as resolved, as for the runner.
    expect(of('after-old')).toMatchObject({ turn: 'agent_scheduled', group: 'runner' })
    expect(of('after-old').runner).toBeUndefined()
    expect(of('next')).toMatchObject({ turn: 'agent_scheduled', group: 'runner' })
    expect(of('busy')).toMatchObject({ group: 'blocked', runner: { kind: 'busy' } })
    expect(of('held')).toMatchObject({ group: 'blocked', runner: { kind: 'held' } })
    expect(of('nowhere')).toMatchObject({ turn: 'needs_you', group: 'nobody', reason: 'no_project', coverage: { ok: false, group: 'idle', reason: 'no_project' } })
    expect(of('in-parked')).toMatchObject({ turn: 'needs_you', group: 'parent', runner: { kind: 'parent', parentId: 'parked', status: 'planned' } })
    // A parent the open lists don't hold is closed: the runner won't start the step.
    expect(of('in-closed')).toMatchObject({ turn: 'needs_you', group: 'parent', runner: { kind: 'parent', status: 'resolved' } })
  })

  it('names the cap when five delegated tasks run, and another member\'s task in a shared space', async () => {
    const running = Array.from({ length: 5 }, (_, i) => mine(`run-${i}`, { delegate: 'atlas', checkpoint: 'after' }))
    const { board } = setup({
      main: [...running, mine('queued', { delegate: 'atlas', checkpoint: 'after' }, 'planned')],
      working: running.map((r) => r.id),
      other: [{ id: 'theirs', status: 'planned', properties: { assignee_ids: ['dominik'], delegate: 'motti', checkpoint: 'after' } }],
    })
    const model = await board.refresh()
    const of = (id: string) => model.tasks.find((t) => t.id === id)!
    expect(of('queued')).toMatchObject({ turn: 'agent_scheduled', group: 'blocked', runner: { kind: 'cap', running: 5, max: 5, standalone: true } })
    expect(of('theirs')).toMatchObject({ turn: 'agent_scheduled', group: 'runner', runner: { kind: 'other_member', owner: 'dominik' } })
  })

  it('names the cap when the tasks of five spawned workers fill it: they count like any delegated task', async () => {
    // A task the cockpit made for a spawned worker: the agent's with checkpoint none and a request (application/worker-task.ts).
    const workers = Array.from({ length: 5 }, (_, i) => mine(`worker-${i}`, {
      delegate: 'atlas', checkpoint: 'none', delegation: { agent: 'atlas', checkpoint: 'none', requested_at: '2026-11-19T09:30:00.000Z' },
    }))
    const { board } = setup({
      main: [...workers, mine('lasses', { delegate: 'atlas', checkpoint: 'after', goal: 'Shipped' }, 'planned')],
      working: workers.map((w) => w.id),
    })
    const model = await board.refresh()
    expect(model.tasks.find((t) => t.id === 'lasses')).toMatchObject({ turn: 'agent_scheduled', group: 'blocked', runner: { kind: 'cap', running: 5, max: 5, standalone: true } })
    expect(model.tasks.find((t) => t.id === 'worker-0')).toMatchObject({ turn: 'agent_working' })
  })

  it('counts a slot as the runner does: tasks waiting on an answer and another member\'s tasks hold none, a fresh start does', async () => {
    const theirs = (id: string): Row => ({ id, status: 'active', properties: { assignee_ids: ['dominik'], delegate: 'motti', checkpoint: 'after' } })
    const own = (id: string, props: Record<string, unknown> = {}) => mine(id, { delegate: 'atlas', checkpoint: 'after', ...props })
    const { board } = setup({
      main: [],
      other: [
        own('now-plan', { waiting_on: { who: 'lasse', kind: 'question', why: 'Which view?' } }),
        theirs('grok'), theirs('audit'), theirs('t1'), theirs('dupes'),
        mine('follow-up', { delegate: 'atlas', checkpoint: 'after' }, 'planned'),
      ],
      working: ['grok'],
    })
    const of = (model: Awaited<ReturnType<typeof board.refresh>>, id: string) => model.tasks.find((t) => t.id === id)!
    const model = await board.refresh()
    expect(of(model, 'follow-up')).toMatchObject({ turn: 'agent_scheduled', group: 'runner' })
    expect(of(model, 'follow-up').runner).toBeUndefined()

    // Four working own tasks and one the runner started a moment ago fill the cap; past the grace its slot frees.
    const working = ['w-1', 'w-2', 'w-3', 'w-4'].map((id) => own(id))
    const filled = setup({
      main: [...working, own('fresh'), mine('queued', { delegate: 'atlas', checkpoint: 'after' }, 'planned')],
      working: working.map((w) => w.id),
      started: { fresh: Date.parse('2026-11-19T09:59:50Z') },
    })
    expect(of(await filled.board.refresh(), 'queued')).toMatchObject({ group: 'blocked', runner: { kind: 'cap', running: 5, max: 5 } })
    filled.clock.now += 60_000
    expect(of(await filled.board.refresh(), 'queued').runner).toBeUndefined()
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
        mine('asked-and-handed', { goal: 'Done', waits: [waits[0], { id: 'kim', who: 'kim', kind: 'outside', why: 'reply' }] }),
      ],
      pending: () => [
        { opId: 'op-h', kind: 'hand_over', spaceId: 'main', taskId: 'asked-and-handed', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } },
      ],
    })
    const model = await board.refresh()
    // v0.23: a question blocks the agent and ranks above a review
    expect(model.tasks.find((t) => t.id === 'two')).toMatchObject({ turn: 'needs_you', group: 'asked', waitingOn: { kind: 'question', session_id: 's1' } })
    expect(model.inbox.map((i) => [i.kind, i.sessionId]).sort()).toEqual([['question', 's1'], ['review', 's2']])
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
      main: [mine('asked', { goal: 'Done', waiting_on: { who: 'lasse', kind: 'question', why: 'Which list?' } }), mine('done-soon', { waiting_on: { who: 'lasse', kind: 'review' } })],
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

  it('shows a pending Delegate on a task without a goal as it will end: refused, so the task stays as it is', async () => {
    const { board } = setup({
      main: [mine('bare')],
      pending: () => [{ opId: 'op-b', kind: 'hand_over', spaceId: 'main', taskId: 'bare', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } }],
    })
    expect((await board.refresh()).tasks.find((t) => t.id === 'bare')?.delegate).toBeUndefined()
  })

  it('says whether a task has a schedule: whatever its state and whoever owns the task', async () => {
    const schedule = { crons: ['0 8 * * *'], time_zone: 'UTC' }
    const { board } = setup({
      main: [
        mine('daily', { delegate: 'atlas' }), mine('paused', { delegate: 'atlas' }), mine('plain'),
        mine('repeating', { delegation: { agent: 'atlas', schedule } }),
        { id: 'theirs', status: 'active', properties: { assignee_ids: ['dominik'], delegation: { agent: 'atlas', schedule } } },
      ],
      jobs: { daily: '2026-11-20T00:00:00.000Z' }, openJobs: ['paused'],
    })
    const model = await board.refresh()
    const of = (id: string) => model.tasks.find((t) => t.id === id)!
    expect(of('daily')).toMatchObject({ hasSchedule: true, nextRunAt: '2026-11-20T00:00:00.000Z' })
    // No run is coming up, but it could be resumed: it closes only by ending its schedule.
    expect(of('paused')).toMatchObject({ hasSchedule: true, nextRunAt: null })
    expect(of('plain').hasSchedule).toBe(false)
    expect(of('repeating')).toMatchObject({ hasSchedule: true, nextRunAt: '2026-11-20T08:00:00.000Z' })
    expect(of('theirs').hasSchedule).toBe(true)
  })

  it('shows a pending Looks good on a task whose schedule is on as still open, without the reviews it answers; End schedule as closed', async () => {
    const review = { id: 's1', who: 'lasse', kind: 'review', why: 'Review: brief written', since: '2026-11-19T08:00:00.000Z', session_id: 's1' }
    const later = { ...review, why: 'Review: next brief written', since: '2026-11-19T09:59:00.000Z' }
    const kim = { id: 'kim', who: 'kim', kind: 'outside', why: 'Kim answers', since: '2026-11-19T07:00:00.000Z' }
    const pending = (opId: string, kind: string, taskId: string, extra: Record<string, unknown> = {}) => ({ opId, kind, spaceId: 'main', taskId, undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '', ...extra })
    const { board } = setup({
      main: [
        mine('daily', { delegate: 'atlas', waits: [review, kim], waiting_on: review }),
        // Its schedule is paused: no run is coming up, it has one all the same.
        mine('paused', { waits: [review], waiting_on: review }),
        // Another member's task: its schedule counts all the same.
        { id: 'mirrored', status: 'active', properties: { assignee_ids: ['other'], waits: [review], waiting_on: review, delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * *'], time_zone: 'UTC' } } } },
        // Its schedule has ended since, but it had one when the owner chose Looks good.
        mine('was-scheduled', { waits: [review], waiting_on: review }),
        // The next run asked for its review after the owner approved the one before: that one stays.
        mine('next-run', { waits: [later], waiting_on: later }),
        // A wait from before kinds existed, a review by its why.
        mine('old-wait', { waiting_on: { who: 'lasse', why: 'Review: brief written' } }),
        mine('once', { waits: [review], waiting_on: review }),
        mine('ending', { delegate: 'atlas' }),
      ],
      jobs: { daily: '2026-11-20T00:00:00.000Z', ending: '2026-11-20T00:00:00.000Z', 'next-run': '2026-11-20T00:00:00.000Z', 'old-wait': '2026-11-20T00:00:00.000Z' },
      openJobs: ['paused'],
      pending: () => [
        pending('op-1', 'review', 'daily'), pending('op-2', 'review', 'mirrored'), pending('op-3', 'review', 'was-scheduled', { runOnly: true }),
        pending('op-4', 'review', 'once'), pending('op-5', 'end_schedule', 'ending'), pending('op-6', 'review', 'paused'),
        pending('op-7', 'review', 'next-run', { runOnly: true, approves: [{ id: 's1', since: review.since }] }), pending('op-8', 'review', 'old-wait'),
      ] as never,
    })
    const model = await board.refresh()
    const of = (id: string) => model.tasks.find((t) => t.id === id)!
    expect(of('daily')).toMatchObject({ status: 'active', nextRunAt: '2026-11-20T00:00:00.000Z', waitingOn: { who: 'kim', kind: 'outside' }, pending: { opId: 'op-1', kind: 'review' } })
    expect(of('daily').turn).not.toBe('done')
    for (const id of ['mirrored', 'was-scheduled', 'paused', 'old-wait']) {
      expect(of(id).status, id).toBe('active')
      expect(of(id).waitingOn, id).toBeUndefined()
      expect(of(id).turn, id).not.toBe('review')
    }
    expect(of('next-run')).toMatchObject({ status: 'active', turn: 'review', waitingOn: { why: 'Review: next brief written' } })
    expect(of('once')).toMatchObject({ status: 'resolved', turn: 'done', pending: { opId: 'op-4' } })
    expect(of('ending')).toMatchObject({ status: 'resolved', turn: 'done', pending: { opId: 'op-5', kind: 'end_schedule' } })
    // The reviews left the Inbox with the click; only the next run's still asks for the viewer.
    expect(model.inbox.map((i) => i.taskId)).toEqual(['next-run'])
  })

  it('lists closed tasks for Reopen and ⌘K, with why a reopen would be refused, and shows a pending reopen as active', async () => {
    const { board, brains } = setup({
      main: [
        mine('open-parent'),
        mine('done', { outcome: 'Shipped', delegate: 'atlas', checkpoint: 'after' }, 'resolved'),
        mine('dropped', {}, 'invalidated'),
        mine('replaced', {}, 'superseded'),
        { ...mine('orphan', {}, 'invalidated'), parent_id: 'closed-parent' },
        { ...mine('kept', {}, 'invalidated'), parent_id: 'open-parent' },
        mine('coming-back', { waiting_on: { who: 'lasse', kind: 'review' } }, 'invalidated'),
      ],
      pending: () => [{ opId: 'op-r', kind: 'reopen', spaceId: 'main', taskId: 'coming-back', undoUntil: '2026-11-19T10:00:08Z', state: 'pending', createdAt: '' }],
    })
    const model = await board.refresh()
    const closed = new Map(model.closed.map((t) => [t.id, t]))
    expect(closed.get('done')).toMatchObject({ status: 'resolved', outcome: 'Shipped', owner: 'lasse', delegate: 'atlas', checkpoint: 'after', closedAt: '2026-11-19T09:00:00Z' })
    expect(closed.get('done')!.blocked).toBeUndefined()
    expect(closed.get('dropped')).toMatchObject({ status: 'invalidated' })
    expect(closed.get('replaced')).toMatchObject({ blocked: 'superseded' })
    expect(closed.get('orphan')).toMatchObject({ blocked: 'parent_closed' })
    expect(closed.get('kept')!.blocked).toBeUndefined()
    expect(closed.has('coming-back')).toBe(false)
    expect(model.tasks.find((t) => t.id === 'coming-back')).toMatchObject({ status: 'active', pending: { opId: 'op-r', kind: 'reopen' } })
    expect(model.tasks.find((t) => t.id === 'coming-back')!.waitingOn).toBeUndefined()
    // Neither dropped nor replaced tasks get a turn on the board.
    expect(model.tasks.some((t) => t.id === 'dropped' || t.id === 'replaced')).toBe(false)
    expect(brains.get('main')!.queries.map((q) => q.status)).toEqual(expect.arrayContaining(['invalidated', 'superseded']))
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

  describe('a brain that does not answer', () => {
    /** Make the space's brain fail every read with `err` until the returned function is called. */
    const breakBrain = (brain: { get: (path: string, query?: Record<string, unknown>) => Promise<unknown> }, err: () => Error) => {
      const plainGet = brain.get.bind(brain)
      brain.get = async () => { throw err() }
      return () => { brain.get = plainGet }
    }
    const timeout = () => Object.assign(new Error('GET /list?type=task timed out after 30000ms'), { status: 0 })

    it('keeps the space as its brain gave it last, marked stale, while the other spaces update', async () => {
      const log: string[] = []
      const { board, brains } = setup({ main: [mine('a'), mine('done', {}, 'resolved')], other: [mine('e1')], log })
      const before = await board.refresh()
      const mend = breakBrain(brains.get('main')!, timeout)
      brains.get('ebisu')!.rows.push(mine('e2'))
      const during = await board.refresh()
      expect(during.tasks.filter((t) => t.spaceId === 'main')).toEqual(before.tasks.filter((t) => t.spaceId === 'main'))
      expect(during.closed).toEqual(before.closed)
      expect(during.projects).toEqual(before.projects)
      expect(during.inbox).toEqual(before.inbox)
      expect(during.spaces.map((sp) => [sp.id, sp.stale ?? false])).toEqual([['main', true], ['ebisu', false]])
      expect(during.tasks.filter((t) => t.spaceId === 'ebisu').map((t) => t.id)).toEqual(['e1', 'e2'])
      // said once, however many builds fail
      await board.refresh()
      expect(log.filter((l) => l.includes('Main: its brain did not answer'))).toEqual(['[board] Main: its brain did not answer (GET /list?type=task timed out after 30000ms); showing its last state'])
      mend()
      brains.get('main')!.rows.push(mine('b'))
      const after = await board.refresh()
      expect(after.tasks.filter((t) => t.spaceId === 'main').map((t) => t.id)).toEqual(['a', 'b', 'done'])
      expect(after.spaces[0]).not.toHaveProperty('stale')
      expect(log.filter((l) => l.includes('Main: its brain answers again'))).toHaveLength(1)
    })

    it('does not ask a second time without the new parameters: only a refusal is worth that', async () => {
      const { board, brains } = setup({ main: [mine('a')] })
      await board.refresh()
      const brain = brains.get('main')!
      const plainGet = brain.get.bind(brain)
      let lists = 0
      brain.get = async (path: string, query?: Record<string, unknown>) => {
        if (path !== '/list') return plainGet(path, query)
        lists++
        throw new Error('GET /list failed: fetch failed')
      }
      await board.refresh()
      // the five lists of one build, each asked once
      expect(lists).toBe(5)
    })

    it('takes a server error as no answer too', async () => {
      const { board, brains } = setup({ main: [mine('a')] })
      await board.refresh()
      breakBrain(brains.get('main')!, () => Object.assign(new Error('brain needs intervention'), { status: 503 }))
      expect((await board.refresh()).tasks.map((t) => t.id)).toEqual(['a'])
    })

    it('lists the space without tasks, marked stale, when its brain never answered yet', async () => {
      const { board, brains } = setup({ main: [mine('a')], other: [mine('e1')] })
      breakBrain(brains.get('main')!, timeout)
      const model = await board.refresh()
      expect(model.spaces[0]).toEqual({ id: 'main', name: 'Main', agents: [], stale: true })
      expect(model.tasks.map((t) => t.id)).toEqual(['e1'])
    })

    it('tells the pages when a space goes stale and when it is back', async () => {
      const { board, brains } = setup({ main: [mine('a')] })
      let told = 0
      board.onChange(() => { told++ })
      await board.refresh()
      const mend = breakBrain(brains.get('main')!, timeout)
      await board.refresh()
      expect(told).toBe(1)
      mend()
      await board.refresh()
      expect(told).toBe(2)
    })

    it('does not take a mistake of its own for a brain that is away', async () => {
      const { board, brains } = setup({ main: [mine('a')] })
      const brain = brains.get('main')!
      const plainGet = brain.get.bind(brain)
      // an answer the build cannot read: its own failure, not the brain's
      brain.get = async (path: string, query?: Record<string, unknown>) => path === '/list' ? { engrams: [null] } : plainGet(path, query)
      await expect(board.refresh()).rejects.toThrow(TypeError)
    })
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
    // said once when it starts and once when it ends, not with every try
    expect(log.filter((l) => l.includes('watching Main failed'))).toHaveLength(1)
    expect(log.filter((l) => l.includes('watching Main: its brain answers again after'))).toHaveLength(1)
  })

  it('refreshes once when a brain is back, whether or not its head moved, so nothing written meanwhile is missed', async () => {
    let down = false
    let calls = 0
    const waits: number[] = []
    const head: TaskBoardDeps['head'] = async (space, _after, waitMs) => {
      if (space.id !== 'main') return 1
      calls++
      waits.push(waitMs)
      if (down) throw new Error('GET /head?after=4&wait=25000 timed out after 35000ms')
      return 4
    }
    const { board, brains } = setup({ main: [mine('t1')], head })
    let told = 0
    board.onChange(() => { told++ })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, settleMs: 5, restMs: 5, sleep: quickSleep })
    await until(() => calls >= 2)
    down = true
    const failedAt = calls
    await until(() => calls >= failedAt + 2)
    // written while the watch got no answer; the head the watch sees afterwards is the one it knew
    brains.get('main')!.rows.push(mine('written-meanwhile', {}, 'planned'))
    down = false
    await until(() => told > 0)
    stop()
    expect((await board.get(60_000)).tasks.map((t) => t.id)).toContain('written-meanwhile')
    // after a failed call the head is asked for without waiting, so the answer comes as soon as the brain is back
    expect(waits.slice(failedAt + 1, failedAt + 3)).toEqual([0, 0])
  })

  it('asks a brain that does not answer again within ten seconds at most', async () => {
    const rests: number[] = []
    const head: TaskBoardDeps['head'] = async (space) => {
      if (space.id !== 'main') return 1
      throw new Error('fetch failed')
    }
    const { board } = setup({ main: [mine('t1')], head })
    await board.get(5000)
    const stop = board.watch({ viewedMs: 60_000, restMs: 2000, sleep: (ms) => { rests.push(ms); return quickSleep(ms) } })
    await until(() => rests.filter((ms) => ms === 10_000).length >= 2)
    stop()
    expect(Math.max(...rests)).toBe(10_000)
    expect(rests.slice(0, rests.indexOf(10_000) + 1).filter((ms) => ms > 2000)).toEqual([4000, 8000, 10_000])
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

  it('lists a project\'s closed tasks, done, dropped and replaced, newest first, shaped for the panel', async () => {
    const { board, brains } = setup({ main: [
      { id: 'done-new', status: 'resolved', updated_at: '2026-11-19T09:00:00Z', parent_id: 'root', properties: { display_title: 'Done new', assignee_ids: ['lasse'], outcome: 'Shipped' } },
      { id: 'dropped', status: 'invalidated', updated_at: '2026-11-18T09:00:00Z', origin_task_id: 'root' },
      { id: 'replaced', status: 'superseded', updated_at: '2026-11-17T09:00:00Z' },
      { id: 'done-old', status: 'resolved', updated_at: '2026-11-01T09:00:00Z' },
      mine('open'),
    ] })
    const answer = await board.closed('main', 'acme', 3)
    expect(answer).toEqual({ ok: true, page: {
      tasks: [
        { id: 'done-new', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'done-new', displayTitle: 'Done new', status: 'resolved', closedAt: '2026-11-19T09:00:00Z', outcome: 'Shipped', owner: 'lasse', parentId: 'root', originId: null, sessionIds: [], blocked: 'parent_closed' },
        { id: 'dropped', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'dropped', status: 'invalidated', closedAt: '2026-11-18T09:00:00Z', parentId: null, originId: 'root', sessionIds: [] },
        { id: 'replaced', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'replaced', status: 'superseded', closedAt: '2026-11-17T09:00:00Z', parentId: null, originId: null, sessionIds: [], blocked: 'superseded' },
      ],
      more: true,
    } })
    expect(brains.get('main')!.queries.at(-1)).toMatchObject({ type: 'task', scope: 'project.acme', order_by: 'updated_at', limit: 4 })
    expect(await board.closed('main', 'acme', 4)).toMatchObject({ ok: true, page: { more: false } })
    expect(await board.closed('nowhere', 'acme', 3)).toEqual({ ok: false, refusal: 'unknown_space' })
  })

  it('leaves out a closed task whose Reopen is still in its Undo window', async () => {
    const { board } = setup({
      main: [{ id: 'reopening', status: 'resolved' }, { id: 'done', status: 'resolved' }],
      pending: () => [{ opId: 'op', kind: 'reopen', taskId: 'reopening', spaceId: 'main', state: 'pending', createdAt: '2026-11-19T09:59:58Z', undoUntil: '2026-11-19T10:00:06Z' } as never],
    })
    expect(await board.closed('main', 'acme', 20)).toMatchObject({ ok: true, page: { tasks: [{ id: 'done' }] } })
  })

  it('fails the closed tasks when the brain does not answer, instead of saying nothing is closed', async () => {
    const log: string[] = []
    const { board, brains } = setup({ main: [], log })
    brains.get('main')!.get = async () => { throw new Error('connect ECONNREFUSED') }
    expect(await board.closed('main', 'acme', 20)).toEqual({ ok: false, refusal: 'brain_unavailable' })
    expect(log.at(-1)).toContain('ECONNREFUSED')
  })

  it('lists closed tasks without origins on a brain server that refuses with_origin', async () => {
    const { board } = setup({ main: [{ id: 'done', status: 'resolved' }], oldBrain: true })
    expect(await board.closed('main', 'acme', 20)).toMatchObject({ ok: true, page: { tasks: [{ id: 'done' }] } })
  })
})
