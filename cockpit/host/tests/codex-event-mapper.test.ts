import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../src/domain/session-runtime.js'
import { CodexEventMapper, historyEvents, toolTitle } from '../src/infrastructure/providers/codex/event-mapper.js'
import type { Turn } from '../src/infrastructure/providers/codex/protocol.js'

/**
 * Sessions recorded from `codex app-server` (fixtures/codex-app-server, see its README)
 * and what the chat is told of them. A recording is played as the runtime would see it:
 * the server's notifications and requests go through the mapper, and where the recording
 * answers a request, the mapper's answer for "allow" has to be the recorded one.
 */

interface Line {
  dir: 'in' | 'out'
  msg: { id?: number; method?: string; params?: unknown; result?: unknown }
}

const recorded = (name: string): Line[] => readFileSync(join(__dirname, 'fixtures', 'codex-app-server', name), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line)

/** Plays a recording; the client's own requests and their answers are not the mapper's. */
function play(mapper: CodexEventMapper, lines: Line[]): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  const asked = new Map<number, string>()
  for (const { dir, msg } of lines) {
    if (dir === 'in' && msg.method && msg.id !== undefined) {
      const request = mapper.request(msg.id, msg.method, msg.params)
      if (!request) throw new Error(`Not mapped: ${msg.method}`)
      const card = request.find((event) => event.kind === 'permission_request')
      if (card?.kind === 'permission_request') asked.set(msg.id, card.requestId)
      events.push(...request)
    } else if (dir === 'in' && msg.method) {
      events.push(...mapper.notification(msg.method, msg.params))
    } else if (dir === 'out' && !msg.method && msg.id !== undefined && asked.has(msg.id)) {
      const answer = mapper.answer(asked.get(msg.id) as string, { decision: 'allow' })
      expect(answer).toMatchObject({ id: msg.id, result: msg.result })
      events.push(...(answer?.events ?? []))
    }
  }
  return events
}

const kinds = (events: RuntimeEvent[]) => events.map((event) => event.kind)
const note = (mapper: CodexEventMapper, method: string, params: unknown) => mapper.notification(method, params)
const started = (mapper: CodexEventMapper, item: object) => note(mapper, 'item/started', { item, threadId: 't', turnId: 'u' })
const completed = (mapper: CodexEventMapper, item: object) => note(mapper, 'item/completed', { item, threadId: 't', turnId: 'u' })

const COMMAND = 'exec-43031280-5add-464a-8c20-1ed0f43818e7'
const COMMENTARY = 'msg_03b51c4809663806016b08348c8ebc87d09761aa42a77bd346'
const FINAL = 'msg_03b51c4809663806016b083491dcd487d0822e504bf2ddab4b'

describe('CodexEventMapper, a recorded turn with a command and its approval', () => {
  const events = play(new CodexEventMapper(), recorded('turn-approval.jsonl'))

  it('tells the turn in the order it ran', () => {
    expect(kinds(events)).toEqual([
      'activity',
      'notice', 'notice',
      'text_delta', 'text_delta', 'text_delta', 'text',
      'usage', 'context',
      'activity',
      'tool_call', 'permission_request', 'request_settled',
      'activity',
      'tool_result',
      'usage', 'context',
      'text_delta', 'text_delta', 'text_delta', 'text',
      'usage', 'context',
      'activity',
      'turn_end',
    ])
  })

  it('streams a message under its item id, and the complete text replaces the deltas', () => {
    const commentary = events.filter((event) => 'blockId' in event && event.blockId === COMMENTARY)
    expect(commentary).toEqual([
      { kind: 'text_delta', blockId: COMMENTARY, delta: 'I' },
      { kind: 'text_delta', blockId: COMMENTARY, delta: '’ll' },
      { kind: 'text_delta', blockId: COMMENTARY, delta: ' create' },
      { kind: 'text', blockId: COMMENTARY, text: 'I’ll create `hello.txt` in the current project directory and confirm the write.' },
    ])
    // Commentary and the final answer are both the agent's text.
    expect(events.filter((event) => event.kind === 'text').at(-1))
      .toEqual({ kind: 'text', blockId: FINAL, text: 'Created `hello.txt` in the project directory containing `hi`.' })
  })

  it('leaves the user\'s own message to the bridge, and an empty reasoning item out', () => {
    expect(events.some((event) => event.kind === 'user_message')).toBe(false)
    expect(events.some((event) => event.kind === 'thinking' || event.kind === 'thinking_delta')).toBe(false)
  })

  it('shows the command as a tool call, asks for it, and reports its end', () => {
    const input = { command: '/bin/bash -lc \'printf hi > hello.txt\'', cwd: '/workspace/project' }
    expect(events.find((event) => event.kind === 'tool_call'))
      .toEqual({ kind: 'tool_call', toolId: COMMAND, name: 'Shell', toolKind: 'execute', title: 'Run printf hi > hello.txt', input })
    expect(events.find((event) => event.kind === 'permission_request')).toEqual({
      kind: 'permission_request',
      requestId: `req-0-${COMMAND}`,
      toolId: COMMAND,
      toolName: 'Shell',
      title: 'Run printf hi > hello.txt',
      input,
      reason: 'The sandbox failed to start the command. May I retry with escalated permissions to create hello.txt in the project directory?',
      alwaysScope: 'Commands starting with `/bin/bash -lc printf hi > hello.txt`, from now on',
    })
    expect(events.find((event) => event.kind === 'request_settled')).toEqual({ kind: 'request_settled', requestId: `req-0-${COMMAND}`, outcome: 'allowed' })
    expect(events.find((event) => event.kind === 'tool_result')).toEqual({ kind: 'tool_result', toolId: COMMAND, status: 'completed', output: '' })
  })

  it('follows the thread from working to waiting and back to idle, each state once', () => {
    expect(events.filter((event) => event.kind === 'activity').map((event) => event.state)).toEqual(['working', 'waiting', 'working', 'idle'])
  })

  it('reads usage and the context from the last model request', () => {
    expect(events.filter((event) => event.kind === 'usage' || event.kind === 'context').slice(0, 4)).toEqual([
      { kind: 'usage', inputTokens: 16135, outputTokens: 70 },
      { kind: 'context', usedTokens: 16205, maxTokens: 258400 },
      { kind: 'usage', inputTokens: 16248, outputTokens: 94 },
      { kind: 'context', usedTokens: 16342, maxTokens: 258400 },
    ])
  })

  it('says once per server that a tool server did not start', () => {
    const notices = events.filter((event) => event.kind === 'notice').map((event) => event.text)
    expect(notices).toHaveLength(2)
    expect(notices[0]).toMatch(/^The tool server "cockpit" did not start: MCP client for `cockpit` failed to start/)
    expect(notices[0].length).toBeLessThan(400)
    expect(notices[1]).toMatch(/^The tool server "eml_brain" did not start: /)
  })

  it('ends the turn as a success', () => {
    expect(events.at(-1)).toEqual({ kind: 'turn_end', reason: 'success' })
  })
})

describe('CodexEventMapper, a recorded interrupt', () => {
  it('ends the turn as interrupted, without an error, and keeps what was streamed', () => {
    const events = play(new CodexEventMapper(), recorded('interrupt.jsonl'))
    expect(events.filter((event) => event.kind === 'text_delta').map((event) => event.delta).join('')).toMatch(/^1\n2/)
    expect(events.some((event) => event.kind === 'text' || event.kind === 'error')).toBe(false)
    expect(events.slice(-2)).toEqual([{ kind: 'activity', state: 'idle' }, { kind: 'turn_end', reason: 'interrupted' }])
  })
})

describe('CodexEventMapper', () => {
  it('leaves out a notification, an item kind or a request it does not know, and one without its fields', () => {
    const mapper = new CodexEventMapper()
    expect(note(mapper, 'account/rateLimits/updated', { rateLimits: { limitId: 'codex' } })).toEqual([])
    expect(note(mapper, 'some/future/notification', undefined)).toEqual([])
    expect(started(mapper, { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent' })).toEqual([])
    expect(completed(mapper, { type: 'somethingNew', id: 'n1' })).toEqual([])
    for (const method of ['item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated', 'thread/status/changed', 'turn/completed', 'error']) {
      expect(note(mapper, method, undefined)).toEqual([])
      expect(note(mapper, method, {})).toEqual([])
      expect(note(mapper, method, { item: null, turn: 'x', tokenUsage: 3, status: [] })).toEqual([])
    }
    expect(mapper.request(4, 'item/tool/requestUserInput', { itemId: 'q1' })).toBeNull()
  })

  it('streams a reasoning summary as thinking, part by part, and the complete item replaces it', () => {
    const mapper = new CodexEventMapper()
    const delta = (text: string, summaryIndex: number) => note(mapper, 'item/reasoning/summaryTextDelta', { itemId: 'rs_1', delta: text, summaryIndex })
    expect(started(mapper, { type: 'reasoning', id: 'rs_1', summary: [], content: [] })).toEqual([])
    expect(delta('Looking', 0)).toEqual([{ kind: 'thinking_delta', blockId: 'rs_1', delta: 'Looking' }])
    expect(note(mapper, 'item/reasoning/summaryPartAdded', { itemId: 'rs_1', summaryIndex: 1 })).toEqual([])
    expect(delta('Then', 1)).toEqual([{ kind: 'thinking_delta', blockId: 'rs_1', delta: '\n\nThen' }])
    expect(delta(' write', 1)).toEqual([{ kind: 'thinking_delta', blockId: 'rs_1', delta: ' write' }])
    expect(completed(mapper, { type: 'reasoning', id: 'rs_1', summary: ['Looking at it', 'Then write'], content: ['raw'] }))
      .toEqual([{ kind: 'thinking', blockId: 'rs_1', text: 'Looking at it\n\nThen write' }])
    // Without a summary the raw reasoning is what there is.
    expect(note(mapper, 'item/reasoning/textDelta', { itemId: 'rs_2', delta: 'raw', contentIndex: 0 })).toEqual([{ kind: 'thinking_delta', blockId: 'rs_2', delta: 'raw' }])
    expect(completed(mapper, { type: 'reasoning', id: 'rs_2', summary: [], content: ['raw text'] })).toEqual([{ kind: 'thinking', blockId: 'rs_2', text: 'raw text' }])
  })

  it('names an MCP tool call the way the chat knows the cockpit\'s tools', () => {
    const mapper = new CodexEventMapper()
    const call = { type: 'mcpToolCall', id: 'mcp-1', server: 'cockpit', tool: 'end_turn', status: 'inProgress', arguments: { result: 'Draft is ready' }, result: null, error: null }
    expect(started(mapper, call)).toEqual([
      { kind: 'tool_call', toolId: 'mcp-1', name: 'mcp__cockpit__end_turn', toolKind: 'other', title: 'mcp__cockpit__end_turn', input: { result: 'Draft is ready' } },
    ])
    expect(completed(mapper, { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'Recorded.' }, { type: 'image', data: '…' }], structuredContent: null } }))
      .toEqual([{ kind: 'tool_result', toolId: 'mcp-1', status: 'completed', output: 'Recorded.\n[image]' }])
    const failed = { ...call, id: 'mcp-2', server: 'eml_brain', tool: 'eml_recall', arguments: { query: 'pricing\nand more' }, status: 'failed', error: { message: 'No such engram' } }
    // A call that was never announced comes with its result.
    expect(completed(mapper, failed)).toEqual([
      { kind: 'tool_call', toolId: 'mcp-2', name: 'mcp__eml_brain__eml_recall', toolKind: 'other', title: 'mcp__eml_brain__eml_recall pricing', input: { query: 'pricing\nand more' } },
      { kind: 'tool_result', toolId: 'mcp-2', status: 'failed', output: 'No such engram' },
    ])
  })

  it('shows a command with its output, cut off when it is long, and a failed or declined one as failed', () => {
    const mapper = new CodexEventMapper()
    const command = { type: 'commandExecution', id: 'exec-1', command: 'ls -la', cwd: '/workspace/project', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null }
    expect(started(mapper, command)).toMatchObject([{ kind: 'tool_call', toolId: 'exec-1', toolKind: 'execute', title: 'Run ls -la' }])
    expect(completed(mapper, { ...command, status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 0 }))
      .toEqual([{ kind: 'tool_result', toolId: 'exec-1', status: 'completed', output: 'a\nb\n' }])
    const long = completed(mapper, { ...command, id: 'exec-2', status: 'completed', aggregatedOutput: 'x'.repeat(30_000), exitCode: 0 }).at(-1)
    expect(long).toMatchObject({ kind: 'tool_result', status: 'completed' })
    expect(long?.kind === 'tool_result' && long.output).toBe(`${'x'.repeat(20_000)}\n… (cut off)`)
    expect(completed(mapper, { ...command, id: 'exec-3', status: 'failed', aggregatedOutput: 'ls: no such file', exitCode: 2 }).at(-1))
      .toEqual({ kind: 'tool_result', toolId: 'exec-3', status: 'failed', output: 'ls: no such file' })
    expect(completed(mapper, { ...command, id: 'exec-4', status: 'declined' }).at(-1))
      .toEqual({ kind: 'tool_result', toolId: 'exec-4', status: 'failed', output: 'Declined.' })
    // Still running in a stored turn: a call without an end.
    expect(kinds(completed(mapper, { ...command, id: 'exec-5' }))).toEqual(['tool_call'])
  })

  it('shows a file change as an edit and a web search as a fetch', () => {
    const mapper = new CodexEventMapper()
    const changes = [
      { path: '/workspace/project/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
      { path: '/workspace/project/b.ts', kind: { type: 'add' }, diff: '+x' },
    ]
    expect(started(mapper, { type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' })).toEqual([
      { kind: 'tool_call', toolId: 'patch-1', name: 'Edit', toolKind: 'edit', title: 'Edit /workspace/project/a.ts and 1 more', input: { changes } },
    ])
    expect(completed(mapper, { type: 'fileChange', id: 'patch-1', changes, status: 'completed' }))
      .toEqual([{ kind: 'tool_result', toolId: 'patch-1', status: 'completed', output: '' }])
    const search = { type: 'webSearch', id: 'ws-1', query: 'vitest fake timers', action: { type: 'search', query: 'vitest fake timers', queries: null } }
    expect(started(mapper, { ...search, query: '', action: null })).toEqual([
      { kind: 'tool_call', toolId: 'ws-1', name: 'WebSearch', toolKind: 'fetch', title: 'Fetch', input: {} },
    ])
    expect(completed(mapper, search)).toEqual([{ kind: 'tool_result', toolId: 'ws-1', status: 'completed', output: 'vitest fake timers' }])
    expect(toolTitle('WebSearch', 'fetch', { url: 'https://example.com/page' })).toBe('Fetch https://example.com/page')
  })

  it('reports a compaction once, when it is done', () => {
    const mapper = new CodexEventMapper()
    expect(started(mapper, { type: 'contextCompaction', id: 'cc-1' })).toEqual([])
    expect(completed(mapper, { type: 'contextCompaction', id: 'cc-1' })).toEqual([{ kind: 'compaction' }])
  })

  it('reports a failed turn with its reason, and a retry as a notice', () => {
    const mapper = new CodexEventMapper()
    const error = { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
    expect(note(mapper, 'error', { error: { ...error, message: 'Stream disconnected' }, willRetry: true, threadId: 't', turnId: 'u' }))
      .toEqual([{ kind: 'notice', text: 'Trying again: Stream disconnected' }])
    // The turn's own end says it.
    expect(note(mapper, 'error', { error, willRetry: false, threadId: 't', turnId: 'u' })).toEqual([])
    expect(note(mapper, 'turn/completed', { threadId: 't', turn: { id: 'u', items: [], status: 'failed', error } })).toEqual([
      { kind: 'error', message: 'You have hit your usage limit.' },
      { kind: 'turn_end', reason: 'error' },
    ])
    // A failed turn that names no error keeps the one reported before it.
    note(mapper, 'error', { error, willRetry: false, threadId: 't', turnId: 'v' })
    expect(note(mapper, 'turn/completed', { threadId: 't', turn: { id: 'v', items: [], status: 'failed', error: null } })[0])
      .toEqual({ kind: 'error', message: 'You have hit your usage limit.' })
    expect(note(mapper, 'turn/completed', { threadId: 't', turn: { id: 'w', items: [], status: 'failed', error: null } })[0])
      .toEqual({ kind: 'error', message: 'The turn failed.' })
  })

  it('reads the thread\'s status as activity, and a started turn as working', () => {
    const mapper = new CodexEventMapper()
    const status = (value: object) => note(mapper, 'thread/status/changed', { threadId: 't', status: value })
    expect(note(mapper, 'turn/started', { threadId: 't', turn: { id: 'u' } })).toEqual([{ kind: 'activity', state: 'working' }])
    expect(status({ type: 'active', activeFlags: [] })).toEqual([])
    expect(status({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toEqual([{ kind: 'activity', state: 'waiting' }])
    expect(status({ type: 'systemError' })).toEqual([{ kind: 'activity', state: 'idle' }])
    expect(status({ type: 'notLoaded' })).toEqual([])
    expect(status({ type: 'idle' })).toEqual([])
  })

  it('reports no context without a known window', () => {
    const mapper = new CodexEventMapper()
    const last = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 }
    expect(note(mapper, 'thread/tokenUsage/updated', { threadId: 't', turnId: 'u', tokenUsage: { total: last, last, modelContextWindow: null } }))
      .toEqual([{ kind: 'usage', inputTokens: 100, outputTokens: 20 }])
  })
})

describe('CodexEventMapper, approvals', () => {
  const command = (extra: object = {}) => ({ threadId: 't', turnId: 'u', itemId: 'exec-1', command: 'npm test', cwd: '/workspace/project', ...extra })
  const ask = (mapper: CodexEventMapper, id: number, method: string, params: object) => {
    const card = mapper.request(id, method, params)?.[0]
    if (card?.kind !== 'permission_request') throw new Error('No permission request')
    return card
  }

  it('offers "always" only where the request does, and answers in the request\'s own words', () => {
    const mapper = new CodexEventMapper()
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }
    const cases: Array<{ offered: unknown[] | null; scope: string | null; allow: unknown; always: unknown; deny: unknown }> = [
      { offered: ['accept', amendment, 'cancel'], scope: 'Commands starting with `npm test`, from now on', allow: 'accept', always: amendment, deny: 'cancel' },
      { offered: ['accept', 'acceptForSession', amendment, 'decline', 'cancel'], scope: 'This command, for the rest of this session', allow: 'accept', always: 'acceptForSession', deny: 'decline' },
      { offered: ['accept', 'decline'], scope: null, allow: 'accept', always: 'accept', deny: 'decline' },
      // An older server names no list: what the protocol always takes.
      { offered: null, scope: 'This command, for the rest of this session', allow: 'accept', always: 'acceptForSession', deny: 'decline' },
    ]
    let id = 0
    for (const { offered, scope, allow, always, deny } of cases) {
      for (const [decision, expected] of [['allow', allow], ['always', always], ['deny', deny]] as const) {
        const card = ask(mapper, ++id, 'item/commandExecution/requestApproval', command({ availableDecisions: offered }))
        expect(card.alwaysScope).toBe(scope)
        const outcome = decision === 'deny' ? 'denied' : decision === 'always' && scope ? 'always' : 'allowed'
        expect(mapper.answer(card.requestId, { decision })).toEqual({
          id, result: { decision: expected }, events: [{ kind: 'request_settled', requestId: card.requestId, outcome }],
        })
      }
    }
  })

  it('answers each request once, and none it does not know', () => {
    const mapper = new CodexEventMapper()
    const card = ask(mapper, 1, 'item/commandExecution/requestApproval', command())
    expect(card).toMatchObject({ requestId: 'req-1-exec-1', toolId: 'exec-1', toolName: 'Shell', title: 'Run npm test', reason: null })
    // A question's answer is none for a permission.
    expect(mapper.answer(card.requestId, { decision: 'answer', answers: {} })).toBeNull()
    expect(mapper.answer(card.requestId, { decision: 'deny', message: 'Not now' })).not.toBeNull()
    expect(mapper.answer(card.requestId, { decision: 'allow' })).toBeNull()
    expect(mapper.answer('req-9-nothing', { decision: 'allow' })).toBeNull()
  })

  it('asks for a file change with what the item said it changes', () => {
    const mapper = new CodexEventMapper()
    const changes = [{ path: '/workspace/project/a.ts', kind: { type: 'add' }, diff: '+x' }]
    started(mapper, { type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' })
    const card = ask(mapper, 2, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'patch-1', reason: 'Outside the workspace' })
    expect(card).toEqual({
      kind: 'permission_request', requestId: 'req-2-patch-1', toolId: 'patch-1', toolName: 'Edit', title: 'Edit /workspace/project/a.ts',
      input: { changes }, reason: 'Outside the workspace', alwaysScope: 'These files, for the rest of this session',
    })
    expect(mapper.answer(card.requestId, { decision: 'always' })).toMatchObject({ result: { decision: 'acceptForSession' } })
    const again = ask(mapper, 3, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'patch-1' })
    expect(mapper.answer(again.requestId, { decision: 'deny' })).toMatchObject({ result: { decision: 'decline' } })
  })

  it('grants more access as it was asked for: for the turn, for the session, or not at all', () => {
    const mapper = new CodexEventMapper()
    const permissions = { network: { enabled: true }, fileSystem: null }
    const params = { threadId: 't', turnId: 'u', itemId: 'perm-1', cwd: '/workspace/project', reason: 'Needs to download', permissions }
    const card = ask(mapper, 5, 'item/permissions/requestApproval', params)
    expect(card).toEqual({
      kind: 'permission_request', requestId: 'req-5-perm-1', toolId: 'perm-1', toolName: 'Permissions', title: 'Allow network access',
      input: { permissions }, reason: 'Needs to download', alwaysScope: 'The same access, for the rest of this session',
    })
    expect(mapper.answer(card.requestId, { decision: 'allow' })?.result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(mapper.answer(ask(mapper, 6, 'item/permissions/requestApproval', params).requestId, { decision: 'always' })?.result)
      .toEqual({ permissions: { network: { enabled: true } }, scope: 'session' })
    expect(mapper.answer(ask(mapper, 7, 'item/permissions/requestApproval', params).requestId, { decision: 'deny' })?.result)
      .toEqual({ permissions: {}, scope: 'turn' })
    const files = { network: null, fileSystem: { read: null, write: ['/workspace/other'] } }
    expect(ask(mapper, 8, 'item/permissions/requestApproval', { ...params, permissions: files }).title).toBe('Allow writing to /workspace/other')
  })

  it('settles as cancelled what the server takes back, what a turn leaves open, and what a close finds', () => {
    const mapper = new CodexEventMapper()
    const first = ask(mapper, 1, 'item/commandExecution/requestApproval', command())
    expect(note(mapper, 'serverRequest/resolved', { threadId: 't', requestId: 1 })).toEqual([{ kind: 'request_settled', requestId: first.requestId, outcome: 'cancelled' }])
    expect(mapper.answer(first.requestId, { decision: 'allow' })).toBeNull()
    const second = ask(mapper, 2, 'item/commandExecution/requestApproval', command())
    expect(note(mapper, 'turn/completed', { threadId: 't', turn: { id: 'u', items: [], status: 'interrupted', error: null } })).toEqual([
      { kind: 'request_settled', requestId: second.requestId, outcome: 'cancelled' },
      { kind: 'turn_end', reason: 'interrupted' },
    ])
    const third = ask(mapper, 3, 'item/commandExecution/requestApproval', command())
    expect(mapper.cancelOpenRequests()).toEqual([{ kind: 'request_settled', requestId: third.requestId, outcome: 'cancelled' }])
    expect(mapper.cancelOpenRequests()).toEqual([])
  })
})

describe('historyEvents, a recorded thread/turns/list', () => {
  const page = recorded('history.jsonl').find((line) => line.dir === 'in')?.msg.result as { data: Turn[] }
  // Recorded newest first, the server's default.
  const events = historyEvents([...page.data].reverse())

  it('tells the stored conversation as a live run would have, oldest first, and ends it', () => {
    expect(kinds(events)).toEqual([
      'user_message', 'text', 'tool_call', 'tool_result', 'text',
      'user_message', 'text',
      'user_message',
      'user_message', 'text',
      'history_end',
    ])
    expect(events.slice(0, 5)).toEqual([
      {
        kind: 'user_message', id: '01a2180d-411c-74a0-a01d-86d3e5d5c9df', queued: false,
        text: 'Create a file hello.txt containing hi, then tell me in one sentence what you did. If the sandbox fails to start the command, retry it with escalated permissions.',
      },
      { kind: 'text', blockId: COMMENTARY, text: 'I’ll create `hello.txt` in the current project directory and confirm the write.' },
      {
        kind: 'tool_call', toolId: COMMAND, name: 'Shell', toolKind: 'execute', title: 'Run printf hi > hello.txt',
        input: { command: '/bin/bash -lc \'printf hi > hello.txt\'', cwd: '/workspace/project' },
      },
      { kind: 'tool_result', toolId: COMMAND, status: 'completed', output: '' },
      { kind: 'text', blockId: FINAL, text: 'Created `hello.txt` in the project directory containing `hi`.' },
    ])
  })

  it('keeps of an interrupted turn what the thread kept: the user\'s message', () => {
    expect(events[7]).toMatchObject({ kind: 'user_message', text: 'Count slowly from 1 to 200, one number per line.', queued: false })
  })

  it('takes a message under the id it was sent with, counts its images, and says why a turn failed', () => {
    const turn = {
      id: 'u1', itemsView: 'full', status: 'failed', startedAt: 1, completedAt: 2, durationMs: 1,
      error: { message: 'The model is overloaded.', codexErrorInfo: 'serverOverloaded', additionalDetails: null },
      items: [
        {
          type: 'userMessage', id: 'item-1', clientId: 'sent-1',
          content: [{ type: 'text', text: 'Look', text_elements: [] }, { type: 'localImage', path: '/tmp/a.png' }, { type: 'text', text: 'here', text_elements: [] }],
        },
        { type: 'reasoning', id: 'rs_1', summary: ['Thinking it over'], content: [] },
        { type: 'hookPrompt', id: 'h1', fragments: [] },
        { type: 'contextCompaction', id: 'cc-1' },
      ],
    } as unknown as Turn
    expect(historyEvents([turn])).toEqual([
      { kind: 'user_message', id: 'sent-1', text: 'Look\nhere', queued: false, images: [{ url: null }] },
      { kind: 'thinking', blockId: 'rs_1', text: 'Thinking it over' },
      { kind: 'compaction' },
      { kind: 'error', message: 'The model is overloaded.' },
      { kind: 'history_end' },
    ])
    expect(historyEvents([])).toEqual([{ kind: 'history_end' }])
  })
})
