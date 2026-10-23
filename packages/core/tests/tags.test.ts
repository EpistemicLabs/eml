import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import {
  validDecision, writes,
} from './fixtures'


describe('v0.12 tags', () => {
  let dir: string
  let eml: EML

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-tags-test-'))
    eml = new EML({ namespace: 'test', dbPath: join(dir, 't.db') })
  })

  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('brain schema version includes v0.12', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(12)
  })

  it('TagStore.create slugifies the name and dedups', () => {
    const t = writes(eml).tags.create({ name: 'Deploy' })
    expect(t.id).toBe('deploy')
    expect(writes(eml).tags.create({ name: 'deploy' }).id).toBe('deploy')
    expect(eml.tags.list()).toHaveLength(1)
  })

  it('normalizes spaces/punctuation into a hyphen slug', () => {
    expect(writes(eml).tags.create({ name: 'CI / CD Pipeline' }).id).toBe('ci-cd-pipeline')
  })

  it('rejects a name with no alphanumerics', () => {
    expect(() => writes(eml).tags.create({ name: '///' })).toThrow()
  })

  it('writes an engram with a registered tag and reads it back', () => {
    writes(eml).tags.create({ name: 'deploy' })
    const e = writes(eml).store({
      type: 'note', scope: 'global', title: 'n', content: 'shipped v1',
      tags: ['deploy'],
    })
    expect(e.tags).toEqual(['deploy'])
    expect(eml.engrams.get(e.id)!.tags).toEqual(['deploy'])
    expect(eml.engrams.query({})[0].tags).toEqual(['deploy'])
  })

  it('rejects an engram carrying an unregistered tag — and writes nothing', () => {
    expect(() => writes(eml).store({
      type: 'note', scope: 'global', title: 'n', content: 'nope', tags: ['ghost'],
    })).toThrow(/ghost.*not found/)
    expect(eml.engrams.query({})).toHaveLength(0)
  })

  it('update replaces the tag set (add, remove, clear)', () => {
    writes(eml).tags.create({ name: 'a' }); writes(eml).tags.create({ name: 'b' })
    const e = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'x', tags: ['a'] })
    expect(writes(eml).update(e.id, { tags: ['a', 'b'] })!.tags).toEqual(['a', 'b'])
    expect(writes(eml).update(e.id, { tags: ['b'] })!.tags).toEqual(['b'])
    expect(writes(eml).update(e.id, { tags: [] })!.tags).toEqual([])
  })

  it('update leaves tags untouched when tags is omitted', () => {
    writes(eml).tags.create({ name: 'keep' })
    const e = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'x', tags: ['keep'] })
    expect(writes(eml).update(e.id, { content: 'y' })!.tags).toEqual(['keep'])
  })

  it('update rejects an unregistered tag', () => {
    const e = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'x' })
    expect(() => writes(eml).update(e.id, { tags: ['ghost'] })).toThrow(/ghost.*not found/)
  })

  it('engramTagsInScope returns the scope membership set', () => {
    writes(eml).tags.create({ name: 'deploy' }); writes(eml).tags.create({ name: 'schema' })
    const a = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'a', tags: ['deploy', 'schema'] })
    writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'b', tags: ['deploy'] })
    const mem = eml.engrams.engramTagsInScope('global')
    expect(mem).toHaveLength(3)
    expect(mem.filter(m => m.tag_id === 'deploy')).toHaveLength(2)
    expect(mem.filter(m => m.engram_id === a.id).map(m => m.tag_id).sort()).toEqual(['deploy', 'schema'])
  })

  it('normalizes tags on write — registered "deploy" accepts ["Deploy","DEPLOY"]', () => {
    writes(eml).tags.create({ name: 'deploy' })
    const e = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'x', tags: ['Deploy', 'DEPLOY'] })
    expect(e.tags).toEqual(['deploy']) // slugified + deduped
  })

  it('rejects and names ALL unknown tags in one error', () => {
    writes(eml).tags.create({ name: 'known' })
    expect(() => writes(eml).store({
      type: 'note', scope: 'global', title: 'n', content: 'x', tags: ['known', 'ghosta', 'ghostb'],
    })).toThrow(/ghosta.*ghostb/)
  })

  it('a tags-only update bumps updated_at (recency reflects the change)', () => {
    writes(eml).tags.create({ name: 'x' })
    const e = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'c' })
    const stored = eml.engrams.get(e.id)!.updated_at
    const upd = writes(eml).update(e.id, { tags: ['x'] })!
    expect(upd.tags).toEqual(['x'])
    expect(upd.updated_at).not.toEqual(stored)
  })

  it('rejects an unslugifiable tag instead of silently dropping it', () => {
    expect(() => writes(eml).store({
      type: 'note', scope: 'global', title: 'n', content: 'x', tags: ['///'],
    })).toThrow(/invalid tag name/)
  })

  it('?tag= filter matches regardless of case (slugified to stored form)', () => {
    writes(eml).tags.create({ name: 'deploy' })
    const a = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'a', tags: ['deploy'] })
    expect(eml.engrams.query({ tag: 'Deploy' }).map(e => e.id)).toEqual([a.id])
  })

  it('project brain-state snapshot engrams carry their tags', () => {
    writes(eml).projects.create({ id: 'proj', name: 'Proj' })
    writes(eml).tags.create({ name: 'deploy' })
    const d = writes(eml).store(validDecision({
      scope: 'project.proj', title: 'x', content: 'chose X',
      tags: ['deploy'],
    }))
    const state = eml.projects.getBrainState('proj')!
    const found = state.recent_decisions.find(e => e.id === d.id)
    expect(found?.tags).toEqual(['deploy'])
  })

  it('query filters engrams by tag membership (?tag=)', () => {
    writes(eml).tags.create({ name: 'deploy' })
    const a = writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'a', tags: ['deploy'] })
    writes(eml).store({ type: 'note', scope: 'global', title: 'n', content: 'b' })
    const hits = eml.engrams.query({ tag: 'deploy' })
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(a.id)
  })

})
