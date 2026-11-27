import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { applyMigration } from '../src/database'
import { verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { validNote, writes } from './fixtures'

// Schema 25 (asks and check-backs are separate): the step moves every stored
// delegation.schedule to the task's own field schedule and names who a
// wake-up is for (by = the delegation's agent: at 24 only the delegated
// agent's runner fired one), without touching any other field, rev or
// updated_at. Every device derives the same rows, a second run changes
// nothing, and the runner writes the checkpoint a rebuild at 25 starts from.

const NOW = '2026-11-27T12:00:00.000Z'
const AT = '2026-11-26T09:00:00.000Z'
const WAKE = '2026-11-28T02:00:00.000Z'
const BRAIN = '6f1d1b3e-2b7a-4c1e-9a55-0d7c2f8e4a10'

type Row = { id: string, properties: string, rev: number, updated_at: string }
type Props = Record<string, any>

/** The tasks schema 24 stored, by title. */
const TASKS: Record<string, Props> = {
  'crons-only': { goal: 'done', delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' } }, priority: 'high' },
  'wake-up': { goal: 'done', delegate: 'atlas', checkpoint: 'after', delegation: { agent: 'atlas', checkpoint: 'after', requested_at: AT, schedule: { at: WAKE, why: 'check whether the vendor answered', by_session: 'sess-1' } } },
  'everything': {
    delegate: 'motti', checkpoint: 'none',
    delegation: { agent: 'motti', checkpoint: 'none', schedule: { crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'], at: WAKE, why: 'look again', by_session: 'sess-2', time_zone: 'Asia/Makassar', paused: false, ends_at: '2026-12-31T00:00:00.000Z' } },
    waits: [{ id: 'w', who: 'ada', kind: 'review' }], waiting_on: { who: 'ada', kind: 'review' },
  },
  'paused-crons': { delegate: 'atlas', delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * *'], paused: true } } },
  'no-schedule': { delegate: 'atlas', checkpoint: 'before', delegation: { agent: 'atlas', checkpoint: 'before', requested_at: AT } },
  'no-delegation': { priority: 'low' },
}

/** A brain at schema 24 holding TASKS (and a note), its genesis over that state. */
function brainAt24(file: string): void {
  const db = new Database(file)
  const rows = Object.entries(TASKS).map(([title, props], i) =>
    `INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev, ord)
     VALUES ('task-${title}', 'task', 'global', '${title}', 'do it', 'active', '${JSON.stringify(props)}', '${AT}', '${AT}', 3, ${i + 1});`)
  // a note is no task: a schedule-looking property stays as it is
  rows.push(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev, ord)
     VALUES ('note-1', 'note', 'global', 'not-a-task', 'n', 'active', '{"delegation":{"agent":"atlas","schedule":{"at":"${WAKE}"}}}', '${AT}', '${AT}', 1, ${rows.length + 1});`)
  const sql = readFileSync(join(__dirname, 'fixtures', 'brain-v24.sql'), 'utf-8') + '\n' + rows.join('\n')
  applyMigration(db, 24, sql, () => AT, BRAIN, true)
  db.close()
}

function rows(db: Database.Database): Record<string, Row> {
  const all = db.prepare(`SELECT id, properties, rev, updated_at FROM engrams WHERE id LIKE 'task-%' OR id = 'note-1'`).all() as Row[]
  return Object.fromEntries(all.map(r => [r.id, r]))
}

describe('v0.25 migration — the schedule is the task\'s own field', () => {
  let dir: string
  let file: string
  let eml: EML
  let db: Database.Database
  let after: Record<string, Row>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-v025-mig-'))
    file = join(dir, 'v24.db')
    brainAt24(file)
    eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW, brainId: BRAIN })
    db = (eml as any).db as Database.Database
    after = rows(db)
  })
  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const props = (title: string): Props => JSON.parse(after[`task-${title}`].properties)

  it('brings the brain to the current schema', () => {
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
  })

  it('moves repeating times out of the delegation; without a wake-up there is no by', () => {
    expect(props('crons-only').schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(props('crons-only').delegation).toEqual({ agent: 'atlas' })
    expect(props('paused-crons').schedule).toEqual({ crons: ['0 8 * * *'], paused: true })
  })

  it('a wake-up keeps why and by_session and gets by = the delegation\'s agent', () => {
    expect(props('wake-up').schedule).toEqual({ at: WAKE, why: 'check whether the vendor answered', by: 'atlas', by_session: 'sess-1' })
    expect(props('wake-up').delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: AT })
  })

  it('keeps every key, in the stored order of schema 25', () => {
    const s = props('everything').schedule
    expect(Object.keys(s)).toEqual(['crons', 'at', 'why', 'by', 'by_session', 'time_zone', 'paused', 'ends_at'])
    expect(s).toEqual({ crons: ['0 13 * * 1-5', '0 18,22 * * 1-5'], at: WAKE, why: 'look again', by: 'motti', by_session: 'sess-2', time_zone: 'Asia/Makassar', paused: false, ends_at: '2026-12-31T00:00:00.000Z' })
    expect(after['task-everything'].properties).toContain('"paused":false')
  })

  it('changes nothing else: the other fields and their order, rev and updated_at', () => {
    for (const title of Object.keys(TASKS)) {
      const now = props(title)
      const { schedule: _s, ...delegationBefore } = TASKS[title].delegation ?? {}
      if (TASKS[title].delegation) expect(now.delegation, title).toEqual(delegationBefore)
      expect(Object.keys(now).filter(k => k !== 'schedule'), title).toEqual(Object.keys(TASKS[title]))
      expect({ ...now, delegation: undefined, schedule: undefined }, title).toEqual({ ...TASKS[title], delegation: undefined })
      expect([after[`task-${title}`].rev, after[`task-${title}`].updated_at], title).toEqual([3, AT])
    }
    expect(props('no-schedule').schedule).toBeUndefined()
    expect(after['task-no-schedule'].properties).toBe(JSON.stringify(TASKS['no-schedule']))
    expect(after['task-no-delegation'].properties).toBe(JSON.stringify(TASKS['no-delegation']))
  })

  it('an engram that is no task is not touched', () => {
    expect(JSON.parse(after['note-1'].properties)).toEqual({ delegation: { agent: 'atlas', schedule: { at: WAKE } } })
  })

  it('the moved schedule is what core stores: a write after it leaves it as it is', () => {
    const juno = eml.env({ handle: 'juno' })
    for (const title of ['crons-only', 'wake-up', 'everything', 'paused-crons']) {
      writes(eml).trackTask(`task-${title}`, { schedule: props(title).schedule }, juno)
      const stored = eml.engrams.getRaw(`task-${title}`)!.properties!.schedule
      expect(JSON.stringify(stored), title).toBe(JSON.stringify(props(title).schedule))
      expect(eml.engrams.entries(`task-${title}`, ['change']).map(e => e.text).filter(t => t.startsWith('schedule')), title).toEqual([])
    }
  })

  it('a second run changes nothing', () => {
    const before = stateDump(db)
    db.exec(readFileSync(join(__dirname, '..', 'migrations', 'brain', 'v0.25_migrate.sql'), 'utf-8'))
    expect(stateDump(db)).toEqual(before)
  })

  it('every device derives the same rows: two copies migrate to one state hash', () => {
    const hashes = ['a.db', 'b.db'].map(name => {
      const copy = join(dir, name)
      brainAt24(copy)
      const other = new EML({ namespace: 'test', dbPath: copy, clock: () => NOW, brainId: BRAIN })
      const h = other.stateHash()
      other.close()
      return h
    })
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[0]).toBe(eml.stateHash())
  }, process.platform === 'win32' ? 15_000 : 5_000)

  it('the checkpoint of schema 25 names the migrated state; the log verifies and goes on', () => {
    const log = db.prepare('SELECT seq, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, payload: string }>
    const payloads = log.map(e => JSON.parse(e.payload))
    expect(payloads[payloads.length - 1]).toMatchObject({ schema: 25, call: 'brain.checkpoint', args: { state_hash: stateHash(stateDump(db)) } })
    writes(eml).store(validNote({ scope: 'global', title: 'after-25' }), eml.env({ handle: 'juno' }))
    expect(verify(db)).toMatchObject({ ok: true, entries: log.length + 1 })
  })
})
