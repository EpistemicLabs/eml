import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { createV20Brain, validNote, writes } from './fixtures'

// Schema 24 (a task holds its schedule): the step rewrites every stored
// delegation.schedule from the shape of schema 23 ({ at | cron, time_zone?,
// paused?, session? }) to the one of 24 ({ crons?, at?, why?, by_session?,
// time_zone?, paused?, ends_at? }) — cron becomes crons with that one entry,
// session is dropped, at, time_zone and paused stay — without touching any
// other field, rev or updated_at. Every device derives the same rows, and the
// runner writes the checkpoint a rebuild at 24 starts from.
//
// Schema 25 moves the schedule out of the delegation (properties.schedule) and
// adds by next to a wake-up (v025-migration.test.ts); these tests read the
// schedule where it lives now and leave by out.

const NOW = '2026-11-26T12:00:00.000Z'
const AT = '2026-11-24T09:00:00.000Z'
const WAKE = '2026-11-28T02:00:00.000Z'

type Row = { id: string, properties: string, rev: number, updated_at: string }
type Props = Record<string, any>

/** The delegations schema 23 stored, by task title. */
const DELEGATIONS: Record<string, Props | undefined> = {
  'cron-only': { agent: 'atlas', schedule: { cron: '0 8 * * 1-5' } },
  'at-only': { agent: 'atlas', checkpoint: 'after', schedule: { at: WAKE } },
  'cron-paused-resume': { agent: 'atlas', checkpoint: 'none', schedule: { cron: '0 13 * * 1-5', time_zone: 'Asia/Makassar', paused: true, session: 'resume' } },
  'at-new': { agent: 'atlas', requested_at: AT, schedule: { at: WAKE, session: 'new' } },
  'cron-not-paused': { agent: 'atlas', schedule: { cron: '0 8 * * *', paused: false, session: 'new' } },
  'cron-with-space': { agent: 'atlas', schedule: { cron: ' 0 8 * * * ' } },
  'at-paused': { agent: 'atlas', schedule: { at: WAKE, time_zone: 'Europe/Berlin', paused: true } },
  'no-schedule': { agent: 'atlas', checkpoint: 'before', requested_at: AT },
  // what no write of schema 23 stored: a schedule without a time is no schedule
  'no-time': { agent: 'atlas', checkpoint: 'after', schedule: { session: 'new', paused: true } },
  'blank-cron': { agent: 'atlas', schedule: { cron: ' ' } },
  'no-delegation': undefined,
}

/** A v20 brain with tasks as schema 23 stored them (a task that has a delegation is left alone by the step to 23). */
function brainWithSchedules(file: string): Record<string, Props> {
  createV20Brain(file)
  const tasks: Record<string, Props> = {}
  for (const [title, delegation] of Object.entries(DELEGATIONS)) {
    tasks[title] = delegation === undefined
      ? { priority: 'high', goal: 'done' }
      : { goal: 'done', delegate: delegation.agent, ...(delegation.checkpoint ? { checkpoint: delegation.checkpoint } : {}), delegation, priority: 'high' }
  }
  const db = new Database(file)
  const insert = db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES (?, 'task', 'global', ?, 'do it', 'active', ?, ?, ?, 3)`)
  for (const [title, props] of Object.entries(tasks)) insert.run(`task-${title}`, title, JSON.stringify(props), AT, AT)
  // a note is no task: a schedule-looking property stays as it is
  db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES ('note-1', 'note', 'global', 'not-a-task', 'n', 'active', '{"delegation":{"agent":"atlas","schedule":{"cron":"0 8 * * *"}}}', ?, ?, 1)`).run(AT, AT)
  db.close()
  return tasks
}

function rows(db: Database.Database): Record<string, Row> {
  const all = db.prepare(`SELECT id, properties, rev, updated_at FROM engrams WHERE id LIKE 'task-%' OR id = 'note-1'`).all() as Row[]
  return Object.fromEntries(all.map(r => [r.id, r]))
}

describe('v0.24 migration — the stored schedules in the shape of schema 24', () => {
  let dir: string
  let file: string
  let tasks: Record<string, Props>
  let eml: EML
  let db: Database.Database
  let after: Record<string, Row>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-v024-mig-'))
    file = join(dir, 'v20.db')
    tasks = brainWithSchedules(file)
    eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    db = (eml as any).db as Database.Database
    after = rows(db)
  })
  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const props = (title: string): Props => JSON.parse(after[`task-${title}`].properties)
  const schedule = (title: string): Props | undefined => {
    const s = props(title).schedule
    if (s === undefined) return undefined
    const { by: _by, ...rest } = s
    return rest
  }

  it('brings the brain to the current schema', () => {
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
  })

  it('a cron becomes crons with that one entry', () => {
    expect(schedule('cron-only')).toEqual({ crons: ['0 8 * * 1-5'] })
  })

  it('a wake-up (at) stays as it is', () => {
    expect(schedule('at-only')).toEqual({ at: WAKE })
  })

  it('a paused cron that resumed its session keeps time_zone and paused, and loses session', () => {
    expect(schedule('cron-paused-resume')).toEqual({ crons: ['0 13 * * 1-5'], time_zone: 'Asia/Makassar', paused: true })
  })

  it('a wake-up that started a new session loses session', () => {
    expect(schedule('at-new')).toEqual({ at: WAKE })
  })

  it('paused stays a JSON boolean, false too', () => {
    expect(schedule('cron-not-paused')).toEqual({ crons: ['0 8 * * *'], paused: false })
    expect(after['task-cron-not-paused'].properties).toContain('"paused":false')
    expect(after['task-at-paused'].properties).toContain('"paused":true')
  })

  it('a cron is stored without the white space around it, as a write at 24 stores it', () => {
    expect(schedule('cron-with-space')).toEqual({ crons: ['0 8 * * *'] })
  })

  it('the keys end in their stored order', () => {
    expect(Object.keys(schedule('cron-paused-resume')!)).toEqual(['crons', 'time_zone', 'paused'])
    expect(Object.keys(schedule('at-paused')!)).toEqual(['at', 'time_zone', 'paused'])
  })

  it('a delegation without a schedule and a task without a delegation stay as they are', () => {
    expect(after['task-no-schedule'].properties).toBe(JSON.stringify(tasks['no-schedule']))
    expect(after['task-no-delegation'].properties).toBe(JSON.stringify(tasks['no-delegation']))
  })

  it('a schedule without a time is removed; its delegation stays', () => {
    expect(props('no-time').delegation).toEqual({ agent: 'atlas', checkpoint: 'after' })
    expect(props('blank-cron').delegation).toEqual({ agent: 'atlas' })
  })

  it('an engram that is no task is not touched', () => {
    expect(JSON.parse(after['note-1'].properties)).toEqual({ delegation: { agent: 'atlas', schedule: { cron: '0 8 * * *' } } })
  })

  it('changes nothing else: the other fields, the rest of the delegation, the key order, rev and updated_at', () => {
    for (const title of Object.keys(tasks)) {
      const now = props(title)
      const { schedule: _s, ...delegation } = now.delegation ?? {}
      const { schedule: _old, ...delegationBefore } = tasks[title].delegation ?? {}
      expect(delegation, title).toEqual(delegationBefore)
      expect(Object.keys(now).filter(k => k !== 'schedule'), title).toEqual(Object.keys(tasks[title]))
      expect({ ...now, delegation: undefined, schedule: undefined }, title).toEqual({ ...tasks[title], delegation: undefined })
      expect([after[`task-${title}`].rev, after[`task-${title}`].updated_at], title).toEqual([3, AT])
    }
    expect(Object.keys(props('at-new').delegation)).toEqual(['agent', 'requested_at'])
  })

  it('no task holds a key of schema 23 any more', () => {
    for (const title of Object.keys(tasks)) {
      expect(Object.keys(schedule(title) ?? {}).filter(k => k === 'cron' || k === 'session'), title).toEqual([])
    }
  })

  it('the migrated schedule is what core stores: a flat write after it leaves it as it is', () => {
    const juno = eml.env({ handle: 'juno' })
    for (const title of ['cron-only', 'at-only', 'cron-paused-resume', 'at-new', 'cron-not-paused', 'cron-with-space', 'at-paused']) {
      writes(eml).trackTask(`task-${title}`, { checkpoint: 'before' }, juno)
      const stored = eml.engrams.getRaw(`task-${title}`)!.properties!.schedule as Props
      expect(JSON.stringify(stored), title).toBe(JSON.stringify(props(title).schedule))
      expect(eml.engrams.entries(`task-${title}`, ['change']).map(e => e.text).filter(t => t.startsWith('schedule')), title).toEqual([])
    }
  })

  it('every device derives the same rows: two copies migrate to one state hash', () => {
    const hashes = ['a.db', 'b.db'].map(name => {
      const copy = join(dir, name)
      brainWithSchedules(copy)
      const other = new EML({ namespace: 'test', dbPath: copy, clock: () => NOW, brainId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })
      const h = other.stateHash()
      other.close()
      return h
    })
    expect(hashes[0]).toBe(hashes[1])
  }, process.platform === 'win32' ? 15_000 : 5_000)

  it('the checkpoint of schema 24 names the migrated state, another one than the checkpoint of 23; the log verifies and goes on', () => {
    const log = db.prepare('SELECT seq, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, payload: string }>
    const payloads = log.map(e => JSON.parse(e.payload))
    const checkpoint = payloads.find(p => p.schema === 24 && p.call === 'brain.checkpoint')
    expect(checkpoint).toMatchObject({ schema: 24, call: 'brain.checkpoint' })
    const before = payloads.find(p => p.schema === 23 && p.call === 'brain.checkpoint')
    expect(before.args.state_hash).not.toBe(checkpoint.args.state_hash)
    // (schema 25 moves the schedules again: the last checkpoint names the state now)
    expect(payloads[payloads.length - 1]).toMatchObject({ schema: 25, call: 'brain.checkpoint', args: { state_hash: stateHash(stateDump(db)) } })

    writes(eml).store(validNote({ scope: 'project.p', title: 'after-24' }), eml.env({ handle: 'juno' }))
    expect(verify(db)).toMatchObject({ ok: true, entries: log.length + 1 })
  })
})
