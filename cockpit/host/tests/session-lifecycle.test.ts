import { describe, expect, it } from 'vitest'
import { chatSessionShouldStop, CLOSED_WINDOW_MS, terminalBusyState, UNATTENDED_MS } from '../src/domain/session-lifecycle.js'

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

describe('chatSessionShouldStop', () => {
  const idle = { clients: 0, running: true, turnActive: false, backgroundTasks: 0, openRequests: 0, worker: false, quietMs: 0 }
  const long = UNATTENDED_MS * 10

  it('a window keeps it running, however long it is quiet', () => {
    expect(chatSessionShouldStop({ ...idle, clients: 1, quietMs: long })).toBe(false)
  })

  it('a session of the user stops 30 minutes after its last activity', () => {
    expect(chatSessionShouldStop({ ...idle, quietMs: CLOSED_WINDOW_MS - 1 })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, quietMs: CLOSED_WINDOW_MS })).toBe(true)
  })

  it('a worker stays up to 24 hours', () => {
    expect(chatSessionShouldStop({ ...idle, worker: true, quietMs: CLOSED_WINDOW_MS })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, worker: true, quietMs: UNATTENDED_MS })).toBe(true)
  })

  it('is never stopped mid-turn or with background work', () => {
    expect(chatSessionShouldStop({ ...idle, turnActive: true, quietMs: long })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, backgroundTasks: 1, quietMs: long })).toBe(false)
  })

  it('an open card waits 24 hours, though its turn counts as active', () => {
    const card = { ...idle, turnActive: true, openRequests: 1 }
    expect(chatSessionShouldStop({ ...card, quietMs: CLOSED_WINDOW_MS })).toBe(false)
    expect(chatSessionShouldStop({ ...card, quietMs: UNATTENDED_MS })).toBe(true)
  })

  it('a crashed one is cleared at once, unless a window shows it', () => {
    expect(chatSessionShouldStop({ ...idle, running: false })).toBe(true)
    expect(chatSessionShouldStop({ ...idle, running: false, clients: 1 })).toBe(false)
  })
})
