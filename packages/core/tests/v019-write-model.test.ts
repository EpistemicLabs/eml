import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EML, UPGRADE_HINT, readObject, createObject, updateObject, type WriteContext } from '../src'
import { seedDefaultBrain } from '../src/default-brain'
import {
  validDecision, validTask, validNote, validEvent, validLog, validReference, validRule, validProfile, validStatus,
} from './fixtures'

// v0.19 — the write model behind the 22-tool surface: strict fields per type,
// the task lifecycle (trackTask), binding, supersede after the fact (B1), core
// profiles, reviews as entries, set_status versions, one log per session,
// learnings with evidence and ripeness, objects, expiry, the event duplicate scan.

describe('v0.19 write model', () => {
  let eml: EML
  const ctx = (session = 's1', caller = 'juno'): WriteContext =>
    ({ caller, session_id: session, model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp' })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.agents.store({ id: 'juno', name: 'Juno' })
    eml.users.create({ id: 'ada', name: 'Ada' })
    eml.projects.create({ id: 'p', name: 'P' })
  })
  afterEach(() => { vi.useRealTimers(); eml.close() })

  const rawDb = (): any => (eml.engrams as any).db
  const statusOf = (id: string) => eml.engrams.get(id)!.status
  const propsOf = (id: string) => (eml.engrams.get(id)!.properties ?? {}) as Record<string, unknown>
  const edge = (from: string, to: string, rel: string) =>
    rawDb().prepare('SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?').get(from, to, rel)

  describe('strict fields', () => {
    it('rejects unknown fields, naming the allowed ones; removed keys get the upgrade hint', () => {
      let msg = ''
      try { eml.engrams.store({ ...validDecision(), significance: 'high' } as any) } catch (e) { msg = (e as Error).message }
      expect(msg).toMatch(/^Invalid engram: unknown field significance for a decision\. Allowed: content, scope, title, /)
      expect(msg).toContain('rationale, alternatives, binding, review_due_at, detail.')
      expect(msg).toContain(UPGRADE_HINT)
      expect(msg).not.toMatch(/Allowed:.*\bstatus\b/)

      expect(() => eml.engrams.store(validNote({ properties: { source_id: 'x' } })))
        .toThrow(/unknown field source_id for a note\. Allowed: binding, detail\. This client predates/)
      let plain = ''
      try { eml.engrams.store(validNote({ properties: { colour: 'red' } })) } catch (e) { plain = (e as Error).message }
      expect(plain).toBe('Invalid engram: unknown field colour for a note. Allowed: binding, detail.')
    })

    it('checks field kinds and enums', () => {
      expect(() => eml.engrams.store(validEvent({ properties: { change_type: 'launched' } }))).toThrow(/change_type must be one of created, started/)
      expect(() => eml.engrams.store(validEvent({ properties: { occurred_at: 'yesterday' } }))).toThrow(/occurred_at must be an ISO date/)
      expect(() => eml.engrams.store(validRule({ properties: { rule_type: 'guideline' } }))).toThrow(/rule_type must be one of/)
      expect(() => eml.engrams.store(validStatus({ properties: { blockers: 'one' } }))).toThrow(/blockers must be a list of text/)
      expect(() => eml.engrams.store(validProfile({ properties: { core: 'yes' } }))).toThrow(/core must be true or false/)
    })

    it('every type needs its required fields; a rule needs why and agreed', () => {
      expect(() => eml.engrams.store({ type: 'rule', scope: 'global', title: 'r', content: 'Do X.', properties: { applies: 'always' } }))
        .toThrow('Invalid engram: a rule needs why. a rule needs agreed.')
      expect(() => eml.engrams.store({ type: 'reference', scope: 'global', title: 'r', content: 'x' })).toThrow('a reference needs source.')
      expect(() => eml.engrams.store({ type: 'log', scope: 'global', title: 'l', content: 'x' })).toThrow('a log needs what.')
    })

    it('stamps provenance from the context, never from input', () => {
      const n = eml.engrams.store(validNote(), ctx())
      expect(n).toMatchObject({ ingested_by: 'juno', session_id: 's1', model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp', origin: null })
      expect(() => eml.engrams.store({ ...validNote(), session_id: 'forged' } as any)).toThrow(/unknown field session_id/)
    })

    it('a learning is written by learn(), not store()', () => {
      expect(() => eml.engrams.store({ type: 'learning', scope: 'user.ada', title: 'l', content: 'x' }))
        .toThrow(/a learning is written with eml_learning/)
    })
  })

  describe('titles, origin and status on create', () => {
    it('a status has no title; every other type needs one; a note with an origin may omit it', () => {
      expect(() => eml.engrams.store(validStatus({ title: 'x' }))).toThrow(/a status has no title/)
      expect(() => eml.engrams.store(validNote({ title: undefined }))).toThrow('Invalid engram: a note needs a title')
      expect(() => eml.engrams.store(validEvent({ title: '  ' }))).toThrow('Invalid engram: an event needs a title')
      const pane = eml.engrams.store({ type: 'note', scope: 'project.p', content: 'pane note', origin: 'cockpit-notes', app: { user_content_hash: 'h' } })
      expect(pane.title).toBeNull()
      expect(pane.origin).toBe('cockpit-notes')
      expect(pane.properties).toEqual({ app: { user_content_hash: 'h' } })
    })

    it('origin must be known; app state needs an origin and is a flat text map', () => {
      expect(() => eml.engrams.store(validNote({ origin: 'my-app' }))).toThrow(/origin must be one of cockpit-notes/)
      expect(() => eml.engrams.store(validNote({ app: { a: 'b' } }))).toThrow(/app state needs an origin/)
      expect(() => eml.engrams.store(validNote({ origin: 'cockpit-notes', app: { a: 1 } as any }))).toThrow(/app must be a flat map of text values/)
    })

    it('a task starts planned or active with a change entry; closed or with outcome is rejected', () => {
      const t = eml.engrams.store(validTask({ status: 'active', properties: { stage: 'ready' } }), ctx())
      expect(t.status).toBe('active')
      expect(eml.engrams.entries(t.id)).toMatchObject([{ kind: 'change', text: 'created (active · stage ready)', author: 'juno', session_id: 's1', model: 'test-model' }])
      expect(eml.engrams.entries(eml.engrams.store(validTask()).id)[0].text).toBe('created (planned)')
      expect(() => eml.engrams.store(validTask({ status: 'invalidated' }))).toThrow(/done things are not tasks/)
      expect(() => eml.engrams.store(validNote({ status: 'active' }))).toThrow(/status is not set on create/)
    })

    it('a profile is about someone: agent, user or entity scopes only', () => {
      expect(() => eml.engrams.store(validProfile({ scope: 'global' }))).toThrow(/a profile is about someone/)
      expect(() => eml.engrams.store(validProfile({ scope: 'project.p' }))).toThrow(/a profile is about someone/)
      expect(eml.engrams.store(validProfile({ scope: 'agent.juno' })).type).toBe('profile')
    })
  })

  describe('task lifecycle (trackTask)', () => {
    const hub = () => eml.engrams.store(validTask({ scope: 'project.p', title: 'hub', status: 'active' }), ctx())
    const bound = (taskId: string, type: 'decision' | 'note', title: string, binding: 'task' | 'standing' = 'task') =>
      eml.engrams.store((type === 'decision' ? validDecision : validNote)({ scope: 'project.p', title, task_id: taskId, properties: { binding } }), ctx())

    it('closing with bound items and no keep errors with their list and changes nothing', () => {
      const t = hub()
      const d = bound(t.id, 'decision', 'approach')
      const n = bound(t.id, 'note', 'plan')
      bound(t.id, 'decision', 'architecture', 'standing')
      expect(() => eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'done', text: 'shipped' }))
        .toThrow(`Invalid engram: 2 items are bound to this task and close with it: decision approach (${d.id}); note plan (${n.id}). Pass keep=[ids]`)
      expect(statusOf(t.id)).toBe('active')
      expect(eml.engrams.get(t.id)!.bound!.map(b => b.title)).toEqual(['approach', 'plan'])
    })

    it('keep=[ids] makes those standing; the rest close: a decision follows the task, a note is invalidated', () => {
      const t = hub()
      const keepMe = bound(t.id, 'decision', 'keep-me')
      const closeMe = bound(t.id, 'decision', 'close-me')
      const plan = bound(t.id, 'note', 'plan')
      const r = eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'done', text: 'shipped; keep-me holds beyond it', keep: [keepMe.id] }, ctx())!
      expect(r.status).toBe('resolved')
      expect(r.kept!.map(b => b.id)).toEqual([keepMe.id])
      expect(r.closed_with_task!.map(b => `${b.title}:${b.status}`)).toEqual(['close-me:resolved', 'plan:invalidated'])
      expect(propsOf(keepMe.id).binding).toBe('standing')
      expect(statusOf(keepMe.id)).toBe('active')
      expect(statusOf(closeMe.id)).toBe('resolved')
      expect(statusOf(plan.id)).toBe('invalidated')
      expect(eml.engrams.entries(t.id).slice(-5).map(e => `${e.kind}:${e.text}`)).toEqual([
        'note:shipped; keep-me holds beyond it',
        'change:resolved: done',
        `change:kept as standing: decision keep-me (${keepMe.id})`,
        `change:closed with the task: decision close-me (${closeMe.id})`,
        `change:closed with the task: note plan (${plan.id})`,
      ])
    })

    // Known gap (reported): entries_written lists the note and the status change,
    // but not the change entries closeBoundItems writes for kept / closed items.
    it('entries_written also lists the entries for kept and closed bound items', () => {
      const t = hub()
      const d = bound(t.id, 'decision', 'approach')
      const r = eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'done', text: 'shipped', keep: [d.id] })!
      expect(r.entries_written!.map(e => e.text)).toContain(`kept as standing: decision approach (${d.id})`)
    })

    it('an invalidated task invalidates its bound decisions; keep must name bound items', () => {
      const t = hub()
      const d = bound(t.id, 'decision', 'approach')
      expect(() => eml.engrams.trackTask(t.id, { status: 'invalidated', outcome: 'dropped', text: 'no', keep: ['other'] }))
        .toThrow('Invalid engram: keep other — not bound to this task.')
      eml.engrams.trackTask(t.id, { status: 'invalidated', outcome: 'dropped', text: 'no', keep: [] })
      expect(statusOf(d.id)).toBe('invalidated')
    })

    it('reopening needs text, clears the outcome and lists the items that closed with the task', () => {
      const t = hub()
      const d = bound(t.id, 'decision', 'approach')
      eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'done', text: 'shipped', keep: [] })
      expect(() => eml.engrams.trackTask(t.id, { status: 'active' })).toThrow('Invalid engram: reopening needs text')
      const r = eml.engrams.trackTask(t.id, { status: 'active', text: 'a bug came back' })!
      expect(r.properties!.outcome).toBeUndefined()
      expect(r.reopen_candidates!.map(b => b.id)).toEqual([d.id])
      expect(eml.engrams.entries(t.id, ['change']).pop()!.text).toBe('reopened (active)')
      // reactivate one by hand
      expect(eml.engrams.update(d.id, { status: 'active' })!.status).toBe('active')
    })

    it('text is required for closing, a stage change and a content rewrite; optional for attributes and planned ↔ active', () => {
      const t = hub()
      expect(() => eml.engrams.trackTask(t.id, { status: 'resolved', outcome: 'x', keep: [] })).toThrow('Invalid engram: closing needs text')
      expect(() => eml.engrams.trackTask(t.id, { stage: 'ready' })).toThrow('Invalid engram: a stage change needs text')
      expect(() => eml.engrams.trackTask(t.id, { content: 'new definition' })).toThrow('Invalid engram: a content rewrite needs text')
      const r = eml.engrams.trackTask(t.id, { priority: 'high', assignee_id: 'ada', blockers: ['waiting on X'], status: 'planned' })!
      expect(r.entries_written!.map(e => e.text)).toEqual([
        'status active → planned', 'priority none → high', 'assignee_id none → ada', 'blockers none → waiting on X',
      ])
      expect(eml.engrams.trackTask(t.id, { assignee_id: null })!.properties!.assignee_id).toBeUndefined()
    })

    it('outcome only on close; keep only on close; unknown fields error', () => {
      const t = hub()
      expect(() => eml.engrams.trackTask(t.id, { outcome: 'x', text: 'y' })).toThrow(/outcome is set when the task closes/)
      expect(() => eml.engrams.trackTask(t.id, { keep: [], text: 'y' })).toThrow(/keep is only for closing/)
      expect(() => eml.engrams.trackTask(t.id, { significance: 'high' } as any)).toThrow(/unknown field significance for a task/)
      expect(() => eml.engrams.trackTask(t.id, { status: 'superseded', text: 'x' })).toThrow(/planned, active, resolved or invalidated/)
    })

    it('a task superseded by create_task hands its bound items to the successor', () => {
      const old = hub()
      const d = bound(old.id, 'decision', 'approach')
      const next = eml.engrams.store(validTask({ scope: 'project.p', title: 'hub-2', supersedes: [old.id] }), ctx())
      expect(statusOf(old.id)).toBe('superseded')
      expect(edge(d.id, next.id, 'derived_from')).toBeTruthy()
      expect(edge(d.id, old.id, 'derived_from')).toBeFalsy()
      expect(eml.engrams.get(next.id)!.bound!.map(b => b.id)).toEqual([d.id])
      expect(eml.engrams.entries(next.id, ['change']).map(e => e.text)).toContain(`decision moved here from ${old.id}: approach (${d.id})`)
    })

    // Known gap (reported): store() writes the "moved here" entries before the
    // task's own "created" entry, so the successor's journal does not start at birth.
    it('the successor\'s journal starts with its creation entry', () => {
      const old = hub()
      bound(old.id, 'decision', 'approach')
      const next = eml.engrams.store(validTask({ scope: 'project.p', title: 'hub-2', supersedes: [old.id] }))
      expect(eml.engrams.entries(next.id)[0].text).toBe('created (planned)')
    })
  })

  describe('update (eml_update)', () => {
    it('rejects tasks and type changes', () => {
      const t = eml.engrams.store(validTask())
      expect(() => eml.engrams.update(t.id, { content: 'x' })).toThrow(/is a task — everything about a task goes through eml_track_task/)
      const n = eml.engrams.store(validNote())
      expect(() => eml.engrams.update(n.id, { type: 'reference' } as any)).toThrow(/the type of an engram does not change/)
      expect(eml.engrams.update('nope', { content: 'x' })).toBeNull()
    })

    it('status: invalidated or active (reactivation); superseded and expired are not settable', () => {
      const n = eml.engrams.store(validNote())
      expect(() => eml.engrams.update(n.id, { status: 'superseded' })).toThrow(/Superseded comes from supersedes/)
      expect(() => eml.engrams.update(n.id, { status: 'resolved' })).toThrow(/invalidated or active/)
      expect(() => eml.engrams.update(n.id, { status: 'expired' as any })).toThrow(/invalidated or active/)
      expect(eml.engrams.update(n.id, { status: 'invalidated' })!.status).toBe('invalidated')
      expect(eml.engrams.update(n.id, { status: 'active' })!.status).toBe('active')
      const next = eml.engrams.store(validNote({ supersedes: [n.id] }))
      expect(next.superseded).toEqual([n.id])
      expect(() => eml.engrams.update(n.id, { status: 'active' })).toThrow(/reactivated only once its successor is invalidated/)
      // undo of a refile: invalidate the successor, then the old one comes back
      eml.engrams.update(next.id, { status: 'invalidated' })
      expect(eml.engrams.update(n.id, { status: 'active' })!.status).toBe('active')
    })

    it('a status takes only status=invalidated, tags and subjects', () => {
      const s = eml.engrams.store(validStatus({ scope: 'project.p' }))
      expect(() => eml.engrams.update(s.id, { content: 'x' })).toThrow(/a status only takes status=invalidated, tags and subjects/)
      expect(() => eml.engrams.update(s.id, { status: 'active' })).toThrow(/a status only takes/)
      expect(eml.engrams.update(s.id, { status: 'invalidated' })!.status).toBe('invalidated')
    })

    it('an event is correctable but never superseded', () => {
      const ev = eml.engrams.store(validEvent({ title: 'release' }))
      const r = eml.engrams.update(ev.id, { content: 'released, corrected', properties: { change_type: 'released', detail: 'sha abc' } })!
      expect(r.content).toBe('released, corrected')
      expect(r.diff).toMatchObject({ change_type: ['completed', 'released'], detail: [null, 'sha abc'] })
      expect(() => eml.engrams.store(validNote({ supersedes: [ev.id] }))).toThrow(/is an event — an event is corrected, never superseded/)
      expect(() => eml.engrams.update(ev.id, { supersedes: [eml.engrams.store(validNote()).id] })).toThrow(/an event does not supersede/)
    })

    it('a log\'s START HERE fields and content are correctable from any session; a correction from another session is noted', () => {
      const log = eml.engrams.store(validLog({ content: 'the story' }), ctx('s1'))
      const r = eml.engrams.update(log.id, { properties: { next: 'next step 2' } }, ctx('s1'))!
      expect(r.content).toContain('**NEXT:** next step 2')
      expect(r.content.endsWith('the story')).toBe(true)
      expect(eml.engrams.entries(log.id)).toEqual([])
      const other = eml.engrams.update(log.id, { properties: { landed: 'x' } }, ctx('s2'))!
      expect(other.content).toContain('**WHERE WE LANDED:** x')
      expect(eml.engrams.entries(log.id)).toMatchObject([{ kind: 'change', text: 'landed corrected from session s2', session_id: 's2' }])
      const fixed = eml.engrams.update(log.id, { content: 'the corrected story' }, ctx('s2'))!
      expect(fixed.content).toContain('**NEXT:** next step 2')
      expect(fixed.content.endsWith('the corrected story')).toBe(true)
    })

    it('null clears an optional field, a required one cannot be cleared; the response carries the diff', () => {
      const d = eml.engrams.store(validDecision({ properties: { detail: 'more', review_due_at: '2030-01-01' } }))
      const r = eml.engrams.update(d.id, { properties: { detail: null } })!
      expect(r.properties!.detail).toBeUndefined()
      expect(r.diff).toMatchObject({ detail: ['more', null] })
      expect(() => eml.engrams.update(d.id, { properties: { rationale: null } })).toThrow(/rationale is required and cannot be cleared/)
      expect(() => eml.engrams.update(d.id, { properties: { why: 'x' } })).toThrow(/unknown field why for a decision/)
    })

    it('binding task needs a task link', () => {
      const d = eml.engrams.store(validDecision())
      expect(() => eml.engrams.update(d.id, { properties: { binding: 'task' } })).toThrow(/binding task needs a task/)
    })

    it('a learning takes content, title, status, tags and subjects; sharpening its content writes a change entry', () => {
      const l = eml.engrams.learn({ scope: 'user.ada', title: 'ask-first', content: 'Ask first.', source: 'self', happened: 'did not ask' }, ctx())
      if (!l.written) throw new Error('not written')
      expect(() => eml.engrams.update(l.engram.id, { properties: { detail: 'x' } })).toThrow(/a learning takes content, title, status, tags, subjects and supersedes/)
      expect(() => eml.engrams.update(l.engram.id, { supersedes: [eml.engrams.store(validNote()).id] })).toThrow(/a learning supersedes only a rule/)
      expect(() => eml.engrams.update(l.engram.id, { content: 'x'.repeat(201) })).toThrow(/at most 200 characters/)
      const r = eml.engrams.update(l.engram.id, { content: 'Ask before acting.' }, ctx())!
      expect(r.learning).toBeDefined()
      expect(eml.engrams.entries(l.engram.id, ['change']).map(e => e.text)).toEqual(['content sharpened'])
    })
  })

  // Known gap (reported): a field patch on a learning hits the generic unknown-field
  // error with an empty list ("Allowed: .") before the learning-specific message.
  it('a field patch on a learning gets the learning message, not "Allowed: ."', () => {
    const l = eml.engrams.learn({ scope: 'user.ada', title: 'x', content: 'Do x.', source: 'self', happened: 'h' })
    if (!l.written) throw new Error('not written')
    expect(() => eml.engrams.update(l.engram.id, { properties: { detail: 'x' } })).toThrow(/new evidence goes through eml_learning/)
  })

  describe('supersede after the fact (B1)', () => {
    it('across types: the new engram supersedes the old one, edge drawn', () => {
      const ref = eml.engrams.store(validReference({ title: 'synthesis' }))
      const note = eml.engrams.store(validNote({ title: 'synthesis-note' }))
      const r = eml.engrams.update(note.id, { supersedes: [ref.id] })!
      expect(r.superseded).toEqual([ref.id])
      expect(statusOf(ref.id)).toBe('superseded')
      expect(edge(note.id, ref.id, 'supersedes')).toBeTruthy()
    })

    it('re-links an engram that is superseded but has no successor edge', () => {
      const old = eml.engrams.store(validDecision({ title: 'old' }))
      rawDb().prepare(`UPDATE engrams SET status = 'superseded' WHERE id = ?`).run(old.id)
      const next = eml.engrams.store(validDecision({ title: 'new' }))
      eml.engrams.update(next.id, { supersedes: [old.id] })
      expect(edge(next.id, old.id, 'supersedes')).toBeTruthy()
      expect(statusOf(old.id)).toBe('superseded')
    })

    it('rejects itself and unknown ids; relate draws no supersedes', () => {
      const n = eml.engrams.store(validNote())
      expect(() => eml.engrams.update(n.id, { supersedes: [n.id] })).toThrow(/cannot supersede itself/)
      expect(() => eml.engrams.update(n.id, { supersedes: ['nope'] })).toThrow(/supersedes nope — no such engram/)
      const m = eml.engrams.store(validNote())
      expect(() => eml.engrams.relate({ source_id: n.id, target_id: m.id, relation: 'supersedes', detection_method: 'manual' }))
        .toThrow(/supersedes is drawn by a write/)
    })
  })

  describe('core profile', () => {
    it('one active core profile per scope: a new one supersedes the old one', () => {
      const a = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno', properties: { core: true } }))
      const b = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno-identity', properties: { core: true } }))
      expect(b.superseded).toEqual([a.id])
      expect(statusOf(a.id)).toBe('superseded')
      expect(edge(b.id, a.id, 'supersedes')).toBeTruthy()
      const other = eml.engrams.store(validProfile({ scope: 'user.ada', title: 'ada', properties: { core: true } }))
      expect(other.superseded).toBeUndefined()
    })

    it('making a profile core by update supersedes the current one too', () => {
      const a = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno', properties: { core: true } }))
      const facet = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno-work' }))
      const r = eml.engrams.update(facet.id, { properties: { core: true } })!
      expect(r.superseded).toEqual([a.id])
      expect(statusOf(a.id)).toBe('superseded')
    })
  })

  describe('reviews', () => {
    it('review_note writes a review entry and restarts the review; only for decision/rule/profile', () => {
      const d = eml.engrams.store(validDecision())
      rawDb().prepare(`UPDATE engrams SET properties = json_set(properties, '$.review_due_at', '2020-01-01T00:00:00.000Z') WHERE id = ?`).run(d.id)
      expect(eml.engrams.get(d.id)!.review_due).toBe(true)
      eml.engrams.update(d.id, { review_note: 'still the right call' }, ctx())
      expect(Date.parse(propsOf(d.id).review_due_at as string)).toBeGreaterThan(Date.now() + 50 * 86400_000)
      expect(eml.engrams.get(d.id)!.review_due).toBe(false)
      expect(eml.engrams.entries(d.id)).toMatchObject([{ kind: 'review', text: 'still the right call', author: 'juno' }])
      expect(() => eml.engrams.update(eml.engrams.store(validNote()).id, { review_note: 'x' })).toThrow(/review_note confirms a decision, rule or profile/)
      expect(() => eml.engrams.update(d.id, { review_note: '  ' })).toThrow(/review_note must say why it still holds/)
    })

    it('confirmReview needs text for a decision, rule or profile and writes the same review entry', () => {
      const r = eml.engrams.store(validRule())
      expect(() => eml.engrams.confirmReview(r.id)).toThrow('Invalid engram: confirming a review needs text — why it still holds.')
      eml.engrams.confirmReview(r.id, 'still how we work', ctx())
      expect(eml.engrams.entries(r.id).map(e => `${e.kind}:${e.text}`)).toEqual(['review:still how we work'])
      expect(() => eml.engrams.confirmReview(eml.engrams.store(validNote()).id, 'x')).toThrow(/decision, rule, profile or task/)
    })
  })

  describe('set_status', () => {
    it('every write is a new version: previous_state, and status_tracks only for project / entity scopes', () => {
      const s1 = eml.engrams.store(validStatus({ scope: 'project.p', properties: { state: 'v1' } }))
      expect(s1.previous_state).toBeNull()
      expect(s1.status_tracks).toBeNull()
      expect(s1.status_tracks_missing).toBe(true)
      eml.projects.update('p', { status_tracks: 'released version' })
      const s2 = eml.engrams.store(validStatus({ scope: 'project.p', properties: { state: 'v1' } }))
      expect(s2.previous_state).toBe('v1')
      expect(s2.superseded).toEqual([s1.id])
      expect(s2.status_tracks).toBe('released version')
      expect(s2.status_tracks_missing).toBeUndefined()
      const g = eml.engrams.store(validStatus({ scope: 'agent.juno' }))
      expect(g.status_tracks).toBeUndefined()
      expect(g.status_tracks_missing).toBeUndefined()
    })
  })

  describe('log', () => {
    it('renders START HERE from the fields, then the narrative; one log per session', () => {
      const log = eml.engrams.store(validLog({ content: 'Longer story.', properties: { what: 'W', landed: 'L', next: 'N', open_threads: ['t1', 't2'] } }), ctx('s9'))
      expect(log.content).toBe('## START HERE\n**WHAT:** W\n\n**WHERE WE LANDED:** L\n\n**NEXT:** N\n\n**OPEN THREADS:**\n- t1\n- t2\n\nLonger story.')
      expect(() => eml.engrams.store(validLog(), ctx('s9'))).toThrow(`Invalid engram: this session already has a log (${log.id} ${log.title})`)
      expect(eml.engrams.sessionLog('s9')!.id).toBe(log.id)
      expect(eml.engrams.store(validLog(), ctx('s10')).type).toBe('log')
      expect(eml.engrams.store(validLog({ content: '' })).content).toBe('## START HERE\n**WHAT:** test what\n\n**WHERE WE LANDED:** test landed\n\n**NEXT:** test next')
    })
  })

  describe('learning', () => {
    const lesson = (over: Record<string, unknown> = {}, c = ctx()) =>
      eml.engrams.learn({ scope: 'user.ada', title: 'ask-before-push', content: 'Ask before pushing.', source: 'user', happened: 'pushed without asking', quote: 'frag erst', ...over } as any, c)

    it('creates with evidence; the topic check finds a match and writes nothing; new_topic bypasses it', () => {
      const a = lesson()
      expect(a.written).toBe(true)
      if (!a.written) return
      expect(a.engram.type).toBe('learning')
      expect(eml.engrams.entries(a.engram.id)).toMatchObject([{ kind: 'evidence', source: 'user', stance: 'supports', quote: 'frag erst', text: 'pushed without asking', session_id: 's1' }])
      const b = lesson({ title: 'ask-before-pushing', content: 'Ask before pushing code.', source: 'self', quote: undefined })
      expect(b.written).toBe(false)
      if (b.written) return
      expect(b.matches.map(m => m.id)).toEqual([a.engram.id])
      expect(eml.engrams.query({ type: 'learning' })).toHaveLength(1)
      const c = lesson({ title: 'ask-before-pushing', content: 'Ask before pushing code.', source: 'self', quote: undefined, new_topic: true })
      expect(c.written).toBe(true)
    })

    it('needs quote for user evidence and for a decline; happened always; valid source and stance', () => {
      expect(() => lesson({ quote: undefined })).toThrow(/evidence from the user needs quote/)
      expect(() => lesson({ happened: ' ' })).toThrow(/happened is required/)
      expect(() => lesson({ source: 'hearsay' })).toThrow(/source must be one of user, observed, self/)
      const a = lesson()
      if (!a.written) throw new Error('not written')
      expect(() => eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'asked', stance: 'declined' })).toThrow(/a decline needs quote/)
      expect(() => eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'x', stance: 'maybe' })).toThrow(/stance must be one of/)
      expect(() => eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'x', scope: 'global' } as any)).toThrow(/only on create/)
      expect(() => eml.engrams.learn({ scope: 'user.ada', title: 't', content: 'c', source: 'self', happened: 'h', stance: 'contradicts' })).toThrow(/starts from supporting evidence/)
    })

    it('ripeness: collecting → ripe (2 sessions, one from the user) → unclear on a contradiction → ripe again once sharpened', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
      const a = lesson({ source: 'self', quote: undefined })
      if (!a.written) throw new Error('not written')
      expect(a.learning.state).toBe('collecting')
      vi.setSystemTime(new Date('2026-10-01T11:00:00Z'))
      // a second piece in the same session is the same incident
      expect(eml.engrams.learn({ id: a.engram.id, source: 'user', happened: 'again', quote: 'frag!' }, ctx('s1')).written && eml.engrams.get(a.engram.id)!.learning!.state).toBe('collecting')
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
      const r = eml.engrams.learn({ id: a.engram.id, source: 'observed', happened: 'user frowned' }, ctx('s2'))
      expect(r.written && r.learning).toMatchObject({ state: 'ripe', supporting_sessions: 2, from_user: true, open_contradiction: false })
      vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
      const c = eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'pushing was fine here', stance: 'contradicts' }, ctx('s3'))
      expect(c.written && c.learning.state).toBe('unclear')
      vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
      eml.engrams.update(a.engram.id, { content: 'Ask before pushing to main.' }, ctx('s4'))
      expect(eml.engrams.get(a.engram.id)!.learning!.state).toBe('ripe')
    })

    it('observed or self evidence alone never makes a learning ripe', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
      const a = lesson({ source: 'self', quote: undefined })
      if (!a.written) throw new Error('not written')
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'observed', happened: 'x' }, ctx('s2'))
      vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'y' }, ctx('s3'))
      expect(eml.engrams.get(a.engram.id)!.learning).toMatchObject({ state: 'collecting', supporting_sessions: 3, from_user: false })
    })

    it('a decline pauses it until two more supporting pieces from different sessions', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
      const a = lesson()
      if (!a.written) throw new Error('not written')
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'observed', happened: 'x' }, ctx('s2'))
      vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
      const d = eml.engrams.learn({ id: a.engram.id, source: 'user', happened: 'asked to make it a rule', quote: 'nein, noch nicht', stance: 'declined' }, ctx('s3'))
      expect(d.written && d.learning).toMatchObject({ state: 'paused', declined_at: '2026-10-03T10:00:00.000Z' })
      vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'observed', happened: 'y' }, ctx('s4'))
      expect(eml.engrams.get(a.engram.id)!.learning!.state).toBe('paused')
      vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'z' }, ctx('s5'))
      expect(eml.engrams.get(a.engram.id)!.learning!.state).toBe('ripe')
    })

    it('a rule with from_learning supersedes the learnings; from_learning is only for rules and needs active learnings', () => {
      const a = lesson()
      if (!a.written) throw new Error('not written')
      const rule = eml.engrams.store(validRule({ scope: 'user.ada', title: 'ask-before-push', from_learning: [a.engram.id] }))
      expect(rule.superseded).toEqual([a.engram.id])
      expect(statusOf(a.engram.id)).toBe('superseded')
      expect(edge(rule.id, a.engram.id, 'supersedes')).toBeTruthy()
      expect(() => eml.engrams.store(validNote({ from_learning: [a.engram.id] }))).toThrow(/from_learning is only for a rule/)
      expect(() => eml.engrams.store(validRule({ from_learning: [a.engram.id] }))).toThrow(/is superseded, not active/)
      expect(() => eml.engrams.store(validRule({ from_learning: [rule.id] }))).toThrow(/is not a learning/)
      expect(() => eml.engrams.learn({ id: a.engram.id, source: 'self', happened: 'x' })).toThrow(/evidence goes to an active learning/)
    })

    it('the learning_state filter lists only ripe ones in a scope', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
      const a = lesson()
      lesson({ title: 'other-topic', content: 'Keep replies short.', new_topic: true })
      if (!a.written) throw new Error('not written')
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
      eml.engrams.learn({ id: a.engram.id, source: 'observed', happened: 'x' }, ctx('s2'))
      expect(eml.engrams.query({ scope: 'user.ada', learning_state: 'ripe' }).map(e => e.id)).toEqual([a.engram.id])
    })
  })

  describe('objects', () => {
    it('create, read and update per kind, with usage counts and a diff', () => {
      const { object: proj } = createObject(eml, 'project', { name: 'My App', goal: 'ship', metadata: { repo: 'x/y' } })
      expect(proj).toMatchObject({ id: 'my-app', name: 'My App', goal: 'ship', metadata: { repo: 'x/y' }, status: 'active' })
      eml.engrams.store(validNote({ scope: 'project.my-app' }))
      expect(readObject(eml, 'project', { id: 'my-app' })).toMatchObject({ engram_count: 1 })
      const upd = updateObject(eml, 'project', 'my-app', { status_tracks: 'released version', goal: null })!
      expect(upd.diff).toMatchObject({ status_tracks: [null, 'released version'], goal: ['ship', null] })

      const { object: ent } = createObject(eml, 'entity', { name: 'Acme', kind: 'org' })
      expect(ent).toMatchObject({ id: 'acme', status: 'active', metadata: null, status_tracks: null })
      expect(() => createObject(eml, 'entity', { name: 'Bob' })).toThrow(/an entity needs kind/)

      const t = createObject(eml, 'tag', { name: 'Deploy', description: 'releases' })
      expect(t).toMatchObject({ created: true, object: { id: 'deploy', status: 'active' } })
      expect(createObject(eml, 'tag', { name: 'deploy' }).created).toBe(false)
      const s = createObject(eml, 'subject', { name: 'v0.19 build' })
      expect(s.object).toMatchObject({ id: 'v0-19-build', status: 'active' })
      expect(updateObject(eml, 'subject', 'v0-19-build', { status: 'closed' })!.diff).toMatchObject({ status: ['active', 'closed'] })
      expect(updateObject(eml, 'tag', 'nope', { description: 'x' })).toBeNull()
    })

    it('unknown fields, unknown kinds, fixed fields and metadata shape error', () => {
      expect(() => createObject(eml, 'project', { name: 'X', tags: ['a'] })).toThrow(/^Invalid object: unknown field tags for a project\. Allowed: id, name, status/)
      expect(() => createObject(eml, 'agent', { name: 'X' })).toThrow(/unknown object "agent"/)
      expect(() => updateObject(eml, 'project', 'p', { id: 'q' })).toThrow(/id cannot change/)
      expect(() => createObject(eml, 'project', { name: 'Y', metadata: { n: 1 } })).toThrow(/metadata must be a flat map of text values/)
      expect(() => createObject(eml, 'project', { name: 'P', id: 'p' })).toThrow(/project "p" already exists/)
      expect(() => updateObject(eml, 'project', 'p', { name: null })).toThrow(/name cannot be cleared/)
    })

    it('archiving a project sets ended_at; leaving archived clears it; archived ones only with a status filter', () => {
      updateObject(eml, 'project', 'p', { status: 'archived' })
      expect(eml.projects.get('p')!.ended_at).toBe(new Date().toISOString().slice(0, 10))
      expect((readObject(eml, 'project') as Array<{ id: string }>).map(p => p.id)).not.toContain('p')
      expect((readObject(eml, 'project', { status: 'archived' }) as Array<{ id: string }>).map(p => p.id)).toEqual(['p'])
      updateObject(eml, 'project', 'p', { status: 'active' })
      expect(eml.projects.get('p')!.ended_at).toBeNull()
      expect(() => readObject(eml, 'tag', { status: 'closed' })).toThrow(/status for tag is one of active, archived/)
    })

    it('an archived tag stays on its engrams but is not assigned anew', () => {
      createObject(eml, 'tag', { name: 'old' })
      const n = eml.engrams.store(validNote({ tags: ['old'] }))
      updateObject(eml, 'tag', 'old', { status: 'archived' })
      expect(eml.engrams.get(n.id)!.tags).toEqual(['old'])
      expect(() => eml.engrams.store(validNote({ tags: ['old'] }))).toThrow(/tag "old" is archived/)
      expect(eml.engrams.update(n.id, { tags: ['old'], content: 'kept' })!.tags).toEqual(['old'])
      expect((readObject(eml, 'tag') as unknown[]).length).toBe(0)
      expect((readObject(eml, 'tag', { status: 'archived' }) as Array<{ engram_count: number }>)[0].engram_count).toBe(1)
    })
  })

  describe('expiry, conflicts, filters', () => {
    it('v0.20: a decision has no expires_at, on create and on update', () => {
      expect(() => eml.engrams.store(validDecision({ properties: { expires_at: '2030-01-01' } as any }))).toThrow(/unknown field expires_at for a decision/)
      const d = eml.engrams.store(validDecision())
      expect(() => eml.engrams.update(d.id, { properties: { expires_at: '2030-01-01' } as any })).toThrow(/unknown field expires_at for a decision/)
    })

    it('an event is compared with events of the same change_type close in time, and nothing else', () => {
      eml.engrams.store(validEvent({ title: 'release-1', content: 'released version one of the cockpit', properties: { occurred_at: '2026-10-19T10:00:00Z', change_type: 'released' } }))
      const dup = eml.engrams.store(validEvent({ title: 'release-one', content: 'released version one of the cockpit today', properties: { occurred_at: '2026-10-19T14:00:00Z', change_type: 'released' } }))
      expect(dup.potential_conflicts!.map(c => c.title)).toEqual(['release-1'])
      const otherType = eml.engrams.store(validEvent({ title: 'deploy-one', content: 'released version one of the cockpit deployed', properties: { occurred_at: '2026-10-19T14:00:00Z', change_type: 'deployed' } }))
      expect(otherType.potential_conflicts).toBeUndefined()
      const far = eml.engrams.store(validEvent({ title: 'release-again', content: 'released version one of the cockpit again', properties: { occurred_at: '2026-11-19T14:00:00Z', change_type: 'released' } }))
      expect(far.potential_conflicts).toBeUndefined()
      const decision = eml.engrams.store(validDecision({ title: 'cockpit-version', content: 'released version one of the cockpit' }))
      expect(decision.potential_conflicts).toBeUndefined()
    })

    it('a new task is compared with planned tasks too', () => {
      const planned = eml.engrams.store(validTask({ scope: 'project.p', title: 'migrate-brain', content: 'Migrate the production brain to schema nineteen' }))
      const dup = eml.engrams.store(validTask({ scope: 'project.p', title: 'brain-migration', content: 'Migrate production brain schema nineteen' }))
      expect(dup.potential_conflicts!.map(c => c.id)).toContain(planned.id)
    })

    it('query filters binding, task_id, origin and session_id', () => {
      const t = eml.engrams.store(validTask({ scope: 'project.p' }))
      const bound = eml.engrams.store(validDecision({ task_id: t.id, properties: { binding: 'task' } }), ctx('s7'))
      const standing = eml.engrams.store(validDecision({ task_id: t.id, properties: { binding: 'standing' } }))
      const plain = eml.engrams.store(validNote())
      const pane = eml.engrams.store({ type: 'note', scope: 'project.p', content: 'pane', origin: 'cockpit-notes' })
      const ids = (q: Parameters<typeof eml.engrams.query>[0]) => eml.engrams.query({ limit: 100, ...q }).map(e => e.id).sort()
      expect(ids({ binding: 'task' })).toEqual([bound.id])
      expect(ids({ binding: 'standing' })).toEqual([standing.id, plain.id, pane.id].sort())
      expect(ids({ task_id: t.id })).toEqual([bound.id, standing.id].sort())
      expect(ids({ origin: 'cockpit-notes' })).toEqual([pane.id])
      expect(ids({ session_id: 's7' })).toEqual([bound.id])
    })
  })

  describe('default brain seeds', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-v019-seed-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('core profiles, origin eml-default-brain, rules with why and no agreement yet', () => {
      const file = join(dir, 'b.db')
      seedDefaultBrain(file, 'juno', 'ada')
      const seeded = new EML({ dbPath: file, namespace: 'juno' })
      try {
        const all = seeded.engrams.query({ limit: 50 })
        expect(all.every(e => e.origin === 'eml-default-brain')).toBe(true)
        expect(seeded.engrams.query({ type: 'profile' }).map(p => `${p.scope}:${(p.properties as any).core}`).sort())
          .toEqual(['agent.juno:true', 'user.ada:true'])
        for (const r of seeded.engrams.query({ type: 'rule' })) {
          expect((r.properties as any).why).toBeTruthy()
          expect((r.properties as any).agreed).toBeUndefined()
        }
      } finally { seeded.close() }
    })
  })
})
