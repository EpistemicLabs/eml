import type { EngramType } from './types'

// --- The engram field model (v0.19) ----------------------------------------------
//
// Every engram type has a fixed set of fields. They are stored in `properties`,
// but properties is no longer free: a write may only carry the fields of its
// type, with the values the field allows. This file is the one place that says
// what they are — core enforces it for every surface (MCP, REST, CLI), and the
// v0.19 migration folded what existed before into these fields.
//
// What is not here: the columns every engram has (content, scope, title, status,
// tags, subjects) and the write-time inputs that are not stored as a field
// (supersedes, task_id, parent_id, from_learning, keep, review_note, …), which
// the write paths take as their own parameters.

export type FieldKind = 'text' | 'text[]' | 'enum' | 'bool' | 'date' | 'map'

export interface FieldSpec {
  kind: FieldKind
  /** enum: the allowed values. */
  values?: readonly string[]
  /** text: the maximum length in characters. */
  max?: number
  /** Required on create (further conditional requirements live in the write path). */
  required?: boolean
}

export const BINDINGS = ['task', 'standing'] as const
export type Binding = typeof BINDINGS[number]

export const RULE_TYPES = ['constraint', 'process', 'convention', 'behavior', 'security'] as const
export const APPLIES = ['always', 'situational'] as const
export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export const STAGES = ['ideation', 'planning', 'ready', 'implementation'] as const
/** v0.19: the checked list (launched → released; incident and other for what the list does not cover). */
export const CHANGE_TYPES = [
  'created', 'started', 'completed', 'released', 'deployed', 'failed', 'incident', 'paused', 'resumed', 'deleted', 'other',
] as const

/** Engram origins the software writes (the cockpit notes pane, review triage, the default brain). */
export const ORIGINS = ['cockpit-notes', 'cockpit-review-triage', 'eml-default-brain'] as const
/** The origin of the default-brain seeds: its rules wait for the user's agreement (getting-started). */
export const SEED_ORIGIN = 'eml-default-brain'

const text = (o: Omit<FieldSpec, 'kind'> = {}): FieldSpec => ({ kind: 'text', ...o })
const list = (o: Omit<FieldSpec, 'kind'> = {}): FieldSpec => ({ kind: 'text[]', ...o })
const date = (o: Omit<FieldSpec, 'kind'> = {}): FieldSpec => ({ kind: 'date', ...o })
const oneOf = (values: readonly string[], o: Omit<FieldSpec, 'kind' | 'values'> = {}): FieldSpec => ({ kind: 'enum', values, ...o })

export const TYPE_FIELDS: Record<EngramType, Record<string, FieldSpec>> = {
  decision: {
    rationale: text({ required: true }),
    alternatives: list({ required: true }),
    binding: oneOf(BINDINGS),
    review_due_at: date(),
    detail: text(),
  },
  rule: {
    applies: oneOf(APPLIES, { required: true }),
    trigger: text({ max: 80 }),
    why: text({ required: true }),
    agreed: text({ required: true }),
    rule_type: oneOf(RULE_TYPES),
    detail: text(),
    review_due_at: date(),
  },
  profile: {
    core: { kind: 'bool' },
    detail: text(),
    review_due_at: date(),
  },
  status: {
    state: text({ required: true }),
    next_step: text(),
    blockers: list(),
    detail: text(),
  },
  task: {
    context: text(),
    priority: oneOf(TASK_PRIORITIES),
    assignee_id: text(),
    due_date: date(),
    blockers: list(),
    stage: oneOf(STAGES),
    outcome: text(),
  },
  event: {
    occurred_at: date({ required: true }),
    change_type: oneOf(CHANGE_TYPES, { required: true }),
    source_url: text(),
    detail: text(),
  },
  log: {
    what: text({ required: true }),
    landed: text({ required: true }),
    next: text({ required: true }),
    open_threads: list(),
    detail: text(),
  },
  reference: {
    source: text({ required: true }),
    source_name: text(),
    checked_at: date(),
    detail: text(),
  },
  note: {
    binding: oneOf(BINDINGS),
    detail: text(),
  },
  learning: {},
}

/**
 * Keys an older client still sends (removed in v0.19). An unknown key from this
 * list means the client predates the tool surface: the error says to upgrade.
 */
export const REMOVED_KEYS: ReadonlySet<string> = new Set([
  'significance', 'properties', 'kind', 'source_id', 'source_type', 'boot', 'applies_to',
  'decision_type', 'profile_type', 'reference_type', 'researched_at', 'accessed_at', 'url',
  'ingestion_method', 'session_id', 'type',
])

export const UPGRADE_HINT = 'This client predates EML v0.19 — upgrade @engramprotocol/mcp-server to ≥ 0.19.'

const article = (type: string) => (/^[aeio]/.test(type) ? 'an' : 'a')

/** "Invalid engram: unknown field(s) … for a <type>. Allowed: …" (+ the upgrade hint for removed keys). */
export function unknownFieldsError(type: string, unknown: string[], allowed: readonly string[]): Error {
  const removed = unknown.some(k => REMOVED_KEYS.has(k))
  return new Error(
    `Invalid engram: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} for ${article(type)} ${type}. ` +
    `Allowed: ${allowed.join(', ')}.${removed ? ` ${UPGRADE_HINT}` : ''}`,
  )
}

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T')))
}

/** One field's value against its spec; null is a clear (handled by the caller). Returns a problem or null. */
export function fieldProblem(name: string, spec: FieldSpec, value: unknown): string | null {
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string') return `${name} must be text.`
      if (spec.max !== undefined && value.length > spec.max) return `${name} is at most ${spec.max} characters (got ${value.length}).`
      return null
    case 'text[]':
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return `${name} must be a list of text.`
      return null
    case 'enum':
      if (typeof value !== 'string' || !spec.values!.includes(value)) return `${name} must be one of ${spec.values!.join(', ')}.`
      return null
    case 'bool':
      if (typeof value !== 'boolean') return `${name} must be true or false.`
      return null
    case 'date':
      if (typeof value !== 'string' || !isIsoDate(value)) return `${name} must be an ISO date (YYYY-MM-DD or a full timestamp).`
      return null
    case 'map':
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value as Record<string, unknown>).some(v => typeof v !== 'string')) {
        return `${name} must be a flat map of text values.`
      }
      return null
  }
}

/** True when a required text / list field has no content. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return !value.some(v => typeof v === 'string' && v.trim() !== '')
  return false
}

/**
 * Check the typed fields of a write. `fields` holds only the type's fields (the
 * caller split them from the universal ones). On create, required fields must
 * be there; on update a null clears an optional field and a required one
 * cannot be cleared. Throws `Invalid engram: …` naming every problem.
 */
export function validateFields(type: EngramType, fields: Record<string, unknown>, mode: 'create' | 'update', notRequired: readonly string[] = []): void {
  const specs = TYPE_FIELDS[type]
  const unknown = Object.keys(fields).filter(k => !(k in specs))
  if (unknown.length > 0) throw unknownFieldsError(type, unknown, Object.keys(specs))
  const problems: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    const value = fields[name]
    if (value === undefined) {
      if (mode === 'create' && spec.required && !notRequired.includes(name)) problems.push(`${article(type)} ${type} needs ${name}.`)
      continue
    }
    if (value === null) {
      if (spec.required) problems.push(`${name} is required and cannot be cleared.`)
      continue
    }
    const p = fieldProblem(name, spec, value)
    if (p) { problems.push(p); continue }
    if (spec.required && isBlank(value)) problems.push(`${name} must not be empty.`)
  }
  if (problems.length > 0) throw new Error(`Invalid engram: ${problems.join(' ')}`)
}

/** Split a flat write body into the type's fields and everything else. */
export function splitFields(type: EngramType, body: Record<string, unknown>): { fields: Record<string, unknown>, rest: Record<string, unknown> } {
  const specs = TYPE_FIELDS[type]
  const fields: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue
    if (k in specs) fields[k] = v
    else rest[k] = v
  }
  return { fields, rest }
}
