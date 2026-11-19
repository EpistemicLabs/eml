import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validTask, writes } from './fixtures'

// v0.22 task system: a step's depends_on, checkpoint, waiting_on and done_when are optional
// task fields. Tasks without them stay as they are; an update keeps the fields
// it does not name.

describe('task system fields', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties!
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)

  it('a step is created with its checkpoint and dependencies', () => {
    const first = writes(eml).store(validTask({ scope: 'project.eml', title: 'proof' }))
    const step = writes(eml).store(validTask({ scope: 'project.eml', title: 'deploy', properties: { checkpoint: 'before', depends_on: [first.id] } }))
    expect(props(step.id).checkpoint).toBe('before')
    expect(props(step.id).depends_on).toEqual([first.id])
  })

  it('rejects a checkpoint outside before · after · none', () => {
    expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { checkpoint: 'later' } })))
      .toThrow('checkpoint must be one of before, after, none.')
  })

  it('waiting_on is a flat map of text', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml' }))
    expect(() => writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', since: 3 } as unknown as Record<string, string> }))
      .toThrow('waiting_on must be a flat map of text values.')
  })

  it('track sets, journals and clears the fields, and keeps the ones it does not name', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { priority: 'high', checkpoint: 'after' } }))
    writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', why: 'review', since: '2026-11-17T09:02:00Z', session_id: 's-1' } })
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', why: 'review', since: '2026-11-17T09:02:00Z', session_id: 's-1' })
    expect(props(t.id).priority).toBe('high')
    expect(props(t.id).checkpoint).toBe('after')
    expect(changes(t.id).at(-1)).toBe('waiting on nobody → lasse · review')

    writes(eml).trackTask(t.id, { waiting_on: null, checkpoint: 'none' })
    expect(props(t.id).waiting_on).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('none')
    expect(changes(t.id)).toContain('checkpoint after → none')
    expect(changes(t.id)).toContain('waiting on lasse · review → nobody')
  })

  it('done_when is set, journalled and cleared like the other fields', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { done_when: 'the customer answered' } }))
    expect(props(t.id).done_when).toBe('the customer answered')
    writes(eml).trackTask(t.id, { done_when: 'the customer withdrew the cancellation' })
    expect(props(t.id).done_when).toBe('the customer withdrew the cancellation')
    expect(changes(t.id).at(-1)).toBe('done_when changed')
    writes(eml).trackTask(t.id, { done_when: null })
    expect(props(t.id).done_when).toBeUndefined()
    expect(changes(t.id).at(-1)).toBe('done_when cleared')
  })

  it('lists the tasks whose turn it is for one handle', () => {
    const waiting = writes(eml).store(validTask({ scope: 'project.eml', title: 'waits' }))
    writes(eml).store(validTask({ scope: 'project.eml', title: 'runs' }))
    writes(eml).trackTask(waiting.id, { waiting_on: { who: 'lasse', why: 'go', since: '2026-11-17T09:00:00Z' } })
    const listed = eml.engrams.query({ type: 'task', waiting_on: 'lasse' })
    expect(listed.map(e => e.title)).toEqual(['waits'])
  })
})
