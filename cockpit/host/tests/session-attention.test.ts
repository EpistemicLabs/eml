import { describe, expect, it } from 'vitest'
import { attentionAfterTurn, missingReply, shouldAskForStatus, stillRunning, wasSpawned, worksAlone } from '../src/domain/session-attention.js'

describe('shouldAskForStatus', () => {
  const quiet = { alone: true, clients: 0, declared: false, asked: false }

  it('asks a session that works on its own and said nothing, once', () => {
    expect(shouldAskForStatus(quiet)).toBe(true)
    expect(shouldAskForStatus({ ...quiet, asked: true })).toBe(false)
  })

  it.each([
    ['it already said', { declared: true }],
    ['someone has it open', { clients: 1 }],
    ['it is the user\'s conversation', { alone: false }],
  ])('leaves it alone when %s', (_why, patch) => {
    expect(shouldAskForStatus({ ...quiet, ...patch })).toBe(false)
  })
})

describe('attentionAfterTurn', () => {
  const quiet = { alone: true, clients: 0, declared: false, reason: 'success' as const }

  it('unclear means someone should look', () => {
    expect(attentionAfterTurn(quiet)).toBe('review')
  })

  it('a failed turn is failed', () => {
    expect(attentionAfterTurn({ ...quiet, reason: 'error' })).toBe('failed')
  })

  it.each([
    ['it said', { declared: true }],
    ['someone has it open', { clients: 1 }],
    ['it is the user\'s conversation', { alone: false }],
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

describe('stillRunning', () => {
  it('a turn that ends while its subagents run, asking nobody, is no stop', () => {
    expect(stillRunning({ agents: 2, status: null })).toBe(true)
    expect(stillRunning({ agents: 1, status: 'done' })).toBe(true)
  })

  it('without subagents, or when it asks someone, it is a stop', () => {
    expect(stillRunning({ agents: 0, status: null })).toBe(false)
    expect(stillRunning({ agents: 1, status: 'question' })).toBe(false)
    expect(stillRunning({ agents: 1, status: 'review' })).toBe(false)
    expect(stillRunning({ agents: 1, status: 'failed' })).toBe(false)
  })
})

describe('worksAlone', () => {
  it('goes by the task: handed to an agent, the session works on its own, whoever started it', () => {
    expect(worksAlone({ delegated: true, worker: false, spawned: false })).toBe(true)
    expect(worksAlone({ delegated: true, worker: true, spawned: false })).toBe(true)
  })

  it('takes the user\'s own session on a task that is not handed over as their conversation', () => {
    expect(worksAlone({ delegated: false, worker: false, spawned: false })).toBe(false)
    expect(worksAlone({ delegated: null, worker: false, spawned: false })).toBe(false)
  })

  it('takes a runner\'s worker whose task lost its delegate as the user\'s conversation', () => {
    expect(worksAlone({ delegated: false, worker: true, spawned: false })).toBe(false)
  })

  it('keeps a worker a session or a job started on its own, also on a task that is not handed over', () => {
    expect(worksAlone({ delegated: false, worker: true, spawned: true })).toBe(true)
  })

  it('goes by how the session was started when it has no task, or the task cannot be read', () => {
    expect(worksAlone({ delegated: null, worker: true, spawned: false })).toBe(true)
    expect(worksAlone({ delegated: null, worker: true, spawned: true })).toBe(true)
  })

  it('counts a parent session or a job as having started it', () => {
    expect(wasSpawned({ parentSessionId: 's1', jobId: null })).toBe(true)
    expect(wasSpawned({ parentSessionId: null, jobId: 'j1' })).toBe(true)
    expect(wasSpawned({ parentSessionId: null, jobId: null })).toBe(false)
  })
})
