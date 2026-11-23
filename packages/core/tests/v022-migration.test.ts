import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { createV20Brain, validNote, writes } from './fixtures'

// Schema 22 (the contract of a shared brain): the step changes no row of the
// brain's state. It adds op_log.verdicts, a column of the replica like
// rejected — outside the state and NULL until a build fills it — and the
// runner writes the checkpoint a rebuild at schema 22 starts from.

const NOW = '2026-11-23T12:00:00.000Z'

const columns = (db: Database.Database, table: string) => (db.prepare('SELECT name, type, "notnull" AS required FROM pragma_table_info(?)').all(table) as Array<{ name: string, type: string, required: number }>)

describe('v0.22 migration — op_log.verdicts, and a checkpoint at the new schema', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v022-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a migrated brain: the column is there and NULL, the state is what the step before left, the log verifies and goes on', () => {
    const file = join(dir, 'v20.db')
    createV20Brain(file)
    const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    const db = (eml as any).db as Database.Database
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    expect(columns(db, 'op_log').find(c => c.name === 'verdicts')).toEqual({ name: 'verdicts', type: 'TEXT', required: 0 })

    const log = db.prepare('SELECT seq, verdicts, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, verdicts: string | null, payload: string }>
    expect(log.map(e => e.verdicts)).toEqual(log.map(() => null))
    const checkpoint = JSON.parse(log[log.length - 1].payload)
    // the checkpoint of schema 22 names the state the genesis of schema 21 named: no state row changed
    expect(checkpoint).toMatchObject({ schema: 22, call: 'brain.checkpoint', args: { state_hash: JSON.parse(log[0].payload).args.state_hash } })
    expect(checkpoint.args.state_hash).toBe(stateHash(stateDump(db)))

    writes(eml).store(validNote({ scope: 'project.p', title: 'after-22' }), eml.env({ handle: 'juno' }))
    expect(verify(db)).toMatchObject({ ok: true, entries: log.length + 1 })
    expect((db.prepare('SELECT verdicts FROM op_log ORDER BY seq DESC LIMIT 1').get() as { verdicts: string | null }).verdicts).toBeNull()
    eml.close()
  })

  it('verdicts is outside the state, like rejected: a value in it leaves the state hash and the verify as they are', () => {
    const eml = new EML({ namespace: 'test', dbPath: ':memory:', clock: () => NOW })
    const db = (eml as any).db as Database.Database
    expect(columns(db, 'op_log').map(c => c.name)).toContain('verdicts')
    expect(Object.keys(stateDump(db))).not.toContain('op_log')
    const before = eml.stateHash()
    db.prepare('UPDATE op_log SET verdicts = ? WHERE seq = 1').run('a'.repeat(64))
    expect(eml.stateHash()).toBe(before)
    expect(verify(db)).toMatchObject({ ok: true })
    eml.close()
  })
})
