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
    expect(banner!).not.toContain('high word overlap')
    expect(banner!).toContain('[decision]')
    expect(banner!).toContain('brand-and-domain')
    expect(banner!).toContain('abcdef12')              // id sliced to 8
    expect(banner!).toContain('60 % word overlap')
    // the resolve instruction reaches the agent at write time
    expect(banner!).toContain('supersede')
    expect(banner!).toContain('merge')
    expect(banner!).toContain('relate')
    expect(banner!).toContain('dismiss')
    // v0.19: supersede after the fact is eml_update on the new engram
    expect(banner!).toContain('eml_update(<new id>, supersedes=[<old id>])')
  })

  // v0.19: the resolve line follows the written type's lifecycle — the call it
  // proposes must be one the server accepts.
  it('proposes the supersede path of the written type: task → track_task, event → invalidate, status → none', () => {
    const task = conflictBanner({ type: 'task', potential_conflicts: [cand(0.6, { type: 'task' })] })!
    expect(task).toContain('eml_track_task(<new id>, supersedes=[<old id>])')
    expect(task).not.toContain('eml_update(<new id>, supersedes')
    const event = conflictBanner({ type: 'event', potential_conflicts: [cand(0.9, { type: 'event' })] })!
    expect(event).toContain('eml_update(<new id>, status=invalidated)')
    expect(event).not.toContain('supersede')
    const status = conflictBanner({ type: 'status', potential_conflicts: [cand(0.6)] })!
    expect(status).toContain('already superseded by this write')
    expect(status).not.toContain('supersedes=[')
    expect(status).not.toContain('merge (eml_update')
    // a task among the candidates of a note: not superseded by the note
    const note = conflictBanner({ type: 'note', potential_conflicts: [cand(0.6), cand(0.6, { id: '7a5c0000aaaa', type: 'task' })] })!
    expect(note).toContain('eml_update(<new id>, supersedes=[<old id>])')
    expect(note).toContain('7a5c0000: a task, not superseded by this write — close it with eml_track_task')
  })

  // v0.19 (second-session review): the proposal follows the candidate's type too.
  it('proposes no supersede the server would reject for the candidate', () => {
    // only a task among the candidates of a note: no supersede, no merge
    const onlyTask = conflictBanner({ type: 'note', potential_conflicts: [cand(0.6, { type: 'task' })] })!
    expect(onlyTask).not.toContain('supersedes=[')
    expect(onlyTask).not.toContain('merge (eml_update')
    // a status candidate under a decision write
    const dec = conflictBanner({ type: 'decision', potential_conflicts: [cand(0.9, { id: '5b64a5270000', type: 'status' })] })!
    expect(dec).not.toContain('supersedes=[')
    expect(dec).toContain('5b64a527: a status, replaced only by the next eml_set_status in its scope.')
    // a task write next to a decision and a task: track_task supersede for the task, the decision is named
    const task = conflictBanner({ type: 'task', potential_conflicts: [cand(0.8, { id: 'dddd00000000' }), cand(0.8, { id: 'tttt00000000', type: 'task' })] })!
    expect(task).toContain('eml_track_task(<new id>, supersedes=[<old id>])')
    expect(task).toContain('dddd0000: not replaced by a task')
    expect(task).not.toContain('eml_update content')
    // a task write with only a decision candidate: relate or dismiss
    const taskDec = conflictBanner({ type: 'task', potential_conflicts: [cand(0.8)] })!
    expect(taskDec).not.toContain('supersede')
    expect(taskDec).toContain('relate (eml_relate contradicts | related_to) / dismiss.')
  })

  it('escalates wording at/above the escalation threshold (high word overlap)', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(CONFLICT_ESCALATION_COVERAGE)] })
    expect(banner!).toContain('high word overlap')
    expect(banner!).not.toContain('(advisory)')
    // singular candidate → singular verb agreement ("engram … exists")
    expect(banner!).toMatch(/active engram with high word overlap exists —/)
  })

  it('uses the highest coverage to decide escalation across multiple candidates', () => {
    const banner = conflictBanner({ potential_conflicts: [cand(0.55), cand(0.9, { id: 'ffff0000ffff0000', title: 'brand-rename' })] })
    expect(banner!).toContain('high word overlap')
    // plural form when more than one candidate — noun + verb agree ("engrams … exist")
    expect(banner!).toMatch(/active engrams with high word overlap exist —/)
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
    expect(b).toContain('eml_update_object(object=subject, id=<subject id>, status=active)')
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

  it('reopen candidates that are sub-tasks get the track_task path', () => {
    const b = boundItemsBanner({ reopen_candidates: [item('c'), { id: 'd', type: 'task', title: 'child', status: 'invalidated' }] })!
    expect(b).toContain('reactivate the ones that hold again with eml_update(id, status=active):\n  • decision x · c')
    expect(b).toContain('reopen the ones that are still work with eml_track_task(id, status=planned, text):\n  • task child · d')
  })

  it('writeBanner puts the status line first and bound items last', () => {
    const b = writeBanner({ type: 'status', scope: 'global', previous_state: null, properties: { state: 's' }, potential_conflicts: [cand(0.6)], closed_with_task: [item('a')] })!
    expect(b.indexOf('status (first)')).toBeLessThan(b.indexOf('possibly conflicting'))
    expect(b.indexOf('possibly conflicting')).toBeLessThan(b.indexOf('closed with the task'))
  })
})
