import { describe, expect, it } from 'vitest'
import { createSessionKind } from '../src/application/session-kind.js'

type Entry = { taskId: string | null; spaceId: string | null; worker: boolean; parentSessionId: string | null; jobId: string | null }

function setup(entries: Record<string, Partial<Entry>>, tasks: Record<string, { delegate?: string } | Error>, brain = true) {
  const full = (e: Partial<Entry>): Entry => ({ taskId: null, spaceId: null, worker: false, parentSessionId: null, jobId: null, ...e })
  return createSessionKind({
    ledger: { get: (id: string) => (entries[id] ? full(entries[id]!) : undefined) } as never,
    spaces: { resolve: () => ({}) as never },
    brain: () => (brain ? {
      get: async (path: string) => {
        const task = tasks[decodeURIComponent(path.replace('/engram/', ''))]
        if (!task || task instanceof Error) throw task ?? new Error('404')
        return { id: 'x', properties: task }
      },
    } as never : null),
  })
}

describe('session kind', () => {
  it('reads the task as it stands now: handed over, the session works on its own, also one the user started', async () => {
    const tasks: Record<string, { delegate?: string }> = { t1: {} }
    const kind = setup({ own: { taskId: 't1' }, runner: { taskId: 't1', worker: true } }, tasks)
    expect(await kind.worksAlone('own')).toBe(false)
    expect(await kind.worksAlone('runner')).toBe(false)
    tasks.t1!.delegate = 'atlas'
    expect(await kind.worksAlone('own')).toBe(true)
    expect(await kind.worksAlone('runner')).toBe(true)
  })

  it('keeps a worker a session or a job started on its own on a task that is not handed over', async () => {
    const kind = setup({ spawned: { taskId: 't1', worker: true, parentSessionId: 'main' }, job: { taskId: 't1', worker: true, jobId: 'j1' } }, { t1: {} })
    expect(await kind.worksAlone('spawned')).toBe(true)
    expect(await kind.worksAlone('job')).toBe(true)
  })

  it('goes by how the session was started without a task, without a brain, or when the task cannot be read', async () => {
    expect(await setup({ w: { worker: true }, own: {} }, {}).worksAlone('w')).toBe(true)
    expect(await setup({ w: { worker: true }, own: {} }, {}).worksAlone('own')).toBe(false)
    expect(await setup({ w: { taskId: 't1', worker: true } }, { t1: {} }, false).worksAlone('w')).toBe(true)
    expect(await setup({ w: { taskId: 'gone', worker: true } }, {}).worksAlone('w')).toBe(true)
  })

  it('takes a session it does not know as nobody\'s', async () => {
    expect(await setup({}, {}).worksAlone('nope')).toBe(false)
  })
})
