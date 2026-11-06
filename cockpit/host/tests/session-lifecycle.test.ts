import { describe, expect, it } from 'vitest'
import { chatSessionShouldStop, IDLE_MS, MAKE_ROOM_MIN_QUIET_MS, OPEN_CARD_MS, sessionToStopForRoom, terminalBusyState, WINDOW_OPEN_MS } from '../src/domain/session-lifecycle.js'

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
  const idle = { clients: 0, running: true, turnActive: false, backgroundTasks: 0, openRequests: 0, quietMs: 0, idleMs: IDLE_MS }
  const long = OPEN_CARD_MS * 10

  it('a session nobody looks at stops once quiet for the idle time, a worker or not', () => {
    expect(chatSessionShouldStop({ ...idle, quietMs: IDLE_MS - 1 })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, quietMs: IDLE_MS })).toBe(true)
  })

  it('follows the idle time from Settings', () => {
    expect(chatSessionShouldStop({ ...idle, idleMs: 3 * IDLE_MS, quietMs: 2 * IDLE_MS })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, idleMs: 3 * IDLE_MS, quietMs: 3 * IDLE_MS })).toBe(true)
  })

  it('a window open keeps it longer, but not for ever', () => {
    expect(chatSessionShouldStop({ ...idle, clients: 1, quietMs: WINDOW_OPEN_MS - 1 })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, clients: 1, quietMs: WINDOW_OPEN_MS })).toBe(true)
  })

  it('is never stopped mid-turn or with background work', () => {
    expect(chatSessionShouldStop({ ...idle, turnActive: true, quietMs: long })).toBe(false)
    expect(chatSessionShouldStop({ ...idle, backgroundTasks: 1, quietMs: long })).toBe(false)
  })

  it('an open card waits four hours, though its turn counts as active', () => {
    const card = { ...idle, turnActive: true, openRequests: 1 }
    expect(chatSessionShouldStop({ ...card, quietMs: WINDOW_OPEN_MS })).toBe(false)
    expect(chatSessionShouldStop({ ...card, quietMs: OPEN_CARD_MS })).toBe(true)
  })

  it('a crashed one is cleared at once, unless a window shows it', () => {
    expect(chatSessionShouldStop({ ...idle, running: false })).toBe(true)
    expect(chatSessionShouldStop({ ...idle, running: false, clients: 1 })).toBe(false)
  })
})

describe('sessionToStopForRoom', () => {
  const rest = { clients: 0, running: true, turnActive: false, backgroundTasks: 0, openRequests: 0, quietMs: MAKE_ROOM_MIN_QUIET_MS }

  it('picks the one quiet longest', () => {
    expect(sessionToStopForRoom([{ ...rest, sessionId: 'a' }, { ...rest, sessionId: 'b', quietMs: rest.quietMs + 1 }])).toBe('b')
  })

  it('one nobody is looking at goes before one with a window open', () => {
    expect(sessionToStopForRoom([{ ...rest, sessionId: 'open', clients: 1, quietMs: 10 * rest.quietMs }, { ...rest, sessionId: 'closed' }])).toBe('closed')
  })

  it('never one at work, waiting on a card, just finished or already gone', () => {
    expect(sessionToStopForRoom([
      { ...rest, sessionId: 'turn', turnActive: true },
      { ...rest, sessionId: 'bg', backgroundTasks: 1 },
      { ...rest, sessionId: 'card', openRequests: 1 },
      { ...rest, sessionId: 'fresh', quietMs: MAKE_ROOM_MIN_QUIET_MS - 1 },
      { ...rest, sessionId: 'gone', running: false },
    ])).toBeNull()
  })
})
