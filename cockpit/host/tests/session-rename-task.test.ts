import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmlApiError } from '@engramprotocol/mcp-server'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-rename-task-test-'))
process.env.EML_COCKPIT_HOME = home

const MAIN = 'main-brain-id'

const fakeSpace = {
  id: MAIN,
  name: 'Main',
  main: true,
  agent: 'atlas',
  runtime: null,
  ledgerKey: null,
  url: 'http://127.0.0.1:1',
  token: 'eml_testprefix_testsecret',
  registry: { get: (projectId: string) => ({ projectId, path: `/main/${projectId}` }) },
  notes: { subscribe: () => () => {} },
}

/** A session with a task is called by its task; renaming it renames the task (application/session-task.ts renamed). */
describe('a session called by its task', () => {
  let server: Server
  let base: string
  let ledger: import('../src/session-ledger.js').SessionLedger
  const names = new Map<string, string>()
  const delegated = new Map<string, boolean>()
  /** Where the board last read each task (TaskBoard.waitsSeen); a task left out is one it has not read. */
  const seen = new Map<string, import('../src/domain/session-attention.js').TaskWaitsSeen>()
  const renames: Array<[string, string]> = []
  let refreshes = 0
  let refuse: Error | null = null

  beforeAll(async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    const { createHostServer } = await import('../src/http.js')
    ledger = new SessionLedger()
    ledger.recordSpawn('tasked', null, 'p1', 'claude', false, 'task-1')
    ledger.recordSpawn('plain', null, 'p1', 'claude')
    ledger.recordSpawn('lead', null, 'p1', 'claude')
    ledger.expectParent('helper', 'lead')
    ledger.recordSpawn('helper', null, 'p1', 'claude', true, 'task-2')
    const provider = {
      id: 'claude',
      summary: () => ({ messageCount: 1, lastMessageAt: null, lastActivity: null, summary: 'First prompt', aiTitle: null, lastReply: null, model: null, contextTokens: null }),
      deleteTranscript: () => {},
    }
    const deps = {
      spaces: new BrainSpaces(fakeSpace as never),
      turns: new TurnTracker(),
      providers: { forSession: () => provider, all: () => [provider] },
      bridge: {
        ledger,
        sessionRef: (sessionId: string, projectPath: string | null) => ({ sessionId, projectPath }),
        sessionState: () => 'ended',
        killSession: () => {},
      },
      chat: { isRunning: () => false, backgroundTasks: () => 0, kill: async () => {}, end: async () => {} },
      spawns: { on: () => {}, off: () => {}, list: () => [] },
      spawnToken: 'spawn-token',
      hookToken: 'hook-token',
      turnHookConfig: '',
      sessionTask: {
        async renamed(sessionId: string, title: string) {
          if (refuse) throw refuse
          if (!ledger.get(sessionId)?.taskId) return false
          renames.push([sessionId, title])
          names.set(ledger.get(sessionId)!.taskId!, title)
          return true
        },
      },
      tasks: { board: { nameOf: (taskId: string) => names.get(taskId) ?? null, delegated: (taskId: string) => delegated.get(taskId) ?? null, waitsSeen: (_spaceId: string | null, taskId: string) => seen.get(taskId) ?? null, refresh: async () => { refreshes += 1 } } },
    }
    server = createHostServer(deps as never, ['http://cockpit.test'])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })
  beforeEach(() => { refuse = null })

  const patch = (id: string, body: unknown) => fetch(`${base}/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { origin: 'http://cockpit.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const listed = async () => {
    const { sessions } = await (await fetch(`${base}/api/sessions/all`)).json() as { sessions: Array<{ id: string; summary: string }> }
    return new Map(sessions.map((s) => [s.id, s.summary]))
  }

  it('lists a session with a named task by the task\'s name, and one without by its own', async () => {
    names.set('task-1', 'Fix the stock answers')
    const byId = await listed()
    expect(byId.get('tasked')).toBe('Fix the stock answers')
    expect(byId.get('plain')).toBe('First prompt')
  })

  it('says whether a session works on its own, by its task on the board', async () => {
    const alone = async () => {
      const { sessions } = await (await fetch(`${base}/api/sessions/all`)).json() as { sessions: Array<{ id: string; alone: boolean }> }
      return new Map(sessions.map((s) => [s.id, s.alone]))
    }
    // The user's own session: theirs until its task is handed to an agent; without a task, always.
    expect((await alone()).get('tasked')).toBe(false)
    delegated.set('task-1', true)
    expect((await alone()).get('tasked')).toBe(true)
    expect((await alone()).get('plain')).toBe(false)
    delegated.delete('task-1')
  })

  it('shows a session waiting only while its task holds the wait, and lets its starter be archived once the task is closed', async () => {
    const attentionOf = async (id: string) => {
      const { sessions } = await (await fetch(`${base}/api/sessions/all`)).json() as { sessions: Array<{ id: string; attention: { kind: string } | null }> }
      return sessions.find((s) => s.id === id)?.attention ?? null
    }
    const archive = (id: string) => fetch(`${base}/api/sessions/${id}/archive`, { method: 'POST', headers: { origin: 'http://cockpit.test' } })
    ledger.setAttention('helper', { kind: 'question', reason: 'Which one?' })
    const later = new Date(Date.now() + 60_000).toISOString()
    // The board has not read its task: the session's own mark counts, and the question holds its starter.
    expect((await attentionOf('helper'))?.kind).toBe('question')
    expect((await archive('lead')).status).toBe(409)
    // Its task holds the wait: still waiting.
    seen.set('task-2', { open: true, sessions: new Set(['helper']), at: later })
    expect((await attentionOf('helper'))?.kind).toBe('question')
    // The task is closed: nothing waits, in the list and for the archive.
    seen.set('task-2', { open: false, sessions: new Set(['helper']), at: later })
    expect(await attentionOf('helper')).toBeNull()
    const res = await archive('lead')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { archived: string[] }).archived).toEqual(expect.arrayContaining(['lead', 'helper']))
  })

  it('renames the task when the session is renamed, answers with the task\'s new name, and keeps no second copy', async () => {
    ledger.update('tasked', { title: 'A name from before' })
    const before = refreshes
    const res = await patch('tasked', { title: '  Check   the stock  ' })
    expect(res.status).toBe(200)
    expect(renames.at(-1)).toEqual(['tasked', 'Check the stock'])
    expect(refreshes).toBe(before + 1)
    expect(((await res.json()) as { session: { summary: string } }).session.summary).toBe('Check the stock')
    expect(ledger.get('tasked')!.title).toBeNull()
  })

  it('leaves the session as it was when the brain refuses, and says whether trying again can help', async () => {
    ledger.update('tasked', { title: 'Kept' })
    const cases: Array<[Error, number, string]> = [
      [new EmlApiError(0, null, 'POST /task/task-1/track → network: refused'), 502, 'BRAIN_UNAVAILABLE'],
      [new EmlApiError(503, null, 'POST /task/task-1/track → 503: busy'), 502, 'BRAIN_UNAVAILABLE'],
      [new EmlApiError(404, null, 'POST /task/task-1/track → 404: engram not found'), 404, 'TASK_NOT_FOUND'],
      [new EmlApiError(400, null, 'POST /task/task-1/track → 400: Invalid engram'), 422, 'TASK_NAME_REFUSED'],
      [new Error('anything else'), 502, 'BRAIN_UNAVAILABLE'],
    ]
    for (const [err, status, code] of cases) {
      refuse = err
      const res = await patch('tasked', { title: 'Another name' })
      expect(res.status).toBe(status)
      const { error } = (await res.json()) as { error: { code: string; message: string } }
      expect(error.code).toBe(code)
      // the brain's own wording stays inside the host
      expect(error.message).not.toContain('/task/')
      expect(ledger.get('tasked')!.title).toBe('Kept')
    }
  })

  it('renames a session without a task on its own', async () => {
    const count = renames.length
    const res = await patch('plain', { title: 'My session' })
    expect(res.status).toBe(200)
    expect(renames).toHaveLength(count)
    expect(ledger.get('plain')!.title).toBe('My session')
    expect((await listed()).get('plain')).toBe('My session')
  })
})
