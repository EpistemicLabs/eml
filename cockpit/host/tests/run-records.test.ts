import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STALE_MS, isStale, liveFactsOf, openRunsByTask, runOriginOf, runStateOf, runsBlockRunner, sessionOfRun } from '../src/domain/runs.js'
import { createRunRecords, type RunSession } from '../src/application/run-records.js'
import { lastStartsOf, requestOpen } from '../src/domain/delegation.js'
import type { TurnState } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the modules that use it.
const home = mkdtempSync(join(tmpdir(), 'cockpit-run-records-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const T0 = Date.parse('2026-11-24T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('runs as the board and the runner read them', () => {
  const run = (id: string, state: string, at: number, member = 'dominik') => ({ id, task_id: 't', member, state, last_activity_at: iso(at) })

  it('a running run is stale once nothing happened in it for STALE_MS; idle and ended runs never are', () => {
    expect(isStale(run('r', 'running', T0 - STALE_MS + 1), T0)).toBe(false)
    expect(isStale(run('r', 'running', T0 - STALE_MS - 1), T0)).toBe(true)
    expect(isStale({ id: 'r', task_id: 't', member: 'm', state: 'running' }, T0)).toBe(true)
    expect(isStale(run('r', 'idle', T0 - 10 * STALE_MS), T0)).toBe(false)
  })

  it('joins this host\'s sessions with the open runs of sessions it does not have; a stale run counts, but does not work', () => {
    const runs = [run('mine', 'idle', T0, 'lasse'), run('theirs', 'running', T0 - 1000)]
    expect(liveFactsOf([{ sessionId: 'mine', working: false }], runs, null, T0)).toEqual({ working: true, sessions: 2, nextRunAt: null })
    expect(liveFactsOf([], [run('old', 'running', T0 - STALE_MS - 1)], 'x', T0)).toEqual({ working: false, sessions: 1, nextRunAt: 'x', stale: true })
    expect(liveFactsOf([], [run('gone', 'ended', T0)], null, T0)).toEqual({ working: false, sessions: 0, nextRunAt: null })
  })

  it('only a working run of a session this host does not have holds the runner', () => {
    expect(runsBlockRunner([run('theirs', 'running', T0)], new Set(), T0)).toBe(true)
    expect(runsBlockRunner([run('mine', 'running', T0)], new Set(['mine']), T0)).toBe(false)
    expect(runsBlockRunner([run('theirs', 'idle', T0)], new Set(), T0)).toBe(false)
    expect(runsBlockRunner([run('theirs', 'running', T0 - STALE_MS - 1)], new Set(), T0)).toBe(false)
  })

  it('names the session a run belongs to: its id, or the part before a later run\'s start', () => {
    expect(sessionOfRun('5f0c-aa')).toBe('5f0c-aa')
    expect(sessionOfRun('5f0c-aa_1764064800000')).toBe('5f0c-aa')
  })

  it('groups open runs by task and maps turns and origins', () => {
    const byTask = openRunsByTask([{ ...run('a', 'idle', T0), task_id: 't1' }, { ...run('b', 'ended', T0), task_id: 't1' }, { ...run('c', 'running', T0), task_id: 't2' }])
    expect([...byTask.entries()].map(([t, rs]) => [t, rs.map((r) => r.id)])).toEqual([['t1', ['a']], ['t2', ['c']]])
    expect(['working', 'waiting', 'done', 'idle', undefined].map((t) => runStateOf(t as TurnState | undefined))).toEqual(['running', 'idle', 'idle', 'idle', 'idle'])
    expect(runOriginOf({ jobId: 'j', worker: true, parentSessionId: null })).toEqual({ origin: 'job', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: true, parentSessionId: null })).toEqual({ origin: 'runner', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: true, parentSessionId: 'p' })).toEqual({ origin: 'user', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: false, parentSessionId: null })).toEqual({ origin: 'user', driver: 'human' })
    expect(runOriginOf({ jobId: null, worker: false, parentSessionId: null, runStartedAt: '2026-11-24T11:00:00.000Z' })).toEqual({ origin: 'runner', driver: 'agent' })
  })
})

/** A brain that keeps runs the way the server's object routes answer: PUT patches, an ended run is left out of the list. */
function brainOf(tasks: string[] = ['t1'], runs: Array<Record<string, unknown>> = []) {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const byId = new Map(runs.map((r) => [r.id as string, r]))
  return {
    writes,
    runs: byId,
    async get(path: string) {
      if (path === '/object/run') return { objects: [...byId.values()].filter((r) => r.state !== 'ended') }
      const one = /^\/object\/run\/(.+)$/.exec(path)
      if (one) return { object: byId.get(decodeURIComponent(one[1])) }
      throw new Error(`not found: ${path}`)
    },
    async post(path: string, body: Record<string, unknown>) {
      writes.push({ method: 'POST', path, body })
      if (!tasks.includes(body.task_id as string)) throw new Error(`Invalid object: task_id ${String(body.task_id)} is not a task of this brain.`)
      if (byId.has(body.id as string)) throw new Error(`Invalid object: run "${String(body.id)}" already exists.`)
      byId.set(body.id as string, { ...body })
      return { object: body }
    },
    async put(path: string, body: Record<string, unknown>) {
      writes.push({ method: 'PUT', path, body })
      const id = decodeURIComponent(path.slice('/object/run/'.length))
      byId.set(id, { ...byId.get(id), ...body })
      return {}
    },
  }
}

function setup(brain: ReturnType<typeof brainOf>, sessions: RunSession[]) {
  const turns = new Map<string, TurnState>()
  const processes = new Set<string>()
  const results = new Map<string, string>()
  const logs: string[] = []
  const records = createRunRecords({
    spaces: () => [{ id: 'main', name: 'Main' } as never],
    brain: () => brain,
    me: 'lasse',
    sessions: () => sessions,
    turnOf: (id) => turns.get(id),
    processRuns: (id) => processes.has(id),
    resultOf: (id) => results.get(id) ?? null,
    agentOf: () => 'atlas',
    log: (line) => logs.push(line),
  })
  return { records, turns, processes, results, logs }
}

const session = (sessionId: string, taskId: string | null, more: Partial<RunSession> = {}): RunSession => ({
  sessionId, taskId, spaceId: 'main', createdAt: '2026-11-24T09:00:00.000Z', archived: false, jobId: null, worker: false, parentSessionId: null, runStartedAt: null, ...more,
})

describe('run records', () => {
  it('writes a run when the session\'s process runs, follows its turns with the result line, and writes nothing when nothing changed', async () => {
    const brain = brainOf()
    const sessions = [session('s1', 't1', { worker: true })]
    const { records, turns, processes, results } = setup(brain, sessions)

    await records.sync()
    expect(brain.writes).toEqual([])

    processes.add('s1')
    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes).toEqual([{ method: 'POST', path: '/object/run', body: {
      id: 's1', task_id: 't1', member: 'lasse', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running', started_at: '2026-11-24T09:00:00.000Z',
    } }])

    // nothing changed: no write — there is no heartbeat
    await records.sync()
    await records.sync()
    expect(brain.writes).toHaveLength(1)

    turns.set('s1', 'done')
    results.set('s1', 'Draft ready for review.')
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'idle', result: 'Draft ready for review.' } })

    turns.set('s1', 'waiting')
    await records.sync()
    expect(brain.writes).toHaveLength(2)

    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes.at(-1)!.body).toEqual({ state: 'running' })
  })

  it('ends a run put_away when its session is put away, finished when it leaves the ledger, and resumes the same run when it runs again', async () => {
    const brain = brainOf(['t1', 't2'])
    const sessions = [session('s1', 't1'), session('s2', 't2')]
    const { records, turns, processes } = setup(brain, sessions)
    processes.add('s1')
    processes.add('s2')
    await records.sync()
    expect(brain.runs.get('s1')).toMatchObject({ state: 'idle', origin: 'user', driver: 'human' })

    sessions[0].archived = true
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'ended', end_reason: 'put_away' } })

    sessions[0].archived = false
    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'running' } })

    sessions.splice(1, 1)
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s2', body: { state: 'ended', end_reason: 'finished' } })
  })

  it('a session a delegation continued gets a new run from then: the earlier one ends, and the new run closes the request', async () => {
    const brain = brainOf()
    const sessions = [session('s1', 't1')]
    const { records, turns, processes } = setup(brain, sessions)
    processes.add('s1')
    await records.sync()
    const requested = '2026-11-24T11:00:00.000Z'
    const task = { status: 'active', properties: { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: requested } } }
    const latest = () => lastStartsOf([...brain.runs.values()].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))))
    expect(requestOpen(task, latest().get('t1') ?? null)).toBe(true)

    sessions[0].runStartedAt = '2026-11-24T11:00:05.000Z'
    turns.set('s1', 'working')
    await records.sync()
    const runId = `s1_${Date.parse('2026-11-24T11:00:05.000Z')}`
    expect(brain.writes.slice(-2)).toEqual([
      { method: 'PUT', path: '/object/run/s1', body: { state: 'ended', end_reason: 'finished' } },
      { method: 'POST', path: '/object/run', body: {
        id: runId, task_id: 't1', member: 'lasse', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running', started_at: '2026-11-24T11:00:05.000Z',
      } },
    ])
    expect(requestOpen(task, latest().get('t1') ?? null)).toBe(false)

    // its turns now go to the new run
    turns.set('s1', 'done')
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: `/object/run/${runId}`, body: { state: 'idle' } })
  })

  it('after a restart, carries on with the later run of a continued session instead of crashing or recreating it', async () => {
    const runId = `s1_${Date.parse('2026-11-24T11:00:05.000Z')}`
    const brain = brainOf(['t1'], [
      { id: 's1', task_id: 't1', member: 'lasse', state: 'ended' },
      { id: runId, task_id: 't1', member: 'lasse', state: 'idle' },
    ])
    const { records, processes, turns } = setup(brain, [session('s1', 't1', { runStartedAt: '2026-11-24T11:00:05.000Z' })])
    processes.add('s1')
    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes).toEqual([{ method: 'PUT', path: `/object/run/${runId}`, body: { state: 'running' } }])
  })

  it('a process gone mid-turn leaves the run idle until it runs again', async () => {
    const brain = brainOf()
    const { records, turns, processes } = setup(brain, [session('s1', 't1')])
    processes.add('s1')
    turns.set('s1', 'working')
    await records.sync()
    processes.delete('s1')
    turns.delete('s1')
    await records.sync()
    expect(brain.writes.at(-1)!.body).toEqual({ state: 'idle' })
    await records.sync()
    expect(brain.writes).toHaveLength(2)
  })

  it('at the first sync after a start, ends this member\'s open runs without a live session as crashed; another member\'s it leaves alone', async () => {
    const brain = brainOf(['t1'], [
      { id: 'gone', task_id: 't1', member: 'lasse', state: 'running' },
      { id: 'back', task_id: 't1', member: 'lasse', state: 'idle' },
      { id: 'theirs', task_id: 't1', member: 'dominik', state: 'running' },
    ])
    const { records, processes } = setup(brain, [session('back', 't1')])
    processes.add('back')
    await records.sync()
    expect(brain.writes).toEqual([{ method: 'PUT', path: '/object/run/gone', body: { state: 'ended', end_reason: 'crashed' } }])
    expect(brain.runs.get('theirs')!.state).toBe('running')
  })

  it('carries on with a run that ended before the host started; a refused or moved session stays with the ledger', async () => {
    const brain = brainOf(['t1', 't2'], [{ id: 's1', task_id: 't1', member: 'lasse', state: 'ended' }])
    const sessions = [session('s1', 't1'), session('s9', 'elsewhere')]
    const { records, processes, turns, logs } = setup(brain, sessions)
    processes.add('s1')
    processes.add('s9')
    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes.map((w) => `${w.method} ${w.path} ${JSON.stringify(w.body.state)}`)).toEqual([
      // s1's run is found by its id and resumed, never created twice; s9's task is not in the brain
      'PUT /object/run/s1 "running"', 'POST /object/run "idle"',
    ])
    expect(logs).toEqual([expect.stringContaining('no run for session s9')])

    sessions[0].taskId = 't2'
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'ended', end_reason: 'finished' } })
    await records.sync()
    expect(brain.writes.filter((w) => w.method === 'POST')).toHaveLength(1)
  })

  it('looks a session\'s run up before creating it: another member\'s run with that id is refused, not overwritten', async () => {
    const brain = brainOf(['t1'], [{ id: 's1', task_id: 't1', member: 'dominik', state: 'ended' }])
    const { records, processes, logs } = setup(brain, [session('s1', 't1')])
    processes.add('s1')
    await records.sync()
    expect(brain.writes).toEqual([])
    expect(logs).toEqual([expect.stringContaining('belongs to dominik')])
  })

  it('a brain without runs (before schema 23) gets no writes', async () => {
    const brain = brainOf()
    brain.get = async () => { throw new Error('Unknown object run') }
    const { records, processes, logs } = setup(brain, [session('s1', 't1')])
    processes.add('s1')
    await records.sync()
    await records.sync()
    expect(brain.writes).toEqual([])
    expect(logs).toEqual([expect.stringContaining('runs not readable')])
  })
})
