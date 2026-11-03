import type { CommandMap, CommandName, EML, Env } from '@engramprotocol/core'
import type { Sync } from './sync/sync'

/**
 * The server's one write seam (v0.21, spec team-brain-sync-client-spec §4).
 * Every write route runs its command here. A private brain writes directly
 * (eml.apply). A shared brain is written through its relay (`sync`, a
 * confirmed write); without a live connection it is read-only. A brain whose
 * team file exists but cannot be used (`sync` an Error) is shared and
 * read-only until the user fixes it. A brain without a genesis — an empty
 * brain only /team/create or /team/join act on — takes no write either.
 */
export async function applyWrite<N extends CommandName>(eml: EML, command: { name: N, input: CommandMap[N][0] }, env: Env, sync: Sync | Error | undefined): Promise<CommandMap[N][1]> {
  if (sync instanceof Error) throw readOnly(`it stopped: its team file cannot be used (${sync.message})`, true)
  if (sync) return await sync.write(command, env) as CommandMap[N][1]
  // a brain with a sync is shared even before its genesis arrived from the relay
  if (eml.teamBrain() !== null) throw readOnly('it is not connected to its relay')
  if (!eml.hasGenesis()) throw readOnly('it is not created yet')
  return eml.apply(command, env)
}

/** A write to a shared brain that did not happen as asked: its HTTP status, code and the text the caller reads. */
export class SharedWriteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SharedWriteError'
  }
}

/**
 * 503 SHARED_BRAIN_READ_ONLY: the shared brain takes no write right now; reads
 * still work. `lasting` when it does not clear up by itself and needs the user.
 */
export function readOnly(reason: string, lasting = false): SharedWriteError {
  const next = lasting ? 'this needs the user — tell them' : 'try the write again once it is back'
  return new SharedWriteError(503, 'SHARED_BRAIN_READ_ONLY', `This shared brain is read-only right now: ${reason}. Reads still work; ${next}.`)
}
