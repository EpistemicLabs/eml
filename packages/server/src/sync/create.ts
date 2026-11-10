import {
  GENESIS_PREV_HASH, certifyDevice, clearOp, keyId, newBrainKey, newDeviceKeys, newSigningKey, sealHandle,
  type TeamOp,
} from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, NO_ACTOR } from '@engramprotocol/core'
import type { TeamFile } from './team-file'

// --- Creating a team brain (v0.21, spec team-brain-sync-client-spec §5) ---------
//
// The owner's device founds the brain: it makes the member's identity key,
// its own device keys and the epoch-0 brain key, and signs the genesis — the
// brain's id, the hash of the empty state it starts from, and the root: the
// member, its device certificate, its handle sealed under the brain key, and
// the key's id. The genesis goes to the relay with the account's creation
// grant (sync.ts, create mode); the relay's log then delivers it back like
// every record, and the replica founds the brain from it.

/**
 * What a new team brain starts from, for the brain `brain` on `relay`: the
 * team file to keep (identity, device, the genesis with its grant, the
 * epoch-0 key), ready for a Sync in create mode. `stateHash` is the hash of
 * the brain as it is — empty, with no log.
 */
export function createTeamBrain(args: { brain: string, relay: string, grant: string, handle: string, stateHash: string, now: string }): TeamFile {
  const identity = newSigningKey()
  const device = newDeviceKeys()
  const key = newBrainKey(0)
  const op_id = crypto.randomUUID()
  const member = identity.publicKey
  const genesis: TeamOp = {
    op_id,
    schema: CURRENT_BRAIN_SCHEMA_VERSION,
    call: 'brain.genesis',
    args: {
      brain: args.brain,
      state_hash: args.stateHash,
      root: {
        member,
        device_cert: certifyDevice(identity, { brain: args.brain, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: args.now }),
        handle: sealHandle(args.handle, { brain: args.brain, op_id, member }, key),
        key_id: keyId(key.key),
      },
    } as never,
    provenance: NO_ACTOR,
    team: { brain: args.brain, device: device.sign.publicKey, base_seq: 0, head_hash: GENESIS_PREV_HASH },
  }
  const record = clearOp(genesis, device.sign).record as unknown as Record<string, unknown>
  return { v: 1, brain: args.brain, relay: args.relay, device, identity, create: { genesis: record, grant: args.grant }, key }
}
