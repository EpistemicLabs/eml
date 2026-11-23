import { canonicalJson, sha256Hex, type Json } from '@engramprotocol/protocol/log'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { ENGRAM_TYPES, INGESTION_METHODS } from '../types'
import { TYPE_FIELDS, ORIGINS, ISO_DATE_FIELD } from '../fields'
import { OBJECT_KINDS, OBJECT_FIELDS, FIXED_ON_UPDATE } from '../objects'
import { EVIDENCE_SOURCES, EVIDENCE_STANCES } from '../entries'
import {
  RULE_CONTENT_MAX_CHARS, PROFILE_CONTENT_MAX_CHARS, RULE_TRIGGER_MAX_CHARS,
  VALID_SCOPE_PATTERNS, PROFILE_SCOPE, RULE_SCOPE, LEARNING_SCOPE,
} from '../validate'
import { LEARNING_CONTENT_MAX_CHARS } from '../engrams'
import { MOVED_COLUMNS } from '../log/move'
import { ISO_MS, ISO_DATE } from '../commands/engram-import'
import { CALL_KEYS, LEARNING_CREATE_KEYS } from './calls'
import {
  RELATION_VERBS, DETECTION_METHODS, TASK_CREATE_STATUSES, UPDATE_STATUSES, TASK_TRACK_STATUSES,
  BRAIN_ID, HANDLE, SET_HASH, OBJECT_ID,
} from './values'
import { readFrozenLog } from './frozen'

// --- The contract of a brain schema (schema 22) -------------------------------------
//
// What an entry must look like to be valid in a brain of this schema, as one
// document: the keys every call takes, the fields of every engram type and
// object kind, the enums, limits and patterns their values are checked
// against, and the state the schema's frozen log replays to. It is generated
// from the tables the commands check with, so a build whose tables differ
// has another document, and its sha256 — the contract id — is another one.
//
// One contract per schema (decision shared-brain-contract-per-schema): the
// document of schema N is checked in as contracts/v<N>.json and
// tests/contract.test.ts compares it with what this code generates. A change
// to the document is a new brain schema.
//
// What it does not cover: rules that depend on the brain's state (existing
// ids, registered tags, the task lifecycle, the learning topic gate) and the
// SQL schema's own constraints. The frozen log exercises those; a build
// replays it when it starts (log/self-test.ts).

const pattern = (re: RegExp): string => `/${re.source}/${re.flags}`

/** The contract of the brain schema this code writes, as plain JSON. */
export function contractDocument(): Json {
  return JSON.parse(JSON.stringify({
    schema: CURRENT_BRAIN_SCHEMA_VERSION,
    frozen_log: { state_hash: readFrozenLog().state_hash },
    calls: { ...CALL_KEYS, 'engram.create (learning)': LEARNING_CREATE_KEYS },
    type_fields: TYPE_FIELDS,
    object_fields: OBJECT_FIELDS,
    object_fields_fixed_on_update: FIXED_ON_UPDATE,
    moved_rows: MOVED_COLUMNS,
    enums: {
      engram_type: ENGRAM_TYPES,
      object_kind: OBJECT_KINDS,
      origin: ORIGINS,
      task_create_status: TASK_CREATE_STATUSES,
      update_status: UPDATE_STATUSES,
      task_track_status: TASK_TRACK_STATUSES,
      relation: RELATION_VERBS,
      detection_method: DETECTION_METHODS,
      evidence_source: EVIDENCE_SOURCES,
      evidence_stance: EVIDENCE_STANCES,
      ingestion_method: INGESTION_METHODS,
    },
    limits: {
      rule_content_chars: RULE_CONTENT_MAX_CHARS,
      rule_trigger_chars: RULE_TRIGGER_MAX_CHARS,
      profile_content_chars: PROFILE_CONTENT_MAX_CHARS,
      learning_content_chars: LEARNING_CONTENT_MAX_CHARS,
    },
    patterns: {
      scope: VALID_SCOPE_PATTERNS.map(pattern),
      profile_scope: pattern(PROFILE_SCOPE),
      rule_scope: pattern(RULE_SCOPE),
      learning_scope: pattern(LEARNING_SCOPE),
      brain_id: pattern(BRAIN_ID),
      handle: pattern(HANDLE),
      set_hash: pattern(SET_HASH),
      object_id: pattern(OBJECT_ID),
      date_field: pattern(ISO_DATE_FIELD),
      moved_time: pattern(ISO_MS),
      moved_date: pattern(ISO_DATE),
    },
  })) as Json
}

/** The contract document as the bytes that are hashed, compared and signed: canonical JSON. */
export function contractJson(): string {
  return canonicalJson(contractDocument())
}

let id: string | undefined

/** The contract id of this build: sha256 of its contract document, as lowercase hex. */
export function contractId(): string {
  return id ??= sha256Hex(contractJson())
}
