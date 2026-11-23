import Database from 'better-sqlite3'
import { canonicalJson } from '@engramprotocol/protocol/log'
import { EML } from '../index'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { initDatabase } from '../database'
import type { Actor } from '../env'
import { readFrozenLog, type FrozenLog, type FrozenRefusal } from '../contract/frozen'
import { rebuild } from './rebuild'
import { stateDump, stateHash } from './snapshot'

// --- The self-test of a build (schema 22) -------------------------------------------
//
// The contract id says which shape tables a build has; what its code does with
// a valid entry it does not say. So a build replays the frozen log of its
// schema when it starts: the log must come to the state it was frozen with,
// and the writes frozen as refused must be refused with the same answers. A
// build that fails derives another state from the same log than the release
// does, and must not write to a shared brain (the sync client's gate).
//
// It covers what the frozen log exercises, in memory, and touches no brain.

/** The brain id the frozen log was written in. */
export const FROZEN_BRAIN = '6f1d2c3b-4a59-4e68-9b7a-0c1d2e3f4a5b'
/** The time the refused writes are tried at: after every entry of the log. */
export const FROZEN_LATER = '2026-11-20T08:00:00.000Z'

const INSERT_ENTRY = 'INSERT INTO op_log (seq, at, op_id, prev_hash, payload_hash, hash, signature, rejected, payload) VALUES (@seq, @at, @op_id, @prev_hash, @payload_hash, @hash, NULL, NULL, @payload)'
const INSERT_GENESIS = 'INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (1, ?, ?, ?)'

/** The frozen log as a brain in memory: its log loaded as stored, its state rebuilt from it. The caller closes it. */
export function replayFrozenLog(frozen: FrozenLog): Database.Database {
  const genesis = [frozen.schema, frozen.genesis.state_hash, Buffer.from(frozen.genesis.data, 'base64')]
  const log = initDatabase(':memory:', undefined, FROZEN_BRAIN, { log: false })
  const brain = new Database(':memory:')
  try {
    const insert = log.prepare(INSERT_ENTRY)
    for (const entry of frozen.entries) insert.run(entry)
    log.prepare(INSERT_GENESIS).run(...genesis)

    rebuild(brain, log)
    const keep = brain.prepare(INSERT_ENTRY)
    for (const entry of frozen.entries) keep.run(entry)
    brain.prepare(INSERT_GENESIS).run(...genesis)
    return brain
  } catch (err) {
    brain.close()
    throw err
  } finally {
    log.close()
  }
}

/** What the brain answers to a write it must refuse; throws when it takes the write. */
export function refusalOf(eml: EML, name: string, input: unknown, actor: Actor): FrozenRefusal['error'] {
  try {
    eml.apply({ name, input } as never, { now: () => FROZEN_LATER, newId: () => '99999999-0000-4000-8000-000000000000', actor })
  } catch (err) {
    const e = err as { code?: string, message: string, data?: unknown }
    return { code: e.code ?? 'ERROR', message: e.message, data: e.data ?? null }
  }
  throw new Error(`${name} was not refused`)
}

export type SelfTestResult =
  | { ok: true, schema: number, entries: number, state_hash: string }
  | { ok: false, schema: number, problem: string }

/**
 * Replays the frozen log this build ships and retries its refused writes.
 * `frozen` is the shipped file unless a test passes another one.
 */
export function selfTest(frozen?: FrozenLog): SelfTestResult {
  const schema = CURRENT_BRAIN_SCHEMA_VERSION
  let brain: Database.Database | undefined
  // the frozen log's own warnings (an unresolved wikilink it writes on purpose) are not this start's
  const warn = console.warn
  console.warn = () => {}
  try {
    frozen ??= readFrozenLog()
    if (frozen.schema !== schema) return { ok: false, schema, problem: `the frozen log is of schema ${frozen.schema}` }
    brain = replayFrozenLog(frozen)
    const replayed = stateHash(stateDump(brain))
    if (replayed !== frozen.state_hash) {
      return { ok: false, schema, problem: `the frozen log replays to state ${replayed}, it was frozen at ${frozen.state_hash}` }
    }
    const eml = EML.fromConnection(brain, 'self-test')
    for (const { name, input, actor, error } of frozen.refused) {
      const what = `${name} ${JSON.stringify(input).slice(0, 80)}`
      let answer: FrozenRefusal['error']
      try {
        answer = refusalOf(eml, name, input, actor)
      } catch {
        return { ok: false, schema, problem: `a write the frozen log refuses was taken: ${what}` }
      }
      if (canonicalJson(answer) !== canonicalJson(error)) {
        return { ok: false, schema, problem: `a write the frozen log refuses is answered differently: ${what}` }
      }
    }
    return { ok: true, schema, entries: frozen.entries.length, state_hash: replayed }
  } catch (err) {
    return { ok: false, schema, problem: `the frozen log cannot be replayed: ${(err as Error).message}` }
  } finally {
    console.warn = warn
    brain?.close()
  }
}
