import type Database from 'better-sqlite3'
import {
  DivergedError, GENESIS_PREV_HASH, ProtocolError, UnsupportedVersionError,
  applyMembership, canonicalJson, checkAuthor, checkCheckpoint, checkRecord, epochKeys, genesisMembers, isClearCall,
  memberHandles, openRecord, unwrapKey,
  type MemberSet, type OpenedOp, type TeamOp,
} from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, EML, RelayOrderError } from '@engramprotocol/core'
import type { TeamFile } from './team-file'

// --- The replica (v0.21, spec team-brain-sync-client-spec §4) ---------------------
//
// One per shared brain: it takes the entries its relay delivers, one at a time
// in seq order, and decides for each what every replica decides for it —
// applied, or kept as rejected (decision shared-log-rejected-entries). Where
// replicas could not decide alike, or this code cannot decide at all, it
// stops: the brain stays readable and takes nothing more. Nothing of that is
// kept on disk; a restart meets the same entry again.

/** A relayed entry as the relay's op frame carries it. */
export interface Delivered {
  seq: number
  at: string
  record: unknown
}

export type Outcome =
  | { kind: 'applied' }
  /** kept in the log, changed nothing */
  | { kind: 'rejected', why: string }
  /** nothing written: the device has no key for the brain's current epoch yet (addKey) */
  | { kind: 'waiting', epoch: number }
  /** the brain stops: replicas went apart, or the relay's log is not one */
  | { kind: 'stopped', why: string }
  /** the brain stops until this cockpit is updated: a newer protocol or brain schema */
  | { kind: 'update_needed', why: string }

type Halt = Extract<Outcome, { kind: 'stopped' | 'update_needed' }>

export class Replica {
  private readonly eml: EML
  /** the member set at the head; null before the genesis */
  private set: MemberSet | null = null
  private readonly keys = new Map<number, Uint8Array>()
  private handles: Record<string, string | null> | null = null
  private halt: Halt | null = null
  private waiting: number | null = null

  /** The replica of the brain on `db` (empty, or with a shared log) with its team file. */
  constructor(private readonly db: Database.Database, private readonly team: TeamFile) {
    this.eml = EML.fromConnection(db, 'replica')
    if (this.head().seq === 0) return
    const brain = this.eml.teamBrain()
    if (brain !== team.brain) {
      this.stop(`the brain's genesis names team brain ${String(brain)}, its team file ${team.brain}`)
      return
    }
    try {
      this.set = memberSetOf(db)
    } catch (err) {
      this.stop(`the log's membership does not replay: ${(err as Error).message}`)
    }
  }

  /** live, waiting for a key, or halted. */
  get state(): Outcome | { kind: 'live' } {
    return this.halt ?? (this.waiting !== null ? { kind: 'waiting', epoch: this.waiting } : { kind: 'live' })
  }

  /** Takes a wrapped key the relay holds for this device: that epoch's key and every older one. Throws ProtocolError when it is not the log's. */
  addKey(wrapped: unknown): void {
    if (!this.set) throw new ProtocolError('the brain has no members before its genesis')
    for (const k of epochKeys(this.set, unwrapKey(this.set, wrapped, this.team.device))) this.keys.set(k.epoch, k.key)
    this.handles = null
  }

  /** Takes the next relayed entry. */
  take(entry: Delivered): Outcome {
    if (this.halt) return this.halt
    try {
      const outcome = this.decide(entry)
      this.waiting = outcome.kind === 'waiting' ? outcome.epoch : null
      return outcome
    } catch (err) {
      if (err instanceof RelayOrderError) return this.stop(err.message)
      throw err
    }
  }

  private decide({ seq, at, record }: Delivered): Outcome {
    const head = this.head()
    if (seq !== head.seq + 1) return this.stop(`relayed entry ${seq}: the log expects seq ${head.seq + 1}`)
    const keyFor = (epoch: number) => this.keys.get(epoch)

    let header
    try {
      header = checkRecord(record, this.team.brain)
    } catch (err) {
      return this.unopened(seq, at, record, err)
    }
    if (this.db.prepare('SELECT 1 FROM op_log WHERE op_id = ?').get(header.op_id)) {
      return this.reject(seq, at, header.op_id, canonicalJson(record), null, 'DUPLICATE: the op_id is in the log already')
    }
    if (header.kind === 'op') {
      if (!this.set) return this.stop('the log does not start with a genesis')
      // only the current epoch is opened (PROTOCOL.md §4): whether a replica
      // still holds an older key must not change what it logs
      if (header.epoch !== this.set.epoch) {
        return this.reject(seq, at, header.op_id, canonicalJson(record), null, `REFUSED: the op is sealed under epoch ${header.epoch}, the brain is at ${this.set.epoch}`)
      }
      if (!keyFor(header.epoch)) return { kind: 'waiting', epoch: header.epoch }
    }

    let opened: OpenedOp
    try {
      opened = openRecord(record, this.team.brain, keyFor)
    } catch (err) {
      return this.unopened(seq, at, record, err)
    }
    const op = opened.envelope
    if (op.schema > CURRENT_BRAIN_SCHEMA_VERSION) {
      return this.halted({ kind: 'update_needed', why: `entry ${seq} is brain schema ${op.schema}; this cockpit knows ${CURRENT_BRAIN_SCHEMA_VERSION}` })
    }

    if (seq === 1) {
      let founded: MemberSet
      try {
        founded = genesisMembers(opened)
      } catch (err) {
        return this.stop(`the log does not start with a genesis: ${(err as Error).message}`)
      }
      try {
        this.eml.takeRelayed(this.entry(seq, at, opened), op)
      } catch (err) {
        if (err instanceof RelayOrderError) throw err
        return this.stop(`the genesis does not found this brain: ${(err as Error).message}`)
      }
      this.set = founded
      return { kind: 'applied' }
    }

    if (op.team.base_seq >= seq) return this.reject(seq, at, op.op_id, opened.payload, opened.sig, `REFUSED: base_seq ${op.team.base_seq} is not before the op's seq`)
    if (op.team.head_hash !== this.hashAt(op.team.base_seq)) {
      return this.stop(`entry ${seq}: its author's log differs from this one at seq ${op.team.base_seq}`)
    }

    const set = this.set as MemberSet
    let next = set
    try {
      if (isClearCall(op.call)) {
        next = applyMembership(set, opened)
      } else {
        checkAuthor(set, opened, this.handles ??= memberHandles(set, keyFor))
        // a live replica has only its head's state hash; an older checkpoint
        // gets the format check, and is compared by a device joining (block 6)
        if (op.call === 'brain.checkpoint') checkCheckpoint(opened, s => s === head.seq ? this.eml.stateHash() : (op.args as { state_hash: string }).state_hash)
      }
    } catch (err) {
      if (err instanceof DivergedError) return this.stop(err.message)
      if (err instanceof ProtocolError) return this.reject(seq, at, op.op_id, opened.payload, opened.sig, `REFUSED: ${err.message}`)
      throw err
    }

    const why = this.eml.takeRelayed(this.entry(seq, at, opened), op)
    if (why !== null) return { kind: 'rejected', why }
    if (next !== set) {
      this.set = next
      this.handles = null
    }
    return { kind: 'applied' }
  }

  /** A record that did not open: a newer protocol stops; otherwise it is kept as rejected, as delivered. */
  private unopened(seq: number, at: string, record: unknown, err: unknown): Outcome {
    if (err instanceof UnsupportedVersionError) return this.halted({ kind: 'update_needed', why: `entry ${seq}: ${err.message}` })
    if (!(err instanceof ProtocolError)) throw err
    if (seq === 1) return this.stop(`the log does not start with a genesis: ${err.message}`)
    const opId = (record as { op_id?: unknown } | null)?.op_id
    return this.reject(seq, at, typeof opId === 'string' && UUID.test(opId) ? opId : null, canonicalJson(record), null, `UNOPENABLE: ${err.message}`)
  }

  private reject(seq: number, at: string, opId: string | null, payload: string, sig: string | null, why: string): Outcome {
    this.eml.takeRelayed({ seq, at, op_id: opId, payload, signature: sig === null ? null : Buffer.from(sig, 'base64url'), rejected: why }, null)
    return { kind: 'rejected', why }
  }

  private entry(seq: number, at: string, opened: OpenedOp) {
    return { seq, at, op_id: opened.envelope.op_id, payload: opened.payload, signature: Buffer.from(opened.sig, 'base64url'), rejected: null }
  }

  private head(): { seq: number } {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM op_log').get() as { seq: number }
  }

  /** The chain link after `seq` (the genesis's prev_hash before seq 1). */
  private hashAt(seq: number): string | undefined {
    if (seq === 0) return GENESIS_PREV_HASH
    return (this.db.prepare('SELECT hash FROM op_log WHERE seq = ?').get(seq) as { hash: string } | undefined)?.hash
  }

  private stop(why: string): Outcome {
    return this.halted({ kind: 'stopped', why })
  }

  private halted(halt: Halt): Outcome {
    this.halt = halt
    return halt
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The member set at the head of a shared log: its genesis and every applied membership record after it. */
function memberSetOf(db: Database.Database): MemberSet {
  const rows = db.prepare(`SELECT seq, payload, signature FROM op_log WHERE rejected IS NULL AND (seq = 1 OR json_extract(payload, '$.call') LIKE 'team.%') ORDER BY seq`)
    .iterate() as IterableIterator<{ seq: number, payload: string, signature: Buffer }>
  let set: MemberSet | null = null
  for (const row of rows) {
    const opened: OpenedOp = { envelope: JSON.parse(row.payload) as TeamOp, payload: row.payload, sig: row.signature.toString('base64url'), epoch: null }
    set = set === null ? genesisMembers(opened) : applyMembership(set, opened)
  }
  if (set === null) throw new Error('the log has no genesis')
  return set
}
