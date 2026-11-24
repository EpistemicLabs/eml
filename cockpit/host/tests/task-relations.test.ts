import { describe, it, expect } from 'vitest'
import { childrenOf, parentOf } from '../src/domain/task-relations.js'

describe('task relations', () => {
  const relations = [
    { relation: 'part_of', source_id: 'step', target_id: 'parent' },
    { relation: 'part_of', source_id: 'child', target_id: 'step' },
    { relation: 'relates_to', source_id: 'step', target_id: 'other' },
  ]

  it('finds the task a step is part of, and null for a task without one', () => {
    expect(parentOf({ id: 'step', relations })).toBe('parent')
    expect(parentOf({ id: 'parent', relations })).toBeNull()
    expect(parentOf({ id: 'step' })).toBeNull()
  })

  it('lists the steps of a task', () => {
    expect(childrenOf({ id: 'step', relations })).toEqual(['child'])
    expect(childrenOf({ id: 'child', relations })).toEqual([])
  })
})
