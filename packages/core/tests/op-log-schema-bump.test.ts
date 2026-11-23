import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { plainJson, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initDatabase } from '../src'
import { applyMigration } from '../src/database'
import { appendOp, snapshotSchemaOf, writeCheckpoint, writeGenesis } from '../src/log/log'
import { rebuild, verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { validNote, writes } from './fixtures'

// A log across a schema bump (decision schema-bump-replay-path-is-checkpoint):
// the migration step states the state after it as a checkpoint with a
// snapshot, and a rebuild starts from the latest snapshot of the schema the
// code replays — ops of an older schema are never run again.

const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const TEAM = '0f8fad5b-d9cb-469f-a165-70867728950e'
const DEVICE = 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4'
const NEXT = CURRENT_BRAIN_SCHEMA_VERSION + 1
const OLDER = CURRENT_BRAIN_SCHEMA_VERSION - 1
const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }
const T = (s: number): string => new Date(Date.parse('2026-11-19T08:00:00.000Z') + s * 1000).toISOString()
/** A migrate step to the next schema: one more state table. */
const STEP = 'CREATE TABLE bump_probe (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO bump_probe (note) VALUES (\'migrated\');'

const raw = (eml: EML): Database.Database => (eml as any).db
const entries = (db: Database.Database) => db.prepare('SELECT seq, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, payload: string }>
const snapshots = (db: Database.Database) => db.prepare('SELECT seq, schema, state_hash FROM op_snapshots ORDER BY seq').all()

function privateBrain(): EML {
  let t = Date.parse(T(0))
  let n = 0
  return new EML({ dbPath: ':memory:', namespace: 'test', brainId: BRAIN, clock: () => new Date(t++).toISOString(), newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}` })
}

function migrate(db: Database.Database, at = T(60)): void {
  db.pragma('foreign_keys = OFF')
  applyMigration(db, NEXT, STEP, () => at, BRAIN)
  db.pragma('foreign_keys = ON')
}

describe('a migrate step on a brain whose log has started', () => {
  it('appends a checkpoint at the new schema with the migrated state as its snapshot', () => {
    const eml = privateBrain()
    writes(eml).store(validNote({ title: 'before' }))
    const db = raw(eml)
    const head = entries(db).length
    migrate(db)

    const last = entries(db).at(-1)!
    const op = JSON.parse(last.payload) as OpEnvelope
    const state_hash = stateHash(stateDump(db))
    expect(last.seq).toBe(head + 1)
    expect(op).toMatchObject({ schema: NEXT, call: 'brain.checkpoint', args: { seq: head, state_hash } })
    expect(snapshots(db)).toEqual([
      { seq: 1, schema: CURRENT_BRAIN_SCHEMA_VERSION, state_hash: expect.any(String) },
      { seq: head + 1, schema: NEXT, state_hash },
    ])
    expect(stateDump(db).bump_probe).toEqual([{ id: 1, note: 'migrated' }])
    eml.close()
  })

  it('writes the same entry in the preflight and in the live run', () => {
    const [a, b] = [privateBrain(), privateBrain()]
    for (const eml of [a, b]) { writes(eml).store(validNote({ title: 'before' })); migrate(raw(eml)) }
    expect(entries(raw(a)).at(-1)).toEqual(entries(raw(b)).at(-1))
    a.close(); b.close()
  })

  it('leaves a brain without a genesis and a shared brain to their relay', () => {
    const waiting = initDatabase(':memory:', undefined, BRAIN, { log: false })
    migrate(waiting)
    expect(entries(waiting)).toEqual([])

    const shared = initDatabase(':memory:', undefined, TEAM, { log: false })
    const genesis: OpEnvelope = { op_id: BRAIN, schema: CURRENT_BRAIN_SCHEMA_VERSION, call: 'brain.genesis', args: { brain: TEAM, state_hash: stateHash(stateDump(shared)) }, provenance: NONE, team: { brain: TEAM, device: DEVICE, base_seq: 0, head_hash: '0'.repeat(64) } }
    EML.fromConnection(shared, 'test').takeRelayed({ seq: 1, at: T(0), op_id: genesis.op_id, payload: plainJson(genesis), signature: null, rejected: null }, genesis)
    migrate(shared)
    expect(entries(shared)).toHaveLength(1)
    expect(snapshotSchemaOf(shared)).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    waiting.close(); shared.close()
  })

  it('a brain migrated past this code is refused by its rebuild', () => {
    const eml = privateBrain()
    migrate(raw(eml))
    expect(verify(raw(eml))).toEqual({ ok: false, seq: 2, problem: `op 2: the latest snapshot is schema ${NEXT}; this code replays schema ${CURRENT_BRAIN_SCHEMA_VERSION}` })
    eml.close()
  })
})

describe('a log that came from an older schema', () => {
  /** A brain whose log began at the schema before this one: a genesis and a write of that schema, then the checkpoint of the migration. */
  function migratedBrain(): EML {
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    writeGenesis(db, OLDER, T(0), BRAIN)
    // what the older schema wrote is in the state the checkpoint names; its op is not one this code could run
    appendOp(db, { op_id: '11111111-1111-4111-8111-111111111111', schema: OLDER, call: 'engram.create', args: { a: 'shape this schema does not know' }, provenance: NONE }, T(1))
    expect(writeCheckpoint(db, CURRENT_BRAIN_SCHEMA_VERSION, T(2))).toBe(true)
    let t = Date.parse(T(3))
    let n = 0
    return EML.fromConnection(db, 'test', { clock: () => new Date(t++).toISOString(), newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}` })
  }

  it('rebuilds from the checkpoint and replays only what came after it', () => {
    const eml = migratedBrain()
    writes(eml).store(validNote({ title: 'after the bump' }))
    writes(eml).store(validNote({ title: 'and one more' }))
    const db = raw(eml)
    expect(verify(db)).toEqual({ ok: true, entries: 5, state_hash: stateHash(stateDump(db)) })

    const into = new Database(':memory:')
    rebuild(into, db)
    expect(stateDump(into)).toEqual(stateDump(db))
    into.close(); db.close()
  })

  it('does not verify when the snapshot is not the state its checkpoint names', () => {
    const eml = migratedBrain()
    const db = raw(eml)
    db.prepare('UPDATE op_snapshots SET state_hash = ? WHERE seq = 3').run('f'.repeat(64))
    expect(verify(db)).toEqual({ ok: false, seq: 3, problem: 'the checkpoint snapshot does not match the checkpoint state_hash' })
    db.close()
  })

  it('does not replay an op of the older schema that sits after the checkpoint', () => {
    const eml = migratedBrain()
    const db = raw(eml)
    appendOp(db, { op_id: '22222222-2222-4222-8222-222222222222', schema: OLDER, call: 'engram.create', args: {}, provenance: NONE }, T(9))
    expect(verify(db)).toMatchObject({ ok: false, seq: 4, problem: `op 4: the op is schema ${OLDER}; this code replays schema ${CURRENT_BRAIN_SCHEMA_VERSION}` })
    db.close()
  })
})

describe('a shared brain at a schema bump', () => {
  const team = (base_seq: number) => ({ brain: TEAM, device: DEVICE, base_seq, head_hash: '0'.repeat(64) })
  const take = (eml: EML, seq: number, op: OpEnvelope): string | null =>
    eml.takeRelayed({ seq, at: T(seq), op_id: op.op_id, payload: plainJson(op), signature: null, rejected: null }, op).rejected
  const checkpoint = (n: number, seq: number, state_hash: string, schema = CURRENT_BRAIN_SCHEMA_VERSION): OpEnvelope =>
    ({ op_id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`, schema, call: 'brain.checkpoint', args: { seq, state_hash }, provenance: NONE, team: team(seq) })

  /** A replica whose log began at the older schema and whose file is at this one. */
  function replica(): EML {
    const eml = EML.fromConnection(initDatabase(':memory:', undefined, TEAM, { log: false }), 'test')
    const genesis: OpEnvelope = { op_id: BRAIN, schema: OLDER, call: 'brain.genesis', args: { brain: TEAM, state_hash: eml.stateHash() }, provenance: NONE, team: team(0) }
    expect(take(eml, 1, genesis)).toBeNull()
    return eml
  }

  it('the first checkpoint of the new schema that names this replica\'s state becomes its snapshot', () => {
    const eml = replica()
    const db = raw(eml)
    expect(snapshotSchemaOf(db)).toBe(OLDER)
    expect(take(eml, 2, checkpoint(1, 1, eml.stateHash()))).toBeNull()
    expect(snapshots(db)).toEqual([{ seq: 1, schema: OLDER, state_hash: eml.stateHash() }, { seq: 2, schema: CURRENT_BRAIN_SCHEMA_VERSION, state_hash: eml.stateHash() }])
    // a later checkpoint of the same schema is the usual statement of a hash: no second snapshot
    expect(take(eml, 3, checkpoint(2, 2, eml.stateHash()))).toBeNull()
    expect(snapshots(db)).toHaveLength(2)
    expect(verify(db)).toMatchObject({ ok: true, entries: 3 })
    db.close()
  })

  it('a checkpoint that another entry slipped in before, or of another state, leaves none', () => {
    const eml = replica()
    const db = raw(eml)
    expect(take(eml, 2, checkpoint(1, 1, 'f'.repeat(64)))).toBeNull()
    expect(take(eml, 3, checkpoint(2, 1, eml.stateHash()))).toBeNull()
    expect(snapshots(db)).toHaveLength(1)
    db.close()
  })
})
