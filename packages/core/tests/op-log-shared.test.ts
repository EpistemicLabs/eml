import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { canonicalJson, plainJson, sha256Hex, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CommandError, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { applyOp, commandStores } from '../src/log/apply-op'
import { RelayOrderError, appendRelayed, teamBrainOf, type RelayedEntry } from '../src/log/log'
import { uuidv5 } from '../src/log/op'
import { rebuild, verify } from '../src/log/rebuild'
import { encodeSnapshot, stateDump, stateHash } from '../src/log/snapshot'
import { validNote } from './fixtures'

// v0.21 (spec team-brain-sync-client-spec §2–§3): a shared brain's log as core
// keeps it — every entry at the seq and time its relay gave it, rejected
// entries in the chain but not applied, ops with team fields for exactly this
// brain, membership records and checkpoints applied as nothing.

const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e'
const DEVICE = 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4'
const T0 = '2026-10-27T08:00:00.000Z'
const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }
const JUNO = { ...NONE, handle: 'juno', agent: 'pilot', ingestion_method: 'mcp' }

const raw = (eml: EML): Database.Database => (eml as any).db
const time = (s: number): string => new Date(Date.parse(T0) + s * 1000).toISOString()
const opId = (n: number): string => uuidv5(BRAIN, `op ${n}`)

function envelope(n: number, call: string, args: unknown, team: string | null = BRAIN): OpEnvelope {
  return {
    op_id: opId(n), schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never,
    provenance: call.startsWith('team.') || call.startsWith('brain.genesis') ? NONE : JUNO,
    ...(team ? { team: { brain: team, device: DEVICE, base_seq: n - 1, head_hash: '0'.repeat(64) } } : {}),
  }
}

/** A shared brain: an empty brain whose log starts with a relayed genesis for BRAIN and its snapshot. */
function sharedBrain(): EML {
  const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
  const db = raw(eml)
  db.exec('DELETE FROM op_snapshots; DELETE FROM op_log')  // the private genesis a new brain file writes
  const dump = stateDump(db)
  const genesis = envelope(1, 'brain.genesis', { state_hash: stateHash(dump) })
  db.transaction(() => {
    appendRelayed(db, { seq: 1, at: T0, op_id: genesis.op_id, payload: plainJson(genesis), signature: null, rejected: null })
    db.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (1, ?, ?, ?)').run(CURRENT_BRAIN_SCHEMA_VERSION, stateHash(dump), encodeSnapshot(dump))
  })()
  return eml
}

/** How a replica takes a relayed op: append it at its seq and apply it, or keep it as rejected — in one transaction. */
function take(eml: EML, seq: number, op: OpEnvelope, at = time(seq)): string | null {
  const db = raw(eml)
  const stores = commandStores(eml, db)
  const entry: RelayedEntry = { seq, at, op_id: op.op_id, payload: plainJson(op), signature: null, rejected: null }
  try {
    db.transaction(() => { appendRelayed(db, entry); applyOp(stores, op, at, BRAIN) })()
    return null
  } catch (err) {
    if (err instanceof RelayOrderError) throw err
    const rejected = `INVALID: ${(err as Error).message}`
    db.transaction(() => appendRelayed(db, { ...entry, rejected }))()
    return rejected
  }
}

const count = (eml: EML, title: string): number =>
  (raw(eml).prepare('SELECT COUNT(*) AS n FROM engrams WHERE title = ?').get(title) as { n: number }).n

describe('a shared brain\'s log', () => {
  it('belongs to the team brain its genesis names; a private brain\'s to none', () => {
    const shared = sharedBrain()
    const own = new EML({ dbPath: ':memory:', namespace: 'test' })
    expect(teamBrainOf(raw(shared))).toBe(BRAIN)
    expect(teamBrainOf(raw(own))).toBeNull()
    shared.close(); own.close()
  })

  it('takes each relayed entry at the relay\'s seq and time, chained like a private one', () => {
    const eml = sharedBrain()
    expect(take(eml, 2, envelope(2, 'engram.create', validNote({ title: 'hello' })))).toBeNull()
    expect(count(eml, 'hello')).toBe(1)
    const e = raw(eml).prepare('SELECT * FROM op_log WHERE seq = 2').get() as any
    expect(e).toMatchObject({ at: time(2), op_id: opId(2), rejected: null })
    expect(verify(raw(eml))).toMatchObject({ ok: true, entries: 2 })
    eml.close()
  })

  it('stops on a gap or a time that goes back: RelayOrderError, nothing written', () => {
    const eml = sharedBrain()
    expect(() => take(eml, 3, envelope(3, 'engram.create', validNote({ title: 'gap' })))).toThrow(RelayOrderError)
    expect(() => take(eml, 2, envelope(2, 'engram.create', validNote({ title: 'back' })), time(-1))).toThrow(/before the head/)
    expect(take(eml, 2, envelope(2, 'engram.create', validNote({ title: 'same time' })), T0)).toBeNull()
    expect((raw(eml).prepare('SELECT COUNT(*) AS n FROM op_log').get() as { n: number }).n).toBe(2)
    eml.close()
  })

  it('keeps a refused op at its seq as rejected: in the chain, not applied, also not by a rebuild', () => {
    const eml = sharedBrain()
    const bad = envelope(2, 'engram.create', { ...validNote({ title: 'no content' }), content: '' })
    expect(take(eml, 2, bad)).toMatch(/^INVALID: /)
    expect(take(eml, 3, envelope(3, 'engram.create', validNote({ title: 'after' })))).toBeNull()
    expect(count(eml, 'no content')).toBe(0)
    expect(verify(raw(eml))).toMatchObject({ ok: true, entries: 3 })
    eml.close()
  })

  it('a record that did not open is kept with canonicalJson of the record as its payload, with or without a valid op_id', () => {
    const eml = sharedBrain()
    const db = raw(eml)
    const record = { v: 1, kind: 'op', brain: BRAIN, op_id: opId(2), epoch: 0, nonce: 'AAAA', ct: 'garbage' }
    const nameless = { ...record, op_id: 'not-a-uuid' }
    db.transaction(() => {
      appendRelayed(db, { seq: 2, at: time(2), op_id: record.op_id, payload: canonicalJson(record), signature: null, rejected: 'UNOPENABLE: the box does not open' })
      appendRelayed(db, { seq: 3, at: time(3), op_id: null, payload: canonicalJson(nameless), signature: null, rejected: 'UNOPENABLE: the box does not open' })
    })()
    const e = db.prepare('SELECT payload_hash FROM op_log WHERE seq = 2').get() as { payload_hash: string }
    expect(e.payload_hash).toBe(sha256Hex(canonicalJson(record)))
    expect(verify(db)).toMatchObject({ ok: true, entries: 3 })
    eml.close()
  })

  it('an op_id is applied once (the index), and may stand again only as rejected', () => {
    const eml = sharedBrain()
    const db = raw(eml)
    const op = envelope(2, 'engram.create', validNote({ title: 'once' }))
    expect(take(eml, 2, op)).toBeNull()
    const again = { seq: 3, at: time(3), op_id: op.op_id, payload: plainJson(op), signature: null }
    expect(() => db.transaction(() => appendRelayed(db, { ...again, rejected: null }))()).toThrow(/UNIQUE/)
    db.transaction(() => appendRelayed(db, { ...again, rejected: 'DUPLICATE: op_id is in the log' }))()
    expect(count(eml, 'once')).toBe(1)
    expect(() => db.transaction(() => appendRelayed(db, { seq: 4, at: time(4), op_id: null, payload: '{}', signature: null, rejected: null }))()).toThrow(/CHECK/)
    eml.close()
  })

  it('membership records and checkpoints change no brain table; a genesis after seq 1 is refused', () => {
    const eml = sharedBrain()
    const before = stateHash(stateDump(raw(eml)))
    expect(take(eml, 2, envelope(2, 'team.add_device', { device_cert: {} }))).toBeNull()
    expect(take(eml, 3, envelope(3, 'brain.checkpoint', { seq: 2, state_hash: before }))).toBeNull()
    expect(stateHash(stateDump(raw(eml)))).toBe(before)
    expect(take(eml, 4, envelope(4, 'brain.genesis', { state_hash: before }))).toMatch(/brain.genesis only starts a log/)
    expect(verify(raw(eml))).toMatchObject({ ok: true, entries: 4 })
    eml.close()
  })

  it('takes ops with team fields for exactly this brain', () => {
    const eml = sharedBrain()
    expect(take(eml, 2, envelope(2, 'engram.create', validNote({ title: 'private op' }), null))).toMatch(/only ops with team fields/)
    expect(take(eml, 3, envelope(3, 'engram.create', validNote({ title: 'other brain' }), OTHER))).toMatch(new RegExp(`for team brain ${OTHER}, not ${BRAIN}`))
    expect(count(eml, 'private op') + count(eml, 'other brain')).toBe(0)
    eml.close()
  })

  it('is not written locally: a write through EML.apply is refused and logs nothing', () => {
    const eml = sharedBrain()
    let err: unknown
    try { eml.apply({ name: 'engram.create', input: validNote({ title: 'local' }) }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(CommandError)
    expect((err as Error).message).toMatch(/written through its relay/)
    expect((raw(eml).prepare('SELECT COUNT(*) AS n FROM op_log').get() as { n: number }).n).toBe(1)
    eml.close()
  })

  it('rebuilds to the live state: applied ops replayed, rejected and non-state entries skipped', () => {
    const eml = sharedBrain()
    take(eml, 2, envelope(2, 'engram.create', validNote({ title: 'kept' })))
    take(eml, 3, envelope(3, 'engram.create', { ...validNote(), content: '' }))
    take(eml, 4, envelope(4, 'team.add_device', { device_cert: {} }))
    take(eml, 5, envelope(5, 'engram.create', validNote({ title: 'also kept' })))
    const into = new Database(':memory:')
    rebuild(into, raw(eml))
    expect(stateHash(stateDump(into))).toBe(stateHash(stateDump(raw(eml))))
    into.close(); eml.close()
  })
})

describe('a private brain', () => {
  it('refuses an op with team fields', () => {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    const stores = commandStores(eml, raw(eml))
    expect(() => applyOp(stores, envelope(2, 'engram.create', validNote()), T0, null)).toThrow(/private brain takes no op with team fields/)
    eml.close()
  })
})
