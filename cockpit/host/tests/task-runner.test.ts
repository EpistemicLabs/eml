import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-runner-'))
process.env.EML_COCKPIT_HOME = home

type Mod = typeof import('../src/application/task-runner.js')

type T = { id: string; status: string; goal?: string; author?: string; title?: string; scope?: string; checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; delegation?: Record<string, unknown>; schedule?: Record<string, unknown>; waiting_on?: Record<string, string>; parent?: string }
const DAILY = { crons: ['0 9 * * *'], time_zone: 'UTC' }
/** The task's delegation: as given, else requested when planned with a delegate and a checkpoint; its schedule is a field of its own beside it. */
const delegationOf = (t: T): { delegation?: Record<string, unknown>; schedule?: Record<string, unknown> } => {
  const base = t.delegation ?? (t.status === 'planned' && t.delegate && t.checkpoint ? { agent: t.delegate, checkpoint: t.checkpoint, requested_at: '2026-01-01T00:00:00.000Z' } : null)
  return { ...(base ? { delegation: base } : {}), ...(t.schedule ? { schedule: t.schedule } : {}) }
}

/** A brain with tasks and their part_of relations, as GET /engram?with_relations and /list give them. */
function brainOf(list: T[], runs: Array<Record<string, unknown>> = []) {
  const byId = new Map(list.map((t) => [t.id, t]))
  const view = (t: T) => ({
    id: t.id, title: t.title ?? t.id, content: `do ${t.id}`, status: t.status, scope: t.scope ?? 'project.eml', parent_id: t.parent ?? null, ingested_by: t.author ?? null,
    properties: { ...(t.goal ? { goal: t.goal } : {}), ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}), ...(t.depends_on ? { depends_on: t.depends_on } : {}), ...(t.assignee_ids ? { assignee_ids: t.assignee_ids } : {}), ...(t.delegate ? { delegate: t.delegate } : {}), ...delegationOf(t), ...(t.waiting_on ? { waiting_on: t.waiting_on } : {}) },
    relations: list.filter((o) => o.parent === t.id || t.parent === o.id).map((o) => (o.parent === t.id
      ? { source_id: o.id, target_id: t.id, relation: 'part_of' }
      : { source_id: t.id, target_id: o.id, relation: 'part_of' })),
  })
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    posts,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') return { engrams: list.filter((t) => t.status === query?.status).map(view) }
      if (path === '/object/run') return { objects: query?.latest ? runs : runs.filter((r) => r.state !== 'ended') }
      const t = byId.get(path.slice('/engram/'.length))
      if (!t) throw new Error('not found')
      return view(t)
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      const t = byId.get(/^\/task\/([^/]+)\/track$/.exec(path)![1])!
      if (typeof body.status === 'string') t.status = body.status
      return view(t)
    },
  }
}

describe('task runner', () => {
  let mod: Mod
  beforeAll(async () => { mod = await import('../src/application/task-runner.js') })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const run = async (list: T[], space: { shared: boolean | null; name: string } = { shared: false, name: 'Main' }, start: (step: { id: string }) => string | null = () => null, busy: (id: string) => boolean = () => false, more: { held?: (id: string, requestedAt?: string) => boolean; working?: (id: string) => boolean; ownSession?: (id: string) => string | null; question?: (id: string) => string | undefined; continuedFor?: (id: string, requestedAt: string) => boolean; resume?: (sessionId: string, step: { id: string }) => Promise<{ kind: 'continued' } | { kind: 'retry' | 'fallback'; why: string }> } = {}, runs: Array<Record<string, unknown>> = []) => {
    const brain = brainOf(list, runs)
    const started: Array<{ id: string; projectId: string; checkpoint: string }> = []
    const logs: string[] = []
    const runner = mod.createTaskRunner({
      spaces: { list: () => [space as never] }, brain: () => brain, me: 'lasse', log: (l) => logs.push(l), busy, ...more,
      start: (_space, step) => { const problem = start(step); if (!problem) started.push(step); return problem },
    })
    await runner.tick()
    return { started, brain, logs, runner }
  }

  it('continues the task\'s own session with the start prompt instead of starting a new one, once per request', async () => {
    const list: T[] = [{ id: 'solo', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T10:00:00.000Z' } }]
    const resumed: Array<{ sessionId: string; id: string; question?: string }> = []
    const { started, brain, runner } = await run(list, undefined, undefined, undefined, {
      ownSession: (id) => (id === 'solo' ? 'desk-1' : null),
      question: () => 'Count it?',
      resume: async (sessionId, step) => { resumed.push({ sessionId, id: step.id, question: (step as { question?: string }).question }); return { kind: 'continued' } },
    })
    expect(resumed).toEqual([{ sessionId: 'desk-1', id: 'solo', question: 'Count it?' }])
    expect(started).toEqual([])
    expect(brain.posts.map((p) => p.body.text)).toEqual(['Continued in its own session by the task runner.'])
    // its run is not in the brain yet: the request counts as started here, so the prompt is not sent again
    await runner.tick()
    expect(resumed).toHaveLength(1)
  })

  it('starts nothing beside an own session that is busy, and tries it again next tick; a delivery that throws stalls no other task', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T10:00:00.000Z' }
    const list: T[] = [
      { id: 'busy', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation },
      { id: 'throws', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation },
      { id: 'plain', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation },
    ]
    const tries: string[] = []
    const { started, brain, runner } = await run(list, undefined, undefined, undefined, {
      ownSession: (id) => (id === 'plain' ? null : `own-${id}`),
      resume: async (sessionId) => {
        tries.push(sessionId)
        if (sessionId === 'own-throws') throw new Error('socket closed')
        return { kind: 'retry', why: 'the session is busy (busy)' }
      },
    })
    expect(started.map((s) => s.id)).toEqual(['plain'])
    expect(brain.posts.map((p) => p.path)).toEqual(['/task/plain/track'])
    await runner.tick()
    expect(tries.filter((t) => t === 'own-busy')).toHaveLength(2)
    expect(started.map((s) => s.id)).toEqual(['plain'])
  })

  it('after a restart, sends no second start prompt to a session the ledger says was continued for this request', async () => {
    const list: T[] = [{ id: 'solo', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T10:00:00.000Z' } }]
    const resumed: string[] = []
    // a fresh runner (nothing in memory) and no run in the brain: only the ledger's runStartedAt says it was continued
    const { started } = await run(list, undefined, undefined, undefined, {
      ownSession: () => 'desk-1',
      continuedFor: (id, requestedAt) => id === 'solo' && requestedAt === '2026-11-25T10:00:00.000Z',
      resume: async (sessionId) => { resumed.push(sessionId); return { kind: 'continued' } },
    })
    expect(resumed).toEqual([])
    expect(started).toEqual([])
  })

  it('continues nothing while the hand-over can still be undone', async () => {
    const list: T[] = [{ id: 'solo', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T10:00:00.000Z' } }]
    const resumed: string[] = []
    const { started, brain } = await run(list, undefined, undefined, undefined, {
      held: () => true, ownSession: () => 'desk-1', resume: async (sessionId) => { resumed.push(sessionId); return { kind: 'continued' } },
    })
    expect(resumed).toEqual([])
    expect(started).toEqual([])
    expect(brain.posts).toEqual([])
  })

  it('starts a new session when the own session does not take the prompt, or when there is none to continue', async () => {
    const delegation = { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-25T10:00:00.000Z' }
    const list: T[] = [
      { id: 'refused', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation },
      { id: 'fresh', status: 'active', checkpoint: 'after', delegate: 'atlas', delegation },
    ]
    const { started, logs, brain } = await run(list, undefined, undefined, undefined, {
      ownSession: (id) => (id === 'refused' ? 'desk-1' : null),
      resume: async () => ({ kind: 'fallback', why: 'the session cannot be reached (refused)' }),
    })
    expect(started.map((s) => s.id).sort()).toEqual(['fresh', 'refused'])
    expect(brain.posts.map((p) => p.body.text)).toEqual(['Started by the task runner.', 'Started by the task runner.'])
    expect(logs.some((l) => l.includes('not continued in session desk-1'))).toBe(true)
  })

  it('tells a continued session to carry on alone; a new one that the runner started it', () => {
    const step = { id: 't1', title: 'Fix it', content: 'do it' }
    expect(mod.stepPrompt({ ...step, continued: true }, 'after').split('\n')[0]).toBe('The owner delegated "Fix it" (task t1) to you: carry on with it on your own from where this conversation stands.')
    expect(mod.stepPrompt(step, 'after').split('\n')[0]).toBe('The task runner started you for "Fix it" (task t1).')
  })

  it('starts the ready steps of an active task, and marks them active so they start once', async () => {
    const list: T[] = [
      { id: 'plan', status: 'active' },
      { id: 'proof', status: 'resolved', parent: 'plan', checkpoint: 'none' },
      { id: 'deploy', status: 'planned', parent: 'plan', checkpoint: 'before', depends_on: ['proof'], delegate: 'atlas' },
      { id: 'copy', status: 'planned', parent: 'plan', checkpoint: 'after', delegate: 'atlas' },
    ]
    const { started, brain, runner } = await run(list)
    expect(started.map((s) => s.id).sort()).toEqual(['copy', 'deploy'])
    expect(started.find((s) => s.id === 'deploy')).toMatchObject({ projectId: 'bp-eml', checkpoint: 'before' })
    expect(brain.posts.map((p) => p.body.status)).toEqual(['active', 'active'])
    await runner.tick()
    expect(started).toHaveLength(2)
  })

  it('leaves steps that wait for a dependency, have no delegate or no checkpoint, or whose task is not active', async () => {
    const { started } = await run([
      { id: 'plan', status: 'active' },
      { id: 'parked', status: 'planned' },
      { id: 'a', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'waits', status: 'planned', parent: 'plan', checkpoint: 'none', depends_on: ['a'], delegate: 'atlas' },
      { id: 'mine', status: 'planned', parent: 'plan', checkpoint: 'none', assignee_ids: ['lasse'] },
      { id: 'plain', status: 'planned', parent: 'plan', delegate: 'atlas' },
      { id: 'idle', status: 'planned', parent: 'parked', checkpoint: 'none', delegate: 'atlas' },
    ])
    expect(started).toEqual([])
  })

  it('starts a delegated task whose owner is a person, but not while someone is waited on, its hand-over can be undone, or its schedule will start it', async () => {
    const { started } = await run([
      { id: 'owned', status: 'planned', checkpoint: 'after', assignee_ids: ['lasse'], delegate: 'atlas' },
      { id: 'asked', status: 'planned', checkpoint: 'after', delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'question' } },
      { id: 'held', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'at-nine', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: DAILY },
      { id: 'paused', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: { ...DAILY, paused: true } },
    ], undefined, () => null, () => false, { held: (id) => id === 'held' })
    // a paused schedule has no run coming up: the request starts it
    expect(started.map((s) => s.id)).toEqual(['owned', 'paused'])
  })

  it('is held off a task whose schedule starts it now: a wake-up that is due and not fired yet, a run that waits to start', async () => {
    const now = Date.now()
    const passed = { at: new Date(now - 60_000).toISOString() }
    const facts: Record<string, { cursor?: string | null; firedWake?: string | null; waitingRunDueAt?: string | null }> = {
      // this cockpit fired that wake-up already: clearing it on the task has not arrived, nothing is coming
      'fired-wake': { firedWake: passed.at },
      'waiting-run': { waitingRunDueAt: new Date(now - 120_000).toISOString() },
    }
    const { started } = await run([
      { id: 'due-wake', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: passed },
      { id: 'fired-wake', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: passed },
      { id: 'waiting-run', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'paused-wake', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: { ...passed, paused: true } },
    ], undefined, () => null, () => false, { scheduleFacts: (id: string) => facts[id] ?? {} } as never)
    expect(started.map((s) => s.id)).toEqual(['fired-wake', 'paused-wake'])
  })

  it('is not held off a task by a repeating time its record holds for the user\'s OK; a wake-up ahead still holds it off', async () => {
    const now = Date.now()
    const hourly = { crons: ['0 * * * *'], time_zone: 'UTC' }
    const facts: Record<string, { cursor?: string | null; needsOk?: boolean }> = {
      held: { cursor: new Date(now).toISOString(), needsOk: true },
      'held-wake': { cursor: new Date(now).toISOString(), needsOk: true },
    }
    const { started } = await run([
      { id: 'held', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: hourly },
      { id: 'held-wake', status: 'planned', checkpoint: 'after', delegate: 'atlas', schedule: { ...hourly, at: new Date(now + 3_600_000).toISOString() } },
    ], undefined, () => null, () => false, { scheduleFacts: (id: string) => facts[id] ?? {} } as never)
    expect(started.map((s) => s.id)).toEqual(['held'])
  })

  it('starts a standalone task with a checkpoint, at most five at a time, and none a session already works on', async () => {
    const { started } = await run([
      { id: 'running-1', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'running-2', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'running-3', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'running-4', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'mine', status: 'planned', checkpoint: 'after', assignee_ids: ['lasse'] },
      { id: 'plain', status: 'planned', delegate: 'atlas' },
      { id: 'taken', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'free-1', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'free-2', status: 'planned', checkpoint: 'none', delegate: 'atlas' },
    ], undefined, () => null, (id) => id === 'taken', { working: (id) => id.startsWith('running-') })
    expect(started.map((s) => s.id)).toEqual(['free-1'])
  })

  it('does not count an active task that only waits on its scheduled job towards the cap', async () => {
    const { started } = await run([
      { id: 'job-1', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'job-2', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'job-3', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'job-4', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'job-5', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'free', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'plan', status: 'active' },
      { id: 'step-job-1', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'step-job-2', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'step-job-3', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'step-job-4', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'step-job-5', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'step-free', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
    ].map((t) => (t.id.includes('job-') ? { ...t, schedule: DAILY } : t)))
    expect(started.map((s) => s.id).sort()).toEqual(['free', 'step-free'])
  })

  it('runs at most five steps of one task at a time', async () => {
    const { started } = await run([
      { id: 'plan', status: 'active' },
      { id: 'r1', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'r2', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'r3', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'r4', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 's1', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 's2', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
    ], undefined, () => null, () => false, { working: (id) => id.startsWith('r') })
    expect(started).toHaveLength(1)
  })

  describe('slots: only a task this cockpit runs with a session working on it holds one', () => {
    const active = (id: string, extra: Partial<T> = {}): T => ({ id, status: 'active', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'], ...extra })

    it('frees the slot of an own task that waits on its owner\'s answer or review', async () => {
      const { started } = await run([
        active('asked', { waiting_on: { who: 'lasse', kind: 'question' } }),
        active('review', { waiting_on: { who: 'lasse', kind: 'review' } }),
        active('w-1'), active('w-2'), active('w-3'),
        { id: 'free', status: 'planned', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'] },
      ], undefined, () => null, () => false, { working: (id) => id.startsWith('w-') })
      expect(started.map((s) => s.id)).toEqual(['free'])
    })

    it('gives another member\'s tasks in a shared space no slot, even while their run works on the other cockpit', async () => {
      const theirs = (id: string): T => ({ id, status: 'active', checkpoint: 'after', delegate: 'motti', assignee_ids: ['dominik'] })
      const now = new Date().toISOString()
      const { started } = await run([
        active('now-plan', { waiting_on: { who: 'lasse', kind: 'question' } }),
        theirs('grok'), theirs('audit'), theirs('t1'), theirs('dupes'),
        { id: 'follow-up', status: 'planned', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'] },
      ], { shared: true, name: 'EML' }, () => null, () => false, { working: (id) => id === 'grok' },
      [{ id: 'run-grok', task_id: 'grok', member: 'dominik', state: 'running', started_at: '2026-01-01T00:00:00.000Z', last_activity_at: now }])
      expect(started.map((s) => s.id)).toEqual(['follow-up'])
    })

    it('counts own tasks with a working session, and lets "Run now" on an active task start below the cap', async () => {
      const working = ['w-1', 'w-2', 'w-3', 'w-4', 'w-5'].map((id) => active(id))
      const queued: T = { id: 'queued', status: 'planned', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'] }
      expect((await run([...working, queued], undefined, () => null, () => false, { working: (id) => id.startsWith('w-') })).started).toEqual([])
      // Run Atlas now on an active task: a new request; four working tasks leave a slot.
      const rerun = active('rerun', { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-06-01T00:00:00.000Z' } })
      const { started } = await run([...working.slice(0, 4), active('idle-1'), rerun], undefined, () => null, () => false, { working: (id) => id.startsWith('w-') })
      expect(started.map((s) => s.id)).toEqual(['rerun'])
    })

    it('keeps the slot of a task it just started until its session works or START_GRACE_MS passed', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-11-24T12:00:00.000Z') })
      try {
        const list: T[] = [
          active('w-1'), active('w-2'), active('w-3'), active('w-4'),
          { id: 'first', status: 'planned', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'] },
          { id: 'second', status: 'planned', checkpoint: 'after', delegate: 'atlas', assignee_ids: ['lasse'] },
        ]
        const brain = brainOf(list)
        const started: string[] = []
        const runner = mod.createTaskRunner({
          spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse', log: () => {},
          working: (id) => id.startsWith('w-'),
          start: (_space, step) => { started.push(step.id); return null },
        })
        await runner.tick()
        expect(started).toEqual(['first'])
        expect(runner.startedAt('first')).toBe(Date.now())
        await runner.tick()
        expect(started).toEqual(['first'])
        vi.advanceTimersByTime(61_000)
        await runner.tick()
        expect(started).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('in a shared or unconfirmed space starts only the steps this member owns: first assignee, else author', async () => {
    const list = (): T[] => [
      { id: 'plan', status: 'active', author: 'dominik' },
      { id: 'assigned', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas', assignee_ids: ['lasse'], author: 'dominik' },
      { id: 'authored', status: 'planned', checkpoint: 'after', delegate: 'atlas', author: 'lasse' },
      { id: 'theirs', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas', assignee_ids: ['dominik'], author: 'lasse' },
      { id: 'their-own', status: 'planned', checkpoint: 'after', delegate: 'atlas', author: 'dominik' },
    ]
    for (const shared of [true, null]) {
      const { started, brain } = await run(list(), { shared, name: 'Team' })
      expect(started.map((s) => s.id).sort()).toEqual(['assigned', 'authored'])
      expect(brain.posts.map((p) => p.path).sort()).toEqual(['/task/assigned/track', '/task/authored/track'])
    }
    expect((await run(list(), { shared: false, name: 'Main' })).started.map((s) => s.id).sort()).toEqual(['assigned', 'authored', 'their-own', 'theirs'])
  })

  it('keeps a step planned when it cannot start', async () => {
    const steps: T[] = [{ id: 'plan', status: 'active' }, { id: 's', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' }]
    const refused = await run(steps, undefined, () => 'project bp-eml is not in space Main')
    expect(refused.brain.posts).toEqual([])
    expect(refused.logs.at(-1)).toContain('not started')
  })

  it('tells the step\'s session how far to go for each checkpoint', () => {
    const step = { id: 't', title: 'Deploy', content: 'Deploy the page.' }
    expect(mod.stepPrompt(step, 'before')).toContain('do not act yet')
    expect(mod.stepPrompt(step, 'after')).toContain('for review')
    expect(mod.stepPrompt(step, 'after')).toContain('Never close the task yourself')
    expect(mod.stepPrompt(step, 'before')).toContain('hand the result over for review')
    expect(mod.stepPrompt(step, 'before')).not.toContain('close the task.')
    for (const c of ['before', 'after']) expect(mod.stepPrompt(step, c)).toContain('runs in the user\'s cockpit')
    expect(mod.stepPrompt(step, 'none')).not.toContain('Never close the task yourself')
    expect(mod.stepPrompt(step, 'none')).toContain('close it')
    expect(mod.stepPrompt(step, 'none')).toContain('to the end on your own')
    // How a turn ends is in the session's start context: the prompt names no tool and no block.
    expect(mod.stepPrompt(step, 'before')).toContain('Ask the user for the go and stop.')
    expect(mod.stepPrompt(step, 'after')).toContain('Checkpoint after: do the step, then hand the result over for review (an ask for the owner, kind review).')
    for (const c of ['before', 'after', 'none']) expect(mod.stepPrompt(step, c)).not.toMatch(/handoff|session_status|\[lasse\]|schedule tool/i)
    // A job's run never closes its task: the job's prompt does not ask for it.
    expect(mod.stepPrompt({ ...step, ofJob: true }, 'none')).toContain('to the end on your own')
    expect(mod.stepPrompt({ ...step, ofJob: true }, 'none')).not.toMatch(/close it|Closing means/)
  })
})

describe('the newest start per task', () => {
  it('keeps the newest run of each task when several come newest first', async () => {
    const { lastStartsOf } = await import('../src/domain/delegation.js')
    const starts = lastStartsOf([
      { task_id: 't', started_at: '2026-11-24T10:00:00.000Z' }, { task_id: 't', started_at: '2026-11-23T10:00:00.000Z' },
      { task_id: 'u', started_at: '2026-11-20T10:00:00.000Z' },
    ])
    expect([...starts]).toEqual([['t', '2026-11-24T10:00:00.000Z'], ['u', '2026-11-20T10:00:00.000Z']])
  })
})

describe('the delegation request (v0.23)', () => {
  let mod: Mod
  beforeAll(async () => { mod = await import('../src/application/task-runner.js') })
  const REQUESTED = '2026-11-24T10:00:00.000Z'
  const runnerOf = (brain: ReturnType<typeof brainOf>, started: string[]) => mod.createTaskRunner({
    spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse', log: () => {},
    start: (_space, step) => { started.push(step.id); return null },
  })

  it('starts an active task with an open request once, without setting its status back or forward', async () => {
    const list: T[] = [{ id: 'a', status: 'active', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: REQUESTED } }]
    const brain = brainOf(list)
    const started: string[] = []
    const runner = runnerOf(brain, started)
    await runner.tick()
    await runner.tick()
    expect(started).toEqual(['a'])
    expect(brain.posts).toEqual([{ path: '/task/a/track', body: { text: 'Started by the task runner.' } }])
  })

  it('a run that started after the request has handled it; one from before has not', async () => {
    const task = (id: string): T => ({ id, status: 'active', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: REQUESTED } })
    const brain = brainOf([task('handled'), task('open')], [
      { id: 'r1', task_id: 'handled', member: 'lasse', state: 'ended', started_at: '2026-11-24T10:00:05.000Z' },
      { id: 'r2', task_id: 'open', member: 'lasse', state: 'ended', started_at: '2026-11-24T09:59:00.000Z' },
    ])
    const started: string[] = []
    await runnerOf(brain, started).tick()
    expect(started).toEqual(['open'])
  })

  it('starts nothing without a request: not the old signal (planned, delegate and checkpoint), a delegation without a checkpoint, or a scheduled one', async () => {
    const brain = brainOf([
      { id: 'old-signal', status: 'planned', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' } },
      { id: 'no-checkpoint', status: 'planned', delegate: 'atlas', delegation: { agent: 'atlas', requested_at: REQUESTED } },
      { id: 'scheduled', status: 'planned', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' }, schedule: { crons: ['0 8 * * *'] } },
      { id: 'planned-request', status: 'planned', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: REQUESTED } },
    ])
    const started: string[] = []
    await runnerOf(brain, started).tick()
    expect(started).toEqual(['planned-request'])
    expect(brain.posts[0].body).toEqual({ status: 'active', text: 'Started by the task runner.' })
  })
})

describe('the owner\'s own session and Delegate now (B3)', () => {
  type Busy = typeof import('../src/domain/runner-busy.js')
  let busy: Busy
  beforeAll(async () => { busy = await import('../src/domain/runner-busy.js') })

  const at = (iso: string, more: Partial<{ archived: boolean; working: boolean }> = {}) => ({ createdAt: iso, archived: false, working: false, ...more })

  it('an idle session from before Delegate now does not block; a later, a working or an un-delegated one does', () => {
    const delegated = '2026-11-23T10:00:00.000Z'
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z')], delegated, false)).toBe(false)
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z', { working: true })], delegated, false)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T10:05:00.000Z')], delegated, false)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z')], null, false)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T10:05:00.000Z', { archived: true })], null, false)).toBe(false)
  })

  it('a request still queued for the task blocks it, with no session on it yet', () => {
    expect(busy.sessionsBlockRunner([], null, true)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z')], '2026-11-23T10:00:00.000Z', true)).toBe(true)
    expect(busy.sessionsBlockRunner([], null, false)).toBe(false)
  })

  it('reproduced: Delegate now on an active task while the owner\'s idle session on it is open starts the delegate', async () => {
    const { createTaskCommands, TaskCommandStore, UNDO_WINDOW_MS } = await import('../src/application/task-commands.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const list: T[] = [{ id: 'own-task', status: 'active', assignee_ids: ['lasse'], goal: 'Done' }]
    const brain = brainOf(list)
    // The owner's own session on the task, open and idle, from before the hand-over.
    const ledger = new SessionLedger()
    ledger.recordSpawn('own', null, 'bp-eml', 'claude', false, 'own-task')
    let now = Date.now() + 60_000
    const commands = createTaskCommands({
      store: new TaskCommandStore(join(home, 'b3-commands.json')), space: () => ({ id: 'main', name: 'Main', shared: false }) as never,
      brain: () => ({ get: brain.get, post: async (path: string, body: Record<string, unknown>) => {
        // As core mirrors it: the delegation sets the flat fields too.
        const t = list[0]; const d = body.delegation as { agent: string; checkpoint?: string } | undefined
        if (d) { t.delegation = d; t.delegate = d.agent; t.checkpoint = d.checkpoint }
        return brain.post(path, body)
      } }),
      agentsOf: async () => ['atlas'], changed: () => {}, now: () => now, log: () => {},
    })
    await commands.submit({ opId: 'op-b3', kind: 'hand_over', spaceId: 'main', taskId: 'own-task', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    now += UNDO_WINDOW_MS + 1
    await commands.tick()
    // the status stays active (it moves forward only); the request starts it
    expect(list[0]).toMatchObject({ status: 'active', delegate: 'atlas', checkpoint: 'after', delegation: { requested_at: expect.any(String) } })

    const started: string[] = []
    const { createTaskRunner } = await import('../src/application/task-runner.js')
    const runner = createTaskRunner({
      spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse', log: () => {},
      // As index.ts wires it.
      busy: (id) => busy.sessionsBlockRunner(ledger.list().filter((e) => e.taskId === id).map((e) => ({ createdAt: e.createdAt, archived: Boolean(e.archivedAt), working: false })), commands.delegatedAt(id), false),
      held: (id) => commands.held(id) || commands.together(id),
      start: (_space, step) => { started.push(step.id); return null },
    })
    await runner.tick()
    expect(started).toEqual(['own-task'])
  })
})
