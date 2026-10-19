import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EML, significanceWeight, validateProperties, bucketByRelevance, renderRecallMarkdown, renderBrainStateMarkdown } from '../../core/src'
import { validDecision, validTask } from '../../core/tests/fixtures'

// v0.8 C3: hard scope validation. Tests that use scope='project.<id>' / 'agent.<id>'
// / 'user.<id>' / 'entity.<id>' must register the referenced entity first.
// This helper creates the fixtures the tests typically need. Tests that need
// specific scopes register their own.
function seedScopeFixtures(eml: EML): void {
  // Projects
  for (const id of ['eml', 'frank', 'ecp', 'acme-app']) {
    if (!eml.projects.exists(id)) eml.projects.create({ id, name: id })
  }
  // Agents
  for (const id of ['assistant', 'scout-btc', 'btc-scout', 'frank']) {
    if (!eml.agents.exists(id)) eml.agents.store({ id, name: id })
  }
  // Users
  for (const id of ['alice']) {
    if (!eml.users.exists(id)) eml.users.create({ id, name: id })
  }
  // Entities
  for (const id of ['bob', 'anthropic', 'btc']) {
    if (!eml.entities.exists(id)) eml.entities.create({ id, name: id, kind: 'person' })
  }
}

// Helper for CRUD describe blocks that create their own projects/agents/users
// and must not collide with the global seed.
// The API has no DELETE (no-delete-by-design), so raw SQL.
function resetEntities(eml: EML): void {
  const db = (eml as unknown as { db: { exec(sql: string): void } }).db
  db.exec("DELETE FROM projects; DELETE FROM agents; DELETE FROM users; DELETE FROM entities;")
}

describe('EML v0.2', () => {
  let eml: EML
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    eml = new EML({ namespace: 'test', dbPath: ':memory:' })
    // v0.8 C3: standard fixtures before each test, so scope existence checks
    // don't have to be set up in every single test.
    seedScopeFixtures(eml)
    // Suppress console.warn (still partly emitted by old code paths).
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy?.mockRestore()
    warnSpy = null
    eml.close()
  })

  // ============================================================
  // Engrams CRUD
  // ============================================================
  describe('engrams', () => {
    it('stores and retrieves an engram', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'EML uses SQLite with FTS5',
        scope: 'project.eml',
        title: 'EML',
      }))

      expect(engram.id).toBeDefined()
      expect(engram.content).toBe('EML uses SQLite with FTS5')
      expect(engram.type).toBe('decision')
      expect(engram.scope).toBe('project.eml')
      expect(engram.status).toBe('active')
      expect(engram.significance).toBe('normal')

      const retrieved = eml.engrams.get(engram.id)
      expect(retrieved).toBeDefined()
      expect(retrieved!.content).toBe('EML uses SQLite with FTS5')
    })

    // v0.9.1 Cluster 1: ingested_by user input dropped, source_id/source_type
    // removed from the schema. decay_* stays free-form in properties (no server schema).
    it('stores engram with optional fields (post-Cluster-1: without multi-caller columns)', () => {
      const engram = eml.engrams.store({
        content: 'BTC at $74,200',
        type: 'note',
        scope: 'global',
        title: 'BTC',
        significance: 'high',
        properties: {
          value: 74200, unit: 'USD',
          decay_model: 'ttl', decay_params: { ttl_seconds: 3600 },
        },
        ingestion_method: 'hook',
        session_id: 'sess-123',
      })

      expect(engram.significance).toBe('high')
      expect(engram.ingestion_method).toBe('hook')
      const props = engram.properties as Record<string, any>
      expect(props.value).toBe(74200)
      expect(props.decay_model).toBe('ttl')
      expect(props.decay_params?.ttl_seconds).toBe(3600)
    })

    it('updates an engram', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'Old content',
        scope: 'global',
      }))

      const updated = eml.engrams.update(engram.id, {
        content: 'New content',
        significance: 'high',
        status: 'superseded',
      })

      expect(updated!.content).toBe('New content')
      expect(updated!.significance).toBe('high')
      expect(updated!.status).toBe('superseded')
    })

    it('update() merges properties shallowly (incoming wins, others preserved)', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'Test',
        scope: 'global',
        properties: { source_id: 'assistant', source_type: 'agent', decided_at: '2026-05-01' },
      }))

      const updated = eml.engrams.update(engram.id, {
        properties: { decided_at: '2026-05-20' },
      })

      const props = updated!.properties as Record<string, unknown>
      expect(props.decided_at).toBe('2026-05-20')
      expect(props.source_id).toBe('assistant')
      expect(props.source_type).toBe('agent')
    })

    it('update() with null property value deletes that key', () => {
      const engram = eml.engrams.store({
        content: 'Test',
        type: 'rule',
        scope: 'global',
        properties: { applies: 'always', source_id: 'assistant', source_type: 'agent', boot: ['*'] },
      })

      const updated = eml.engrams.update(engram.id, {
        properties: { boot: null },
      })

      const props = updated!.properties as Record<string, unknown>
      expect(props.boot).toBeUndefined()
      expect(props.applies).toBe('always')
      expect(props.source_id).toBe('assistant')
    })

    it('update() merges into empty existing properties', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'Test',
        scope: 'global',
      }))

      const updated = eml.engrams.update(engram.id, {
        properties: { source_id: 'assistant', source_type: 'agent' },
      })

      const props = updated!.properties as Record<string, unknown>
      expect(props.source_id).toBe('assistant')
      expect(props.source_type).toBe('agent')
    })

    it('deletes an engram and its relations', () => {
      const a = eml.engrams.store(validDecision({ content: 'A', scope: 'global' }))
      const b = eml.engrams.store(validDecision({ content: 'B', scope: 'global' }))
      eml.engrams.relate({
        source_id: a.id, target_id: b.id,
        relation: 'supports', detection_method: 'manual',
      })

      expect(eml.engrams.delete(a.id)).toBe(true)
      expect(eml.engrams.get(a.id)).toBeNull()
      // Relation should also be gone
      const bCtx = eml.engrams.get(b.id)
      expect(bCtx!.relations).toHaveLength(0)
    })
  })

  // ============================================================
  // Properties Validation
  // ============================================================
  describe('validation', () => {
    it('rejects an update to an unknown type', () => {
      const e = eml.engrams.store({ content: 'A note', type: 'note', scope: 'global' })
      expect(() => eml.engrams.update(e.id, { type: 'bogus' as any })).toThrow(/unknown type/)
    })

    it('rejects an unknown type', () => {
      expect(() => eml.engrams.store({
        content: 'X', type: 'bogus' as any, scope: 'global',
      })).toThrow(/unknown type/)
    })

    it('rejects rule without applies', () => {
      expect(() => eml.engrams.store({
        content: 'Bad rule',
        type: 'rule',
        scope: 'global',
        properties: {},
      })).toThrow('applies')
    })

    it('accepts profile without properties (v0.5: profile_type removed)', () => {
      const engram = eml.engrams.store({
        content: 'Profile sans type',
        type: 'profile',
        scope: 'global',
        properties: {},
      })
      expect(engram.type).toBe('profile')
    })

    // v0.8 C7: status_type gone; state required.
    it('rejects status without state', () => {
      expect(() => eml.engrams.store({
        content: 'Bad status',
        type: 'status',
        scope: 'global',
        properties: {},
      })).toThrow('state')
    })

    it('rejects decision without alternatives and rationale (v0.15)', () => {
      expect(() => eml.engrams.store({
        content: 'We use SQLite',
        type: 'decision',
        scope: 'project.eml',
      })).toThrow(/^Invalid engram: a decision needs/)
    })
  })

  // ============================================================
  // Status engrams
  // ============================================================
  describe('status engrams', () => {
    it('stores and queries status engram', () => {
      const engram = eml.engrams.store({
        content: 'EML: v0.2 done, bootstrap next',
        type: 'status',
        scope: 'project.eml',
        title: 'EML',
        properties: {
          state: 'v0.2 complete',
          next_step: 'Bootstrap: assistant knowledge into EML',
        },
      })

      expect(engram.id).toBeDefined()
      expect(engram.type).toBe('status')
      expect(engram.properties).toEqual({
        state: 'v0.2 complete',
        next_step: 'Bootstrap: assistant knowledge into EML',
      })

      const results = eml.engrams.query({ type: 'status' })
      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('EML')
    })
  })

  // ============================================================
  // Agents
  // ============================================================
  describe('agents', () => {
    // CRUD tests share entity ids with the global seed → reset.
    beforeEach(() => resetEntities(eml))

    it('stores and retrieves an agent', () => {
      const agent = eml.agents.store({
        id: 'assistant',
        name: 'Assistant',
        domains: ['architecture', 'workflow'],
        description: 'Lead dev agent',
      })

      expect(agent.id).toBe('assistant')
      expect(agent.domains).toEqual(['architecture', 'workflow'])

      const retrieved = eml.agents.get('assistant')
      expect(retrieved!.name).toBe('Assistant')
    })

    it('lists all agents', () => {
      eml.agents.store({ id: 'assistant', name: 'Assistant' })
      eml.agents.store({ id: 'scout', name: 'Scout' })

      const all = eml.agents.list()
      expect(all).toHaveLength(2)
    })

    it('updates an agent', () => {
      eml.agents.store({ id: 'scout', name: 'Scout' })
      const updated = eml.agents.update('scout', { name: 'Scout-BTC', domains: ['market'] })
      expect(updated!.name).toBe('Scout-BTC')
      expect(updated!.domains).toEqual(['market'])
    })

    it('deletes an agent', () => {
      eml.agents.store({ id: 'temp', name: 'Temp', type: 'automated' })
      expect(eml.agents.delete('temp')).toBe(true)
      expect(eml.agents.get('temp')).toBeNull()
    })
  })

  // ============================================================
  // Relations
  // ============================================================
  describe('relations', () => {
    it('rejects the removed evaluates verb (v0.16)', () => {
      const a = eml.engrams.store({ content: 'A', type: 'note', scope: 'global' })
      const b = eml.engrams.store({ content: 'B', type: 'note', scope: 'global' })
      expect(() => eml.engrams.relate({
        source_id: a.id, target_id: b.id,
        relation: 'evaluates' as any, detection_method: 'agent_declared',
      })).toThrow()
    })

    it('creates and loads relations on get', () => {
      const a = eml.engrams.store(validDecision({ content: 'A', scope: 'global' }))
      const b = eml.engrams.store({ content: 'B', type: 'note', scope: 'global' })

      eml.engrams.relate({
        source_id: a.id, target_id: b.id,
        relation: 'derived_from', detection_method: 'agent_declared',
        explanation: 'B is based on A',
      })

      const bCtx = eml.engrams.get(b.id)
      expect(bCtx!.relations).toHaveLength(1)
      expect(bCtx!.relations[0].relation).toBe('derived_from')
      expect(bCtx!.relations[0].detection_method).toBe('agent_declared')
      expect(bCtx!.relations[0].explanation).toBe('B is based on A')
    })

    it('requires detection_method', () => {
      const a = eml.engrams.store(validDecision({ content: 'A', scope: 'global' }))
      const b = eml.engrams.store(validDecision({ content: 'B', scope: 'global' }))

      // detection_method is required by the DB CHECK constraint
      expect(() => eml.engrams.relate({
        source_id: a.id, target_id: b.id,
        relation: 'supports',
        detection_method: 'invalid_method' as any,
      })).toThrow()
    })

    it('relationsInScope returns edges with either endpoint in scope, incl. cross-scope', () => {
      const inA = eml.engrams.store(validDecision({ content: 'inA', scope: 'project.eml' }))
      const inB = eml.engrams.store(validDecision({ content: 'inB', scope: 'project.eml' }))
      const ext = eml.engrams.store(validDecision({ content: 'ext', scope: 'project.frank' }))
      const outX = eml.engrams.store(validDecision({ content: 'outX', scope: 'global' }))
      const outY = eml.engrams.store(validDecision({ content: 'outY', scope: 'global' }))

      eml.engrams.relate({ source_id: inA.id, target_id: inB.id, relation: 'related_to', detection_method: 'agent_declared' }) // both in scope
      eml.engrams.relate({ source_id: inA.id, target_id: ext.id, relation: 'related_to', detection_method: 'agent_declared' }) // cross-scope (source in)
      eml.engrams.relate({ source_id: outX.id, target_id: inB.id, relation: 'related_to', detection_method: 'agent_declared' }) // cross-scope (target in)
      eml.engrams.relate({ source_id: outX.id, target_id: outY.id, relation: 'related_to', detection_method: 'agent_declared' }) // fully outside

      const rels = eml.engrams.relationsInScope('project.eml')
      expect(rels).toHaveLength(3)
      const pairs = rels.map(r => `${r.source_id}->${r.target_id}`)
      expect(pairs).toContain(`${inA.id}->${inB.id}`)
      expect(pairs).toContain(`${inA.id}->${ext.id}`)
      expect(pairs).toContain(`${outX.id}->${inB.id}`)
      expect(pairs).not.toContain(`${outX.id}->${outY.id}`)
    })
  })

  // ============================================================
  // Query Filters
  // ============================================================
  describe('query', () => {
    beforeEach(() => {
      eml.engrams.store(validDecision({ content: 'EML decision', scope: 'project.eml', title: 'EML', significance: 'high' }))
      eml.engrams.store({ content: 'Workflow rule', type: 'rule', scope: 'global', title: 'workflow', properties: { applies: 'situational', trigger: 'when it applies' } })
      eml.engrams.store({ content: 'BTC metric', type: 'note', scope: 'global', title: 'BTC', significance: 'low', properties: { value: 74200, unit: 'USD' } })
    })

    it('filters by scope', () => {
      const results = eml.engrams.query({ scope: 'project.eml' })
      expect(results).toHaveLength(1)
      expect(results[0].content).toBe('EML decision')
    })

    it('filters by type', () => {
      const results = eml.engrams.query({ type: 'rule' })
      expect(results).toHaveLength(1)
    })

    it('filters by title', () => {
      const results = eml.engrams.query({ title: 'BTC' })
      expect(results).toHaveLength(1)
    })

    it('filters by significance', () => {
      const results = eml.engrams.query({ significance: 'high' })
      expect(results).toHaveLength(1)
    })

    it('fulltext search', () => {
      const results = eml.engrams.query({ search: 'workflow' })
      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('rule')
    })

    it('orders by significance', () => {
      const results = eml.engrams.query({ order_by: 'significance' })
      expect(results[0].significance).toBe('high')
      expect(results[results.length - 1].significance).toBe('low')
    })

    it('respects limit and offset', () => {
      const page1 = eml.engrams.query({ limit: 2, offset: 0 })
      const page2 = eml.engrams.query({ limit: 2, offset: 2 })
      expect(page1).toHaveLength(2)
      expect(page2).toHaveLength(1)
    })

    it('filters by has_relations', () => {
      const noRels = eml.engrams.query({ has_relations: false })
      expect(noRels).toHaveLength(3)

      const withRels = eml.engrams.query({ has_relations: true })
      expect(withRels).toHaveLength(0)
    })
  })

  // ============================================================
  // Decay
  // ============================================================
  // v0.8 C7: the decay mechanism is not active — decay_model/decay_params live in
  // properties (instead of top level), but nothing evaluates them. The old decay
  // tests are removed because engram.decay_factor is no longer set.
  describe('significance weight', () => {
    it('significance weight mapping', () => {
      expect(significanceWeight('critical')).toBe(1.0)
      expect(significanceWeight('normal')).toBe(0.5)
      expect(significanceWeight('trivial')).toBe(0.1)
    })
  })

  // ============================================================
  // FTS
  // ============================================================
  describe('fts', () => {
    it('searches across content', () => {
      eml.engrams.store(validDecision({ content: 'SQLite is the database engine', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'PostgreSQL is not used', scope: 'project.eml' }))

      const results = eml.engrams.query({ search: 'SQLite' })
      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('SQLite')
    })
  })

  // ============================================================
  // v0.10.5: search_mode (recall AND→OR fix)
  // ============================================================
  describe('search_mode (v0.10.5)', () => {
    it("'or' matches engrams containing ANY token; default 'and' requires ALL", () => {
      eml.engrams.store(validDecision({ content: 'Turso migration planned', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'SQLite chosen as engine', scope: 'project.eml' }))

      // No single engram contains both 'turso' and 'sqlite'.
      const andResults = eml.engrams.query({ search: 'turso sqlite' }) // default 'and'
      expect(andResults).toHaveLength(0)

      const orResults = eml.engrams.query({ search: 'turso sqlite', search_mode: 'or' })
      expect(orResults).toHaveLength(2)
    })

    it("default 'and' still narrows to engrams containing ALL tokens", () => {
      eml.engrams.store(validDecision({ content: 'Turso migration planned for Q2', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'Turso evaluation only', scope: 'project.eml' }))

      const results = eml.engrams.query({ search: 'turso migration' }) // 'and'
      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('migration')
    })

    it("'or' is the multi-word fix: a phrase query that AND-misses now hits", () => {
      // Reproduces the 2026-05-25 prod failure shape: tokens spread across
      // different engrams → AND returns 0, OR returns the union.
      eml.engrams.store(validDecision({ content: 'delivery pipeline notes', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'channel selection rationale', scope: 'project.eml' }))

      expect(eml.engrams.query({ search: 'delivery channel' })).toHaveLength(0)
      expect(eml.engrams.query({ search: 'delivery channel', search_mode: 'or' })).toHaveLength(2)
    })

    it('whitespace-only search does not throw and applies no text filter', () => {
      eml.engrams.store(validDecision({ content: 'anything at all', scope: 'project.eml' }))

      expect(() => eml.engrams.query({ search: '   ' })).not.toThrow()
      expect(() => eml.engrams.query({ search: '   ', search_mode: 'or' })).not.toThrow()
      // No tokens → no text constraint → engram still returned.
      expect(eml.engrams.query({ search: '   ' })).toHaveLength(1)
    })

    it("'or' tolerates extra internal whitespace between tokens", () => {
      eml.engrams.store(validDecision({ content: 'alpha topic', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'beta topic', scope: 'project.eml' }))

      const results = eml.engrams.query({ search: 'alpha    beta', search_mode: 'or' })
      expect(results).toHaveLength(2)
    })
  })

  // ============================================================
  // v0.10.5: statuses set (recall surfaces active + planned)
  // ============================================================
  describe('statuses set (v0.10.5)', () => {
    it("filters to a status SET (recall's {active, planned}); excludes historical states", () => {
      // active knowledge, open work, and a dead/historical engram sharing a term.
      eml.engrams.store(validDecision({ content: 'kappa active fact', scope: 'project.eml', status: 'active' }))
      eml.engrams.store({ content: 'kappa open work', type: 'task', scope: 'project.eml', status: 'planned' })
      eml.engrams.store({ content: 'kappa old state', type: 'status', scope: 'project.eml', status: 'superseded', properties: { state: 'old' } })

      const live = eml.engrams.query({ search: 'kappa', statuses: ['active', 'planned'] })
      expect(live).toHaveLength(2)
      expect(live.map(e => e.status).sort()).toEqual(['active', 'planned'])

      // History stays reachable via single-status filter (the list path).
      const history = eml.engrams.query({ search: 'kappa', status: 'superseded' })
      expect(history).toHaveLength(1)
      expect(history[0].status).toBe('superseded')
    })

    it('statuses takes precedence over single status when both are passed', () => {
      eml.engrams.store(validDecision({ content: 'lambda active', scope: 'project.eml', status: 'active' }))
      eml.engrams.store({ content: 'lambda planned', type: 'task', scope: 'project.eml', status: 'planned' })

      // statuses wins → both returned, single `status: 'active'` ignored.
      const results = eml.engrams.query({ search: 'lambda', status: 'active', statuses: ['active', 'planned'] })
      expect(results).toHaveLength(2)
    })
  })

  // ============================================================
  // v0.10.5: bm25 relevance ranking + bucket-tiebreak (recall path)
  // ============================================================
  describe('bm25 ranking (v0.10.5)', () => {
    it('relevance leads over significance: a dense trivial match outranks a sparse critical one', () => {
      // 'zeta' dense + dedicated (strong bm25) but trivial significance.
      eml.engrams.store(validDecision({ content: 'zeta zeta zeta dedicated note', scope: 'project.eml', significance: 'trivial' }))
      // 'zeta' once inside a long unrelated passage (weak bm25) but critical.
      eml.engrams.store(validDecision({ content: 'zeta appears once inside a very long passage about many entirely unrelated subjects and other matters', scope: 'project.eml', significance: 'critical' }))

      const results = eml.engrams.query({ search: 'zeta', order_by: 'score' })
      expect(results).toHaveLength(2)
      // bm25 leads → the dense (trivial) match is first, despite lower significance.
      expect(results[0].significance).toBe('trivial')
    })

    it('bucket-tiebreak: equally-relevant matches are ordered by significance', () => {
      // Identical content → identical bm25 rank → same relevance bucket →
      // significance × recency breaks the tie.
      eml.engrams.store(validDecision({ content: 'omega identical body text', scope: 'project.eml', significance: 'normal', title: 'low-sig' }))
      eml.engrams.store(validDecision({ content: 'omega identical body text', scope: 'project.eml', significance: 'critical', title: 'high-sig' }))

      const results = eml.engrams.query({ search: 'omega', order_by: 'score' })
      expect(results).toHaveLength(2)
      expect(results[0].title).toBe('high-sig') // critical wins the tie
    })

    it('does not leak the transient bm25_rank column into results', () => {
      eml.engrams.store(validDecision({ content: 'psi searchable content', scope: 'project.eml' }))
      const results = eml.engrams.query({ search: 'psi', order_by: 'score' })
      expect(results).toHaveLength(1)
      expect(results[0]).not.toHaveProperty('bm25_rank')
    })

    it('orders a 3-engram relevance gradient by bm25, significance held equal', () => {
      // Equal doc length (10 tokens) + equal significance → only the query-term
      // frequency (9/3/1) drives bm25. The 9/3/1 spread is deliberately steep so
      // every consecutive bm25 gap exceeds BM25_RELEVANCE_EPS (0.15): the three land
      // in DISTINCT relevance buckets, so pure bm25 order holds and the recency
      // tiebreak never engages. (A shallower 3/2/1 spread puts tf3+tf2 inside one
      // bucket — gap ~0.12 < EPS — where recency, not frequency, would decide.)
      eml.engrams.store(validDecision({ content: 'rho rho rho rho rho rho rho rho rho filler', scope: 'project.eml', significance: 'normal', title: 'tf3' }))
      eml.engrams.store(validDecision({ content: 'rho rho rho filler filler filler filler filler filler filler', scope: 'project.eml', significance: 'normal', title: 'tf2' }))
      eml.engrams.store(validDecision({ content: 'rho filler filler filler filler filler filler filler filler filler', scope: 'project.eml', significance: 'normal', title: 'tf1' }))

      const results = eml.engrams.query({ search: 'rho', order_by: 'score' })
      expect(results.map(e => e.title)).toEqual(['tf3', 'tf2', 'tf1'])
    })

    it('list path (non-score) is unaffected: keeps AND default + created_at order', () => {
      eml.engrams.store(validDecision({ content: 'chi alpha', scope: 'project.eml' }))
      eml.engrams.store(validDecision({ content: 'chi beta', scope: 'project.eml' }))

      // No order_by → default path, default AND. 'chi' matches both.
      const both = eml.engrams.query({ search: 'chi' })
      expect(both).toHaveLength(2)
      // AND across distinct engrams still yields 0 (default mode unchanged).
      expect(eml.engrams.query({ search: 'alpha beta' })).toHaveLength(0)
    })
  })

  // ============================================================
  // v0.10.5: bucketByRelevance EPS gate — synthetic ranks, no FTS dependency
  // ============================================================
  describe('bucketByRelevance EPS gate (v0.10.5)', () => {
    // scoreFn reads a plain numeric significance marker; no recency, fully
    // deterministic. Higher = ranks first within a bucket.
    const score = (e: { id: string; sig: number }) => e.sig

    it('within EPS of the bucket anchor → significance reorders; beyond → own bucket', () => {
      const ranked = [
        { engram: { id: 'A', sig: 1 }, rank: -1.0 },  // best relevance, low sig
        { engram: { id: 'B', sig: 5 }, rank: -0.90 }, // gap 0.10 < 0.15 → same bucket as A
        { engram: { id: 'C', sig: 9 }, rank: -0.80 }, // gap 0.20 from anchor A → new bucket
      ]
      // Bucket1 [A,B] → sig reorders → B before A. Bucket2 [C] stays after.
      expect(bucketByRelevance(ranked, score, 0.15).map(e => e.id)).toEqual(['B', 'A', 'C'])
    })

    it('beyond EPS, relevance order holds even against higher significance', () => {
      const ranked = [
        { engram: { id: 'X', sig: 1 }, rank: -1.0 },
        { engram: { id: 'Y', sig: 9 }, rank: -0.5 }, // gap 0.5 > 0.15 → separate buckets
      ]
      // Different buckets → bm25 order wins → X first despite Y's higher sig.
      expect(bucketByRelevance(ranked, score, 0.15).map(e => e.id)).toEqual(['X', 'Y'])
    })

    it('a gap exactly at EPS is a relevance step (gate is strict <)', () => {
      const ranked = [
        { engram: { id: 'P', sig: 1 }, rank: -1.0 },
        { engram: { id: 'Q', sig: 9 }, rank: -0.85 }, // gap exactly 0.15 → NOT < 0.15
      ]
      expect(bucketByRelevance(ranked, score, 0.15).map(e => e.id)).toEqual(['P', 'Q'])
    })
  })

  // ============================================================
  // v0.10.5: recall DISPLAY rendering (identify, don't dump)
  // ============================================================
  describe('renderRecallMarkdown DISPLAY (v0.10.5)', () => {
    const hit = (over: Record<string, unknown> = {}) => ({
      id: 'id-x', type: 'log', significance: 'high',
      scope: 'project.eml', title: 'subj', content: 'body',
      properties: { context: 'HUGE_CONTEXT_BLOB', source_id: 'assistant' },
      ...over,
    })

    it('caps long content to a preview with an ellipsis', () => {
      const md = renderRecallMarkdown('q', [hit({ content: 'x'.repeat(500) })] as any)
      expect(md).toContain('x'.repeat(200) + '…')
      expect(md).not.toContain('x'.repeat(201)) // nothing beyond the cap
    })

    it('shows short content fully without ellipsis', () => {
      const md = renderRecallMarkdown('q', [hit({ content: 'short body here' })] as any)
      expect(md).toContain('short body here')
      expect(md).not.toContain('…')
    })

    it('collapses newlines and whitespace in the preview', () => {
      const md = renderRecallMarkdown('q', [hit({ content: 'line one\n\n## head\nline two' })] as any)
      expect(md).toContain('line one ## head line two')
    })

    it('includes the full id and drops the properties dump', () => {
      const md = renderRecallMarkdown('q', [hit({ id: 'f4f3f8ae-34ed-486f-8f6c-4a05bbf9ae35' })] as any)
      expect(md).toContain('id: f4f3f8ae-34ed-486f-8f6c-4a05bbf9ae35')
      expect(md).not.toContain('HUGE_CONTEXT_BLOB') // properties not rendered
      expect(md).not.toContain('source_id: assistant')
    })

    it('meta line is [type | significance | scope | title]', () => {
      const md = renderRecallMarkdown('q', [hit()] as any)
      expect(md).toContain('[log | high | project.eml | subj]')
    })
  })

  // ============================================================
  // v0.10.5: eml_show dashboard rendering (bounded, identify-don't-dump)
  // ============================================================
  describe('renderBrainStateMarkdown DISPLAY (v0.10.5)', () => {
    const state = (over: Record<string, unknown> = {}) => ({
      scope: 'project.eml',
      current_status: [], open_tasks: [], recent_decisions: [], recent_logs: [], rules: [],
      ...over,
    })

    it('status shows [state] + capped preview + next_step + id', () => {
      const md = renderBrainStateMarkdown(state({
        current_status: [{ id: 'st-1', type: 'status', significance: 'high', scope: 'project.eml', title: 's',
          content: 'y'.repeat(400), properties: { state: 'v0.10.4-shipped', next_step: 'do v0.10.5' } }],
      }) as any)
      expect(md).toContain('[v0.10.4-shipped]')
      expect(md).toContain('next: do v0.10.5')
      expect(md).toContain('· st-1')
      expect(md).toContain('y'.repeat(160) + '…')
      expect(md).not.toContain('y'.repeat(161))
    })

    it('tasks show [priority·status] title — preview · id', () => {
      const md = renderBrainStateMarkdown(state({
        open_tasks: [{ id: 't-1', type: 'task', status: 'planned', title: 'eml-show-bounded',
          content: 'cap eml_show per section', properties: { priority: 'high' } }],
      }) as any)
      expect(md).toContain('## Open tasks (1)')
      expect(md).toContain('[high·planned] eml-show-bounded — cap eml_show per section · t-1')
    })

    it('decisions and rules are titles-only (no body)', () => {
      const md = renderBrainStateMarkdown(state({
        recent_decisions: [{ id: 'd-1', type: 'decision', title: 'read-layer-architecture', content: 'LONG_RATIONALE_BODY' }],
        rules: [{ id: 'r-1', type: 'rule', title: 'eml-no-workarounds', content: 'RULE_BODY_TEXT' }],
      }) as any)
      expect(md).toContain('- read-layer-architecture · d-1')
      expect(md).not.toContain('LONG_RATIONALE_BODY')
      expect(md).toContain('- eml-no-workarounds · r-1')
      expect(md).not.toContain('RULE_BODY_TEXT')
    })

    it('never renders relations (dropped from the dashboard)', () => {
      const md = renderBrainStateMarkdown(state({
        relations: [{ id: 'rel-1', source_id: 'a', target_id: 'b', relation: 'supersedes' }],
      }) as any)
      expect(md).not.toContain('rel-1')
      expect(md).not.toMatch(/relations/i)
    })
  })

  // v0.8 C7: access_count + last_accessed_at deleted — no tracking anymore.
  // Tests removed.

  // ============================================================
  // Recall (query-level tests)
  // ============================================================
  describe('recall (FTS search)', () => {
    it('finds engrams by content search', () => {
      eml.engrams.store({ content: 'Turso migration is planned for Q2', type: 'status', scope: 'project.eml', properties: { state: 'planned' } })
      eml.engrams.store({ content: 'Assistant is a digital moth', type: 'profile', scope: 'global', properties: {} })

      const results = eml.engrams.query({ search: 'turso migration', limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('Turso')
    })
  })

  // ============================================================
  // v0.3: task type
  // ============================================================
  describe('v0.3: task type', () => {
    it('stores task with minimal properties (content only) — v0.8: default status=planned', () => {
      const engram = eml.engrams.store({
        content: 'Extend SETUP.md with section 3.3',
        type: 'task',
        scope: 'project.eml',
      })
      expect(engram.type).toBe('task')
      // v0.8 C1: TYPE_DEFAULT_STATUS — task defaults to 'planned' (workflow lifecycle).
      expect(engram.status).toBe('planned')
    })

    it('stores task with full properties', () => {
      const engram = eml.engrams.store({
        content: 'Deploy EML v0.3 to the VPS',
        type: 'task',
        scope: 'project.eml',
        status: 'planned',
        significance: 'high',
        properties: {
          due_date: '2026-05-01',
          assignee_id: 'alice',
          priority: 'high',
          context: 'Blocks assistant dogfooding of v0.3 features',
        },
      })
      expect(engram.status).toBe('planned')
      expect(engram.properties).toEqual({
        due_date: '2026-05-01',
        assignee_id: 'alice',
        priority: 'high',
        context: 'Blocks assistant dogfooding of v0.3 features',
      })
    })

    it('task status transitions (planned → active → resolved)', () => {
      const engram = eml.engrams.store({
        content: 'Carry out the schema migration',
        type: 'task',
        scope: 'project.eml',
        status: 'planned',
      })
      let updated = eml.engrams.update(engram.id, { status: 'active' })
      expect(updated?.status).toBe('active')
      updated = eml.engrams.update(engram.id, { status: 'resolved', properties: { outcome: 'migrated' } })
      expect(updated?.status).toBe('resolved')
    })

    it('task without assignee is allowed (unassigned)', () => {
      const engram = eml.engrams.store({
        content: 'Someone should clean up the docs',
        type: 'task',
        scope: 'project.eml',
      })
      expect(engram.properties).toBeNull()
    })
  })

  // ============================================================
  // v0.3: event type (with immutability)
  // ============================================================
  describe('v0.3: event type', () => {
    it('stores event with required properties', () => {
      const engram = eml.engrams.store({
        content: 'EML API v0.3 deployed',
        type: 'event',
        scope: 'project.eml',
        properties: {
          occurred_at: '2026-04-20T12:00:00Z',
          change_type: 'deployed',
          previous_state: 'v0.2',
          new_state: 'v0.3',
          triggered_by: 'alice',
        },
      })
      expect(engram.properties?.change_type).toBe('deployed')
    })

    it('throws for an event without occurred_at', () => {
      expect(() => {
        eml.engrams.store({
          content: 'broken event',
          type: 'event',
          scope: 'project.eml',
          properties: { change_type: 'deployed' },
        })
      }).toThrow(/occurred_at/)
    })

    it('throws for an event without change_type', () => {
      expect(() => {
        eml.engrams.store({
          content: 'broken event',
          type: 'event',
          scope: 'project.eml',
          properties: { occurred_at: '2026-04-20T12:00:00Z' },
        })
      }).toThrow(/change_type/)
    })
  })

  // ============================================================
  // v0.3: event immutability enforcement
  // ============================================================
  describe('v0.3: event immutability', () => {
    it('update() throws on a content change to an event', () => {
      const engram = eml.engrams.store({
        content: 'API deployed',
        type: 'event',
        scope: 'project.eml',
        properties: { occurred_at: '2026-04-20T12:00:00Z', change_type: 'deployed' },
      })
      expect(() => {
        eml.engrams.update(engram.id, { content: 'API redeployed' })
      }).toThrow(/Cannot modify event fields/)
    })

    it('update() throws on a properties change to an event', () => {
      const engram = eml.engrams.store({
        content: 'API deployed',
        type: 'event',
        scope: 'project.eml',
        properties: { occurred_at: '2026-04-20T12:00:00Z', change_type: 'deployed' },
      })
      expect(() => {
        eml.engrams.update(engram.id, { properties: { occurred_at: '2026-04-20T13:00:00Z', change_type: 'deployed' } })
      }).toThrow(/Cannot modify event fields/)
    })

    it('update() allows a significance change on an event', () => {
      const engram = eml.engrams.store({
        content: 'API deployed',
        type: 'event',
        scope: 'project.eml',
        properties: { occurred_at: '2026-04-20T12:00:00Z', change_type: 'deployed' },
      })
      const updated = eml.engrams.update(engram.id, { significance: 'critical' })
      expect(updated?.significance).toBe('critical')
    })

    it('update() allows a status change on an event (all values)', () => {
      const engram = eml.engrams.store({
        content: 'Duplicate event',
        type: 'event',
        scope: 'project.eml',
        properties: { occurred_at: '2026-04-20T12:00:00Z', change_type: 'deployed' },
      })
      const superseded = eml.engrams.update(engram.id, { status: 'invalidated' })
      expect(superseded?.status).toBe('invalidated')
    })

    it('update() on non-event types still works (regression)', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'Original Decision',
        scope: 'project.eml',
      }))
      const updated = eml.engrams.update(engram.id, { content: 'Updated Decision' })
      expect(updated?.content).toBe('Updated Decision')
    })
  })

  // ============================================================
  // v0.3: log type
  // ============================================================
  describe('v0.3: log type', () => {
    it('stores log with minimal content (no properties)', () => {
      const engram = eml.engrams.store({
        content: 'Session with Alice today on the v0.3 design',
        type: 'log',
        scope: 'project.eml',
      })
      expect(engram.type).toBe('log')
    })

    it('stores log with occurred_at + session_id (v0.8: source in properties)', () => {
      const engram = eml.engrams.store({
        content: 'Design decision: engram as the umbrella term',
        type: 'log',
        scope: 'project.eml',
        title: 'v0.3-proposal',
        session_id: '2026-04-20-v03-design-a7c3b2',
        // v0.8 C7: source_* live in properties (ad hoc for context types).
        properties: {
          occurred_at: '2026-04-20T11:30:00Z',
          source_id: 'assistant',
          source_type: 'agent',
        },
      })
      expect(engram.session_id).toBe('2026-04-20-v03-design-a7c3b2')
      const props = engram.properties as Record<string, any>
      expect(props.source_id).toBe('assistant')
      expect(props.source_type).toBe('agent')
      expect(props.occurred_at).toBe('2026-04-20T11:30:00Z')
    })

    it('log is not immutable — update() works', () => {
      const engram = eml.engrams.store({
        content: 'First note',
        type: 'log',
        scope: 'project.eml',
      })
      const updated = eml.engrams.update(engram.id, { content: 'Corrected note' })
      expect(updated?.content).toBe('Corrected note')
    })
  })

  // ============================================================
  // v0.5: ProfileType removed entirely — core identity data lives in entity tables,
  // facets remain as profile engrams without a profile_type field.
  // ============================================================
  describe('v0.5: ProfileType removed', () => {
    it('accepts a profile engram without profile_type', () => {
      const engram = eml.engrams.store({
        content: 'Assistant workstyle',
        type: 'profile',
        scope: 'agent.assistant',
        title: 'workstyle',
        properties: {},
      })
      expect(engram.type).toBe('profile')
      // v0.8 C9: profile automatically gets review_due_at (180d).
      expect((engram.properties as any).review_due_at).toBeDefined()
    })

    it('accepts a profile engram with other properties (title carries the facet info)', () => {
      const engram = eml.engrams.store({
        content: 'Erin, Grace — family',
        type: 'profile',
        scope: 'user.alice',
        title: 'family',
        properties: { since: '2025-10-09' },
      })
      expect(engram.title).toBe('family')
      expect(engram.properties?.since).toBe('2025-10-09')
    })
  })

  // ============================================================
  // v0.3: blocks relation
  // ============================================================
  describe('v0.3: blocks relation', () => {
    it('stores a blocks relation between two tasks', () => {
      const blocker = eml.engrams.store({
        content: 'Migration must go through',
        type: 'task',
        scope: 'project.eml',
        status: 'active',
      })
      const blocked = eml.engrams.store({
        content: 'Deploy feature X',
        type: 'task',
        scope: 'project.eml',
        status: 'planned',
      })
      eml.engrams.relate({
        source_id: blocker.id,
        target_id: blocked.id,
        relation: 'blocks',
        detection_method: 'manual',
      })
      const full = eml.engrams.get(blocked.id)
      const blockedRel = full?.relations.find(r => r.relation === 'blocks')
      expect(blockedRel).toBeDefined()
      expect(blockedRel?.source_id).toBe(blocker.id)
    })
  })

  // ============================================================
  // v0.3: bug fix — pass /store status through
  // ============================================================
  describe('v0.3: status pass-through (bug-fix regression)', () => {
    it('store({status: planned}) lands as planned in the DB', () => {
      const engram = eml.engrams.store({
        content: 'Planned Task',
        type: 'task',
        scope: 'project.eml',
        status: 'planned',
      })
      expect(engram.status).toBe('planned')
    })

    it('store without status defaults to active', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'Default Status',
        scope: 'global',
      }))
      expect(engram.status).toBe('active')
    })
  })

  // ============================================================
  // v0.4: Projects (First-Class Entity)
  // ============================================================
  describe('v0.4: ProjectStore CRUD', () => {
    beforeEach(() => resetEntities(eml))
    it('create stores project with required fields', () => {
      const project = eml.projects.create({ id: 'eml', name: 'EML' })
      expect(project.id).toBe('eml')
      expect(project.name).toBe('EML')
      expect(project.status).toBe('active')
    })

    it('create accepts all optional fields', () => {
      const project = eml.projects.create({
        id: 'acme-app',
        name: 'Acme App',
        goal: 'Source reliability',
        description: 'Cardano ecosystem',
        owner: 'alice',
        tags: ['cardano', 'research'],
        started_at: '2026-01-01',
        metadata: { repo: 'example/acme-app' },
      })
      expect(project.goal).toBe('Source reliability')
      expect(project.owner).toBe('alice')
      expect(project.tags).toEqual(['cardano', 'research'])
      expect(project.metadata?.repo).toBe('example/acme-app')
    })

    it('get returns null for unknown id', () => {
      expect(eml.projects.get('missing')).toBeNull()
    })

    it('exists check', () => {
      eml.projects.create({ id: 'eml', name: 'EML' })
      expect(eml.projects.exists('eml')).toBe(true)
      expect(eml.projects.exists('missing')).toBe(false)
    })

    it('list filters by status', () => {
      eml.projects.create({ id: 'a', name: 'A', status: 'active' })
      eml.projects.create({ id: 'b', name: 'B', status: 'archived' })
      expect(eml.projects.list().length).toBe(2)
      expect(eml.projects.list({ status: 'archived' }).length).toBe(1)
      expect(eml.projects.list({ status: 'archived' })[0].id).toBe('b')
    })

    it('update partial patches', () => {
      eml.projects.create({ id: 'eml', name: 'EML', goal: 'initial' })
      const updated = eml.projects.update('eml', { goal: 'updated', status: 'paused' })
      expect(updated?.goal).toBe('updated')
      expect(updated?.status).toBe('paused')
      expect(updated?.name).toBe('EML')
    })

    it('update returns null for unknown id', () => {
      expect(eml.projects.update('missing', { name: 'x' })).toBeNull()
    })

    it('create enforces parent FK when parent exists', () => {
      eml.projects.create({ id: 'parent', name: 'Parent' })
      const child = eml.projects.create({ id: 'child', name: 'Child', parent_project: 'parent' })
      expect(child.parent_project).toBe('parent')
    })

    it('prevents direct self-cycle', () => {
      expect(() => eml.projects.create({ id: 'eml', name: 'EML', parent_project: 'eml' }))
        .toThrow(/cannot be its own parent/)
    })

    it('prevents indirect cycle via update', () => {
      eml.projects.create({ id: 'a', name: 'A' })
      eml.projects.create({ id: 'b', name: 'B', parent_project: 'a' })
      expect(() => eml.projects.update('a', { parent_project: 'b' }))
        .toThrow(/cycle/)
    })
  })

  // v0.8 C3: the soft warning became a hard throw. Tests adjusted.
  describe('v0.8 C3: hard scope validation (was: v0.4 soft)', () => {
    it('store with unknown project scope throws', () => {
      expect(() => eml.engrams.store({
        content: 'task for unknown project',
        type: 'task',
        scope: 'project.nonexistent',
      })).toThrow(/unknown project "nonexistent"/)
    })

    it('store with known project scope succeeds', () => {
      // 'eml' is already registered via seedScopeFixtures
      const engram = eml.engrams.store({
        content: 'task for known project',
        type: 'task',
        scope: 'project.eml',
      })
      expect(engram).toBeDefined()
    })

    it('store with global scope succeeds (no existence check)', () => {
      const e1 = eml.engrams.store(validDecision({ content: 'a', scope: 'global' }))
      expect(e1).toBeDefined()
    })

    // v0.8 C2: external.* is dropped — the newly validated pattern is entity.*
    it('store with external.* scope throws (v0.8 C2: rename → entity)', () => {
      expect(() => eml.engrams.store({
        content: 'b', type: 'note', scope: 'external.charles_hoskinson',
      })).toThrow(/Invalid scope/)
    })

    it('store with invalid scope pattern throws', () => {
      expect(() => eml.engrams.store(validDecision({
        content: 'x', scope: 'foo.bar',
      }))).toThrow(/Invalid scope/)
    })

    it('update throws when scope changes to unknown project', () => {
      const engram = eml.engrams.store(validDecision({
        content: 'x', scope: 'global',
      }))
      expect(() => eml.engrams.update(engram.id, { scope: 'project.unknown' }))
        .toThrow(/unknown project "unknown"/)
    })
  })

  describe('v0.4: ProjectBrainState aggregation', () => {
    // 'eml' already comes from seedScopeFixtures — no extra create().

    it('returns null for unknown project', () => {
      expect(eml.projects.getBrainState('missing', 'test')).toBeNull()
    })

    it('aggregates status, tasks, decisions, logs, relations', () => {
      eml.engrams.store({ content: 'API running', type: 'status', scope: 'project.eml', properties: { state: 'live' } })
      eml.engrams.store({ content: 'Write tests', type: 'task', scope: 'project.eml', status: 'planned', properties: { priority: 'high' } })
      eml.engrams.store({ content: 'Deploy v0.4', type: 'task', scope: 'project.eml', status: 'active', properties: { priority: 'urgent' } })
      eml.engrams.store(validTask({ content: 'Resolved task', scope: 'project.eml', status: 'resolved' }))
      eml.engrams.store(validDecision({ content: 'Use SQLite', scope: 'project.eml', significance: 'critical' }))
      eml.engrams.store(validDecision({ content: 'Normal decision', scope: 'project.eml', significance: 'normal' }))
      eml.engrams.store({ content: 'Session with alice', type: 'log', scope: 'project.eml' })

      const state = eml.projects.getBrainState('eml')
      expect(state).not.toBeNull()
      expect(state!.project.id).toBe('eml')
      expect(state!.current_status.length).toBe(1)
      expect(state!.open_tasks.length).toBe(2)
      expect(state!.recent_decisions.length).toBe(2)
      expect(state!.recent_logs.length).toBe(1)
    })

    it('open_tasks sorted by priority (urgent > high > normal > low)', () => {
      eml.engrams.store({ content: 'low', type: 'task', scope: 'project.eml', status: 'planned', properties: { priority: 'low' } })
      eml.engrams.store({ content: 'urgent', type: 'task', scope: 'project.eml', status: 'planned', properties: { priority: 'urgent' } })
      eml.engrams.store({ content: 'high', type: 'task', scope: 'project.eml', status: 'active', properties: { priority: 'high' } })
      const state = eml.projects.getBrainState('eml')!
      expect(state.open_tasks.map(t => t.content)).toEqual(['urgent', 'high', 'low'])
    })

    it('recent_decisions sorted by significance DESC', () => {
      eml.engrams.store(validDecision({ content: 'normal', scope: 'project.eml', significance: 'normal' }))
      eml.engrams.store(validDecision({ content: 'critical', scope: 'project.eml', significance: 'critical' }))
      eml.engrams.store(validDecision({ content: 'high', scope: 'project.eml', significance: 'high' }))
      const state = eml.projects.getBrainState('eml')!
      expect(state.recent_decisions.map(d => d.content)).toEqual(['critical', 'high', 'normal'])
    })

    // v0.9.1 Cluster 1: namespace filter removed from BrainState — the corresponding test is obsolete.
  })

  // ============================================================
  // v0.5: UserStore CRUD
  // ============================================================
  describe('v0.5: UserStore CRUD', () => {
    beforeEach(() => resetEntities(eml))
    it('creates and retrieves a user', () => {
      const user = eml.users.create({
        id: 'alice',
        name: 'Alice Smith',
        email: 'alice@example.com',
        description: 'EML-Owner',
      })
      expect(user.id).toBe('alice')
      expect(user.name).toBe('Alice Smith')
      expect(user.email).toBe('alice@example.com')

      const retrieved = eml.users.get('alice')
      expect(retrieved?.name).toBe('Alice Smith')
    })

    it('returns null for unknown user', () => {
      expect(eml.users.get('missing')).toBeNull()
    })

    it('lists users', () => {
      eml.users.create({ id: 'alice', name: 'Alice' })
      eml.users.create({ id: 'erin', name: 'Erin' })
      const list = eml.users.list()
      expect(list.length).toBe(2)
      expect(list.map(u => u.id).sort()).toEqual(['alice', 'erin'])
    })

    it('updates user fields', () => {
      eml.users.create({ id: 'alice', name: 'D' })
      const updated = eml.users.update('alice', { name: 'Alice S.', email: 'd@x.com' })
      expect(updated?.name).toBe('Alice S.')
      expect(updated?.email).toBe('d@x.com')
    })

    it('exists() returns true/false', () => {
      eml.users.create({ id: 'alice', name: 'D' })
      expect(eml.users.exists('alice')).toBe(true)
      expect(eml.users.exists('missing')).toBe(false)
    })

    it('persists metadata as JSON', () => {
      eml.users.create({
        id: 'alice',
        name: 'D',
        metadata: { role: 'owner', timezone: 'Europe/Berlin' },
      })
      const u = eml.users.get('alice')
      expect(u?.metadata).toEqual({ role: 'owner', timezone: 'Europe/Berlin' })
    })
  })

  // ============================================================
  // v0.5: AgentStore extensions
  // ============================================================
  describe('v0.5: AgentStore extensions', () => {
    beforeEach(() => resetEntities(eml))
    // v0.6: type test removed — agents.type column dropped

    // v0.9 Cluster 1: default_namespace tests removed (column dropped).

    it('exists() returns true/false', () => {
      eml.agents.store({ id: 'assistant', name: 'Assistant' })
      expect(eml.agents.exists('assistant')).toBe(true)
      expect(eml.agents.exists('missing')).toBe(false)
    })

    it('updates name + domains', () => {
      eml.agents.store({ id: 'assistant', name: 'Assistant', domains: ['dev'] })
      const updated = eml.agents.update('assistant', {
        name: 'Assistant 2.0',
        domains: ['dev', 'strategy'],
      })
      expect(updated?.name).toBe('Assistant 2.0')
      expect(updated?.domains).toEqual(['dev', 'strategy'])
    })
  })

  // ============================================================
  // v0.8 C3: hard scope validation for user.X + agent.X (was: v0.5 soft).
  // ============================================================
  describe('v0.8 C3: hard scope validation user/agent', () => {
    it('throws on store with unknown user scope', () => {
      expect(() => eml.engrams.store({
        content: 'mention',
        type: 'note',
        scope: 'user.unknown',
      })).toThrow(/unknown user "unknown"/)
    })

    it('throws on store with unknown agent scope', () => {
      expect(() => eml.engrams.store({
        content: 'mention',
        type: 'note',
        scope: 'agent.scout-x',
      })).toThrow(/unknown agent "scout-x"/)
    })

    it('succeeds when user/agent exists', () => {
      // alice + assistant are registered via seedScopeFixtures
      const a = eml.engrams.store({ content: 'a', type: 'profile', scope: 'user.alice', title: 'workstyle' })
      const b = eml.engrams.store({ content: 'b', type: 'profile', scope: 'agent.assistant', title: 'identity' })
      expect(a).toBeDefined()
      expect(b).toBeDefined()
    })

    it('throws on store with unknown entity scope', () => {
      expect(() => eml.engrams.store({
        content: 'mention',
        type: 'note',
        scope: 'entity.unknown-person',
      })).toThrow(/unknown entity "unknown-person"/)
    })

    it('succeeds for entity.<id> when entity exists', () => {
      // 'bob' is registered as an entity via seedScopeFixtures
      const e = eml.engrams.store({
        content: 'note about bob', type: 'note',
        scope: 'entity.bob',
      })
      expect(e).toBeDefined()
    })

    // v0.8 C2: external.* is dropped — entity.* is the new container.
    it('throws for external.X scopes (v0.8 C2: rename → entity)', () => {
      expect(() => eml.engrams.store({
        content: 'note about external person',
        type: 'note',
        scope: 'external.charles_hoskinson',
      })).toThrow(/Invalid scope/)
    })

    it('throws on update when scope changes to unknown user/agent', () => {
      const engram = eml.engrams.store(validDecision({ content: 'x', scope: 'global' }))
      expect(() => eml.engrams.update(engram.id, { scope: 'agent.unknown' }))
        .toThrow(/unknown agent "unknown"/)
    })
  })

  // v0.9 Cluster 1: multi-tenant + reserved ids ('global'/'master') removed
  // entirely. Neither conflict (namespace='global' and master identity) exists
  // anymore — the test section is obsolete.

  // ============================================================
  // v0.8 C7: source_id + source_type live in properties (ad hoc). Top-level source_id/source_type/source_url/
  // source_name are gone. Filtering via a top-level query is no longer possible —
  // search via search/FTS or JSON properties (a later cluster).
  // ============================================================
  describe('v0.8 C7: source_* in properties', () => {
    it('store with source_* in properties', () => {
      const e = eml.engrams.store({
        content: 'BTC note',
        type: 'note',
        scope: 'global',
        properties: {
          source_id: 'scout-btc',
          source_type: 'agent',
        },
      })
      const props = e.properties as Record<string, any>
      expect(props.source_id).toBe('scout-btc')
      expect(props.source_type).toBe('agent')
    })

    // v0.9.1 Cluster 1 Phase 1.2: source_id/source_type removed from the schema —
    // validateSourceType is no longer called, test obsolete.

    it('source fields are absent from properties when not set', () => {
      // v0.8 C9: a decision automatically gets review_due_at — so not null,
      // but without source fields.
      const e = eml.engrams.store(validDecision({ content: 'a', scope: 'global' }))
      const props = e.properties as Record<string, any> | null
      expect(props).not.toBeNull()
      expect(props!.source_id).toBeUndefined()
      expect(props!.source_type).toBeUndefined()
    })
  })

  // ============================================================
  // v0.7: reference type (context layer)
  // ============================================================
  describe('v0.7: reference type', () => {
    it('stores reference (v0.8: source_url/source_name in properties)', () => {
      const e = eml.engrams.store({
        content: 'Mem0 — vector-based memory layer for agents',
        type: 'reference',
        scope: 'project.eml',
        title: 'competitor-mem0',
        // v0.8 C7: source_url + source_name now live in properties
        // (ReferenceProperties — typed).
        properties: {
          reference_type: 'analysis',
          source_url: 'https://mem0.ai/docs',
          source_name: 'Mem0 Docs',
          accessed_at: '2026-04-28',
        },
      })
      expect(e.type).toBe('reference')
      const props = e.properties as Record<string, any>
      expect(props.source_url).toBe('https://mem0.ai/docs')
      expect(props.reference_type).toBe('analysis')
    })

    it('reference accepts empty properties (all optional)', () => {
      const e = eml.engrams.store({
        content: 'just a pointer', type: 'reference',
        scope: 'project.eml', title: 'rfc-9999',
      })
      expect(e.type).toBe('reference')
      // No properties set is fine
      expect(e.properties).toBeNull()
    })

    it('CHECK constraint accepts reference at DB level', () => {
      // Direct insert via raw db to verify CHECK-Constraint
      // v0.9 Cluster 1: namespace column dropped.
      const raw = (eml as any).db
      const stmt = raw.prepare(`
        INSERT INTO engrams (id, content, type, scope, status, significance, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `)
      expect(() => stmt.run(
        'ref-test-id', 'raw insert', 'reference', 'global', 'active', 'normal'
      )).not.toThrow()
    })
  })

  // ============================================================
  // v0.7: relate Idempotency (UNIQUE + ON CONFLICT IGNORE)
  // ============================================================
  describe('v0.7: relate idempotency', () => {
    let aId: string, bId: string
    beforeEach(() => {
      const a = eml.engrams.store(validDecision({
        content: 'A', scope: 'project.eml',
      }))
      const b = eml.engrams.store(validDecision({
        content: 'B', scope: 'project.eml',
      }))
      aId = a.id
      bId = b.id
    })

    it('two identical relate() calls produce one row', () => {
      eml.engrams.relate({ source_id: aId, target_id: bId, relation: 'supports', detection_method: 'manual' })
      eml.engrams.relate({ source_id: aId, target_id: bId, relation: 'supports', detection_method: 'manual' })
      const rels = (eml as any).db.prepare(
        'SELECT COUNT(*) as c FROM relations WHERE source_id=? AND target_id=? AND relation=?'
      ).get(aId, bId, 'supports') as { c: number }
      expect(rels.c).toBe(1)
    })

    it('first writer wins — second call does not overwrite explanation', () => {
      eml.engrams.relate({
        source_id: aId, target_id: bId, relation: 'supports',
        detection_method: 'manual', explanation: 'first',
      })
      eml.engrams.relate({
        source_id: aId, target_id: bId, relation: 'supports',
        detection_method: 'agent_declared', explanation: 'second',
      })
      const row = (eml as any).db.prepare(
        'SELECT * FROM relations WHERE source_id=? AND target_id=? AND relation=?'
      ).get(aId, bId, 'supports') as any
      expect(row.explanation).toBe('first')
      expect(row.detection_method).toBe('manual')
    })

    it('different relations between same pair are independent', () => {
      eml.engrams.relate({ source_id: aId, target_id: bId, relation: 'supports', detection_method: 'manual' })
      eml.engrams.relate({ source_id: aId, target_id: bId, relation: 'refines', detection_method: 'manual' })
      const rels = (eml as any).db.prepare(
        'SELECT COUNT(*) as c FROM relations WHERE source_id=? AND target_id=?'
      ).get(aId, bId) as { c: number }
      expect(rels.c).toBe(2)
    })
  })

  // v0.9.1 Cluster 1: the namespaces filter in get() + callerNamespace in update()
  // are gone — the v0.7/v0.8 multi-tenant tests are obsolete (1 user = 1 brain).
  describe('v0.9.1: get/update without namespace filter', () => {
    it('get returns engram by id (no namespace filter anymore)', () => {
      const e = eml.engrams.store(validDecision({ content: 'simple', scope: 'global' }))
      const fetched = eml.engrams.get(e.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.content).toBe('simple')
    })

    it('update modifies engram by id (no callerNamespace param anymore)', () => {
      const e = eml.engrams.store(validDecision({ content: 'orig', scope: 'global' }))
      const updated = eml.engrams.update(e.id, { content: 'updated' })
      expect(updated).not.toBeNull()
      expect(updated!.content).toBe('updated')
    })
  })

  // ============================================================
  // v0.8: C8 layer value migration ('knowledge' → 'epistemic')
  // ============================================================

  // ============================================================
  // v0.8: C7 top-level schema cleanup — source_*/decay_* → properties,
  // map ingestion_method values, drop columns.
  // ============================================================

  // ============================================================
  // v0.8 C1: status lifecycle (auto-supersede + TYPE_DEFAULT_STATUS + BrainState filter)
  // ============================================================

  // ============================================================
  // v0.8 C9: brain hygiene review (review_due_at)
  // ============================================================

  // ============================================================
  // v0.8 C2: entity scope rename (external.<x> → entity.<x>)
  // ============================================================

  // ============================================================
  // v0.8 end-to-end: chain a realistic v0.7 snapshot through initDatabase.
  // No direct migrate call — exactly the VPS path (service boot calls
  // initDatabase, which decides the chain from _eml_migrations.MAX(version)).
  // ============================================================

  describe('v0.8 C2: entity scope rename', () => {

    it('post-migration: store with entity.<id> (registered) succeeds', () => {
      // 'bob' is registered as an entity via seedScopeFixtures
      const e = eml.engrams.store({
        content: 'note about bob', type: 'note',
        scope: 'entity.bob',
      })
      expect(e.scope).toBe('entity.bob')
    })

    it('post-migration: store with external.<id> is rejected', () => {
      expect(() => eml.engrams.store({
        content: 'should fail', type: 'note',
        scope: 'external.legacy',
      })).toThrow(/Invalid scope/)
    })
  })

  describe('v0.8 C9: brain hygiene review', () => {
    it('default setter: decision gets review_due_at = now + 60d', () => {
      const t0 = Date.now()
      const e = eml.engrams.store(validDecision({ content: 'd', scope: 'global' }))
      const due = (e.properties as any).review_due_at
      expect(due).toBeDefined()
      const dueMs = new Date(due).getTime()
      const expected = t0 + 60 * 86400_000
      expect(Math.abs(dueMs - expected)).toBeLessThan(5000)   // ±5s tolerance
    })

    it('default setter: rule gets review_due_at = now + 90d', () => {
      const t0 = Date.now()
      const e = eml.engrams.store({
        content: 'r', type: 'rule', scope: 'global',
        properties: { applies: 'situational', trigger: 'when it applies' },
      })
      const dueMs = new Date((e.properties as any).review_due_at).getTime()
      expect(Math.abs(dueMs - (t0 + 90 * 86400_000))).toBeLessThan(5000)
    })

    it('default setter: profile gets review_due_at = now + 180d', () => {
      const t0 = Date.now()
      const e = eml.engrams.store({
        content: 'p', type: 'profile', scope: 'agent.assistant', properties: {},
      })
      const dueMs = new Date((e.properties as any).review_due_at).getTime()
      expect(Math.abs(dueMs - (t0 + 180 * 86400_000))).toBeLessThan(5000)
    })

    it('default setter respects an explicitly set review_due_at', () => {
      const explicit = '2030-01-01T00:00:00.000Z'
      const e = eml.engrams.store(validDecision({
        content: 'd', scope: 'global',
        properties: { review_due_at: explicit },
      }))
      expect((e.properties as any).review_due_at).toBe(explicit)
    })

    it('default setter does NOT apply to note/task/log', () => {
      const o = eml.engrams.store({
        content: 'o', type: 'note', scope: 'global',
      })
      const t = eml.engrams.store({ content: 't', type: 'task', scope: 'global' })
      const l = eml.engrams.store({ content: 'l', type: 'log', scope: 'global' })
      expect((o.properties as any)?.review_due_at).toBeUndefined()
      expect((t.properties as any)?.review_due_at).toBeUndefined()
      expect((l.properties as any)?.review_due_at).toBeUndefined()
    })

    it('confirmReview resets review_due_at (now + default days)', async () => {
      const e = eml.engrams.store(validDecision({
        content: 'old', scope: 'global',
        properties: { review_due_at: '2020-01-01T00:00:00.000Z' },
      }))
      const t0 = Date.now()
      const updated = eml.engrams.confirmReview(e.id)!
      const newDue = new Date((updated.properties as any).review_due_at).getTime()
      expect(Math.abs(newDue - (t0 + 60 * 86400_000))).toBeLessThan(5000)
    })

    it('confirmReview throws for a non-eligible type', () => {
      const o = eml.engrams.store({
        content: 'o', type: 'note', scope: 'global',
      })
      expect(() => eml.engrams.confirmReview(o.id))
        .toThrow(/only supported for decision\/rule\/profile/)
    })

    it('confirmReview returns null for an unknown id', () => {
      expect(eml.engrams.confirmReview('does-not-exist')).toBeNull()
    })

  })

  describe('v0.8 C1: status lifecycle', () => {
    it('TYPE_DEFAULT_STATUS — task defaults to planned', () => {
      const t = eml.engrams.store({
        content: 'a task', type: 'task', scope: 'global',
      })
      expect(t.status).toBe('planned')
    })

    it('TYPE_DEFAULT_STATUS — non-task defaults to active', () => {
      const d = eml.engrams.store(validDecision({ content: 'd', scope: 'global' }))
      const o = eml.engrams.store({
        content: 'o', type: 'note', scope: 'global',
      })
      const s = eml.engrams.store({
        content: 's', type: 'status', scope: 'global',
        properties: { state: 'live' },
      })
      expect(d.status).toBe('active')
      expect(o.status).toBe('active')
      expect(s.status).toBe('active')
    })

    it('explicit status in the input overrides the default', () => {
      const t = eml.engrams.store({
        content: 'a', type: 'task', scope: 'global', status: 'active',
      })
      expect(t.status).toBe('active')
    })

    it('auto-supersede: the old active status gets superseded', () => {
      const s1 = eml.engrams.store({
        content: 'EML v0.6 deployed', type: 'status',
        scope: 'project.eml', title: 'EML',
        properties: { state: 'v0.6 live' },
      })
      expect(s1.status).toBe('active')

      const s2 = eml.engrams.store({
        content: 'EML v0.7 deployed', type: 'status',
        scope: 'project.eml', title: 'EML',
        properties: { state: 'v0.7 live' },
      })
      expect(s2.status).toBe('active')

      // s1 is now superseded
      const s1after = eml.engrams.get(s1.id)!
      expect(s1after.status).toBe('superseded')

      // supersedes relation: s2 → s1
      const rels = s1after.relations.filter(r => r.relation === 'supersedes')
      expect(rels.length).toBeGreaterThan(0)
      // s2 is the relation's source, s1 the target
      const r = rels.find(r => r.source_id === s2.id && r.target_id === s1.id)
      expect(r).toBeDefined()
      expect(r!.detection_method).toBe('manual')
    })

    it('auto-supersede applies ONLY to the status type, not to decision', () => {
      const d1 = eml.engrams.store(validDecision({
        content: 'Decision A', scope: 'project.eml', title: 'arch',
      }))
      const d2 = eml.engrams.store(validDecision({
        content: 'Decision B', scope: 'project.eml', title: 'arch',
      }))
      // d1 stays active — no auto-supersede for decisions
      expect(eml.engrams.get(d1.id)!.status).toBe('active')
      expect(eml.engrams.get(d2.id)!.status).toBe('active')
    })

    it('auto-supersede is scope-isolated — another scope stays untouched', () => {
      const sA = eml.engrams.store({
        content: 'A', type: 'status',
        scope: 'project.eml',
        properties: { state: 'a' },
      })
      const sB = eml.engrams.store({
        content: 'B', type: 'status',
        scope: 'project.frank',
        properties: { state: 'b' },
      })
      expect(eml.engrams.get(sA.id)!.status).toBe('active')
      expect(eml.engrams.get(sB.id)!.status).toBe('active')
    })

    it('BrainState current_status filters to status=active', () => {
      // 'eml' comes from seedScopeFixtures
      const sOld = eml.engrams.store({
        content: 'Old status', type: 'status',
        scope: 'project.eml',
        properties: { state: 'v0.5' },
      })
      const sNew = eml.engrams.store({
        content: 'New status', type: 'status',
        scope: 'project.eml',
        properties: { state: 'v0.7' },
      })
      const state = eml.projects.getBrainState('eml')!
      // Only sNew is active; sOld was superseded by auto-supersede
      expect(state.current_status.length).toBe(1)
      expect(state.current_status[0].id).toBe(sNew.id)
    })

  })

  // ============================================================
  // v0.8: C6 entity table — external subjects (people, orgs, assets, topics)
  // ============================================================

  describe('v0.8: entities', () => {
    beforeEach(() => resetEntities(eml))
    it('creates and gets an entity', () => {
      const e = eml.entities.create({
        id: 'bob', name: 'Bob Miller', kind: 'person',
        description: 'Built the ECP wrapper',
      })
      expect(e.id).toBe('bob')
      expect(e.kind).toBe('person')
      expect(e.description).toBe('Built the ECP wrapper')

      const got = eml.entities.get('bob')
      expect(got).not.toBeNull()
      expect(got!.name).toBe('Bob Miller')
    })

    it('lists entities, filtered by kind', () => {
      eml.entities.create({ id: 'bob', name: 'Bob', kind: 'person' })
      eml.entities.create({ id: 'anthropic', name: 'Anthropic', kind: 'org' })
      eml.entities.create({ id: 'btc', name: 'Bitcoin', kind: 'asset' })

      expect(eml.entities.list().length).toBe(3)
      expect(eml.entities.list({ kind: 'person' }).length).toBe(1)
      expect(eml.entities.list({ kind: 'org' }).length).toBe(1)
      expect(eml.entities.list({ kind: 'asset' }).length).toBe(1)
    })

    it('updates entity fields', () => {
      eml.entities.create({ id: 'bob', name: 'Bob', kind: 'person' })
      const updated = eml.entities.update('bob', {
        name: 'Bob Miller', description: 'ECP wrapper author',
      })
      expect(updated!.name).toBe('Bob Miller')
      expect(updated!.description).toBe('ECP wrapper author')
    })

    it('exists() returns true for created entity, false for unknown', () => {
      eml.entities.create({ id: 'bob', name: 'Bob', kind: 'person' })
      expect(eml.entities.exists('bob')).toBe(true)
      expect(eml.entities.exists('unknown')).toBe(false)
    })

    it('rejects invalid kind at DB level', () => {
      expect(() => eml.entities.create({
        id: 'x', name: 'X',
        // @ts-expect-error — invalid kind
        kind: 'banana',
      })).toThrow()
    })

    it('UNIQUE constraint: duplicate id throws', () => {
      eml.entities.create({ id: 'bob', name: 'Bob', kind: 'person' })
      expect(() => eml.entities.create({ id: 'bob', name: 'Other', kind: 'person' })).toThrow(/UNIQUE/)
    })

  })
})
