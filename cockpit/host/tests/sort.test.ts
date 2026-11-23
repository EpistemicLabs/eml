import { describe, it, expect } from 'vitest'
import { planSort } from '../src/domain/sort.js'

describe('sorting a drifted session', () => {
  it('links topics that have a task, creates the missing ones, and closes the dropped', () => {
    expect(planSort('t-root', [
      { topic: 'Session review views', pick: 'keep', taskId: 't-root' },
      { topic: 'Task board mockup', pick: 'sub', taskId: 't-board' },
      { topic: 'Owner + delegate model', pick: 'spun', taskId: 't-owner' },
      { topic: 'Top bar v2', pick: 'drop', taskId: 't-top' },
      { topic: 'No greeting in a new chat', pick: 'sub', brief: 'Goal: a new chat opens without a greeting.' },
      { topic: 'Media viewer', pick: 'spun' },
      { topic: 'Plugins settings', pick: 'unrelated' },
      { topic: 'Green redesign', pick: 'drop' },
    ])).toEqual([
      { kind: 'link_sub', taskId: 't-board' },
      { kind: 'link_spun', taskId: 't-owner' },
      { kind: 'close', taskId: 't-top' },
      { kind: 'create', title: 'no-greeting-in-a-new-chat', content: 'No greeting in a new chat\n\nGoal: a new chat opens without a greeting.', parent: true, origin: false },
      { kind: 'create', title: 'media-viewer', content: 'Media viewer', parent: false, origin: true },
      { kind: 'create', title: 'plugins-settings', content: 'Plugins settings', parent: false, origin: false },
    ])
  })

  it('never touches the session\'s own task, and skips a topic without a usable title', () => {
    expect(planSort('t-root', [{ topic: 'This one', pick: 'drop', taskId: 't-root' }, { topic: '✨', pick: 'spun' }, { topic: ' ', pick: 'sub' }])).toEqual([])
  })

  it('leaves a task alone that is picked as unrelated: it already has its own place', () => {
    expect(planSort('t-root', [{ topic: 'Follow-up loop', pick: 'unrelated', taskId: 't-loop' }])).toEqual([])
  })
})
