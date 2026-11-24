import { describe, it, expect } from 'vitest'
import { MAX_RUNNING, runnerBlock, type GateInput, type GateTask } from '../src/domain/runner-gate.js'

const t = (id: string, status: string, props: GateTask['properties'] = {}, extra: Partial<GateTask> = {}): GateTask =>
  ({ id, status, scope: 'project.eml', title: id, properties: props, ...extra })
const REQUESTED = '2026-11-24T10:00:00.000Z'
/** A planned step handed over: its delegation follows delegate and checkpoint (as core mirrors them), with a request. */
const ready = (props: GateTask['properties'] = {}) => {
  const p = { delegate: 'atlas', checkpoint: 'after', assignee_ids: ['lasse'], ...props }
  return t('step', 'planned', { ...p, ...(p.delegate ? { delegation: { agent: p.delegate, ...(p.checkpoint ? { checkpoint: p.checkpoint } : {}), requested_at: REQUESTED } } : {}) })
}
const gate = (patch: Partial<GateInput> = {}) => runnerBlock({ task: ready(), deps: [], running: 0, shared: false, me: 'lasse', ...patch })

describe('the runner gate', () => {
  it('lets a ready step start', () => {
    expect(gate()).toBeNull()
    expect(gate({ parent: { id: 'plan', task: t('plan', 'active') }, deps: [{ id: 'a', task: t('a', 'resolved') }] })).toBeNull()
  })

  it('is not runner work when closed, without a delegate or a checkpoint, or without an open request; an active one with a request is (v0.23)', () => {
    expect(gate({ task: { ...ready(), status: 'active' } })).toBeNull()
    expect(gate({ task: { ...ready(), status: 'resolved' } })).toEqual({ kind: 'not_runner_work' })
    expect(gate({ lastRunStartedAt: '2026-11-24T10:00:01.000Z' })).toEqual({ kind: 'not_runner_work' })
    expect(gate({ lastRunStartedAt: '2026-11-24T09:00:00.000Z' })).toBeNull()
    expect(gate({ task: t('step', 'planned', { delegate: 'atlas', checkpoint: 'after' }) })).toEqual({ kind: 'not_runner_work' })
    expect(gate({ task: ready({ delegate: undefined }) })).toEqual({ kind: 'not_runner_work' })
    expect(gate({ task: ready({ checkpoint: undefined }) })).toEqual({ kind: 'not_runner_work' })
  })

  it('names a wait on someone, a job, a hold and an open session', () => {
    expect(gate({ task: ready({ waiting_on: { who: 'kim@acme' } }) })).toEqual({ kind: 'waiting', who: 'kim@acme' })
    expect(gate({ scheduled: true })).toEqual({ kind: 'scheduled' })
    expect(gate({ held: true })).toEqual({ kind: 'held' })
    expect(gate({ busy: true })).toEqual({ kind: 'busy' })
  })

  it('names a parent that is not active, or that the brain could not give', () => {
    expect(gate({ parent: { id: 'plan', task: t('plan', 'planned') } })).toEqual({ kind: 'parent', parentId: 'plan', status: 'planned' })
    expect(gate({ parent: { id: 'plan', task: null } })).toEqual({ kind: 'parent', parentId: 'plan', status: null })
  })

  it('names the first step it depends on that is not resolved, with its state, and how many more wait', () => {
    const deps = [
      { id: 'done', task: t('done', 'resolved') },
      { id: 'pr', task: t('pr', 'active', { display_title: 'Open the PR against alpha' }) },
      { id: 'gone', task: null },
    ]
    expect(gate({ deps })).toEqual({ kind: 'depends', stepId: 'pr', title: 'Open the PR against alpha', status: 'active', more: 1 })
    expect(gate({ deps: [{ id: 'gone', task: null }] })).toEqual({ kind: 'depends', stepId: 'gone', title: null, status: null, more: 0 })
  })

  it('names the cap, per parent or for standalone tasks', () => {
    expect(gate({ running: MAX_RUNNING })).toEqual({ kind: 'cap', running: MAX_RUNNING, max: MAX_RUNNING, standalone: true })
    expect(gate({ running: MAX_RUNNING, parent: { id: 'plan', task: t('plan', 'active') } })).toEqual({ kind: 'cap', running: MAX_RUNNING, max: MAX_RUNNING, standalone: false })
    expect(gate({ running: MAX_RUNNING - 1 })).toBeNull()
  })

  it('names a task outside a project', () => {
    expect(gate({ task: { ...ready(), scope: 'global' } })).toEqual({ kind: 'no_project', scope: 'global' })
  })

  it('in a shared or unconfirmed space leaves another member\'s task to their cockpit, after every other reason', () => {
    const theirs = ready({ assignee_ids: ['dominik'] })
    expect(gate({ task: theirs, shared: true })).toEqual({ kind: 'other_member', owner: 'dominik' })
    expect(gate({ task: theirs, shared: null })).toEqual({ kind: 'other_member', owner: 'dominik' })
    expect(gate({ task: theirs, shared: false })).toBeNull()
    expect(gate({ task: { ...ready({ assignee_ids: undefined }), ingested_by: 'dominik' }, shared: true })).toEqual({ kind: 'other_member', owner: 'dominik' })
    // A real wait on a step is named before whose cockpit starts it.
    expect(gate({ task: theirs, shared: true, deps: [{ id: 'pr', task: t('pr', 'active') }] })).toMatchObject({ kind: 'depends' })
  })

  it('names the reason a person needs first: a wait before the tree, the tree before the cap', () => {
    expect(gate({ task: ready({ waiting_on: { who: 'kim' } }), held: true, running: 9 })).toMatchObject({ kind: 'waiting' })
    expect(gate({ parent: { id: 'p', task: t('p', 'planned') }, deps: [{ id: 'a', task: t('a', 'planned') }] })).toMatchObject({ kind: 'parent' })
    expect(gate({ deps: [{ id: 'a', task: t('a', 'planned') }], running: 9 })).toMatchObject({ kind: 'depends' })
  })
})
