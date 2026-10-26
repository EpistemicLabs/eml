import { describe, it, expect, beforeAll } from 'vitest'
import {
  DivergedError, ProtocolError, checkCheckpoint, checkpointArgs, clearOp, openRecord, ready, sealOp, type OpenedOp, type TeamOp,
} from '../src'
import { BRAIN, envelope, found, keyFor, person } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §6, block 7): a checkpoint is
// a sealed op stating the state hash after its author's base_seq; every reader
// compares it with its own.

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

beforeAll(() => ready())

/** ada's checkpoint, sealed and opened as a reader opens it; `args` overrides the stated ones. */
function checkpoint(args?: unknown): { opened: OpenedOp, base_seq: number } {
  const ada = person('ada')
  const { keys } = found(ada)
  const env = envelope(ada, 'brain.checkpoint', {})
  const base_seq = env.team.base_seq
  const op = { ...env, args: (args ?? checkpointArgs(base_seq, HASH_A)) as never } as TeamOp
  const { record } = sealOp(op, ada.device.sign, keys[0])
  return { opened: openRecord(JSON.parse(JSON.stringify(record)), BRAIN, keyFor(keys)), base_seq }
}

describe('checkpoints', () => {
  it('a replica with the same hash after the author\'s base_seq passes; one with another hash has diverged', () => {
    const { opened, base_seq } = checkpoint()
    expect(opened.epoch).toBe(0)  // a checkpoint is sealed: the relay does not see state hashes
    expect(() => checkCheckpoint(opened, s => (s === base_seq ? HASH_A : undefined))).not.toThrow()
    let err: unknown
    try { checkCheckpoint(opened, () => HASH_B) } catch (e) { err = e }
    expect(err).toBeInstanceOf(DivergedError)
    expect(err).toBeInstanceOf(ProtocolError)
    expect((err as DivergedError).seq).toBe(base_seq)
  })

  it('refuses a hash the replica does not have, a seq other than the base_seq, malformed args, another call', () => {
    const { opened, base_seq } = checkpoint()
    expect(() => checkCheckpoint(opened, () => undefined)).toThrow(/no state hash at seq/)
    expect(() => checkCheckpoint(checkpoint({ seq: 1_000_000_000, state_hash: HASH_A }).opened, () => HASH_A)).toThrow(/after its author's base_seq/)
    expect(() => checkCheckpoint(checkpoint({ seq: base_seq + 100, state_hash: 'A'.repeat(64) }).opened, () => HASH_A)).toThrow(/64 lowercase hex/)
    expect(() => checkCheckpoint(checkpoint({ seq: 0, state_hash: HASH_A }).opened, () => HASH_A)).toThrow(/positive integer/)
    expect(() => checkCheckpoint(checkpoint({ state_hash: HASH_A }).opened, () => HASH_A)).toThrow(/lacks seq/)
    expect(() => checkCheckpoint({ ...opened, envelope: { ...opened.envelope, call: 'engram.create' } }, () => HASH_A)).toThrow(/not a checkpoint/)
  })

  it('travels sealed, never in the clear', () => {
    const ada = person('ada')
    expect(() => clearOp(envelope(ada, 'brain.checkpoint', checkpointArgs(1, HASH_A)), ada.device.sign)).toThrow(/travels sealed/)
  })
})
