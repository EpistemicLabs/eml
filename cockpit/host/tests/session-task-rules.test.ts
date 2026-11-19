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
})
