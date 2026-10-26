import { describe, it, expect, vi, afterEach } from 'vitest'
import { EML, CommandError, COMMAND_NAMES, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { engramCreate } from '../src/commands/engram-create'
import { applyOp } from '../src/log/apply-op'
import { GENESIS_PREV_HASH, chainHash, sha256Hex, uuidv5, type OpEnvelope } from '../src/log/op'
import { brainRef, exportSet } from '../src/log/move'
import { otherBrain, validDecision, validNote, validTask } from './fixtures'

// v0.21 (spec local-op-log-spec, block 3): every write is an op in the log —
// appended, then applied on the args as stored, at the entry's time, with ids
// derived from the op_id. Only applied writes stay in the log.

const START = '2026-10-26T08:00:00.000Z'

/** A brain with a clock the test sets, and op_ids from a counter. */
function brain(): { eml: EML, setClock(iso: string): void } {
  let now = START
  let n = 0
  const eml = new EML({
    dbPath: ':memory:', namespace: 'test',
    clock: () => now,
    newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
  return { eml, setClock: (iso: string) => { now = iso } }
}

const raw = (eml: EML): any => (eml as any).db
type Entry = { seq: number, at: string, op_id: string, prev_hash: string, payload_hash: string, hash: string, signature: Buffer | null, payload: string }
const log = (eml: EML): Entry[] => raw(eml).prepare('SELECT * FROM op_log ORDER BY seq').all()
const last = (eml: EML): Entry => log(eml).at(-1)!
const payloadOf = (e: Entry): OpEnvelope => JSON.parse(e.payload)

function rejection(fn: () => unknown): CommandError {
  try { fn() } catch (e) { return e as CommandError }
  throw new Error('expected a rejection')
}

afterEach(() => { vi.restoreAllMocks() })

describe('writes through the op log', () => {
  it('every command appends exactly one op: its call, its args as given, the schema and the actor', () => {
    const { eml } = brain()
    const env = eml.env({ handle: 'juno', session_id: 's1', model: 'm', harness: 'h', ingestion_method: 'mcp' })
    const used = new Set<string>()
    const write = <T>(name: string, input: object): T => {
      const before = log(eml).length
      const result = eml.apply({ name, input } as never, env) as T
      expect(log(eml).length, name).toBe(before + 1)
      const op = payloadOf(last(eml))
      expect(op).toMatchObject({ schema: CURRENT_BRAIN_SCHEMA_VERSION, call: name, provenance: env.actor })
      expect(op.args).toEqual(JSON.parse(JSON.stringify(input)))
      used.add(name)
      return result
    }
    write('object.create', { object: 'project', fields: { id: 'p', name: 'P' } })
    write('object.create', { object: 'tag', fields: { name: 'ops' } })
    write('object.update', { object: 'project', id: 'p', patch: { goal: 'ship' } })
    const t = write<{ id: string }>('engram.create', validTask({ scope: 'project.p', title: 'hub', status: 'active', tags: ['ops'] }))
    write('task.track', { id: t.id, text: 'progress' })
    const d = write<{ id: string }>('engram.create', validDecision({ scope: 'project.p', title: 'pick' }))
    write('engram.update', { id: d.id, patch: { content: 'picked again' } })
    write('engram.confirm_review', { id: d.id, text: 'still holds' })
    write('relation.create', { source_id: d.id, target_id: t.id, relation: 'supports', detection_method: 'manual' })
    const l = write<{ id: string }>('engram.create', { type: 'learning', scope: 'global', title: 'ask-first', content: 'Ask before acting.', evidence: { source: 'self', happened: 'once' } })
    write('learning.add_evidence', { id: l.id, source: 'observed', happened: 'again' })
    const other = otherBrain()
    const set = exportSet((other as any).db, ((other as any).db.prepare('SELECT id FROM engrams').all() as Array<{ id: string }>).map(r => r.id))
    write('engram.import', { source: brainRef((other as any).db), set_hash: set.set_hash, rows: set.rows })
    other.close()
    expect([...used].sort()).toEqual([...COMMAND_NAMES].sort())
    eml.close()
  })

  it('the ids a write draws are uuidv5(op_id, n), and its rows carry the entry\'s time', () => {
    const { eml } = brain()
    eml.apply({ name: 'object.create', input: { object: 'project', fields: { id: 'p', name: 'P' } } })
    const task = eml.apply({ name: 'engram.create', input: validTask({ scope: 'project.p', title: 'hub', status: 'active' }) })
    const entry = last(eml)
    const derived = new Set(Array.from({ length: 32 }, (_, n) => uuidv5(entry.op_id, String(n))))
    expect(derived.has(task.id)).toBe(true)
    const entries = raw(eml).prepare('SELECT id, at FROM entries WHERE engram_id = ?').all(task.id) as Array<{ id: string, at: string }>
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(derived.has(e.id)).toBe(true)
      expect(e.at).toBe(entry.at)
    }
    expect(task.created_at).toBe(entry.at)
    eml.close()
  })

  it('a rejected write leaves no log entry: NOT_FOUND, and CONFLICT on a stale base_rev', () => {
    const { eml } = brain()
    const note = eml.apply({ name: 'engram.create', input: validNote({ title: 'n' }) })
    const before = log(eml)
    expect(rejection(() => eml.apply({ name: 'task.track', input: { id: '00000000-0000-4000-8000-0000000000ff', text: 'x' } })).code).toBe('NOT_FOUND')
    expect(rejection(() => eml.apply({ name: 'engram.update', input: { id: note.id, patch: { content: 'c2' }, base_rev: 7 } })).code).toBe('CONFLICT')
    expect(log(eml)).toEqual(before)
    eml.close()
  })

  it('a shape error leaves no log entry: unknown command, an input that is no object, a value that is not plain JSON', () => {
    const { eml } = brain()
    const before = log(eml)
    expect(rejection(() => eml.apply({ name: 'engram.delete', input: {} } as never)).code).toBe('INVALID')
    expect(rejection(() => eml.apply({ name: 'engram.create', input: 'a note' } as never)).code).toBe('INVALID')
    const nan = rejection(() => eml.apply({ name: 'engram.create', input: { ...validNote({ title: 'n' }), properties: { weight: NaN } } as never }))
    expect(nan.code).toBe('INVALID')
    expect(nan.message).toMatch(/plain JSON; \$\.args\.properties\.weight is NaN/)
    expect(log(eml)).toEqual(before)
    eml.close()
  })

  it('time never goes back: when the clock does, the entry keeps the head\'s time', () => {
    const { eml, setClock } = brain()
    const genesis = last(eml).at
    expect(genesis).toBe(START)
    setClock('2026-10-26T09:00:00.000Z')
    eml.apply({ name: 'engram.create', input: validNote({ title: 'first' }) })
    setClock('2026-10-26T07:00:00.000Z')  // back an hour before the genesis
    const second = eml.apply({ name: 'engram.create', input: validNote({ title: 'second' }) })
    expect(last(eml).at).toBe('2026-10-26T09:00:00.000Z')
    expect(second.created_at).toBe('2026-10-26T09:00:00.000Z')
    setClock('2026-10-26T10:00:00.000Z')
    eml.apply({ name: 'engram.create', input: validNote({ title: 'third' }) })
    expect(log(eml).map(e => e.at)).toEqual([START, '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-10-26T10:00:00.000Z'])
    eml.close()
  })

  it('a key whose value is undefined: the stored payload leaves it out, and the command saw exactly the stored args', () => {
    const { eml } = brain()
    const seen: unknown[] = []
    const validate = engramCreate.validate
    vi.spyOn(engramCreate, 'validate').mockImplementation((input: unknown) => { seen.push(input); return validate(input) })
    eml.apply({ name: 'engram.create', input: { ...validNote({ title: 'u' }), significance: undefined } as never })
    const args = payloadOf(last(eml)).args as Record<string, unknown>
    expect('significance' in args).toBe(false)
    expect(seen).toEqual([args])
    expect('significance' in (seen[0] as object)).toBe(false)
    eml.close()
  })

  it('the payload keeps the caller\'s key order: properties are stored in that order, and a replay of the payload writes the same row', () => {
    const a = brain()
    const b = brain()
    const decision = a.eml.apply({ name: 'engram.create', input: { type: 'decision', scope: 'global', title: 'pick', content: 'chose it', properties: { rationale: 'r', alternatives: ['x'] } } })
    const row = (eml: EML) => raw(eml).prepare('SELECT * FROM engrams WHERE id = ?').get(decision.id)
    expect(row(a.eml).properties.startsWith('{"rationale":"r","alternatives":["x"]')).toBe(true)
    // the replay: the entry's payload and time applied to a brain at the same state
    const entry = last(a.eml)
    const e = b.eml
    const stores = { eml: e, db: raw(e), store: e.engrams, projects: e.projects, users: e.users, agents: e.agents, entities: e.entities, tags: e.tags, subjects: e.subjects }
    raw(e).transaction(() => applyOp(stores, payloadOf(entry), entry.at))()
    expect(row(b.eml)).toEqual(row(a.eml))
    a.eml.close(); b.eml.close()
  })

  it('entries chain: each prev_hash is the previous link, every link and payload hash verifies', () => {
    const { eml } = brain()
    eml.apply({ name: 'engram.create', input: validNote({ title: 'one' }) })
    eml.apply({ name: 'engram.create', input: validNote({ title: 'two' }) })
    const entries = log(eml)
    expect(entries.map(e => e.seq)).toEqual([1, 2, 3])
    expect(entries[0].prev_hash).toBe(GENESIS_PREV_HASH)
    entries.forEach((e, i) => {
      if (i > 0) expect(e.prev_hash).toBe(entries[i - 1].hash)
      expect(e.payload_hash).toBe(sha256Hex(e.payload))
      expect(e.hash).toBe(chainHash(e.prev_hash, e.seq, e.at, e.payload_hash))
      expect(e.signature).toBeNull()
    })
    eml.close()
  })
})
