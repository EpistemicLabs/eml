import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { createObject, createV20Brain, writes } from './fixtures'

// Schema 23 (task state): the step adds the runs table and brings every
// existing task into the mirrored state — a delegate gets its delegation, a
// waiting_on with a who gets its waits — without touching any other field, rev
// or updated_at. Every device derives the same rows, and the runner writes the
// checkpoint a rebuild at 23 starts from.

const NOW = '2026-11-23T12:00:00.000Z'
const AT = '2026-11-20T09:00:00.000Z'

type Row = { id: string, properties: string, rev: number, updated_at: string }

/** A v20 brain with tasks as the task system wrote them up to schema 22. */
function brainWithTasks(file: string): Record<string, Record<string, unknown>> {
  createV20Brain(file)
  const tasks: Record<string, Record<string, unknown>> = {
    delegated: { delegate: 'atlas', checkpoint: 'after', goal: 'done' },
    'delegated-no-checkpoint': { delegate: 'atlas' },
    'checkpoint-only': { checkpoint: 'before' },
    'bad-checkpoint': { delegate: 'atlas', checkpoint: 'later' },
    'blank-delegate': { delegate: '' },
    waiting: { waiting_on: { who: 'lasse', kind: 'review', why: 'look at it', since: '2026-11-22T10:00:00.000Z', session_id: 'sess-1' } },
    'waiting-loose': { waiting_on: { who: 'lasse', kind: 'someday', since: '2026-11-22', extra: 'x' } },
    'waiting-nobody': { waiting_on: { why: 'no who' } },
    both: { delegate: 'motti', checkpoint: 'none', waiting_on: { who: 'dominik', kind: 'question', why: 'which?', session_id: '' } },
    plain: { priority: 'high' },
  }
  const db = new Database(file)
  const insert = db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES (?, 'task', 'global', ?, 'do it', 'active', ?, ?, ?, 3)`)
  for (const [title, props] of Object.entries(tasks)) insert.run(`task-${title}`, title, JSON.stringify(props), AT, AT)
  // a note with a delegate-looking property is no task: it stays as it is
  db.prepare(`INSERT INTO engrams (id, type, scope, title, content, status, properties, created_at, updated_at, rev)
    VALUES ('note-1', 'note', 'global', 'not-a-task', 'n', 'active', '{"detail":"delegate"}', ?, ?, 1)`).run(AT, AT)
  db.close()
  return tasks
}

function rows(db: Database.Database): Record<string, Row> {
  const all = db.prepare(`SELECT id, properties, rev, updated_at FROM engrams WHERE id LIKE 'task-%' OR id = 'note-1'`).all() as Row[]
  return Object.fromEntries(all.map(r => [r.id, r]))
}

describe('v0.23 migration — runs, and the mirrored task state for existing tasks', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v023-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('backfills delegation and waits from the flat fields, and changes nothing else', () => {
    const file = join(dir, 'v20.db')
    const tasks = brainWithTasks(file)
    const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    const db = (eml as any).db as Database.Database
    expect((db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get() as { v: number }).v).toBe(CURRENT_BRAIN_SCHEMA_VERSION)
    const after = rows(db)
    const props = (title: string) => JSON.parse(after[`task-${title}`].properties)

    expect(props('delegated')).toEqual({ ...tasks.delegated, delegation: { agent: 'atlas', checkpoint: 'after', mode: 'alone' } })
    expect(props('delegated-no-checkpoint').delegation).toEqual({ agent: 'atlas', mode: 'alone' })
    expect(props('checkpoint-only')).toEqual(tasks['checkpoint-only'])
    expect(props('bad-checkpoint').delegation).toEqual({ agent: 'atlas', mode: 'alone' })
    expect(props('blank-delegate')).toEqual(tasks['blank-delegate'])
    expect(props('waiting').waits).toEqual([{ id: 'sess-1', who: 'lasse', kind: 'review', why: 'look at it', since: '2026-11-22T10:00:00.000Z', session_id: 'sess-1' }])
    expect(props('waiting-loose').waits).toEqual([{ id: 'waiting_on', who: 'lasse' }])
    expect(props('waiting-nobody')).toEqual(tasks['waiting-nobody'])
    expect(props('both')).toMatchObject({
      delegation: { agent: 'motti', checkpoint: 'none', mode: 'alone' },
      waits: [{ id: 'waiting_on', who: 'dominik', kind: 'question', why: 'which?', session_id: '' }],
    })
    expect(props('plain')).toEqual(tasks.plain)
    expect(JSON.parse(after['note-1'].properties)).toEqual({ detail: 'delegate' })
    // the flat fields stay as they were, and so do rev and updated_at
    for (const title of Object.keys(tasks)) {
      const { delegation: _d, waits: _w, ...rest } = props(title)
      expect(rest, title).toEqual(tasks[title])
      expect([after[`task-${title}`].rev, after[`task-${title}`].updated_at], title).toEqual([3, AT])
    }
    eml.close()
  })

  it('the migrated state is what core\'s mirror derives: a flat write after it keeps mode and the waits follow', () => {
    const file = join(dir, 'v20.db')
    brainWithTasks(file)
    const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    const juno = eml.env({ handle: 'juno' })
    writes(eml).trackTask('task-delegated', { checkpoint: 'before' }, juno)
    expect(eml.engrams.getRaw('task-delegated')!.properties!.delegation).toEqual({ agent: 'atlas', checkpoint: 'before', mode: 'alone' })
    writes(eml).trackTask('task-waiting', { waiting_on: null }, juno)
    expect(eml.engrams.getRaw('task-waiting')!.properties!.waits).toBeUndefined()
    eml.close()
  })

  it('every device derives the same rows: two copies migrate to one state hash', () => {
    const a = join(dir, 'a.db')
    const b = join(dir, 'b.db')
    brainWithTasks(a)
    brainWithTasks(b)
    const hashes = [a, b].map(file => {
      const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW, brainId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })
      const h = eml.stateHash()
      eml.close()
      return h
    })
    expect(hashes[0]).toBe(hashes[1])
  })

  it('adds the runs table, and the checkpoint of schema 23 names the migrated state; the log verifies and goes on', () => {
    const file = join(dir, 'v20.db')
    brainWithTasks(file)
    const eml = new EML({ namespace: 'test', dbPath: file, clock: () => NOW })
    const db = (eml as any).db as Database.Database
    expect((db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('runs') as Array<{ name: string }>).map(c => c.name))
      .toEqual(['id', 'task_id', 'member', 'agent', 'origin', 'driver', 'state', 'started_at', 'heartbeat_at', 'lease_until', 'created_at', 'updated_at'])
    const log = db.prepare('SELECT seq, payload FROM op_log ORDER BY seq').all() as Array<{ seq: number, payload: string }>
    const checkpoint = JSON.parse(log[log.length - 1].payload)
    expect(checkpoint).toMatchObject({ schema: 23, call: 'brain.checkpoint', args: { state_hash: stateHash(stateDump(db)) } })

    const juno = eml.env({ handle: 'juno' })
    createObject(eml, 'run', { id: 'sess-9', task_id: 'task-plain', member: 'juno', origin: 'user', driver: 'human' }, juno)
    expect(verify(db)).toMatchObject({ ok: true, entries: log.length + 1 })
    eml.close()
  })

  it('the runs table refuses values outside its enums, like the command does', () => {
    const eml = new EML({ namespace: 'test', dbPath: ':memory:', clock: () => NOW })
    const db = (eml as any).db as Database.Database
    const insert = (state: string) => db.prepare(`INSERT INTO runs (id, task_id, member, origin, driver, state, started_at, created_at, updated_at)
      VALUES ('r', 't', 'm', 'user', 'human', ?, ?, ?, ?)`).run(state, NOW, NOW, NOW)
    expect(() => insert('paused')).toThrow(/CHECK constraint/)
    expect(() => insert('running')).not.toThrow()
    eml.close()
  })
})
