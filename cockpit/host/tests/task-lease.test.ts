import { describe, it, expect } from 'vitest'
import { decideAdd, holderName, leaseHolder, leaseSessionOf, pendingHolder, routeToHolder, sessionHolder, staleRunnerRequest, takesLease, type LeaseSession } from '../src/domain/task-lease.js'
import { LONG_CONTEXT_TOKENS } from '../src/domain/own-session.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'

// One live session per task: who holds a task's lease, and what each way of starting a session does when it is held.

type Req = Pick<SpawnRequest, 'id' | 'taskId' | 'origin' | 'jobId' | 'createdAt'>
const req = (id: string, more: Partial<Req> = {}): Req => ({ id, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', ...more })
const s = (sessionId: string, more: Partial<LeaseSession & { parentSessionId: string | null }> = {}) => ({
  sessionId, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', archived: false, jobId: null, parentSessionId: null, ...more,
})

describe('the task lease', () => {
  it('is taken by a request bound to a task, never by a scheduled run', () => {
    expect(takesLease({ taskId: 't1', origin: 'runner' })).toBe(true)
    expect(takesLease({ taskId: 't1' })).toBe(true)
    expect(takesLease({ taskId: 't1', origin: 'job', jobId: 't1' })).toBe(false)
    expect(takesLease({ taskId: 't1', jobId: 't1' })).toBe(false)
    expect(takesLease({ origin: 'task' })).toBe(false)
  })

  it('is held by the oldest pending request on the task', () => {
    const pending = [req('newer', { createdAt: '2026-11-25T10:00:00.000Z' }), req('older'), req('job', { origin: 'job', jobId: 't1', createdAt: '2026-11-25T08:00:00.000Z' }), req('other', { taskId: 't2' })]
    expect(pendingHolder(pending, 't1')?.id).toBe('older')
    expect(pendingHolder(pending, 't3')).toBeNull()
  })

  it('is held by the newest session on the task that is not put away and not a scheduled run, helpers included', () => {
    const sessions = [
      s('old'),
      s('helper', { createdAt: '2026-11-25T10:00:00.000Z', parentSessionId: 'old' }),
      s('put-away', { createdAt: '2026-11-25T11:00:00.000Z', archived: true }),
      s('job-run', { createdAt: '2026-11-25T11:00:00.000Z', jobId: 'j1' }),
      s('elsewhere', { createdAt: '2026-11-25T11:00:00.000Z', taskId: 't2' }),
    ]
    expect(sessionHolder(sessions, 't1')?.sessionId).toBe('helper')
    expect(sessionHolder([s('job-run', { jobId: 'j1' })], 't1')).toBeNull()
  })

  it('reads the ledger\'s entries: one with an archivedAt is put away', () => {
    const entry = (sessionId: string, more: Record<string, unknown> = {}) => ({ sessionId, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', archivedAt: null, jobId: null, ...more })
    expect(leaseSessionOf([entry('open'), entry('gone', { createdAt: '2026-11-25T10:00:00.000Z', archivedAt: '2026-11-25T11:00:00.000Z' })], 't1')?.sessionId).toBe('open')
    expect(leaseSessionOf([entry('gone', { archivedAt: '2026-11-25T11:00:00.000Z' })], 't1')).toBeNull()
  })

  it('names a holder by the user\'s title, else the agent\'s, else its id', () => {
    expect(holderName({ sessionId: 's1', title: 'Mine', agentTitle: 'Agent\'s' })).toBe('Mine')
    expect(holderName({ sessionId: 's1', title: null, agentTitle: 'Agent\'s' })).toBe('Agent\'s')
    expect(holderName({ sessionId: 's1' })).toBe('s1')
  })

  it('goes to a pending request before a session', () => {
    expect(leaseHolder([req('r1')], [s('a')], 't1')).toEqual({ kind: 'request', request: req('r1') })
    expect(leaseHolder([], [s('a')], 't1')).toMatchObject({ kind: 'session', session: { sessionId: 'a' } })
    expect(leaseHolder([], [], 't1')).toBeNull()
  })
})

describe('a new request against the pending ones', () => {
  it('a runner request for a task with one pending gets that one back', () => {
    const pending = [req('own', { origin: 'task' })]
    expect(decideAdd({ taskId: 't1', origin: 'runner' }, pending)).toEqual({ kind: 'use_existing', existing: pending[0] })
    expect(decideAdd({ taskId: 't1', origin: 'runner' }, [req('r1', { origin: 'runner' })])).toMatchObject({ kind: 'use_existing', existing: { id: 'r1' } })
    expect(decideAdd({ taskId: 't1', origin: 'runner' }, [req('x', { taskId: 't2', origin: 'runner' })])).toEqual({ kind: 'add', revoke: [] })
  })

  it('the user\'s own start supersedes a pending runner request, and a second own start uses the first', () => {
    const runner = req('r1', { origin: 'runner' })
    expect(decideAdd({ taskId: 't1', origin: 'task' }, [runner])).toEqual({ kind: 'add', revoke: [runner] })
    expect(decideAdd({ taskId: 't1', origin: 'split' }, [runner])).toEqual({ kind: 'add', revoke: [runner] })
    const own = req('own', { origin: 'task' })
    expect(decideAdd({ taskId: 't1', origin: 'task' }, [own, runner])).toEqual({ kind: 'use_existing', existing: own })
  })

  it('leaves requests without a task and scheduled runs alone', () => {
    const runner = req('r1', { origin: 'runner' })
    expect(decideAdd({ origin: 'task' }, [runner])).toEqual({ kind: 'add', revoke: [] })
    expect(decideAdd({ taskId: 't1', origin: 'job', jobId: 't1' }, [runner])).toEqual({ kind: 'add', revoke: [] })
  })
})

describe('fencing a queued runner request', () => {
  const runner = req('r1', { origin: 'runner', createdAt: '2026-11-25T10:00:00.000Z' })
  const quiet = { together: false, held: false, session: null }

  it('lets it start when nothing changed', () => {
    expect(staleRunnerRequest(runner, quiet)).toBeNull()
    expect(staleRunnerRequest(runner, { ...quiet, session: { sessionId: 'older', createdAt: '2026-11-25T09:00:00.000Z' } })).toBeNull()
  })

  it('drops it when the owner works on the task, a hand-over changed, or a session started on it since', () => {
    expect(staleRunnerRequest(runner, { ...quiet, together: true })).toMatch(/works on the task/)
    expect(staleRunnerRequest(runner, { ...quiet, held: true })).toMatch(/hand-over/)
    expect(staleRunnerRequest(runner, { ...quiet, session: { sessionId: 'newer-session', createdAt: '2026-11-25T10:00:01.000Z' } })).toMatch(/newer-se/)
  })

  it('never drops what the user or a session asked for', () => {
    expect(staleRunnerRequest({ ...runner, origin: 'task' }, { ...quiet, together: true })).toBeNull()
    expect(staleRunnerRequest({ ...runner, origin: undefined }, { ...quiet, together: true })).toBeNull()
  })
})

describe('a worker for a task a session holds', () => {
  it('goes to that session, unless its context is very long', () => {
    expect(routeToHolder(null)).toBe('deliver')
    expect(routeToHolder(LONG_CONTEXT_TOKENS - 1)).toBe('deliver')
    expect(routeToHolder(LONG_CONTEXT_TOKENS)).toBe('replace')
  })
})
