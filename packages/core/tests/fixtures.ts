import type { EngramInput, EML, StoredEngram, Env, LearnInput, LearnResult, RelationInput } from '../src'

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
  const task = writes(eml).store(validTask(overrides), ctx)
  return writes(eml).trackTask(task.id, { status, outcome: 'test outcome', text: 'closed in a test', keep: [] }, ctx)!
}

// v0.20: every write goes through eml.apply(command, env). Tests that are not
// about the command layer write through this facade, shaped like the store
// methods it replaced: NOT_FOUND reads as null, a learning's topic match as
// { written: false, matches }, an object write returns the object.
type AnyFields = Record<string, unknown>

function orNull<T>(f: () => T): T | null {
  try { return f() } catch (e) {
    if ((e as { code?: string })?.code === 'NOT_FOUND') return null
    throw e
  }
}

export function writes(eml: EML) {
  const run = (name: string, input: unknown, env?: Env): any => eml.apply({ name, input } as never, env)
  const object = (kind: string) => ({
    create: (fields: AnyFields, env?: Env): any => run('object.create', { object: kind, fields }, env).object,
    update: (id: string, patch: AnyFields, env?: Env): any => orNull(() => run('object.update', { object: kind, id, patch }, env).object),
  })
  const agent = object('agent')
  return {
    store: (input: EngramInput, env?: Env): StoredEngram & Record<string, any> => run('engram.create', input, env),
    update: (id: string, patch: AnyFields, env?: Env): (StoredEngram & Record<string, any>) | null => orNull(() => run('engram.update', { id, patch }, env)),
    trackTask: (id: string, input: AnyFields, env?: Env): (StoredEngram & Record<string, any>) | null => orNull(() => run('task.track', { ...input, id }, env)),
    confirmReview: (id: string, text?: string, env?: Env): any => orNull(() => run('engram.confirm_review', { id, ...(text !== undefined ? { text } : {}) }, env)),
    relate: (input: RelationInput, env?: Env): boolean => run('relation.create', input, env).created,
    learn: (input: LearnInput, env?: Env): LearnResult => {
      if (input.id !== undefined) return { written: true, ...run('learning.add_evidence', input, env) }
      const { source, happened, quote, stance, rule_id, ...lesson } = input
      const evidence = Object.fromEntries(Object.entries({ source, happened, quote, stance, rule_id }).filter(([, v]) => v !== undefined))
      try {
        const { learning, ...engram } = run('engram.create', { ...lesson, type: 'learning', evidence }, env)
        return { written: true, engram, learning }
      } catch (e) {
        const err = e as { code?: string, data?: { matches: any } }
        if (err?.code === 'TOPIC_EXISTS') return { written: false, matches: err.data!.matches }
        throw e
      }
    },
    projects: object('project'),
    entities: object('entity'),
    users: object('user'),
    tags: object('tag'),
    subjects: object('subject'),
    agents: { store: agent.create, update: agent.update },
  }
}

/** object.create / object.update in the shape of the v0.19 functions. */
export function createObject(eml: EML, object: string, fields: AnyFields, env?: Env): { object: any, created: boolean } {
  return eml.apply({ name: 'object.create', input: { object, fields } }, env) as never
}
export function updateObject(eml: EML, object: string, id: string, patch: AnyFields, env?: Env): { object: any, diff: Record<string, [unknown, unknown]> } | null {
  return orNull(() => eml.apply({ name: 'object.update', input: { object, id, patch } }, env)) as never
}
