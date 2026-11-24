import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-task-rules-'))

describe('what a session reads about its task', () => {
  it('names the delegate and says the owner stays a person', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const text = taskContext({ id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { checkpoint: 'after', delegate: 'atlas' } } as never, false)
    expect(text).toContain('[active · checkpoint after · delegate atlas]')
    expect(text).toContain('Never put an agent into assignee_ids.')
    expect(text).toContain('a checkpoint (default after; before when it needs the user\'s OK first) and a delegate')
  })

  it('tells the session to hand finished work over for review and close only on the owner\'s word', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const text = taskContext({ id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { checkpoint: 'before', delegate: 'atlas' } } as never, false)
    expect(text).toContain('a task with checkpoint before or after you never close on your own')
    expect(text).toContain('tells you explicitly in the chat to close it')
    expect(text).toContain('not when its PR is open or merged')
    expect(text).not.toContain('A task with checkpoint after you only close once')
  })

  it('tells every session, workers included, when to split work and what a sub-task holds', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const { MAX_RUNNING } = await import('../src/domain/runner-gate.js')
    const task = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: {} } as never
    for (const worker of [false, true]) {
      const text = taskContext(task, false, worker)
      expect(text).toContain('## Splitting work')
      expect(text).toContain('One session does this task from start to end.')
      expect(text).toContain('only for truly separate work')
      expect(text).toContain('do not run in parallel: chain them (depends_on) or make them one step')
      expect(text).toContain(`At most ${MAX_RUNNING} steps of one task run at the same time, and ${MAX_RUNNING} tasks without a parent per space`)
    }
  })

  it('has a worker name new work as a [task] question instead of offering a split', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const task = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: {} } as never
    const worker = taskContext(task, false, true)
    expect(worker).toContain('Name it in the handoff as a [task] question.')
    expect(worker).not.toContain('offer_split')
    const attended = taskContext(task, false, false)
    expect(attended).toContain('offer_split')
    expect(attended).not.toContain('Name it in the handoff as a [task] question.')
  })

  it('names the parent and its goal for a step', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const task = { id: 's1', title: 'acme-step', content: 'Do a part.', status: 'planned', properties: {} } as never
    const parent = { id: 'p1', title: 'acme-rescue', properties: { display_title: 'Keep Acme as a customer', goal: 'Acme renewed.' } }
    expect(taskContext(task, false, true, parent)).toContain('Step of **Keep Acme as a customer** (p1). Parent goal: Acme renewed.')
    expect(taskContext(task, false, true)).not.toContain('Step of')
  })
})
