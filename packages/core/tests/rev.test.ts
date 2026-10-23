import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, CommandError } from '../src'
import { validDecision, validTask, validNote, validStatus, validProfile, writes } from './fixtures'

// v0.20 (decision engram-revision-counter): every engram has a rev — 1 on
// create, +1 on every write that changes it, once per write. engram.update and
// task.track take an optional base_rev; a mismatch is CONFLICT and writes nothing.

describe('engram rev', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    writes(eml).agents.store({ id: 'juno', name: 'Juno' })
    writes(eml).projects.create({ id: 'p', name: 'P' })
  })
  afterEach(() => eml.close())

  const rev = (id: string) => eml.engrams.get(id)!.rev
  const w = () => writes(eml)
  const scope = 'project.p'

  it('starts at 1 and goes up by one per command that changes the engram', () => {
    const d = w().store(validDecision({ scope, title: 'd' }))
    expect(d.rev).toBe(1)
    expect(w().update(d.id, { content: 'changed' })!.rev).toBe(2)
    expect(eml.apply({ name: 'engram.confirm_review', input: { id: d.id, text: 'still holds' } }).rev).toBe(3)
    const t = w().store(validTask({ scope, title: 't', status: 'active' }))
    expect(t.rev).toBe(1)   // its creation entry is part of the create
    expect(w().trackTask(t.id, { text: 'progress', priority: 'high' })!.rev).toBe(2)   // a note, a change entry and the row: one bump
    const l = w().learn({ scope: 'agent.juno', title: 'ask-first', content: 'Ask first.', source: 'self', happened: 'once' })
    if (!l.written) throw new Error('not written')
    expect(l.engram.rev).toBe(1)
    expect(eml.apply({ name: 'learning.add_evidence', input: { id: l.engram.id, source: 'observed', happened: 'again', content: 'Ask first, always.' } }).engram.rev).toBe(2)
    // a relation is not engram state: relate leaves both revs alone
    const n = w().store(validNote({ scope, title: 'n' }))
    w().relate({ source_id: n.id, target_id: d.id, relation: 'supports', detection_method: 'manual' })
    expect([rev(n.id), rev(d.id)]).toEqual([1, 3])
  })

  it('a patch that changes nothing writes nothing: no rev, no updated_at', () => {
    let at = '2026-10-23T10:00:00.000Z'
    const clocked = new EML({ dbPath: ':memory:', namespace: 'juno', clock: () => at })
    try {
      writes(clocked).projects.create({ id: 'p', name: 'P' })
      writes(clocked).tags.create({ name: 'ops' })
      const n = writes(clocked).store(validNote({ scope, title: 'n', content: 'same', tags: ['ops'] }))
      at = '2026-10-23T11:00:00.000Z'
      const r = clocked.apply({ name: 'engram.update', input: { id: n.id, patch: { content: 'same', title: 'n', scope, status: 'active', tags: ['ops'] } } })
      expect(r).toMatchObject({ rev: 1, updated_at: '2026-10-23T10:00:00.000Z', diff: {} })
      const d = writes(clocked).store(validDecision({ scope, title: 'd' }))
      const props = clocked.engrams.get(d.id)!.properties as Record<string, unknown>
      at = '2026-10-23T12:00:00.000Z'
      const r2 = clocked.apply({ name: 'engram.update', input: { id: d.id, patch: { properties: { rationale: props.rationale } } } })
      expect(r2).toMatchObject({ rev: 1, updated_at: '2026-10-23T11:00:00.000Z', diff: {} })
      expect(clocked.engrams.get(d.id)!.properties).toEqual(props)   // review_due_at not restarted
    } finally { clocked.close() }
  })

  it('side effects on other engrams bump them too, once', () => {
    // supersede target, status and core-profile auto-supersede
    const old = w().store(validDecision({ scope, title: 'old' }))
    w().store(validDecision({ scope, title: 'new', supersedes: [old.id] }))
    expect(rev(old.id)).toBe(2)
    const s1 = w().store(validStatus({ scope }))
    w().store(validStatus({ scope, content: 'next', properties: { state: 'next' } }))
    expect(rev(s1.id)).toBe(2)
    const p1 = w().store(validProfile({ scope: 'agent.juno', title: 'juno', properties: { core: true } }))
    w().store(validProfile({ scope: 'agent.juno', title: 'juno-2', properties: { core: true } }))
    expect(rev(p1.id)).toBe(2)
    // task_id: the task gets a change entry
    const task = w().store(validTask({ scope, title: 'hub', status: 'active' }))
    const closes = w().store(validNote({ scope, title: 'closes', task_id: task.id, properties: { binding: 'task' } }))
    const stays = w().store(validDecision({ scope, title: 'stays', task_id: task.id, properties: { binding: 'task' } }))
    expect(rev(task.id)).toBe(3)
    // closing: the task once, each bound item once (row + its own entry)
    w().trackTask(task.id, { status: 'resolved', outcome: 'done', text: 'done', keep: [stays.id] })
    expect([rev(task.id), rev(closes.id), rev(stays.id)]).toEqual([4, 2, 2])
    // a task replaced by a task hands its bound items over: only their edge moves, an edge is not engram state
    const a = w().store(validTask({ scope, title: 'a', status: 'active' }))
    const item = w().store(validNote({ scope, title: 'item', task_id: a.id, properties: { binding: 'task' } }))
    const itemAt = eml.engrams.get(item.id)!.updated_at
    const b = w().store(validTask({ scope, title: 'b', supersedes: [a.id] }))
    expect(b.rev).toBe(1)
    expect([rev(a.id), rev(item.id)]).toEqual([3, 1])
    expect(eml.engrams.get(item.id)!.updated_at).toBe(itemAt)
    // part_of: the child's own track bumps it, the parent stays
    const child = w().store(validTask({ scope, title: 'child' }))
    w().trackTask(child.id, { parent_id: b.id })
    expect([rev(child.id), rev(b.id)]).toEqual([2, 1])
  })

  describe('base_rev', () => {
    const reject = (f: () => unknown): CommandError => {
      try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
      throw new Error('not rejected')
    }

    it('engram.update: a match writes, a mismatch is CONFLICT with the current rev and writes nothing', () => {
      const n = w().store(validNote({ scope, title: 'n', content: 'v1' }))
      const ok = eml.apply({ name: 'engram.update', input: { id: n.id, patch: { content: 'v2' }, base_rev: 1 } })
      expect(ok.rev).toBe(2)
      const e = reject(() => eml.apply({ name: 'engram.update', input: { id: n.id, patch: { content: 'v3' }, base_rev: 1 } }))
      expect(e.code).toBe('CONFLICT')
      expect(e.data).toEqual({ current_rev: 2 })
      expect(eml.engrams.get(n.id)).toMatchObject({ content: 'v2', rev: 2 })
      expect(reject(() => eml.apply({ name: 'engram.update', input: { id: n.id, patch: { content: 'x' }, base_rev: 'two' as never } })).code).toBe('INVALID')
      // without base_rev: last write wins, as for agents
      expect(eml.apply({ name: 'engram.update', input: { id: n.id, patch: { content: 'v4' } } }).rev).toBe(3)
    })

    it('task.track: the same precondition; nothing written on a mismatch, no entry either', () => {
      const t = w().store(validTask({ scope, title: 't', status: 'active' }))
      expect(eml.apply({ name: 'task.track', input: { id: t.id, text: 'one', base_rev: 1 } }).rev).toBe(2)
      const before = eml.engrams.entries(t.id).length
      const e = reject(() => eml.apply({ name: 'task.track', input: { id: t.id, text: 'two', base_rev: 1 } }))
      expect(e).toMatchObject({ code: 'CONFLICT', data: { current_rev: 2 } })
      expect(eml.engrams.entries(t.id).length).toBe(before)
      expect(rev(t.id)).toBe(2)
    })

    it('an unknown id stays NOT_FOUND', () => {
      expect(reject(() => eml.apply({ name: 'engram.update', input: { id: 'ghost', patch: { content: 'x' }, base_rev: 1 } })).code).toBe('NOT_FOUND')
    })
  })
})
