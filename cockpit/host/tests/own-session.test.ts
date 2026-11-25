import { describe, it, expect } from 'vitest'
import { LONG_CONTEXT_TOKENS, newSessionReason, ownSessionOf, type SessionOnTaskFacts } from '../src/domain/own-session.js'

const s = (sessionId: string, more: Partial<SessionOnTaskFacts> = {}): SessionOnTaskFacts => ({
  sessionId, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', archived: false, parentSessionId: null, jobId: null, runtime: 'sdk', contextTokens: 20_000, ...more,
})

describe('a task\'s own session', () => {
  it('is the newest open session on the task that no session or job started', () => {
    const sessions = [
      s('old'),
      s('newer', { createdAt: '2026-11-25T10:00:00.000Z' }),
      s('put-away', { createdAt: '2026-11-25T11:00:00.000Z', archived: true }),
      s('helper', { createdAt: '2026-11-25T11:00:00.000Z', parentSessionId: 'old' }),
      s('job-run', { createdAt: '2026-11-25T11:00:00.000Z', jobId: 'j1' }),
      // the conversation that created the task works on its own task
      s('creator', { createdAt: '2026-11-25T11:00:00.000Z', taskId: 't0' }),
    ]
    expect(ownSessionOf(sessions, 't1')?.sessionId).toBe('newer')
    expect(ownSessionOf([s('helper', { parentSessionId: 'x' })], 't1')).toBeNull()
  })

  it('is continued by a delegation unless there is none, it runs in a terminal, its context is very long, or the owner chose Start fresh', () => {
    expect(newSessionReason(s('a'), false)).toBeNull()
    expect(newSessionReason(s('a', { contextTokens: null }), false)).toBeNull()
    expect(newSessionReason(null, false)).toBe('no_session')
    expect(newSessionReason(s('a', { runtime: 'terminal' }), false)).toBe('terminal')
    expect(newSessionReason(s('a', { contextTokens: LONG_CONTEXT_TOKENS }), false)).toBe('long_context')
    expect(newSessionReason(s('a', { contextTokens: LONG_CONTEXT_TOKENS - 1 }), false)).toBeNull()
    expect(newSessionReason(s('a'), true)).toBe('fresh')
  })
})
