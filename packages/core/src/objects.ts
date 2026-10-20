import type { EML } from './index'
import { slugifyTag } from './tags'
import { slugifySubject } from './subjects'
import { fieldProblem, unknownFieldsError } from './fields'

// --- Objects (v0.19): project · entity · tag · subject ---------------------------
//
// The structure that organizes engrams, read and written through one generic
// path (eml_read_object / eml_create_object / eml_update_object, REST
// /object/<object>). Each kind takes only its own fields; an unknown field
// errors with the list of allowed ones. Agents and users are not objects here
// (setup and the cockpit manage them).

export const OBJECT_KINDS = ['project', 'entity', 'tag', 'subject'] as const
export type ObjectKind = typeof OBJECT_KINDS[number]

type Spec = Record<string, { kind: 'text' | 'enum' | 'date' | 'map', values?: readonly string[] }>

const OBJECT_FIELDS: Record<ObjectKind, Spec> = {
  project: {
    id: { kind: 'text' }, name: { kind: 'text' },
    status: { kind: 'enum', values: ['active', 'paused', 'archived'] },
    goal: { kind: 'text' }, description: { kind: 'text' }, owner: { kind: 'text' },
    parent_project: { kind: 'text' }, started_at: { kind: 'date' },
    status_tracks: { kind: 'text' }, metadata: { kind: 'map' },
  },
  entity: {
    id: { kind: 'text' }, name: { kind: 'text' },
    kind: { kind: 'enum', values: ['person', 'org', 'asset'] },
    status: { kind: 'enum', values: ['active', 'archived'] },
    description: { kind: 'text' }, status_tracks: { kind: 'text' }, metadata: { kind: 'map' },
  },
  tag: {
    name: { kind: 'text' }, description: { kind: 'text' },
    status: { kind: 'enum', values: ['active', 'archived'] },
  },
  subject: {
    name: { kind: 'text' }, description: { kind: 'text' },
    status: { kind: 'enum', values: ['active', 'closed'] },
  },
}

/** Fields that cannot be cleared or changed after create. */
const FIXED_ON_UPDATE: Record<ObjectKind, readonly string[]> = {
  project: ['id'], entity: ['id'], tag: [], subject: [],
}

function assertObject(object: unknown): asserts object is ObjectKind {
  if (!(OBJECT_KINDS as readonly unknown[]).includes(object)) {
    throw new Error(`Invalid object: unknown object "${String(object)}". One of ${OBJECT_KINDS.join(', ')}.`)
  }
}

function checkFields(object: ObjectKind, input: Record<string, unknown>, mode: 'create' | 'update'): void {
  const spec = OBJECT_FIELDS[object]
  const unknown = Object.keys(input).filter(k => !(k in spec) && input[k] !== undefined)
  if (unknown.length > 0) {
    const e = unknownFieldsError(object, unknown, Object.keys(spec).filter(k => mode === 'create' || !FIXED_ON_UPDATE[object].includes(k)))
    throw new Error(e.message.replace(/^Invalid engram:/, 'Invalid object:'))
  }
  const problems: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    if (v === null) {
      if (k === 'name' || k === 'status' || k === 'kind') problems.push(`${k} cannot be cleared.`)
      continue
    }
    const p = fieldProblem(k, spec[k], v)
    if (p) problems.push(p)
  }
  if (mode === 'update') {
    const fixed = FIXED_ON_UPDATE[object].filter(k => input[k] !== undefined)
    if (fixed.length > 0) problems.push(`${fixed.join(', ')} cannot change.`)
  }
  if (problems.length > 0) throw new Error(`Invalid object: ${problems.join(' ')}`)
}

function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const diff: Record<string, [unknown, unknown]> = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'updated_at' || k === 'engram_count') continue
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff[k] = [before[k] ?? null, after[k] ?? null]
  }
  return diff
}

/** How many engrams live in a project's / entity's scope. */
function scopeCount(eml: EML, scope: string): number {
  return eml.engrams.countInScope(scope)
}

/**
 * Without id: the objects of a kind with their usage (engram count). Archived
 * or closed ones only with a status filter. With id: one object with all its
 * fields, or null.
 */
export function readObject(eml: EML, object: unknown, opts: { id?: string, status?: string, kind?: string } = {}): unknown {
  assertObject(object)
  // An entity list can be narrowed by kind (person · org · asset); the other objects have none.
  if (opts.kind !== undefined) {
    if (object !== 'entity') throw new Error('Invalid object: kind filters entities only.')
    if (!['person', 'org', 'asset'].includes(opts.kind)) throw new Error('Invalid object: kind is one of person, org, asset.')
  }
  if (opts.id !== undefined) {
    switch (object) {
      case 'project': {
        const p = eml.projects.get(opts.id)
        return p ? { ...p, engram_count: scopeCount(eml, `project.${p.id}`) } : null
      }
      case 'entity': {
        const e = eml.entities.get(opts.id)
        return e ? { ...e, engram_count: scopeCount(eml, `entity.${e.id}`) } : null
      }
      case 'tag': return eml.tags.get(slugifyTag(opts.id))
      case 'subject': return eml.subjects.get(opts.id)
    }
  }
  const statuses: Record<ObjectKind, readonly string[]> = {
    project: ['active', 'paused', 'archived'], entity: ['active', 'archived'], tag: ['active', 'archived'], subject: ['active', 'closed'],
  }
  if (opts.status !== undefined && !statuses[object].includes(opts.status)) {
    throw new Error(`Invalid object: status for ${object} is one of ${statuses[object].join(', ')}.`)
  }
  switch (object) {
    case 'project': {
      const all = eml.projects.list(opts.status ? { status: opts.status as 'active' } : undefined)
      return all.filter(p => opts.status || p.status !== 'archived').map(p => ({ ...p, engram_count: scopeCount(eml, `project.${p.id}`) }))
    }
    case 'entity':
      return eml.entities.list({ status: (opts.status ?? 'active') as 'active', ...(opts.kind ? { kind: opts.kind as 'person' } : {}) }).map(e => ({ ...e, engram_count: scopeCount(eml, `entity.${e.id}`) }))
    case 'tag':
      return eml.tags.list((opts.status ?? 'active') as 'active')
    case 'subject':
      return eml.subjects.list((opts.status ?? 'active') as 'active')
  }
}

/** Create an object; only the kind's fields. A project's or entity's id defaults to the slug of its name. */
export function createObject(eml: EML, object: unknown, input: Record<string, unknown>): { object: unknown, created: boolean } {
  assertObject(object)
  checkFields(object, input, 'create')
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error(`Invalid object: a ${object} needs a name.`)
  const name = input.name.trim()
  switch (object) {
    case 'project': {
      const id = (input.id as string | undefined) ?? slugifyTag(name)
      if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid object: a project id is letters, digits, - and _ (it becomes the scope project.<id>).')
      if (eml.projects.exists(id)) throw new Error(`Invalid object: project "${id}" already exists.`)
      if (input.status === 'archived') throw new Error('Invalid object: a new project is active or paused.')
      const project = eml.projects.create({
        id, name, status: input.status as 'active' | undefined, goal: input.goal as string | undefined,
        description: input.description as string | undefined, owner: input.owner as string | undefined,
        parent_project: input.parent_project as string | undefined, started_at: input.started_at as string | undefined,
        status_tracks: input.status_tracks as string | undefined, metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: project, created: true }
    }
    case 'entity': {
      const id = (input.id as string | undefined) ?? slugifyTag(name)
      if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid object: an entity id is letters, digits, - and _ (it becomes the scope entity.<id>).')
      if (!input.kind) throw new Error('Invalid object: an entity needs kind — person, org or asset.')
      if (eml.entities.exists(id)) throw new Error(`Invalid object: entity "${id}" already exists.`)
      const entity = eml.entities.create({
        id, name, kind: input.kind as 'person', status: input.status as 'active' | undefined,
        description: input.description as string | undefined, status_tracks: input.status_tracks as string | undefined,
        metadata: input.metadata as Record<string, string> | undefined,
      })
      return { object: entity, created: true }
    }
    case 'tag': {
      const created = !eml.tags.exists(slugifyTag(name))
      const tag = eml.tags.create({ name, description: input.description as string | undefined })
      if (created && input.status === 'archived') eml.tags.update(tag.id, { status: 'archived' })
      return { object: eml.tags.get(tag.id), created }
    }
    case 'subject': {
      const created = !eml.subjects.exists(slugifySubject(name))
      const subject = eml.subjects.create({ name, description: input.description as string | undefined })
      if (created && input.status === 'closed') eml.subjects.update(subject.id, { status: 'closed' })
      return { object: eml.subjects.get(subject.id), created }
    }
  }
}

/** Update an object; only the kind's fields; null clears an optional one. Returns the object and the diff, or null. */
export function updateObject(eml: EML, object: unknown, id: string, patch: Record<string, unknown>): { object: unknown, diff: Record<string, [unknown, unknown]> } | null {
  assertObject(object)
  checkFields(object, patch, 'update')
  switch (object) {
    case 'project': {
      const before = eml.projects.get(id)
      if (!before) return null
      // archiving sets ended_at; leaving archived clears it
      const ended = patch.status === 'archived' && before.status !== 'archived' ? new Date().toISOString().slice(0, 10)
        : patch.status !== undefined && patch.status !== 'archived' && before.status === 'archived' ? null : undefined
      const after = eml.projects.update(id, {
        ...(patch as object),
        ...(ended !== undefined ? { ended_at: ended as string } : {}),
      } as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'entity': {
      const before = eml.entities.get(id)
      if (!before) return null
      const after = eml.entities.update(id, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'tag': {
      const slug = slugifyTag(id)
      const before = eml.tags.get(slug)
      if (!before) return null
      const after = eml.tags.update(slug, patch as never)!
      return { object: after, diff: diffOf(before as never, after as never) }
    }
    case 'subject': {
      const before = eml.subjects.get(id)
      if (!before) return null
      const after = eml.subjects.update(id, patch as never)
      return { object: after, diff: diffOf(before as never, after as never) }
    }
  }
}
