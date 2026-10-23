import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as core from '../src'
import { EML, CommandError, COMMAND_NAMES, readObject } from '../src'
import { validDecision, validTask, validNote } from './fixtures'

// v0.20 (decision write-command-set): every brain write is one of eight
// commands behind EML.apply(command, env); the rest of EML only reads, except
// engrams.delete and agents.delete (decision no-delete-command).

describe('the command set', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'juno', name: 'Juno' } } })
    eml.apply({ name: 'object.create', input: { object: 'project', fields: { id: 'p', name: 'P' } } })
  })
  afterEach(() => eml.close())

  const count = (table: string) => ((eml as any).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const reject = (f: () => unknown): CommandError => {
    try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
    throw new Error('not rejected')
  }

  it('is closed: eight commands, and no public write besides apply and the two deletes', () => {
    expect(COMMAND_NAMES).toEqual([
      'engram.create', 'engram.update', 'task.track', 'learning.add_evidence',
      'engram.confirm_review', 'relation.create', 'object.create', 'object.update',
    ])
    const WRITE = /^(store|create|update|track|learn$|addEvidence|confirm|relate|insert|append|link|supersede|close|move|replace|set|delete)/i
    const methods = (o: object): string[] => {
      const names = new Set<string>()
      for (let p = Object.getPrototypeOf(o); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor' && typeof (o as any)[n] === 'function') names.add(n)
      }
      return [...names]
    }
    const writes: string[] = []
    for (const store of ['engrams', 'projects', 'entities', 'users', 'agents', 'tags', 'subjects'] as const) {
      for (const m of methods((eml as any)[store])) if (WRITE.test(m)) writes.push(`${store}.${m}`)
    }
    expect(writes.sort()).toEqual(['agents.delete', 'engrams.delete'])
    expect(methods(eml).filter(m => !m.startsWith('wire')).sort()).toEqual(['apply', 'close', 'env', 'now'])
    // the writers and the old write functions are not exported
    for (const name of ['EngramWriter', 'ObjectWriter', 'appendEntry', 'createObject', 'updateObject']) expect(name in core).toBe(false)
  })

  it('an unknown command or input shape is INVALID', () => {
    expect(reject(() => eml.apply({ name: 'engram.delete', input: {} } as never)).message).toMatch(/^Invalid command: unknown command "engram.delete"/)
    expect(reject(() => eml.apply({ name: 'engram.update', input: 'x' } as never)).code).toBe('INVALID')
    expect(reject(() => eml.apply({ name: 'task.track', input: { text: 'x' } } as never)).message).toMatch(/id is required/)
  })

  it('a rejection is typed and writes nothing', () => {
    const before = count('engrams')
    const e = reject(() => eml.apply({ name: 'engram.create', input: validDecision({ title: 'x', tags: ['nope'] }) }))
    expect(e.code).toBe('INVALID')
    expect(e.message).toMatch(/tag "nope" not found/)
    expect(count('engrams')).toBe(before)
    expect(reject(() => eml.apply({ name: 'engram.update', input: { id: 'ghost', patch: { content: 'x' } } })).code).toBe('NOT_FOUND')
    expect(reject(() => eml.apply({ name: 'task.track', input: { id: 'ghost', text: 'x' } })).code).toBe('NOT_FOUND')
    expect(reject(() => eml.apply({ name: 'engram.confirm_review', input: { id: 'ghost', text: 'x' } })).code).toBe('NOT_FOUND')
    expect(reject(() => eml.apply({ name: 'object.update', input: { object: 'project', id: 'ghost', patch: { goal: 'x' } } })).message).toBe('project "ghost" not found')
  })

  it('every command writes in one transaction: a failing apply leaves nothing behind', () => {
    const task = eml.apply({ name: 'engram.create', input: validTask({ scope: 'project.p', title: 'hub', status: 'active' }) })
    const entries = count('entries')
    // the close is refused after the bound-item check, before any row changes
    eml.apply({ name: 'engram.create', input: validNote({ scope: 'project.p', title: 'bound', task_id: task.id, properties: { binding: 'task' } }) })
    const afterBound = count('entries')
    expect(afterBound).toBeGreaterThan(entries)
    expect(reject(() => eml.apply({ name: 'task.track', input: { id: task.id, status: 'resolved', outcome: 'done', text: 'done' } })).message).toMatch(/bound to this task/)
    expect(count('entries')).toBe(afterBound)
    expect(eml.engrams.get(task.id)!.status).toBe('active')
  })

  describe('learnings: engram.create and learning.add_evidence', () => {
    const lesson = { type: 'learning' as const, scope: 'agent.juno', title: 'ask-first', content: 'Ask before acting.' }

    it('engram.create writes a learning with its first evidence', () => {
      const r = eml.apply({ name: 'engram.create', input: { ...lesson, evidence: { source: 'user', happened: 'acted alone', quote: 'ask me first' } } })
      expect(r.type).toBe('learning')
      expect(r.learning!.state).toBe('collecting')
      expect(eml.engrams.entries(r.id, ['evidence'])).toMatchObject([{ text: 'acted alone', source: 'user', quote: 'ask me first' }])
    })

    it('needs evidence; the first evidence supports', () => {
      expect(reject(() => eml.apply({ name: 'engram.create', input: lesson as never })).message).toMatch(/a learning is written with eml_learning/)
      expect(reject(() => eml.apply({ name: 'engram.create', input: { ...lesson, evidence: { source: 'self', happened: 'x', stance: 'contradicts' } } })).message)
        .toMatch(/a new learning starts from supporting evidence/)
    })

    it('the topic check rejects a second learning on the same topic with TOPIC_EXISTS and its matches; nothing is written', () => {
      const first = eml.apply({ name: 'engram.create', input: { ...lesson, evidence: { source: 'self', happened: 'once' } } })
      const before = count('engrams')
      const e = reject(() => eml.apply({ name: 'engram.create', input: { ...lesson, content: 'Ask before acting, always.', evidence: { source: 'self', happened: 'twice' } } }))
      expect(e.code).toBe('TOPIC_EXISTS')
      expect((e.data!.matches as Array<{ id: string }>).map(m => m.id)).toEqual([first.id])
      expect(count('engrams')).toBe(before)
      const other = eml.apply({ name: 'engram.create', input: { ...lesson, new_topic: true, evidence: { source: 'self', happened: 'twice' } } })
      expect(other.id).not.toBe(first.id)
    })

    it('learning.add_evidence appends to an existing learning, and sharpens its content', () => {
      const l = eml.apply({ name: 'engram.create', input: { ...lesson, evidence: { source: 'self', happened: 'once' } } })
      const r = eml.apply({ name: 'learning.add_evidence', input: { id: l.id, source: 'observed', happened: 'again', content: 'Ask before acting, every time.' } })
      expect(r.engram.content).toBe('Ask before acting, every time.')
      expect(eml.engrams.entries(l.id, ['evidence']).map(e => e.text)).toEqual(['once', 'again'])
      expect(reject(() => eml.apply({ name: 'learning.add_evidence', input: { id: l.id, source: 'self', happened: 'x', scope: 'global' } as never })).message)
        .toMatch(/scope only on create/)
    })

    it('learning.add_evidence: an unknown id is NOT_FOUND, an engram of another type INVALID', () => {
      expect(reject(() => eml.apply({ name: 'learning.add_evidence', input: { id: 'ghost', source: 'self', happened: 'x' } })))
        .toMatchObject({ code: 'NOT_FOUND', message: 'learning not found' })
      const n = eml.apply({ name: 'engram.create', input: validNote({ title: 'n' }) })
      expect(reject(() => eml.apply({ name: 'learning.add_evidence', input: { id: n.id, source: 'self', happened: 'x' } })))
        .toMatchObject({ code: 'INVALID', message: `Invalid engram: ${n.id} is a note, not a learning.` })
    })
  })

  describe('relation.create: a closed payload', () => {
    it('takes only the relation fields; detection_method one of the four, strength a number', () => {
      const a = eml.apply({ name: 'engram.create', input: validNote({ title: 'a' }) })
      const b = eml.apply({ name: 'engram.create', input: validNote({ title: 'b' }) })
      const rel = (extra: Record<string, unknown>) => ({ name: 'relation.create' as const, input: { source_id: a.id, target_id: b.id, relation: 'supports', ...extra } as never })
      const before = count('relations')
      expect(reject(() => eml.apply(rel({ scope: 'global', bogus: 1 })))).toMatchObject({
        code: 'INVALID', message: 'unknown fields scope, bogus — a relation takes source_id, target_id, relation, detection_method, strength, explanation, metadata',
      })
      expect(reject(() => eml.apply(rel({ detection_method: 'bogus' })))).toMatchObject({
        code: 'INVALID', message: 'invalid detection_method "bogus" — one of manual, agent_declared, auto_temporal, auto_semantic',
      })
      expect(reject(() => eml.apply(rel({ strength: 'high' })))).toMatchObject({ code: 'INVALID', message: 'strength must be a number' })
      expect(reject(() => eml.apply(rel({ explanation: 42 })))).toMatchObject({ code: 'INVALID', message: 'explanation must be a string' })
      expect(reject(() => eml.apply(rel({ metadata: 'x' })))).toMatchObject({ code: 'INVALID', message: 'metadata must be an object' })
      expect(count('relations')).toBe(before)
      expect(eml.apply(rel({ detection_method: 'agent_declared', strength: 0.5, explanation: 'why', metadata: { k: 'v' } }))).toEqual({ created: true })
      expect(count('relations')).toBe(before + 1)
    })
  })

  describe('users and agents are objects', () => {
    it('object.create / object.update for a user, unknown fields named', () => {
      const r = eml.apply({ name: 'object.create', input: { object: 'user', fields: { name: 'Ada Lovelace', email: 'ada@example.com' } } })
      expect(r).toMatchObject({ created: true, object: { id: 'ada-lovelace', name: 'Ada Lovelace', email: 'ada@example.com' } })
      const u = eml.apply({ name: 'object.update', input: { object: 'user', id: 'ada-lovelace', patch: { description: 'the user' } } })
      expect(u.diff).toEqual({ description: [null, 'the user'] })
      expect(reject(() => eml.apply({ name: 'object.create', input: { object: 'user', fields: { name: 'X', role: 'admin' } } })).message)
        .toMatch(/^Invalid object: unknown field role for a user\. Allowed: id, name, email, description, metadata\./)
      expect(reject(() => eml.apply({ name: 'object.create', input: { object: 'user', fields: { id: 'ada-lovelace', name: 'Ada' } } })).message)
        .toBe('Invalid object: user "ada-lovelace" already exists.')
      expect(reject(() => eml.apply({ name: 'object.update', input: { object: 'user', id: 'ada-lovelace', patch: { id: 'ada' } } })).message).toMatch(/id cannot change/)
    })

    it('object.create / object.update for an agent; read back as objects', () => {
      eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'scout', name: 'Scout', parent_id: 'juno', domains: ['btc'] } } })
      const a = eml.apply({ name: 'object.update', input: { object: 'agent', id: 'scout', patch: { domains: ['btc', 'eth'] } } })
      expect(a.object).toMatchObject({ id: 'scout', parent_id: 'juno', domains: ['btc', 'eth'] })
      expect(reject(() => eml.apply({ name: 'object.create', input: { object: 'agent', fields: { name: 'Y', domains: 'btc' } } })).message).toMatch(/domains must be a list of text/)
      expect((readObject(eml, 'agent') as Array<{ id: string }>).map(x => x.id).sort()).toEqual(['juno', 'scout'])
      expect(readObject(eml, 'agent', { id: 'scout' })).toMatchObject({ id: 'scout', engram_count: 0 })
      expect(() => readObject(eml, 'agent', { status: 'active' })).toThrow(/an agent has no status/)
    })
  })
})
