import { describe, expect, it } from 'vitest'
import { attentionAfterTurn, shouldAskForStatus } from '../src/domain/session-attention.js'

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
