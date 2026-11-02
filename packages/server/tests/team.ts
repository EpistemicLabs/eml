import type Database from 'better-sqlite3'
import {
  GENESIS_PREV_HASH, applyMembership, certifyDevice, clearOp, genesisMembers, keyId, newBrainKey, newDeviceKeys, newSigningKey,
  openRecord, rotateKey, sealHandle, sealOp, wrapKey,
  type BrainKey, type DeviceKeys, type KeyPair, type MemberSet, type TeamOp,
} from '@engramprotocol/protocol'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { Replica } from '../src/sync/replica'

// A team brain to play through in the sync tests: people, their records built
// with the protocol package, and a brain that replicates it.

export const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e'
export const T0 = Date.parse('2026-10-28T08:00:00.000Z')
export const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }

export interface Person { identity: KeyPair, device: DeviceKeys, handle: string }
export const person = (handle: string): Person => ({ identity: newSigningKey(), device: newDeviceKeys(), handle })
export const cert = (p: Person) => certifyDevice(p.identity, { brain: BRAIN, device_sign: p.device.sign.publicKey, device_enc: p.device.enc.publicKey, created_at: '2026-10-28T08:00:00.000Z' })
export const json = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value))
export const time = (seq: number): string => new Date(T0 + seq * 1000).toISOString()

/**
 * A team brain: its owner juno, whose device this replica runs on, the brain
 * keys, and the member set as the relay's log has it. Records are built
 * against the replica's own log (base_seq = its head).
 */
export class Team {
  readonly owner = person('juno')
  readonly keys: BrainKey[] = [newBrainKey(0)]
  readonly db: Database.Database
  replica: Replica
  set!: MemberSet

  constructor() {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    this.db = (eml as any).db
    this.db.exec('DELETE FROM op_snapshots; DELETE FROM op_log')  // a new brain file writes a private genesis
    this.replica = new Replica(this.db, { v: 1, brain: BRAIN, relay: 'wss://relay.test', device: this.owner.device })
  }

  get head(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM op_log').get() as { n: number }).n
  }

  /** The genesis: juno founds the brain as its root, epoch 0, at the empty state. */
  genesis(): Record<string, unknown> {
    const op_id = crypto.randomUUID()
    const member = this.owner.identity.publicKey
    const record = json(clearOp(this.envelope(this.owner, 'brain.genesis', {
      brain: BRAIN,
      state_hash: EML.fromConnection(this.db, 'test').stateHash(),
      root: { member, device_cert: cert(this.owner), handle: sealHandle(this.owner.handle, { brain: BRAIN, op_id, member }, this.keys[0]), key_id: keyId(this.keys[0].key) },
    }, op_id), this.owner.device.sign).record)
    this.set = genesisMembers(openRecord(record, BRAIN, () => undefined))
    return record
  }

  /** A sealed op by `author` (default: an engram.create titled `title`) under the current epoch. */
  write(author: Person, title: string, opts: { epoch?: number, handle?: string, args?: unknown, call?: string, schema?: number, team?: Partial<TeamOp['team']> } = {}): Record<string, unknown> {
    const env = this.envelope(author, opts.call ?? 'engram.create', opts.args ?? validNote({ title }), crypto.randomUUID(), opts.team)
    env.provenance = { ...NONE, handle: opts.handle ?? author.handle, ingestion_method: 'mcp' }
    if (opts.schema !== undefined) env.schema = opts.schema
    return json(sealOp(env, author.device.sign, this.keys[opts.epoch ?? this.set.epoch]).record)
  }

  /** juno adds `joiner`; the relay's member set follows (unless it refuses the record). */
  addMember(joiner: Person): Record<string, unknown> {
    const op_id = crypto.randomUUID()
    const member = joiner.identity.publicKey
    const handle = sealHandle(joiner.handle, { brain: BRAIN, op_id, member }, this.keys[this.set.epoch])
    return this.membership(this.envelope(this.owner, 'team.add_member', { member, role: 'member', device_cert: cert(joiner), handle }, op_id))
  }

  /** juno rotates to the next brain key; the relay's member set follows. */
  rotate(): Record<string, unknown> {
    const { next, args } = rotateKey(this.set, this.keys[this.set.epoch])
    this.keys.push(next)
    return this.membership(this.envelope(this.owner, 'team.rotate_key', args))
  }

  /** The key of `epoch`, wrapped by juno for `device` (default: this replica's). */
  wrapped(epoch: number, device = this.owner.device): unknown {
    return json(wrapKey(this.set, this.keys[epoch], device.sign.publicKey, this.owner.device.sign))
  }

  deliver(record: unknown, seq = this.head + 1, at = time(seq)) {
    return this.replica.take({ seq, at, record })
  }

  private membership(env: TeamOp): Record<string, unknown> {
    const record = json(clearOp(env, this.owner.device.sign).record)
    try {
      this.set = applyMembership(this.set, openRecord(record, BRAIN, () => undefined))
    } catch {
      // a record the member set refuses: the log keeps it, the set stays
    }
    return record
  }

  private envelope(author: Person, call: string, args: unknown, op_id: string = crypto.randomUUID(), team: Partial<TeamOp['team']> = {}): TeamOp {
    const head = this.head
    const link = head === 0 ? GENESIS_PREV_HASH : (this.db.prepare('SELECT hash FROM op_log WHERE seq = ?').get(head) as { hash: string }).hash
    return {
      op_id, schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never, provenance: NONE,
      team: { brain: BRAIN, device: author.device.sign.publicKey, base_seq: head, head_hash: link, ...team },
    }
  }
}
