import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'

// v0.10.9 audit C0 (H1) regression: property-filters (--due-before / --assignee /
// --priority / --change-type) must be SQL predicates so the LIMIT applies AFTER
// filtering. The old CLI filtered in JS AFTER the LIMIT, so matches sorted past the
// limit were silently dropped — a wrong/empty result in a memory store. See
// docs/specs/v0.10.9-PROPOSAL.md Appendix A.

describe('query property-filters apply before LIMIT (audit C0)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    eml.projects.create({ id: 'eml', name: 'EML' })
    eml.agents.store({ id: 'alice', name: 'Alice' })
    eml.agents.store({ id: 'bob', name: 'Bob' })

    // 30 tasks assigned to alice, written FIRST (so a created_at-DESC sort buries
    // them behind the 20 bob tasks — exactly the "late-sorted match" the bug drops).
    for (let i = 0; i < 30; i++) {
      eml.engrams.store({
        type: 'task', scope: 'project.eml', title: `alice-task-${i}`,
        content: `Alice task ${i}`, properties: { assignee_id: 'alice' },
      })
    }
    for (let i = 0; i < 20; i++) {
      eml.engrams.store({
        type: 'task', scope: 'project.eml', title: `bob-task-${i}`,
        content: `Bob task ${i}`, properties: { assignee_id: 'bob' },
      })
    }
  })

  afterEach(() => {
    eml.close()
  })

  it('returns ALL 30 assignee matches when the limit admits them (was: silently dropped)', () => {
    const results = eml.engrams.query({ type: 'task', assignee: 'alice', limit: 40 })
    expect(results).toHaveLength(30)
    expect(results.every(r => r.properties?.assignee_id === 'alice')).toBe(true)
  })

  it('a small limit yields limit-many MATCHES, never limit-many raw rows then filtered to fewer', () => {
    const results = eml.engrams.query({ type: 'task', assignee: 'alice', limit: 10 })
    expect(results).toHaveLength(10)
    expect(results.every(r => r.properties?.assignee_id === 'alice')).toBe(true)
  })

  it('priority filter is a SQL predicate', () => {
    eml.engrams.store({
      type: 'task', scope: 'project.eml', title: 'urgent-one',
      content: 'urgent', properties: { priority: 'urgent' },
    })
    const results = eml.engrams.query({ type: 'task', priority: 'urgent', limit: 5 })
    expect(results).toHaveLength(1)
    expect(results[0].properties?.priority).toBe('urgent')
  })

  it('due_before filter is a SQL predicate (strict <)', () => {
    eml.engrams.store({
      type: 'task', scope: 'project.eml', title: 'due-early',
      content: 'soon', properties: { due_date: '2026-01-01' },
    })
    eml.engrams.store({
      type: 'task', scope: 'project.eml', title: 'due-late',
      content: 'later', properties: { due_date: '2026-12-01' },
    })
    const results = eml.engrams.query({ type: 'task', due_before: '2026-06-01', limit: 50 })
    expect(results.map(r => r.title)).toContain('due-early')
    expect(results.map(r => r.title)).not.toContain('due-late')
  })

  it('change_type filter is a SQL predicate', () => {
    eml.engrams.store({
      type: 'event', scope: 'project.eml', title: 'deploy-evt',
      content: 'deployed v1', properties: { occurred_at: '2026-06-01T00:00:00Z', change_type: 'deployed' },
    })
    eml.engrams.store({
      type: 'event', scope: 'project.eml', title: 'fail-evt',
      content: 'failed run', properties: { occurred_at: '2026-06-01T00:00:00Z', change_type: 'failed' },
    })
    const results = eml.engrams.query({ change_type: 'deployed', limit: 50 })
    expect(results.map(r => r.title)).toContain('deploy-evt')
    expect(results.map(r => r.title)).not.toContain('fail-evt')
  })
})
