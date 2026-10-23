import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EML, initDatabase } from '../src'
import { validDecision, validLog, validNote, validStatus } from './fixtures'

describe('EML.fromConnection', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-factory-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('wraps an already-open Database.Database', () => {
    const db = initDatabase(join(dir, 'test.db'))
    try {
      const eml = EML.fromConnection(db, 'tenant-x')
      eml.agents.store({ id: 'foo', name: 'Foo' })
      const got = eml.agents.get('foo')
      expect(got?.id).toBe('foo')
    } finally {
      db.close()
    }
  })

  it('close() is no-op for fromConnection — owner-managed lifecycle', () => {
    const db = initDatabase(join(dir, 'test.db'))
    const eml = EML.fromConnection(db, 'tenant-x')

    eml.close()  // must be a no-op

    // db should still be open + usable
    expect(() => db.prepare('SELECT 1').get()).not.toThrow()
    db.close()
  })

  it('close() closes a constructor-created EML', () => {
    const eml = new EML({ namespace: 'owned', dbPath: join(dir, 'owned.db') })
    eml.close()
    // follow-up operations must fail
    expect(() => eml.engrams.query({})).toThrow()
  })

  it('two EML instances on the same DB see the same data', () => {
    const db = initDatabase(join(dir, 'shared.db'))
    try {
      const a = EML.fromConnection(db, 'tenant-shared')
      const b = EML.fromConnection(db, 'tenant-shared')

      a.agents.store({ id: 'shared-agent', name: 'Shared' })
      // Engram via a, lookup via b
      a.engrams.store(validLog({ scope: `agent.shared-agent`, content: 'via instance a' }))
      const seenByB = b.engrams.query({})
      expect(seenByB).toHaveLength(1)
      expect(seenByB[0].content).toContain('via instance a')
    } finally {
      db.close()
    }
  })

  // v0.9.1 Cluster 1: per-instance namespace isolation removed (1 user = 1 brain).
  // When two instances look at the same DB, they see all engrams.
  it('shared DB: all instances see all engrams (no namespace filter anymore)', () => {
    const db = initDatabase(join(dir, 'multi-ns.db'))
    try {
      const a = EML.fromConnection(db, 'ns-a')
      const b = EML.fromConnection(db, 'ns-b')

      a.agents.store({ id: 'agent-x', name: 'X' })
      a.engrams.store(validNote({ scope: 'agent.agent-x', content: 'a-note' }))
      b.engrams.store(validNote({ scope: 'agent.agent-x', content: 'b-note' }))

      const aResults = a.engrams.query({}).map(e => e.content).sort()
      const bResults = b.engrams.query({}).map(e => e.content).sort()
      expect(aResults).toEqual(['a-note', 'b-note'])
      expect(bResults).toEqual(['a-note', 'b-note'])
    } finally {
      db.close()
    }
  })

  // v0.11 team-brains: server-stamped authorship. store(input, caller) writes the
  // caller into engrams.ingested_by; reads expose it. In a shared brain this is how
  // per-engram authorship (carol vs dave vs bob) becomes visible + unforgeable.
  it('store(input, caller) stamps ingested_by and exposes it on read', () => {
    const db = initDatabase(join(dir, 'authorship.db'))
    try {
      const eml = EML.fromConnection(db, 'tenant-team')

      const byCarol = eml.engrams.store(
        validDecision({ scope: 'global', content: 'team decision' }),
        eml.env({ handle: 'carol' }),
      )
      expect(byCarol.ingested_by).toBe('carol')
      expect(eml.engrams.get(byCarol.id)?.ingested_by).toBe('carol')

      const byDave = eml.engrams.store(validNote({ scope: 'global', content: 'team note' }), eml.env({ handle: 'dave' }))
      expect(byDave.ingested_by).toBe('dave')

      // no caller (in-process / legacy path) → null, preserving prior behaviour
      const anon = eml.engrams.store(validNote({ scope: 'global', content: 'anon' }))
      expect(anon.ingested_by).toBeNull()
    } finally {
      db.close()
    }
  })

  // Regression: ProjectStore.rowToEngram must expose ingested_by in lockstep with
  // EngramStore.rowToEngram — else authorship is silently dropped on the project
  // brain-state read path (getBrainState → eml_show), the actual team-brain scope.
  it('project brain-state surfaces ingested_by (both row-mappers in lockstep)', () => {
    const db = initDatabase(join(dir, 'projstate.db'))
    try {
      const eml = EML.fromConnection(db, 'tenant-proj')
      eml.projects.create({ id: 'teamco', name: 'TeamCo' })
      eml.engrams.store(
        validStatus({ scope: 'project.teamco', content: 'v1 live', properties: { state: 'live' } }),
        eml.env({ handle: 'carol' }),
      )
      const state = eml.projects.getBrainState('teamco')
      expect(state?.current_status[0]?.ingested_by).toBe('carol')
    } finally {
      db.close()
    }
  })
})
