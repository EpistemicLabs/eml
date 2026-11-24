import { describe, it, expect } from 'vitest'
import { sessionName } from '../src/domain/session-name.js'
import { taskNameOf } from '../src/domain/task-title.js'

describe('session name (task owns the name)', () => {
  const entry = { taskId: null as string | null, title: null as string | null, agentTitle: null as string | null }

  it('calls a session with a named task by its task, over its own titles', () => {
    expect(sessionName({ ...entry, taskId: 't1', title: 'Mine', agentTitle: 'Agent' }, 'Fix the stock answers', 'first prompt')).toBe('Fix the stock answers')
  })

  it('goes by its own name without a task, or while its task has none', () => {
    expect(sessionName({ ...entry, title: 'Mine', agentTitle: 'Agent' }, 'ignored', 'first prompt')).toBe('Mine')
    expect(sessionName({ ...entry, taskId: 't1', agentTitle: 'Agent' }, null, 'first prompt')).toBe('Agent')
    expect(sessionName({ ...entry, taskId: 't1' }, null, 'first prompt')).toBe('first prompt')
  })

  it('reads a task\'s name like the tasks card: display title, else the anchor as words, never the placeholder', () => {
    expect(taskNameOf({ title: 'fix-stock', displayTitle: 'Fix the stock answers' })).toBe('Fix the stock answers')
    expect(taskNameOf({ title: 'fix-stock-answers' })).toBe('Fix stock answers')
    expect(taskNameOf({ title: 'session-2026-11-24-a609860b' })).toBeNull()
    expect(taskNameOf({ title: 'session-2026-11-24-a609860b', displayTitle: 'Named by hand' })).toBe('Named by hand')
    expect(taskNameOf({ title: null })).toBeNull()
  })
})
