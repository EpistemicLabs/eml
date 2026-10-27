import { readFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, type EngramInput, type StoredEngram, type Env, type LearnInput, type LearnResult, type RelationInput } from '../src'
import { brainRef, exportSet } from '../src/log/move'

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

/**
 * The same writes on any brain: every mutator, with the side effects that touch
 * several rows (supersede, part_of, task_id, bound items, wikilinks, tags,
 * subjects, objects).
 */
export function writeEverything(eml: EML): void {
  const juno = eml.env({ handle: 'juno', session_id: 's1', model: 'm', harness: 'h', ingestion_method: 'mcp' })
  const ada = eml.env({ handle: 'ada', session_id: 's2', ingestion_method: 'direct' })
  writes(eml).agents.store({ id: 'juno', name: 'Juno' }, juno)
  writes(eml).agents.update('juno', { description: 'the agent' })
  writes(eml).users.create({ id: 'ada', name: 'Ada' }, juno)
  writes(eml).users.update('ada', { email: 'ada@example.com' }, juno)
  createObject(eml, 'project', { id: 'p', name: 'P' }, juno)
  createObject(eml, 'entity', { id: 'acme', name: 'Acme', kind: 'org' }, juno)
  createObject(eml, 'tag', { name: 'ops' }, juno)
  createObject(eml, 'tag', { name: 'old', status: 'archived' }, juno)
  createObject(eml, 'subject', { name: 'launch' }, juno)
  createObject(eml, 'subject', { name: 'done-strand', status: 'closed' }, juno)
  updateObject(eml, 'entity', 'acme', { description: 'a customer' }, juno)
  updateObject(eml, 'tag', 'ops', { description: 'operations' }, juno)
  updateObject(eml, 'subject', 'launch', { description: 'the launch' }, juno)

  const scope = 'project.p'
  const parent = writes(eml).store(validTask({ scope, title: 'parent', status: 'active' }), juno)
  const child = writes(eml).store(validTask({ scope, title: 'child', parent_id: parent.id }), juno)
  const bound = writes(eml).store(validDecision({ scope, title: 'bound', task_id: parent.id, properties: { binding: 'task' } }), juno)
  const kept = writes(eml).store(validNote({ scope, title: 'kept', task_id: parent.id, properties: { binding: 'task' } }), juno)
  const note = writes(eml).store(validNote({ scope, title: 'note', content: 'see [[bound]] and [[nowhere]]', tags: ['ops'], subjects: ['launch'] }), ada)
  writes(eml).store(validStatus({ scope }), juno)
  writes(eml).store(validStatus({ scope, content: 'next state', properties: { state: 'next' } }), ada)
  writes(eml).store(validRule({ scope, title: 'rule-one' }), juno)
  writes(eml).store(validProfile({ scope: 'user.ada', title: 'ada', properties: { core: true } }), juno)
  writes(eml).store(validProfile({ scope: 'user.ada', title: 'ada-2', properties: { core: true } }), juno)
  writes(eml).store(validEvent({ scope, title: 'shipped' }), juno)
  const log = writes(eml).store(validLog({ scope, title: 'session' }), juno)
  writes(eml).store(validReference({ scope, title: 'ref' }), juno)

  writes(eml).trackTask(child.id, { text: 'started', status: 'active', stage: 'implementation', tags: ['ops'] }, juno)
  writes(eml).trackTask(child.id, { status: 'resolved', outcome: 'done', text: 'finished' }, juno)
  writes(eml).trackTask(parent.id, { status: 'resolved', outcome: 'done', text: 'closed', keep: [kept.id] }, ada)
  writes(eml).trackTask(parent.id, { status: 'active', text: 'reopened' }, ada)
  const successor = writes(eml).store(validTask({ scope, title: 'successor', supersedes: [parent.id] }), juno)
  writes(eml).trackTask(successor.id, { subjects: ['launch'], priority: 'high' }, juno)

  writes(eml).update(note.id, { content: 'see [[kept]] again', tags: [], subjects: ['launch'] }, ada)
  writes(eml).update(log.id, { properties: { next: 'go on' } }, ada)
  const decision = writes(eml).store(validDecision({ scope, title: 'standing-one' }), juno)
  writes(eml).update(decision.id, { review_note: 'still holds' }, juno)
  writes(eml).confirmReview(decision.id, 'confirmed again', ada)
  writes(eml).confirmReview(successor.id, 'still relevant', ada)
  const replacement = writes(eml).store(validDecision({ scope, title: 'replacement' }), juno)
  writes(eml).update(replacement.id, { supersedes: [decision.id] }, juno)
  writes(eml).update(bound.id, { status: 'invalidated' }, juno)

  const learned = writes(eml).learn({ scope: 'user.ada', title: 'ask-first', content: 'Ask before acting.', source: 'user', happened: 'once', quote: 'ask me' }, juno)
  if (!learned.written) throw new Error('learning not written')
  writes(eml).learn({ id: learned.engram.id, source: 'observed', happened: 'twice', content: 'Ask before acting, always.' }, ada)
  writes(eml).relate({ source_id: note.id, target_id: decision.id, relation: 'supports', detection_method: 'manual' }, juno)

  // v0.21: a task with its journal leaves for another brain; its part_of edge crosses the set and is dropped
  const leaving = writes(eml).store(validTask({ scope, title: 'leaving', parent_id: successor.id }), juno)
  writes(eml).trackTask(leaving.id, { text: 'handed over' }, ada)
  moveOut(eml, [leaving.id], juno)

  updateObject(eml, 'project', 'p', { status: 'archived' }, juno)

  // v0.21: engrams from another brain, with their history and their project
  const other = otherBrain()
  const set = exportSet((other as any).db, (((other as any).db.prepare('SELECT id FROM engrams').all()) as Array<{ id: string }>).map(r => r.id))
  eml.apply({ name: 'engram.import', input: { source: brainRef((other as any).db), set_hash: set.set_hash, rows: set.rows } }, juno)
  other.close()
}

/** A brain with a clock that moves 1 ms per read from `start` and ids from a counter: the same on every call. */
export function fixedBrain(namespace: string, start: string, idPrefix: string): EML {
  let t = Date.parse(start)
  let n = 0
  return new EML({
    dbPath: ':memory:', namespace,
    clock: () => new Date(t++).toISOString(),
    newId: () => `${idPrefix}-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
}

/**
 * The two ops of a cross-brain move by hand: engrams `ids` imported into a
 * fresh brain, then engram.move_out in `eml` naming that import and dropping
 * the relations that cross the set.
 */
export function moveOut(eml: EML, ids: string[], env?: Env): unknown {
  const db = (eml as any).db
  const set = exportSet(db, ids)
  const there = fixedBrain('there', '2026-10-21T08:00:00.000Z', '20000000')
  there.apply({ name: 'engram.import', input: { source: brainRef(db), set_hash: set.set_hash, rows: set.rows } })
  const target = { brain: brainRef((there as any).db).brain, op_id: (there as any).db.prepare('SELECT op_id FROM op_log ORDER BY seq DESC LIMIT 1').get().op_id as string }
  there.close()
  return eml.apply({ name: 'engram.move_out', input: { ids, set_hash: set.set_hash, drop_relations: set.crossing.map(r => r.id), target } }, env)
}

/**
 * A second brain, the same on every call: a project with a task, its journal
 * and a decision bound to it, tagged with a tag of its own and one (ops) that
 * writeEverything's brain has too.
 */
export function otherBrain(): EML {
  const other = fixedBrain('other', '2026-10-20T08:00:00.000Z', '10000000')
  const kai = other.env({ handle: 'kai', session_id: 's9', ingestion_method: 'mcp' })
  createObject(other, 'project', { id: 'moved', name: 'Moved' }, kai)
  createObject(other, 'tag', { name: 'ops' }, kai)
  createObject(other, 'tag', { name: 'carried' }, kai)
  const task = writes(other).store(validTask({ scope: 'project.moved', title: 'moved-task', status: 'active', tags: ['carried', 'ops'] }), kai)
  writes(other).trackTask(task.id, { text: 'progress' }, kai)
  writes(other).store(validDecision({ scope: 'project.moved', title: 'moved-decision', task_id: task.id, properties: { binding: 'task' } }), kai)
  return other
}

/** A brain file as v0.20 left it (tests/fixtures/brain-v20.sql), with a row in every state table. */
export function createV20Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(join(__dirname, 'fixtures', 'brain-v20.sql'), 'utf-8'))
  const at = '2026-10-23T09:00:00.000Z'
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('juno', 'Juno', ?)`).run(at)
  db.prepare(`INSERT INTO users (id, name, created_at, updated_at) VALUES ('ada', 'Ada', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO entities (id, name, kind, created_at, updated_at) VALUES ('acme', 'Acme', 'org', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'P', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO tags (id, name, created_at) VALUES ('ops', 'ops', ?)`).run(at)
  db.prepare(`INSERT INTO subjects (id, name, created_at, updated_at) VALUES ('launch', 'launch', ?, ?)`).run(at, at)
  const engram = db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES (?, ?, 'project.p', ?, ?, 'active', ?, ?, ?, 1)`)
  engram.run('d-1', 'decision', 'pick', 'chose the test option', JSON.stringify({ rationale: 'r', alternatives: ['a'] }), at, at)
  engram.run('t-1', 'task', 'build', 'build it', JSON.stringify({ stage: 'planning' }), at, at)
  for (const id of ['d-1', 't-1']) {
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
  }
  db.prepare(`INSERT INTO relations (id, source_id, target_id, relation, detection_method, created_at) VALUES ('rel-1', 'd-1', 't-1', 'supports', 'manual', ?)`).run(at)
  db.prepare(`INSERT INTO engram_tags (engram_id, tag_id, created_at) VALUES ('d-1', 'ops', ?)`).run(at)
  db.prepare(`INSERT INTO engram_subjects (engram_id, subject_id, created_at) VALUES ('t-1', 'launch', ?)`).run(at)
  db.prepare(`INSERT INTO entries (id, engram_id, kind, at, text) VALUES ('e-1', 't-1', 'change', ?, 'created (planned)')`).run(at)
  db.close()
}
