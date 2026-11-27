import { describe, it, expect } from 'vitest'
import { createTaskLease, routeToTaskHolder, takenSince, taskLeaseHookups, type LeaseCommands, type RouteDeps } from '../src/application/task-lease.js'
import type { MessageRequest } from '../src/application/deliver-message.js'
import type { LeaseEntry } from '../src/domain/task-lease.js'
import type { SpawnRequest } from '../src/domain/spawn-request.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'

// The task lease against the host's state: fencing a queued runner request, whom a split onto a held task goes to, a
// holder making way, and routing a start on a task to the session that holds it.

const entry = (sessionId: string, more: Partial<LeaseEntry> = {}): LeaseEntry => ({
  sessionId, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', archivedAt: null, jobId: null, title: null, agentTitle: null, ...more,
})
const request = (id: string, more: Partial<SpawnRequest> = {}): SpawnRequest => ({
  id, projectId: 'bp-eml', prompt: 'p', title: null, fromSessionId: null, taskId: 't1', createdAt: '2026-11-25T10:00:00.000Z', ...more,
})

function lease(opts: { pending?: SpawnRequest[]; sessions?: LeaseEntry[]; commands?: Partial<LeaseCommands> | null; working?: string[] } = {}) {
  const ended: Array<[string, string]> = []
  const answered: string[] = []
  const commands = opts.commands === null ? null : { together: () => false, held: () => false, undoneSince: () => false, ...opts.commands }
  const taskLease = createTaskLease({
    pending: () => opts.pending ?? [],
    sessions: () => opts.sessions ?? [],
    commands: () => commands,
    working: (id) => (opts.working ?? []).includes(id),
    end: async (id, reason) => { ended.push([id, reason]) },
    answered: (id) => answered.push(id),
  })
  return { taskLease, ended, answered }
}

describe('the fencing check of the host', () => {
  const runner = request('r1', { origin: 'runner' })

  it('reads together, a pending or undone hand-over, and a session on the task started since', () => {
    expect(lease().taskLease.stale(runner)).toBeNull()
    expect(lease({ commands: null }).taskLease.stale(runner)).toBeNull()
    expect(lease({ commands: { together: (t) => t === 't1' } }).taskLease.stale(runner)).toMatch(/works on the task/)
    expect(lease({ commands: { held: (t) => t === 't1' } }).taskLease.stale(runner)).toMatch(/hand-over/)
    const undoneSince = (t: string, since: string) => t === 't1' && since === runner.createdAt
    expect(lease({ commands: { undoneSince } }).taskLease.stale(runner)).toMatch(/hand-over/)
    expect(lease({ sessions: [entry('newer', { createdAt: '2026-11-25T10:00:01.000Z' })] }).taskLease.stale(runner)).toMatch(/newer/)
    expect(lease({ sessions: [entry('older')] }).taskLease.stale(runner)).toBeNull()
    expect(lease({ sessions: [entry('put-away', { createdAt: '2026-11-25T10:00:01.000Z', archivedAt: '2026-11-25T10:01:00.000Z' })] }).taskLease.stale(runner)).toBeNull()
  })

  it('never fences a request without a task', () => {
    expect(lease({ commands: { together: () => true } }).taskLease.stale(request('r2', { origin: 'runner', taskId: undefined }))).toBeNull()
  })
})

describe('whom a split onto an existing task goes to', () => {
  it('a session holding the task, by its name', () => {
    expect(lease({ sessions: [entry('s1', { agentTitle: 'Mail job' })] }).taskLease.splitHolder('t1')).toEqual({ sessionId: 's1', title: 'Mail job' })
    expect(lease({ sessions: [entry('s1')] }).taskLease.splitHolder('t1')).toEqual({ sessionId: 's1', title: 's1' })
    expect(lease().taskLease.splitHolder('t1')).toBeNull()
  })

  it('a request starting on the task first, but never a runner request: the split revokes that one', () => {
    expect(lease({ pending: [request('own', { origin: 'task' })], sessions: [entry('s1')] }).taskLease.splitHolder('t1')).toEqual({ pending: 'own' })
    expect(lease({ pending: [request('r1', { origin: 'runner' })] }).taskLease.splitHolder('t1')).toBeNull()
  })
})

describe('a holder making way for a new session', () => {
  it('is stopped and put away, and its wait on the task ends', async () => {
    const { taskLease, ended, answered } = lease()
    expect(await taskLease.putAway('s1')).toBeNull()
    expect(ended).toEqual([['s1', 'replaced by a new session on its task']])
    expect(answered).toEqual(['s1'])
  })

  it('never while it is in a turn', async () => {
    const { taskLease, ended } = lease({ working: ['s1'] })
    expect(await taskLease.putAway('s1')).toBe('it is in a turn')
    expect(ended).toEqual([])
  })
})

describe('routing a start on a task to its holder', () => {
  const route = (opts: { pending?: SpawnRequest[]; sessions?: LeaseEntry[]; outcome?: DeliveryOutcome; tokens?: number | null; putAway?: string | null } = {}) => {
    const delivered: Array<{ target: string; text: string; from: string | null }> = []
    const putAway: string[] = []
    const deps: RouteDeps = {
      pending: () => opts.pending ?? [],
      sessions: () => opts.sessions ?? [],
      deliver: async (r) => { delivered.push(r); return opts.outcome ?? 'delivered' },
      contextTokensOf: () => opts.tokens ?? null,
      putAway: async (id) => { putAway.push(id); return opts.putAway ?? null },
    }
    return { deps, delivered, putAway }
  }
  const input = { taskId: 't1', prompt: 'do it', fromSessionId: 'requester', from: 'requester@eml' }

  it('is free when nobody holds the task', async () => {
    expect(await routeToTaskHolder(route().deps, input)).toEqual({ kind: 'free', replaced: null })
  })

  it('gives the holding session the prompt as a message', async () => {
    const r = route({ sessions: [entry('s1')] })
    expect(await routeToTaskHolder(r.deps, input)).toMatchObject({ kind: 'routed', session: { sessionId: 's1' } })
    expect(r.delivered).toEqual([{ target: 's1', text: 'do it', from: 'requester@eml', caller: 'session' }])
  })

  it('refuses, saying whether a retry helps: a request starting (yes), the requester itself (never), an unreachable holder (only while busy)', async () => {
    const starting = await routeToTaskHolder(route({ pending: [request('r1', { origin: 'runner' })] }).deps, input)
    expect(starting).toMatchObject({ kind: 'refused', refusal: { code: 'TASK_STARTING', retry: true } })
    const mine = await routeToTaskHolder(route({ sessions: [entry('requester')] }).deps, input)
    expect(mine).toMatchObject({ kind: 'refused', refusal: { code: 'TASK_HELD_BY_YOU', retry: false } })
    for (const [outcome, retry] of [['busy', true], ['running', true], ['refused', false], ['unknown', false]] as const) {
      const held = await routeToTaskHolder(route({ sessions: [entry('s1', { title: 'Customer reply' })], outcome }).deps, input)
      expect(held).toMatchObject({ kind: 'refused', refusal: { code: 'TASK_HELD', retry } })
      expect(held.kind === 'refused' && held.refusal.message).toContain('Customer reply')
    }
  })

  it('puts a holder with a very long context away and lets the start take its place', async () => {
    const r = route({ sessions: [entry('s1')], tokens: 200_000 })
    expect(await routeToTaskHolder(r.deps, input)).toEqual({ kind: 'free', replaced: 's1' })
    expect(r.putAway).toEqual(['s1'])
    expect(r.delivered).toEqual([])
    const busy = route({ sessions: [entry('s1')], tokens: 200_000, putAway: 'it is in a turn' })
    expect(await routeToTaskHolder(busy.deps, input)).toMatchObject({ kind: 'refused', refusal: { code: 'TASK_HELD', retry: true } })
  })
})

describe('the lease once more right before the add', () => {
  it('a request or a session that took the task since refuses, worth a retry', () => {
    expect(takenSince({ pending: () => [], sessions: () => [] }, 't1', null)).toBeNull()
    expect(takenSince({ pending: () => [request('r1')], sessions: () => [] }, 't1', null)).toMatchObject({ code: 'TASK_STARTING', retry: true })
    expect(takenSince({ pending: () => [], sessions: () => [entry('s1')] }, 't1', null)).toMatchObject({ code: 'TASK_STARTING', retry: true })
  })

  it('after a holder was put away, an older session on the task does not count, a pending request still does', () => {
    expect(takenSince({ pending: () => [], sessions: () => [entry('older')] }, 't1', 'newest')).toBeNull()
    expect(takenSince({ pending: () => [request('r1')], sessions: () => [] }, 't1', 'newest')).toMatchObject({ code: 'TASK_STARTING' })
  })
})

describe('the lease as the host hands it to its entry points', () => {
  function hookups(opts: { pending?: SpawnRequest[]; sessions?: LeaseEntry[]; together?: boolean } = {}) {
    const ended: Array<[string, string]> = []
    const answered: string[] = []
    const revoked: Array<[string, string]> = []
    const delivered: MessageRequest[] = []
    const wired = taskLeaseHookups({
      pending: () => opts.pending ?? [],
      sessions: () => opts.sessions ?? [],
      commands: () => ({ together: () => opts.together ?? false, held: () => false, undoneSince: () => false }),
      working: () => false,
      end: async (id, reason) => { ended.push([id, reason]) },
      answered: (id) => answered.push(id),
      revokeRunnerFor: (taskId, why) => revoked.push([taskId, why]),
      deliver: async (request) => { delivered.push(request); return 'delivered' },
      contextTokensOf: (id) => (id === 's1' ? 42 : null),
    })
    return { wired, ended, answered, revoked, delivered }
  }

  it('the spawn entry points get the fencing check, put-away and the context read', async () => {
    const { wired, ended, answered } = hookups({ together: true })
    expect(wired.spawn.stale(request('r1', { origin: 'runner' }))).toMatch(/works on the task/)
    expect(wired.spawn.contextTokensOf('s1')).toBe(42)
    expect(await wired.spawn.putAway('s1')).toBeNull()
    expect(ended.map(([id]) => id)).toEqual(['s1'])
    expect(answered).toEqual(['s1'])
  })

  it('a split onto a held task finds the holder and hands it the brief as a session message', async () => {
    const { wired, delivered } = hookups({ sessions: [entry('s1', { title: 'Mail job' })] })
    expect(wired.split.holderOf('t1')).toEqual({ sessionId: 's1', title: 'Mail job' })
    expect(await wired.split.deliver('s1', 'The brief')).toBe('delivered')
    expect(delivered).toEqual([{ target: 's1', text: 'The brief', from: null, caller: 'session' }])
  })

  it('the owner working on a task now revokes its queued runner requests', () => {
    const { wired, revoked } = hookups()
    wired.supersedeRunner('t1')
    expect(revoked).toEqual([['t1', 'the owner works on the task now']])
  })
})
