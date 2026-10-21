import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML } from '../src'
import { validDecision } from './fixtures'

// v0.13: a write that declares supersedes flips each prior engram to
// 'superseded' AND draws a 'supersedes' edge (new → old) — the status-type
// auto-supersede, generalised via the explicit declaration. v0.19: supersedes
// is a write parameter (was properties.supersedes), and an unknown id is an error.

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

  const decision = (title: string, content: string, supersedes?: string[]) =>
    eml.engrams.store(validDecision({ scope: 'project.eml', title, content, supersedes }))

  it('flips the prior engram AND draws the supersedes edge', () => {
    const old = decision('comm', 'v1')
    const next = decision('comm', 'v2', [old.id])

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
    const merged = decision('merged', 'merged', [a.id, b.id])

    expect(statusOf(a.id)).toBe('superseded')
    expect(statusOf(b.id)).toBe('superseded')
    expect(edge(merged.id, a.id)).toBeTruthy()
    expect(edge(merged.id, b.id)).toBeTruthy()
  })

  it('rejects a non-existent supersedes id and writes nothing (no dangling edge)', () => {
    expect(() => decision('y', 'y', ['does-not-exist'])).toThrow('Invalid engram: supersedes does-not-exist — no such engram.')
    expect(rawDb().prepare(`SELECT COUNT(*) AS n FROM engrams WHERE title = 'y'`).get().n).toBe(0)
    expect(rawDb().prepare(`SELECT COUNT(*) AS n FROM relations WHERE target_id = 'does-not-exist'`).get().n).toBe(0)
  })
})
