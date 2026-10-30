import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEventMapper, historyEvents, toolTitle } from '../src/infrastructure/providers/claude/sdk-runtime.js'

const sdk = (message: unknown) => message as SDKMessage
const stream = (event: unknown) => sdk({ type: 'stream_event', parent_tool_use_id: null, event })
const assistant = (id: string, content: unknown[], extra: object = {}) => sdk({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { id, content }, ...extra })
const success = sdk({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 2 } })

describe('ClaudeEventMapper', () => {
  it('a complete block takes over the id its deltas ran under, per block of one message', () => {
    const mapper = new ClaudeEventMapper()
    mapper.map(stream({ type: 'message_start', message: { id: 'm1' } }))
    mapper.map(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
    mapper.map(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }))
    expect(mapper.map(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'b' } })))
      .toEqual([{ kind: 'text_delta', blockId: 'm1:1', delta: 'b' }])
    const first = mapper.map(assistant('m1', [{ type: 'text', text: 'A' }])).filter((e) => e.kind === 'text')
    const second = mapper.map(assistant('m1', [{ type: 'text', text: 'B' }])).filter((e) => e.kind === 'text')
    expect(first).toEqual([{ kind: 'text', blockId: 'm1:0', text: 'A' }])
    expect(second).toEqual([{ kind: 'text', blockId: 'm1:1', text: 'B' }])
  })

  it('pairs tool calls and results by id, and an async launch is not a finish', () => {
    const mapper = new ClaudeEventMapper()
    expect(mapper.map(assistant('m', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls\n-l' } }])))
      .toContainEqual({ kind: 'tool_call', toolId: 't1', name: 'Bash', toolKind: 'execute', title: 'Run ls', input: { command: 'ls\n-l' } })
    const result = (extra: object, block: object = {}) => mapper.map(sdk({
      type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done', ...block }] }, ...extra,
    }))
    expect(result({})).toEqual([{ kind: 'tool_result', toolId: 't1', status: 'completed', output: 'done' }])
    expect(result({ tool_use_result: { status: 'async_launched' } })[0]).toMatchObject({ status: 'launched' })
    expect(result({}, { is_error: true })[0]).toMatchObject({ status: 'failed' })
  })

  it('leaves a subagent\'s own stream out', () => {
    const mapper = new ClaudeEventMapper()
    expect(mapper.map(assistant('m', [{ type: 'text', text: 'inner' }], { parent_tool_use_id: 't' }))).toEqual([])
  })

  it('shows a local command\'s answer but not the CLI\'s placeholder', () => {
    const mapper = new ClaudeEventMapper()
    const synthetic = (text: string) => assistant('m', [{ type: 'text', text }], { message: { id: 'm', model: '<synthetic>', content: [{ type: 'text', text }] } })
    expect(mapper.map(synthetic('## Context Usage'))).toContainEqual(expect.objectContaining({ kind: 'text', text: '## Context Usage' }))
    expect(mapper.map(synthetic('No response requested.'))).toEqual([])
  })

  it('reports the mode and model from init and from a status change', () => {
    const mapper = new ClaudeEventMapper()
    expect(mapper.map(sdk({ type: 'system', subtype: 'init', model: 'm1', permissionMode: 'auto' }))).toEqual([{ kind: 'settings', model: 'm1', mode: 'auto' }])
    expect(mapper.map(sdk({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }))).toEqual([{ kind: 'settings', mode: 'plan' }])
    expect(mapper.map(sdk({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([])
  })

  it('follows a subagent from start to end, with its tool calls under the call that started it', () => {
    const mapper = new ClaudeEventMapper()
    const system = (subtype: string, extra: object) => mapper.map(sdk({ type: 'system', subtype, task_id: 'a1', ...extra }))
    const usage = { total_tokens: 100, tool_uses: 2, duration_ms: 3000 }
    expect(system('task_started', { tool_use_id: 't1', description: 'Look', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: false })).toEqual([
      { kind: 'agent_task', taskId: 'a1', toolId: 't1', description: 'Look', agentType: 'Explore', status: 'running', background: false },
    ])
    expect(system('task_progress', { description: 'Reading', usage })).toEqual([
      { kind: 'agent_task', taskId: 'a1', activity: 'Reading', tokens: 100, toolUses: 2, durationMs: 3000 },
    ])
    expect(mapper.map(assistant('m', [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: {} },
    ], { parent_tool_use_id: 't1' }))).toEqual([
      { kind: 'agent_tool', parentToolId: 't1', toolId: 'r1', toolKind: 'read', title: 'Read /x', status: 'running' },
    ])
    expect(mapper.map(sdk({ type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }] } }))).toEqual([
      { kind: 'agent_tool', parentToolId: 't1', toolId: 'r1', status: 'completed' },
    ])
    expect(system('task_updated', { patch: { status: 'killed' } })).toEqual([{ kind: 'agent_task', taskId: 'a1', status: 'stopped' }])
    expect(system('task_notification', { status: 'completed', usage })).toEqual([
      { kind: 'agent_task', taskId: 'a1', status: 'completed', tokens: 100, toolUses: 2, durationMs: 3000 },
    ])
  })

  it('leaves other tasks out, and takes a subagent\'s report as its result', () => {
    const mapper = new ClaudeEventMapper()
    expect(mapper.map(sdk({ type: 'system', subtype: 'task_started', task_id: 'b', task_type: 'local_bash', description: 'x' }))).toEqual([])
    expect(mapper.map(sdk({ type: 'system', subtype: 'task_updated', task_id: 'b', patch: { status: 'completed' } }))).toEqual([])
    expect(mapper.map(sdk({
      type: 'user', parent_tool_use_id: null, tool_use_result: { handbackReport: { text: 'the report' } },
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'delivered' }] },
    }))).toEqual([{ kind: 'tool_result', toolId: 't', status: 'completed', output: 'the report' }])
  })

  it('reports a cleared conversation', () => {
    const mapper = new ClaudeEventMapper()
    const init = (session_id: string) => mapper.map(sdk({ type: 'system', subtype: 'init', session_id, model: 'm', permissionMode: 'default' })).map((e) => e.kind)
    expect(init('c1')).toEqual(['settings'])
    expect(init('c1')).toEqual(['settings'])
    expect(mapper.map(sdk({ type: 'conversation_reset', new_conversation_id: 'not-the-transcript' }))).toEqual([])
    expect(init('c2')).toEqual(['conversation_reset', 'settings'])
  })

  it('ends an interrupted turn as interrupted, whatever the result says', () => {
    const mapper = new ClaudeEventMapper()
    mapper.noteInterrupt()
    const events = mapper.map(sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 0, output_tokens: 0 } }))
    expect(events).toContainEqual({ kind: 'turn_end', reason: 'interrupted' })
    expect(events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('reports a failed turn with its reason', () => {
    const mapper = new ClaudeEventMapper()
    const events = mapper.map(sdk({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], usage: { input_tokens: 0, output_tokens: 0 } }))
    expect(events).toContainEqual({ kind: 'error', message: 'too many' })
    expect(events).toContainEqual({ kind: 'turn_end', reason: 'error' })
  })

  it('goes idle at a result without session-state messages, and defers to them once they come', () => {
    const plain = new ClaudeEventMapper()
    expect(plain.map(success)).toContainEqual({ kind: 'activity', state: 'idle' })
    const stateful = new ClaudeEventMapper()
    expect(stateful.map(sdk({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' })))
      .toEqual([{ kind: 'activity', state: 'waiting' }])
    expect(stateful.map(success).some((e) => e.kind === 'activity')).toBe(false)
  })
})

describe('historyEvents', () => {
  it('turns a transcript into events and leaves out what the CLI wrote as the user', () => {
    const events = historyEvents([
      { type: 'user', uuid: 'u0', parent_tool_use_id: null, message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/x' } }] } },
      { type: 'user', uuid: 'u2', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'data' }] } },
      { type: 'user', uuid: 'u3', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'assistant', uuid: 'a3', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      { type: 'assistant', uuid: 'a2', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'inner' }] } },
    ])
    expect(events.map((e) => e.kind)).toEqual(['user_message', 'text', 'tool_call', 'tool_result', 'history_end'])
  })
})

describe('toolTitle', () => {
  it('is one line of verb and target', () => {
    expect(toolTitle('Read', { file_path: '/a/b' })).toBe('Read /a/b')
    expect(toolTitle('mcp__x__y', {})).toBe('mcp__x__y')
  })
})
