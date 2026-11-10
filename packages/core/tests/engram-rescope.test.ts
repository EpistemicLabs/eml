import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, CommandError } from '../src'
import { closedTask, legacyLearning, legacyRule, validDecision, validNote, validProfile, validRule, validStatus, validTask, writes } from './fixtures'

// engram.rescope: a re-sort moves engrams between scopes of one brain without
// reading as an edit, and refuses what may not arrive instead of retiring it.

describe('engram.rescope', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    for (const id of ['a', 'b']) eml.apply({ name: 'object.create', input: { object: 'project', fields: { id, name: id } } })
    eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'juno', name: 'Juno' } } })
    eml.apply({ name: 'object.create', input: { object: 'user', fields: { id: 'default', name: 'Default' } } })
  })
  afterEach(() => eml.close())

  const create = (input: any) => eml.apply({ name: 'engram.create', input }) as any
  const rescope = (ids: string[], scope: string) => eml.apply({ name: 'engram.rescope', input: { ids, scope } })
  const row = (id: string) => (eml as any).db.prepare('SELECT * FROM engrams WHERE id = ?').get(id)
  const reject = (f: () => unknown): CommandError => {
    try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
    throw new Error('not rejected')
  }

  it('moves one engram: the scope changes and rev goes up, nothing else', () => {
    const d = create(validDecision({ scope: 'project.a' }))
    const before = row(d.id)
    expect(rescope([d.id], 'project.b')).toEqual({ moved: 1, unchanged: 0 })
    expect(row(d.id)).toEqual({ ...before, scope: 'project.b', rev: before.rev + 1 })
    rescope([d.id], 'project.b')
    expect(row(d.id).rev).toBe(before.rev + 1)
  })

  it('moves many of any type and status, closed ones and old statuses included', () => {
    const closed = closedTask(eml, { scope: 'project.a' })
    const old = create(validStatus({ scope: 'project.a' }))
    const current = create(validStatus({ scope: 'project.a' }))
    expect(row(old.id).status).toBe('superseded')
    expect(rescope([closed.id, old.id, current.id], 'project.b')).toEqual({ moved: 3, unchanged: 0 })
    for (const e of [closed, old, current]) expect(row(e.id).scope).toBe('project.b')
    expect(row(closed.id).status).toBe('resolved')
  })

  it('keeps journal, tags, subjects and relations', () => {
    eml.apply({ name: 'object.create', input: { object: 'tag', fields: { name: 'kept' } } })
    const task = create(validTask({ scope: 'project.a', status: 'active', tags: ['kept'] }))
    eml.apply({ name: 'task.track', input: { id: task.id, text: 'progress' } as never })
    const note = create(validNote({ scope: 'project.a', task_id: task.id, properties: { binding: 'task' } }))
    rescope([task.id], 'project.b')
    const after = eml.engrams.get(task.id) as any
    expect(after.tags).toEqual(['kept'])
    expect(after.entries.some((e: any) => e.text === 'progress')).toBe(true)
    expect(row(note.id).scope).toBe('project.a')
    const links = (eml as any).db.prepare('SELECT COUNT(*) AS n FROM relations WHERE source_id = ? AND target_id = ?').get(note.id, task.id)
    expect(links.n).toBe(1)
  })

  it('moves the search index with the engram', () => {
    const d = create(validDecision({ scope: 'project.a', content: 'a findable quokka decision' }))
    rescope([d.id], 'project.b')
    const fts = (eml as any).db.prepare(`SELECT scope FROM engrams_fts WHERE engrams_fts MATCH 'quokka'`).all()
    expect(fts).toEqual([{ scope: 'project.b' }])
  })

  it('can be repeated: what is already there counts as unchanged', () => {
    const d = create(validDecision({ scope: 'project.a' }))
    const n = create(validNote({ scope: 'project.b' }))
    expect(rescope([d.id, n.id], 'project.b')).toEqual({ moved: 1, unchanged: 1 })
    expect(rescope([d.id, n.id], 'project.b')).toEqual({ moved: 0, unchanged: 2 })
  })

  it('moves nothing when one id is unknown', () => {
    const d = create(validDecision({ scope: 'project.a' }))
    const e = reject(() => rescope([d.id, 'ghost'], 'project.b'))
    expect(e.code).toBe('NOT_FOUND')
    expect(e.message).toContain('ghost')
    expect(row(d.id).scope).toBe('project.a')
  })

  it('refuses an unknown scope and a malformed input', () => {
    const d = create(validDecision({ scope: 'project.a' }))
    expect(reject(() => rescope([d.id], 'project.ghost')).code).toBe('INVALID')
    expect(reject(() => rescope([], 'project.b')).code).toBe('INVALID')
    expect(reject(() => rescope([d.id, d.id], 'project.b')).code).toBe('INVALID')
    expect(reject(() => eml.apply({ name: 'engram.rescope', input: { ids: [d.id], scope: 'project.b', title: 'x' } as never })).code).toBe('INVALID')
  })

  it('refuses a second active status, and takes it once the other is closed', () => {
    const here = create(validStatus({ scope: 'project.a' }))
    const there = create(validStatus({ scope: 'project.b' }))
    expect(reject(() => rescope([here.id], 'project.b')).message).toContain('one active status')
    expect(row(there.id).status).toBe('active')
    eml.apply({ name: 'engram.update', input: { id: there.id, patch: { status: 'invalidated' } } })
    expect(rescope([here.id], 'project.b').moved).toBe(1)
  })

  it('refuses two active statuses arriving together', () => {
    eml.apply({ name: 'object.create', input: { object: 'project', fields: { id: 'c', name: 'c' } } })
    const a = create(validStatus({ scope: 'project.a' }))
    const b = create(validStatus({ scope: 'project.b' }))
    const e = reject(() => rescope([a.id, b.id], 'project.c'))
    expect(e.message).toContain('one active status')
    expect(row(a.id).scope).toBe('project.a')
  })

  it('keeps profiles on someone, and one core profile per scope', () => {
    const p = create(validProfile({ scope: 'user.default', properties: { core: true } }))
    expect(reject(() => rescope([p.id], 'project.b')).code).toBe('INVALID')
    const q = create(validProfile({ scope: 'agent.juno', properties: { core: true } }))
    expect(reject(() => rescope([q.id], 'user.default')).message).toContain('one core profile')
  })

  it('moves a rule only to its owner, an agent or a project; nothing moves on a refusal', () => {
    const r = create(validRule({ scope: 'project.a', title: 'r' }))
    const d = create(validDecision({ scope: 'project.a' }))
    for (const scope of ['user.default', 'global']) {
      expect(reject(() => rescope([d.id, r.id], scope)).message).toMatch(/a rule needs an owner/)
      expect(row(d.id).scope).toBe('project.a')
    }
    expect(rescope([r.id], 'project.b').moved).toBe(1)
    expect(rescope([r.id], 'agent.juno').moved).toBe(1)
  })

  it('moves a learning only to an agent scope', () => {
    const l = writes(eml).learn({ scope: 'agent.juno', title: 'ask-first', content: 'Ask first.', source: 'self', happened: 'h' })
    if (!l.written) throw new Error('not written')
    for (const scope of ['project.b', 'user.default', 'global']) {
      expect(reject(() => rescope([l.engram.id], scope)).message).toMatch(/a learning is the agent's/)
    }
    expect(row(l.engram.id).scope).toBe('agent.juno')
  })

  it('leaves a legacy rule or learning where it is: already there counts as unchanged, a move goes to the owner', () => {
    const rule = legacyRule(eml, { title: 'old-rule', content: 'Do X.', properties: { applies: 'always', why: 'w', agreed: 'yes' } }, 'user.default', 'agent.juno')
    const learning = legacyLearning(eml, { title: 'old-lesson', content: 'Do Y.' }, 'user.default', 'agent.juno')
    const p = create(validProfile({ scope: 'agent.juno' }))
    expect(rescope([rule.id, learning.id, p.id], 'user.default')).toEqual({ moved: 1, unchanged: 2 })
    expect(rescope([rule.id, learning.id], 'agent.juno')).toEqual({ moved: 2, unchanged: 0 })
  })
})
