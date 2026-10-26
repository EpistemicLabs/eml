import { ProtocolError, asObject, exactFields } from './sodium'
import type { OpenedOp } from './seal'

// --- Checkpoints (v0.21) ---------------------------------------------------------
//
// A member states the hash of the brain's state as their replica has it:
// `brain.checkpoint {seq, state_hash}`, a sealed op whose seq is the author's
// base_seq — the state after that entry. state_hash is core's stateHash (the
// canonical row dump; spec team-brain-protocol-package-spec §6). Every reader
// compares it with its own hash at that seq: a new device that replayed the
// log learns that it reached the state another member signed, and replicas
// that went apart find out (spec §6).

/** A checkpoint whose hash is not this replica's: the replicas went apart at or before `seq`; the brain stops. */
export class DivergedError extends ProtocolError {
  constructor(readonly seq: number) {
    super(`the state at seq ${seq} differs from the checkpoint`)
    this.name = 'DivergedError'
  }
}

const HASH = /^[0-9a-f]{64}$/

/** The args of a checkpoint for the state after `seq` (the author's base_seq). */
export function checkpointArgs(seq: number, stateHash: string): { seq: number, state_hash: string } {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new ProtocolError('seq is a positive integer')
  if (!HASH.test(stateHash)) throw new ProtocolError('state_hash is 64 lowercase hex digits')
  return { seq, state_hash: stateHash }
}

/**
 * Checks an opened `brain.checkpoint` against this replica: exactly {seq,
 * state_hash}, seq the author's base_seq, and the state hash this replica
 * had after that seq (`stateHashAt`). Throws ProtocolError for a malformed
 * checkpoint and DivergedError when the hashes differ.
 */
export function checkCheckpoint(opened: OpenedOp, stateHashAt: (seq: number) => string | undefined): void {
  const { envelope } = opened
  if (envelope.call !== 'brain.checkpoint') throw new ProtocolError(`${envelope.call} is not a checkpoint`)
  const args = asObject(envelope.args, 'the checkpoint args')
  exactFields(args, ['seq', 'state_hash'], 'the checkpoint args')
  checkpointArgs(args.seq as number, args.state_hash as string)
  if (args.seq !== envelope.team.base_seq) throw new ProtocolError('a checkpoint states the state after its author\'s base_seq')
  const own = stateHashAt(args.seq as number)
  if (own === undefined) throw new ProtocolError(`this replica has no state hash at seq ${String(args.seq)}`)
  if (own !== args.state_hash) throw new DivergedError(args.seq as number)
}
