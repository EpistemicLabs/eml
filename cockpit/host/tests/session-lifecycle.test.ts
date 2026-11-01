import { describe, expect, it } from 'vitest'
import { terminalBusyState } from '../src/domain/session-lifecycle.js'

describe('terminalBusyState', () => {
  const base = { running: true, turn: null, promptAt: null }

  it('is free without a process, whatever the turn says', () => {
    expect(terminalBusyState({ ...base, running: false, turn: { state: 'working', since: 1 }, promptAt: 1 })).toBeNull()
  })

  it('follows the turn', () => {
    expect(terminalBusyState({ ...base, turn: { state: 'working', since: 1 } })).toBe('working')
    expect(terminalBusyState({ ...base, turn: { state: 'waiting', since: 1 } })).toBe('waiting')
    expect(terminalBusyState({ ...base, turn: { state: 'done', since: 1 } })).toBeNull()
  })

  it('is free for a session started without a prompt and no turn yet', () => {
    expect(terminalBusyState(base)).toBeNull()
  })

  it('a session booting with its prompt is working before its first hook', () => {
    expect(terminalBusyState({ ...base, promptAt: 5 })).toBe('working')
  })

  it('a turn from before the prompted start says nothing about it', () => {
    expect(terminalBusyState({ ...base, promptAt: 5, turn: { state: 'done', since: 4 } })).toBe('working')
  })

  it('is free once the prompted turn is done', () => {
    expect(terminalBusyState({ ...base, promptAt: 5, turn: { state: 'done', since: 6 } })).toBeNull()
  })
})
