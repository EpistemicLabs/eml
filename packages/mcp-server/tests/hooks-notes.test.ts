import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { contentHash, diffNote, notesScope, notesUpdate } from '../src/hooks/notes'

const CFG = { EML_URL: 'http://brain.test', EML_API_TOKEN: 't' }
const INPUT = { session_id: 'sess-1', cwd: '/x/eml-app' }
const ENV = { EML_PROJECT_SCOPE: 'project.eml-app' }

type Note = { id: string; content: string; properties?: Record<string, unknown> }
// Pane notes carry source_id 'cockpit-notes'; byAgent = a pane note the agent edited last.
const byUser = (id: string, content: string): Note => ({ id, content, properties: { source_id: 'cockpit-notes', user_content_hash: contentHash(content) } })
const byAgent = (id: string, content: string, stamp = 'stale'): Note => ({ id, content, properties: { source_id: 'cockpit-notes', user_content_hash: stamp } })
// A note an agent wrote itself (task plan, re-filed decision) — not one of the user's notes.
const agentWritten = (id: string, content: string): Note => ({ id, content, properties: { source_id: 'assistant', source_type: 'agent' } })

function fakeBrain(notes: () => Note[], seen: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    seen.push(String(url))
    return new Response(JSON.stringify({ engrams: notes() }), { status: 200 })
  }) as typeof fetch
}

describe('diffNote', () => {
  it('reads checkbox toggles as toggles, other lines as +/−', () => {
    const before = '# Todo\n- [ ] Resume fix\n- [ ] Search\nold line'
    const after = '# Todo\n- [x] Resume fix\n- [ ] Search\n- [ ] Notes pane'
    expect(diffNote(before, after)).toEqual([
      '  ☑ Resume fix   (was ☐)',
      '  + - [ ] Notes pane',
      '  − old line',
    ])
  })

  it('ignores reordering and blank lines', () => {
    expect(diffNote('a\n\nb', 'b\na\n')).toEqual([])
  })
})

describe('notesScope', () => {
  it('prefers EML_PROJECT_SCOPE, falls back to the cwd basename, rejects junk', () => {
    expect(notesScope('/x/other', ENV)).toBe('project.eml-app')
    expect(notesScope('/x/eml-app', {})).toBe('project.eml-app')
    expect(notesScope('/x/eml-app', { EML_PROJECT_SCOPE: 'global; rm' })).toBe('project.eml-app')
    expect(notesScope('', {})).toBeNull()
  })
})

describe('notesUpdate', () => {
  let stateDir: string
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-notes-')) })
  afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }) })

  it('names the notes on the first turn, scoped by EML_PROJECT_SCOPE', async () => {
    const seen: string[] = []
    const r = await notesUpdate(CFG, stateDir, INPUT, ENV, fakeBrain(() => [byUser('n1', '# Cockpit todos\n- [ ] a')], seen))
    expect(r.output).toContain('"Cockpit todos" (n1)')
    expect(seen[0]).toContain('scope=project.eml-app')
    expect(seen[0]).toContain('type=note')
  })

  it('lists only notes written in the notes pane, not agent-written notes', async () => {
    const r = await notesUpdate(CFG, stateDir, INPUT, ENV, fakeBrain(() => [
      byUser('n1', '# Cockpit todos\n- [ ] a'),
      agentWritten('n2', '# Plan for task X\n- step 1'),
    ]))
    expect(r.output).toContain('"Cockpit todos" (n1)')
    expect(r.output).not.toContain('n2')
  })

  it('shows the user\'s edits once, then stays quiet', async () => {
    let notes = [byUser('n1', '# Todo\n- [ ] a')]
    const brain = fakeBrain(() => notes)
    await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    notes = [byUser('n1', '# Todo\n- [x] a\n- [ ] b')]
    const r = await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    expect(r.output).toContain('[Notes changed by the user')
    expect(r.output).toContain('☑ a   (was ☐)')
    expect(r.output).toContain('+ - [ ] b')
    expect((await notesUpdate(CFG, stateDir, INPUT, ENV, brain)).output).toBe('')
  })

  it('does not echo the agent\'s own edits back to it', async () => {
    let notes = [byUser('n1', '# Todo\n- [ ] a')]
    const brain = fakeBrain(() => notes)
    await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    notes = [byAgent('n1', '# Todo\n- [x] a', contentHash('# Todo\n- [ ] a'))]
    expect((await notesUpdate(CFG, stateDir, INPUT, ENV, brain)).output).toBe('')
    // …and a later user edit diffs against the agent's version.
    notes = [byUser('n1', '# Todo\n- [x] a\n- [ ] c')]
    const r = await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    expect(r.output).toContain('+ - [ ] c')
    expect(r.output).not.toContain('☑ a')
  })

  it('reports new and archived notes', async () => {
    let notes = [byUser('n1', 'First')]
    const brain = fakeBrain(() => notes)
    await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    notes = [byUser('n2', '# Second\n- [ ] x')]
    const r = await notesUpdate(CFG, stateDir, INPUT, ENV, brain)
    expect(r.output).toContain('New note "Second" (n2)')
    expect(r.output).toContain('"First" (n1) was archived or removed.')
  })

  it('is silent without config, session or reachable brain', async () => {
    expect((await notesUpdate(null, stateDir, INPUT, ENV)).output).toBe('')
    expect((await notesUpdate(CFG, stateDir, { cwd: '/x' }, ENV)).output).toBe('')
    const down = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    expect((await notesUpdate(CFG, stateDir, INPUT, ENV, down)).output).toBe('')
    const old = (async () => new Response('{}', { status: 400 })) as typeof fetch
    expect((await notesUpdate(CFG, stateDir, INPUT, ENV, old)).output).toBe('')
  })
})
