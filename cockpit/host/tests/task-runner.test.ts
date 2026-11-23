import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-runner-'))
process.env.EML_COCKPIT_HOME = home

type Mod = typeof import('../src/application/task-runner.js')

type T = { id: string; status: string; author?: string; title?: string; scope?: string; checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; mode?: 'alone' | 'together'; waiting_on?: Record<string, string>; parent?: string }

/** A brain with tasks and their part_of relations, as GET /engram?with_relations and /list give them. */
function brainOf(list: T[]) {
  const byId = new Map(list.map((t) => [t.id, t]))
  const view = (t: T) => ({
    id: t.id, title: t.title ?? t.id, content: `do ${t.id}`, status: t.status, scope: t.scope ?? 'project.eml', parent_id: t.parent ?? null, ingested_by: t.author ?? null,
    properties: { ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}), ...(t.depends_on ? { depends_on: t.depends_on } : {}), ...(t.assignee_ids ? { assignee_ids: t.assignee_ids } : {}), ...(t.delegate ? { delegate: t.delegate } : {}), ...(t.delegate && t.mode ? { delegation: { agent: t.delegate, ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}), mode: t.mode } } : {}), ...(t.waiting_on ? { waiting_on: t.waiting_on } : {}) },
    relations: list.filter((o) => o.parent === t.id || t.parent === o.id).map((o) => (o.parent === t.id
      ? { source_id: o.id, target_id: t.id, relation: 'part_of' }
      : { source_id: t.id, target_id: o.id, relation: 'part_of' })),
  })
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    posts,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') return { engrams: list.filter((t) => t.status === query?.status).map(view) }
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

  const run = async (list: T[], space: { shared: boolean | null; name: string } = { shared: false, name: 'Main' }, start: (step: { id: string }) => string | null = () => null, busy: (id: string) => boolean = () => false, more: { held?: (id: string) => boolean; scheduled?: (id: string) => boolean } = {}) => {
    const brain = brainOf(list)
    const started: Array<{ id: string; projectId: string; checkpoint: string }> = []
    const logs: string[] = []
    const runner = mod.createTaskRunner({
      spaces: { list: () => [space as never] }, brain: () => brain, me: 'lasse', log: (l) => logs.push(l), busy, ...more,
      start: (_space, step) => { const problem = start(step); if (!problem) started.push(step); return problem },
    })
    await runner.tick()
    return { started, brain, logs, runner }
  }

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

  it('starts only a delegate that works alone: a together task stays with its owner (delegation.mode)', async () => {
    const { started } = await run([
      { id: 'plan', status: 'active' },
      { id: 'alone', status: 'planned', parent: 'plan', checkpoint: 'after', delegate: 'atlas', mode: 'alone' },
      { id: 'together', status: 'planned', parent: 'plan', checkpoint: 'after', delegate: 'atlas', mode: 'together' },
      // Written before schema 23, without a delegation: alone.
      { id: 'legacy', status: 'planned', parent: 'plan', checkpoint: 'after', delegate: 'atlas' },
    ])
    expect(started.map((s) => s.id).sort()).toEqual(['alone', 'legacy'])
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

  it('starts a delegated task whose owner is a person, but not while someone is waited on, its hand-over can be undone, or a job will start it', async () => {
    const { started } = await run([
      { id: 'owned', status: 'planned', checkpoint: 'after', assignee_ids: ['lasse'], delegate: 'atlas' },
      { id: 'asked', status: 'planned', checkpoint: 'after', delegate: 'atlas', waiting_on: { who: 'lasse', kind: 'question' } },
      { id: 'held', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'at-nine', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
    ], undefined, () => null, () => false, { held: (id) => id === 'held', scheduled: (id) => id === 'at-nine' })
    expect(started.map((s) => s.id)).toEqual(['owned'])
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
    ], undefined, () => null, (id) => id === 'taken')
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
    ], undefined, () => null, () => false, { scheduled: (id) => id.includes('job-') })
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
    ])
    expect(started).toHaveLength(1)
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
    expect(mod.stepPrompt(step, 'after')).toContain('Do NOT close the task yourself')
    expect(mod.stepPrompt(step, 'none')).toContain('close it')
    expect(mod.stepPrompt(step, 'none')).toContain('to the end on your own')
  })
})

describe('the owner\'s own session and Delegate now (B3)', () => {
  type Busy = typeof import('../src/domain/runner-busy.js')
  let busy: Busy
  beforeAll(async () => { busy = await import('../src/domain/runner-busy.js') })

  const at = (iso: string, more: Partial<{ archived: boolean; working: boolean }> = {}) => ({ createdAt: iso, archived: false, working: false, ...more })

  it('an idle session from before Delegate now does not block; a later, a working or an un-delegated one does', () => {
    const delegated = '2026-11-23T10:00:00.000Z'
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z')], delegated)).toBe(false)
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z', { working: true })], delegated)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T10:05:00.000Z')], delegated)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T09:00:00.000Z')], null)).toBe(true)
    expect(busy.sessionsBlockRunner([at('2026-11-23T10:05:00.000Z', { archived: true })], null)).toBe(false)
  })

  it('reproduced: Delegate now on an active task while the owner\'s idle session on it is open starts the delegate', async () => {
    const { createTaskCommands, TaskCommandStore, UNDO_WINDOW_MS } = await import('../src/application/task-commands.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const list: T[] = [{ id: 'own-task', status: 'active', assignee_ids: ['lasse'] }]
    const brain = brainOf(list)
    // The owner's own session on the task, open and idle, from before the hand-over.
    const ledger = new SessionLedger()
    ledger.recordSpawn('own', null, 'bp-eml', 'claude', false, 'own-task')
    let now = Date.now() + 60_000
    const commands = createTaskCommands({
      store: new TaskCommandStore(join(home, 'b3-commands.json')), space: () => ({ id: 'main', name: 'Main', shared: false }) as never,
      brain: () => ({ get: brain.get, post: async (path: string, body: Record<string, unknown>) => {
        const t = list[0]; const d = body.delegation as { agent: string; checkpoint?: string } | undefined
        if (d) { t.delegate = d.agent; t.checkpoint = d.checkpoint }
        return brain.post(path, body)
      } }),
      agentsOf: async () => ['atlas'], createJob: async () => ({ jobId: 'j' }), changed: () => {}, now: () => now, log: () => {},
    })
    await commands.submit({ opId: 'op-b3', kind: 'hand_over', spaceId: 'main', taskId: 'own-task', handOver: { mode: 'now', delegate: 'atlas', checkpoint: 'after' } })
    now += UNDO_WINDOW_MS + 1
    await commands.tick()
    expect(list[0]).toMatchObject({ status: 'planned', delegate: 'atlas', checkpoint: 'after' })

    const started: string[] = []
    const { createTaskRunner } = await import('../src/application/task-runner.js')
    const runner = createTaskRunner({
      spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse', log: () => {},
      // As index.ts wires it.
      busy: (id) => busy.sessionsBlockRunner(ledger.list().filter((e) => e.taskId === id).map((e) => ({ createdAt: e.createdAt, archived: Boolean(e.archivedAt), working: false })), commands.delegatedAt(id)),
      held: (id) => commands.held(id) || commands.together(id),
      start: (_space, step) => { started.push(step.id); return null },
    })
    await runner.tick()
    expect(started).toEqual(['own-task'])
  })
})
