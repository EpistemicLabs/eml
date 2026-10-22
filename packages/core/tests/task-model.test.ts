import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, TASK_INACTIVITY_DAYS } from '../src'
import { validTask, validNote } from './fixtures'

// The task model (v0.15; v0.19: every change goes through trackTask): stage
// (optional maturity, frozen while closed), outcome on the transition into
// resolved/invalidated, part_of parent/child (tasks only, acyclic, one parent,
// close guard, supersede lists open children), the
// append-only journal (note + change entries), and the inactivity review.

describe('task model', () => {
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
  const close = (id: string, status: 'resolved' | 'invalidated' = 'resolved', outcome = 'ok') =>
    eml.engrams.trackTask(id, { status, outcome, text: 'closing', keep: [] })!
  const labels = (id: string): string[] => eml.engrams.get(id)!.labels ?? []
  /** Age a task: its last update and every entry (the creation entry counts as movement). */
  const age = (id: string, days: number) => {
    rawDb().prepare(`UPDATE engrams SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id)
    rawDb().prepare(`UPDATE entries SET at = ? WHERE engram_id = ?`).run(new Date(Date.now() - days * 86400_000).toISOString(), id)
  }
  const notes = (id: string) => eml.engrams.entries(id, ['note'])

  describe('stage', () => {
    it('accepts the four stages and rejects anything else, on create and on track', () => {
      for (const stage of ['ideation', 'planning', 'ready', 'implementation']) {
        expect(task(`s-${stage}`, { properties: { stage } }).properties).toMatchObject({ stage })
      }
      expect(() => task('bad', { properties: { stage: 'done' } }))
        .toThrow('Invalid engram: stage must be one of ideation, planning, ready, implementation.')
      const t = task('later')
      expect(() => eml.engrams.trackTask(t.id, { stage: 'planned', text: 'x' })).toThrow(/stage must be one of/)
    })

    it('is optional — a task without stage works as before', () => {
      const t = task('plain')
      expect(t.properties).toEqual({})
      expect(eml.engrams.trackTask(t.id, { status: 'active' })!.status).toBe('active')
    })

    it('filters via query({ stage })', () => {
      const a = task('a', { properties: { stage: 'planning' } })
      task('b', { properties: { stage: 'implementation' } })
      task('c')
      expect(eml.engrams.query({ type: 'task', stage: 'planning' }).map(e => e.id)).toEqual([a.id])
    })

    it('is frozen while the task is closed; reopening thaws it', () => {
      const t = task('frozen', { properties: { stage: 'implementation' } })
      close(t.id, 'invalidated', 'build abandoned')
      expect(() => eml.engrams.trackTask(t.id, { stage: 'planning', text: 'back' }))
        .toThrow('Invalid engram: stage is frozen while a task is closed — reopen it first.')
      expect(eml.engrams.trackTask(t.id, { content: 'reworded while closed', text: 'reworded' })).toBeTruthy()
      eml.engrams.trackTask(t.id, { status: 'planned', stage: 'planning', text: 'picked up again' })
      expect(propsOf(t.id).stage).toBe('planning')
    })
  })

  describe('outcome', () => {
    it('is required on the transition into resolved and invalidated', () => {
      const t = task('close-me', { status: 'active' })
      expect(() => eml.engrams.trackTask(t.id, { status: 'resolved', text: 'done' }))
        .toThrow('Invalid engram: closing a task needs an outcome — one line, shown in task lists.')
      expect(() => eml.engrams.trackTask(t.id, { status: 'invalidated', outcome: '  ', text: 'dropped' }))
        .toThrow(/needs an outcome/)
      expect(statusOf(t.id)).toBe('active')
      eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'deployed', text: 'shipped it' })
      expect(statusOf(t.id)).toBe('resolved')
    })

    it('a task is never created closed', () => {
      expect(() => eml.engrams.store(validTask({ status: 'resolved' })))
        .toThrow(/a task is created planned or active/)
      expect(() => eml.engrams.store(validTask({ properties: { outcome: 'x' } })))
        .toThrow(/outcome is set when the task closes/)
    })

    it('is not demanded by planned ↔ active', () => {
      const t = task('open')
      expect(eml.engrams.trackTask(t.id, { status: 'active' })!.status).toBe('active')
      expect(eml.engrams.trackTask(t.id, { status: 'planned' })!.status).toBe('planned')
    })

    it('a legacy closed task without outcome stays editable', () => {
      rawDb().prepare(
        `INSERT INTO engrams (id, type, scope, title, content, status, properties)
         VALUES ('legacy-task', 'task', 'project.eml', 'old', 'old task', 'resolved', '{}')`,
      ).run()
      rawDb().prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES ('legacy-task', 'old task', 'project.eml', 'old')`).run()
      expect(eml.engrams.trackTask('legacy-task', { content: 'old task, reworded', text: 'reworded' })!.content).toBe('old task, reworded')
      expect(eml.engrams.trackTask('legacy-task', { context: 'x' })).toBeTruthy()
      expect(eml.engrams.trackTask('legacy-task', { status: 'resolved', text: 'still' })!.status).toBe('resolved')  // no transition
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
      const note = eml.engrams.store(validNote({ content: 'a note' }))
      const before = count()
      expect(() => eml.engrams.store(validNote({ parent_id: parent.id })))
        .toThrow('Invalid engram: part_of needs two tasks.')
      expect(() => task('child', { parent_id: note.id })).toThrow('Invalid engram: part_of needs two tasks.')
      expect(() => task('child', { parent_id: 'no-such-id' })).toThrow('Invalid engram: part_of needs two tasks.')
      expect(count()).toBe(before)
    })

    it('trackTask(parent_id): tasks only, no cycles; re-parenting moves the edge, null clears it', () => {
      const a = task('a'); const b = task('b'); const c = task('c')
      const note = eml.engrams.store(validNote({ content: 'a note' }))
      expect(() => eml.engrams.trackTask(b.id, { parent_id: note.id })).toThrow('Invalid engram: part_of needs two tasks.')
      eml.engrams.trackTask(b.id, { parent_id: a.id })
      eml.engrams.trackTask(c.id, { parent_id: b.id })                       // a ← b ← c
      expect(() => eml.engrams.trackTask(a.id, { parent_id: c.id })).toThrow('Invalid engram: part_of would create a cycle.')
      expect(() => eml.engrams.trackTask(a.id, { parent_id: a.id })).toThrow('Invalid engram: part_of would create a cycle.')
      eml.engrams.trackTask(c.id, { parent_id: a.id })                       // re-parent: a ← c
      expect(edge(c.id, b.id)).toBeUndefined()
      expect(edge(c.id, a.id)).toBeTruthy()
      eml.engrams.trackTask(c.id, { parent_id: null })
      expect(edge(c.id, a.id)).toBeUndefined()
      expect(eml.engrams.entries(c.id, ['change']).map(e => e.text)).toContain(`parent ${b.id} → ${a.id}`)
    })

    it('relate() draws no part_of (it comes from parent_id)', () => {
      const a = task('a'); const b = task('b')
      expect(() => eml.engrams.relate({ source_id: b.id, target_id: a.id, relation: 'part_of', detection_method: 'manual' }))
        .toThrow(/part_of comes from a task's parent/)
    })

    it('a parent cannot be resolved while a sub-task is open (error lists them)', () => {
      const parent = task('parent', { status: 'active' })
      const open = task('open-child', { parent_id: parent.id })
      const done = task('done-child', { parent_id: parent.id })
      close(done.id)

      expect(() => close(parent.id, 'resolved', 'all done'))
        .toThrow(`Invalid engram: task ${parent.id} has open sub-tasks: ${open.id} open-child`)
      expect(statusOf(parent.id)).toBe('active')

      close(open.id)
      expect(close(parent.id, 'resolved', 'all done').status).toBe('resolved')
    })

    it('a parent cannot be invalidated while a sub-task is open either — close or move it first', () => {
      const parent = task('parent')
      const child = task('child', { parent_id: parent.id, status: 'active' })
      const moved = task('moved', { parent_id: parent.id })
      expect(() => close(parent.id, 'invalidated', 'dropped')).toThrow(`has open sub-tasks: ${child.id} child, ${moved.id} moved`)
      expect(statusOf(child.id)).toBe('active')
      close(child.id, 'invalidated', 'dropped')
      eml.engrams.trackTask(moved.id, { parent_id: null })
      expect(close(parent.id, 'invalidated', 'dropped').status).toBe('invalidated')
      expect(statusOf(moved.id)).toBe('planned')
    })

    it('superseding a parent (create_task supersedes) does not cascade — the open sub-tasks are listed', () => {
      const parent = task('parent')
      const child = task('child', { parent_id: parent.id })
      const successor = task('successor', { supersedes: [parent.id] })
      expect(statusOf(parent.id)).toBe('superseded')
      expect(statusOf(child.id)).toBe('planned')
      expect(successor.open_subtasks).toEqual([{ parent_id: parent.id, id: child.id, title: 'child' }])
      expect(() => eml.engrams.trackTask(parent.id, { status: 'active', text: 'again' })).toThrow(/superseded task stays superseded/)
    })

    it('no open_subtasks field when there is nothing to list', () => {
      const t = task('lonely')
      expect(task('next', { supersedes: [t.id] }).open_subtasks).toBeUndefined()
    })
  })

  describe('entries', () => {
    it('a text becomes a note entry with time, author and the current stage; get returns all oldest first', () => {
      const t = task('journal', { properties: { stage: 'planning' } })
      eml.engrams.trackTask(t.id, { text: 'first' }, 'assistant')
      eml.engrams.trackTask(t.id, { text: 'second' }, 'bob')
      eml.engrams.trackTask(t.id, { text: 'third' })

      const entries = eml.engrams.get(t.id)!.entries!
      expect(entries.map(e => `${e.kind}:${e.text}`)).toEqual(['change:created (planned · stage planning)', 'note:first', 'note:second', 'note:third'])
      expect(notes(t.id).map(e => e.author)).toEqual(['assistant', 'bob', null])
      expect(entries.every(e => e.stage === 'planning' && e.engram_id === t.id)).toBe(true)
      expect(Date.parse(entries[0].at)).not.toBeNaN()
    })

    it('a stage change needs text; it sets the stage and writes a change entry', () => {
      const t = task('stepper', { properties: { stage: 'implementation' } })
      expect(() => eml.engrams.trackTask(t.id, { stage: 'planning' })).toThrow('Invalid engram: a stage change needs text')
      const r = eml.engrams.trackTask(t.id, { text: 'plan did not hold', stage: 'planning' })!
      expect(propsOf(t.id).stage).toBe('planning')
      expect(r.entries_written!.map(e => `${e.kind}:${e.text}:${e.stage}`))
        .toEqual(['note:plan did not hold:planning', 'change:stage implementation → planning:planning'])
    })

    it('rejects a non-task, an empty call and an unknown stage; unknown id → null', () => {
      const note = eml.engrams.store(validNote({ content: 'a note' }))
      const t = task('t')
      expect(() => eml.engrams.trackTask(note.id, { text: 'x' })).toThrow(`Invalid engram: ${note.id} is a note, not a task — use eml_update.`)
      expect(() => eml.engrams.trackTask(t.id, { text: '  ' })).toThrow('Invalid engram: nothing to track')
      expect(() => eml.engrams.trackTask(t.id, { text: 'x', stage: 'done' })).toThrow(/stage must be one of/)
      expect(eml.engrams.trackTask('no-such-id', { text: 'x' })).toBeNull()
      expect(notes(t.id)).toEqual([])
    })

    it('a closed task takes notes but no stage change (frozen) — and writes nothing then', () => {
      const t = task('closed', { properties: { stage: 'implementation' } })
      close(t.id, 'resolved', 'deployed')
      eml.engrams.trackTask(t.id, { text: 'post-mortem note' })
      expect(notes(t.id).pop()!.stage).toBe('implementation')
      expect(() => eml.engrams.trackTask(t.id, { text: 'back to planning', stage: 'planning' })).toThrow(/frozen/)
      expect(notes(t.id).map(e => e.text)).toEqual(['closing', 'post-mortem note'])
    })

    it('update() does not touch a task; deleting a task deletes its entries', () => {
      const t = task('gone')
      expect(() => eml.engrams.update(t.id, { content: 'x' })).toThrow(/is a task — everything about a task goes through eml_track_task/)
      eml.engrams.trackTask(t.id, { text: 'x' })
      eml.engrams.delete(t.id)
      expect((rawDb().prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }).n).toBe(0)
    })
  })

  describe('inactivity review', () => {
    it(`stamps open tasks without movement for ${TASK_INACTIVITY_DAYS} days, not recent or closed ones`, () => {
      const stale = task('stale'); age(stale.id, TASK_INACTIVITY_DAYS + 1)
      const staleActive = task('stale-active', { status: 'active' }); age(staleActive.id, 90)
      const fresh = task('fresh'); age(fresh.id, TASK_INACTIVITY_DAYS - 1)
      const closed = task('closed'); close(closed.id); age(closed.id, 90)

      expect(eml.engrams.stampDueReviewLabels()).toBe(2)
      expect(labels(stale.id)).toContain('review')
      expect(labels(staleActive.id)).toContain('review')
      expect(labels(fresh.id)).not.toContain('review')
      expect(labels(closed.id)).not.toContain('review')
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)   // idempotent
    })

    it('a recent entry counts as movement even when updated_at is old', () => {
      const t = task('journaled')
      age(t.id, 60)
      eml.engrams.trackTask(t.id, { text: 'still on it' })
      rawDb().prepare(`UPDATE engrams SET updated_at = datetime('now', '-60 days') WHERE id = ?`).run(t.id)
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)

      rawDb().prepare(`UPDATE entries SET at = ? WHERE engram_id = ?`)
        .run(new Date(Date.now() - 45 * 86400_000).toISOString(), t.id)
      expect(eml.engrams.stampDueReviewLabels()).toBe(1)
    })

    it('any movement clears the label: a field change, a note, a confirm', () => {
      const ids = ['by-field', 'by-note', 'by-confirm'].map(s => { const t = task(s); age(t.id, 40); return t.id })
      eml.engrams.stampDueReviewLabels()
      expect(ids.every(id => labels(id).includes('review'))).toBe(true)

      eml.engrams.trackTask(ids[0], { priority: 'high' })
      eml.engrams.trackTask(ids[1], { text: 'picked up again' })
      eml.engrams.confirmReview(ids[2])
      expect(ids.map(labels)).toEqual([[], [], []])

      // a confirm is a movement: it stays clear on the next sweep
      expect(eml.engrams.stampDueReviewLabels()).toBe(0)
    })

    it('a flagged planned task shows up in the scope\'s pending reviews', () => {
      const t = task('parked'); age(t.id, 40)
      eml.engrams.stampDueReviewLabels()
      expect(eml.engrams.buildBrainState('project.eml').pending_reviews.map(e => e.id)).toContain(t.id)
    })
  })
})
