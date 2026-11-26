import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, SessionSpace } from '../src/domain/agent-provider.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-codex-workers-'))
process.env.EML_COCKPIT_HOME = home

/**
 * Where a Codex worker runs and whether it gets an address: in the chat once the user switched Codex's chat view
 * on (Settings › Models › Codex), in a terminal before; a worker with tool limits never, since Codex cannot hold them.
 */

const space: SessionSpace = { id: 'main', mcpToken: 't', files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e' } }
const request: SpawnRequest = { id: 'w1', projectId: 'bp-eml', prompt: 'do it', title: null, fromSessionId: 'requester', createdAt: '', provider: 'codex' }
const limited = { ...request, toolProfile: { deniedTools: ['Bash'], mcpServers: null } }

describe('Codex workers', () => {
  let codex: AgentProvider
  let mods: {
    workerInChat: typeof import('../src/application/start-worker.js')['workerInChat']
    StartWorker: typeof import('../src/application/start-worker.js')['StartWorker']
    MIN_FREE_MEMORY: number
    requestSpawn: typeof import('../src/spawn-api.js')['requestSpawn']
    SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
    SpawnQueue: typeof import('../src/spawn-queue.js')['SpawnQueue']
    sessionAddress: typeof import('../src/session-address.js')['sessionAddress']
  }
  beforeAll(async () => {
    codex = (await import('../src/infrastructure/providers/codex/index.js')).createCodexProvider()
    const startWorker = await import('../src/application/start-worker.js')
    mods = {
      workerInChat: startWorker.workerInChat,
      StartWorker: startWorker.StartWorker,
      MIN_FREE_MEMORY: startWorker.MIN_FREE_MEMORY,
      requestSpawn: (await import('../src/spawn-api.js')).requestSpawn,
      SessionLedger: (await import('../src/session-ledger.js')).SessionLedger,
      SpawnQueue: (await import('../src/spawn-queue.js')).SpawnQueue,
      sessionAddress: (await import('../src/session-address.js')).sessionAddress,
    }
  })
  afterEach(() => { codex.settings?.write({ chatView: false }) })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const chatView = (on: boolean) => expect(codex.settings?.write({ chatView: on })).toBeNull()

  /** StartWorker as the host wires it (index.ts): the request's provider decides through workerInChat. */
  const starter = () => {
    const started: string[] = []
    const worker = new mods.StartWorker({
      chat: { startWorker: () => { started.push('chat'); return null } },
      terminal: { startWorker: () => { started.push('terminal'); return null } },
      runsInChat: (asked) => mods.workerInChat(codex, space, asked),
      freeMemory: () => mods.MIN_FREE_MEMORY,
      log: () => {},
    })
    return { worker, started }
  }

  it('run in the chat with the chat view on, in a terminal without it', () => {
    expect(mods.workerInChat(codex, space, request)).toBe(false)
    const terminal = starter()
    expect(terminal.worker.forPane(request)).toBe('terminal')
    expect(terminal.worker.withoutPane(request)).toBeNull()
    expect(terminal.started).toEqual(['terminal'])

    chatView(true)
    expect(mods.workerInChat(codex, space, request)).toBe(true)
    const chat = starter()
    // A session's worker, a job's run, a task run: each starts on the host in the chat, a pane only joins.
    for (const origin of [{}, { fromSessionId: null, origin: 'job' as const }, { fromSessionId: null, origin: 'runner' as const }]) {
      expect(chat.worker.forPane({ ...request, ...origin })).toBe('sdk')
    }
    expect(chat.worker.withoutPane(request)).toBeNull()
    expect(chat.started).toEqual(['chat', 'chat', 'chat', 'chat'])
    // The host's own requests need a person at a terminal, as for Claude Code.
    expect(chat.worker.forPane({ ...request, fromSessionId: null })).toBe('terminal')
  })

  it('with tool limits stay refused, chat view or not: Codex cannot hold them', () => {
    for (const on of [false, true]) {
      chatView(on)
      expect(mods.workerInChat(codex, space, limited)).toBe(false)
      const { worker, started } = starter()
      expect(worker.forPane(limited)).toBeNull()
      expect(worker.withoutPane(limited)).toBe('a tool profile needs the chat runtime')
      expect(started).toEqual([])
    }
  })

  describe('requested by a session', () => {
    const setup = () => {
      const ledger = new mods.SessionLedger()
      const spawns = new mods.SpawnQueue()
      const space = { main: true, id: 'main', registry: { get: (id: string) => (id.startsWith('bp-') ? { projectId: id } : undefined), list: () => [] }, projects: { list: async () => [] } }
      const deps = {
        ledger, spawns, spawnToken: 't', deliver: async () => 'delivered' as const,
        spaces: { resolve: () => space }, providers: { get: (id: string) => (id === 'codex' ? codex : undefined), default: () => codex, all: () => [codex] },
      } as unknown as Parameters<typeof mods.requestSpawn>[0]
      ledger.recordSpawn('requester', null, 'bp-eml', 'claude', false, null)
      return { deps, spawns }
    }

    it('get an address once they run in the chat, none in a terminal', async () => {
      const { deps } = setup()
      const terminal = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'do it', provider: 'codex', fromSession: 'requester' })
      expect(terminal.status).toBe(202)
      expect(terminal.payload).not.toHaveProperty('address')
      chatView(true)
      const chat = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'do it', provider: 'codex', fromSession: 'requester' })
      expect(chat.status).toBe(202)
      const { id, address } = chat.payload as { id: string; address?: string }
      expect(address).toBe(mods.sessionAddress(id, 'bp-eml'))
      // The host's own start stays in a terminal: nothing to send to.
      const own = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'do it', provider: 'codex' })
      expect(own.payload).not.toHaveProperty('address')
    })

    it('with tool limits are refused with the reason, chat view or not', async () => {
      for (const on of [false, true]) {
        chatView(on)
        const { deps, spawns } = setup()
        const out = await mods.requestSpawn(deps, { project: 'bp-eml', prompt: 'do it', provider: 'codex', fromSession: 'requester', deniedTools: ['Bash'] })
        expect(out).toEqual({ status: 400, payload: { error: { code: 'TOOLS_NEED_CHAT', message: 'Codex sessions cannot be limited to some tools: a worker with tool limits needs Claude Code in the chat view.' } } })
        expect(spawns.list()).toEqual([])
      }
    })
  })
})
