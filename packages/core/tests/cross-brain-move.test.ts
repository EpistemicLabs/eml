import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { EML, CommandError } from '../src'
import { listEntries } from '../src/entries'
import { verify } from '../src/log/rebuild'
import { MOVED_COLUMNS, brainRef, exportSet, setHash, type MovedRows } from '../src/log/move'
import { createObject, validDecision, validProfile, validRule, validStatus, validTask, writes } from './fixtures'

// v0.21 (spec cross-brain-move-spec, block 2): a set of engrams is exported
// from one brain as rows and imported into another as they are — ids,
// authorship, times, rev, journals, the relations inside the set, tags,
// subjects and the scope objects they need.

function brain(name: string, start = '2026-10-20T08:00:00.000Z'): EML {
  let t = Date.parse(start)
  let n = 0
  return new EML({
    dbPath: ':memory:', namespace: name,
    clock: () => new Date(t++).toISOString(),
    newId: () => `${createHash('sha1').update(name).digest('hex').slice(0, 8)}-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
}

const raw = (eml: EML): Database.Database => (eml as any).db
const ids = (eml: EML, where = '1 = 1'): string[] => (raw(eml).prepare(`SELECT id FROM engrams WHERE ${where} ORDER BY ord`).all() as Array<{ id: string }>).map(r => r.id)
const opCount = (eml: EML) => (raw(eml).prepare('SELECT COUNT(*) AS n FROM op_log').get() as { n: number }).n

/** The import's input for `set` from `source`. */
const importOf = (source: EML, set: ReturnType<typeof exportSet>) => ({ source: brainRef(raw(source)), set_hash: set.set_hash, rows: set.rows })

function reject(f: () => unknown): CommandError {
  try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
  throw new Error('not rejected')
}

/**
 * A source brain: project p (child of project root) with a task and its
 * journal, a sub-task (part_of), a decision bound to the task, a superseded
 * decision, a rule outside the set that a learning's evidence names, and a
 * note outside the set related both ways.
 */
function source() {
  const eml = brain('source')
  const kai = eml.env({ handle: 'kai', session_id: 's1', model: 'm1', harness: 'h1', ingestion_method: 'mcp' })
  const ada = eml.env({ handle: 'ada', session_id: 's2', ingestion_method: 'direct' })
  createObject(eml, 'project', { id: 'root', name: 'Root' }, kai)
  createObject(eml, 'project', { id: 'p', name: 'P', parent_project: 'root', metadata: { repo: 'r' } }, kai)
  createObject(eml, 'project', { id: 'elsewhere', name: 'Elsewhere' }, kai)
  createObject(eml, 'user', { id: 'ada', name: 'Ada' }, kai)
  createObject(eml, 'tag', { name: 'ops', description: 'source ops' }, kai)
  createObject(eml, 'subject', { name: 'launch' }, kai)
  const task = writes(eml).store(validTask({ scope: 'project.p', title: 'hub', status: 'active', tags: ['ops'], subjects: ['launch'] }), kai)
  const sub = writes(eml).store(validTask({ scope: 'project.p', title: 'sub', parent_id: task.id }), kai)
  const bound = writes(eml).store(validDecision({ scope: 'project.p', title: 'bound', task_id: task.id, properties: { binding: 'task' } }), ada)
  const old = writes(eml).store(validDecision({ scope: 'project.p', title: 'old' }), kai)
  const next = writes(eml).store(validDecision({ scope: 'project.p', title: 'next', supersedes: [old.id] }), ada)
  writes(eml).trackTask(sub.id, { status: 'resolved', outcome: 'done', text: 'finished' }, ada)
  writes(eml).trackTask(task.id, { text: 'progress', stage: 'implementation' }, kai)
  const rule = writes(eml).store(validRule({ scope: 'project.elsewhere', title: 'outside-rule' }), kai)
  const learned = writes(eml).learn({ scope: 'user.ada', title: 'ask-first', content: 'Ask first.', source: 'user', happened: 'once', quote: 'ask', rule_id: rule.id }, kai)
  if (!learned.written) throw new Error('learning not written')
  const outside = writes(eml).store(validDecision({ scope: 'project.elsewhere', title: 'outside' }), kai)
  writes(eml).relate({ source_id: outside.id, target_id: task.id, relation: 'supports', detection_method: 'manual' }, kai)
  writes(eml).relate({ source_id: next.id, target_id: outside.id, relation: 'related_to', detection_method: 'manual' }, kai)
  const set = [task.id, sub.id, bound.id, old.id, next.id, learned.engram.id]
  return { eml, set, task, sub, bound, old, next, rule, learned: learned.engram, outside }
}

describe('exportSet', () => {
  it('carries every stored column but ord', () => {
    const eml = brain('cols')
    for (const [table, cols] of Object.entries(MOVED_COLUMNS)) {
      const stored = (raw(eml).prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(c => c.name).filter(c => c !== 'ord')
      expect([...cols].sort(), table).toEqual(stored.sort())
    }
    eml.close()
  })

  it('the rows of the set and what moves with them, in a fixed order; the rest listed', () => {
    const s = source()
    const set = exportSet(raw(s.eml), [...s.set].reverse())
    const { rows } = set
    expect(rows.engrams.map(e => e.id)).toEqual(ids(s.eml).filter(id => s.set.includes(id)))
    expect(rows.engrams.every(e => !('ord' in e))).toBe(true)
    // the project with its parent first; the learning's user
    expect(rows.projects.map(p => p.id)).toEqual(['root', 'p'])
    expect(rows.users.map(u => u.id)).toEqual(['ada'])
    expect(rows.entities).toEqual([])
    expect(rows.agents).toEqual([])
    expect(rows.tags).toEqual([expect.objectContaining({ id: 'ops', description: 'source ops' })])
    expect(rows.subjects.map(x => x.id)).toEqual(['launch'])
    // relations inside the set: part_of, the task binding, supersedes
    expect(rows.relations.some(r => r.source_id === s.bound.id && r.target_id === s.task.id)).toBe(true)
    expect(rows.relations.some(r => r.relation === 'part_of' && r.source_id === s.sub.id && r.target_id === s.task.id)).toBe(true)
    expect(rows.relations.some(r => r.relation === 'supersedes' && r.source_id === s.next.id && r.target_id === s.old.id)).toBe(true)
    // entries by ord, the journal with its authors
    const ords = (raw(s.eml).prepare(`SELECT id FROM entries WHERE engram_id IN (SELECT value FROM json_each(?)) ORDER BY ord`).all(JSON.stringify(rows.engrams.map(e => e.id))) as Array<{ id: string }>).map(r => r.id)
    expect(rows.entries.map(e => e.id)).toEqual(ords)
    expect(rows.entries.some(e => e.author === 'ada' && e.text === 'finished')).toBe(true)
    // crossing relations both ways; the learning's rule stays as an external reference
    expect(set.crossing.map(r => [r.source_id, r.target_id]).sort()).toEqual([[s.next.id, s.outside.id], [s.outside.id, s.task.id]].sort())
    expect(set.external_refs).toEqual([expect.objectContaining({ engram_id: s.learned.id, rule_id: s.rule.id })])
    expect(set.set_hash).toBe(setHash(rows))
    s.eml.close()
  })

  it('the set hash does not depend on key order', () => {
    const s = source()
    const { rows, set_hash } = exportSet(raw(s.eml), s.set)
    const reordered = Object.fromEntries(Object.entries(rows).reverse().map(([t, list]) => [t, list.map(r => Object.fromEntries(Object.entries(r).reverse()))])) as MovedRows
    expect(setHash(reordered)).toBe(set_hash)
    s.eml.close()
  })

  it('refuses an unknown id and an empty set', () => {
    const s = source()
    expect(reject(() => exportSet(raw(s.eml), [s.task.id, 'nope'])).code).toBe('NOT_FOUND')
    expect(reject(() => exportSet(raw(s.eml), [])).code).toBe('INVALID')
    s.eml.close()
  })
})

describe('engram.import', () => {
  it('writes the rows as they are, appends them in source order and the target verifies', () => {
    const s = source()
    const set = exportSet(raw(s.eml), s.set)
    const target = brain('target', '2026-10-26T08:00:00.000Z')
    const env = target.env({ handle: 'mover', ingestion_method: 'other' })
    createObject(target, 'project', { id: 'there', name: 'There' }, env)
    writes(target).store(validDecision({ scope: 'project.there', title: 'already-here' }), env)
    const before = { engrams: ids(target).length }

    const result = target.apply({ name: 'engram.import', input: importOf(s.eml, set) }, env)
    expect(result.moved).toEqual({ engrams: 6, entries: set.rows.entries.length, relations: set.rows.relations.length })
    expect(result.created).toEqual({ projects: ['root', 'p'], entities: [], users: ['ada'], agents: [], tags: ['ops'], subjects: ['launch'] })

    // the target's export of the set is the source's, row for row
    expect(exportSet(raw(target), s.set).rows).toEqual(set.rows)
    // after the target's own rows, in source order
    expect(ids(target).slice(before.engrams)).toEqual(set.rows.engrams.map(e => e.id))
    // the journal reads the same, ties included
    expect(listEntries(raw(target), s.task.id)).toEqual(listEntries(raw(s.eml), s.task.id))
    expect(listEntries(raw(target), s.sub.id)).toEqual(listEntries(raw(s.eml), s.sub.id))
    // reads see it as the source did, but for its ord here and the crossing relation that stayed behind
    const read = (eml: EML) => { const { ord: _ord, relations: _rel, ...rest } = eml.engrams.get(s.task.id) as any; return rest }
    expect(read(target)).toEqual(read(s.eml))
    // the op: the mover's, with the source named
    const op = JSON.parse((raw(target).prepare('SELECT payload FROM op_log ORDER BY seq DESC LIMIT 1').get() as { payload: string }).payload)
    expect(op).toMatchObject({ call: 'engram.import', provenance: { handle: 'mover' }, args: { source: brainRef(raw(s.eml)), set_hash: set.set_hash } })

    expect(verify(raw(target))).toMatchObject({ ok: true })
    target.close()
    s.eml.close()
  })

  it('keeps registry rows the target already has as they are', () => {
    const s = source()
    const set = exportSet(raw(s.eml), s.set)
    const target = brain('target')
    const env = target.env({ handle: 'mover' })
    createObject(target, 'project', { id: 'root', name: 'Target root' }, env)
    createObject(target, 'tag', { name: 'ops', description: 'target ops' }, env)
    const result = target.apply({ name: 'engram.import', input: importOf(s.eml, set) }, env)
    expect(result.created.projects).toEqual(['p'])
    expect(result.created.tags).toEqual([])
    expect(target.projects.get('root')!.name).toBe('Target root')
    expect(target.tags.get('ops')!.description).toBe('target ops')
    expect(verify(raw(target))).toMatchObject({ ok: true })
    target.close()
    s.eml.close()
  })

  describe('refuses, and writes nothing', () => {
    const attempt = (target: EML, input: unknown): CommandError => {
      const before = opCount(target)
      const err = reject(() => target.apply({ name: 'engram.import', input: input as never }))
      expect(opCount(target)).toBe(before)
      return err
    }
    /** rows changed by `f`, with their hash recomputed. */
    const edited = (s: ReturnType<typeof source>, f: (rows: MovedRows) => void) => {
      const set = exportSet(raw(s.eml), s.set)
      f(set.rows)
      return { source: brainRef(raw(s.eml)), set_hash: setHash(set.rows), rows: set.rows }
    }

    it('an id the target has (an import twice)', () => {
      const s = source()
      const target = brain('target')
      const input = importOf(s.eml, exportSet(raw(s.eml), s.set))
      target.apply({ name: 'engram.import', input })
      const err = attempt(target, input)
      expect(err.code).toBe('CONFLICT')
      expect(err.message).toMatch(/already in this brain/)
      target.close(); s.eml.close()
    })

    it('an active core profile or an active status next to a carried one', () => {
      const s = source()
      const env = s.eml.env({ handle: 'kai' })
      const profile = writes(s.eml).store(validProfile({ scope: 'user.ada', title: 'ada', properties: { core: true } }), env)
      const status = writes(s.eml).store(validStatus({ scope: 'project.p' }), env)
      const target = brain('target')
      createObject(target, 'user', { id: 'ada', name: 'Ada' })
      createObject(target, 'project', { id: 'p', name: 'P' })
      writes(target).store(validProfile({ scope: 'user.ada', title: 'ada-here', properties: { core: true } }))
      writes(target).store(validStatus({ scope: 'project.p' }))
      const err = attempt(target, importOf(s.eml, exportSet(raw(s.eml), [profile.id, status.id])))
      expect(err.code).toBe('CONFLICT')
      expect(err.message).toMatch(/user\.ada has an active core profile/)
      expect(err.message).toMatch(/project\.p has an active status/)
      target.close(); s.eml.close()
    })

    it('a set hash that does not match the rows', () => {
      const s = source()
      const target = brain('target')
      const input = importOf(s.eml, exportSet(raw(s.eml), s.set))
      const err = attempt(target, { ...input, set_hash: '0'.repeat(64) })
      expect(err.code).toBe('INVALID')
      expect(err.message).toMatch(/set_hash does not match/)
      target.close(); s.eml.close()
    })

    it('a row that points outside the set, a scope object not carried, a missing column', () => {
      const s = source()
      const target = brain('target')
      expect(attempt(target, edited(s, rows => { rows.engrams = rows.engrams.filter(e => e.id !== s.sub.id) })).message).toMatch(/is not in the set/)
      expect(attempt(target, edited(s, rows => { rows.users = [] })).message).toMatch(/scope object of user\.ada is not carried/)
      expect(attempt(target, edited(s, rows => { delete rows.engrams[0].rev })).message).toMatch(/has the columns/)
      expect(attempt(target, edited(s, rows => { rows.projects.reverse() })).message).toMatch(/comes before its parent/)
      target.close(); s.eml.close()
    })

    it('a project whose parent is neither carried nor in the target', () => {
      const s = source()
      const target = brain('target')
      const err = attempt(target, edited(s, rows => { rows.projects = rows.projects.filter(p => p.id !== 'root') }))
      expect(err.code).toBe('CONFLICT')
      expect(err.message).toMatch(/project p needs its parent root/)
      target.close(); s.eml.close()
    })
  })
})

describe('engram.move_out', () => {
  /** The set imported into a target; what the source's move_out names. */
  function imported(s: ReturnType<typeof source>) {
    const set = exportSet(raw(s.eml), s.set)
    const target = brain('target')
    target.apply({ name: 'engram.import', input: importOf(s.eml, set) })
    const op_id = (raw(target).prepare('SELECT op_id FROM op_log ORDER BY seq DESC LIMIT 1').get() as { op_id: string }).op_id
    const input = { ids: s.set, set_hash: set.set_hash, drop_relations: set.crossing.map(r => r.id), target: { brain: brainRef(raw(target)).brain, op_id } }
    return { set, target, input }
  }
  const count = (eml: EML, sql: string, ...params: unknown[]) => (raw(eml).prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n

  it('removes the set and the crossing relations; registries, scope objects and the rest stay; the source verifies', () => {
    const s = source()
    const { set, target, input } = imported(s)
    const relationsBefore = count(s.eml, 'relations')
    const result = s.eml.apply({ name: 'engram.move_out', input })
    expect(result).toEqual({
      removed: { engrams: 6, entries: set.rows.entries.length, relations: set.rows.relations.length + set.crossing.length },
      dropped_relations: set.crossing.map(r => r.id).sort(),
    })
    const json = JSON.stringify(s.set)
    const inSet = '(SELECT value FROM json_each(?))'
    expect(count(s.eml, `engrams WHERE id IN ${inSet}`, json)).toBe(0)
    expect(count(s.eml, `engrams_fts WHERE id IN ${inSet}`, json)).toBe(0)
    expect(count(s.eml, `entries WHERE engram_id IN ${inSet}`, json)).toBe(0)
    expect(count(s.eml, `engram_tags WHERE engram_id IN ${inSet}`, json)).toBe(0)
    expect(count(s.eml, `engram_subjects WHERE engram_id IN ${inSet}`, json)).toBe(0)
    expect(count(s.eml, `relations WHERE source_id IN ${inSet} OR target_id IN ${inSet}`, json, json)).toBe(0)
    expect(count(s.eml, 'relations')).toBe(relationsBefore - set.rows.relations.length - set.crossing.length)
    // what stays: the engrams outside the set, the registries, the scope objects
    expect(s.eml.engrams.get(s.outside.id)).toBeTruthy()
    expect(s.eml.engrams.get(s.rule.id)).toBeTruthy()
    expect(s.eml.tags.get('ops')).toBeTruthy()
    expect(s.eml.subjects.get('launch')).toBeTruthy()
    expect(s.eml.projects.get('p')).toBeTruthy()
    expect(s.eml.users.get('ada')).toBeTruthy()
    // the op names the import in the target
    const op = JSON.parse((raw(s.eml).prepare('SELECT payload FROM op_log ORDER BY seq DESC LIMIT 1').get() as { payload: string }).payload)
    expect(op).toMatchObject({ call: 'engram.move_out', args: { target: input.target, set_hash: set.set_hash } })

    expect(verify(raw(s.eml))).toMatchObject({ ok: true })
    expect(verify(raw(target))).toMatchObject({ ok: true })
    target.close(); s.eml.close()
  })

  describe('refuses, and removes nothing', () => {
    const attempt = (eml: EML, input: unknown): CommandError => {
      const before = { ops: opCount(eml), engrams: count(eml, 'engrams'), relations: count(eml, 'relations') }
      const err = reject(() => eml.apply({ name: 'engram.move_out', input: input as never }))
      expect({ ops: opCount(eml), engrams: count(eml, 'engrams'), relations: count(eml, 'relations') }).toEqual(before)
      return err
    }

    it('a set that changed since the import', () => {
      const s = source()
      const { target, input } = imported(s)
      writes(s.eml).trackTask(s.task.id, { text: 'written after the import' })
      const err = attempt(s.eml, input)
      expect(err.code).toBe('CONFLICT')
      expect(err.message).toMatch(/the set changed since it was imported/)
      target.close(); s.eml.close()
    })

    it('drop_relations that are not exactly the crossing relations', () => {
      const s = source()
      const { target, input } = imported(s)
      expect(attempt(s.eml, { ...input, drop_relations: input.drop_relations.slice(1) }).code).toBe('CONFLICT')
      expect(attempt(s.eml, { ...input, drop_relations: [...input.drop_relations, 'another'] }).message).toMatch(/must name exactly the relations crossing/)
      // a new crossing relation after the import
      const other = writes(s.eml).store(validDecision({ scope: 'project.elsewhere', title: 'later' }))
      writes(s.eml).relate({ source_id: other.id, target_id: s.old.id, relation: 'supports', detection_method: 'manual' })
      expect(attempt(s.eml, input).code).toBe('CONFLICT')
      target.close(); s.eml.close()
    })

    it('an unknown id, and input of the wrong shape', () => {
      const s = source()
      const { target, input } = imported(s)
      expect(attempt(s.eml, { ...input, ids: [...input.ids, 'nope'] }).code).toBe('NOT_FOUND')
      expect(attempt(s.eml, { ...input, ids: [] }).code).toBe('INVALID')
      expect(attempt(s.eml, { ...input, set_hash: 'x' }).code).toBe('INVALID')
      expect(attempt(s.eml, { ...input, target: { brain: 'b' } }).code).toBe('INVALID')
      expect(attempt(s.eml, { ...input, extra: 1 }).code).toBe('INVALID')
      target.close(); s.eml.close()
    })
  })
})
