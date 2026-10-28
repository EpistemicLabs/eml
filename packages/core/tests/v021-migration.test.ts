import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, runForwardMigrations } from '../src'
import { GENESIS_PREV_HASH, chainHash, sha256Hex } from '@engramprotocol/protocol/log'
import { decodeSnapshot, stateDump, stateHash, type StateDump } from '../src/log/snapshot'
import { createV20Brain } from './fixtures'

// Schema 21 (release F2): the op log. The step adds op_log and op_snapshots
// and changes no row; in the same transaction the runner writes the genesis —
// seq 1 with the hash of the brain's state and that state as the snapshot.

const NOW = '2026-10-26T12:00:00.000Z'

/** The state without ord and agent (schema 21 adds them; every other value stays as it was). */
function withoutNew(dump: StateDump): StateDump {
  return Object.fromEntries(Object.entries(dump).map(([t, rows]) => [t, rows.map(({ ord: _o, agent: _a, ...row }) => row)]))
}

/** ord is 1, 2, … in the rows' rowid order on engrams, relations and entries. */
function expectOrdInRowidOrder(db: Database.Database): void {
  for (const table of ['engrams', 'relations', 'entries']) {
    const ords = (db.prepare(`SELECT ord FROM ${table} ORDER BY rowid`).all() as Array<{ ord: number }>).map(r => r.ord)
    expect(ords, table).toEqual(ords.map((_, i) => i + 1))
  }
}

function read<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true })
  try { return fn(db) } finally { db.close() }
}

/** The genesis is the log's only entry, its chain link is valid, and it and its snapshot hold the brain's state. */
function expectGenesis(file: string): void {
  read(file, db => {
    const log = db.prepare('SELECT * FROM op_log').all() as Array<Record<string, any>>
    expect(log).toHaveLength(1)
    const g = log[0]
    expect(g.seq).toBe(1)
    expect(g.prev_hash).toBe(GENESIS_PREV_HASH)
    expect(g.payload_hash).toBe(sha256Hex(g.payload))
    expect(g.hash).toBe(chainHash(g.prev_hash, g.seq, g.at, g.payload_hash))
    expect(g.signature).toBeNull()
    const state = stateHash(stateDump(db))
    const payload = JSON.parse(g.payload)
    expect(payload).toMatchObject({ schema: CURRENT_BRAIN_SCHEMA_VERSION, call: 'brain.genesis', args: { state_hash: state }, op_id: g.op_id })
    expect(payload.provenance).toEqual({ handle: null, agent: null, ingestion_method: 'other', session_id: null, model: null, harness: null })

    const snaps = db.prepare('SELECT * FROM op_snapshots').all() as Array<Record<string, any>>
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ seq: 1, schema: CURRENT_BRAIN_SCHEMA_VERSION, state_hash: state })
    const snapshot = decodeSnapshot(snaps[0].data)
    expect(stateHash(snapshot)).toBe(state)
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(stateDump(db))))
  })
}

describe('v0.21 migration — the op log starts with a genesis', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v021-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a fresh brain starts its log with the genesis of the empty brain', () => {
    const file = join(dir, 'fresh.db')
    new EML({ namespace: 'test', dbPath: file, clock: () => NOW }).close()
    expectGenesis(file)
    read(file, db => {
      expect(Object.values(stateDump(db)).every(rows => rows.length === 0)).toBe(true)
      expect((db.prepare('SELECT at FROM op_log').get() as { at: string }).at).toBe(NOW)
    })
  })

  it('through initDatabase: no value of a state row changes (ord is added, in rowid order; agent is added, NULL), and the genesis holds the brain as it was', () => {
    const file = join(dir, 'v20.db')
    createV20Brain(file)
    const before = read(file, db => stateDump(db))
    new EML({ namespace: 'test', dbPath: file, clock: () => NOW }).close()
    expectGenesis(file)
    read(file, db => {
      expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(21)
      expect(withoutNew(stateDump(db))).toEqual(before)
      expectOrdInRowidOrder(db)
      for (const table of ['engrams', 'entries']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent IS NOT NULL`).get() as { n: number }).n, table).toBe(0)
      // the fixture fills every state table, so the comparison covers them all
      expect(Object.entries(before).filter(([, rows]) => rows.length === 0).map(([t]) => t)).toEqual([])
    })
  })

  it('through the forward-migration pipeline', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'brains'), { recursive: true })
    const file = join(dataDir, 'brains', 'b1.db')
    createV20Brain(file)
    const before = read(file, db => stateDump(db))
    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare(`INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES ('b1', 'test', 'u1', 'brains/b1.db', 20)`).run()
      const report = runForwardMigrations({ control, dataDir, clock: () => NOW })
      expect(report.outcomes[0]).toMatchObject({ status: 'migrated', kind: 'migrated', appliedVersions: [21] })
    } finally { control.close() }
    expectGenesis(file)
    read(file, db => { expect(withoutNew(stateDump(db))).toEqual(before); expectOrdInRowidOrder(db) })
  })

  it('the genesis is a function of the brain and the time: the same brain migrated twice writes the same entry', () => {
    const a = join(dir, 'a.db'); const b = join(dir, 'b.db')
    createV20Brain(a); createV20Brain(b)
    new EML({ namespace: 'test', dbPath: a, clock: () => NOW }).close()
    new EML({ namespace: 'test', dbPath: b, clock: () => NOW }).close()
    const entry = (file: string) => read(file, db => db.prepare('SELECT * FROM op_log').get())
    expect(entry(b)).toEqual(entry(a))
  })

  it('a brain already at 21 keeps its one genesis on the next open', () => {
    const file = join(dir, 'v20.db')
    createV20Brain(file)
    new EML({ namespace: 'test', dbPath: file, clock: () => NOW }).close()
    new EML({ namespace: 'test', dbPath: file, clock: () => '2026-10-27T08:00:00.000Z' }).close()
    expectGenesis(file)
  })

  it('the step, its ledger row and the genesis commit together: a failure leaves the brain at 20 without a log', () => {
    const file = join(dir, 'v20.db')
    createV20Brain(file)
    const before = read(file, db => stateDump(db))
    expect(() => new EML({ namespace: 'test', dbPath: file, clock: () => { throw new Error('clock down') } })).toThrow('clock down')
    read(file, db => {
      expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(20)
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('op_log', 'op_snapshots')`).all()).toEqual([])
      expect(stateDump(db)).toEqual(before)
    })
    new EML({ namespace: 'test', dbPath: file, clock: () => NOW }).close()
    expectGenesis(file)
  })
})
