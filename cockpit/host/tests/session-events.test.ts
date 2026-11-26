import { describe, expect, it } from 'vitest'
import { InMemoryEventStore } from '../src/application/session-events.js'

describe('InMemoryEventStore', () => {
  it('numbers events and serves what comes after n', () => {
    const store = new InMemoryEventStore()
    store.append('a', { kind: 'compaction' })
    const second = store.append('a', { kind: 'history_end' })
    expect(second.seq).toBe(2)
    expect(store.after('a', 1)).toEqual([second])
  })

  it('keeps sessions apart', () => {
    const store = new InMemoryEventStore()
    store.append('a', { kind: 'compaction' })
    expect(store.after('b', 0)).toEqual([])
  })

  it('a final block takes the place of its deltas, for a client that comes later', () => {
    const store = new InMemoryEventStore()
    store.append('a', { kind: 'text_delta', blockId: 'x', delta: 'par' })
    store.append('a', { kind: 'text_delta', blockId: 'y', delta: 'other' })
    store.append('a', { kind: 'text', blockId: 'x', text: 'partial' })
    expect(store.after('a', 0).map(({ event }) => event.kind)).toEqual(['text_delta', 'text'])
  })

  it('a call\'s result takes the place of the output that streamed of it', () => {
    const store = new InMemoryEventStore()
    store.append('a', { kind: 'tool_call', toolId: 't1', name: 'Shell', toolKind: 'execute', title: 'Run ls', input: {} })
    store.append('a', { kind: 'tool_output_delta', toolId: 't1', delta: 'a\n' })
    store.append('a', { kind: 'tool_output_delta', toolId: 't2', delta: 'other' })
    store.append('a', { kind: 'tool_result', toolId: 't1', status: 'completed', output: 'a\nb\n' })
    expect(store.after('a', 0).map(({ event }) => event.kind)).toEqual(['tool_call', 'tool_output_delta', 'tool_result'])
  })

  it('a reset starts a new epoch with numbers from 1', () => {
    const store = new InMemoryEventStore()
    store.append('a', { kind: 'compaction' })
    const before = store.epoch('a')
    const after = store.reset('a')
    expect(after).not.toBe(before)
    expect(store.append('a', { kind: 'compaction' }).seq).toBe(1)
  })
})
