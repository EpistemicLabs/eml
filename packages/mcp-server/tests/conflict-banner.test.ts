import { describe, it, expect } from 'vitest'
import { conflictBanner, closedSubjectBanner, unresolvedLinksBanner, writeBanner, CONFLICT_ESCALATION_COVERAGE } from '../src/tools/_helpers'

// v0.10.9 write-time conflict guardrail — rendering layer. conflictBanner turns the
// store response's advisory `potential_conflicts` into the banner prepended to the
// write-tool result, so the resolve instruction reaches the agent at write time.
// The core gate is tested in packages/core/tests/conflicts.test.ts; this locks the
// user-facing wording + confidence escalation that the gate's value depends on.

const cand = (over: number, extra: Partial<Record<string, unknown>> = {}) => ({
  id: 'abcdef1234567890',
  type: 'decision',
  title: 'brand-and-domain',
  gist: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
  coverage: over,
  ...extra,
})

describe('conflictBanner', () => {
  it('returns null when there is nothing to surface (absent / empty / null result)', () => {
    expect(conflictBanner({})).toBeNull()
    expect(conflictBanner({ potential_conflicts: [] })).toBeNull()
    expect(conflictBanner(null)).toBeNull()
    expect(conflictBanner(undefined)).toBeNull()
  })

  it('advisory wording below the escalation threshold; carries id/type/title/coverage + the resolve instruction', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(0.6)] })
    expect(banner).not.toBeNull()
    expect(banner!).toContain('(advisory)')
    expect(banner!).not.toContain('near-identical')
    expect(banner!).toContain('[decision]')
    expect(banner!).toContain('brand-and-domain')
    expect(banner!).toContain('abcdef12')              // id sliced to 8
    expect(banner!).toContain('coverage 0.6')
    // the resolve instruction reaches the agent at write time
    expect(banner!).toContain('supersede')
    expect(banner!).toContain('merge')
    expect(banner!).toContain('relate')
    expect(banner!).toContain('dismiss')
  })

  it('escalates wording at/above the escalation threshold (near-identical)', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(CONFLICT_ESCALATION_COVERAGE)] })
    expect(banner!).toContain('near-identical')
    expect(banner!).not.toContain('(advisory)')
    // singular candidate → singular verb agreement ("engram already exists")
    expect(banner!).toMatch(/active engram already exists —/)
  })

  it('uses the highest coverage to decide escalation across multiple candidates', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(0.55), cand(0.9, { id: 'ffff0000ffff0000', title: 'brand-rename' })] })
    expect(banner!).toContain('near-identical')
    // plural form when more than one candidate — noun + verb agree ("engrams already exist")
    expect(banner!).toMatch(/active engrams already exist —/)
    // both candidates listed
    expect(banner!).toContain('brand-and-domain')
    expect(banner!).toContain('brand-rename')
  })

  it('handles a null title gracefully', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(0.6, { title: null })] })
    expect(banner!).toContain('(no title)')
  })
})

// v0.14: filing into a closed subject is allowed but flagged (server `closed_subjects`).
describe('closedSubjectBanner / writeBanner', () => {
  it('is silent without closed_subjects', () => {
    expect(closedSubjectBanner({ subjects: ['trip'] })).toBeNull()
    expect(writeBanner({ subjects: [] })).toBeNull()
  })

  it('names the closed subjects and points at reopening', () => {
    const b = closedSubjectBanner({ closed_subjects: ['norway-trip'] })!
    expect(b).toContain('closed subject norway-trip')
    expect(b).toContain('eml_subject_update(status=active)')
  })

  it('writeBanner stacks the conflict banner first, then the closed-subject notice', () => {
    const b = writeBanner({ potential_conflicts: [cand(0.6)], closed_subjects: ['a', 'b'] })!
    expect(b.indexOf('possibly conflicting')).toBeLessThan(b.indexOf('closed subjects a, b'))
  })
})

// v0.14 Cluster C: unresolved [[wikilinks]] surfaced as a banner line.
describe('unresolvedLinksBanner', () => {
  it('is silent without unresolved_links', () => {
    expect(unresolvedLinksBanner({ subjects: [] })).toBeNull()
    expect(unresolvedLinksBanner({ unresolved_links: [] })).toBeNull()
  })

  it('names the unresolved links and says no edge was drawn', () => {
    const b = unresolvedLinksBanner({ unresolved_links: ['ghost', 'nope'] })!
    expect(b).toContain('[[ghost]] [[nope]]')
    expect(b).toContain('no edge drawn')
  })

  it('writeBanner appends unresolved links after conflicts + closed subjects', () => {
    const b = writeBanner({ potential_conflicts: [cand(0.6)], closed_subjects: ['a'], unresolved_links: ['x'] })!
    expect(b.indexOf('possibly conflicting')).toBeLessThan(b.indexOf('closed subject a'))
    expect(b.indexOf('closed subject a')).toBeLessThan(b.indexOf('unresolved wikilink'))
  })
})
