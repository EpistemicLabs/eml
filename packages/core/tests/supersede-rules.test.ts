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
    it('an invalidated engram gets the edge, not a new status — on create and after the fact', () => {
      const wrong = eml.engrams.store(validDecision({ title: 'wrong' }))
      eml.engrams.update(wrong.id, { status: 'invalidated' })
      const next = eml.engrams.store(validDecision({ title: 'next', supersedes: [wrong.id] }))
      expect(next.superseded).toEqual([wrong.id])
      expect(statusOf(wrong.id)).toBe('invalidated')
      expect(edge(next.id, wrong.id)).toBeTruthy()

      const old = eml.engrams.store(validNote({ title: 'old' }))
      eml.engrams.update(old.id, { status: 'invalidated' })
      const note = eml.engrams.store(validNote({ title: 'note' }))
      eml.engrams.update(note.id, { supersedes: [old.id] })
      expect(statusOf(old.id)).toBe('invalidated')
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
      // a keeps its status under b and cannot come back while b holds, so it can't take b as its predecessor
      expect(() => eml.engrams.update(a.id, { status: 'active' })).toThrow(`${a.id} is replaced by ${b.id}`)
      expect(() => eml.engrams.update(a.id, { supersedes: [b.id] })).toThrow(/only an active engram supersedes another/)
      expect(statusOf(b.id)).toBe('active')
    })
  })

  describe('undo', () => {
    it('reactivating a superseded engram removes the edge, so it can be superseded again', () => {
      const old = eml.engrams.store(validNote({ title: 'old' }))
      const wrong = eml.engrams.store(validNote({ title: 'wrong', supersedes: [old.id] }))
      eml.engrams.update(wrong.id, { status: 'invalidated' })
      eml.engrams.update(old.id, { status: 'active' })
      expect(statusOf(old.id)).toBe('active')
      expect(edge(wrong.id, old.id)).toBeFalsy()
      const right = eml.engrams.store(validNote({ title: 'right', supersedes: [old.id] }))
      expect(statusOf(old.id)).toBe('superseded')
      expect(edge(right.id, old.id)).toBeTruthy()
    })
  })

  describe('a closed engram with a successor stays closed', () => {
    it('R1: a decision closed and only linked comes back only once its successor is invalidated', () => {
      const d1 = eml.engrams.store(validDecision({ title: 'd1' }))
      eml.engrams.update(d1.id, { status: 'invalidated' })
      const d2 = eml.engrams.store(validDecision({ title: 'd2', supersedes: [d1.id] }))
      expect(() => eml.engrams.update(d1.id, { status: 'active' })).toThrow(`${d1.id} is replaced by ${d2.id} — it is reactivated only once its successor is invalidated`)
      expect(statusOf(d1.id)).toBe('invalidated')
      eml.engrams.update(d2.id, { status: 'invalidated' })
      eml.engrams.update(d1.id, { status: 'active' })
      expect(edge(d2.id, d1.id)).toBeFalsy()
      const d3 = eml.engrams.store(validDecision({ title: 'd3', supersedes: [d1.id] }))
      expect(statusOf(d1.id)).toBe('superseded')
      expect(edge(d3.id, d1.id)).toBeTruthy()
    })

    it('an invalidated successor is history: the closed engram can be superseded again', () => {
      const old = eml.engrams.store(validNote({ title: 'old' }))
      eml.engrams.update(old.id, { status: 'invalidated' })
      const undone = eml.engrams.store(validNote({ title: 'undone', supersedes: [old.id] }))
      eml.engrams.update(undone.id, { status: 'invalidated' })
      const next = eml.engrams.store(validNote({ title: 'next', supersedes: [old.id] }))
      expect(edge(next.id, old.id)).toBeTruthy()
      expect(statusOf(old.id)).toBe('invalidated')
    })

    it('R3: a resolved task with a successor reopens only once its successor is invalidated', () => {
      const done = eml.engrams.store(validTask({ title: 'done' }))
      eml.engrams.trackTask(done.id, { status: 'resolved', outcome: 'shipped', text: 'done', keep: [] })
      const next = eml.engrams.store(validTask({ title: 'next', supersedes: [done.id] }))
      expect(() => eml.engrams.trackTask(done.id, { status: 'active', text: 'again' })).toThrow(`${done.id} is replaced by ${next.id}`)
      eml.engrams.trackTask(next.id, { status: 'invalidated', outcome: 'undone', text: 'undone', keep: [] })
      expect(eml.engrams.trackTask(done.id, { status: 'active', text: 'again' })!.status).toBe('active')
      expect(edge(next.id, done.id)).toBeFalsy()
    })

    it('R2: a reopen does not offer a bound item that was replaced since', () => {
      const task = eml.engrams.store(validTask({ title: 'work' }))
      const d = eml.engrams.store(validDecision({ task_id: task.id, properties: { binding: 'task' } }))
      const kept = eml.engrams.store(validDecision({ title: 'kept-out', task_id: task.id, properties: { binding: 'task' } }))
      eml.engrams.trackTask(task.id, { status: 'resolved', outcome: 'done', text: 'done', keep: [] })
      eml.engrams.store(validDecision({ title: 'replacement', supersedes: [d.id] }))
      const r = eml.engrams.trackTask(task.id, { status: 'active', text: 'back' })!
      expect((r.reopen_candidates ?? []).map(c => c.id)).toEqual([kept.id])
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
