import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validTask, writes } from './fixtures'

// task.track writes only what differs from the stored task, like engram.update:
// a field set to its current value, or a tag / subject set equal to the stored
// one, is no change. A call that changes nothing and has no text writes nothing
// (no rev, no updated_at, no entry); a text-only call stays a progress entry.

describe('task.track: a no-op writes nothing', () => {
  let eml: EML
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 9, 1) + (++tick) * 1000).toISOString()

  beforeEach(() => {
    tick = 0
    eml = new EML({ dbPath: ':memory:', namespace: 'test', clock })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
    writes(eml).tags.create({ name: 'ops' })
    writes(eml).tags.create({ name: 'infra' })
    writes(eml).subjects.create({ name: 'launch' })
    writes(eml).subjects.create({ name: 'audit' })
  })

  afterEach(() => eml.close())

  const task = () => writes(eml).store(validTask({
    scope: 'project.eml', title: 'steady', tags: ['ops', 'infra'], subjects: ['launch', 'audit'],
    properties: { priority: 'high', intent: 'users see X', stage: 'planning', blockers: ['b1'] },
  }))
  const state = (id: string) => {
    const e = eml.engrams.getRaw(id)!
    return { rev: e.rev, updated_at: e.updated_at, properties: e.properties, tags: e.tags, subjects: e.subjects, entries: eml.engrams.entries(id).length }
  }

  const NO_OPS: Array<[string, Record<string, unknown>]> = [
    ['a scalar field', { priority: 'high' }],
    ['intent', { intent: 'users see X' }],
    ['tags (another order)', { tags: ['infra', 'ops'] }],
    ['subjects (another order)', { subjects: ['audit', 'launch'] }],
    ['stage', { stage: 'planning' }],
    ['the status', { status: 'planned' }],
    ['blockers', { blockers: ['b1'] }],
    ['all of them at once', { priority: 'high', intent: 'users see X', tags: ['ops', 'infra'], subjects: ['launch', 'audit'], stage: 'planning' }],
  ]
  for (const [what, input] of NO_OPS) {
    it(`${what} set to its current value: no rev, no updated_at, no entry`, () => {
      const t = task()
      const before = state(t.id)
      const r = writes(eml).trackTask(t.id, input)!
      expect(r.entries_written).toEqual([])
      expect(state(t.id)).toEqual(before)
    })
  }

  it('a text-only call is a progress entry: the note, updated_at and rev — as before', () => {
    const t = task()
    const before = state(t.id)
    const r = writes(eml).trackTask(t.id, { text: 'made progress' })!
    expect(r.entries_written.map((e: { kind: string, text: string }) => [e.kind, e.text])).toEqual([['note', 'made progress']])
    const after = state(t.id)
    expect(after.rev).toBe(before.rev + 1)
    expect(after.updated_at > before.updated_at).toBe(true)
    expect(after.entries).toBe(before.entries + 1)
    expect(after.properties).toEqual(before.properties)
  })

  it('text with unchanged fields writes only the note entry', () => {
    const t = task()
    const r = writes(eml).trackTask(t.id, { text: 'checked in', priority: 'high', tags: ['infra', 'ops'] })!
    expect(r.entries_written.map((e: { kind: string }) => e.kind)).toEqual(['note'])
    expect(eml.engrams.entries(t.id, ['change']).map(e => e.text)).toEqual(['created (planned · stage planning)'])
  })

  it('a real change still writes its entry and moves rev', () => {
    const t = task()
    const before = state(t.id)
    const r = writes(eml).trackTask(t.id, { priority: 'low', tags: ['ops'] })!
    expect(r.entries_written.map((e: { text: string }) => e.text)).toEqual(['priority high → low', 'tags → ops'])
    expect(state(t.id).rev).toBe(before.rev + 1)
  })
})
