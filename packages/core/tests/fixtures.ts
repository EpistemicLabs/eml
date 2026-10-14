import type { ContextInput, EngramInput } from '../src'

// v0.15 Cluster 0 — shared fixtures for engram writes in tests. A decision needs
// at least one alternative and a rationale on create, a task closed as
// resolved/invalidated needs an outcome; tests that are not about those rules
// write through these helpers instead of repeating the required properties.
// Server tests import this file too (they already reach into core/src).

type Overrides = Partial<Omit<EngramInput, 'type'>>
type Typed<T extends string> = ContextInput & { type: T }

/** A decision that passes create-time validation. Overrides win; properties merge. */
export function validDecision(overrides: Overrides = {}): Typed<'decision'> {
  return {
    content: 'chose the test option',
    scope: 'global',
    ...overrides,
    type: 'decision',
    properties: {
      rationale: 'test rationale',
      alternatives: ['test alternative'],
      ...overrides.properties,
    },
  }
}

/** A task; closed as resolved/invalidated it carries an outcome. Overrides win; properties merge. */
export function validTask(overrides: Overrides = {}): Typed<'task'> {
  const closed = overrides.status === 'resolved' || overrides.status === 'invalidated'
  const properties = {
    ...(closed ? { outcome: 'test outcome' } : {}),
    ...overrides.properties,
  }
  return {
    content: 'a test task',
    scope: 'global',
    ...overrides,
    type: 'task',
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  }
}
