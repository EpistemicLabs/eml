import { describe, expect, it } from 'vitest'
import { planArchive, type ArchiveFacts } from '../src/application/archive-session.js'
import { needsAnswer } from '../src/domain/session-attention.js'

const session = (sessionId: string, patch: Partial<ArchiveFacts> = {}): ArchiveFacts => ({
  sessionId, parentSessionId: null, working: false, needsAnswer: false, ...patch,
})

describe('planArchive', () => {
  it('takes finished workers along, all the way down', () => {
    const plan = planArchive('p', [
      session('p'), session('a', { parentSessionId: 'p' }), session('b', { parentSessionId: 'a' }), session('other'),
    ])
    expect(plan).toEqual({ archive: ['p', 'a', 'b'] })
  })

  it('waits while it or a worker works', () => {
    expect(planArchive('p', [session('p', { working: true })])).toEqual({ blockedBy: 'p', reason: 'working' })
    expect(planArchive('p', [session('p'), session('a', { parentSessionId: 'p', working: true })])).toEqual({ blockedBy: 'a', reason: 'working' })
  })

  it('will not drop a worker\'s open question, but may drop its own', () => {
    expect(planArchive('p', [session('p'), session('a', { parentSessionId: 'p', needsAnswer: true })])).toEqual({ blockedBy: 'a', reason: 'needs-answer' })
    expect(planArchive('p', [session('p', { needsAnswer: true })])).toEqual({ archive: ['p'] })
  })

  it('survives a parent loop', () => {
    expect(planArchive('a', [session('a', { parentSessionId: 'b' }), session('b', { parentSessionId: 'a' })])).toEqual({ archive: ['a', 'b'] })
  })
})

describe('needsAnswer', () => {
  it('holds for what only a person can settle', () => {
    expect(['question', 'failed', 'review', 'done'].filter((kind) => needsAnswer(kind as 'done'))).toEqual(['question', 'failed'])
  })
})
