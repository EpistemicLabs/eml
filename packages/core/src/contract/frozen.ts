import { readFileSync } from 'fs'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { CONTRACTS_DIR } from '../database'
import type { Actor } from '../env'

// --- The frozen log of a brain schema ----------------------------------------------
//
// contracts/log-v<N>.json: a log that calls every command, the hash of the
// state it replays to, and writes the brain refuses on that state with what it
// answers. It ships with every build: the tests replay it
// (tests/frozen-log.test.ts), and so does the build itself when it starts
// (log/self-test.ts). The contract document names its state hash.

export interface FrozenEntry { seq: number, at: string, op_id: string, prev_hash: string, payload_hash: string, hash: string, payload: string }
export interface FrozenRefusal { name: string, input: unknown, actor: Actor, error: { code: string, message: string, data: unknown } }
export interface FrozenLog {
  schema: number
  state_hash: string
  /** the genesis snapshot's stored bytes, base64 */
  genesis: { state_hash: string, data: string }
  entries: FrozenEntry[]
  refused: FrozenRefusal[]
}

/** Where the frozen log of `schema` lives. */
export function frozenLogFile(schema: number = CURRENT_BRAIN_SCHEMA_VERSION): string {
  return join(CONTRACTS_DIR, `log-v${schema}.json`)
}

/** The frozen log this build ships for its schema. Throws when the file is missing or not JSON. */
export function readFrozenLog(): FrozenLog {
  return JSON.parse(readFileSync(frozenLogFile(), 'utf-8')) as FrozenLog
}
