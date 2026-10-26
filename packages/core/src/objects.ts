import type { EML } from './index'
import { slugifyTag } from './tags'
import { fieldProblem, unknownFieldsError } from './fields'

// --- Objects (v0.19): project · entity · tag · subject · user · agent -------------
//
// The structure that organizes engrams, read and written through one generic
// path (eml_read_object / eml_create_object / eml_update_object, REST
// /object/<object>). Each kind takes only its own fields; an unknown field
// errors with the list of allowed ones. v0.20: users and agents are objects too
// (decision write-command-set); writes go through the object commands.

export const OBJECT_KINDS = ['project', 'entity', 'tag', 'subject', 'user', 'agent'] as const
export type ObjectKind = typeof OBJECT_KINDS[number]

type Spec = Record<string, { kind: 'text' | 'text[]' | 'enum' | 'date' | 'map', values?: readonly string[] }>

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
  user: {
    id: { kind: 'text' }, name: { kind: 'text' }, email: { kind: 'text' },
    description: { kind: 'text' }, metadata: { kind: 'map' },
  },
  agent: {
    id: { kind: 'text' }, name: { kind: 'text' }, parent_id: { kind: 'text' },
    domains: { kind: 'text[]' }, description: { kind: 'text' }, metadata: { kind: 'map' },
  },
}

/** Fields that cannot be cleared or changed after create. */
const FIXED_ON_UPDATE: Record<ObjectKind, readonly string[]> = {
  project: ['id'], entity: ['id'], tag: [], subject: [], user: ['id'], agent: ['id'],
}

export function assertObject(object: unknown): asserts object is ObjectKind {
  if (!(OBJECT_KINDS as readonly unknown[]).includes(object)) {
    throw new Error(`Invalid object: unknown object "${String(object)}". One of ${OBJECT_KINDS.join(', ')}.`)
  }
}

export function checkFields(object: ObjectKind, input: Record<string, unknown>, mode: 'create' | 'update'): void {
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

export function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
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
      case 'user': {
        const u = eml.users.get(opts.id)
        return u ? { ...u, engram_count: scopeCount(eml, `user.${u.id}`) } : null
      }
      case 'agent': {
        const a = eml.agents.get(opts.id)
        return a ? { ...a, engram_count: scopeCount(eml, `agent.${a.id}`) } : null
      }
    }
  }
  const statuses: Record<ObjectKind, readonly string[]> = {
    project: ['active', 'paused', 'archived'], entity: ['active', 'archived'], tag: ['active', 'archived'], subject: ['active', 'closed'],
    user: [], agent: [],
  }
  if (opts.status !== undefined && !statuses[object].includes(opts.status)) {
    throw new Error(statuses[object].length === 0
      ? `Invalid object: ${object === 'agent' ? 'an' : 'a'} ${object} has no status.`
      : `Invalid object: status for ${object} is one of ${statuses[object].join(', ')}.`)
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
    case 'user':
      return eml.users.list().map(u => ({ ...u, engram_count: scopeCount(eml, `user.${u.id}`) }))
    case 'agent':
      return eml.agents.list().map(a => ({ ...a, engram_count: scopeCount(eml, `agent.${a.id}`) }))
  }
}
