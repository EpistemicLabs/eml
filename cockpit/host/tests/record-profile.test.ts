import { describe, it, expect } from 'vitest'
import { narrowRecordProfile } from '../src/application/record-profile.js'
import { newRecord, recordKeeping } from '../src/domain/job.js'
import type { ToolProfile } from '../src/domain/tool-profile.js'
import { JobStore } from '../src/job-store.js'

// A wake-up set by ending a turn must never lead to a session with more tools than the session that set it: the
// record's profile is what a new session of the task starts with, and it is narrowed by the schedule tool's rule.

const AT = '2026-11-25T08:00:00.000Z'
const TASK = { id: 't1', spaceId: null }
const NO_SHELL: ToolProfile = { deniedTools: ['Bash'], mcpServers: null }
const store = (profile?: ToolProfile | null) => {
  const s = new JobStore(null)
  if (profile !== undefined) s.put({ ...newRecord(TASK, '2026-11-01T00:00:00.000Z', 'maker'), toolProfile: profile })
  return s
}
const narrow = (s: JobStore, toolProfile: ToolProfile | null) => narrowRecordProfile(s, TASK, { sessionId: 's1', toolProfile }, AT)

describe('the record\'s tools after a session set a wake-up', () => {
  it('a session with all its tools changes nothing, and no record is made for it', () => {
    const none = store()
    expect(narrow(none, null)).toBeNull()
    expect(none.get('t1')).toBeUndefined()
    const has = store(NO_SHELL)
    const before = structuredClone(has.get('t1'))
    expect(narrow(has, null)).toBeNull()
    expect(has.get('t1')).toEqual(before)
  })

  it('a narrowed session on a task without a record: the record is made with its profile, and stays while the task is open', () => {
    const s = store()
    const made = narrow(s, { deniedTools: ['Bash', 'SendMessage'], mcpServers: ['eml'] })
    expect(made).toMatchObject({ id: 't1', taskId: 't1', spaceId: null, createdBy: 's1', toolProfile: { deniedTools: ['Bash', 'SendMessage'], mcpServers: ['eml'] }, cursor: null })
    expect(s.get('t1')).toEqual(made)
    // a record with a profile is kept for an open task even when nothing else holds it
    expect(recordKeeping(s.get('t1')!, 'open', []).remove).toBe(false)
  })

  it('a narrowed session narrows a wider record to what both allow, and gives one without a profile its own', () => {
    const wider = store({ deniedTools: ['WebFetch'], mcpServers: ['eml', 'gmail', 'slack'] })
    expect(narrow(wider, { deniedTools: ['Bash'], mcpServers: ['eml', 'slack', 'stripe'] })?.toolProfile).toEqual({ deniedTools: ['WebFetch', 'Bash'], mcpServers: ['eml', 'slack'] })
    expect(wider.get('t1')).toMatchObject({ createdBy: 'maker', updatedAt: AT })
    const free = store(null)
    expect(narrow(free, NO_SHELL)?.toolProfile).toEqual(NO_SHELL)
    // every MCP server allowed on the record, some on the session: the session's list
    const all = store({ deniedTools: [], mcpServers: null })
    expect(narrow(all, { deniedTools: [], mcpServers: ['eml'] })?.toolProfile).toEqual({ deniedTools: [], mcpServers: ['eml'] })
  })

  it('a narrowed session leaves a narrower record as it is: nothing is written', () => {
    const narrower = store({ deniedTools: ['Bash', 'SendMessage', 'WebFetch'], mcpServers: ['eml'] })
    const before = structuredClone(narrower.get('t1'))
    expect(narrow(narrower, { deniedTools: ['Bash'], mcpServers: ['eml', 'gmail'] })).toBeNull()
    expect(narrow(narrower, { deniedTools: ['SendMessage', 'Bash'], mcpServers: null })).toBeNull()
    expect(narrower.get('t1')).toEqual(before)
  })
})
