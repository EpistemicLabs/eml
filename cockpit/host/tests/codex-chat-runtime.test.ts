import { describe, expect, it } from 'vitest'
import './setup-home.js'
import type { RuntimeEvent, SessionRuntime, SessionRuntimeStart } from '../src/domain/session-runtime.js'
import { createCodexChatRuntimes, startingMode, threadPermissions, type CodexChatHost, OPEN_ELSEWHERE } from '../src/infrastructure/providers/codex/chat-runtime.js'
import { historyEvents } from '../src/infrastructure/providers/codex/event-mapper.js'
import type { Turn } from '../src/infrastructure/providers/codex/protocol.js'
import { codexRuntime } from '../src/infrastructure/providers/codex/runtime.js'
import { codexSettings } from '../src/infrastructure/providers/codex/settings.js'
import { CODEX_CONFIG_DIR } from '../src/paths.js'
import { FakeAppServer, RefusedRequest, fakeSpawn, recorded } from './helpers/fake-app-server.js'

/**
 * The Codex chat runtime against an app-server that is none (helpers/fake-app-server.ts):
 * what it asks of the server and in which order, and what the bridge hears of it. What
 * every chat runtime owes the bridge is in runtime-contract.test.ts.
 */

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

const ENV = { CODEX_HOME: '/codex-home', COCKPIT_SESSION_ID: 's1', PATH: '/bin' }

interface Started {
  runtime: SessionRuntime
  events: RuntimeEvent[]
  server: FakeAppServer
  spawned: number[]
}

function start(over: Partial<SessionRuntimeStart> = {}, configure: (server: FakeAppServer) => void = () => {}, host: CodexChatHost = {}): Started {
  const events: RuntimeEvent[] = []
  const spawned: number[] = []
  const { spawn, servers } = fakeSpawn(configure)
  const runtime = createCodexChatRuntimes(spawn, host).start({
    sessionId: 's1', resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: ENV, address: 'session-address',
    launch: { bin: 'codex', args: [], env: {}, keepRunning: false },
    space: { id: 'space', mcpToken: 't', files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e' } },
    onEvent: (event) => events.push(event),
    onSpawn: (pid) => spawned.push(pid),
    ...over,
  })
  return { runtime, events, server: servers[0], spawned }
}

const kinds = (events: RuntimeEvent[]) => events.map((event) => event.kind)
const methods = (server: FakeAppServer) => server.received.flatMap((message) => (message.method ? [message.method] : []))
const text = (words: string) => ({ type: 'text', text: words, text_elements: [] })
const hiddenText = (words: string) => text(`<cockpit-context>\n${words}\n</cockpit-context>`)

describe('the Codex chat runtime, a start', () => {
  it('runs one app-server in the session\'s folder, with the session\'s environment and nothing else', async () => {
    const { runtime, server, spawned } = start()
    expect(server.spawned).toEqual({ bin: codexRuntime.bin, args: ['app-server'], cwd: '/work', env: ENV })
    expect(spawned).toEqual([4242])
    await runtime.close()
  })

  it('opens a new thread in the user\'s mode, binds its id, and then says what can be chosen and what it runs with', async () => {
    const { runtime, events, server } = start()
    await flush()
    expect(methods(server)).toEqual(['initialize', 'initialized', 'thread/start', 'model/list'])
    expect(server.requestsOf('initialize')[0]).toMatchObject({ clientInfo: { name: 'eml_cockpit' } })
    // Auto, the setting's default: what the terminal's arguments say for the same mode.
    expect(server.requestsOf('thread/start')).toEqual([{ cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }])
    expect(kinds(events)).toEqual(['conversation', 'capabilities', 'commands', 'settings'])
    expect(events[0]).toEqual({ kind: 'conversation', conversationId: server.threadId })
    expect(events[1]).toMatchObject({
      modes: [{ id: 'auto' }, { id: 'ask' }, { id: 'off' }],
      models: [
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', resolved: 'gpt-6-luna' },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      ],
    })
    expect(events[3]).toEqual({ kind: 'settings', model: 'gpt-6-luna', mode: 'auto' })
    await runtime.close()
  })

  it('continues the stored thread, and starts a new one when the server no longer has it', async () => {
    const resumed = start({ resume: true, conversationId: 'thread-9', model: 'gpt-5.6-terra' })
    await flush()
    expect(methods(resumed.server)).toEqual(['initialize', 'initialized', 'thread/resume', 'model/list'])
    expect(resumed.server.requestsOf('thread/resume')).toEqual([{
      threadId: 'thread-9', cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review', model: 'gpt-5.6-terra', excludeTurns: true,
    }])
    expect(resumed.events[0]).toEqual({ kind: 'conversation', conversationId: 'thread-9' })
    await resumed.runtime.close()

    const gone = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32600, 'no rollout found for thread id thread-9') })
    })
    await flush()
    expect(methods(gone.server)).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/start', 'model/list'])
    expect(kinds(gone.events)).toEqual(['notice', 'conversation', 'capabilities', 'commands', 'settings'])
    expect(gone.events[1]).toEqual({ kind: 'conversation', conversationId: gone.server.threadId })
    await gone.runtime.close()
  })

  it('does not fork a conversation another process still writes to, and reports any other refused resume', async () => {
    const busy = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32600, 'thread thread-9 already has an active writer') })
    })
    await flush()
    expect(methods(busy.server)).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(busy.events).toEqual([{ kind: 'error', message: `Codex did not start: ${OPEN_ELSEWHERE}` }, { kind: 'runtime_exit', expected: false }])
    const odd = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32603, 'internal error') })
    })
    await flush()
    expect(methods(odd.server)).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(odd.events).toEqual([{ kind: 'error', message: 'Codex did not start: internal error' }, { kind: 'runtime_exit', expected: false }])
  })

  it('reads a mode as the terminal does: the session\'s own, else the setting, with the network and the space\'s plugin servers', async () => {
    expect(threadPermissions('auto')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' })
    expect(threadPermissions('ask')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' })
    expect(threadPermissions('off')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(startingMode(null, 'ask')).toBe('ask')
    expect(startingMode('off', 'ask')).toBe('off')
    // A mode of another agent (a ledger entry from before) is none of Codex's.
    expect(startingMode('acceptEdits', 'auto')).toBe('auto')

    expect(codexSettings.write({ permissionMode: 'ask', sandboxNetwork: true })).toBeNull()
    try {
      const host: CodexChatHost = { pluginServers: (spaceId) => (spaceId === 'space' ? ['gmail', 'notion_2'] : []) }
      const asking = start({}, undefined, host)
      await flush()
      expect(asking.server.requestsOf('thread/start')).toEqual([{
        cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user',
        config: { 'sandbox_workspace_write.network_access': true, 'mcp_servers.gmail.enabled': true, 'mcp_servers.notion_2.enabled': true },
      }])
      expect(asking.events.at(-1)).toMatchObject({ kind: 'settings', mode: 'ask' })
      await asking.runtime.close()
      // Without the sandbox its network setting says nothing.
      const off = start({ mode: 'off' })
      await flush()
      expect(off.server.requestsOf('thread/start')).toEqual([{ cwd: '/work', approvalPolicy: 'never', sandbox: 'danger-full-access' }])
      await off.runtime.close()
    } finally {
      codexSettings.write({ permissionMode: 'auto', sandboxNetwork: false })
    }
  })

  it('says why Codex did not start, and ends', async () => {
    const { events } = start({}, (server) => {
      server.answer('thread/start', () => { throw new RefusedRequest(-32600, 'not signed in') })
    })
    await flush()
    expect(events).toEqual([{ kind: 'error', message: 'Codex did not start: not signed in' }, { kind: 'runtime_exit', expected: false }])
  })
})

describe('the Codex chat runtime, messages and turns', () => {
  it('starts a turn for a message, under the id the view shows it with', async () => {
    const { runtime, events, server } = start()
    // Sent while the session still starts: it waits for the thread.
    runtime.send('m1', 'Hello')
    await flush()
    expect(server.requestsOf('turn/start')).toEqual([{ threadId: server.threadId, input: [text('Hello')], clientUserMessageId: 'm1' }])
    expect(kinds(events).slice(-2)).toEqual(['activity', 'turn_end'])
    expect(kinds(events)).not.toContain('user_message')
    runtime.send('m2', '', [{ mediaType: 'image/png', data: 'AAAA' }])
    await flush()
    expect(server.requestsOf('turn/start')[1]).toEqual({ threadId: server.threadId, input: [{ type: 'image', url: 'data:image/png;base64,AAAA' }], clientUserMessageId: 'm2' })
    await runtime.close()
  })

  it('keeps a message sent during a turn until that turn is over, the interrupted one too', async () => {
    const { runtime, events, server } = start({}, (fake) => { fake.turnsEnd = false })
    await flush()
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    runtime.send('m3', 'third')
    await flush()
    expect(server.turnTexts()).toEqual([['first']])
    server.completeTurn()
    await flush()
    expect(server.turnTexts()).toEqual([['first'], ['second']])
    expect(events.filter((event) => event.kind === 'turn_end')).toEqual([{ kind: 'turn_end', reason: 'success' }])
    await runtime.interrupt()
    await flush()
    expect(server.requestsOf('turn/interrupt')).toEqual([{ threadId: server.threadId, turnId: 'turn-2' }])
    expect(events.filter((event) => event.kind === 'turn_end').at(-1)).toEqual({ kind: 'turn_end', reason: 'interrupted' })
    expect(server.turnTexts()).toEqual([['first'], ['second'], ['third']])
    await runtime.close()
  })

  it('interrupts nothing when no turn runs', async () => {
    const { runtime, server } = start()
    await flush()
    await runtime.interrupt()
    expect(server.requestsOf('turn/interrupt')).toEqual([])
    await runtime.close()
  })

  it('reports a turn the server refuses to start, and goes on with the next message', async () => {
    let refused = false
    const { runtime, events, server } = start({}, (fake) => {
      const started = (params: Record<string, unknown>) => ({ turn: { id: 'turn-x', items: [], status: 'inProgress', error: null }, params })
      fake.answer('turn/start', (params) => {
        if (!refused) { refused = true; throw new RefusedRequest(-32600, 'model not found') }
        queueMicrotask(() => fake.completeTurn())
        return started(params)
      })
    })
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    await flush()
    expect(events.filter((event) => event.kind === 'error' || event.kind === 'turn_end')).toEqual([
      { kind: 'error', message: 'model not found' }, { kind: 'turn_end', reason: 'error' }, { kind: 'turn_end', reason: 'success' },
    ])
    expect(server.turnTexts()).toEqual([['first'], ['second']])
    await runtime.close()
  })

  it('reports a failed turn with its reason', async () => {
    const { runtime, events, server } = start({}, (fake) => { fake.turnsEnd = false })
    runtime.send('m1', 'first')
    await flush()
    server.completeTurn('failed', { message: 'You have hit your usage limit.' })
    await flush()
    expect(events.slice(-2)).toEqual([{ kind: 'error', message: 'You have hit your usage limit.' }, { kind: 'turn_end', reason: 'error' }])
    await runtime.close()
  })

  it('carries a changed mode and model with the next turn only: the thread keeps them', async () => {
    const host: CodexChatHost = { writableDirs: () => ['/cockpit-home/tasks'] }
    const { runtime, events, server } = start({ mode: 'off' }, undefined, host)
    await flush()
    await expect(runtime.setMode('plan')).rejects.toThrow('Codex has no mode "plan".')
    await runtime.setMode('ask')
    await runtime.setModel('gpt-5.6-terra')
    expect(events.slice(-2)).toEqual([{ kind: 'settings', mode: 'ask' }, { kind: 'settings', model: 'gpt-5.6-terra' }])
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    await flush()
    const [first, second] = server.requestsOf('turn/start')
    // Started without a sandbox, the thread named no workspace policy: the cockpit's own folders and the network setting.
    expect(first).toEqual({
      threadId: server.threadId, input: [text('first')], clientUserMessageId: 'm1', model: 'gpt-5.6-terra',
      approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/cockpit-home/tasks'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    })
    expect(second).toEqual({ threadId: server.threadId, input: [text('second')], clientUserMessageId: 'm2' })
    await runtime.setMode('off')
    runtime.send('m3', 'third')
    await flush()
    expect(server.requestsOf('turn/start')[2]).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(server.requestsOf('turn/start')[2]).not.toHaveProperty('approvalsReviewer')
    await runtime.close()
  })

  it('goes back to the sandbox the thread started with', async () => {
    const { runtime, server } = start()
    await flush()
    await runtime.setMode('off')
    await runtime.setMode('ask')
    runtime.send('m1', 'first')
    await flush()
    expect(server.requestsOf('turn/start')[0]).toMatchObject({
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/cockpit-home/spawn-inbox', '/cockpit-home/tasks'], networkAccess: false },
    })
    await runtime.close()
  })
})

describe('the Codex chat runtime, what the bridge adds to a turn', () => {
  it('puts what the cockpit adds to a prompt before the user\'s words, as an item of its own', async () => {
    const notes = ['The cockpit: a tool was stopped.', null]
    const worker = { onPrompt: () => notes.shift() ?? null, onTurnEnding: () => null, endTurn: async () => { throw new Error('not here') }, report: () => {} }
    const { runtime, server } = start({ worker })
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    await flush()
    expect(server.requestsOf('turn/start').map((params) => params.input)).toEqual([
      [hiddenText('The cockpit: a tool was stopped.'), text('first')],
      [text('second')],
    ])
    await runtime.close()
  })

  it('sends a turn back when the bridge asks for it, and says no end for the turn it sent back', async () => {
    const asked = ['Say how this stands.', null, null]
    let endings = 0
    const worker = {
      onTurnEnding: async () => { endings += 1; return asked.shift() ?? null },
      endTurn: async () => { throw new Error('not here') }, report: () => {},
    }
    const { runtime, events, server } = start({ worker }, (fake) => { fake.turnsEnd = false })
    runtime.send('m1', 'first')
    await flush()
    // A message that came meanwhile runs after the turn that was sent back.
    runtime.send('m2', 'second')
    server.completeTurn()
    await flush()
    expect(kinds(events)).not.toContain('turn_end')
    expect(server.requestsOf('turn/start')[1]).toEqual({ threadId: server.threadId, input: [hiddenText('Say how this stands.')] })
    server.completeTurn()
    await flush()
    expect(events.filter((event) => event.kind === 'turn_end')).toEqual([{ kind: 'turn_end', reason: 'success' }])
    expect(server.turnTexts().at(-1)).toEqual(['second'])
    // An interrupted turn is not the session's stop: nobody is asked.
    await runtime.interrupt()
    await flush()
    expect(endings).toBe(2)
    expect(events.filter((event) => event.kind === 'turn_end').at(-1)).toEqual({ kind: 'turn_end', reason: 'interrupted' })
    await runtime.close()
  })
})

describe('the Codex chat runtime, approvals', () => {
  const request = recorded('turn-approval.jsonl').find((line) => line.msg.method === 'item/commandExecution/requestApproval')?.msg.params as { itemId: string }

  it('asks the user, answers the server under the request\'s id, and settles the card', async () => {
    const { runtime, events, server } = start()
    await flush()
    const id = server.ask('item/commandExecution/requestApproval', request)
    await flush()
    const card = events.find((event) => event.kind === 'permission_request')
    expect(card).toMatchObject({ requestId: `req-${id}-${request.itemId}`, toolName: 'Shell', title: 'Run printf hi > hello.txt' })
    runtime.answerPermission(`req-${id}-${request.itemId}`, { decision: 'always' })
    runtime.answerPermission(`req-${id}-${request.itemId}`, { decision: 'deny' })
    expect(server.received.filter((message) => message.method === undefined)).toEqual([
      { id, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/bash', '-lc', 'printf hi > hello.txt'] } } } },
    ])
    expect(events.at(-1)).toEqual({ kind: 'request_settled', requestId: `req-${id}-${request.itemId}`, outcome: 'always' })
    await runtime.close()
  })

  it('refuses a request it cannot put to the user', async () => {
    const { runtime, events, server } = start()
    await flush()
    const before = events.length
    const id = server.ask('item/tool/requestUserInput', { itemId: 'q1', questions: [] })
    await flush()
    expect(server.received.at(-1)).toEqual({ id, error: { code: -32601, message: 'The cockpit does not answer item/tool/requestUserInput' } })
    expect(events).toHaveLength(before)
    await runtime.close()
  })
})

describe('the Codex chat runtime, its end', () => {
  it('says why the process died, takes back what it asked, and reports the exit once', async () => {
    const { runtime, events, server } = start()
    await flush()
    server.ask('item/fileChange/requestApproval', { threadId: server.threadId, turnId: 'turn-1', itemId: 'patch-1' })
    await flush()
    server.stderr.emit('data', Buffer.from('thread main panicked\nerror: out of memory\n'))
    server.exit(101)
    await flush()
    expect(events.slice(-3)).toEqual([
      { kind: 'error', message: 'error: out of memory' },
      { kind: 'request_settled', requestId: 'req-0-patch-1', outcome: 'cancelled' },
      { kind: 'runtime_exit', expected: false },
    ])
    // Nothing reaches a process that is gone, and nothing more is said.
    runtime.send('m1', 'late')
    await runtime.close()
    await flush()
    expect(events.filter((event) => event.kind === 'runtime_exit')).toHaveLength(1)
    expect(server.requestsOf('turn/start')).toEqual([])
  })

  it('has no tool servers to manage yet, and says so', async () => {
    const { runtime } = start()
    expect(await runtime.toolServers()).toEqual([])
    await expect(runtime.setToolServerEnabled('gmail', false)).rejects.toThrow(/cannot be changed from the chat yet/)
    await expect(runtime.reconnectToolServer('gmail')).rejects.toThrow(/cannot be changed from the chat yet/)
    await expect(runtime.stopAgent('a1')).rejects.toThrow(/no subagents/)
    await runtime.close()
  })
})

describe('the Codex chat runtime, a stored conversation', () => {
  // Recorded newest first; the runtime asks for the oldest first.
  const turns = [...(recorded('history.jsonl').find((line) => line.dir === 'in')?.msg.result as { data: Turn[] }).data].reverse()
  const ref = { sessionId: 's1', providerSessionId: 'thread-9', projectPath: '/work', greeted: null }

  it('reads every page with a process of its own, oldest turn first, and ends that process', async () => {
    const { spawn, servers } = fakeSpawn((server) => {
      server.answer('thread/turns/list', ({ cursor }) => (cursor === 'page-2'
        ? { data: turns.slice(2), nextCursor: null, backwardsCursor: null }
        : { data: turns.slice(0, 2), nextCursor: 'page-2', backwardsCursor: null }))
    })
    const events = await createCodexChatRuntimes(spawn).history(ref)
    expect(events).toEqual(historyEvents(turns))
    expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(4)
    const [server] = servers
    expect(methods(server)).toEqual(['initialize', 'initialized', 'thread/turns/list', 'thread/turns/list'])
    expect(server.requestsOf('thread/turns/list')).toEqual([
      { threadId: 'thread-9', itemsView: 'full', sortDirection: 'asc', limit: 50 },
      { threadId: 'thread-9', itemsView: 'full', sortDirection: 'asc', limit: 50, cursor: 'page-2' },
    ])
    expect(server.spawned).toMatchObject({ bin: codexRuntime.bin, args: ['app-server'], env: { CODEX_HOME: CODEX_CONFIG_DIR } })
    // No session's environment: it only reads files.
    expect(Object.keys(server.spawned?.env ?? {}).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH'].filter((key) => key !== 'HOME' || process.env.HOME).sort())
    expect(server.exited).toBe(true)
  })

  it('is empty for a thread the server does not know, and starts no process for a session without one', async () => {
    const { spawn, servers } = fakeSpawn()
    const runtimes = createCodexChatRuntimes(spawn)
    expect(await runtimes.history({ ...ref, providerSessionId: null })).toEqual([{ kind: 'history_end' }])
    expect(servers).toHaveLength(0)
    expect(await runtimes.history(ref)).toEqual([{ kind: 'history_end' }])
    expect(servers[0].exited).toBe(true)
  })

  it('reports a history it could not read instead of showing an empty conversation', async () => {
    const { spawn, servers } = fakeSpawn((server) => {
      server.answer('thread/turns/list', () => { throw new RefusedRequest(-32603, 'database is locked') })
    })
    await expect(createCodexChatRuntimes(spawn).history(ref)).rejects.toThrow('database is locked')
    expect(servers[0].exited).toBe(true)
  })

  it('leaves out of a stored turn what the cockpit added for the agent alone', () => {
    const turn = {
      id: 'u1', itemsView: 'full', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      items: [
        { type: 'userMessage', id: 'i1', clientId: 'm1', content: [hiddenText('The cockpit: a tool was stopped.'), text('first')] },
        { type: 'userMessage', id: 'i2', clientId: null, content: [hiddenText('Say how this stands.')] },
      ],
    } as unknown as Turn
    expect(historyEvents([turn])).toEqual([{ kind: 'user_message', id: 'm1', text: 'first', queued: false }, { kind: 'history_end' }])
  })
})
