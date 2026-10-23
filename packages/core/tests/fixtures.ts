import type { EngramInput, EML, StoredEngram, Env } from '../src'

// Shared fixtures for engram writes in tests. v0.19: every type has required
// fields (fields.ts) and a title (except status); tests that are not about those
// rules write through these helpers instead of repeating them. A task is never
// created closed — closedTask() creates it and closes it through trackTask.
// Server tests import this file too (they already reach into core/src).

type Overrides = Partial<Omit<EngramInput, 'type'>>
type Typed<T extends string> = EngramInput & { type: T }

let n = 0
const title = (prefix: string) => `${prefix}-${++n}`

function build<T extends EngramInput['type']>(type: T, defaults: Record<string, unknown>, overrides: Overrides): Typed<T> {
  return {
    content: `a test ${type}`,
    scope: 'global',
    ...(type === 'status' ? {} : { title: title(`test-${type}`) }),
    ...overrides,
    type,
    properties: { ...defaults, ...overrides.properties },
  } as Typed<T>
}

/** A decision that passes create-time validation. Overrides win; properties merge. */
export function validDecision(overrides: Overrides = {}): Typed<'decision'> {
  return build('decision', { rationale: 'test rationale', alternatives: ['test alternative'] }, { content: 'chose the test option', ...overrides })
}

/** An open task (planned unless status says active). Overrides win; properties merge. */
export function validTask(overrides: Overrides = {}): Typed<'task'> {
  return build('task', {}, overrides)
}

/** A rule the user agreed to (always, unless properties say otherwise). */
export function validRule(overrides: Overrides = {}): Typed<'rule'> {
  return build('rule', { applies: 'always', why: 'test why', agreed: 'yes' }, { content: 'Do the test thing.', ...overrides })
}

export function validNote(overrides: Overrides = {}): Typed<'note'> {
  return build('note', {}, overrides)
}

export function validEvent(overrides: Overrides = {}): Typed<'event'> {
  return build('event', { occurred_at: '2026-10-01T10:00:00Z', change_type: 'completed' }, overrides)
}

export function validLog(overrides: Overrides = {}): Typed<'log'> {
  return build('log', { what: 'test what', landed: 'test landed', next: 'test next' }, overrides)
}

export function validReference(overrides: Overrides = {}): Typed<'reference'> {
  return build('reference', { source: 'https://example.org/doc' }, overrides)
}

export function validProfile(overrides: Overrides = {}): Typed<'profile'> {
  return build('profile', {}, { scope: 'user.default', ...overrides })
}

export function validStatus(overrides: Overrides = {}): Typed<'status'> {
  return build('status', { state: 'test state' }, overrides)
}

/** Create a task and close it (resolved by default) — done things are never created closed. */
export function closedTask(
  eml: EML,
  overrides: Overrides = {},
  status: 'resolved' | 'invalidated' = 'resolved',
  ctx?: Env,
): StoredEngram {
  const task = eml.engrams.store(validTask(overrides), ctx)
  return eml.engrams.trackTask(task.id, { status, outcome: 'test outcome', text: 'closed in a test', keep: [] }, ctx)!
}
