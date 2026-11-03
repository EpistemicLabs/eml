import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { plainJson, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CommandError, CURRENT_BRAIN_SCHEMA_VERSION, boot, hygieneCheck, initDatabase, ALL_RULES } from '../src'
import { uuidv5 } from '../src/log/op'
import { verify } from '../src/log/rebuild'
import { brainRef, exportSet } from '../src/log/move'
import { planMove } from '../src/log/move-engrams'
import { validNote, validTask, validRule, writes, legacyGlobalRule } from './fixtures'

// v0.21, decision cockpit-identity-agent-brain: what core gives the agent brain —
// a relation with one end in another brain, the provenance re-stamp, the boot
// in parts, and rules that always have an owner (decision
// rules-need-a-scope-no-global-rules).

const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e'
const raw = (eml: EML): Database.Database => (eml as any).db
const reject = (f: () => unknown): CommandError => {
  try { f() } catch (e) { if (e instanceof CommandError) return e; throw e }
  throw new Error('not rejected')
}

describe('a relation with one end in another brain', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'motti' })
    eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'motti', name: 'Motti' } } })
  })
  afterEach(() => eml.close())

  const learning = () => {
    const r = writes(eml).learn({ scope: 'agent.motti', title: 'deploy-lesson', content: 'Check the audit first.', source: 'self', happened: 'once' })
    if (!r.written) throw new Error('not written')
    return r.engram
  }
  const remoteTask = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

  it('is stored with the brain of the remote end; the local end must exist, the remote one is not checked', () => {
    const l = learning()
    expect(eml.apply({ name: 'relation.create', input: { source_id: l.id, target_id: remoteTask, relation: 'refines', detection_method: 'manual', target_brain: OTHER } })).toEqual({ created: true })
    const rel = eml.engrams.get(l.id)!.relations[0]
    expect(rel).toMatchObject({ source_id: l.id, target_id: remoteTask, relation: 'refines', source_brain: null, target_brain: OTHER })
    // the other direction: a space log that relates to this learning
    const spaceLog = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
    eml.apply({ name: 'relation.create', input: { source_id: spaceLog, target_id: l.id, relation: 'related_to', detection_method: 'manual', source_brain: OTHER } })
    expect(eml.engrams.get(l.id)!.relations.map(r => [r.source_brain, r.target_brain])).toEqual([[null, OTHER], [OTHER, null]])
    expect(eml.engrams.relationsInScope('agent.motti').map(r => r.target_brain ?? r.source_brain)).toEqual([OTHER, OTHER])
    // a local end that does not exist is still NOT_FOUND
    expect(reject(() => eml.apply({ name: 'relation.create', input: { source_id: remoteTask, target_id: spaceLog, relation: 'supports', detection_method: 'manual', target_brain: OTHER } })))
      .toMatchObject({ code: 'NOT_FOUND', message: `engram "${remoteTask}" not found` })
    // a relation without a remote end checks both, as before
    expect(reject(() => eml.apply({ name: 'relation.create', input: { source_id: l.id, target_id: remoteTask, relation: 'supports', detection_method: 'manual' } })).code).toBe('NOT_FOUND')
  })

  it('refuses two remote ends, a malformed brain id and this brain\'s own id', () => {
    const l = learning()
    const base = { source_id: l.id, target_id: remoteTask, relation: 'refines', detection_method: 'manual' }
    expect(reject(() => eml.apply({ name: 'relation.create', input: { ...base, source_brain: OTHER, target_brain: OTHER } as never })).message)
      .toBe('a relation has at most one end in another brain — source_brain or target_brain, not both')
    expect(reject(() => eml.apply({ name: 'relation.create', input: { ...base, target_brain: 'main' } as never })).message).toBe('target_brain is a brain id (a lowercase UUID)')
    expect(reject(() => eml.apply({ name: 'relation.create', input: { ...base, target_brain: eml.brainId()! } as never })).message).toMatch(/is this brain — a cross-brain reference names another one/)
    expect(raw(eml).prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 0 })
  })

  it('is an op like any other: a rebuild replays it, and a move carries the columns', () => {
    const l = learning()
    eml.apply({ name: 'relation.create', input: { source_id: l.id, target_id: remoteTask, relation: 'refines', detection_method: 'manual', target_brain: OTHER } })
    expect(verify(raw(eml))).toMatchObject({ ok: true })
    const t = eml.apply({ name: 'engram.create', input: validTask({ scope: 'agent.motti', title: 'local' }) })
    eml.apply({ name: 'relation.create', input: { source_id: l.id, target_id: t.id, relation: 'related_to', detection_method: 'manual' } })
    const set = exportSet(raw(eml), [l.id, t.id])
    expect(set.rows.relations.map(r => [r.relation, r.source_brain, r.target_brain])).toEqual([['refines', null, OTHER], ['related_to', null, null]])
    expect(set.crossing).toEqual([])
  })

  it('is refused in a shared brain: nothing of an agent reaches a team brain', () => {
    const { shared, op, take } = sharedBrain()
    expect(take(2, op(2, 'object.create', { object: 'project', fields: { id: 'p', name: 'P' } }))).toBeNull()
    const noteOp = op(3, 'engram.create', validNote({ scope: 'project.p', title: 'n' }))
    expect(take(3, noteOp)).toBeNull()
    const note = raw(shared).prepare('SELECT id FROM engrams WHERE title = ?').get('n') as { id: string }
    expect(take(4, op(4, 'relation.create', { source_id: note.id, target_id: remoteTask, relation: 'related_to', detection_method: 'manual', target_brain: OTHER })))
      .toBe('INVALID: Invalid command: a shared brain holds no relation into another brain.')
    expect(raw(shared).prepare('SELECT COUNT(*) AS n FROM relations').get()).toEqual({ n: 0 })
    shared.close()
  })

  it('a set carrying one is refused by a shared target at plan, and by its import', () => {
    const l = learning()
    eml.apply({ name: 'relation.create', input: { source_id: l.id, target_id: remoteTask, relation: 'refines', detection_method: 'manual', target_brain: OTHER } })
    const { shared, op, take } = sharedBrain()
    const set = exportSet(raw(eml), [l.id])
    const relation = set.rows.relations[0].id
    const reason = `relation ${relation} points into another brain, which a shared brain holds no relation into`
    expect(planMove({ source: raw(eml), target: raw(shared), ids: [l.id] }).collisions).toEqual([reason])
    expect(take(2, op(2, 'engram.import', { source: brainRef(raw(eml)), set_hash: set.set_hash, rows: set.rows }))).toBe(`INVALID: engram.import refused: ${reason}.`)
    expect(raw(shared).prepare('SELECT COUNT(*) AS n FROM engrams').get()).toEqual({ n: 0 })
    // a private target takes it, relation and all
    const own = new EML({ dbPath: ':memory:', namespace: 'other' })
    expect(planMove({ source: raw(eml), target: raw(own), ids: [l.id] }).collisions).toEqual([])
    shared.close(); own.close()
  })
})

/** A shared brain: an empty brain whose log starts with a relayed genesis for BRAIN, and how to relay an op to it. */
function sharedBrain() {
  const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const shared = EML.fromConnection(initDatabase(':memory:', undefined, BRAIN, { log: false }), 'test')
  const op = (n: number, call: string, args: unknown): OpEnvelope => ({
    op_id: uuidv5(BRAIN, `op ${n}`), schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never,
    provenance: { handle: call === 'brain.genesis' ? null : 'juno', agent: null, ingestion_method: null, session_id: null, model: null, harness: null },
    team: { brain: BRAIN, device: 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4', base_seq: n - 1, head_hash: '0'.repeat(64) },
  })
  const take = (n: number, o: OpEnvelope) => shared.takeRelayed({ seq: n, at: `2026-10-27T08:00:0${n}.000Z`, op_id: o.op_id, payload: plainJson(o), signature: null, rejected: null }, o).rejected
  expect(take(1, op(1, 'brain.genesis', { brain: BRAIN, state_hash: shared.stateHash() }))).toBeNull()
  return { shared, op, take }
}

describe('provenance.restamp', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'motti' })
    eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'motti', name: 'Motti' } } })
  })
  afterEach(() => eml.close())

  it('turns the rows written as the agent\'s name into person via agent; rows with an agent or of other handles stay; rev does not move', () => {
    const asMotti = eml.env({ handle: 'motti', ingestion_method: 'mcp' })
    const t = eml.apply({ name: 'engram.create', input: validTask({ scope: 'agent.motti', title: 'legacy' }) }, asMotti)
    eml.apply({ name: 'task.track', input: { id: t.id, text: 'progress' } }, asMotti)
    const stamped = eml.apply({ name: 'engram.create', input: validNote({ scope: 'agent.motti', title: 'already' }) }, eml.env({ handle: 'dominik', agent: 'motti' }))
    const other = eml.apply({ name: 'engram.create', input: validNote({ scope: 'agent.motti', title: 'other' }) }, eml.env({ handle: 'argus' }))
    const revBefore = eml.engrams.get(t.id)!.rev
    const entriesBefore = eml.engrams.entries(t.id).length

    const result = eml.apply({ name: 'provenance.restamp', input: { from_handle: 'motti', to_handle: 'dominik', agent: 'motti' } }, eml.env({ handle: 'dominik' }))
    expect(result).toEqual({ engrams: 1, entries: entriesBefore })
    expect(eml.engrams.get(t.id)).toMatchObject({ ingested_by: 'dominik', agent: 'motti', rev: revBefore })
    for (const e of eml.engrams.entries(t.id)) expect([e.author, e.agent]).toEqual(['dominik', 'motti'])
    expect(eml.engrams.get(stamped.id)).toMatchObject({ ingested_by: 'dominik', agent: 'motti' })
    expect(eml.engrams.get(other.id)).toMatchObject({ ingested_by: 'argus', agent: null })
    // the second run finds nothing; a rebuild replays both
    expect(eml.apply({ name: 'provenance.restamp', input: { from_handle: 'motti', to_handle: 'dominik', agent: 'motti' } })).toEqual({ engrams: 0, entries: 0 })
    expect(verify(raw(eml))).toMatchObject({ ok: true })
  })

  it('takes exactly from_handle, to_handle and agent in the handle charset, and two different handles', () => {
    const run = (input: unknown) => reject(() => eml.apply({ name: 'provenance.restamp', input } as never)).message
    expect(run({ from_handle: 'motti', to_handle: 'dominik' })).toBe('Invalid command: provenance.restamp needs agent.')
    expect(run({ from_handle: 'motti', to_handle: 'dominik', agent: 'motti', dry: true })).toMatch(/^Invalid command: unknown field dry/)
    expect(run({ from_handle: 'Motti', to_handle: 'dominik', agent: 'motti' })).toBe('Invalid command: from_handle is 1–63 characters of a-z, 0-9, _ and -.')
    expect(run({ from_handle: 'motti', to_handle: 'motti', agent: 'motti' })).toBe('Invalid command: from_handle and to_handle must differ.')
    expect(raw(eml).prepare('SELECT COUNT(*) AS n FROM op_log').get()).toEqual({ n: 2 })
  })
})

describe('boot in parts', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'motti' })
    writes(eml).agents.store({ id: 'motti', name: 'Motti' })
    writes(eml).users.create({ id: 'dominik', name: 'Dominik' })
    writes(eml).store({ type: 'profile', scope: 'agent.motti', title: 'motti', content: 'A digital moth.', properties: { core: true } })
    writes(eml).store(validRule({ scope: 'user.dominik', title: 'ask-first', content: 'Propose first.' }))
    writes(eml).store(validRule({ scope: 'agent.motti', title: 'reread', content: 'Re-read the task.', properties: { applies: 'situational', trigger: 'starting a build' } }))
  })
  afterEach(() => eml.close())

  it('identity carries the header, profiles and rules without system rules; system only the system rules; together they are the whole', () => {
    const all = boot(eml, 'motti', { systemRules: ALL_RULES, version: '0.21.0' })
    const identity = boot(eml, 'motti', { systemRules: ALL_RULES, version: '0.21.0', part: 'identity' })
    const system = boot(eml, 'motti', { systemRules: ALL_RULES, version: '0.21.0', part: 'system' })
    expect(identity.markdown.startsWith('# EML Boot — motti\n\n## Identity\n')).toBe(true)
    expect(identity.markdown).toContain('Propose first.')
    expect(identity.markdown).not.toContain('## EML System Rules')
    expect(identity.engrams).toBe(3)
    expect(system.markdown.startsWith('## EML System Rules (managed by engramprotocol v0.21.0)\n')).toBe(true)
    expect(system.markdown).not.toContain('# EML Boot')
    expect(system.engrams).toBe(0)
    expect(`${identity.markdown}\n\n${system.markdown}`).toBe(all.markdown)
    expect(boot(eml, 'motti', { systemRules: ALL_RULES, part: 'all' }).markdown).toBe(boot(eml, 'motti', { systemRules: ALL_RULES }).markdown)
  })

  it('the budget applies to the part that is rendered', () => {
    const free = boot(eml, 'motti', { systemRules: ALL_RULES, part: 'identity' }).markdown.length
    const r = boot(eml, 'motti', { systemRules: ALL_RULES, part: 'identity', budget: free - 1 })
    expect(r.markdown.length).toBeLessThan(free)
    expect(r.budget).toMatchObject({ limit: free - 1, chars: r.markdown.length, fits: true })
    expect(r.budget!.situational_title_only + r.budget!.always_title_only + r.budget!.left_out).toBeGreaterThanOrEqual(1)
    expect(r.markdown).toContain('A digital moth.')
  })
})

describe('a rule has an owner (v0.21, decision rules-need-a-scope-no-global-rules)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'assistant' })
    writes(eml).agents.store({ id: 'assistant', name: 'Assistant' })
    writes(eml).users.create({ id: 'ada', name: 'Ada' })
    writes(eml).projects.create({ id: 'p', name: 'P' })
    writes(eml).entities.create({ id: 'acme', name: 'Acme', kind: 'org' })
  })
  afterEach(() => eml.close())

  it('is written in agent, user or project scope, never in global or entity', () => {
    for (const scope of ['agent.assistant', 'user.ada', 'project.p']) expect(writes(eml).store(validRule({ scope, title: `r-${scope}` })).scope).toBe(scope)
    for (const scope of ['global', 'entity.acme']) {
      expect(() => writes(eml).store(validRule({ scope, title: `r-${scope}` }))).toThrow(/^Invalid engram: a rule needs an owner — scope agent\.<id> .*; global holds no rules\.$/)
    }
    // a profile of an entity stays where it is: the owner rule is for rules
    expect(writes(eml).store({ type: 'profile', scope: 'entity.acme', title: 'acme', content: 'A customer.' }).scope).toBe('entity.acme')
  })

  it('cannot be moved to global; a legacy rule in global stays editable where it is and the hygiene check names it', () => {
    const r = writes(eml).store(validRule({ title: 'mine' }))
    expect(() => writes(eml).update(r.id, { scope: 'global' })).toThrow(/a rule needs an owner/)
    const legacy = legacyGlobalRule(eml, { title: 'old-global', content: 'Do X.', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
    expect(writes(eml).update(legacy.id, { content: 'Do X, then Y.' })).toMatchObject({ scope: 'global', content: 'Do X, then Y.' })
    const check = hygieneCheck(eml).checks.find(c => c.id === 'rule-in-global-scope')!
    expect(check).toMatchObject({ kind: 'migration', decides: 'agent', since_schema: 21 })
    expect(check.findings).toEqual([{ id: legacy.id, type: 'rule', scope: 'global', title: 'old-global', reason: 'a rule in global has no owner.' }])
    expect(writes(eml).update(legacy.id, { scope: 'agent.assistant' })).toMatchObject({ scope: 'agent.assistant' })
    expect(hygieneCheck(eml).checks.find(c => c.id === 'rule-in-global-scope')!.findings).toEqual([])
  })
})
