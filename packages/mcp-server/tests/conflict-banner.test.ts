import { describe, it, expect } from 'vitest'
import { conflictBanner, closedSubjectBanner, unresolvedLinksBanner, openSubtasksBanner, statusTracksBanner, boundItemsBanner, writeBanner, CONFLICT_ESCALATION_COVERAGE } from '../src/tools/_helpers'

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
    // v0.19: supersede after the fact is eml_update on the new engram
    expect(banner!).toContain('eml_update(<new id>, supersedes=[<old id>])')
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
    expect(b).toContain('eml_update_object(object=subject, status=active)')
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

// v0.15/v0.19: open sub-tasks of a superseded parent.
describe('openSubtasksBanner', () => {
  it('lists them and points to eml_track_task parent_id', () => {
    const b = openSubtasksBanner({ open_subtasks: [{ parent_id: 'p', id: 'c1', title: 'child' }] })!
    expect(b).toContain('child · c1')
    expect(b).toContain('eml_track_task(<sub-task id>, parent_id=<new task id>)')
    expect(openSubtasksBanner({})).toBeNull()
  })
})

// v0.19 set_status: the transition and status_tracks.
describe('statusTracksBanner', () => {
  it('is silent for other types', () => {
    expect(statusTracksBanner({ type: 'note' })).toBeNull()
  })

  it('shows the transition, the first status and an unchanged state', () => {
    expect(statusTracksBanner({ type: 'status', scope: 'global', previous_state: null, properties: { state: 'v1' } }))
      .toBe('status (first) → v1')
    expect(statusTracksBanner({ type: 'status', scope: 'global', previous_state: 'v1', properties: { state: 'v2' } }))
      .toBe('status v1 → v2')
    expect(statusTracksBanner({ type: 'status', scope: 'global', previous_state: 'v2', properties: { state: 'v2' } }))
      .toContain('(state unchanged)')
  })

  it('repeats status_tracks, or asks for it with the object and id', () => {
    const tracked = statusTracksBanner({ type: 'status', scope: 'project.eml', previous_state: 'a', properties: { state: 'b' }, status_tracks: 'schema' })!
    expect(tracked).toContain("this scope's status tracks: schema")
    const missing = statusTracksBanner({ type: 'status', scope: 'project.eml', previous_state: 'a', properties: { state: 'b' }, status_tracks: null, status_tracks_missing: true })!
    expect(missing).toContain('project.eml has no status_tracks yet')
    expect(missing).toContain('eml_update_object(object=project, id=eml, status_tracks=…)')
  })
})

// v0.19 track_task: bound decisions / notes on close and reopen.
describe('boundItemsBanner', () => {
  const item = (id: string, title: string | null = 'x') => ({ id, type: 'decision', title, status: 'active' })
  it('is silent without bound items', () => {
    expect(boundItemsBanner({})).toBeNull()
    expect(boundItemsBanner({ closed_with_task: [], kept: [] })).toBeNull()
  })

  it('lists closed, kept and reopen candidates', () => {
    const b = boundItemsBanner({ closed_with_task: [item('a', 'plan')], kept: [item('b', null)], reopen_candidates: [item('c')] })!
    expect(b).toContain('closed with the task:\n  • decision plan · a')
    expect(b).toContain('kept as standing:\n  • decision (no title) · b')
    expect(b).toContain('reactivate the ones that hold again with eml_update(id, status=active)')
  })

  it('writeBanner puts the status line first and bound items last', () => {
    const b = writeBanner({ type: 'status', scope: 'global', previous_state: null, properties: { state: 's' }, potential_conflicts: [cand(0.6)], closed_with_task: [item('a')] })!
    expect(b.indexOf('status (first)')).toBeLessThan(b.indexOf('possibly conflicting'))
    expect(b.indexOf('possibly conflicting')).toBeLessThan(b.indexOf('closed with the task'))
  })
})
