import { describe, expect, it } from 'vitest'
import { MIN_FREE_MEMORY, StartWorker, TOOL_PROFILE_NEEDS_CHAT } from '../src/application/start-worker.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'

const request: SpawnRequest = { id: 'w1', projectId: 'p', prompt: 'do it', title: null, fromSessionId: 'requester', createdAt: '' }

function setup(opts: { inChat?: boolean; chatProblem?: string; free?: number | null } = {}) {
  const started: string[] = []
  const logged: string[] = []
  const worker = new StartWorker({
    chat: { startWorker: () => { started.push('chat'); return opts.chatProblem ?? null } },
    runsInChat: () => opts.inChat !== false,
    freeMemory: () => (opts.free === undefined ? MIN_FREE_MEMORY : opts.free),
    log: (line) => logged.push(line),
  })
  return { worker, started, logged }
}

describe('StartWorker', () => {
  it('starts a worker in chat on the host, with a tab or without', () => {
    const { worker, started } = setup()
    expect(worker.start(request)).toBeNull()
    expect(started).toEqual(['chat'])
  })

  it('starts every kind of request in chat: a session\'s worker, a job, a task run, a split, the host\'s own', () => {
    const { worker, started } = setup()
    const kinds: SpawnRequest[] = [
      request,
      { ...request, fromSessionId: null, origin: 'job' },
      { ...request, fromSessionId: null, origin: 'runner' },
      { ...request, fromSessionId: null, origin: 'task', taskId: 't1' },
      { ...request, origin: 'split' },
      // Getting started, brain hygiene: no origin, no requester.
      { ...request, fromSessionId: null },
    ]
    for (const kind of kinds) expect(worker.start(kind)).toBeNull()
    expect(started).toEqual(kinds.map(() => 'chat'))
  })

  it('a chat start that fails is refused with its reason and logged, never left to a terminal', () => {
    const { worker, started, logged } = setup({ chatProblem: 'Claude Code is not signed in' })
    expect(worker.start({ ...request, fromSessionId: null })).toBe('Claude Code is not signed in')
    expect(started).toEqual(['chat'])
    expect(logged).toEqual(['[worker] w1 could not start: Claude Code is not signed in'])
  })

  it('a worker with a tool profile its provider\'s chat cannot hold does not start', () => {
    const limited = { ...request, toolProfile: { deniedTools: ['Bash'], mcpServers: null } }
    const noChat = setup({ inChat: false })
    expect(noChat.worker.start(limited)).toBe(TOOL_PROFILE_NEEDS_CHAT)
    expect(noChat.started).toEqual([])
  })

  it('has room above the memory floor, and where memory cannot be told', () => {
    expect(setup({ free: MIN_FREE_MEMORY }).worker.hasRoom()).toBe(true)
    expect(setup({ free: MIN_FREE_MEMORY - 1 }).worker.hasRoom()).toBe(false)
    expect(setup({ free: null }).worker.hasRoom()).toBe(true)
  })

  it('at the running cap, has room only once a quiet session made way', () => {
    let quiet = false
    let stopped = 0
    const worker = new StartWorker({
      chat: { startWorker: () => null }, runsInChat: () => true,
      freeMemory: () => null, log: () => {},
      atCap: () => true,
      makeRoom: () => { if (quiet) stopped += 1; return quiet },
    })
    expect(worker.hasRoom()).toBe(false)
    quiet = true
    expect(worker.hasRoom()).toBe(true)
    expect(stopped).toBe(1)
  })

  it('makes no room while free memory is low: stopping a session would not be enough reason to start one', () => {
    let asked = 0
    const worker = new StartWorker({
      chat: { startWorker: () => null }, runsInChat: () => true,
      freeMemory: () => MIN_FREE_MEMORY - 1, log: () => {},
      atCap: () => true, makeRoom: () => { asked += 1; return true },
    })
    expect(worker.hasRoom()).toBe(false)
    expect(asked).toBe(0)
  })
})
