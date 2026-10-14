import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { extractSupersedesIds } from '../src/engrams'
import { validDecision } from './fixtures'

// v0.13: store() honours `properties.supersedes` for ANY type. On a write that
// declares it, each prior engram is flipped to 'superseded' AND a 'supersedes'
// relation edge (new → old) is materialised — the status-type auto-supersede
// mechanism, generalised to decision/rule/profile via the explicit declaration.
// Before this, non-status supersession set only the status field (via a separate
// eml_update) and never drew the graph edge.

describe('explicit supersede edges (v0.13)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    eml.projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const edge = (from: string, to: string): any =>
    rawDb().prepare(
      `SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'supersedes'`,
    ).get(from, to)
  const statusOf = (id: string): string =>
    (rawDb().prepare('SELECT status FROM engrams WHERE id = ?').get(id) as { status: string }).status

  const decision = (title: string, content: string, props?: Record<string, unknown>) =>
    eml.engrams.store(validDecision({ scope: 'project.eml', title, content, properties: props }))

  it('flips the prior engram AND draws the supersedes edge', () => {
    const old = decision('comm', 'v1')
    const next = decision('comm', 'v2', { supersedes: [old.id] })

    expect(statusOf(old.id)).toBe('superseded')
    expect(statusOf(next.id)).toBe('active')

    const e = edge(next.id, old.id)
    expect(e).toBeTruthy()
    expect(e.detection_method).toBe('agent_declared')
  })

  it('no supersedes declared → nothing flipped, no edge, both stay active', () => {
    // same title on purpose: same-title alone must NOT trigger supersession
    // (that is how a series threads).
    const a = decision('thread', 'first')
    const b = decision('thread', 'second')

    expect(statusOf(a.id)).toBe('active')
    expect(statusOf(b.id)).toBe('active')
    expect(edge(b.id, a.id)).toBeUndefined()
  })

  it('supersedes multiple priors in a single write', () => {
    const a = decision('a', 'a')
    const b = decision('b', 'b')
    const merged = decision('merged', 'merged', { supersedes: [a.id, b.id] })

    expect(statusOf(a.id)).toBe('superseded')
    expect(statusOf(b.id)).toBe('superseded')
    expect(edge(merged.id, a.id)).toBeTruthy()
    expect(edge(merged.id, b.id)).toBeTruthy()
  })

  it('skips a non-existent supersedes id (no dangling edge)', () => {
    const r = decision('y', 'y', { supersedes: ['does-not-exist'] })
    expect(edge(r.id, 'does-not-exist')).toBeUndefined()
    expect(statusOf(r.id)).toBe('active')
  })

  it('extractSupersedesIds tolerates absent / malformed shapes', () => {
    expect(extractSupersedesIds(undefined)).toEqual([])
    expect(extractSupersedesIds({})).toEqual([])
    expect(extractSupersedesIds({ supersedes: 'not-an-array' })).toEqual([])
    expect(extractSupersedesIds({ supersedes: ['a', 2, '', 'b'] })).toEqual(['a', 'b'])
  })
})
