import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, TASK_INACTIVITY_DAYS } from '../src'
import { validTask } from './fixtures'

// v0.15 Cluster B — the task model: stage (optional maturity), outcome on the
// transition into resolved/invalidated, part_of parent/child (tasks only,
// acyclic, one parent, resolve guard, invalidate cascade, supersede lists open
// children), the append-only task_entries journal, and the inactivity review.

describe('task model (v0.15)', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    eml.projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => eml.close())

  const rawDb = (): any => (eml.engrams as any).db
  const statusOf = (id: string): string => eml.engrams.get(id)!.status
  const propsOf = (id: string): Record<string, unknown> => (eml.engrams.get(id)!.properties ?? {}) as Record<string, unknown>
  const task = (title: string, extra: Parameters<typeof validTask>[0] = {}) =>
    eml.engrams.store(validTask({ scope: 'project.eml', title, content: `task ${title}`, ...extra }))
  const labels = (id: string): string[] => eml.engrams.get(id)!.labels ?? []
  const age = (id: string, days: number) =>
    rawDb().prepare(`UPDATE engrams SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id)

  describe('stage', () => {
    it('accepts the four stages and rejects anything else, on create and update', () => {
      for (const stage of ['ideation', 'planning', 'ready', 'implementation']) {
        expect(task(`s-${stage}`, { properties: { stage } }).properties).toMatchObject({ stage })
      }
      expect(() => task('bad', { properties: { stage: 'done' } }))
        .toThrow('Invalid engram: stage must be one of ideation, planning, ready, implementation.')
      const t = task('later')
      expect(() => eml.engrams.update(t.id, { properties: { stage: 'planned' } })).toThrow(/stage must be one of/)
    })

    it('is optional — a task without stage behaves as before', () => {
      const t = task('plain')
      expect(t.properties).toBeNull()
      expect(eml.engrams.update(t.id, { status: 'active' })!.status).toBe('active')
    })

    it('filters via query({ stage })', () => {
      const a = task('a', { properties: { stage: 'planning' } })
      task('b', { properties: { stage: 'implementation' } })
      task('c')
      expect(eml.engrams.query({ type: 'task', stage: 'planning' }).map(e => e.id)).toEqual([a.id])
    })

    it('is frozen once the task is closed; reopening unfreezes it', () => {
      const t = task('frozen', { properties: { stage: 'implementation' } })
      eml.engrams.update(t.id, { status: 'invalidated', properties: { outcome: 'build abandoned' } })
      expect(() => eml.engrams.update(t.id, { properties: { stage: 'planning' } }))
        .toThrow('Invalid engram: stage is frozen once a task is closed.')
      expect(eml.engrams.update(t.id, { content: 'reworded while closed' })).toBeTruthy()
      eml.engrams.update(t.id, { status: 'planned', properties: { stage: 'planning' } })
      expect(propsOf(t.id).stage).toBe('planning')
    })
  })

  describe('outcome', () => {
    it('is required on the transition into resolved and invalidated', () => {
      const t = task('close-me', { status: 'active' })
      expect(() => eml.engrams.update(t.id, { status: 'resolved' }))
        .toThrow('Invalid engram: closing a task (resolved/invalidated) needs an outcome.')
      expect(() => eml.engrams.update(t.id, { status: 'invalidated', properties: { outcome: '  ' } }))
        .toThrow(/needs an outcome/)
      expect(statusOf(t.id)).toBe('active')
      eml.engrams.update(t.id, { status: 'resolved', properties: { outcome: 'deployed' } })
      expect(statusOf(t.id)).toBe('resolved')
    })

    it('is required when a task is created closed', () => {
      expect(() => eml.engrams.store({ type: 'task', scope: 'global', content: 'done already', status: 'resolved' }))
        .toThrow(/needs an outcome/)
    })

    it('is not demanded by planned/active/superseded', () => {
      const t = task('open')
      expect(eml.engrams.update(t.id, { status: 'active' })!.status).toBe('active')
      expect(eml.engrams.update(t.id, { status: 'superseded' })!.status).toBe('superseded')
    })

    it('a legacy closed task without outcome stays patchable', () => {
      rawDb().prepare(
        `INSERT INTO engrams (id, type, scope, title, content, status, properties)
         VALUES ('legacy-task', 'task', 'project.eml', 'old', 'old task', 'resolved', '{"resolution_note":"done"}')`,
      ).run()
      rawDb().prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES ('legacy-task', 'old task', 'project.eml', 'old')`).run()
      expect(eml.engrams.update('legacy-task', { content: 'old task, reworded' })!.content).toBe('old task, reworded')
      expect(eml.engrams.update('legacy-task', { properties: { context: 'x' } })).toBeTruthy()
      expect(eml.engrams.update('legacy-task', { status: 'resolved' })!.status).toBe('resolved')  // no transition
    })
  })

  describe('part_of', () => {
    const edge = (child: string, parent: string) =>
      rawDb().prepare(`SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND relation = 'part_of'`).get(child, parent)
    const count = () => (rawDb().prepare(`SELECT COUNT(*) AS n FROM engrams`).get() as { n: number }).n

    it('parent_id on store draws child → parent', () => {
      const parent = task('parent')
      const child = task('child', { parent_id: parent.id })
      expect(edge(child.id, parent.id)).toBeTruthy()
    })

    it('rejects a non-task child, a non-task or unknown parent — and leaves no orphan', () => {
      const parent = task('parent')
      const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'a note' })
      const before = count()
      expect(() => eml.engrams.store({ type: 'note', scope: 'global', content: 'n', parent_id: parent.id }))
        .toThrow('Invalid engram: part_of needs two tasks.')
      expect(() => task('child', { parent_id: note.id })).toThrow('Invalid engram: part_of needs two tasks.')
      expect(() => task('child', { parent_id: 'no-such-id' })).toThrow('Invalid engram: part_of needs two tasks.')
      expect(count()).toBe(before)
    })

    it('relate(): tasks only, no cycles, one parent; re-relating the same pair is idempotent', () => {
      const a = task('a'); const b = task('b'); const c = task('c')
      const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'a note' })
      const rel = (s: string, t: string) => eml.engrams.relate({ source_id: s, target_id: t, relation: 'part_of', detection_method: 'manual' })

      expect(() => rel(note.id, a.id)).toThrow('Invalid engram: part_of needs two tasks.')
      expect(rel(b.id, a.id)).toBe(true)
      expect(rel(b.id, a.id)).toBe(false)
      expect(() => rel(b.id, c.id)).toThrow(`Invalid engram: task ${b.id} already has a parent.`)
      expect(rel(c.id, b.id)).toBe(true)                                     // a ← b ← c
      expect(() => rel(a.id, c.id)).toThrow('Invalid engram: part_of would create a cycle.')
      expect(() => rel(a.id, a.id)).toThrow('Invalid engram: part_of would create a cycle.')
    })

    it('a parent cannot be resolved while a sub-task is open (error lists them)', () => {
      const parent = task('parent', { status: 'active' })
      const open = task('open-child', { parent_id: parent.id })
      const done = task('done-child', { parent_id: parent.id })
      eml.engrams.update(done.id, { status: 'resolved', properties: { outcome: 'ok' } })

      expect(() => eml.engrams.update(parent.id, { status: 'resolved', properties: { outcome: 'all done' } }))
        .toThrow(`Invalid engram: task ${parent.id} has open sub-tasks: ${open.id} open-child`)
      expect(statusOf(parent.id)).toBe('active')

      eml.engrams.update(open.id, { status: 'resolved', properties: { outcome: 'ok' } })
      expect(eml.engrams.update(parent.id, { status: 'resolved', properties: { outcome: 'all done' } })!.status).toBe('resolved')
    })

    it('invalidating a parent invalidates its open sub-tasks, grandchildren included', () => {
      const parent = task('parent')
      const child = task('child', { parent_id: parent.id, status: 'active' })
      const grandchild = task('grandchild', { parent_id: child.id })
      const closed = task('closed-child', { parent_id: parent.id })
      eml.engrams.update(closed.id, { status: 'resolved', properties: { outcome: 'shipped' } })

      eml.engrams.update(parent.id, { status: 'invalidated', properties: { outcome: 'dropped' } })

      for (const id of [child.id, grandchild.id]) {
        expect(statusOf(id)).toBe('invalidated')
        expect(propsOf(id).outcome).toBe('parent invalidated')
      }
      expect(statusOf(closed.id)).toBe('resolved')
      expect(propsOf(closed.id).outcome).toBe('shipped')
    })

    it('superseding a parent does not cascade — the open sub-tasks are listed', () => {
      const parent = task('parent')
      const child = task('child', { parent_id: parent.id })
      const res = eml.engrams.update(parent.id, { status: 'superseded' })!
      expect(statusOf(child.id)).toBe('planned')
      expect(res.open_subtasks).toEqual([{ parent_id: parent.id, id: child.id, title: 'child' }])

      const parent2 = task('parent2')
      const child2 = task('child2', { parent_id: parent2.id })
      const successor = task('successor', { properties: { supersedes: [parent2.id] } })
      expect(statusOf(parent2.id)).toBe('superseded')
      expect(statusOf(child2.id)).toBe('planned')
      expect(successor.open_subtasks).toEqual([{ parent_id: parent2.id, id: child2.id, title: 'child2' }])
    })

    it('no open_subtasks field when there is nothing to list', () => {
      const t = task('lonely')
      expect(eml.engrams.update(t.id, { status: 'superseded' })!.open_subtasks).toBeUndefined()
    })
  })

  describe('entries', () => {
    it('appends in order with time, author and the current stage; get returns them oldest first', () => {
      const t = task('journal', { properties: { stage: 'planning' } })
      eml.engrams.appendTaskEntry(t.id, { text: 'first' }, 'assistant')
      eml.engrams.appendTaskEntry(t.id, { text: 'second' }, 'bob')
      eml.engrams.appendTaskEntry(t.id, { text: 'third' })

      const entries = eml.engrams.get(t.id)!.entries!
      expect(entries.map(e => e.text)).toEqual(['first', 'second', 'third'])
      expect(entries.map(e => e.author)).toEqual(['assistant', 'bob', null])
      expect(entries.every(e => e.stage === 'planning' && e.task_id === t.id)).toBe(true)
      expect(Date.parse(entries[0].at)).not.toBeNaN()
    })

    it('a stage on the entry sets the task stage and is recorded', () => {
      const t = task('stepper', { properties: { stage: 'implementation' } })
      const e = eml.engrams.appendTaskEntry(t.id, { text: 'plan did not hold', stage: 'planning' })!
      expect(e.stage).toBe('planning')
      expect(propsOf(t.id).stage).toBe('planning')
    })

    it('rejects a non-task, blank text and an unknown stage; unknown id → null', () => {
      const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'a note' })
      const t = task('t')
      expect(() => eml.engrams.appendTaskEntry(note.id, { text: 'x' })).toThrow(`Invalid engram: task_id ${note.id} is not a task.`)
      expect(() => eml.engrams.appendTaskEntry(t.id, { text: '  ' })).toThrow('Invalid engram: a task entry needs text.')
      expect(() => eml.engrams.appendTaskEntry(t.id, { text: 'x', stage: 'done' })).toThrow(/stage must be one of/)
      expect(eml.engrams.appendTaskEntry('no-such-id', { text: 'x' })).toBeNull()
      expect(eml.engrams.get(t.id)!.entries).toEqual([])
    })

    it('a closed task takes entries but no stage change (frozen) — and writes nothing then', () => {
      const t = task('closed', { properties: { stage: 'implementation' } })
      eml.engrams.update(t.id, { status: 'resolved', properties: { outcome: 'deployed' } })
      expect(eml.engrams.appendTaskEntry(t.id, { text: 'post-mortem note' })!.stage).toBe('implementation')
      expect(() => eml.engrams.appendTaskEntry(t.id, { text: 'back to planning', stage: 'planning' })).toThrow(/frozen/)
      expect(eml.engrams.get(t.id)!.entries!.map(e => e.text)).toEqual(['post-mortem note'])
    })

    it('only tasks carry entries on get; deleting a task deletes its entries', () => {
      const note = eml.engrams.store({ type: 'note', scope: 'global', content: 'a note' })
      expect(eml.engrams.get(note.id)!.entries).toBeUndefined()
      const t = task('gone')
      eml.engrams.appendTaskEntry(t.id, { text: 'x' })
      eml.engrams.delete(t.id)
      expect((rawDb().prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }).n).toBe(0)
    })
  })

  describe('inactivity review', () => {
    it(`stamps open tasks without movement for ${TASK_INACTIVITY_DAYS} days, not recent or closed ones`, () => {
      const stale = task('stale'); age(stale.id, TASK_INACTIVITY_DAYS + 1)
      const staleActive = task('stale-active', { status: 'active' }); age(staleActive.id, 90)
      const fresh = task('fresh'); age(fresh.id, TASK_INACTIVITY_DAYS - 1)
      const closed = task('closed', { status: 'resolved' }); age(closed.id, 90)

      expect(eml.engrams.stampDueReviewLabels()).toBe(2)
      expect(labels(stale.id)).toContain('review')
      expect(labels(staleActive.id)).toContain('review')
      expect(labels(fresh.id)).not.toContain('review')
      expect(labels(closed.id)).not.toContain('review')
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)   // idempotent
    })

    it('a recent entry counts as movement even when updated_at is old', () => {
      const t = task('journaled')
      eml.engrams.appendTaskEntry(t.id, { text: 'still on it' })
      age(t.id, 60)
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)

      rawDb().prepare(`UPDATE entries SET at = ? WHERE engram_id = ?`)
        .run(new Date(Date.now() - 45 * 86400_000).toISOString(), t.id)
      expect(eml.engrams.stampDueReviewLabels()).toBe(1)
    })

    it('any movement clears the label: patch, entry, confirm', () => {
      const ids = ['by-patch', 'by-entry', 'by-confirm'].map(s => { const t = task(s); age(t.id, 40); return t.id })
      eml.engrams.stampDueReviewLabels()
      expect(ids.every(id => labels(id).includes('review'))).toBe(true)

      eml.engrams.update(ids[0], { properties: { priority: 'high' } })
      eml.engrams.appendTaskEntry(ids[1], { text: 'picked up again' })
      eml.engrams.confirmReview(ids[2])
      expect(ids.map(labels)).toEqual([[], [], []])

      // confirm is a movement: it stays clear on the next sweep
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)
    })

    it('a flagged planned task shows up in the scope\'s pending reviews', () => {
      const t = task('parked'); age(t.id, 40)
      eml.engrams.stampDueReviewLabels()
      expect(eml.engrams.buildBrainState('project.eml').pending_reviews.map(e => e.id)).toContain(t.id)
    })
  })
})
