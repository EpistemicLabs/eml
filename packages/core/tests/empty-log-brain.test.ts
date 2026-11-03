import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommandError, CURRENT_BRAIN_SCHEMA_VERSION, EML, checkBrainIds, initControlDatabase, initDatabase } from '../src'
import { applyMigration } from '../src/database'
import { stateDump } from '../src/log/snapshot'
import { validNote } from './fixtures'

// v0.21 (spec team-brain-sync-client-spec §5): a brain whose genesis comes
// from its relay starts as the schema with no rows and an empty log —
// initDatabase with { log: false }. Until the genesis is in, it takes no write;
// no migration step writes one for it; and it is not a brain whose id is off.

const ID = '3b241101-e2bb-4255-8caf-4136c566a962'
const NOW = '2026-11-03T08:00:00.000Z'

const count = (db: ReturnType<typeof initDatabase>, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('a brain without its genesis', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-empty-log-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is the current schema with no rows and no log', () => {
    const db = initDatabase(join(dir, 'new.db'), () => NOW, ID, { log: false })
    try {
      expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
      expect(count(db, 'op_log')).toBe(0)
      expect(count(db, 'op_snapshots')).toBe(0)
      expect(Object.values(stateDump(db)).every(rows => rows.length === 0)).toBe(true)
      const eml = EML.fromConnection(db, 'test')
      expect(eml.hasGenesis()).toBe(false)
      expect(eml.brainId()).toBeNull()
      expect(eml.teamBrain()).toBeNull()
    } finally {
      db.close()
    }
  })

  it('takes no write: the log starts with a genesis', () => {
    const db = initDatabase(':memory:', () => NOW, ID, { log: false })
    const eml = EML.fromConnection(db, 'test')
    expect(() => eml.apply({ name: 'engram.create', input: validNote({ title: 't-early' }) })).toThrow(CommandError)
    expect(() => eml.apply({ name: 'engram.create', input: validNote({ title: 't-early' }) })).toThrow(/no genesis yet/)
    expect(count(db, 'op_log')).toBe(0)
    expect(count(db, 'engrams')).toBe(0)
    expect(eml.engrams.query({})).toEqual([])  // reads run
  })

  it('stays without a log through a later schema step: only the step that brings the log writes a genesis', () => {
    const db = initDatabase(':memory:', () => NOW, ID, { log: false })
    applyMigration(db, CURRENT_BRAIN_SCHEMA_VERSION + 1, 'CREATE TABLE later_step (a TEXT);', () => NOW, ID)
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION + 1)
    expect(count(db, 'op_log')).toBe(0)
  })

  it('opens again as it is: no genesis is written on the next open', () => {
    const file = join(dir, 'again.db')
    initDatabase(file, () => NOW, ID, { log: false }).close()
    const db = initDatabase(file, () => NOW, ID)
    try {
      expect(count(db, 'op_log')).toBe(0)
    } finally {
      db.close()
    }
  })

  it('is not a brain whose id is off: checkBrainIds leaves it as it is', () => {
    mkdirSync(join(dir, 'brains'))
    initDatabase(join(dir, 'brains', `${ID}.db`), () => NOW, ID, { log: false }).close()
    const control = initControlDatabase(':memory:')
    try {
      control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'a@b.de')`).run()
      control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(ID, 'team', 'u1', `brains/${ID}.db`, CURRENT_BRAIN_SCHEMA_VERSION)
      expect(checkBrainIds({ control, dataDir: dir })).toEqual([])
      expect((control.prepare('SELECT status FROM brains WHERE id = ?').get(ID) as { status: string }).status).toBe('ok')
    } finally {
      control.close()
    }
  })
})
