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
    expect(methods(server)).toEqual(['initialize', 'initialized', 'model/list', 'thread/start'])
    expect(server.requestsOf('initialize')[0]).toMatchObject({ clientInfo: { name: 'eml_cockpit' } })
    // Auto, the setting's default: what the terminal's arguments say for the same mode.
    expect(server.requestsOf('thread/start')).toEqual([{ cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }])
    expect(kinds(events)).toEqual(['conversation', 'capabilities', 'commands', 'settings'])
    expect(events[0]).toEqual({ kind: 'conversation', conversationId: server.threadId })
    expect(events[1]).toMatchObject({
      // Shift+Tab never lands on "no sandbox".
      modes: [{ id: 'auto' }, { id: 'ask' }, { id: 'off', cycle: false }],
      models: [
        {
          id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', resolved: 'gpt-6-luna', defaultEffort: 'medium',
          efforts: [{ id: 'low', label: 'Low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }],
        },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      ],
      features: ['stopAgent', 'toolServerReconnect', 'toolServerSignIn', 'reasoningEffort'],
    })
    expect(events[2]).toEqual({ kind: 'commands', commands: [] })
    expect(events[3]).toEqual({ kind: 'settings', model: 'gpt-6-luna', mode: 'auto', effort: null })
    await runtime.close()
  })

  it('continues the stored thread, and starts a new one when the server no longer has it', async () => {
    const resumed = start({ resume: true, conversationId: 'thread-9', model: 'gpt-5.6-terra' })
    await flush()
    expect(methods(resumed.server)).toEqual(['initialize', 'initialized', 'model/list', 'thread/resume'])
    expect(resumed.server.requestsOf('thread/resume')).toEqual([{
      threadId: 'thread-9', cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review', model: 'gpt-5.6-terra', excludeTurns: true,
    }])
    expect(resumed.events[0]).toEqual({ kind: 'conversation', conversationId: 'thread-9' })
    await resumed.runtime.close()

    const gone = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32600, 'no rollout found for thread id thread-9') })
    })
    await flush()
    expect(methods(gone.server)).toEqual(['initialize', 'initialized', 'model/list', 'thread/resume', 'thread/start'])
    expect(kinds(gone.events)).toEqual(['notice', 'conversation', 'capabilities', 'commands', 'settings'])
    expect(gone.events[1]).toEqual({ kind: 'conversation', conversationId: gone.server.threadId })
    await gone.runtime.close()
  })

  it('does not fork a conversation another process still writes to, and reports any other refused resume', async () => {
    const busy = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32600, 'thread thread-9 already has an active writer') })
    })
    await flush()
    expect(methods(busy.server)).toEqual(['initialize', 'initialized', 'model/list', 'thread/resume'])
    expect(busy.events).toEqual([{ kind: 'error', message: `Codex did not start: ${OPEN_ELSEWHERE}` }, { kind: 'runtime_exit', expected: false }])
    const odd = start({ resume: true, conversationId: 'thread-9' }, (server) => {
      server.answer('thread/resume', () => { throw new RefusedRequest(-32603, 'internal error') })
    })
    await flush()
    expect(methods(odd.server)).toEqual(['initialize', 'initialized', 'model/list', 'thread/resume'])
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

  it('refuses a request it cannot put to the user, and answers a question with nothing to ask at once', async () => {
    const { runtime, events, server } = start()
    await flush()
    const before = events.length
    const id = server.ask('mcpServer/elicitation/request', { serverName: 'x' })
    await flush()
    expect(server.received.at(-1)).toEqual({ id, error: { code: -32601, message: 'The cockpit does not answer mcpServer/elicitation/request' } })
    const empty = server.ask('item/tool/requestUserInput', { itemId: 'q1', questions: [] })
    await flush()
    expect(server.received.at(-1)).toEqual({ id: empty, result: { answers: {} } })
    expect(events).toHaveLength(before)
    await runtime.close()
  })

  it('puts the agent\'s questions to the user and answers them by their ids; a skipped card answers nothing', async () => {
    const { runtime, events, server } = start({}, (fake) => { fake.turnsEnd = false })
    runtime.send('m1', 'first')
    await flush()
    const questions = [
      { id: 'env', header: 'Target', question: 'Which environment?', isOther: true, isSecret: false, options: [{ label: 'Staging', description: 'Safe' }, { label: 'Production', description: '' }] },
      { id: 'token', header: 'Token', question: 'Your API token?', isOther: false, isSecret: true, options: null },
    ]
    const id = server.ask('item/tool/requestUserInput', { threadId: server.threadId, turnId: 'turn-1', itemId: 'call-1', questions, isBlocking: true })
    await flush()
    expect(events.at(-1)).toEqual({
      kind: 'question', requestId: `req-${id}-call-1`, questions: [
        { question: 'Which environment?', header: 'Target', multiSelect: false, options: [{ label: 'Staging', description: 'Safe' }, { label: 'Production', description: '' }] },
        { question: 'Your API token?', header: 'Token', multiSelect: false, options: [], secret: true },
      ],
    })
    runtime.answerPermission(`req-${id}-call-1`, { decision: 'answer', answers: { 'Which environment?': 'Staging', 'Your API token?': 'abc' } })
    expect(server.received.at(-1)).toEqual({ id, result: { answers: { env: { answers: ['Staging'] }, token: { answers: ['abc'] } } } })
    expect(events.at(-1)).toEqual({ kind: 'request_settled', requestId: `req-${id}-call-1`, outcome: 'answered' })

    const skipped = server.ask('item/tool/requestUserInput', { threadId: server.threadId, turnId: 'turn-1', itemId: 'call-2', questions, isBlocking: true })
    await flush()
    runtime.answerPermission(`req-${skipped}-call-2`, { decision: 'deny' })
    expect(server.received.at(-1)).toEqual({ id: skipped, result: { answers: {} } })
    // One the turn leaves open is taken back like an approval.
    server.ask('item/tool/requestUserInput', { threadId: server.threadId, turnId: 'turn-1', itemId: 'call-3', questions, isBlocking: true })
    await flush()
    server.completeTurn()
    await flush()
    expect(events).toContainEqual({ kind: 'request_settled', requestId: `req-${skipped + 1}-call-3`, outcome: 'cancelled' })
    await runtime.close()
  })

  it('refuses a call and lets the turn go on, or refuses it and stops the turn; words go to the agent another way', async () => {
    const { runtime, events, server } = start({}, (fake) => {
      fake.turnsEnd = false
      fake.answer('turn/steer', () => ({ turnId: 'turn-1' }))
    })
    runtime.send('m1', 'first')
    await flush()
    const params = (itemId: string) => ({ threadId: server.threadId, turnId: 'turn-1', itemId, command: 'rm -rf build', availableDecisions: ['accept', 'decline', 'cancel'] })
    const declined = server.ask('item/commandExecution/requestApproval', params('exec-1'))
    await flush()
    runtime.answerPermission(`req-${declined}-exec-1`, { decision: 'deny', message: 'Keep the build folder.' })
    await flush()
    expect(server.received.filter((message) => message.id === declined && message.method === undefined)).toEqual([{ id: declined, result: { decision: 'decline' } }])
    // Codex's refusal has no words: they go into the running turn.
    expect(server.requestsOf('turn/steer')).toEqual([{
      threadId: server.threadId, expectedTurnId: 'turn-1', input: [hiddenText('The user declined Run rm -rf build: Keep the build folder.')],
    }])

    const cancelled = server.ask('item/commandExecution/requestApproval', params('exec-2'))
    await flush()
    runtime.answerPermission(`req-${cancelled}-exec-2`, { decision: 'deny', interrupt: true, message: 'Stop here.' })
    await flush()
    expect(server.received.filter((message) => message.id === cancelled && message.method === undefined)).toEqual([{ id: cancelled, result: { decision: 'cancel' } }])
    // "cancel" ends the turn itself; the words wait for the next message rather than starting a turn.
    expect(server.requestsOf('turn/interrupt')).toEqual([])
    expect(server.requestsOf('turn/steer')).toHaveLength(1)
    server.completeTurn('interrupted')
    await flush()
    expect(events.filter((event) => event.kind === 'turn_end').at(-1)).toEqual({ kind: 'turn_end', reason: 'interrupted' })
    runtime.send('m2', 'next')
    await flush()
    expect(server.requestsOf('turn/start')[1]?.input).toEqual([hiddenText('The user declined Run rm -rf build: Stop here.'), text('next')])

    // A request without "cancel" (more access): refused, and the runtime stops the turn itself.
    const access = server.ask('item/permissions/requestApproval', {
      threadId: server.threadId, turnId: 'turn-2', itemId: 'perm-1', cwd: '/work', reason: null, permissions: { network: { enabled: true }, fileSystem: null },
    })
    await flush()
    runtime.answerPermission(`req-${access}-perm-1`, { decision: 'deny', interrupt: true })
    await flush()
    expect(server.received.filter((message) => message.id === access && message.method === undefined)).toEqual([{ id: access, result: { permissions: {}, scope: 'turn' } }])
    expect(server.requestsOf('turn/interrupt')).toEqual([{ threadId: server.threadId, turnId: 'turn-2' }])
    await runtime.close()
  })
})

describe('the Codex chat runtime, reasoning effort', () => {
  it('starts the thread with the session\'s effort, carries a change with the next turn, and refuses one the model does not take', async () => {
    const { runtime, events, server } = start({ effort: 'high' })
    await flush()
    expect(server.requestsOf('thread/start')[0]).toMatchObject({ config: { model_reasoning_effort: 'high' } })
    expect(events.find((event) => event.kind === 'settings')).toMatchObject({ effort: 'high' })
    await runtime.setEffort('low')
    await expect(runtime.setEffort('ultra')).rejects.toThrow('GPT-6-Luna takes no reasoning effort "ultra".')
    runtime.send('m1', 'first')
    runtime.send('m2', 'second')
    await flush()
    const [first, second] = server.requestsOf('turn/start')
    expect(first).toMatchObject({ effort: 'low' })
    expect(second).not.toHaveProperty('effort')
    // Terra takes "ultra".
    await runtime.setModel('gpt-5.6-terra')
    await runtime.setEffort('ultra')
    expect(events.at(-1)).toEqual({ kind: 'settings', effort: 'ultra' })
    // Back on a model without it, the effort gives way to that model's default.
    await runtime.setModel('gpt-6-luna')
    expect(events.at(-1)).toEqual({ kind: 'settings', model: 'gpt-6-luna', effort: 'medium' })
    await runtime.close()
  })

  it('starts with the setting when the session chose none, and leaves out one the model does not take', async () => {
    expect(codexSettings.write({ reasoningEffort: 'xhigh' })).toBeNull()
    expect(codexSettings.write({ reasoningEffort: 'Very High' })).toMatch(/reasoningEffort must be/)
    try {
      const set = start()
      await flush()
      expect(set.server.requestsOf('thread/start')[0]).toMatchObject({ config: { model_reasoning_effort: 'xhigh' } })
      await set.runtime.close()
      const unknown = start({ effort: 'ultra' })
      await flush()
      expect(unknown.server.requestsOf('thread/start')[0]).not.toHaveProperty('config')
      await unknown.runtime.close()
    } finally {
      codexSettings.write({ reasoningEffort: 'default' })
    }
  })
})

describe('the Codex chat runtime, subagents', () => {
  it('shows a subagent on its card, keeps its turns apart from the session\'s, and stops it', async () => {
    const { runtime, events, server } = start({}, (fake) => {
      fake.turnsEnd = false
      // The child's turn is the one that ends (below), not the session's.
      fake.answer('turn/interrupt', () => ({}))
    })
    runtime.send('m1', 'first')
    await flush()
    const child = 'child-thread'
    const item = { type: 'subAgentActivity', id: 'call-a', kind: 'started', agentThreadId: child, agentPath: '/root/run_tests', model: 'gpt-6-luna', reasoningEffort: 'low' }
    server.notify('item/started', { threadId: server.threadId, turnId: 'turn-1', item })
    server.notify('turn/started', { threadId: child, turn: { id: 'child-turn', items: [], status: 'inProgress', error: null } })
    server.notify('item/started', { threadId: child, turnId: 'child-turn', item: { type: 'commandExecution', id: 'exec-c', command: 'npm test', cwd: '/work', status: 'inProgress', commandActions: [] } })
    await flush()
    expect(events.slice(-4)).toEqual([
      { kind: 'tool_call', toolId: 'call-a', name: 'Agent', toolKind: 'agent', title: 'run tests', input: { agentPath: '/root/run_tests', model: 'gpt-6-luna' } },
      { kind: 'agent_task', taskId: child, toolId: 'call-a', description: 'run tests', status: 'running', background: false },
      { kind: 'agent_tool', parentToolId: 'call-a', toolId: 'exec-c', toolKind: 'execute', title: 'Run npm test', status: 'running' },
      { kind: 'agent_task', taskId: child, toolUses: 1, activity: 'Run npm test' },
    ])
    await runtime.stopAgent(child)
    expect(server.requestsOf('turn/interrupt')).toEqual([{ threadId: child, turnId: 'child-turn' }])
    // The child's turn ends; the session's goes on.
    server.notify('turn/completed', { threadId: child, turn: { id: 'child-turn', items: [], status: 'interrupted', error: null } })
    await flush()
    expect(events.slice(-2)).toEqual([
      { kind: 'agent_task', taskId: child, status: 'stopped' },
      { kind: 'tool_result', toolId: 'call-a', status: 'failed', output: 'Stopped.' },
    ])
    expect(kinds(events)).not.toContain('turn_end')
    runtime.send('m2', 'second')
    await flush()
    expect(server.requestsOf('turn/start')).toHaveLength(1)
    // A subagent that is not running is not stopped.
    await runtime.stopAgent(child)
    expect(server.requestsOf('turn/interrupt')).toHaveLength(1)
    server.completeTurn()
    await flush()
    expect(events.filter((event) => event.kind === 'turn_end')).toEqual([{ kind: 'turn_end', reason: 'success' }])
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

})

describe('the Codex chat runtime, tool servers', () => {
  const listed = recorded('subagent.jsonl').filter((line) => line.dir === 'in' && (line.msg.result as { data?: Array<{ authStatus?: unknown }> } | undefined)?.data?.[0]?.authStatus).at(-1)?.msg.result

  it('lists the thread\'s servers without address or credentials, and reconnects them by reloading their configuration', async () => {
    const { runtime, server } = start({}, (fake) => {
      fake.answer('mcpServerStatus/list', () => listed)
      fake.answer('config/mcpServer/reload', () => ({}))
    })
    await flush()
    expect(await runtime.toolServers()).toEqual([
      { name: 'codex_apps', status: 'connected', error: null, scope: null, transport: 'web', toolCount: 3 },
      { name: 'fake', status: 'connected', error: null, scope: null, transport: 'process', toolCount: 1 },
    ])
    expect(server.requestsOf('mcpServerStatus/list')).toEqual([{ threadId: server.threadId, detail: 'toolsAndAuthOnly' }])
    await runtime.reconnectToolServer('fake')
    expect(methods(server)).toContain('config/mcpServer/reload')
    await expect(runtime.setToolServerEnabled('fake', false)).rejects.toThrow(/cannot be switched on or off from the chat/)
    await runtime.close()
  })

  it('reads a server\'s state: one that wants a sign-in, one that failed, one still on its way', async () => {
    const { toolServerOf } = await import('../src/infrastructure/providers/codex/chat-runtime.js')
    const base = { name: 'notion', pluginId: null, httpOrigin: 'https://mcp.example.com', tools: {}, toolsError: null, authStatus: 'unsupported' as const }
    expect(toolServerOf({ ...base, runtimeStatus: 'authenticationRequired' }).status).toBe('needs-auth')
    expect(toolServerOf({ ...base, runtimeStatus: 'failed', authStatus: 'notLoggedIn' }).status).toBe('needs-auth')
    expect(toolServerOf({ ...base, runtimeStatus: 'failed', toolsError: 'boom' })).toMatchObject({ status: 'failed', error: 'boom' })
    expect(toolServerOf({ ...base, runtimeStatus: 'starting' }).status).toBe('pending')
    expect(toolServerOf({ ...base, runtimeStatus: null, tools: { a: {} } }).status).toBe('connected')
    expect(toolServerOf({ ...base, runtimeStatus: 'connected', pluginId: 'gmail@cockpit', httpOrigin: null })).toMatchObject({ scope: 'plugin', transport: 'process' })
  })

  it('signs in to a server over the web: the page to open, then a notice and a reload once it is done', async () => {
    const { runtime, events, server } = start({}, (fake) => {
      fake.answer('mcpServer/oauth/login', ({ name }) => {
        if (name === 'fake') throw new RefusedRequest(-32600, 'OAuth login is only supported for streamable HTTP servers.')
        return { authorizationUrl: 'https://auth.example.com/authorize?state=x', loginId: 'l1' }
      })
      fake.answer('config/mcpServer/reload', () => ({}))
    })
    await flush()
    await expect(runtime.signInToolServer('fake')).rejects.toThrow('OAuth login is only supported for streamable HTTP servers.')
    expect(await runtime.signInToolServer('notion')).toEqual({ url: 'https://auth.example.com/authorize?state=x' })
    expect(server.requestsOf('mcpServer/oauth/login').at(-1)).toEqual({ name: 'notion', threadId: server.threadId })
    server.notify('mcpServer/oauthLogin/completed', { name: 'notion', threadId: null, loginId: 'l1', success: true })
    await flush()
    expect(events.at(-1)).toEqual({ kind: 'notice', text: 'Signed in to the tool server "notion". It connects again with the next message.' })
    expect(methods(server)).toContain('config/mcpServer/reload')
    server.notify('mcpServer/oauthLogin/completed', { name: 'notion', threadId: null, success: false, error: 'access denied' })
    await flush()
    expect(events.at(-1)).toEqual({ kind: 'notice', text: 'Signing in to the tool server "notion" did not work: access denied' })
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
