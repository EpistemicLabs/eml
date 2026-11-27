import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import './setup-home.js'
import type { RuntimeEvent, SessionRuntimeStart } from '../src/domain/session-runtime.js'
import {
  HIDDEN_CLOSE, HIDDEN_OPEN, QwenEventMapper, cliArgs, createQwenChatRuntimes, historyEvents, modelsOf, startingMode, toolServersOf, toolTitle, userWords,
} from '../src/infrastructure/providers/qwen/chat-runtime.js'
import { fakeQwenSpawn } from './helpers/fake-qwen-cli.js'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'qwen-sdk', name), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

function started(over: Partial<SessionRuntimeStart> = {}) {
  const { spawn, clis } = fakeQwenSpawn()
  const events: RuntimeEvent[] = []
  const sessionId = randomUUID()
  const runtime = createQwenChatRuntimes(spawn, { configuredModel: () => 'qwen/qwen3.8-27b' }).start({
    sessionId, resume: false, conversationId: null, mode: null, model: null, cwd: '/work', env: { QWEN_HOME: '/qwen', PATH: '/usr/bin' }, address: 'a',
    launch: { bin: 'node', args: [], env: {}, keepRunning: false },
    space: { id: 'space', mcpToken: 't', files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e/config' } },
    onEvent: (event) => events.push(event),
    ...over,
  })
  return { runtime, events, cli: () => clis[0], sessionId }
}

describe('Qwen Code\'s SDK messages as chat events', () => {
  const mapper = new QwenEventMapper()
  const mapped = fixture('two-turns.jsonl').flatMap((message) => mapper.map(message as never))
  const kinds = mapped.map((event) => event.kind)

  it('streams a reply and then takes it whole under the same block', () => {
    const deltas = mapped.filter((event) => event.kind === 'text_delta')
    const texts = mapped.filter((event) => event.kind === 'text')
    expect(texts.map((event) => event.kind === 'text' && event.text)).toEqual(['Mock reply 1.', 'Running it.', 'The command printed hi.'])
    // Every text block was streamed first, under the id it is then replaced by.
    for (const text of texts) if (text.kind === 'text') expect(deltas.some((delta) => delta.kind === 'text_delta' && delta.blockId === text.blockId)).toBe(true)
  })

  it('shows the tool call with its title and its result', () => {
    expect(mapped).toContainEqual({ kind: 'tool_call', toolId: 'call_2', name: 'run_shell_command', toolKind: 'execute', title: 'Run echo hi', input: { command: 'echo hi', description: 'say hi' } })
    expect(mapped).toContainEqual({ kind: 'tool_result', toolId: 'call_2', status: 'completed', output: 'hi' })
  })

  it('ends each turn once, working in between', () => {
    expect(kinds.filter((kind) => kind === 'turn_end')).toHaveLength(2)
    expect(mapped.filter((event) => event.kind === 'activity').map((event) => event.kind === 'activity' && event.state)).toEqual(['working', 'idle', 'working', 'idle'])
    expect(mapped).toContainEqual({ kind: 'settings', model: 'mock-model', mode: 'default' })
  })

  it('a turn stopped by the user ends as interrupted', () => {
    const one = new QwenEventMapper()
    one.noteInterrupt()
    const result = fixture('two-turns.jsonl').find((message) => message.type === 'result')
    expect(one.map(result as never)).toContainEqual({ kind: 'turn_end', reason: 'interrupted' })
  })
})

describe('a stored Qwen Code conversation', () => {
  it('reads as the user\'s words, the replies and the tool rows, in order', () => {
    const events = historyEvents(fixture('chat.jsonl'))
    const shown = events.map((event) => {
      if (event.kind === 'user_message') return `user: ${event.text}`
      if (event.kind === 'text') return `agent: ${event.text}`
      if (event.kind === 'tool_call') return `call: ${event.title}`
      if (event.kind === 'tool_result') return `result: ${event.status}`
      return event.kind
    })
    expect(shown).toEqual([
      'user: hello', 'agent: Mock reply 1.',
      'user: please TOOL now', 'agent: Running it.', 'call: Run echo hi', 'result: completed', 'agent: The command printed hi.',
      'user: please WRITE it', 'agent: Running it.', 'call: Run touch made-by-agent.txt', 'result: completed', 'agent: The command printed hi.',
      'history_end',
    ])
  })

  it('leaves out what the cockpit added and Qwen Code\'s own reminders', () => {
    expect(userWords(`${HIDDEN_OPEN}\nthe task\n${HIDDEN_CLOSE}\n\nfix it`)).toBe('fix it')
    expect(userWords(`${HIDDEN_OPEN}\nonly the cockpit's\n${HIDDEN_CLOSE}`)).toBeNull()
    expect(userWords('<system-reminder>\nskills…')).toBeNull()
  })

  it('is read from the session\'s chat file in the Qwen home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cockpit-qwen-history-'))
    try {
      const chats = join(home, 'projects', '-work-project', 'chats')
      mkdirSync(chats, { recursive: true })
      writeFileSync(join(chats, 'conv-1.jsonl'), readFileSync(join(import.meta.dirname, 'fixtures', 'qwen-sdk', 'chat.jsonl')))
      const factory = createQwenChatRuntimes(undefined, {}, home)
      const events = await factory.history({ sessionId: 'conv-1', providerSessionId: 'conv-1', projectPath: '/work/project', greeted: null })
      expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(3)
      expect(events.at(-1)).toEqual({ kind: 'history_end' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the Qwen Code chat runtime', () => {
  it('starts the cockpit\'s Qwen Code with the host\'s node, in stream-json, under the session\'s id, in exactly the session\'s environment', async () => {
    const { runtime, cli, sessionId } = started()
    await flush()
    const { bin, args, env, cwd } = cli().spawned
    expect(bin).toBe(process.execPath)
    expect(args.slice(1)).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--channel=SDK', '--include-partial-messages', '--approval-mode', 'auto', '--session-id', sessionId])
    expect(env).toEqual({ QWEN_HOME: '/qwen', PATH: '/usr/bin' })
    expect(cwd).toBe('/work')
    await runtime.close()
  })

  it('resumes the stored conversation by its id, with the model and mode it ran with', () => {
    expect(cliArgs({ sessionId: 's', resume: true, conversationId: 'c', model: 'm' }, 'default', ['--sandbox', 'sandbox-exec']).slice(1))
      .toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--channel=SDK', '--include-partial-messages', '--approval-mode', 'default', '--sandbox', 'sandbox-exec', '--model', 'm', '--resume', 'c'])
  })

  it('says what can be chosen once Qwen Code is up: its modes, the model set in the settings, the context', async () => {
    const { runtime, events } = started()
    await flush()
    const capabilities = events.find((event) => event.kind === 'capabilities')
    expect(capabilities).toMatchObject({ kind: 'capabilities', features: [], models: [{ id: 'qwen/qwen3.8-27b' }] })
    expect(capabilities?.kind === 'capabilities' && capabilities.modes.map((mode) => mode.id)).toEqual(['auto', 'default', 'auto-edit', 'plan', 'yolo'])
    expect(events).toContainEqual({ kind: 'settings', mode: 'auto' })
    expect(events).toContainEqual({ kind: 'context', usedTokens: 0, maxTokens: 200_000 })
    await runtime.close()
  })

  it('puts what the cockpit adds to a worker\'s prompt before the user\'s words, unseen', async () => {
    const { runtime, cli } = started({
      worker: { onPrompt: () => 'Task context', endTurn: async () => { throw new Error('unused') }, report: () => {}, onTurnEnding: () => null },
    })
    runtime.send('m1', 'do it')
    await flush()
    expect(cli().texts).toEqual([`${HIDDEN_OPEN}\nTask context\n${HIDDEN_CLOSE}\n\ndo it`])
    await runtime.close()
  })

  it('sends a worker back before its turn counts as ended, and says no end for that turn', async () => {
    let asked = 0
    const { runtime, cli, events } = started({
      worker: { endTurn: async () => { throw new Error('unused') }, report: () => {}, onTurnEnding: () => (++asked === 1 ? 'Call end_turn first.' : null) },
    })
    runtime.send('m1', 'go')
    await flush()
    const result = fixture('two-turns.jsonl').find((message) => message.type === 'result')
    cli().send(result)
    await flush()
    expect(events.filter((event) => event.kind === 'turn_end')).toHaveLength(0)
    expect(cli().texts.at(-1)).toBe(`${HIDDEN_OPEN}\nCall end_turn first.\n${HIDDEN_CLOSE}`)
    cli().send(result)
    await flush()
    expect(events.filter((event) => event.kind === 'turn_end')).toEqual([{ kind: 'turn_end', reason: 'success' }])
    await runtime.close()
  })

  it('answers a question with the chosen labels, as Qwen Code reads them (updatedInput.answers by question index)', async () => {
    const { runtime, cli, events } = started()
    await flush()
    const input = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }
    const cliRequest = cli().ask('ask_user_question', input)
    await flush()
    const question = events.find((event) => event.kind === 'question')
    if (question?.kind !== 'question') throw new Error('no question was asked')
    expect(question.questions).toEqual(input.questions)
    runtime.answerPermission(question.requestId, { decision: 'answer', answers: { 'Which?': 'B' } })
    await flush()
    expect(cli().answers.get(cliRequest)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 0: 'B' } } })
    await runtime.close()
  })

  it('offers no "always" (Qwen Code would keep it in its settings files), and a refusal goes back with its reason', async () => {
    const { runtime, cli, events } = started()
    await flush()
    const cliRequest = cli().ask()
    await flush()
    const asked = events.find((event) => event.kind === 'permission_request')
    expect(asked).toMatchObject({ kind: 'permission_request', toolName: 'run_shell_command', title: 'Run touch x', alwaysScope: null })
    if (asked?.kind !== 'permission_request') throw new Error('no permission was asked')
    runtime.answerPermission(asked.requestId, { decision: 'deny', message: 'not now' })
    await flush()
    expect(cli().answers.get(cliRequest)).toEqual({ behavior: 'deny', message: 'not now' })
    await runtime.close()
  })

  it('lists its tool servers as the turn\'s init names them, without addresses', async () => {
    const { runtime, cli } = started()
    await flush()
    expect(await runtime.toolServers()).toEqual([])
    cli().send({ type: 'system', subtype: 'init', uuid: 'u', session_id: 's', mcp_servers: [{ name: 'eml_brain', status: 'connected' }, { name: 'cockpit', status: 'connecting' }], tools: ['read_file', 'mcp__eml_brain__eml_recall', 'mcp__eml_brain__eml_get'] })
    await flush()
    expect(await runtime.toolServers()).toEqual([
      { name: 'eml_brain', status: 'connected', error: null, scope: null, transport: null, toolCount: 2 },
      { name: 'cockpit', status: 'pending', error: null, scope: null, transport: null, toolCount: 0 },
    ])
    await runtime.close()
  })

  it('a session started without the sandbox it needs cannot switch into a sandboxed mode (macOS)', async () => {
    const { spawn } = fakeQwenSpawn()
    const events: RuntimeEvent[] = []
    const runtime = createQwenChatRuntimes(spawn, { sandboxArgs: (mode) => (mode === 'yolo' ? [] : ['--sandbox', 'sandbox-exec']) }).start({
      sessionId: randomUUID(), resume: false, conversationId: null, mode: 'yolo', model: null, cwd: '/work', env: {}, address: 'a',
      launch: { bin: 'node', args: [], env: {}, keepRunning: false },
      space: { id: 'space', mcpToken: 't', files: { mcpConfig: '/m.json', settings: '/s.json', emlConfig: '/e/config' } },
      onEvent: (event) => events.push(event),
    })
    await flush()
    await expect(runtime.setMode('auto')).rejects.toThrow(/without a sandbox/)
    await runtime.close()
  })
})

describe('Qwen Code chat helpers', () => {
  it('starts in the session\'s own mode, else in the one the settings name', () => {
    expect(startingMode('plan', 'auto')).toBe('plan')
    expect(startingMode(null, 'ask')).toBe('default')
    expect(startingMode('nonsense', 'off')).toBe('yolo')
  })

  it('names tool rows by verb and target', () => {
    expect(toolTitle('read_file', { file_path: '/a/b.ts' })).toBe('Read /a/b.ts')
    expect(toolTitle('mcp__eml_brain__eml_recall', { query: 'x' })).toBe('mcp__eml_brain__eml_recall x')
  })

  it('lists the endpoint\'s models, else the one set', () => {
    expect(modelsOf({ models: [] }, 'm1')).toEqual([{ id: 'm1', label: 'm1', description: 'Set in Settings › Models › Qwen Code', resolved: 'm1' }])
    expect(modelsOf({ models: [{ id: 'm2', label: 'Model 2' }] }, '').map((model) => model.id)).toEqual(['m2'])
  })

  it('reads tool server status in either shape', () => {
    expect(toolServersOf({ a: 'connected', b: 'disconnected', c: 'connecting' }).map((server) => server.status)).toEqual(['connected', 'failed', 'pending'])
    expect(toolServersOf([{ name: 'a', status: 'connected' }]).map((server) => server.name)).toEqual(['a'])
  })
})
