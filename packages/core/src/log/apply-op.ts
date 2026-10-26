import { CURRENT_BRAIN_SCHEMA_VERSION } from '../control'
import { runCommand, type CommandMap, type CommandName } from '../commands'
import { asCommandError, type CommandContext } from '../commands/types'
import type { Env } from '../env'
import type { Json } from './canonical'
import { appendOp } from './log'
import { opIds, type OpEnvelope } from './op'

// --- Writes through the log (v0.21) ----------------------------------------------
//
// Every brain write is an op: appended to the log, then applied, in one
// transaction. The command runs on the args as the log stores them, at the
// entry's time, with ids derived from the op_id — so a replay of the entry
// does exactly what the write did. Only applied writes stay in the log: a
// rejection rolls back the entry with everything else.

type Stores = Omit<CommandContext, 'stamp'>

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
  return runCommand(stores, { name: op.call as CommandName, input: op.args as never }, { now: () => at, newId: opIds(op.op_id), actor: op.provenance })
}
