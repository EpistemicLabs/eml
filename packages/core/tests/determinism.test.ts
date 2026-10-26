import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { EML, addDays, COMMAND_NAMES, type Env } from '../src'
import { validDecision, validTask, validNote, writes, writeEverything } from './fixtures'
import { stateDump } from '../src/log/snapshot'

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

/** The brain's state, as the op log compares and hashes it (log/snapshot.ts). */
const dump = (eml: EML) => stateDump(raw(eml))

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
      for (const row of rows) {
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

  it('a write reads the clock once: the response (review_due, conflict and topic checks) uses the write\'s time', () => {
    // the brain's one clock, counted: the write's env and the store reads both use it
    let reads = 0
    const env0 = fixedEnv()
    const eml = new EML({ dbPath: ':memory:', namespace: 'test', newId: env0.newId, clock: () => { reads++; return env0.clock() } })
    const once = <T>(f: (env: Env) => T): T => {
      const env = eml.env({ handle: 'juno' })
      reads = 0
      const r = f(env)
      expect(reads).toBe(1)
      return r
    }
    once(env => writes(eml).projects.create({ id: 'p', name: 'P' }, env))
    once(env => writes(eml).projects.update('p', { goal: 'ship' }, env))
    const scope = 'project.p'
    const d = once(env => writes(eml).store(validDecision({ scope, title: 'pick-sqlite', content: 'Use SQLite for the brain store.' }), env))
    once(env => writes(eml).store(validDecision({ scope, title: 'pick-sqlite-again', content: 'Use SQLite for the brain store, again.' }), env))
    once(env => writes(eml).update(d.id, { content: 'Use SQLite for the local brain store.' }, env))
    once(env => writes(eml).confirmReview(d.id, 'still holds', env))
    const t = once(env => writes(eml).store(validTask({ scope, title: 'hub', status: 'active' }), env))
    once(env => writes(eml).trackTask(t.id, { text: 'progress' }, env))
    once(env => writes(eml).relate({ source_id: d.id, target_id: t.id, relation: 'supports', detection_method: 'manual' }, env))
    const l = once(env => writes(eml).learn({ scope: 'global', title: 'ask-first', content: 'Ask before acting.', source: 'self', happened: 'once' }, env))
    if (!l.written) throw new Error('not written')
    once(env => writes(eml).learn({ scope: 'global', title: 'ask-first-again', content: 'Ask before acting.', source: 'self', happened: 'twice' }, env))
    once(env => writes(eml).learn({ id: l.engram.id, source: 'observed', happened: 'again' }, env))
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
    // id sources, not call names: a random draw under any name (an aliased
    // randomUUID, the uuid package, raw random bytes) fails; uuidv5 — an id
    // derived from the op (log/op.ts) — is deterministic and passes
    [/\brandomUUID\b/, 'randomUUID'],
    [/\buuid(v[1-46-8])?\(/, 'uuid() / uuidv1–4, 6–8()'],
    [/from 'uuid'|require\('uuid'\)/, "the 'uuid' package"],
    [/\brandomBytes\b|getRandomValues|Math\.random/, 'random bytes'],
  ]
  const src = join(__dirname, '..', 'src')
  // recursive: the write code lives in commands/ and write/; paths are relative to src
  for (const file of (readdirSync(src, { recursive: true }) as string[]).filter(f => f.endsWith('.ts') && !ALLOWED.has(f)).sort()) {
    it(file, () => {
      const lines = readFileSync(join(src, file), 'utf-8').split('\n')
      const hits = lines.flatMap((line, i) => FORBIDDEN.filter(([re]) => re.test(line)).map(([, what]) => `${file}:${i + 1} ${what}`))
      expect(hits).toEqual([])
    })
  }
})
