import { describe, it, expect } from 'vitest'
import { firesHere, firingOf, ownerOf, ownersFor, projectScope, runsHere } from '../src/domain/task-owner.js'

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

describe('whose cockpit fires a task\'s schedule', () => {
  const members = ['lasse', 'dominik']
  const task = (assignees: string[], author: string | null) => ({ ingested_by: author, properties: { assignee_ids: assignees } })

  it('in a local space every task is this member\'s', () => {
    for (const t of [task(['dominik'], 'dominik'), task([], 'atlas'), task([], null)]) expect(firingOf(false, t, 'lasse', null)).toBe('mine')
  })

  it('in a shared space: mine by the first assignee, else by authorship; another member\'s is theirs', () => {
    expect(firingOf(true, task(['lasse', 'dominik'], 'dominik'), 'lasse', members)).toBe('mine')
    expect(firingOf(true, task([], 'lasse'), 'lasse', members)).toBe('mine')
    expect(firingOf(true, task(['dominik', 'lasse'], 'lasse'), 'lasse', members)).toBe('theirs')
    expect(firingOf(true, task([], 'dominik'), 'lasse', members)).toBe('theirs')
    // an assignee decides without the member list
    expect(firingOf(true, task(['dominik'], 'atlas'), 'lasse', null)).toBe('theirs')
  })

  it('a task nobody is assigned to that no member wrote is ownerless: the cockpit that holds its record fires it', () => {
    expect(firingOf(true, task([], 'atlas'), 'lasse', members)).toBe('ownerless')
    expect(firingOf(true, task([], null), 'lasse', null)).toBe('ownerless')
    expect([firesHere('ownerless', true), firesHere('ownerless', false)]).toEqual([true, false])
    expect([firesHere('mine', false), firesHere('theirs', true), firesHere('unknown', true)]).toEqual([true, false, false])
  })

  it('is unknown while the space\'s kind is, or while the members who would decide cannot be read', () => {
    expect(firingOf(null, task(['lasse'], 'lasse'), 'lasse', members)).toBe('unknown')
    expect(firingOf(true, task([], 'atlas'), 'lasse', null)).toBe('unknown')
  })
})
