import type Database from 'better-sqlite3'
import { provenanceProblem, type Json, type OpEnvelope, type Provenance } from '@engramprotocol/protocol/log'
import type { EML } from '../index'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { runCommand, type CommandMap, type CommandName } from '../commands'
import { asCommandError, type CommandContext } from '../commands/types'
import type { Actor, Env } from '../env'
import { INGESTION_METHODS } from '../types'
import { RelayOrderError, appendOp, appendRelayed, teamBrainOf, type RelayedEntry } from './log'
import { stateDump, stateHash, encodeSnapshot } from './snapshot'
import { opIds } from './op'

// --- Writes through the log (v0.21) ----------------------------------------------
//
// Every brain write is an op: appended to the log, then applied, in one
// transaction. The command runs on the args as the log stores them, at the
// entry's time, with ids derived from the op_id — so a replay of the entry
// does exactly what the write did. A private brain logs only applied writes:
// a rejection rolls back the entry with everything else. A shared brain is
// written through its relay and keeps every relayed entry, rejected ones too.

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
 * One write to a private brain: the command as an op from `env` (op_id,
 * actor), sequenced under the write lock (IMMEDIATE, also against another
 * process on the file), then applied. Throws what the command throws; nothing
 * is written then. A shared brain refuses it: its writes go through the relay.
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
      if (teamBrainOf(stores.db) !== null) throw new Error('Invalid command: a shared brain is written through its relay, not locally.')
      const entry = appendOp(stores.db, op, env.now())
      return applyOp(stores, JSON.parse(entry.payload) as OpEnvelope, entry.at, null) as CommandMap[N][1]
    }).immediate()
  } catch (err) {
    throw asCommandError(err)
  }
}

/**
 * Applies a logged op inside the caller's transaction: its args as stored, at
 * its time, with its derived ids and its author. `teamBrain` is the team brain
 * the log belongs to (teamBrainOf), null for a private brain: an op carries
 * team fields exactly in a shared brain, for that brain. Membership records
 * and checkpoints change no brain table and run nothing; a genesis only starts
 * a log.
 */
export function applyOp(stores: Stores, op: OpEnvelope, at: string, teamBrain: string | null): unknown {
  if (op.call === 'brain.genesis') throw new Error('Invalid command: brain.genesis only starts a log.')
  const opBrain = op.team?.brain ?? null
  if (opBrain !== teamBrain) {
    throw new Error(teamBrain === null ? 'Invalid command: a private brain takes no op with team fields.'
      : opBrain === null ? 'Invalid command: a shared brain takes only ops with team fields.'
      : `Invalid command: the op is for team brain ${opBrain}, not ${teamBrain}.`)
  }
  if (op.call.startsWith('team.') || op.call === 'brain.checkpoint') return undefined
  return runCommand(stores, { name: op.call as CommandName, input: op.args as never }, { now: () => at, newId: opIds(op.op_id), actor: actorOf(op.provenance) })
}

/**
 * Takes one relayed entry of a shared brain (spec team-brain-sync-client-spec
 * §4): appended at its seq and time and, unless the replica already refused
 * it (entry.rejected), `op` applied — in one transaction. An op the brain
 * refuses is kept as rejected ("INVALID: …"); returns why the entry was
 * rejected, or null when it was applied. The genesis at seq 1 founds the log: the brain must be
 * in the state it names, which becomes the snapshot at seq 1. Throws
 * RelayOrderError for an entry out of order and Error for a genesis whose
 * state is not this brain's: the replica stops.
 */
export function takeRelayed(stores: Stores, entry: RelayedEntry, op: OpEnvelope | null): string | null {
  const { db } = stores
  if (entry.rejected !== null) {
    db.transaction(() => appendRelayed(db, entry))()
    return entry.rejected
  }
  if (op === null) throw new Error('a relayed entry is applied with its op or kept as rejected')
  if (entry.seq === 1 && op.call === 'brain.genesis') {
    db.transaction(() => {
      appendRelayed(db, entry)
      const dump = stateDump(db)
      const hash = stateHash(dump)
      if (hash !== (op.args as { state_hash?: unknown }).state_hash) throw new Error('the genesis names another state than this brain\'s')
      db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (1, ?, ?, ?)').run(op.schema, hash, encodeSnapshot(dump))
    })()
    return null
  }
  try {
    db.transaction(() => { appendRelayed(db, entry); applyOp(stores, op, entry.at, teamBrainOf(db)) })()
    return null
  } catch (err) {
    if (err instanceof RelayOrderError) throw err
    const why = `INVALID: ${(err as Error).message}`
    db.transaction(() => appendRelayed(db, { ...entry, rejected: why }))()
    return why
  }
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
  if (provenance.agent !== null && !AGENT.test(provenance.agent)) {
    throw new Error('Invalid command: the op\'s provenance.agent is 1–63 characters of a-z, 0-9, _ and -.')
  }
  return provenance as Actor
}

/** An agent as provenance names it: the charset of a member handle and of agent.<id> (decision provenance-agent-field). */
const AGENT = /^[a-z0-9_-]{1,63}$/
