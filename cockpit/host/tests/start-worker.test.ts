import { describe, expect, it } from 'vitest'
import { MIN_FREE_MEMORY, StartWorker } from '../src/application/start-worker.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'

const request: SpawnRequest = { id: 'w1', projectId: 'p', prompt: 'do it', title: null, fromSessionId: 'requester', createdAt: '' }

function setup(opts: { inChat?: boolean; chatProblem?: string; free?: number | null } = {}) {
  const started: string[] = []
  const worker = new StartWorker({
    chat: { startWorker: () => { started.push('chat'); return opts.chatProblem ?? null } },
    terminal: { startWorker: () => { started.push('terminal'); return null } },
    runsInChat: () => opts.inChat !== false,
    freeMemory: () => (opts.free === undefined ? MIN_FREE_MEMORY : opts.free),
    log: () => {},
  })
  return { worker, started }
}

describe('StartWorker', () => {
  it('starts a pane worker in chat on the host', () => {
    const { worker, started } = setup()
    expect(worker.forPane(request)).toBe('sdk')
    expect(started).toEqual(['chat'])
  })

  it('leaves a pane worker that cannot run in chat to the pane', () => {
    const { worker, started } = setup({ inChat: false })
    expect(worker.forPane(request)).toBe('terminal')
    expect(started).toEqual([])
  })

  it('a chat start that fails leaves a pane worker to the pane', () => {
    const { worker } = setup({ chatProblem: 'no' })
    expect(worker.forPane(request)).toBe('terminal')
  })

  it('the host\'s own requests stay in the terminal', () => {
    const { worker, started } = setup()
    expect(worker.forPane({ ...request, fromSessionId: null })).toBe('terminal')
    expect(started).toEqual([])
  })

  it('runs a worker without a pane in chat, or else in the terminal', () => {
    const chat = setup()
    chat.worker.withoutPane(request)
    expect(chat.started).toEqual(['chat'])
    const terminal = setup({ inChat: false })
    terminal.worker.withoutPane(request)
    expect(terminal.started).toEqual(['terminal'])
    const failed = setup({ chatProblem: 'no' })
    failed.worker.withoutPane(request)
    expect(failed.started).toEqual(['chat', 'terminal'])
  })

  it('a worker with a tool profile never falls back to the terminal', () => {
    const limited = { ...request, toolProfile: { deniedTools: ['Bash'], mcpServers: null } }
    const noChat = setup({ inChat: false })
    expect(noChat.worker.forPane(limited)).toBeNull()
    expect(noChat.worker.withoutPane(limited)).toBe('a tool profile needs the chat runtime')
    expect(noChat.started).toEqual([])
    const failed = setup({ chatProblem: 'no' })
    expect(failed.worker.forPane(limited)).toBeNull()
    expect(failed.worker.withoutPane(limited)).toBe('no')
    expect(failed.started).toEqual(['chat', 'chat'])
  })

  it('has room above the memory floor, and where memory cannot be told', () => {
    expect(setup({ free: MIN_FREE_MEMORY }).worker.hasRoom()).toBe(true)
    expect(setup({ free: MIN_FREE_MEMORY - 1 }).worker.hasRoom()).toBe(false)
    expect(setup({ free: null }).worker.hasRoom()).toBe(true)
  })
})
