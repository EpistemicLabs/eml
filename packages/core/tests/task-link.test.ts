import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validDecision, validTask } from './fixtures'

// v0.15 Cluster C — task-linked writes. A decision or note written with
// task_id gets, in ONE transaction: the engram, the edge to the task
// (decision derived_from task, note refines task) and a task entry authored by
// the caller. The stage is not advanced. A bad task_id writes nothing.

describe('task-linked writes (v0.15)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    eml.projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const count = (table: string): number => (rawDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const edge = (from: string, to: string, relation: string) =>
    rawDb().prepare(`SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?`).get(from, to, relation)
  const hub = () => eml.engrams.store(validTask({ scope: 'project.eml', title: 'hub', content: 'the hub task', properties: { stage: 'planning' } }))

  it('a decision with task_id: derived_from edge + entry by the caller; stage unchanged', () => {
    const task = hub()
    const d = eml.engrams.store(validDecision({ scope: 'project.eml', title: 'pick-db', content: 'use sqlite', task_id: task.id }), 'assistant')

    expect(edge(d.id, task.id, 'derived_from')).toBeTruthy()
    const entries = eml.engrams.get(task.id)!.entries!
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ author: 'assistant', stage: 'planning', text: `decision taken: pick-db (${d.id})` })
    expect((eml.engrams.get(task.id)!.properties as Record<string, unknown>).stage).toBe('planning')
  })

  it('a note with task_id: refines edge + entry; without a title the entry quotes the content', () => {
    const task = hub()
    const plan = eml.engrams.store({ type: 'note', scope: 'project.eml', content: 'Plan: migrate, then rebuild the index.', task_id: task.id })
    expect(edge(plan.id, task.id, 'refines')).toBeTruthy()
    expect(eml.engrams.get(task.id)!.entries![0].text)
      .toBe(`note written: Plan: migrate, then rebuild the index. (${plan.id})`)
  })

  it('a rule written from a task refines it too', () => {
    const task = hub()
    const r = eml.engrams.store({ type: 'rule', scope: 'project.eml', title: 'r', content: 'when X, do Y', properties: { applies: 'always' }, task_id: task.id })
    expect(edge(r.id, task.id, 'refines')).toBeTruthy()
  })

  it('a bad task_id writes nothing: unknown id, a non-task, a type that takes no task_id', () => {
    const task = hub()
    const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'a note' })
    const before = { engrams: count('engrams'), relations: count('relations'), entries: count('task_entries') }

    expect(() => eml.engrams.store(validDecision({ task_id: 'no-such-id' })))
      .toThrow('Invalid engram: task_id no-such-id is not a task.')
    expect(() => eml.engrams.store(validDecision({ task_id: note.id })))
      .toThrow(`Invalid engram: task_id ${note.id} is not a task.`)
    expect(() => eml.engrams.store(validTask({ task_id: task.id })))
      .toThrow('Invalid engram: task_id links a decision or note to a task — not available for type task.')
    expect(() => eml.engrams.store({ type: 'status', scope: 'global', content: 's', properties: { state: 'x' }, task_id: task.id }))
      .toThrow(/not available for type status/)

    expect({ engrams: count('engrams'), relations: count('relations'), entries: count('task_entries') }).toEqual(before)
  })

  it('atomic: if the entry cannot be written, the decision and its edge roll back', () => {
    const task = hub()
    rawDb().exec(`CREATE TRIGGER fail_entry BEFORE INSERT ON task_entries BEGIN SELECT RAISE(ABORT, 'entry write failed'); END`)
    const before = { engrams: count('engrams'), relations: count('relations') }

    expect(() => eml.engrams.store(validDecision({ scope: 'project.eml', content: 'doomed', task_id: task.id })))
      .toThrow('entry write failed')
    expect({ engrams: count('engrams'), relations: count('relations') }).toEqual(before)
    expect(rawDb().prepare(`SELECT 1 FROM engrams_fts WHERE content = 'doomed'`).get()).toBeUndefined()
  })

  it('the decision rules still apply first (no entry for a rejected decision)', () => {
    const task = hub()
    expect(() => eml.engrams.store({ type: 'decision', scope: 'project.eml', content: 'no alternatives', task_id: task.id }))
      .toThrow(/^Invalid engram: a decision needs/)
    expect(count('task_entries')).toBe(0)
  })
})
