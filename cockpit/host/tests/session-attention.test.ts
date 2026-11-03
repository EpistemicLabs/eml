import { describe, expect, it } from 'vitest'
import { attentionAfterTurn, missingSummary, shouldAskForStatus } from '../src/domain/session-attention.js'

describe('shouldAskForStatus', () => {
  const quiet = { worker: true, clients: 0, declared: false, asked: false }

  it('asks a worker that said nothing, once', () => {
    expect(shouldAskForStatus(quiet)).toBe(true)
    expect(shouldAskForStatus({ ...quiet, asked: true })).toBe(false)
  })

  it.each([
    ['it already said', { declared: true }],
    ['someone has it open', { clients: 1 }],
    ['it is not a worker', { worker: false }],
  ])('leaves it alone when %s', (_why, patch) => {
    expect(shouldAskForStatus({ ...quiet, ...patch })).toBe(false)
  })
})

describe('attentionAfterTurn', () => {
  const quiet = { worker: true, clients: 0, declared: false, reason: 'success' as const }

  it('unclear means someone should look', () => {
    expect(attentionAfterTurn(quiet)).toBe('review')
  })

  it('a failed turn is failed', () => {
    expect(attentionAfterTurn({ ...quiet, reason: 'error' })).toBe('failed')
  })

  it.each([
    ['it said', { declared: true }],
    ['someone has it open', { clients: 1 }],
    ['it is not a worker', { worker: false }],
    ['it was interrupted', { reason: 'interrupted' as const }],
  ])('leaves nothing when %s', (_why, patch) => {
    expect(attentionAfterTurn({ ...quiet, ...patch })).toBeNull()
  })
})

describe('missingSummary', () => {
  it('sends a turn back that ends with only the status call', () => {
    expect(missingSummary({ status: 'done', textAfter: '', asked: false })).toBe('summary')
    expect(missingSummary({ status: 'review', textAfter: '  \n', asked: false })).toBe('summary')
  })

  it('asks for the questions when a question was declared but not asked', () => {
    expect(missingSummary({ status: 'question', textAfter: 'I need those three answers before I change anything.', asked: false })).toBe('questions')
  })

  it('lets a reply through that asks or lists its questions', () => {
    expect(missingSummary({ status: 'question', textAfter: 'Which start date?', asked: false })).toBeNull()
    expect(missingSummary({ status: 'question', textAfter: 'Open:\n1. Start date\n2. Terms', asked: false })).toBeNull()
    expect(missingSummary({ status: 'done', textAfter: 'Did X, changed Y.', asked: false })).toBeNull()
  })

  it('asks once, and not without a status', () => {
    expect(missingSummary({ status: 'done', textAfter: '', asked: true })).toBeNull()
    expect(missingSummary({ status: null, textAfter: '', asked: false })).toBeNull()
  })
})
