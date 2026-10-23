import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { EML, addDays, COMMAND_NAMES } from '../src'
import {
  validDecision, validTask, validNote, validRule, validProfile, validStatus, validEvent, validLog, validReference, writes, createObject, updateObject,
} from './fixtures'

// v0.20 (spec sync-ready-write-path §2): a brain write is a function of
// (DB state, input, env). Core write code reads no clock and draws no id of its
// own; each write takes its time once and stamps every row it touches with it.

const START = Date.parse('2026-10-23T08:00:00.000Z')

/** A clock that moves 1 ms on every read, and ids from a counter. */
function fixedEnv() {
  let t = START
  let n = 0
  return {
    clock: () => new Date(t++).toISOString(),
    newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  }
}

function brain(): EML {
  return new EML({ dbPath: ':memory:', namespace: 'test', ...fixedEnv() })
}

const raw = (eml: EML): any => (eml as any).db

/**
 * The same writes on any brain: every mutator, with the side effects that touch
 * several rows (supersede, part_of, task_id, bound items, wikilinks, tags,
 * subjects, objects).
 */
function writeEverything(eml: EML): void {
  const juno = eml.env({ handle: 'juno', session_id: 's1', model: 'm', harness: 'h', ingestion_method: 'mcp' })
  const ada = eml.env({ handle: 'ada', session_id: 's2', ingestion_method: 'direct' })
  writes(eml).agents.store({ id: 'juno', name: 'Juno' }, juno)
  writes(eml).agents.update('juno', { description: 'the agent' })
  writes(eml).users.create({ id: 'ada', name: 'Ada' }, juno)
  writes(eml).users.update('ada', { email: 'ada@example.com' }, juno)
  createObject(eml, 'project', { id: 'p', name: 'P' }, juno)
  createObject(eml, 'entity', { id: 'acme', name: 'Acme', kind: 'org' }, juno)
  createObject(eml, 'tag', { name: 'ops' }, juno)
  createObject(eml, 'tag', { name: 'old', status: 'archived' }, juno)
  createObject(eml, 'subject', { name: 'launch' }, juno)
  createObject(eml, 'subject', { name: 'done-strand', status: 'closed' }, juno)
  updateObject(eml, 'entity', 'acme', { description: 'a customer' }, juno)
  updateObject(eml, 'tag', 'ops', { description: 'operations' }, juno)
  updateObject(eml, 'subject', 'launch', { description: 'the launch' }, juno)

  const scope = 'project.p'
  const parent = writes(eml).store(validTask({ scope, title: 'parent', status: 'active' }), juno)
  const child = writes(eml).store(validTask({ scope, title: 'child', parent_id: parent.id }), juno)
  const bound = writes(eml).store(validDecision({ scope, title: 'bound', task_id: parent.id, properties: { binding: 'task' } }), juno)
  const kept = writes(eml).store(validNote({ scope, title: 'kept', task_id: parent.id, properties: { binding: 'task' } }), juno)
  const note = writes(eml).store(validNote({ scope, title: 'note', content: 'see [[bound]] and [[nowhere]]', tags: ['ops'], subjects: ['launch'] }), ada)
  writes(eml).store(validStatus({ scope }), juno)
  writes(eml).store(validStatus({ scope, content: 'next state', properties: { state: 'next' } }), ada)
  writes(eml).store(validRule({ scope, title: 'rule-one' }), juno)
  writes(eml).store(validProfile({ scope: 'user.ada', title: 'ada', properties: { core: true } }), juno)
  writes(eml).store(validProfile({ scope: 'user.ada', title: 'ada-2', properties: { core: true } }), juno)
  writes(eml).store(validEvent({ scope, title: 'shipped' }), juno)
  const log = writes(eml).store(validLog({ scope, title: 'session' }), juno)
  writes(eml).store(validReference({ scope, title: 'ref' }), juno)

  writes(eml).trackTask(child.id, { text: 'started', status: 'active', stage: 'implementation', tags: ['ops'] }, juno)
  writes(eml).trackTask(child.id, { status: 'resolved', outcome: 'done', text: 'finished' }, juno)
  writes(eml).trackTask(parent.id, { status: 'resolved', outcome: 'done', text: 'closed', keep: [kept.id] }, ada)
  writes(eml).trackTask(parent.id, { status: 'active', text: 'reopened' }, ada)
  const successor = writes(eml).store(validTask({ scope, title: 'successor', supersedes: [parent.id] }), juno)
  writes(eml).trackTask(successor.id, { subjects: ['launch'], priority: 'high' }, juno)

  writes(eml).update(note.id, { content: 'see [[kept]] again', tags: [], subjects: ['launch'] }, ada)
  writes(eml).update(log.id, { properties: { next: 'go on' } }, ada)
  const decision = writes(eml).store(validDecision({ scope, title: 'standing-one' }), juno)
  writes(eml).update(decision.id, { review_note: 'still holds' }, juno)
  writes(eml).confirmReview(decision.id, 'confirmed again', ada)
  writes(eml).confirmReview(successor.id, 'still relevant', ada)
  const replacement = writes(eml).store(validDecision({ scope, title: 'replacement' }), juno)
  writes(eml).update(replacement.id, { supersedes: [decision.id] }, juno)
  writes(eml).update(bound.id, { status: 'invalidated' }, juno)

  const learned = writes(eml).learn({ scope: 'user.ada', title: 'ask-first', content: 'Ask before acting.', source: 'user', happened: 'once', quote: 'ask me' }, juno)
  if (!learned.written) throw new Error('learning not written')
  writes(eml).learn({ id: learned.engram.id, source: 'observed', happened: 'twice', content: 'Ask before acting, always.' }, ada)
  writes(eml).relate({ source_id: note.id, target_id: decision.id, relation: 'supports', detection_method: 'manual' }, juno)

  updateObject(eml, 'project', 'p', { status: 'archived' }, juno)
}

/** Every brain table as sorted JSON rows (FTS shadow tables, the dead labels table and the migration log aside). */
function dump(eml: EML): Record<string, string[]> {
  const tables = (raw(eml).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'engrams_fts_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map(r => r.name)
    .filter(n => n !== '_eml_migrations' && n !== 'labels')
  return Object.fromEntries(tables.map(t => [t, (raw(eml).prepare(`SELECT * FROM ${t}`).all() as unknown[]).map(r => JSON.stringify(r)).sort()]))
}

describe('deterministic writes', () => {
  it('the same commands with the same env give the same brain, row for row', () => {
    const a = brain()
    const b = brain()
    // every write goes through apply(), and the sequence uses all eight commands
    const used = new Set<string>()
    const apply = a.apply.bind(a)
    a.apply = ((command: { name: string }, env?: unknown) => { used.add(command.name); return apply(command as never, env as never) }) as typeof a.apply
    writeEverything(a)
    expect([...used].sort()).toEqual([...COMMAND_NAMES].sort())
    writeEverything(b)
    const da = dump(a)
    expect(Object.keys(da)).toEqual(expect.arrayContaining(['engrams', 'relations', 'entries', 'engram_tags', 'engram_subjects', 'tags', 'subjects', 'projects', 'entities', 'users', 'agents']))
    for (const t of ['engrams', 'relations', 'entries', 'engram_tags', 'engram_subjects', 'tags', 'subjects', 'projects', 'entities', 'users', 'agents']) {
      expect(da[t].length, t).toBeGreaterThan(0)
    }
    expect(dump(b)).toEqual(da)
    a.close(); b.close()
  })

  it('every timestamp a write stores is ISO-8601 UTC with milliseconds, from the env clock', () => {
    const eml = brain()
    writeEverything(eml)
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    const end = Date.parse(eml.now())
    for (const [table, rows] of Object.entries(dump(eml))) {
      for (const row of rows.map(r => JSON.parse(r) as Record<string, unknown>)) {
        for (const col of ['created_at', 'updated_at', 'at']) {
          if (!(col in row)) continue
          expect(row[col], `${table}.${col}`).toMatch(iso)
          const ms = Date.parse(row[col] as string)
          expect(ms >= START && ms <= end, `${table}.${col} ${row[col]}`).toBe(true)
        }
      }
    }
    eml.close()
  })

  it('one timestamp per write: closing a task stamps the task, its entries, the bound items and their entries alike', () => {
    const eml = brain()
    const env = eml.env({ handle: 'juno' })
    writes(eml).projects.create({ id: 'p', name: 'P' }, env)
    const task = writes(eml).store(validTask({ scope: 'project.p', title: 'hub', status: 'active' }), env)
    const closes = writes(eml).store(validNote({ scope: 'project.p', title: 'closes', task_id: task.id, properties: { binding: 'task' } }), env)
    const stays = writes(eml).store(validDecision({ scope: 'project.p', title: 'stays', task_id: task.id, properties: { binding: 'task' } }), env)
    const next = writes(eml).store(validTask({ scope: 'project.p', title: 'next', status: 'active' }), env)

    const r = writes(eml).trackTask(next.id, { text: 'takes over', supersedes: [task.id], tags: [] }, env)!
    const at = r.updated_at
    expect(r.entries_written.map(e => e.at)).toEqual(r.entries_written.map(() => at))
    expect(raw(eml).prepare(`SELECT updated_at FROM engrams WHERE id = ?`).get(task.id).updated_at).toBe(at)
    expect(raw(eml).prepare(`SELECT created_at FROM relations WHERE source_id = ? AND target_id = ?`).get(next.id, task.id).created_at).toBe(at)

    const closed = writes(eml).trackTask(next.id, { status: 'resolved', outcome: 'done', text: 'done', keep: [stays.id] }, env)!
    const t = closed.updated_at
    expect(t > at).toBe(true)
    const stampedAt = (sql: string, ...args: string[]) => (raw(eml).prepare(sql).all(...args) as Array<{ v: string }>).map(x => x.v)
    expect(new Set([
      ...closed.entries_written.map(e => e.at),
      ...stampedAt(`SELECT updated_at AS v FROM engrams WHERE id IN (?, ?)`, closes.id, stays.id),
      ...stampedAt(`SELECT at AS v FROM entries WHERE engram_id IN (?, ?) AND at >= ?`, closes.id, stays.id, t),
    ])).toEqual(new Set([t]))
    // kept as standing, its review clock starts at the same time
    expect(eml.engrams.get(stays.id)!.properties!.review_due_at).toBe(addDays(t, 60))
    eml.close()
  })
})

// The source rule behind it: no clock read and no id drawn in core outside the
// env (env.ts) and the files that are not brain writes.
describe('no clock or id source in core write code', () => {
  const ALLOWED = new Set([
    'env.ts',                // the one source: systemClock, randomId
    'decay.ts',              // recencyBoost's default for callers outside a brain (EngramStore passes its clock)
    'control.ts', 'tokens.ts', 'provisioning.ts', 'forward-migrations.ts',  // control DB and migration infra, not brain writes
  ])
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/Date\.now\(/, 'Date.now()'],
    [/new Date\(\)/, 'new Date()'],
    [/datetime\('now'/, "datetime('now')"],
    [/CURRENT_TIMESTAMP/, 'CURRENT_TIMESTAMP'],
    [/\buuid\w*\(|randomUUID\(/, 'uuid()'],
  ]
  const src = join(__dirname, '..', 'src')
  for (const file of readdirSync(src).filter(f => f.endsWith('.ts') && !ALLOWED.has(f))) {
    it(file, () => {
      const lines = readFileSync(join(src, file), 'utf-8').split('\n')
      const hits = lines.flatMap((line, i) => FORBIDDEN.filter(([re]) => re.test(line)).map(([, what]) => `${file}:${i + 1} ${what}`))
      expect(hits).toEqual([])
    })
  }
})
