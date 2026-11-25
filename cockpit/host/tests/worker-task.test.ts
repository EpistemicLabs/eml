import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-worker-task-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const { createWorkerTask, createWorkerTaskHolds, WORKER_START_GRACE_MS } = await import('../src/application/worker-task.js')
const { createTaskRunner } = await import('../src/application/task-runner.js')

type Task = { id: string; title: string; content: string; status: string; scope: string; properties: Record<string, unknown> }

/** One brain for the spawn API and the runner: a task is listed the moment it is written. */
function brainOf(onWrite: (task: Task) => Promise<void> = async () => {}) {
  const tasks: Task[] = []
  const tracks: string[] = []
  return {
    tasks, tracks,
    async get(path: string, query?: Record<string, unknown>) {
      if (path === '/list') return { engrams: tasks.filter((t) => t.status === query?.status) }
      if (path.startsWith('/object/run')) return { objects: [] }
      const t = tasks.find((x) => x.id === path.slice('/engram/'.length))
      if (!t) throw new Error('not found')
      return { ...t, relations: [] }
    },
    async post(path: string, body: Record<string, unknown>) {
      if (path === '/engram/task') {
        const { title, content, status, scope, ...properties } = body
        const t: Task = { id: `task-${tasks.length + 1}`, title: title as string, content: content as string, status: status as string, scope: scope as string, properties }
        tasks.push(t)
        // the worst case: the runner ticks after the write, before the spawn API has the task's id
        await onWrite(t)
        return t
      }
      tracks.push(path)
      return {}
    },
  }
}

describe('a task the cockpit creates for a spawned worker', () => {
  it('is handed to the space\'s agent with checkpoint none and a request; without an agent it gets no delegation', async () => {
    const holds = createWorkerTaskHolds()
    const brain = brainOf()
    const made = await createWorkerTask({ brain, owner: 'lasse', agent: 'atlas', holds, now: () => Date.parse('2026-11-25T10:00:00.000Z') }, { title: 'Check the Acme feed', content: 'Check it.', scope: 'project.acme' })
    expect(made).toEqual(expect.objectContaining({ id: 'task-1' }))
    expect(brain.tasks[0].properties).toEqual({
      display_title: 'Check the Acme feed', assignee_ids: ['lasse'],
      delegation: { agent: 'atlas', checkpoint: 'none', requested_at: '2026-11-25T10:00:00.000Z' },
    })
    expect(holds.holds('task-1')).toBe(true)

    const bare = brainOf()
    await createWorkerTask({ brain: bare, owner: 'lasse', agent: null, holds }, { title: 'x', content: 'x', scope: 'project.acme' })
    expect(bare.tasks[0].properties).not.toHaveProperty('delegation')
  })

  it('the runner does not start a second session next to its worker, even when it ticks between the task\'s write and the worker\'s start', async () => {
    let clock = Date.parse('2026-11-25T10:00:00.000Z')
    const holds = createWorkerTaskHolds(() => clock)
    const started: string[] = []
    const ticks: Array<Promise<void>> = []
    const runner = () => createTaskRunner({
      spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse', log: () => {},
      held: (id, requestedAt) => holds.holds(id, requestedAt),
      start: (_space, step) => { started.push(step.id); return null },
    })
    const brain = brainOf(async () => { ticks.push(runner().tick()); await ticks.at(-1) })
    await createWorkerTask({ brain, owner: 'lasse', agent: 'atlas', holds, now: () => clock }, { title: 'Check the feed', content: 'Check it.', scope: 'project.acme' })
    await Promise.all(ticks)
    expect(started).toEqual([])
    // after the write, while the worker has not reached the ledger yet
    await runner().tick()
    expect(started).toEqual([])
    // a worker that never started leaves the task to the runner after the grace time
    clock += WORKER_START_GRACE_MS
    await runner().tick()
    expect(started).toEqual(['task-1'])
  })

  it('holds by the request\'s time until the task has an id, then by the id, for the grace time only', () => {
    let clock = 0
    const holds = createWorkerTaskHolds(() => clock)
    const hold = holds.start('2026-11-25T10:00:00.000Z')
    expect(holds.holds('anything', '2026-11-25T10:00:00.000Z')).toBe(true)
    expect(holds.holds('t1', '2026-11-25T10:00:01.000Z')).toBe(false)
    hold.bind('t1')
    expect(holds.holds('t1')).toBe(true)
    clock = WORKER_START_GRACE_MS
    expect(holds.holds('t1')).toBe(false)
  })
})
