import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-runner-'))
process.env.EML_COCKPIT_HOME = home

type Mod = typeof import('../src/application/task-runner.js')

type T = { id: string; status: string; title?: string; scope?: string; checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; waiting_on?: Record<string, string>; parent?: string }

/** A brain with tasks and their part_of relations, as GET /engram?with_relations and /list give them. */
function brainOf(list: T[]) {
  const byId = new Map(list.map((t) => [t.id, t]))
  const view = (t: T) => ({
    id: t.id, title: t.title ?? t.id, content: `do ${t.id}`, status: t.status, scope: t.scope ?? 'project.eml', parent_id: t.parent ?? null,
    properties: { ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}), ...(t.depends_on ? { depends_on: t.depends_on } : {}), ...(t.assignee_ids ? { assignee_ids: t.assignee_ids } : {}), ...(t.delegate ? { delegate: t.delegate } : {}), ...(t.waiting_on ? { waiting_on: t.waiting_on } : {}) },
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

  const run = async (list: T[], space = { taskSystem: true, shared: false, name: 'Main' }, start: (step: { id: string }) => string | null = () => null, busy: (id: string) => boolean = () => false, more: { held?: (id: string) => boolean; scheduled?: (id: string) => boolean } = {}) => {
    const brain = brainOf(list)
    const started: Array<{ id: string; projectId: string; checkpoint: string }> = []
    const logs: string[] = []
    const runner = mod.createTaskRunner({
      spaces: { list: () => [space as never] }, brain: () => brain, log: (l) => logs.push(l), busy, ...more,
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

  it('starts a standalone task with a checkpoint, at most three at a time, and none a session already works on', async () => {
    const { started } = await run([
      { id: 'running-1', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'running-2', status: 'active', checkpoint: 'after', delegate: 'atlas' },
      { id: 'mine', status: 'planned', checkpoint: 'after', assignee_ids: ['lasse'] },
      { id: 'plain', status: 'planned', delegate: 'atlas' },
      { id: 'taken', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'free-1', status: 'planned', checkpoint: 'after', delegate: 'atlas' },
      { id: 'free-2', status: 'planned', checkpoint: 'none', delegate: 'atlas' },
    ], undefined, () => null, (id) => id === 'taken')
    expect(started.map((s) => s.id)).toEqual(['free-1'])
  })

  it('runs at most three steps of one task at a time', async () => {
    const { started } = await run([
      { id: 'plan', status: 'active' },
      { id: 'r1', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 'r2', status: 'active', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 's1', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
      { id: 's2', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' },
    ])
    expect(started).toHaveLength(1)
  })

  it('does nothing where the task system is off, and keeps a step planned when it cannot start', async () => {
    const steps: T[] = [{ id: 'plan', status: 'active' }, { id: 's', status: 'planned', parent: 'plan', checkpoint: 'none', delegate: 'atlas' }]
    expect((await run(steps, { taskSystem: true, shared: true, name: 'EML' })).started).toEqual([])
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
