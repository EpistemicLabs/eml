import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, runForwardMigrations } from '../src'
import { GENESIS_PREV_HASH, chainHash, sha256Hex } from '../src/log/op'
import { decodeSnapshot, stateDump, stateHash } from '../src/log/snapshot'

// Schema 21 (release F2): the op log. The step adds op_log and op_snapshots
// and changes no row; in the same transaction the runner writes the genesis —
// seq 1 with the hash of the brain's state and that state as the snapshot.

const V20_FIXTURE = join(__dirname, 'fixtures', 'brain-v20.sql')
const NOW = '2026-10-26T12:00:00.000Z'

/** A brain as v0.20 left it, with a row in every state table. */
function createV20Brain(file: string): void {
  const db = new Database(file)
  db.exec(readFileSync(V20_FIXTURE, 'utf-8'))
  const at = '2026-10-23T09:00:00.000Z'
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('juno', 'Juno', ?)`).run(at)
  db.prepare(`INSERT INTO users (id, name, created_at, updated_at) VALUES ('ada', 'Ada', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO entities (id, name, kind, created_at, updated_at) VALUES ('acme', 'Acme', 'org', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'P', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO tags (id, name, created_at) VALUES ('ops', 'ops', ?)`).run(at)
  db.prepare(`INSERT INTO subjects (id, name, created_at, updated_at) VALUES ('launch', 'launch', ?, ?)`).run(at, at)
  const engram = db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES (?, ?, 'project.p', ?, ?, 'active', ?, ?, ?, 1)`)
  engram.run('d-1', 'decision', 'pick', 'chose the test option', JSON.stringify({ rationale: 'r', alternatives: ['a'] }), at, at)
  engram.run('t-1', 'task', 'build', 'build it', JSON.stringify({ stage: 'planning' }), at, at)
  for (const id of ['d-1', 't-1']) {
    db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) SELECT id, content, scope, COALESCE(title, '') FROM engrams WHERE id = ?`).run(id)
  }
  db.prepare(`INSERT INTO relations (id, source_id, target_id, relation, detection_method, created_at) VALUES ('rel-1', 'd-1', 't-1', 'supports', 'manual', ?)`).run(at)
  db.prepare(`INSERT INTO engram_tags (engram_id, tag_id, created_at) VALUES ('d-1', 'ops', ?)`).run(at)
  db.prepare(`INSERT INTO engram_subjects (engram_id, subject_id, created_at) VALUES ('t-1', 'launch', ?)`).run(at)
  db.prepare(`INSERT INTO entries (id, engram_id, kind, at, text) VALUES ('e-1', 't-1', 'change', ?, 'created (planned)')`).run(at)
  db.close()
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
    expect(payload.provenance).toEqual({ handle: null, ingestion_method: 'other', session_id: null, model: null, harness: null })

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

  it('through initDatabase: no state row changes, and the genesis holds the brain as it was', () => {
    const file = join(dir, 'v20.db')
    createV20Brain(file)
    const before = read(file, db => stateDump(db))
    new EML({ namespace: 'test', dbPath: file, clock: () => NOW }).close()
    expectGenesis(file)
    read(file, db => {
      expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(21)
      expect(stateDump(db)).toEqual(before)
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
    read(file, db => expect(stateDump(db)).toEqual(before))
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
