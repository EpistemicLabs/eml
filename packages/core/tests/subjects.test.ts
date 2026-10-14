import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML } from '../src'

// v0.14 Cluster B — the subjects axis (the "heavy facet", spec §B.3): a registry
// with description + lifecycle status, and an engram_subjects junction.

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const V12_FIXTURE = join(__dirname, 'fixtures', 'brain-v12.sql')
const SRC = { source_id: 'x', source_type: 'agent' } as const

describe('v0.14 subjects', () => {
  let dir: string
  let eml: EML

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-subjects-test-'))
    eml = new EML({ namespace: 'test', dbPath: join(dir, 't.db') })
    eml.projects.create({ id: 'a', name: 'A' })
    eml.projects.create({ id: 'b', name: 'B' })
  })

  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const note = (scope: string, content: string, extra: Record<string, unknown> = {}) =>
    eml.engrams.store({ type: 'note', scope, content, properties: { ...SRC }, ...extra })

  it('SubjectStore.create slugifies, starts active, and dedups without overwriting', () => {
    const t = eml.subjects.create({ name: 'Norway Trip', description: 'summer 2026' })
    expect(t).toMatchObject({ id: 'norway-trip', name: 'Norway Trip', description: 'summer 2026', status: 'active', engram_count: 0 })
    const again = eml.subjects.create({ name: 'norway trip', description: 'other text' })
    expect(again.description).toBe('summer 2026')
    expect(eml.subjects.list()).toHaveLength(1)
  })

  it('rejects a name with no alphanumerics', () => {
    expect(() => eml.subjects.create({ name: '///' })).toThrow(/invalid subject name/)
  })

  it('writes an engram with a subject and reads it back on every read path', () => {
    eml.subjects.create({ name: 'v0.14 planning' })
    const e = note('project.a', 'plan the subjects axis', { subjects: ['v0.14 Planning'] })
    expect(e.subjects).toEqual(['v0-14-planning'])
    expect(eml.engrams.getRaw(e.id)!.subjects).toEqual(['v0-14-planning'])
    expect(eml.engrams.query({ scope: 'project.a' })[0].subjects).toEqual(['v0-14-planning'])
    eml.engrams.store({
      type: 'log', scope: 'project.a', content: 'session', subjects: ['v0-14-planning'], properties: { ...SRC },
    })
    expect(eml.projects.getBrainState('a')!.recent_logs[0].subjects).toEqual(['v0-14-planning'])
  })

  it('rejects an unregistered subject — naming every unknown one — and writes nothing', () => {
    eml.subjects.create({ name: 'known' })
    expect(() => note('project.a', 'x', { subjects: ['known', 'ghost', 'phantom'] })).toThrow(/"ghost", "phantom" not found/)
    expect(eml.engrams.query({ scope: 'project.a' })).toHaveLength(0)
  })

  it('a subject holds engrams across scopes (the cross-scope property)', () => {
    eml.subjects.create({ name: 'datenschutz' })
    note('project.a', 'gdpr in a', { subjects: ['datenschutz'] })
    note('project.b', 'gdpr in b', { subjects: ['datenschutz'] })
    note('project.b', 'unrelated')
    const members = eml.engrams.query({ subject: 'Datenschutz' })
    expect(members.map(m => m.scope).sort()).toEqual(['project.a', 'project.b'])
    expect(eml.subjects.get('datenschutz')!.engram_count).toBe(2)
  })

  it('update replaces the subject set (add, remove, clear) and leaves it alone when omitted', () => {
    eml.subjects.create({ name: 't1' })
    eml.subjects.create({ name: 't2' })
    const e = note('project.a', 'x', { subjects: ['t1'] })
    expect(eml.engrams.update(e.id, { subjects: ['t1', 't2'] })!.subjects).toEqual(['t1', 't2'])
    expect(eml.engrams.update(e.id, { content: 'y' })!.subjects).toEqual(['t1', 't2'])
    expect(eml.engrams.update(e.id, { subjects: ['t2'] })!.subjects).toEqual(['t2'])
    expect(eml.engrams.update(e.id, { subjects: [] })!.subjects).toEqual([])
  })

  it('a subjects-only update bumps updated_at', () => {
    eml.subjects.create({ name: 't1' })
    const e = note('project.a', 'x')
    const db = new Database(join(dir, 't.db'))
    db.prepare(`UPDATE engrams SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`).run(e.id)
    db.close()
    expect(eml.engrams.update(e.id, { subjects: ['t1'] })!.updated_at).not.toBe('2000-01-01 00:00:00')
  })

  it('closing keeps memberships; a closed subject still accepts late filing; reopen works', () => {
    eml.subjects.create({ name: 'trip' })
    note('project.a', 'booked', { subjects: ['trip'] })
    const closed = eml.subjects.update('trip', { status: 'closed' })
    expect(closed).toMatchObject({ status: 'closed', engram_count: 1 })
    const late = note('project.a', 'photos sorted', { subjects: ['trip'] })
    expect(late.subjects).toEqual(['trip'])
    expect(eml.subjects.get('trip')!.engram_count).toBe(2)
    expect(eml.subjects.update('trip', { status: 'active' }).status).toBe('active')
  })

  it('update edits name + description, keeps the slug id, rejects unknown subjects and bad status', () => {
    eml.subjects.create({ name: 'trip' })
    const t = eml.subjects.update('trip', { name: 'Norway Trip', description: 'the summer one' })
    expect(t).toMatchObject({ id: 'trip', name: 'Norway Trip', description: 'the summer one' })
    expect(() => eml.subjects.update('ghost', { status: 'closed' })).toThrow(/not found/)
    expect(() => eml.subjects.update('trip', { status: 'done' as never })).toThrow(/invalid subject status/)
  })

  it('list puts active subjects first and filters by status', () => {
    eml.subjects.create({ name: 'a-old' })
    eml.subjects.create({ name: 'z-new' })
    eml.subjects.update('a-old', { status: 'closed' })
    expect(eml.subjects.list().map(t => t.id)).toEqual(['z-new', 'a-old'])
    expect(eml.subjects.list('closed').map(t => t.id)).toEqual(['a-old'])
  })

  it('deleting a subject row cascades its memberships (FK)', () => {
    eml.subjects.create({ name: 'gone' })
    const e = note('project.a', 'x', { subjects: ['gone'] })
    const db = new Database(join(dir, 't.db'))
    db.pragma('foreign_keys = ON')
    db.prepare(`DELETE FROM subjects WHERE id = 'gone'`).run()
    db.close()
    expect(eml.engrams.getRaw(e.id)!.subjects).toEqual([])
  })

  it('tags and subjects stay separate axes', () => {
    eml.tags.create({ name: 'deploy' })
    eml.subjects.create({ name: 'deploy' })
    const e = note('project.a', 'x', { tags: ['deploy'] })
    expect(e.tags).toEqual(['deploy'])
    expect(e.subjects).toEqual([])
  })
})

describe('v0.14 subjects — migration', () => {
  it('a raw v0.13 brain gains themes + engram_themes through the v0.14 migration (v0.17 renames them to subjects)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eml-subjects-mig-'))
    try {
      const db = new Database(join(dir, 'v13.db'))
      db.exec(readFileSync(V12_FIXTURE, 'utf-8'))
      db.exec(readFileSync(join(MIGRATIONS, 'v0.13_migrate.sql'), 'utf-8'))
      db.pragma('foreign_keys = OFF')
      db.exec(readFileSync(join(MIGRATIONS, 'v0.14_migrate.sql'), 'utf-8'))
      const tables = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('themes','engram_themes') ORDER BY name`,
      ).all() as Array<{ name: string }>).map(r => r.name)
      expect(tables).toEqual(['engram_themes', 'themes'])
      const idx = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='engram_themes' AND name LIKE 'idx_%' ORDER BY name`,
      ).all() as Array<{ name: string }>).map(r => r.name)
      expect(idx).toEqual(['idx_engram_themes_engram', 'idx_engram_themes_theme'])
      expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(14)
      expect(() => db.prepare(`INSERT INTO themes (id, name, status) VALUES ('x', 'x', 'done')`).run()).toThrow(/CHECK/)
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
