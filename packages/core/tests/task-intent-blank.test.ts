import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, projectBlock, renderBrainStateMarkdown } from '../src'
import { validTask, writes } from './fixtures'

// A task's intent is optional, but a value must not be blank: "" or whitespace
// is INVALID, null is the one way to clear it. A blank intent stored by
// v0.20.0–v0.20.4 renders like none.

describe('a blank task intent is INVALID (decision task-intent-blank-rejected)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const MESSAGE = 'Invalid engram: intent must not be blank — leave it out, or send null to clear it.'

  for (const blank of ['', '  ']) {
    it(`${JSON.stringify(blank)} is rejected on create`, () => {
      expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { intent: blank } }))).toThrow(MESSAGE)
    })

    it(`${JSON.stringify(blank)} is rejected on track, and nothing is written`, () => {
      const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { intent: 'users see X' } }))
      const rev = eml.engrams.getRaw(t.id)!.rev
      expect(() => writes(eml).trackTask(t.id, { intent: blank })).toThrow(MESSAGE)
      expect(eml.engrams.getRaw(t.id)!.properties!.intent).toBe('users see X')
      expect(eml.engrams.getRaw(t.id)!.rev).toBe(rev)
    })
  }

  it('null clears it; a value is stored as given', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { intent: ' users see X ' } }))
    expect(eml.engrams.getRaw(t.id)!.properties!.intent).toBe(' users see X ')
    writes(eml).trackTask(t.id, { intent: null })
    expect(eml.engrams.getRaw(t.id)!.properties!.intent).toBeUndefined()
    expect(eml.engrams.entries(t.id, ['change']).map(e => e.text).at(-1)).toBe('intent cleared')
  })

  it('a blank intent already stored (v0.20.0–v0.20.4) renders like none', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', title: 'old-blank', content: 'do it' }))
    ;(eml.engrams as any).db.prepare(`UPDATE engrams SET properties = json_set(properties, '$.intent', '  ') WHERE id = ?`).run(t.id)
    const stored = eml.engrams.getRaw(t.id)!
    expect(stored.properties!.intent).toBe('  ')
    const md = renderBrainStateMarkdown({
      scope: 'project.eml', current_status: [], recent_decisions: [], recent_logs: [], rules: [], pending_reviews: [],
      open_tasks: [stored],
    } as any)
    expect(md).toContain(`old-blank — do it · ${t.id}`)
    expect(md).not.toContain('intent:')
    expect(projectBlock(eml, 'eml')!.markdown).not.toContain('intent:')
  })
})
