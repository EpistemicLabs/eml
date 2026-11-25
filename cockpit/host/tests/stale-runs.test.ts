import { describe, it, expect } from 'vitest'
import { STALE_MS } from '../src/domain/runs.js'
import { hungSessions, isStaleWait, spanText, staleWaitsAfter, STALE_WHY } from '../src/domain/stale-runs.js'
import { inboxItems } from '../src/domain/inbox.js'
import { turnOf } from '../src/domain/task-turn.js'
import { urgentWaitOf, waitsOf } from '../src/domain/task-waits.js'
import { createStaleRuns, type StaleSession } from '../src/application/stale-runs.js'

const NOW = Date.parse('2026-11-19T10:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const LONG = ago(STALE_MS + 60_000)
const RECENT = ago(5 * 60_000)

const run = (patch: Record<string, unknown> = {}) => ({ id: 's1', task_id: 't1', member: 'lasse', state: 'running', last_activity_at: LONG, ...patch })
const session = (patch: Partial<StaleSession> & { activityAt?: string | null } = {}) => ({ sessionId: 's1', taskId: 't1', archived: false, spaceId: 'main', ...patch })
const task = (properties: Record<string, unknown> = {}, status = 'active') => ({ id: 't1', status, rev: 1, properties: { assignee_ids: ['lasse'], delegate: 'atlas', ...properties } })
const staleWait = (patch: Record<string, unknown> = {}) => ({ id: 's1', who: 'lasse', kind: 'stopped', why: STALE_WHY, since: '2026-11-19T09:30:00.000Z', session_id: 's1', ...patch })

describe('a hung worker (domain)', () => {
  it('words the wait from STALE_MS', () => {
    expect(STALE_WHY).toBe('No activity for 1 h')
    expect(spanText(90 * 60_000)).toBe('90 min')
    expect(spanText(2 * 60 * 60_000)).toBe('2 h')
  })

  it('is this cockpit\'s session whose run says running without activity for STALE_MS', () => {
    const hung = (runs: Array<Record<string, unknown>>, sessions = [session()]) => [...hungSessions({ runs: runs as never, sessions, me: 'lasse', now: NOW })]
    expect(hung([run()])).toEqual([['s1', 't1']])
    expect(hung([run({ last_activity_at: RECENT })])).toEqual([])
    expect(hung([run({ state: 'idle' })])).toEqual([])
    expect(hung([run({ state: 'ended' })])).toEqual([])
    // Another member's run, a session this cockpit does not have, one put away, one on another task: not ours to judge.
    expect(hung([run({ member: 'dominik' })])).toEqual([])
    expect(hung([run({ id: 'elsewhere' })])).toEqual([])
    expect(hung([run()], [session({ archived: true })])).toEqual([])
    expect(hung([run()], [session({ taskId: 't2' })])).toEqual([])
  })

  it('is not hung while the session itself still does something: a run is written only when its state changes', () => {
    const hung = (activityAt: string | null) => hungSessions({ runs: [run()] as never, sessions: [session({ activityAt })], me: 'lasse', now: NOW }).size
    expect(hung(RECENT)).toBe(0)
    expect(hung(LONG)).toBe(1)
    expect(hung(null)).toBe(1)
    expect(hung('not a date')).toBe(1)
  })

  const after = (t: ReturnType<typeof task>, hung: boolean) => staleWaitsAfter({ task: t, sessionId: 's1', hung, me: 'lasse', now: new Date(NOW) })

  it('puts a stopped wait on the task\'s owner, as the session\'s own wait', () => {
    expect(after(task(), true)).toEqual([{ id: 's1', who: 'lasse', kind: 'stopped', why: 'No activity for 1 h', since: '2026-11-19T10:00:00.000Z', session_id: 's1' }])
    expect(after(task({ assignee_ids: ['dominik'] }), true)?.[0].who).toBe('dominik')
    expect(after(task({ assignee_ids: [] }), true)?.[0].who).toBe('lasse')
  })

  it('keeps the waits of other sessions and comes after them', () => {
    const other = { id: 's2', who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T09:00:00.000Z', session_id: 's2' }
    expect(after(task({ waits: [other] }), true)?.map((w) => w.id)).toEqual(['s2', 's1'])
    expect(after(task({ waits: [other, staleWait()] }), false)).toEqual([other])
  })

  it('writes nothing when the wait is there already, or the session has a wait of its own', () => {
    expect(after(task({ waits: [staleWait()] }), true)).toBeNull()
    expect(after(task({ waits: [staleWait({ kind: 'question', why: 'Which list?' })] }), true)).toBeNull()
    expect(after(task({ waits: [staleWait({ why: 'Agent stopped without a next step' })] }), true)).toBeNull()
  })

  it('only for an open task that is handed to an agent', () => {
    expect(after(task({ delegate: undefined }), true)).toBeNull()
    expect(after(task({}, 'resolved'), true)).toBeNull()
    // The task was taken back or closed while the wait stood: it goes.
    expect(after(task({ delegate: undefined, waits: [staleWait()] }), true)).toEqual([])
  })

  it('removes the wait once the run shows activity again or ended, and no other wait of the session', () => {
    expect(after(task({ waits: [staleWait()] }), false)).toEqual([])
    expect(after(task(), false)).toBeNull()
    expect(after(task({ waits: [staleWait({ kind: 'question', why: 'Which list?' })] }), false)).toBeNull()
    expect(after(task({ waits: [staleWait({ why: 'Agent stopped without a next step' })] }), false)).toBeNull()
    expect(after(task({ waits: [staleWait({ kind: 'review', why: 'Review: done' })] }), false)).toBeNull()
  })

  it('reaches the Inbox as a stopped item and Now as Needs you · failed', () => {
    const waits = after(task(), true)!
    expect(isStaleWait(waits[0])).toBe(true)
    expect(inboxItems([{ id: 't1', space: 'main', title: 'Ship it', waits }], 'lasse', [], NOW).live).toMatchObject([{ kind: 'stopped', text: 'No activity for 1 h', taskId: 't1', sessionId: 's1' }])
    const facts = { status: 'active', owner: 'lasse', delegate: 'atlas', checkpoint: 'after', parentActive: null, waitingOn: urgentWaitOf({ waits }) }
    // The board does not count the silent session as working (application/task-board.ts).
    expect(turnOf(facts, { working: false, sessions: 1, nextRunAt: null }, 'lasse', NOW)).toEqual({ turn: 'needs_you', group: 'failed', reason: 'stopped' })
    // For another member it is the owner's move.
    expect(turnOf(facts, { working: false, sessions: 0, nextRunAt: null }, 'dominik', NOW)).toEqual({ turn: 'waiting_on_others' })
  })
})

function world(opts: { tasks: Array<ReturnType<typeof task>>; runs: Array<Record<string, unknown>>; sessions?: StaleSession[]; activity?: Record<string, string> }) {
  const state = { ...opts, sessions: opts.sessions ?? [session()], activity: opts.activity ?? {} as Record<string, string>, now: NOW }
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const gets: string[] = []
  const log: string[] = []
  const brain = {
    async get(path: string, query?: Record<string, unknown>) {
      gets.push(path)
      if (path === '/object/run') return { objects: state.runs }
      if (path === '/list') return { engrams: state.tasks.filter((t) => t.status === query?.status) }
      const found = state.tasks.find((t) => path === `/engram/${t.id}`)
      if (!found) throw new Error('not found')
      return found
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const found = state.tasks.find((t) => path === `/task/${t.id}/track`)!
      if ('waits' in body) found.properties = { ...found.properties, waits: body.waits ?? undefined }
      found.rev += 1
      return {}
    },
  }
  const stale = createStaleRuns({
    spaces: () => [{ id: 'main', name: 'Main' } as never],
    brain: () => brain as never,
    me: 'lasse',
    sessions: () => state.sessions,
    activityAt: (sessionId) => state.activity[sessionId] ?? null,
    log: (line) => { log.push(line) },
    now: () => new Date(state.now),
  })
  return { state, posts, gets, log, stale, waits: (i = 0) => waitsOf(state.tasks[i].properties) }
}

describe('hung workers (the tick)', () => {
  it('writes the wait once, however often it ticks', async () => {
    const w = world({ tasks: [task()], runs: [run()] })
    await w.stale.tick()
    await w.stale.tick()
    await w.stale.tick()
    expect(w.posts).toHaveLength(1)
    expect(w.posts[0]).toMatchObject({ path: '/task/t1/track', body: { base_rev: 1 } })
    expect(w.waits()).toMatchObject([{ id: 's1', who: 'lasse', kind: 'stopped', why: 'No activity for 1 h', session_id: 's1' }])
    expect(w.log.filter((l) => l.includes('waits on its owner'))).toHaveLength(1)
  })

  it('leaves a run alone that is active, idle, or whose session still does something', async () => {
    const w = world({ tasks: [task()], runs: [run({ last_activity_at: RECENT })] })
    await w.stale.tick()
    w.state.runs = [run({ state: 'idle' })]
    await w.stale.tick()
    w.state.runs = [run()]
    w.state.activity = { s1: RECENT }
    await w.stale.tick()
    expect(w.posts).toEqual([])
  })

  it('removes the wait when the run shows activity again', async () => {
    const w = world({ tasks: [task()], runs: [run()] })
    await w.stale.tick()
    w.state.activity = { s1: RECENT }
    await w.stale.tick()
    expect(w.waits()).toEqual([])
    expect(w.posts).toHaveLength(2)
    // Silent again later: a new wait.
    w.state.activity = {}
    await w.stale.tick()
    expect(w.waits()).toHaveLength(1)
  })

  it('removes the wait when the run ends or the session is put away', async () => {
    const ended = world({ tasks: [task()], runs: [run()] })
    await ended.stale.tick()
    ended.state.runs = [run({ state: 'ended' })]
    await ended.stale.tick()
    expect(ended.waits()).toEqual([])

    const away = world({ tasks: [task()], runs: [run()] })
    await away.stale.tick()
    away.state.sessions = [session({ archived: true })]
    await away.stale.tick()
    expect(away.waits()).toEqual([])
  })

  it('a session that ended its turn with a question keeps that wait: the router replaced the stale one', async () => {
    const w = world({ tasks: [task()], runs: [run()] })
    await w.stale.tick()
    const question = staleWait({ kind: 'question', why: 'Which list?' })
    w.state.tasks[0].properties = { ...w.state.tasks[0].properties, waits: [question] }
    w.state.runs = [run({ state: 'idle', last_activity_at: RECENT })]
    await w.stale.tick()
    expect(w.waits()).toEqual([question])
    expect(w.posts).toHaveLength(1)
  })

  it('does not bring the wait back while the session stays silent after the user answered', async () => {
    const w = world({ tasks: [task()], runs: [run()] })
    await w.stale.tick()
    w.state.tasks[0].properties = { ...w.state.tasks[0].properties, waits: undefined }
    await w.stale.tick()
    await w.stale.tick()
    expect(w.waits()).toEqual([])
    expect(w.posts).toHaveLength(1)
  })

  it('does not write over a wait the session already has, and looks again next time', async () => {
    const review = staleWait({ kind: 'review', why: 'Review: done' })
    const w = world({ tasks: [task({ waits: [review] })], runs: [run()] })
    await w.stale.tick()
    expect(w.posts).toEqual([])
    w.state.tasks[0].properties = { ...w.state.tasks[0].properties, waits: undefined }
    await w.stale.tick()
    expect(w.waits()).toMatchObject([{ kind: 'stopped', why: 'No activity for 1 h' }])
  })

  it('skips a task that is not handed to an agent, and another member\'s run', async () => {
    const w = world({ tasks: [task({ delegate: undefined })], runs: [run()] })
    await w.stale.tick()
    w.state.tasks[0].properties = { ...w.state.tasks[0].properties, delegate: 'atlas' }
    w.state.runs = [run({ member: 'dominik' })]
    await w.stale.tick()
    expect(w.posts).toEqual([])
  })

  it('after a restart, removes a wait the host left behind once its run ended; another cockpit\'s stays', async () => {
    const theirs = staleWait({ id: 'far', session_id: 'far' })
    const w = world({ tasks: [task({ waits: [staleWait(), theirs] })], runs: [run({ state: 'ended' })] })
    await w.stale.tick()
    expect(w.waits()).toEqual([theirs])
    // The open tasks are read once, not on every tick.
    await w.stale.tick()
    expect(w.gets.filter((p) => p === '/list')).toHaveLength(2)
  })

  it('never throws: a brain without runs is logged once', async () => {
    const w = world({ tasks: [task()], runs: [run()] })
    const broken = createStaleRuns({
      spaces: () => [{ id: 'main', name: 'Main' } as never],
      brain: () => ({ get: async () => { throw new Error('unknown object run') }, post: async () => ({}) }) as never,
      me: 'lasse', sessions: () => w.state.sessions, log: (line) => { w.log.push(line) },
    })
    await broken.tick()
    await broken.tick()
    expect(w.log).toEqual(['[stale] Main: runs not readable — unknown object run'])
  })
})
