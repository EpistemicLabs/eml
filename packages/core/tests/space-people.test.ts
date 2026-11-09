import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, boot, readObject, spacePeople, knownAssignees } from '../src'
import { validNote, validTask, writes } from './fixtures'

// v0.21: who works in a brain — what eml_read_object lists as users and
// agents, what a task's assignee_ids may name, and the shared-space block of
// the boot. A private brain: its objects and the agents that wrote in it. A
// shared brain: its members (from the server's member set) and the agents
// that wrote in it.

describe('spacePeople', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'motti' })
    writes(eml).users.create({ id: 'dominik', name: 'Dominik' })
    writes(eml).agents.store({ id: 'motti', name: 'Motti' })
  })
  afterEach(() => eml.close())

  it('a private brain: its user and agent objects, and the agents that wrote in it with the handles they wrote for', () => {
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-motti' }) }, eml.env({ handle: 'dominik', agent: 'motti' }))
    const id = eml.apply({ name: 'engram.create', input: validTask({ title: 'by-argus' }) }, eml.env({ handle: 'dominik', agent: 'argus' })).id
    eml.apply({ name: 'task.track', input: { id, text: 'went on' } }, eml.env({ handle: 'dominik', agent: 'nova' }))
    const { users, agents } = spacePeople(eml)
    expect(users.map(u => u.id)).toEqual(['dominik'])
    expect(agents.map(a => [a.id, a.works_for])).toEqual([['argus', ['dominik']], ['motti', ['dominik']], ['nova', ['dominik']]])
    expect(agents.find(a => a.id === 'motti')).toMatchObject({ name: 'Motti', engram_count: 0 })
    expect([...knownAssignees(eml)].sort()).toEqual(['argus', 'dominik', 'motti', 'nova'])
  })

  it('a shared brain: its members with a readable handle, no objects, and the agents that wrote in it', () => {
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-juno' }) }, eml.env({ handle: 'tester', agent: 'juno' }))
    const members = [{ handle: 'dominik', self: true }, { handle: 'tester', self: false }, { handle: null, self: false }]
    expect(spacePeople(eml, members)).toEqual({
      users: [{ id: 'dominik', name: 'dominik', self: true }, { id: 'tester', name: 'tester' }],
      agents: [{ id: 'juno', name: 'juno', works_for: ['tester'] }],
    })
    expect(readObject(eml, 'user', { members })).toHaveLength(2)
    expect(readObject(eml, 'agent', { id: 'juno', members })).toEqual({ id: 'juno', name: 'juno', works_for: ['tester'] })
    expect(readObject(eml, 'agent', { id: 'motti', members })).toBeNull()
  })
})

describe('boot — the shared-space block', () => {
  let eml: EML
  beforeEach(() => { eml = new EML({ dbPath: ':memory:', namespace: 'motti' }) })
  afterEach(() => eml.close())

  const block = (lines: string[]) => [
    '## Shared space',
    'This space is shared: every member reads and writes the same brain, and what you write here they see.',
    'Members:',
    ...lines,
    "Assign work with assignee_ids (a member's or an agent's handle); eml_read_object object=user · agent lists them.",
  ].join('\n')

  it('lists each member with its agents, the session\'s own agent marked (you) — also before it wrote — and a handle not readable yet', () => {
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-juno' }) }, eml.env({ handle: 'tester', agent: 'juno' }))
    const members = [{ handle: 'dominik', self: true }, { handle: 'tester', self: false }, { handle: 'lasse', self: false }, { handle: null, self: false }]
    const { markdown } = boot(eml, 'motti', { part: 'system', members, systemRules: [{ category: 'security', text: 'one' }] as never })
    expect(markdown).toBe(block([
      '- dominik · agents: motti (you)',
      '- tester · agents: juno',
      '- lasse',
      '- (handle not readable yet)',
    ]) + '\n\n## EML System Rules (managed by engramprotocol)\n- [security] one')
  })

  it('marks the own agent once it has written, only under this device\'s member; a private brain has no block', () => {
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-motti' }) }, eml.env({ handle: 'dominik', agent: 'motti' }))
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-argus' }) }, eml.env({ handle: 'dominik', agent: 'argus' }))
    eml.apply({ name: 'engram.create', input: validNote({ title: 'by-their-motti' }) }, eml.env({ handle: 'tester', agent: 'motti' }))
    const members = [{ handle: 'dominik', self: true }, { handle: 'tester', self: false }]
    expect(boot(eml, 'motti', { part: 'system', members }).markdown).toBe(block([
      '- dominik · agents: argus, motti (you)',
      '- tester · agents: motti',
    ]))
    expect(boot(eml, 'motti', { part: 'system' }).markdown).not.toContain('## Shared space')
    expect(boot(eml, 'motti', { part: 'identity', members }).markdown).not.toContain('## Shared space')
  })
})
