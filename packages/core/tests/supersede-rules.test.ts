import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, type WriteContext } from '../src'
import { validDecision, validTask, validNote, validEvent, validLog, closedTask } from './fixtures'

// v0.19.1 — the supersede rules, one check for every write path (decision
// supersede-rules): only a live engram supersedes, a closed target keeps its
// status, one successor and no loop, the type table (a log is never
// superseded), and no supersede along a part_of line.

describe('supersede rules', () => {
  let eml: EML
  const ctx = (session = 's1'): WriteContext =>
    ({ caller: 'juno', session_id: session, model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp' })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.agents.store({ id: 'juno', name: 'Juno' })
  })
  afterEach(() => { eml.close() })

  const rawDb = (): any => (eml.engrams as any).db
  const statusOf = (id: string) => eml.engrams.get(id)!.status
  const edge = (from: string, to: string) =>
    rawDb().prepare(`SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'supersedes'`).get(from, to)

  describe('a closed target keeps how it ended', () => {
    it('an invalidated or expired engram gets the edge, not a new status — on create and after the fact', () => {
      const wrong = eml.engrams.store(validDecision({ title: 'wrong' }))
      eml.engrams.update(wrong.id, { status: 'invalidated' })
      const next = eml.engrams.store(validDecision({ title: 'next', supersedes: [wrong.id] }))
      expect(next.superseded).toEqual([wrong.id])
      expect(statusOf(wrong.id)).toBe('invalidated')
      expect(edge(next.id, wrong.id)).toBeTruthy()

      const old = eml.engrams.store(validNote({ title: 'old' }))
      eml.engrams.update(old.id, { status: 'expired' })
      const note = eml.engrams.store(validNote({ title: 'note' }))
      eml.engrams.update(note.id, { supersedes: [old.id] })
      expect(statusOf(old.id)).toBe('expired')
      expect(edge(note.id, old.id)).toBeTruthy()
    })

    it('a closed task replaced by a task keeps its status and its bound items', () => {
      const done = eml.engrams.store(validTask({ title: 'done' }), ctx())
      const d = eml.engrams.store(validDecision({ task_id: done.id, properties: { binding: 'task' } }))
      eml.engrams.trackTask(done.id, { status: 'resolved', outcome: 'shipped', text: 'done', keep: [d.id] }, ctx())
      const next = eml.engrams.store(validTask({ title: 'next', supersedes: [done.id] }), ctx())
      expect(statusOf(done.id)).toBe('resolved')
      expect(edge(next.id, done.id)).toBeTruthy()
      expect(rawDb().prepare(`SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'derived_from'`).get(d.id, done.id)).toBeTruthy()
      expect(eml.engrams.entries(next.id).map(e => e.text)).toContain(`supersedes ${done.id}`)
    })
  })

  describe('only a live engram supersedes', () => {
    it('a closed engram or task supersedes nothing, not even a closed one', () => {
      const a = eml.engrams.store(validNote({ title: 'a' }))
      const b = eml.engrams.store(validNote({ title: 'b' }))
      eml.engrams.update(a.id, { status: 'invalidated' })
      eml.engrams.update(b.id, { status: 'invalidated' })
      expect(() => eml.engrams.update(b.id, { supersedes: [a.id] })).toThrow(/only an active engram supersedes another/)
      const old = closedTask(eml, { title: 'old' })
      const later = closedTask(eml, { title: 'later' })
      expect(() => eml.engrams.trackTask(later.id, { supersedes: [old.id], text: 'x' })).toThrow(/only an open task replaces another/)
    })
  })

  describe('one successor, no loop', () => {
    it('refuses a supersede that would close the chain', () => {
      const a = eml.engrams.store(validNote({ title: 'a' }))
      eml.engrams.update(a.id, { status: 'invalidated' })
      const b = eml.engrams.store(validNote({ title: 'b', supersedes: [a.id] }))
      // a keeps its status under b; reactivated, it still cannot take b as its predecessor
      eml.engrams.update(a.id, { status: 'active' })
      expect(() => eml.engrams.update(a.id, { supersedes: [b.id] })).toThrow(`${a.id} is already in the supersedes chain of ${b.id} — superseding it would close a loop`)
      expect(statusOf(b.id)).toBe('active')
    })
  })

  describe('no supersede along a part_of line', () => {
    it('a sub-task does not replace its parent or grandparent', () => {
      const top = eml.engrams.store(validTask({ title: 'top' }))
      const parent = eml.engrams.store(validTask({ title: 'parent', parent_id: top.id }))
      const sub = eml.engrams.store(validTask({ title: 'sub', parent_id: parent.id }))
      expect(() => eml.engrams.trackTask(sub.id, { supersedes: [parent.id], text: 'x' })).toThrow(`${parent.id} is a parent of this task — a sub-task does not replace its parent`)
      expect(() => eml.engrams.trackTask(sub.id, { supersedes: [top.id], text: 'x' })).toThrow(/is a parent of this task/)
      expect(() => eml.engrams.store(validTask({ title: 'new-sub', parent_id: parent.id, supersedes: [parent.id] }))).toThrow(/is a parent of this task/)
      expect(statusOf(parent.id)).toBe('planned')
    })

    it('a task does not replace its own sub-task', () => {
      const parent = eml.engrams.store(validTask({ title: 'parent' }))
      const sub = eml.engrams.store(validTask({ title: 'sub', parent_id: parent.id }))
      expect(() => eml.engrams.trackTask(parent.id, { supersedes: [sub.id], text: 'x' })).toThrow(`${sub.id} is a sub-task of this task — a task does not replace its own sub-task`)
    })

    it('a parent set in the same call counts; a task moved out may replace its old parent', () => {
      const parent = eml.engrams.store(validTask({ title: 'parent' }))
      const t = eml.engrams.store(validTask({ title: 't' }))
      expect(() => eml.engrams.trackTask(t.id, { parent_id: parent.id, supersedes: [parent.id], text: 'x' })).toThrow(/is a parent of this task/)
      const sub = eml.engrams.store(validTask({ title: 'sub', parent_id: parent.id }))
      eml.engrams.trackTask(sub.id, { parent_id: null, supersedes: [parent.id], text: 'sub takes over' })
      expect(statusOf(parent.id)).toBe('superseded')
    })
  })

  describe('types', () => {
    it('a log is never superseded, so a session keeps its one log', () => {
      const log = eml.engrams.store(validLog(), ctx('s7'))
      expect(() => eml.engrams.store(validNote({ supersedes: [log.id] }))).toThrow(`${log.id} is a log — a log is corrected with eml_update, never superseded`)
      expect(() => eml.engrams.update(eml.engrams.store(validNote()).id, { supersedes: [log.id] })).toThrow(/is a log/)
      expect(statusOf(log.id)).toBe('active')
      expect(() => eml.engrams.store(validLog(), ctx('s7'))).toThrow(/this session already has a log/)
    })

    it('an event and a log do not supersede; an event is not superseded', () => {
      const n = eml.engrams.store(validNote())
      expect(() => eml.engrams.store(validEvent({ supersedes: [n.id] }))).toThrow('an event does not supersede')
      expect(() => eml.engrams.store(validLog({ supersedes: [n.id] }), ctx('s8'))).toThrow('a log does not supersede')
      const ev = eml.engrams.store(validEvent())
      expect(() => eml.engrams.store(validNote({ supersedes: [ev.id] }))).toThrow(/an event is corrected, never superseded/)
    })
  })
})
