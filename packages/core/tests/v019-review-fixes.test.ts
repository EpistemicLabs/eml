import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EML, hygieneCheck, renderBrainStateMarkdown, type WriteContext } from '../src'
import { validDecision, validTask, validNote, validEvent, validLog, validProfile, validStatus, closedTask } from './fixtures'

// v0.19 — fixes from the review of the write model (note v0.19-review-triage,
// blocks 2, 3 and 5): the task and status lifecycle under a supersede after the
// fact, legacy profiles, the core-profile index, learning sessions, closed
// tasks, reopen candidates, and the two recurring learning checks.

describe('v0.19 review fixes', () => {
  let eml: EML
  const ctx = (session = 's1', caller = 'juno'): WriteContext =>
    ({ caller, session_id: session, model: 'test-model', harness: 'claude-code', ingestion_method: 'mcp' })

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'juno' })
    eml.agents.store({ id: 'juno', name: 'Juno' })
    eml.users.create({ id: 'ada', name: 'Ada' })
    eml.projects.create({ id: 'p', name: 'P' })
    eml.projects.create({ id: 'q', name: 'Q' })
  })
  afterEach(() => { eml.close() })

  const rawDb = (): any => (eml.engrams as any).db
  const statusOf = (id: string) => eml.engrams.get(id)!.status
  const propsOf = (id: string) => (eml.engrams.get(id)!.properties ?? {}) as Record<string, unknown>
  const edge = (from: string, to: string, rel: string) =>
    rawDb().prepare('SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?').get(from, to, rel)
  const journal = (id: string) => eml.engrams.entries(id).map(e => `${e.kind}:${e.text}`)

  describe('supersede of tasks and statuses (block 2)', () => {
    it('a task is not superseded from the side: eml_update and a non-task create point to the task tools', () => {
      const task = eml.engrams.store(validTask({ title: 'work' }))
      const note = eml.engrams.store(validNote())
      expect(() => eml.engrams.update(note.id, { supersedes: [task.id] })).toThrow(/is a task — a task is replaced by a task/)
      expect(() => eml.engrams.store(validDecision({ supersedes: [task.id] }))).toThrow(/is a task — a task is replaced by a task/)
      expect(statusOf(task.id)).toBe('planned')
    })

    it('a status is superseded only by the next set_status', () => {
      const s = eml.engrams.store(validStatus({ scope: 'project.p' }))
      const note = eml.engrams.store(validNote({ scope: 'project.p' }))
      expect(() => eml.engrams.update(note.id, { supersedes: [s.id] })).toThrow(/is a status — a status is superseded by the next eml_set_status/)
      expect(statusOf(s.id)).toBe('active')
    })

    it('eml_track_task supersedes: task → task, bound items move, journals on both sides, open sub-tasks reported', () => {
      const old = eml.engrams.store(validTask({ title: 'old' }), ctx())
      const bound = eml.engrams.store(validDecision({ task_id: old.id, properties: { binding: 'task' } }), ctx())
      const child = eml.engrams.store(validTask({ title: 'child', parent_id: old.id }), ctx())
      const next = eml.engrams.store(validTask({ title: 'next' }), ctx())
      const r = eml.engrams.trackTask(next.id, { supersedes: [old.id] }, ctx())!
      expect(r.superseded).toEqual([old.id])
      expect(r.open_subtasks).toEqual([{ parent_id: old.id, id: child.id, title: 'child' }])
      expect(statusOf(old.id)).toBe('superseded')
      expect(edge(next.id, old.id, 'supersedes')).toBeTruthy()
      expect(edge(bound.id, next.id, 'derived_from')).toBeTruthy()
      expect(edge(bound.id, old.id, 'derived_from')).toBeFalsy()
      expect(journal(old.id).at(-1)).toBe(`change:superseded by ${next.id}`)
      expect(journal(next.id)).toContain(`change:supersedes ${old.id}`)
    })

    it('track_task supersedes takes only tasks, replaces from an open task, and re-links an already superseded one', () => {
      const next = eml.engrams.store(validTask({ title: 'next' }), ctx())
      const note = eml.engrams.store(validNote())
      expect(() => eml.engrams.trackTask(next.id, { supersedes: [note.id] })).toThrow(/is a note — a task replaces a task/)
      const done = closedTask(eml, { title: 'done' })
      // a closed task keeps how it ended and only gets the edge (decision supersede-rules)
      eml.engrams.trackTask(next.id, { supersedes: [done.id] }, ctx())
      expect(statusOf(done.id)).toBe('resolved')
      expect(edge(next.id, done.id, 'supersedes')).toBeTruthy()
      const orphan = eml.engrams.store(validTask({ title: 'orphan' }), ctx())
      rawDb().prepare(`UPDATE engrams SET status = 'superseded' WHERE id = ?`).run(orphan.id)
      eml.engrams.trackTask(next.id, { supersedes: [orphan.id] }, ctx())
      expect(edge(next.id, orphan.id, 'supersedes')).toBeTruthy()
      expect(journal(orphan.id).at(-1)).toBe(`change:superseded by ${next.id}`)
      const closed = closedTask(eml, { title: 'closed-successor' })
      expect(() => eml.engrams.trackTask(closed.id, { supersedes: [eml.engrams.store(validTask()).id] })).toThrow(/only an open task replaces another/)
    })

    it('create_task supersedes writes the journal entry on the old task; a closed one keeps its status', () => {
      const old = eml.engrams.store(validTask({ title: 'old' }), ctx())
      const next = eml.engrams.store(validTask({ title: 'next', supersedes: [old.id] }), ctx())
      expect(journal(old.id).at(-1)).toBe(`change:superseded by ${next.id}`)
      const done = closedTask(eml)
      const after = eml.engrams.store(validTask({ supersedes: [done.id] }), ctx())
      expect(statusOf(done.id)).toBe('resolved')
      expect(journal(done.id).at(-1)).toBe(`change:superseded by ${after.id}`)
    })

    it('only an active engram supersedes another after the fact', () => {
      const a = eml.engrams.store(validNote({ title: 'a' }))
      const b = eml.engrams.store(validNote({ title: 'b' }))
      eml.engrams.update(b.id, { status: 'invalidated' })
      expect(() => eml.engrams.update(b.id, { supersedes: [a.id] })).toThrow(/is invalidated — only an active engram supersedes another/)
      expect(statusOf(a.id)).toBe('active')
      expect(eml.engrams.update(b.id, { status: 'active', supersedes: [a.id] })!.superseded).toEqual([a.id])
    })
  })

  describe('core write model (block 3)', () => {
    it('a legacy profile outside agent / user / entity can be retired and reviewed; only a move is checked', () => {
      const p = eml.engrams.store(validProfile({ scope: 'user.ada', title: 'legacy' }))
      rawDb().prepare(`UPDATE engrams SET scope = 'global' WHERE id = ?`).run(p.id)
      expect(eml.engrams.update(p.id, { review_note: 'still me' }, ctx())!.scope).toBe('global')
      expect(() => eml.engrams.update(p.id, { scope: 'project.p' })).toThrow(/a profile is about someone/)
      expect(eml.engrams.update(p.id, { status: 'invalidated' })!.status).toBe('invalidated')
    })

    it('a core profile arriving in a scope that has one is refused with a clear error; core=true still replaces', () => {
      const a = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno', properties: { core: true } }))
      const b = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno-2', properties: { core: true } }))
      expect(statusOf(a.id)).toBe('superseded')
      eml.engrams.update(b.id, { status: 'invalidated' })
      // the undo: with the successor gone, the old core comes back
      expect(eml.engrams.update(a.id, { status: 'active' })!.status).toBe('active')
      const c = eml.engrams.store(validProfile({ scope: 'agent.juno', title: 'juno-3', properties: { core: true } }))
      expect(statusOf(a.id)).toBe('superseded')
      expect(() => eml.engrams.update(b.id, { status: 'active' })).toThrow(`Invalid engram: scope agent.juno already has a core profile (${c.id}) — invalidate it first`)
      const ada = eml.engrams.store(validProfile({ scope: 'user.ada', title: 'ada', properties: { core: true } }))
      expect(() => eml.engrams.update(ada.id, { scope: 'agent.juno' })).toThrow(/already has a core profile/)
      expect(statusOf(c.id)).toBe('active')
      eml.entities.create({ id: 'acme', name: 'Acme', kind: 'org' })
      expect(eml.engrams.update(ada.id, { scope: 'entity.acme' })!.scope).toBe('entity.acme')
    })

    it('learning evidence without a session id does not count as a session', () => {
      const l = eml.engrams.learn({ scope: 'user.ada', title: 't', content: 'Do X.', source: 'user', happened: 'h1', quote: 'q' }, { caller: 'juno' })
      if (!l.written) throw new Error('not written')
      const r = eml.engrams.learn({ id: l.engram.id, source: 'user', happened: 'h2', quote: 'q2' }, { caller: 'juno' })
      if (!r.written) throw new Error('not written')
      expect(r.learning).toMatchObject({ state: 'collecting', supporting_sessions: 0, unsessioned_evidence: 2 })
      const s = eml.engrams.learn({ id: l.engram.id, source: 'observed', happened: 'h3' }, ctx('s1'))
      const t = eml.engrams.learn({ id: l.engram.id, source: 'observed', happened: 'h4' }, ctx('s2'))
      if (!s.written || !t.written) throw new Error('not written')
      expect(t.learning).toMatchObject({ state: 'ripe', supporting_sessions: 2, from_user: true })
    })

    it('an unknown scope points to eml_create_object, or to the cockpit for users and agents', () => {
      expect(() => eml.engrams.store(validNote({ scope: 'project.nope' }))).toThrow('Create it first with eml_create_object(object=project, name=…, id=nope).')
      expect(() => eml.engrams.store(validNote({ scope: 'user.nope' }))).toThrow('Users and agents are set up by the cockpit')
    })

    it('learn(id, content) refuses a blank lesson', () => {
      const l = eml.engrams.learn({ scope: 'user.ada', title: 't', content: 'Do X.', source: 'user', happened: 'h', quote: 'q' }, ctx())
      if (!l.written) throw new Error('not written')
      expect(() => eml.engrams.learn({ id: l.engram.id, content: '  ', source: 'self', happened: 'h2' }, ctx())).toThrow(/content must not be empty/)
    })

    it('binding task needs an open task, on create and on update', () => {
      const done = closedTask(eml)
      expect(() => eml.engrams.store(validDecision({ task_id: done.id, properties: { binding: 'task' } }))).toThrow(/is resolved — a decision bound to it would close with it/)
      const standing = eml.engrams.store(validNote({ task_id: done.id, properties: { binding: 'standing' } }))
      expect(() => eml.engrams.update(standing.id, { properties: { binding: 'task' } })).toThrow(/a note bound to it would close with it/)
    })

    it('a review confirms only an active engram (an open task)', () => {
      const d = eml.engrams.store(validDecision())
      eml.engrams.update(d.id, { status: 'invalidated' })
      expect(() => eml.engrams.update(d.id, { review_note: 'x' })).toThrow(/is invalidated — a review confirms an active engram/)
      expect(() => eml.engrams.confirmReview(d.id, 'x')).toThrow(/is invalidated — a review confirms an active engram/)
      expect(() => eml.engrams.confirmReview(closedTask(eml).id, 'x')).toThrow(/an open task/)
      expect(eml.engrams.entries(d.id, ['review'])).toEqual([])
    })

    it('a content rewrite through track_task draws wikilinks', () => {
      const target = eml.engrams.store(validNote({ title: 'target-note' }))
      const t = eml.engrams.store(validTask())
      const r = eml.engrams.trackTask(t.id, { content: 'See [[target-note]] and [[missing-one]].', text: 'rewritten' }, ctx())!
      expect(edge(t.id, target.id, 'related_to')).toBeTruthy()
      expect(r.unresolved_links).toEqual(['missing-one'])
    })

    it('the unknown-field list names review_note and app only where they apply; a learning names supersedes', () => {
      const n = eml.engrams.store(validNote())
      let msg = ''
      try { eml.engrams.update(n.id, { colour: 'red' } as any) } catch (e) { msg = (e as Error).message }
      expect(msg).toBe('Invalid engram: unknown field colour for a note. Allowed: content, title, scope, status, tags, subjects, supersedes, binding, detail.')
      const d = eml.engrams.store(validDecision())
      try { eml.engrams.update(d.id, { colour: 'red' } as any) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('supersedes, review_note, rationale')
      expect(msg).not.toContain('app')
    })

    it('the learning topic check filters by scope inside the query', () => {
      eml.engrams.learn({ scope: 'project.p', title: 'ask-first', content: 'Ask before pushing to the remote.', source: 'user', happened: 'h', quote: 'q' }, ctx())
      const other = eml.engrams.learn({ scope: 'project.q', title: 'ask-first', content: 'Ask before pushing to the remote.', source: 'user', happened: 'h', quote: 'q' }, ctx())
      expect(other.written).toBe(true)
      const same = eml.engrams.learn({ scope: 'project.p', title: 'ask-first-2', content: 'Ask before pushing to the remote.', source: 'user', happened: 'h', quote: 'q' }, ctx())
      expect(same.written).toBe(false)
    })
  })

  describe('design questions (block 5)', () => {
    it('a task moves to another scope through track_task, with a change entry and the search index updated', () => {
      const t = eml.engrams.store(validTask({ scope: 'project.p', title: 'movable', content: 'find me by scope' }), ctx())
      const r = eml.engrams.trackTask(t.id, { scope: 'project.q' }, ctx())!
      expect(r.scope).toBe('project.q')
      expect(journal(t.id).at(-1)).toBe('change:scope project.p → project.q')
      expect(eml.engrams.query({ scope: 'project.q', search: 'find' }).map(e => e.id)).toEqual([t.id])
      expect(() => eml.engrams.trackTask(t.id, { scope: 'project.nope' })).toThrow(/unknown project/)
    })

    it('a closed task is not closed again — reopen, then close', () => {
      const t = closedTask(eml)
      expect(() => eml.engrams.trackTask(t.id, { status: 'invalidated', outcome: 'other', text: 'x' })).toThrow(/is already resolved — to change how it ended, reopen it/)
      eml.engrams.trackTask(t.id, { status: 'active', text: 'back' }, ctx())
      expect(eml.engrams.trackTask(t.id, { status: 'invalidated', outcome: 'other', text: 'x', keep: [] }, ctx())!.status).toBe('invalidated')
    })


    it('decision-without-rationale: active decisions missing rationale or alternatives', () => {
      const d = eml.engrams.store(validDecision({ title: 'bare' }))
      rawDb().prepare(`UPDATE engrams SET properties = json_remove(properties, '$.rationale', '$.alternatives') WHERE id = ?`).run(d.id)
      const a = eml.engrams.store(validDecision({ title: 'half' }))
      rawDb().prepare(`UPDATE engrams SET properties = json_set(properties, '$.alternatives', json('[]')) WHERE id = ?`).run(a.id)
      eml.engrams.store(validDecision({ title: 'fine' }))
      const check = hygieneCheck(eml).checks.find(c => c.id === 'decision-without-rationale')!
      expect(check).toMatchObject({ kind: 'migration', decides: 'agent', since_schema: 19 })
      expect(check.findings.map(f => `${f.title}: ${f.reason}`).sort()).toEqual(['bare: no rationale, no alternatives.', 'half: no alternatives.'])
    })

    it('learning-unclear: the recurring learning check (no age check)', () => {
      const unclear = eml.engrams.learn({ scope: 'user.ada', title: 'u', content: 'Do U.', source: 'user', happened: 'h', quote: 'q' }, ctx('s1'))
      if (!unclear.written) throw new Error('not written')
      eml.engrams.learn({ id: unclear.engram.id, source: 'observed', happened: 'did not hold', stance: 'contradicts' }, ctx('s2'))
      const stale = eml.engrams.learn({ scope: 'user.ada', title: 's', content: 'Do S.', source: 'observed', happened: 'once' }, ctx('s1'))
      if (!stale.written) throw new Error('not written')
      const fresh = eml.engrams.learn({ scope: 'user.ada', title: 'f', content: 'Do F.', source: 'observed', happened: 'once' }, ctx('s1'))
      if (!fresh.written) throw new Error('not written')
      const later = new Date(Date.now() + 365 * 86400_000)
      const r = hygieneCheck(eml, { now: later })
      const byId = (id: string) => r.checks.find(c => c.id === id)!
      expect(byId('learning-unclear')).toMatchObject({ kind: 'review', decides: 'user' })
      expect(byId('learning-unclear').findings.map(f => f.id)).toEqual([unclear.engram.id])
      expect(r.checks.find(c => c.id === 'learning-stale')).toBeUndefined()
      expect(r.checks.flatMap(c => c.findings.map(f => f.id))).not.toContain(stale.engram.id)
      expect(r.checks.flatMap(c => c.findings.map(f => f.id))).not.toContain(fresh.engram.id)
    })
  })

  // Found in the dev-cockpit smoke test of the release (2026-10-20).
  describe('closed tasks and their bound items (dev smoke test)', () => {
    it('closing a closed task again names the state, whatever else the call carries', () => {
      const done = closedTask(eml, { title: 'done' })
      expect(() => eml.engrams.trackTask(done.id, { status: 'resolved', outcome: 'again', text: 'again' })).toThrow(/is already resolved — to change how it ended, reopen it/)
      // the current status repeated without an outcome is a plain journal note
      expect(eml.engrams.trackTask(done.id, { status: 'resolved', text: 'a late note' })!.status).toBe('resolved')
      expect(() => eml.engrams.trackTask(done.id, { status: 'invalidated', outcome: 'x', text: 'x' })).toThrow(/is already resolved/)
      expect(statusOf(done.id)).toBe('resolved')
    })

    it('a decision closed with its task comes back with the task: the reopen lists it, then it reactivates', () => {
      const task = eml.engrams.store(validTask({ title: 'work' }))
      const bound = eml.engrams.store(validDecision({ task_id: task.id, properties: { binding: 'task' } }))
      eml.engrams.trackTask(task.id, { status: 'resolved', outcome: 'done', text: 'done', keep: [] })
      expect(statusOf(bound.id)).toBe('resolved')
      expect(() => eml.engrams.update(bound.id, { status: 'active' })).toThrow(/is resolved — a decision bound to it stays closed with it/)
      expect(statusOf(bound.id)).toBe('resolved')
      const reopened = eml.engrams.trackTask(task.id, { status: 'active', text: 'more to do' }) as any
      expect(reopened.reopen_candidates.map((c: any) => c.id)).toEqual([bound.id])
      eml.engrams.update(bound.id, { status: 'active' })
      expect(statusOf(bound.id)).toBe('active')
    })

    it('… or it outlives the closed task as a standing item, in the same call', () => {
      const task = eml.engrams.store(validTask({ title: 'work' }))
      const bound = eml.engrams.store(validNote({ task_id: task.id, properties: { binding: 'task' } }))
      eml.engrams.trackTask(task.id, { status: 'invalidated', outcome: 'dropped', text: 'dropped', keep: [] })
      expect(statusOf(bound.id)).toBe('invalidated')
      eml.engrams.update(bound.id, { status: 'active', properties: { binding: 'standing' } })
      expect(statusOf(bound.id)).toBe('active')
      expect(propsOf(bound.id).binding).toBe('standing')
    })
  })

  // Second-session review of the release branch (2026-10-21), blocks A and B.
  describe('second-session review', () => {
    const relate = (s: string, t: string, relation: 'derived_from' | 'refines' | 'related_to') =>
      eml.engrams.relate({ source_id: s, target_id: t, relation, detection_method: 'agent_declared' })

    it('A3: a bound item belongs to one task; relate does not draw a second binding edge', () => {
      const t1 = eml.engrams.store(validTask({ title: 't1' }))
      const t2 = eml.engrams.store(validTask({ title: 't2' }))
      const d = eml.engrams.store(validDecision({ task_id: t1.id, properties: { binding: 'task' } }))
      expect(() => relate(d.id, t2.id, 'derived_from')).toThrow(`is bound to task ${t1.id} — a decision is bound to one task`)
      expect(() => relate(d.id, t2.id, 'refines')).toThrow(/bound to one task/)
      expect(relate(d.id, t2.id, 'related_to')).toBe(true)
      // a standing item may point at several tasks
      eml.engrams.update(d.id, { properties: { binding: 'standing' } })
      expect(relate(d.id, t2.id, 'derived_from')).toBe(true)
    })

    it('A4: an engram with a successor is not superseded a second time', () => {
      const a = eml.engrams.store(validTask({ title: 'a' }))
      const b = eml.engrams.store(validTask({ title: 'b', supersedes: [a.id] }))
      const c = eml.engrams.store(validTask({ title: 'c' }))
      expect(() => eml.engrams.trackTask(c.id, { supersedes: [a.id], text: 'x' })).toThrow(`${a.id} is already superseded by ${b.id} — continue on that one`)
      const d1 = eml.engrams.store(validDecision())
      const d2 = eml.engrams.store(validDecision({ supersedes: [d1.id] }))
      const d3 = eml.engrams.store(validDecision())
      expect(() => eml.engrams.update(d3.id, { supersedes: [d1.id] })).toThrow(`already superseded by ${d2.id}`)
      expect(rawDb().prepare(`SELECT COUNT(*) AS n FROM relations WHERE target_id = ? AND relation = 'supersedes'`).get(d1.id).n).toBe(1)
    })

    it('B7: a task without priority sorts as normal', () => {
      const raw = rawDb()
      const mk = (title: string, priority?: string, at = '2026-01-01T00:00:00.000Z') => {
        const t = eml.engrams.store(validTask({ title, scope: 'project.p', properties: priority ? { priority } : {} }))
        if (!priority) raw.prepare(`UPDATE engrams SET properties = json_remove(properties, '$.priority') WHERE id = ?`).run(t.id)
        raw.prepare('UPDATE engrams SET updated_at = ? WHERE id = ?').run(at, t.id)
        raw.prepare('UPDATE entries SET at = ? WHERE engram_id = ?').run(at, t.id)
        return t
      }
      // recent movement, so none of them is backlog
      const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()
      mk('low-one', 'low', ago(1))
      mk('none-one', undefined, ago(3))
      mk('normal-one', 'normal', ago(2))
      const order = eml.engrams.buildBrainState('project.p').open_tasks.map(t => t.title)
      expect(order).toEqual(['normal-one', 'none-one', 'low-one'])
    })
  })

  // Dev smoke test of the release candidate (2026-10-21).
  describe('smoke-test findings', () => {
    const conflictIds = (r: any) => (r.potential_conflicts ?? []).map((c: any) => c.id)
    const long = 'Build the intent driven test suite for the cockpit with one test file per user facing area: sessions, panes, desks, windows, sidebar, spaces and providers.'

    it('eml_show counts every open task and names the rest after the first ten', () => {
      for (let i = 0; i < 12; i++) eml.engrams.store(validTask({ title: `t${i}`, scope: 'project.p' }))
      const state = eml.engrams.buildBrainState('project.p')
      expect(state.open_tasks).toHaveLength(10)
      expect(state.open_tasks_total).toBe(12)
      const md = renderBrainStateMarkdown(state)
      expect(md).toContain('## Open tasks (12)')
      expect(md).toContain('- 2 more open tasks — eml_list type=task scope=project.p status=planned (or active)')
      const few = renderBrainStateMarkdown(eml.engrams.buildBrainState('project.q'))
      expect(few).toContain('## Open tasks (0)')
      expect(few).not.toContain('more open tasks')
    })

    it('the conflict check skips what the write is tied to: its parent and its bound task', () => {
      const parent = eml.engrams.store(validTask({ title: 'suite', scope: 'project.p', content: long }))
      const child = eml.engrams.store(validTask({ title: 'suite-sessions', scope: 'project.p', parent_id: parent.id, content: long }))
      expect(conflictIds(child)).not.toContain(parent.id)
      const bound = eml.engrams.store(validDecision({ scope: 'project.p', task_id: child.id, properties: { binding: 'task' }, content: long }))
      expect(conflictIds(bound)).not.toContain(child.id)
      // an unrelated task with the same words is still reported
      expect(conflictIds(bound)).toContain(parent.id)
    })

    it('a short write needs three shared terms, not just a high share', () => {
      eml.engrams.store(validNote({ title: 'intent-suite-notes', scope: 'project.p', content: long }))
      // two shared words of three: 67 %, but no real overlap
      const short = eml.engrams.store(validNote({ title: 'x', scope: 'project.p', content: 'Cockpit sessions.' }))
      expect(conflictIds(short)).toEqual([])
      // three shared words are enough, however short the write
      const three = eml.engrams.store(validNote({ title: 'z', scope: 'project.p', content: 'Cockpit intent suite.' }))
      expect(conflictIds(three)).toHaveLength(1)
      const longer = eml.engrams.store(validNote({ title: 'y', scope: 'project.p', content: 'Cockpit intent suite: sessions, panes and sidebar get a test file.' }))
      expect(conflictIds(longer)).toHaveLength(1)
    })
  })
})
