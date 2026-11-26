import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-task-rules-'))

/** Who ends the session's turns, where a test does not care. */
const WHO = { owner: 'kim', agent: 'atlas', tool: true }

describe('what a session reads about its task', () => {
  it('names the delegate and says the owner stays a person', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const text = taskContext({ id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { checkpoint: 'after', delegate: 'atlas' } } as never, false, WHO)
    expect(text).toContain('[active · checkpoint after · delegate atlas]')
    expect(text).toContain('Never put an agent into assignee_ids.')
    expect(text).toContain('a checkpoint (default after; before when it needs the user\'s OK first) and a delegate')
  })

  it('tells the session to hand finished work over for review and close only on the owner\'s word', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const text = taskContext({ id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { checkpoint: 'before', delegate: 'atlas' } } as never, false, WHO)
    expect(text).toContain('a task with checkpoint before or after you never close on your own')
    expect(text).toContain('tells you explicitly in the chat to close it')
    expect(text).toContain('not when its PR is open or merged')
    expect(text).not.toContain('A task with checkpoint after you only close once')
    expect(text).toContain('Hand the result over for review (next names the owner); its owner closes it')
  })

  it('names the user\'s time zone and its offset, in a chat and in a terminal', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const task = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: {} } as never
    for (const tool of [true, false]) {
      expect(taskContext(task, false, { ...WHO, tool, zone: 'Asia/Bangkok (UTC+7)' })).toContain("Times: the user's time zone is Asia/Bangkok (UTC+7).")
    }
  })

  it('says how a turn ends once, by what the session can do, with the handles a who can name', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const { turnEndRules } = await import('../src/domain/turn-end.js')
    const task = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: {} } as never
    const chat = taskContext(task, false, { owner: 'kim', agent: 'atlas', tool: true })
    expect(chat.endsWith(turnEndRules({ owner: 'kim', agent: 'atlas', tool: true }))).toBe(true)
    expect(chat).toContain('## Ending a turn\nThe end_turn tool\'s description is the whole rule for ending a turn.\nHandles for who: the user is kim, you are atlas.')
    expect(chat).not.toContain('### Handoff')
    const terminal = taskContext(task, false, { owner: 'kim', agent: 'atlas', tool: false })
    expect(terminal).toContain('### Handoff')
    expect(terminal).toContain('- [kim]')
    expect(terminal).not.toContain('tool\'s description')
    // A terminal session that gets the tool from the cockpit's MCP server: the tool by its name there, with its rule.
    const served = taskContext(task, false, { owner: 'kim', agent: 'atlas', tool: { mcpServer: 'cockpit' } })
    expect(served.endsWith(turnEndRules({ owner: 'kim', agent: 'atlas', tool: { mcpServer: 'cockpit' } }))).toBe(true)
    expect(served).toContain('End a turn with the end_turn tool: mcp__cockpit__end_turn, from the MCP server cockpit.')
    expect(served).not.toContain('### Handoff')
    for (const text of [chat, terminal]) {
      expect(text.match(/## Ending a turn/g)).toHaveLength(1)
      expect(text).not.toContain('session_status')
      expect(text).not.toMatch(/^## Handoff/m)
    }
  })

  it('tells a session on a task handed to an agent what to do until it is done, whoever started it', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const handed = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { checkpoint: 'after', delegate: 'atlas' } } as never
    const own = { id: 't2', title: 'acme-notes', content: 'Notes.', status: 'active', properties: {} } as never
    for (const worker of [false, true]) {
      const text = taskContext(handed, false, WHO, worker)
      expect(text).toContain('## Until it is done')
      expect(text).toContain('- Reached: hand the result over for review (next names the owner). Do not close it yourself.')
      expect(text).toContain('- Not reached: name yourself as next, with the time you look again (when); a task that has a next run from its schedule needs no time. The cockpit wakes you then: a simple check needs no schedule tool call.')
      expect(taskContext(own, false, WHO, worker)).not.toContain('## Until it is done')
    }
  })

  it('a task handed over with checkpoint none is closed by its agent once its goal is reached, not handed over for review', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const text = taskContext({ id: 't1', title: 'acme-sync', content: 'Sync.', status: 'active', properties: { checkpoint: 'none', delegate: 'atlas' } } as never, false, WHO, true)
    expect(text).toContain('- Reached: close it yourself (eml_track_task with status resolved and the outcome), unless its schedule is still on (see Closing).')
    expect(text).not.toContain('Do not close it yourself.')
  })

  it('tells every session that no run closes a task whose schedule is still on, also one without a checkpoint', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    for (const checkpoint of ['after', 'none']) {
      const text = taskContext({ id: 't1', title: 'daily-brief', content: 'Write it.', status: 'active', properties: { checkpoint, delegate: 'atlas' } } as never, false, WHO, true)
      const closing = text.split('\n').find((line) => line.startsWith('- Closing:'))!
      expect(closing).toContain('A task with checkpoint none, or one an agent owns, you close yourself when it is done.')
      expect(closing.endsWith('A task whose schedule is still on (it has a repeating time or a wake-up: a routine, a mission that checks back) no run closes, whatever its checkpoint: once its goal is reached, end its schedule first, then hand the result over for review (next names the owner): repeating times you end with the schedule tool (action finish), a wake-up the cockpit clears with the hand-over; its owner closes it.')).toBe(true)
    }
  })

  it('tells every session, workers included, when to split work and what a sub-task holds', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const { MAX_RUNNING } = await import('../src/domain/runner-gate.js')
    const task = { id: 't1', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: {} } as never
    for (const worker of [false, true]) {
      const text = taskContext(task, false, WHO, worker)
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
    const worker = taskContext(task, false, WHO, true)
    expect(worker).toContain('do not create a task for it. Name it when you end the turn, as a question for the user.')
    expect(worker).not.toContain('offer_split')
    const attended = taskContext(task, false, WHO, false)
    expect(attended).toContain('offer_split')
    expect(attended).not.toContain('Name it when you end the turn')
  })

  it('names the parent and its goal for a step', async () => {
    const { taskContext } = await import('../src/application/session-task.js')
    const task = { id: 's1', title: 'acme-step', content: 'Do a part.', status: 'planned', properties: {} } as never
    const parent = { id: 'p1', title: 'acme-rescue', properties: { display_title: 'Keep Acme as a customer', goal: 'Acme renewed.' } }
    expect(taskContext(task, false, WHO, true, parent)).toContain('Step of **Keep Acme as a customer** (p1). Parent goal: Acme renewed.')
    expect(taskContext(task, false, WHO, true)).not.toContain('Step of')
  })
})
