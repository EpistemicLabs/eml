import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RUN_LEASE_MS, RUN_RENEW_MS, isLive, liveFactsOf, runOriginOf, runStateOf, runsBlockRunner, delegatedNextRun,
} from '../src/domain/run-liveness.js'
import { createRunRecords, type RunJob, type RunSession } from '../src/application/run-records.js'
import type { TurnState } from '../src/domain/agent-provider.js'

// paths.ts reads the home at import time — set it before loading the runner.
const home = mkdtempSync(join(tmpdir(), 'cockpit-run-records-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const T0 = Date.parse('2026-11-23T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('run liveness', () => {
  it('counts a run while it is not ended and its lease reaches past now', () => {
    const run = (state: string, lease_until: string | null) => ({ id: 'r', task_id: 't', member: 'ada', state, lease_until })
    expect(isLive(run('running', iso(T0 + 1)), T0)).toBe(true)
    expect(isLive(run('idle', iso(T0 + 1)), T0)).toBe(true)
    expect(isLive(run('running', iso(T0)), T0)).toBe(false)
    expect(isLive(run('ended', iso(T0 + 1)), T0)).toBe(false)
    expect(isLive(run('running', null), T0)).toBe(false)
  })

  it('joins this host\'s sessions with the runs of sessions it does not have', () => {
    const runs = [
      { id: 'mine', task_id: 't', member: 'lasse', state: 'idle' },
      { id: 'theirs', task_id: 't', member: 'ada', state: 'running' },
    ]
    expect(liveFactsOf([{ sessionId: 'mine', working: false }], runs, null)).toEqual({ working: true, sessions: 2, nextRunAt: null })
    expect(liveFactsOf([{ sessionId: 'mine', working: false }], runs.slice(0, 1), 'x')).toEqual({ working: false, sessions: 1, nextRunAt: 'x' })
    expect(runsBlockRunner(runs, new Set(['mine']))).toBe(true)
    expect(runsBlockRunner(runs.slice(0, 1), new Set(['mine']))).toBe(false)
  })

  it('maps turns, origins and a mirrored next run', () => {
    expect(['working', 'waiting', 'done', 'idle', undefined].map((t) => runStateOf(t as TurnState | undefined))).toEqual(['running', 'awaiting_input', 'idle', 'idle', 'idle'])
    expect(runOriginOf({ jobId: 'j', worker: true, parentSessionId: null })).toEqual({ origin: 'job', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: true, parentSessionId: null })).toEqual({ origin: 'runner', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: true, parentSessionId: 'p' })).toEqual({ origin: 'user', driver: 'agent' })
    expect(runOriginOf({ jobId: null, worker: false, parentSessionId: null })).toEqual({ origin: 'user', driver: 'human' })
    expect(delegatedNextRun({ next_run_at: iso(T0 + 1) }, T0)).toBe(iso(T0 + 1))
    expect(delegatedNextRun({ next_run_at: iso(T0 - 1) }, T0)).toBeNull()
    expect(delegatedNextRun(undefined, T0)).toBeNull()
  })
})

/** A brain that keeps runs and tasks the way the server's object and track routes answer. */
function brainOf(tasks: Record<string, { status: string; delegation?: Record<string, string> }> = {}, runs: Array<Record<string, unknown>> = []) {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const byId = new Map(runs.map((r) => [r.id as string, r]))
  return {
    writes,
    runs: byId,
    tasks,
    async get(path: string) {
      if (path === '/object/run') return { objects: [...byId.values()].filter((r) => r.state !== 'ended') }
      const run = /^\/object\/run\/(.+)$/.exec(path)
      if (run) return { object: byId.get(decodeURIComponent(run[1])) }
      const task = /^\/engram\/(.+)$/.exec(path)
      if (task && tasks[task[1]]) return { id: task[1], status: tasks[task[1]].status, properties: tasks[task[1]].delegation ? { delegation: tasks[task[1]].delegation } : {} }
      throw new Error(`not found: ${path}`)
    },
    async post(path: string, body: Record<string, unknown>) {
      writes.push({ method: 'POST', path, body })
      if (path === '/object/run') {
        if (!tasks[body.task_id as string]) throw new Error(`Invalid object: task_id ${String(body.task_id)} is not a task of this brain.`)
        if (byId.has(body.id as string)) throw new Error(`Invalid object: run "${String(body.id)}" already exists.`)
        byId.set(body.id as string, { ...body })
        return { object: body }
      }
      const track = /^\/task\/(.+)\/track$/.exec(path)
      if (track) { tasks[track[1]].delegation = body.delegation as Record<string, string>; return {} }
      throw new Error(`unexpected ${path}`)
    },
    async put(path: string, body: Record<string, unknown>) {
      writes.push({ method: 'PUT', path, body })
      const id = decodeURIComponent(path.slice('/object/run/'.length))
      byId.set(id, { ...byId.get(id), ...body })
      return {}
    },
  }
}

function setup(opts: { brain: ReturnType<typeof brainOf>; sessions: RunSession[]; jobs?: RunJob[] }) {
  const clock = { now: T0 }
  const turns = new Map<string, TurnState>()
  const processes = new Set<string>()
  const logs: string[] = []
  const records = createRunRecords({
    spaces: () => [{ id: 'main', name: 'Main' } as never],
    brain: () => opts.brain,
    me: 'lasse',
    sessions: () => opts.sessions,
    turnOf: (id) => turns.get(id),
    processRuns: (id) => processes.has(id),
    agentOf: () => 'atlas',
    jobs: () => opts.jobs ?? [],
    now: () => clock.now,
    log: (line) => logs.push(line),
  })
  return { records, clock, turns, processes, logs }
}

const session = (sessionId: string, taskId: string | null, more: Partial<RunSession> = {}): RunSession => ({
  sessionId, taskId, spaceId: 'main', createdAt: '2026-11-23T09:00:00.000Z', archived: false, jobId: null, worker: false, parentSessionId: null, ...more,
})

describe('run records', () => {
  it('writes a run when the session\'s process runs, on every state change, renews the lease and ends it when put away', async () => {
    const brain = brainOf({ t1: { status: 'active' } })
    const sessions = [session('s1', 't1', { worker: true })]
    const { records, clock, turns, processes } = setup({ brain, sessions })

    await records.sync()
    expect(brain.writes).toEqual([])

    processes.add('s1')
    turns.set('s1', 'working')
    await records.sync()
    expect(brain.writes).toEqual([{ method: 'POST', path: '/object/run', body: {
      id: 's1', task_id: 't1', member: 'lasse', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running',
      started_at: '2026-11-23T09:00:00.000Z', heartbeat_at: iso(T0), lease_until: iso(T0 + RUN_LEASE_MS),
    } }])

    // nothing changed: no write
    clock.now += 60_000
    await records.sync()
    expect(brain.writes).toHaveLength(1)

    // a state change writes the state with a fresh lease
    turns.set('s1', 'waiting')
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'awaiting_input', heartbeat_at: iso(clock.now), lease_until: iso(clock.now + RUN_LEASE_MS) } })

    // the lease renews every RUN_RENEW_MS while the process runs
    const before = brain.writes.length
    clock.now += RUN_RENEW_MS - 1000
    await records.sync()
    expect(brain.writes).toHaveLength(before)
    clock.now += 1000
    await records.sync()
    expect(brain.writes.at(-1)).toMatchObject({ method: 'PUT', body: { state: 'awaiting_input', lease_until: iso(clock.now + RUN_LEASE_MS) } })

    // the process stops: the state follows, the lease is left to run out
    processes.delete('s1')
    turns.delete('s1')
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'idle' } })
    const quiet = brain.writes.length
    clock.now += 2 * RUN_RENEW_MS
    await records.sync()
    expect(brain.writes).toHaveLength(quiet)

    sessions[0].archived = true
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'PUT', path: '/object/run/s1', body: { state: 'ended', lease_until: null } })
    await records.sync()
    expect(brain.writes).toHaveLength(quiet + 1)
  })

  it('carries on with its member\'s runs after a host start and ends the ones whose session is gone', async () => {
    const brain = brainOf({ t1: { status: 'active' } }, [
      { id: 's1', task_id: 't1', member: 'lasse', state: 'running', lease_until: iso(T0 + 11 * 60_000) },
      { id: 'gone', task_id: 't1', member: 'lasse', state: 'idle', lease_until: iso(T0 + 10 * 60_000) },
      { id: 'theirs', task_id: 't1', member: 'ada', state: 'running', lease_until: iso(T0 + 10 * 60_000) },
    ])
    const { records, processes, turns } = setup({ brain, sessions: [session('s1', 't1')] })
    processes.add('s1')
    turns.set('s1', 'working')
    await records.sync()
    // s1 is known and its lease has 11 minutes left: no write for it; gone ends; theirs is never touched
    expect(brain.writes).toEqual([{ method: 'PUT', path: '/object/run/gone', body: { state: 'ended', lease_until: null } }])
  })

  it('picks up an ended run of a session that is open again, and leaves a refused session to the ledger', async () => {
    const brain = brainOf({ t1: { status: 'active' } }, [{ id: 's1', task_id: 't1', member: 'lasse', state: 'ended', lease_until: null }])
    const { records, processes, turns, logs } = setup({ brain, sessions: [session('s1', 't1'), session('s2', 'other-space-task')] })
    processes.add('s1').add('s2')
    turns.set('s1', 'working')
    await records.sync()
    await records.sync()
    expect(brain.runs.get('s1')).toMatchObject({ state: 'running', lease_until: iso(T0 + RUN_LEASE_MS) })
    expect(brain.runs.has('s2')).toBe(false)
    expect(logs.filter((l) => l.includes('s2'))).toHaveLength(1)
    const writes = brain.writes.length
    await records.sync()
    expect(brain.writes).toHaveLength(writes)
  })

  it('mirrors the earliest next run of a task\'s running jobs into its delegation and clears it when none is left', async () => {
    const brain = brainOf({
      t1: { status: 'active', delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' } },
      plain: { status: 'active' },
    })
    const jobs: RunJob[] = [
      { spaceId: 'main', taskId: 't1', runs: true, nextRunAt: '2026-11-24T09:00:00.000Z' },
      { spaceId: 'main', taskId: 't1', runs: true, nextRunAt: '2026-11-24T08:00:00.000Z' },
      { spaceId: 'main', taskId: 't1', runs: false, nextRunAt: '2026-11-23T11:00:00.000Z' },
      { spaceId: 'main', taskId: 'plain', runs: true, nextRunAt: '2026-11-24T08:00:00.000Z' },
    ]
    const { records } = setup({ brain, sessions: [], jobs })
    await records.sync()
    expect(brain.writes).toEqual([{ method: 'POST', path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone', next_run_at: '2026-11-24T08:00:00.000Z' } } }])
    await records.sync()
    expect(brain.writes).toHaveLength(1)
    jobs[0].runs = false
    jobs[1].runs = false
    await records.sync()
    expect(brain.writes.at(-1)).toEqual({ method: 'POST', path: '/task/t1/track', body: { delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' } } })
  })

  it('writes nothing to a brain without runs and says so once', async () => {
    const brain = brainOf({ t1: { status: 'active' } })
    brain.get = async () => { throw new Error('object must be one of project, entity, tag, subject, user, agent') }
    const { records, processes, logs } = setup({ brain, sessions: [session('s1', 't1')] })
    processes.add('s1')
    await records.sync()
    await records.sync()
    expect(brain.writes).toEqual([])
    expect(logs).toHaveLength(1)
  })
})

describe('the runner reads runs', () => {
  type Mod = typeof import('../src/application/task-runner.js')
  let mod: Mod
  beforeAll(async () => { mod = await import('../src/application/task-runner.js') })

  it('hands the task\'s live runs to busy() and holds a task whose delegation has a next run ahead', async () => {
    const step = (id: string, delegation?: Record<string, string>) => ({
      id, title: id, content: 'do it', status: 'planned', scope: 'project.eml',
      properties: { checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'], ...(delegation ? { delegation } : {}) }, relations: [],
    })
    const tasks = [step('free'), step('elsewhere'), step('their-job', { agent: 'atlas', mode: 'alone', next_run_at: new Date(Date.now() + 3_600_000).toISOString() })]
    const lease = new Date(Date.now() + RUN_LEASE_MS).toISOString()
    const seen: Record<string, string[]> = {}
    const started: string[] = []
    const runner = mod.createTaskRunner({
      spaces: { list: () => [{ shared: true, name: 'Team' } as never] },
      me: 'lasse',
      log: () => {},
      brain: () => ({
        async get(path: string) {
          if (path === '/list') return { engrams: tasks }
          if (path === '/object/run') return { objects: [{ id: 'r1', task_id: 'elsewhere', member: 'ada', state: 'idle', lease_until: lease }] }
          return tasks.find((t) => path === `/engram/${t.id}`)
        },
        async post() { return {} },
      }) as never,
      busy: (taskId, runs) => { seen[taskId] = runs.map((r) => r.id); return runs.length > 0 },
      start: (_space, s) => { started.push(s.id); return null },
    })
    await runner.tick()
    expect(seen).toEqual({ free: [], elsewhere: ['r1'], 'their-job': [] })
    expect(started).toEqual(['free'])
  })
})
