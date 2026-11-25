import { describe, expect, it } from 'vitest'
import { attentionAfterTurn, missingReply, shouldAskForStatus, stillRunning } from '../src/domain/session-attention.js'

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

describe('missingReply', () => {
  it('names the reply when the turn ends with only the call', () => {
    expect(missingReply({ clients: 0, called: true, questions: false, reply: '' })).toEqual(['reply'])
    expect(missingReply({ clients: 0, called: true, questions: false, reply: '  \n' })).toEqual(['reply'])
  })

  it('names the questions when the call has some and the reply does not ask', () => {
    expect(missingReply({ clients: 0, called: true, questions: true, reply: 'I need those three answers before I change anything.' })).toEqual(['questions'])
  })

  it('names both when a call with questions has no reply at all', () => {
    expect(missingReply({ clients: 0, called: true, questions: true, reply: '' })).toEqual(['reply', 'questions'])
  })

  it('lets a reply through that asks or lists its questions', () => {
    expect(missingReply({ clients: 0, called: true, questions: true, reply: 'Which start date?' })).toEqual([])
    expect(missingReply({ clients: 0, called: true, questions: true, reply: 'Open:\n1. Start date\n2. Terms' })).toEqual([])
    expect(missingReply({ clients: 0, called: true, questions: false, reply: 'Did X, changed Y.' })).toEqual([])
  })

  it('names unasked questions only while nobody has the session open, a missing reply always', () => {
    expect(missingReply({ clients: 1, called: true, questions: true, reply: 'I need those three answers before I change anything.' })).toEqual([])
    expect(missingReply({ clients: 1, called: true, questions: true, reply: '' })).toEqual(['reply'])
    expect(missingReply({ clients: 2, called: true, questions: false, reply: '' })).toEqual(['reply'])
  })

  it('names nothing without a call', () => {
    expect(missingReply({ clients: 0, called: false, questions: false, reply: '' })).toEqual([])
  })
})
