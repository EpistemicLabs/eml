import { describe, it, expect } from 'vitest'
import { goalWithIntent, migrationReport, planTaskStateMigration, type MigrationInput, type MigrationTask } from '../src/domain/task-state-migration.js'
import { requestOpen } from '../src/domain/delegation.js'
import { turnOf } from '../src/domain/task-turn.js'
import { urgentWaitOf } from '../src/domain/task-waits.js'

const NOW = '2026-11-24T12:00:00.000Z'
const input = (tasks: MigrationTask[], patch: Partial<MigrationInput> = {}): MigrationInput => ({
  tasks, scheduledTaskIds: new Set(), snoozes: [], taskless: [], jobsOnTasks: [], heldWaitTasks: [], liveSessions: [], viewer: 'lasse', now: NOW, ...patch,
})
const task = (id: string, properties: MigrationTask['properties'], status = 'planned'): MigrationTask => ({ id, status, title: id, properties: { assignee_ids: ['lasse'], ...properties } })

describe('the task state migration', () => {
  it('a planned task with a delegate but no checkpoint gets checkpoint after and no request: it never starts', () => {
    const plan = planTaskStateMigration(input([task('d', { delegate: 'atlas', delegation: { agent: 'atlas' } })]))
    expect(plan.changes).toEqual([{ taskId: 'd', title: 'd', rules: ['checkpoint_after'], patch: { delegation: { agent: 'atlas', checkpoint: 'after' } }, lines: ['handed to atlas with checkpoint after, not started: the board offers "Hand to atlas"'] }])
    // what the runner reads after it: no open request
    expect(requestOpen({ status: 'planned', properties: { delegate: 'atlas', checkpoint: 'after', delegation: plan.changes[0].patch.delegation as never } }, null)).toBe(false)
  })

  it('gives no request in a space it ran in before: a planned task with a delegate and a checkpoint stays unstarted', () => {
    const plan = planTaskStateMigration(input([task('ready', { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' } })], { ranBefore: '2026-11-24T11:03:43.729Z' }))
    expect(plan.changes).toEqual([])
    expect(migrationReport(plan, { space: 'EML', at: NOW, ranBefore: '2026-11-24T11:03:43.729Z' })).toContain('ran in this space on 2026-11-24T11:03:43.729Z')
  })

  it('a planned task the runner starts today is requested now, so it starts as before; an active one, a scheduled one or one already requested is not', () => {
    const plan = planTaskStateMigration(input([
      task('ready', { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' } }),
      task('running', { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after' } }, 'active'),
      task('job', { delegate: 'atlas', checkpoint: 'after' }),
      task('asked', { delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-24T11:00:00.000Z' } }),
    ], { scheduledTaskIds: new Set(['job']) }))
    expect(plan.changes.map((c) => [c.taskId, c.rules])).toEqual([['ready', ['requested']]])
    expect(plan.changes[0].patch.delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: NOW })
    expect(requestOpen({ status: 'planned', properties: { delegation: plan.changes[0].patch.delegation as never } }, null)).toBe(true)
  })

  it('clears a checkpoint without a delegate; leaves closed tasks alone', () => {
    const plan = planTaskStateMigration(input([task('cp', { checkpoint: 'before' }), task('done', { checkpoint: 'before' }, 'resolved')]))
    expect(plan.changes).toEqual([{ taskId: 'cp', title: 'cp', rules: ['checkpoint_cleared'], patch: { checkpoint: null }, lines: ['checkpoint before cleared: no agent is delegated'] }])
  })

  it('turns blockers into outside waits on the owner next to the waits there are, and clears them', () => {
    const wait = { id: 's1', who: 'lasse', kind: 'question', why: 'Which?' }
    const plan = planTaskStateMigration(input([task('b', { blockers: ['TLS cert', 'vendor reply'], waits: [wait] }, 'active')]))
    expect(plan.changes[0].patch).toEqual({
      blockers: null,
      waits: [wait, { id: 'blocker-1', who: 'lasse', kind: 'outside', why: 'TLS cert', since: NOW }, { id: 'blocker-2', who: 'lasse', kind: 'outside', why: 'vendor reply', since: NOW }],
    })
  })

  it('a blocker turned into a wait on the owner never puts the task in the owner\'s Needs you', () => {
    const plan = planTaskStateMigration(input([task('b', { delegate: 'atlas', checkpoint: 'before', blockers: ['Waiting for the supplier'] }, 'active')]))
    const waitingOn = urgentWaitOf(plan.changes[0].patch as { waits: unknown })
    const facts = { status: 'active', owner: 'lasse', delegate: 'atlas', checkpoint: 'before', waitingOn, parentActive: null }
    const at = Date.parse(NOW)
    expect(turnOf(facts, { working: false, sessions: 0, nextRunAt: null }, 'lasse', at)).toEqual({ turn: 'waiting_on_others' })
    expect(turnOf(facts, { working: false, sessions: 0, nextRunAt: '2026-11-26T02:00:00.000Z' }, 'lasse', at)).toEqual({ turn: 'agent_scheduled', group: 'at_time' })
  })

  it('folds an intent into the goal where it says something the goal does not', () => {
    expect(goalWithIntent(undefined, 'Lasse sees runs')).toBe('Lasse sees runs')
    expect(goalWithIntent('The boards read runs', 'Dominik sees who works')).toBe('The boards read runs. Why: Dominik sees who works.')
    expect(goalWithIntent('The boards read runs from the brain.', 'read runs from the brain')).toBeNull()
    const plan = planTaskStateMigration(input([task('i', { goal: 'Ships', intent: 'customers stop asking' }, 'active'), task('same', { goal: 'Ships it', intent: 'ships it' }, 'active')]))
    expect(plan.changes.map((c) => c.patch)).toEqual([{ goal: 'Ships. Why: customers stop asking.', intent: null }, { intent: null }])
  })

  it('moves a snooze of this cockpit onto the viewer\'s wait it was made for; a snooze that ran out is dropped', () => {
    const waits = [{ id: 's1', who: 'lasse', kind: 'question', why: 'Which?', since: '2026-11-23T09:00:00.000Z' }, { id: 'k', who: 'kim', kind: 'outside' }]
    const plan = planTaskStateMigration(input([task('z', { waits }, 'active'), task('old', { waits: [waits[0]] }, 'active')], {
      snoozes: [{ key: 'task:z@2026-11-23T09:00:00.000Z', until: '2026-11-30T00:00:00.000Z' }, { key: 'task:old@2026-11-23T09:00:00.000Z', until: '2026-11-20T00:00:00.000Z' }],
    }))
    expect(plan.changes.map((c) => [c.taskId, c.patch])).toEqual([['z', { waits: [{ ...waits[0], snoozed_until: '2026-11-30T00:00:00.000Z' }, waits[1]] }]])
  })

  it('writes one change per task with every rule it needs, and a report that lists them by rule', () => {
    const plan = planTaskStateMigration(input([task('many', { delegate: 'atlas', blockers: ['x'], intent: 'why' })], {
      taskless: [{ id: 'j1', name: 'Daily brief' }], jobsOnTasks: [{ id: 'j2', name: 'Check refund', taskId: 'abcdef1234' }],
      heldWaitTasks: [{ taskId: 't', count: 2 }], liveSessions: [{ sessionId: 's', taskId: 't' }],
    }))
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].rules).toEqual(['checkpoint_after', 'blockers', 'intent'])
    const report = migrationReport(plan, { space: 'Main', at: NOW })
    expect(report).toContain('# Task state migration — dry run')
    expect(report).toContain('## A delegate without a checkpoint → checkpoint after, no request (nothing starts) (1)')
    expect(report).toContain('- many (many): handed to atlas with checkpoint after')
    expect(report).toContain('- Jobs without a task → a task each with the job\'s schedule (1): "Daily brief"')
    expect(report).toContain('"Check refund" → abcdef12')
  })
})
