// --- The keys of every call (schema 22) --------------------------------------------
//
// What the input of each command may carry: its keys, and for a nested object
// its keys in turn. This file is the one place that says so; every command
// checks its input against its table with unknownKeys, and the contract
// document (document.ts) is generated from the same tables. A key that is not
// in the table is refused, whatever its value — a command never ignores one.
//
// A command runs on its args as the log stores them (JSON), so a key is either
// there with a JSON value or absent: there is no undefined to tell apart.
//
// The values a key takes are checked by the command itself, with the enums,
// limits and patterns the contract document lists next to these tables.

/**
 * What a key holds:
 *   value         — a value the command checks (text, a list, a number …)
 *   map           — an object with free keys (a relation's metadata, an engram's app state)
 *   type_fields   — the fields of the engram's type (fields.ts TYPE_FIELDS)
 *   object_fields — the fields of the object's kind (objects.ts OBJECT_FIELDS)
 *   moved_rows    — the tables and columns of a cross-brain move (log/move.ts MOVED_COLUMNS)
 *   Keys          — an object with exactly these keys
 */
export type KeySpec = 'value' | 'map' | 'type_fields' | 'object_fields' | 'moved_rows' | Keys
export interface Keys { readonly [key: string]: KeySpec }

/** The keys of `input` that `keys` does not name. An own-key lookup: a name every object inherits (toString, constructor …) is unknown like any other. */
export function unknownKeys(input: object, keys: object): string[] {
  return Object.keys(input).filter(k => !Object.hasOwn(keys, k))
}

/** The evidence of a learning: one incident. */
const EVIDENCE_KEYS = { source: 'value', happened: 'value', quote: 'value', stance: 'value', rule_id: 'value' } as const satisfies Keys

/** engram.create of a learning: the lesson, and its first evidence under `evidence`. */
export const LEARNING_CREATE_KEYS = {
  type: 'value', scope: 'value', title: 'value', content: 'value', tags: 'value', subjects: 'value', new_topic: 'value',
  evidence: EVIDENCE_KEYS,
} as const satisfies Keys

export const CALL_KEYS = {
  /** Every type but learning (LEARNING_CREATE_KEYS); which of these a type takes is the command's rule. */
  'engram.create': {
    type: 'value', content: 'value', scope: 'value', title: 'value', status: 'value', properties: 'type_fields',
    tags: 'value', subjects: 'value', parent_id: 'value', task_id: 'value', supersedes: 'value', from_learning: 'value',
    origin: 'value', app: 'map',
  },
  'engram.update': {
    id: 'value',
    patch: {
      content: 'value', title: 'value', scope: 'value', status: 'value', properties: 'type_fields',
      tags: 'value', subjects: 'value', supersedes: 'value', review_note: 'value', app: 'map',
    },
    base_rev: 'value',
  },
  'engram.rescope': { ids: 'value', scope: 'value' },
  'engram.retag': { ids: 'value', add: 'value', remove: 'value' },
  'task.track': {
    id: 'value', base_rev: 'value',
    text: 'value', status: 'value', outcome: 'value', keep: 'value', stage: 'value', content: 'value', title: 'value',
    intent: 'value', context: 'value', priority: 'value', assignee_ids: 'value', due_date: 'value', blockers: 'value',
    parent_id: 'value', scope: 'value', supersedes: 'value', tags: 'value', subjects: 'value',
  },
  'learning.add_evidence': { id: 'value', ...EVIDENCE_KEYS, content: 'value' },
  'engram.confirm_review': { id: 'value', text: 'value' },
  'relation.create': {
    source_id: 'value', target_id: 'value', relation: 'value', detection_method: 'value', strength: 'value',
    explanation: 'value', metadata: 'map', source_brain: 'value', target_brain: 'value',
  },
  'object.create': { object: 'value', fields: 'object_fields' },
  'object.update': { object: 'value', id: 'value', patch: 'object_fields' },
  'engram.import': { source: { brain: 'value', head_seq: 'value' }, set_hash: 'value', rows: 'moved_rows' },
  'engram.move_out': { ids: 'value', set_hash: 'value', drop_relations: 'value', target: { brain: 'value', op_id: 'value' } },
  'provenance.restamp': { from_handle: 'value', to_handle: 'value', agent: 'value' },
  'relation.move_end': { from_brain: 'value', to_brain: 'value', relations: 'value' },
} as const satisfies Record<string, Keys>

/** "unknown field x" / "unknown fields x, y" — the start every unknown-key answer shares. */
export function unknownFieldsText(unknown: string[]): string {
  return `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`
}

/** "a, b and c" — a call's keys as its unknown-key answer names them. */
export function keyList(keys: object): string {
  const names = Object.keys(keys)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('')
}
