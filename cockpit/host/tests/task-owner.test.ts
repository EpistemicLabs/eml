import { describe, it, expect } from 'vitest'
import { ownerOf, ownersFor, projectScope, runsHere } from '../src/domain/task-owner.js'

describe('who owns a task', () => {
  it('is the first assignee, else the author', () => {
    expect(ownerOf({ properties: { assignee_ids: ['dominik', 'lasse'] }, ingested_by: 'lasse' })).toBe('dominik')
    expect(ownerOf({ properties: { assignee_ids: [] }, ingested_by: 'lasse' })).toBe('lasse')
    expect(ownerOf({ properties: null, ingested_by: 'lasse' })).toBe('lasse')
    expect(ownerOf({})).toBeNull()
  })

  it('runs every task here in a local space, only the member\'s own in a shared or unconfirmed one', () => {
    const theirs = { properties: { assignee_ids: ['dominik'] }, ingested_by: 'lasse' }
    const mine = { ingested_by: 'lasse' }
    const nobodys = {}
    expect([theirs, mine, nobodys].map((t) => runsHere(false, t, 'lasse'))).toEqual([true, true, true])
    expect([theirs, mine, nobodys].map((t) => runsHere(true, t, 'lasse'))).toEqual([false, true, false])
    expect([theirs, mine, nobodys].map((t) => runsHere(null, t, 'lasse'))).toEqual([false, true, false])
  })

  it('a task the cockpit makes takes the owners of the task it comes from, else the member', () => {
    expect(ownersFor({ properties: { assignee_ids: ['dominik', 'lasse'] } }, 'lasse')).toEqual(['dominik', 'lasse'])
    expect(ownersFor({ properties: { assignee_ids: [] }, ingested_by: 'dominik' }, 'lasse')).toEqual(['lasse'])
    expect(ownersFor(null, 'lasse')).toEqual(['lasse'])
  })

  it('goes into a project scope only', () => {
    expect(projectScope('project.eml')).toBe('project.eml')
    expect([projectScope('global'), projectScope('agent.sachi'), projectScope(undefined)]).toEqual([null, null, null])
  })
})
