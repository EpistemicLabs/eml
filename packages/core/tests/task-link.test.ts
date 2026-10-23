import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import {
  validDecision, validTask, validNote, validEvent, validLog, validReference, validRule, validStatus, writes,
} from './fixtures'

// Task-linked writes (v0.15, v0.19). A decision, note, event, log or reference
// written with task_id gets, in ONE transaction: the engram, the edge to the
// task (decision derived_from task, the others refine it) and a change entry in
// the task's journal authored by the caller. The stage is not advanced. A bad
// task_id writes nothing. v0.19: rule and profile take no task_id; a decision or
// note with task_id needs binding.

describe('task-linked writes', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const count = (table: string): number => (rawDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const edge = (from: string, to: string, relation: string) =>
    rawDb().prepare(`SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?`).get(from, to, relation)
  const hub = () => writes(eml).store(validTask({ scope: 'project.eml', title: 'hub', content: 'the hub task', properties: { stage: 'planning' } }))
  const changes = (taskId: string) => eml.engrams.entries(taskId, ['change'])

  it('a decision with task_id: derived_from edge + change entry by the caller; stage unchanged', () => {
    const task = hub()
    const d = writes(eml).store(validDecision({ scope: 'project.eml', title: 'pick-db', content: 'use sqlite', task_id: task.id, properties: { binding: 'standing' } }), eml.env({ handle: 'assistant' }))

    expect(edge(d.id, task.id, 'derived_from')).toBeTruthy()
    const entries = changes(task.id)
    expect(entries.map(e => e.text)).toEqual(['created (planned · stage planning)', `decision taken: pick-db (${d.id})`])
    expect(entries[1]).toMatchObject({ kind: 'change', author: 'assistant', stage: 'planning' })
    expect((eml.engrams.get(task.id)!.properties as Record<string, unknown>).stage).toBe('planning')
  })

  it('a note with task_id: refines edge + entry; without a title (an app note) the entry quotes the content', () => {
    const task = hub()
    const plan = writes(eml).store({
      type: 'note', scope: 'project.eml', content: 'Plan: migrate, then rebuild the index.', task_id: task.id,
      origin: 'cockpit-notes', properties: { binding: 'task' },
    })
    expect(edge(plan.id, task.id, 'refines')).toBeTruthy()
    expect(changes(task.id).pop()!.text).toBe(`note written: Plan: migrate, then rebuild the index. (${plan.id})`)
  })

  it('an event, a log and a reference refine the task and are noted in its journal', () => {
    const task = hub()
    const ev = writes(eml).store(validEvent({ scope: 'project.eml', title: 'deploy', task_id: task.id }))
    const log = writes(eml).store(validLog({ scope: 'project.eml', title: 'session-1', task_id: task.id }))
    const ref = writes(eml).store(validReference({ scope: 'project.eml', title: 'doc', task_id: task.id }))
    for (const e of [ev, log, ref]) expect(edge(e.id, task.id, 'refines')).toBeTruthy()
    expect(changes(task.id).slice(1).map(e => e.text)).toEqual([
      `event recorded: deploy (${ev.id})`, `log written: session-1 (${log.id})`, `reference written: doc (${ref.id})`,
    ])
  })

  it('a decision or note with task_id needs binding; binding task without task_id is rejected', () => {
    const task = hub()
    expect(() => writes(eml).store(validDecision({ task_id: task.id }))).toThrow(/a decision with task_id needs binding/)
    expect(() => writes(eml).store(validNote({ task_id: task.id }))).toThrow(/a note with task_id needs binding/)
    expect(() => writes(eml).store(validDecision({ properties: { binding: 'task' } }))).toThrow(/binding task needs task_id/)
  })

  it('a bad task_id writes nothing: unknown id, a non-task, a type that takes no task_id', () => {
    const task = hub()
    const note = writes(eml).store(validNote({ scope: 'global', content: 'a note' }))
    const before = { engrams: count('engrams'), relations: count('relations'), entries: count('entries') }

    expect(() => writes(eml).store(validDecision({ task_id: 'no-such-id', properties: { binding: 'task' } })))
      .toThrow('Invalid engram: task_id no-such-id is not a task.')
    expect(() => writes(eml).store(validDecision({ task_id: note.id, properties: { binding: 'task' } })))
      .toThrow(`Invalid engram: task_id ${note.id} is not a task.`)
    expect(() => writes(eml).store(validTask({ task_id: task.id })))
      .toThrow('Invalid engram: task_id is not available for type task.')
    expect(() => writes(eml).store(validStatus({ task_id: task.id })))
      .toThrow(/not available for type status/)
    expect(() => writes(eml).store(validRule({ scope: 'project.eml', task_id: task.id })))
      .toThrow(/not available for type rule/)

    expect({ engrams: count('engrams'), relations: count('relations'), entries: count('entries') }).toEqual(before)
  })

  it('atomic: if the entry cannot be written, the decision and its edge roll back', () => {
    const task = hub()
    rawDb().exec(`CREATE TRIGGER fail_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'entry write failed'); END`)
    const before = { engrams: count('engrams'), relations: count('relations') }

    expect(() => writes(eml).store(validDecision({ scope: 'project.eml', content: 'doomed', task_id: task.id, properties: { binding: 'task' } })))
      .toThrow('entry write failed')
    expect({ engrams: count('engrams'), relations: count('relations') }).toEqual(before)
    expect(rawDb().prepare(`SELECT 1 FROM engrams_fts WHERE content = 'doomed'`).get()).toBeUndefined()
  })

  it('the decision rules still apply first (no entry for a rejected decision)', () => {
    const task = hub()
    const before = count('entries')
    expect(() => writes(eml).store({ type: 'decision', scope: 'project.eml', title: 'x', content: 'no alternatives', task_id: task.id, properties: { binding: 'task' } }))
      .toThrow(/^Invalid engram: a decision needs/)
    expect(count('entries')).toBe(before)
  })
})
