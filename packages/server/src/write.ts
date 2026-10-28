import type { CommandMap, CommandName, EML, Env } from '@engramprotocol/core'

/**
 * The server's one write seam (v0.21, spec team-brain-sync-client-spec §4).
 * Every write route runs its command here. A private brain writes directly
 * (eml.apply). A shared brain is written through its relay; until this server
 * has a connection to it, the brain is read-only and the write is refused.
 */
export function applyWrite<N extends CommandName>(eml: EML, command: { name: N, input: CommandMap[N][0] }, env: Env): CommandMap[N][1] {
  if (eml.teamBrain() !== null) throw new SharedBrainReadOnly('it is not connected to its relay')
  return eml.apply(command, env)
}

/** A write to a shared brain that cannot take writes right now (503 SHARED_BRAIN_READ_ONLY); reads still work. */
export class SharedBrainReadOnly extends Error {
  readonly code = 'SHARED_BRAIN_READ_ONLY'
  constructor(reason: string) {
    super(`This shared brain is read-only right now: ${reason}. Reads still work; try the write again once it is back.`)
  }
}
