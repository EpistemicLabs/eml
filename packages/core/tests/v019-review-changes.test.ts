import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, type WriteContext } from '../src'
import { renderBrainStateMarkdown } from '../src/render'
import { validDecision, validLog } from './fixtures'

// v0.19 — behaviour changes from the review of the agent-facing texts
// (note v0.19-agent-texts-decisions, C1–C6).

describe('v0.19 review changes', () => {
  let eml: EML
  const ctx = (session = 's1', caller = 'juno'): WriteContext =>
    ({ caller, session_id: session, model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp' })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.agents.store({ id: 'juno', name: 'Juno' })
    eml.users.create({ id: 'ada', name: 'Ada' })
    eml.projects.create({ id: 'p', name: 'P' })
  })
  afterEach(() => { eml.close() })

  describe('C1 eml_show: the last five logs, no decisions', () => {
    it('lists the five newest logs and no decisions section', () => {
      for (let i = 1; i <= 6; i++) {
        eml.engrams.store(validLog({ scope: 'project.p', title: `session-${i}`, properties: { what: `what ${i}`, landed: 'l', next: `next ${i}` } }), ctx(`s${i}`))
      }
      eml.engrams.store(validDecision({ scope: 'project.p', title: 'some-choice' }), ctx())
      const state = eml.engrams.buildBrainState('project.p')
      expect(state.recent_logs).toHaveLength(5)
      const md = renderBrainStateMarkdown(state)
      expect(md).toContain('## Recent sessions (last 5, newest first)')
      expect(md).toContain('next: next 6')
      expect(md).not.toContain('session-1 ')
      expect(md).not.toContain('## Decisions')
      expect(md).not.toContain('some-choice')
    })
  })
})
