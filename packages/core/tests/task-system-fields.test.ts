import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validTask, writes } from './fixtures'

// v0.22 task system: a step's depends_on, checkpoint, waiting_on and goal are optional
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

  it('goal is set, journalled and cleared like the other fields', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { goal: 'the customer answered' } }))
    expect(props(t.id).goal).toBe('the customer answered')
    writes(eml).trackTask(t.id, { goal: 'the customer withdrew the cancellation' })
    expect(props(t.id).goal).toBe('the customer withdrew the cancellation')
    expect(changes(t.id).at(-1)).toBe('goal changed')
    writes(eml).trackTask(t.id, { goal: null })
    expect(props(t.id).goal).toBeUndefined()
    expect(changes(t.id).at(-1)).toBe('goal cleared')
  })

  it('delegate names the one agent that works on the task, journalled, and the owner stays', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { assignee_ids: ['lasse'] } }))
    writes(eml).trackTask(t.id, { delegate: 'atlas', checkpoint: 'after' })
    expect(props(t.id).delegate).toBe('atlas')
    expect(props(t.id).assignee_ids).toEqual(['lasse'])
    expect(changes(t.id)).toContain('delegate none → atlas')
    writes(eml).trackTask(t.id, { delegate: 'motti' })
    expect(changes(t.id).at(-1)).toBe('delegate atlas → motti')
    writes(eml).trackTask(t.id, { delegate: null })
    expect(props(t.id).delegate).toBeUndefined()
    expect(changes(t.id).at(-1)).toBe('delegate motti → none')
  })

  it('delegate is one handle, not a list', () => {
    expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { delegate: ['atlas', 'motti'] } })))
      .toThrow(/delegate/)
  })

  it('lists the tasks delegated to one agent', () => {
    const mine = writes(eml).store(validTask({ scope: 'project.eml', title: 'atlas does it', properties: { delegate: 'atlas' } }))
    writes(eml).store(validTask({ scope: 'project.eml', title: 'nobody does it' }))
    expect(eml.engrams.query({ type: 'task', delegate: 'atlas' }).map(e => e.id)).toEqual([mine.id])
  })

  it('lists the tasks whose turn it is for one handle', () => {
    const waiting = writes(eml).store(validTask({ scope: 'project.eml', title: 'waits' }))
    writes(eml).store(validTask({ scope: 'project.eml', title: 'runs' }))
    writes(eml).trackTask(waiting.id, { waiting_on: { who: 'lasse', why: 'go', since: '2026-11-17T09:00:00Z' } })
    const listed = eml.engrams.query({ type: 'task', waiting_on: 'lasse' })
    expect(listed.map(e => e.title)).toEqual(['waits'])
  })
})
