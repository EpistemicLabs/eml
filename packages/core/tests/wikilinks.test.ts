import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EML } from '../src'
import { extractWikilinkTargets } from '../src/engrams'
import { writes } from './fixtures'

// v0.14 Cluster C: `[[target]]` in content auto-materializes an idempotent
// related_to edge (detection_method 'agent_declared') to the resolved engram, on
// create AND update. Add-only: it never deletes edges. Unresolved targets are
// surfaced on the write response as `unresolved_links` and logged, never dropped.

describe('extractWikilinkTargets', () => {
  it('parses, dedups, trims, keeps order, drops empties and takes the pre-| target', () => {
    expect(extractWikilinkTargets('see [[foo]] and [[ bar ]] and [[foo]]')).toEqual(['foo', 'bar'])
    expect(extractWikilinkTargets('[[a-slug|Display Label]]')).toEqual(['a-slug'])
    expect(extractWikilinkTargets('nothing here')).toEqual([])
    expect(extractWikilinkTargets('[[]] [[   ]]')).toEqual([])
    expect(extractWikilinkTargets('multi\n[[x]]\nline [[y]]')).toEqual(['x', 'y'])
  })
})

describe('wikilink materialize on write (v0.14 Cluster C)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const relatedTo = (from: string, to: string): any =>
    rawDb().prepare(
      `SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'related_to'`,
    ).get(from, to)
  const note = (title: string, content: string) =>
    writes(eml).store({ type: 'note', scope: 'project.eml', title, content })

  it('resolves a [[title-slug]] on create → related_to edge (agent_declared)', () => {
    const target = note('the-target', 'target body')
    const src = note('the-source', 'points at [[the-target]] here')
    const e = relatedTo(src.id, target.id)
    expect(e).toBeTruthy()
    expect(e.detection_method).toBe('agent_declared')
    expect(src.unresolved_links).toBeUndefined()
  })

  it('resolves a [[id-prefix]] (≥8 chars) to the full id', () => {
    const target = note('by-id', 'target body')
    const src = note('src2', `see [[${target.id.slice(0, 12)}]]`)
    expect(relatedTo(src.id, target.id)).toBeTruthy()
  })

  it('surfaces unresolved links instead of dropping them, and draws no edge', () => {
    const src = note('src3', 'dangling [[does-not-exist]] link')
    expect(src.unresolved_links).toEqual(['does-not-exist'])
    expect(rawDb().prepare(`SELECT COUNT(*) c FROM relations WHERE source_id = ?`).get(src.id).c).toBe(0)
  })

  it('never links an engram to itself even if it names its own title', () => {
    const src = note('self-ref', 'I mention [[self-ref]]')
    expect(relatedTo(src.id, src.id)).toBeFalsy()
    expect(src.unresolved_links).toBeUndefined() // self is skipped, not "unresolved"
  })

  it('prefers the active engram when a title slug threads several', () => {
    const old = note('threaded', 'v1')
    writes(eml).update(old.id, { status: 'invalidated' })
    const active = note('threaded', 'v2')
    const src = note('src4', 'link to [[threaded]]')
    expect(relatedTo(src.id, active.id)).toBeTruthy()
    expect(relatedTo(src.id, old.id)).toBeFalsy()
  })

  it('is idempotent — the same link written twice yields one edge', () => {
    const t = note('once', 'body')
    const src = note('twice', 'link [[once]]')
    writes(eml).update(src.id, { content: 'link [[once]] again [[once]]' })
    expect(rawDb().prepare(
      `SELECT COUNT(*) c FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'related_to'`,
    ).get(src.id, t.id).c).toBe(1)
  })

  it('materializes a link ADDED on update (the operative gap)', () => {
    const t = note('added-later', 'body')
    const src = note('editme', 'no links yet')
    expect(relatedTo(src.id, t.id)).toBeFalsy()
    const upd = writes(eml).update(src.id, { content: 'now links [[added-later]]' })
    expect(relatedTo(src.id, t.id)).toBeTruthy()
    expect(upd!.unresolved_links).toBeUndefined()
  })

  it('is add-only: removing a link from content does NOT delete the edge', () => {
    const t = note('sticky', 'body')
    const src = note('editme2', 'links [[sticky]]')
    expect(relatedTo(src.id, t.id)).toBeTruthy()
    writes(eml).update(src.id, { content: 'link removed' })
    expect(relatedTo(src.id, t.id)).toBeTruthy() // still there
  })

  // v0.14 follow-ups (report items B/C/D)
  it('tags wikilink edges with metadata {source:"wikilink"} (distinct from manual eml_relate)', () => {
    const t = note('meta-target', 'body')
    const src = note('meta-src', 'link [[meta-target]]')
    const edge = relatedTo(src.id, t.id)
    expect(JSON.parse(edge.metadata)).toEqual({ source: 'wikilink' })
  })

  it('resolves wikilinks case-insensitively (title slugified, like tag/subject filters)', () => {
    const t = note('case-target', 'body')
    const src = note('case-src', 'see [[CASE-TARGET]] and [[Case-Target]]')
    expect(relatedTo(src.id, t.id)).toBeTruthy()
    expect(src.unresolved_links).toBeUndefined()
  })

  it('prefers the source engram\'s own scope on a cross-scope title collision', () => {
    writes(eml).projects.create({ id: 'other', name: 'Other' })
    const local = note('dup', 'in eml')                                   // scope project.eml
    const foreign = writes(eml).store({ type: 'note', scope: 'project.other', title: 'dup', content: 'in other' })
    const src = note('picks-local', 'link [[dup]]')                       // written in project.eml
    expect(relatedTo(src.id, local.id)).toBeTruthy()
    expect(relatedTo(src.id, foreign.id)).toBeFalsy()
  })

  it('warns on a cross-scope-ambiguous wikilink but still resolves (own scope first)', () => {
    writes(eml).projects.create({ id: 'other', name: 'Other' })
    note('amb', 'in eml')
    writes(eml).store({ type: 'note', scope: 'project.other', title: 'amb', content: 'in other' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    note('amb-src', 'link [[amb]]')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous wikilink [[amb]]'))
    warn.mockRestore()
  })
})

describe('wikilink edges are only the fallback (v0.17)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const edges = (from: string, to: string): string[] =>
    ((eml.engrams as any).db.prepare(
      `SELECT relation FROM relations WHERE source_id = ? AND target_id = ? ORDER BY relation`,
    ).all(from, to) as Array<{ relation: string }>).map(r => r.relation)
  const task = () => writes(eml).store({ type: 'task', scope: 'project.eml', title: 'the-task', content: 'do it' })

  it('a note with task_id and a [[link]] to the same task gets only the refines edge', () => {
    const t = task()
    const n = writes(eml).store({ type: 'note', scope: 'project.eml', title: 'plan', content: 'plan for [[the-task]]', task_id: t.id, properties: { binding: 'task' } })
    expect(edges(n.id, t.id)).toEqual(['refines'])
    expect(n.unresolved_links).toBeUndefined()
  })

  it('a typed edge drawn later replaces the wikilink related_to', () => {
    const t = task()
    const n = writes(eml).store({ type: 'note', scope: 'project.eml', title: 'thought', content: 'about [[the-task]]' })
    expect(edges(n.id, t.id)).toEqual(['related_to'])
    writes(eml).relate({ source_id: n.id, target_id: t.id, relation: 'supports', detection_method: 'agent_declared' })
    expect(edges(n.id, t.id)).toEqual(['supports'])
    // re-saving the content does not bring it back
    writes(eml).update(n.id, { content: 'still about [[the-task]]' })
    expect(edges(n.id, t.id)).toEqual(['supports'])
  })

  it('an explicitly drawn related_to stays next to a typed edge', () => {
    const t = task()
    const n = writes(eml).store({ type: 'note', scope: 'project.eml', title: 'plain', content: 'no link' })
    writes(eml).relate({ source_id: n.id, target_id: t.id, relation: 'related_to', detection_method: 'manual' })
    writes(eml).relate({ source_id: n.id, target_id: t.id, relation: 'supports', detection_method: 'manual' })
    expect(edges(n.id, t.id)).toEqual(['related_to', 'supports'])
  })
})
