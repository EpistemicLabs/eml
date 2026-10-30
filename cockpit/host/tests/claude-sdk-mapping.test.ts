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
