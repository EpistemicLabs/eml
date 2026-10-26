import type Database from 'better-sqlite3'
import { provenanceProblem, type Json, type OpEnvelope, type Provenance } from '@engramprotocol/protocol/log'
import type { EML } from '../index'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { runCommand, type CommandMap, type CommandName } from '../commands'
import { asCommandError, type CommandContext } from '../commands/types'
import type { Actor, Env } from '../env'
import { INGESTION_METHODS } from '../types'
import { appendOp } from './log'
import { opIds } from './op'

// --- Writes through the log (v0.21) ----------------------------------------------
//
// Every brain write is an op: appended to the log, then applied, in one
// transaction. The command runs on the args as the log stores them, at the
// entry's time, with ids derived from the op_id — so a replay of the entry
// does exactly what the write did. Only applied writes stay in the log: a
// rejection rolls back the entry with everything else.

type Stores = Omit<CommandContext, 'stamp'>

/** What a command runs against: a brain's reads and stores over its connection — for the live write and a replay. */
export function commandStores(eml: EML, db: Database.Database): Stores {
  return {
    eml, db, store: eml.engrams,
    projects: eml.projects, users: eml.users, agents: eml.agents, entities: eml.entities,
    tags: eml.tags, subjects: eml.subjects,
  }
}

/**
 * One write: the command as an op from `env` (op_id, actor), sequenced under
 * the write lock (IMMEDIATE, also against another process on the file), then
 * applied. Throws what the command throws; nothing is written then.
 */
export function writeOp<N extends CommandName>(stores: Stores, command: { name: N, input: CommandMap[N][0] }, env: Env): CommandMap[N][1] {
  try {
    const op: OpEnvelope = {
      op_id: env.newId(),
      schema: CURRENT_BRAIN_SCHEMA_VERSION,
      call: command.name,
      args: command.input as unknown as Json,
      provenance: env.actor,
    }
    return stores.db.transaction(() => {
      const entry = appendOp(stores.db, op, env.now())
      return applyOp(stores, JSON.parse(entry.payload) as OpEnvelope, entry.at) as CommandMap[N][1]
    }).immediate()
  } catch (err) {
    throw asCommandError(err)
  }
}

/** Applies a logged op inside the caller's transaction: its args as stored, at its time, with its derived ids and its author. */
export function applyOp(stores: Stores, op: OpEnvelope, at: string): unknown {
  return runCommand(stores, { name: op.call as CommandName, input: op.args as never }, { now: () => at, newId: opIds(op.op_id), actor: actorOf(op.provenance) })
}

/**
 * The actor an op writes as: its provenance, checked field by field — in a
 * shared brain the payload is another member's, so its shape and values are
 * not taken on trust.
 */
function actorOf(provenance: Provenance): Actor {
  const problem = provenanceProblem(provenance)
  if (problem) throw new Error(`Invalid command: the op's ${problem}.`)
  const method = provenance.ingestion_method
  if (method !== null && !(INGESTION_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Invalid command: the op's provenance.ingestion_method "${method}" is not one of ${INGESTION_METHODS.join(', ')}.`)
  }
  return provenance as Actor
}
