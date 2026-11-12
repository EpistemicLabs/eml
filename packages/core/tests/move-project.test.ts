import { describe, it, expect, afterAll } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { plainJson, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CommandError, CURRENT_BRAIN_SCHEMA_VERSION, initDatabase, renderBrainStateMarkdown, type Env } from '../src'
import { uuidv5 } from '../src/log/op'
import { verify } from '../src/log/rebuild'
import { exportSet, legacyAuthorship, projectSet, remoteReferences } from '../src/log/move'
import { moveEngrams, moveProject, planMove, planProjectMove, type MoveTarget } from '../src/log/move-engrams'
import { createObject, validDecision, validNote, validStatus, validTask, writes } from './fixtures'

// v0.21 (spec team-brain-move-project-spec, block 1; decision
// move-project-deterministic-ui): a project moves with its sub-projects, the
// plan names itself with a hash the run checks, the move refuses what a user
// would otherwise have to know, and the target is written where its writes go.

function brain(name: string, dbPath = ':memory:', start = '2026-11-03T08:00:00.000Z'): EML {
  let t = Date.parse(start)
  let n = 0
  return new EML({
    dbPath, namespace: name,
    clock: () => new Date(t++).toISOString(),
    newId: () => `${createHash('sha1').update(name).digest('hex').slice(0, 8)}-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
}

const raw = (eml: EML): Database.Database => (eml as any).db
const count = (eml: EML, sql: string, ...params: unknown[]) => (raw(eml).prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n
const opCount = (eml: EML) => count(eml, 'op_log')

async function rejected(f: () => Promise<unknown>): Promise<CommandError> {
  try { await f() } catch (e) { if (e instanceof CommandError) return e; throw e }
  throw new Error('not rejected')
}

/**
 * A source: project top with sub-project child (engrams in both), sub-project
 * leaf (none) and a project elsewhere; a task with a journal in top, a decision
 * in child linked to a note elsewhere (crossing), written by the person kai.
 */
function source(dbPath = ':memory:') {
  const eml = brain('source', dbPath)
  const kai = eml.env({ handle: 'kai', session_id: 's1', ingestion_method: 'mcp' })
  createObject(eml, 'project', { id: 'top', name: 'Top', metadata: { repo: 'r' } }, kai)
  createObject(eml, 'project', { id: 'child', name: 'Child', parent_project: 'top' }, kai)
  createObject(eml, 'project', { id: 'leaf', name: 'Leaf', parent_project: 'child' }, kai)
  createObject(eml, 'project', { id: 'elsewhere', name: 'Elsewhere' }, kai)
  const task = writes(eml).store(validTask({ scope: 'project.top', title: 'hub', status: 'active' }), kai)
  writes(eml).trackTask(task.id, { text: 'progress' }, kai)
  const decision = writes(eml).store(validDecision({ scope: 'project.child', title: 'choice', task_id: task.id, properties: { binding: 'task' } }), kai)
  const outside = writes(eml).store(validNote({ scope: 'project.elsewhere', title: 'outside' }), kai)
  writes(eml).relate({ source_id: decision.id, target_id: outside.id, relation: 'related_to', detection_method: 'manual' }, kai)
  return { eml, kai, task, decision, outside }
}

function target(dbPath = ':memory:'): EML {
  const eml = brain('target', dbPath, '2026-11-03T09:00:00.000Z')
  createObject(eml, 'project', { id: 'there', name: 'There' })
  return eml
}

/** A shared brain: an empty brain whose log starts with a relayed genesis for `id`. */
function sharedBrain(id: string): EML {
  const eml = EML.fromConnection(initDatabase(':memory:', undefined, id, { log: false }), 'shared')
  const genesis: OpEnvelope = {
    op_id: uuidv5(id, 'genesis'), schema: CURRENT_BRAIN_SCHEMA_VERSION, call: 'brain.genesis', args: { brain: id, state_hash: eml.stateHash() } as never,
    provenance: { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null },
    team: { brain: id, device: 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4', base_seq: 0, head_hash: '0'.repeat(64) },
  }
  eml.takeRelayed({ seq: 1, at: '2026-11-03T07:00:00.000Z', op_id: genesis.op_id, payload: plainJson(genesis), signature: null, rejected: null }, genesis)
  return eml
}

/** A shared target: written like the server writes one — the command applied as a relayed op of its member. */
function sharedTarget(eml: EML, hooks: { before?: () => Promise<void>, after?: () => Promise<void> } = {}): MoveTarget {
  let seq = (raw(eml).prepare('SELECT MAX(seq) AS n FROM op_log').get() as { n: number }).n
  return {
    db: raw(eml),
    write: async (command) => {
      await hooks.before?.()
      const brain = eml.teamBrain()!
      const op: OpEnvelope = {
        op_id: uuidv5(brain, `op ${++seq}`), schema: CURRENT_BRAIN_SCHEMA_VERSION, call: command.name, args: command.input as never,
        provenance: { handle: 'kai', agent: null, ingestion_method: 'mcp', session_id: null, model: null, harness: null },
        team: { brain, device: 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4', base_seq: seq - 1, head_hash: '0'.repeat(64) },
      }
      const taken = eml.takeRelayed({ seq, at: new Date(Date.parse('2026-11-03T10:00:00.000Z') + seq).toISOString(), op_id: op.op_id, payload: plainJson(op), signature: null, rejected: null }, op)
      await hooks.after?.()
      if (taken.rejected !== null) throw taken.error ?? new Error(taken.rejected)
      return taken.result as never
    },
  }
}

describe('projectSet', () => {
  it('the project and its sub-projects, parents first; their engrams in ord order; a sub-project without engrams listed with 0', () => {
    const s = source()
    const { tree, ids } = projectSet(raw(s.eml), 'top')
    expect(tree).toEqual([{ id: 'top', engrams: 1 }, { id: 'child', engrams: 1 }, { id: 'leaf', engrams: 0 }])
    expect(ids).toEqual([s.task.id, s.decision.id])
    expect(projectSet(raw(s.eml), 'leaf')).toEqual({ tree: [{ id: 'leaf', engrams: 0 }], ids: [] })
    expect(() => projectSet(raw(s.eml), 'nowhere')).toThrow(/project nowhere not found/)
    s.eml.close()
  })
})

describe('legacyAuthorship', () => {
  it('counts the rows an agent of the brain is named as author of', () => {
    const s = source()
    expect(legacyAuthorship(raw(s.eml), [s.task.id, s.decision.id])).toEqual({ engrams: 0, entries: 0, agents: [] })
    createObject(s.eml, 'agent', { id: 'motti', name: 'Motti' })
    const motti = s.eml.env({ handle: 'motti', ingestion_method: 'mcp' })
    const legacy = writes(s.eml).store(validNote({ scope: 'project.child', title: 'stamped-by-the-agent' }), motti)
    writes(s.eml).trackTask(s.task.id, { text: 'also by the agent' }, motti)
    expect(legacyAuthorship(raw(s.eml), [s.task.id, s.decision.id, legacy.id])).toEqual({ engrams: 1, entries: 1, agents: ['motti'] })
    s.eml.close()
  })
})

describe('planProjectMove', () => {
  it('the tree, the set, what crosses, the size; the same state gives the same plan', () => {
    const s = source()
    const to = target()
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    expect(plan.project).toBe('top')
    expect(plan.tree).toEqual([{ id: 'top', engrams: 1 }, { id: 'child', engrams: 1 }, { id: 'leaf', engrams: 0 }])
    expect(plan.moved).toEqual({ engrams: 2, entries: 3, relations: 1 })
    expect(plan.crossing.map(c => [c.relation, c.direction, c.other.title])).toEqual([['related_to', 'out', 'outside']])
    expect(plan.created).toEqual({ projects: ['top', 'child'], entities: [], users: [], agents: [], tags: [], subjects: [] })
    expect(plan.legacy).toEqual({ engrams: 0, entries: 0, agents: [] })
    expect(plan.collisions).toEqual([])
    expect(plan.payload_bytes).toBeGreaterThan(1000)
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })).toEqual(plan)
    expect(plan.plan_hash).toBe(planMove({ source: raw(s.eml), target: raw(to), ids: [s.task.id, s.decision.id] }).plan_hash)
    to.close(); s.eml.close()
  })

  it('the plan hash follows what moves and what is dropped, not writes elsewhere', () => {
    const s = source()
    const to = target()
    const hash = () => planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' }).plan_hash
    const first = hash()
    writes(s.eml).store(validNote({ scope: 'project.elsewhere', title: 'unrelated' }))
    createObject(to, 'tag', { name: 'ops' })
    expect(hash()).toBe(first)
    writes(s.eml).trackTask(s.task.id, { text: 'a journal entry in the set' })
    const second = hash()
    expect(second).not.toBe(first)
    writes(s.eml).relate({ source_id: s.outside.id, target_id: s.task.id, relation: 'supports', detection_method: 'manual' })
    expect(hash()).not.toBe(second)
    to.close(); s.eml.close()
  })

  it('refuses a project without engrams, legacy authorship, a team brain as the source, a set too large for one op', () => {
    const s = source()
    const to = target()
    expect(() => planProjectMove({ source: raw(s.eml), target: raw(to), project: 'leaf' })).toThrow(/has no engrams to move/)

    createObject(s.eml, 'agent', { id: 'motti', name: 'Motti' })
    writes(s.eml).trackTask(s.task.id, { text: 'by the agent' }, s.eml.env({ handle: 'motti', ingestion_method: 'mcp' }))
    const legacy = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    expect(legacy.legacy).toEqual({ engrams: 0, entries: 1, agents: ['motti'] })
    expect(legacy.collisions).toEqual([expect.stringMatching(/^0 engrams and 1 journal entries are written under an agent's name \(motti\); run the agent upgrade first$/)])

    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    expect(planMove({ source: raw(s.eml), target: raw(shared), ids: [s.task.id] }).collisions).toEqual([])
    // a set past the limit: only into a team brain is one op too small
    raw(s.eml).prepare('UPDATE engrams SET content = ? WHERE id = ?').run('x'.repeat(16 * 1024 * 1024), s.decision.id)
    expect(planMove({ source: raw(s.eml), target: raw(to), ids: [s.decision.id] }).collisions).toEqual([])
    expect(planMove({ source: raw(s.eml), target: raw(shared), ids: [s.decision.id] }).collisions).toEqual([expect.stringMatching(/^the set is 16\.\d MiB of JSON; one op into a team brain carries at most 16 MiB$/)])
    shared.close(); to.close(); s.eml.close()
  })

  it('a project the target has: its engrams join it; the statuses of one with an active status there stay behind, history and all', () => {
    const s = source()
    const old = writes(s.eml).store(validStatus({ scope: 'project.top', content: 'first' }), s.kai)
    const current = writes(s.eml).store(validStatus({ scope: 'project.top', content: 'second' }), s.kai)
    writes(s.eml).store(validStatus({ scope: 'project.child', content: 'child state' }), s.kai)
    const to = target()
    expect(planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })).toMatchObject({ joins: [], kept_statuses: [], moved: { engrams: 5 }, collisions: [] })

    // the target has top with a status of its own, and child without one
    createObject(to, 'project', { id: 'top', name: 'Top there' })
    createObject(to, 'project', { id: 'child', name: 'Child there', parent_project: 'top' })
    writes(to).store(validStatus({ scope: 'project.top', content: 'theirs' }))
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    expect(plan).toMatchObject({ joins: ['top', 'child'], kept_statuses: [old.id, current.id], moved: { engrams: 3 }, collisions: [] })
    // the tree counts what moves: top's two statuses stay
    expect(plan.tree).toEqual([{ id: 'top', engrams: 1 }, { id: 'child', engrams: 2 }, { id: 'leaf', engrams: 0 }])
    expect(plan.created.projects).toEqual([])
    expect(plan.crossing.map(c => c.relation)).toEqual(['related_to'])
    to.close(); s.eml.close()
  })

  it('a team brain as the source is refused', () => {
    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const t = sharedTarget(shared)
    const to = target()
    // the shared brain gets a project and an engram the way its replica takes them
    return t.write({ name: 'object.create', input: { object: 'project', fields: { id: 'p', name: 'P' } } })
      .then(() => t.write({ name: 'engram.create', input: validNote({ scope: 'project.p', title: 'in-the-team-brain' }) as never }))
      .then(() => {
        const plan = planProjectMove({ source: raw(shared), target: raw(to), project: 'p' })
        expect(plan.collisions).toEqual(['the source is a team brain; a move takes engrams out of a private brain only'])
        shared.close(); to.close()
      })
  })
})

describe('moveProject', () => {
  const dirs: string[] = []
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'eml-move-project-')); dirs.push(d); return d }
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  const inSet = (eml: EML, s: ReturnType<typeof source>) => count(eml, 'engrams WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([s.task.id, s.decision.id]))
  const unlocked = (eml: EML) => {
    expect(raw(eml).inTransaction).toBe(false)
    writes(eml).store(validNote({ scope: 'project.elsewhere', title: `written-after-${opCount(eml)}` }))
  }

  it('moves the tree into a private target and archives the emptied projects with where they went', async () => {
    const s = source()
    const to = target()
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    const result = await moveProject({ source: raw(s.eml), target: { db: raw(to) }, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'source.db'), target_name: 'EML team' }, s.kai)
    expect(result).toMatchObject({ project: 'top', tree: plan.tree, archived: ['top', 'child'], moved: plan.moved, resumed: false, dropped_relations: plan.crossing.map(c => c.id) })
    expect(result.created.projects).toEqual(['top', 'child'])
    expect(inSet(to, s)).toBe(2)
    expect(inSet(s.eml, s)).toBe(0)
    // the emptied projects point at the target, by id and by the name given; leaf had nothing and stays as it was
    const top = s.eml.projects.get('top')!
    expect(top.status).toBe('archived')
    expect(top.metadata).toEqual({ repo: 'r', moved_to: plan.target, moved_at: expect.stringMatching(/^2026-11-03T/), moved_to_name: 'EML team' })
    expect(s.eml.projects.get('child')!.metadata).toEqual({ moved_to: plan.target, moved_at: expect.stringMatching(/^2026-11-03T/), moved_to_name: 'EML team' })
    expect(s.eml.projects.get('leaf')).toMatchObject({ status: 'active', metadata: null })
    // eml_show on the moved project: the line under the header names the space and the day; the marker is not a metadata fact
    const shown = renderBrainStateMarkdown(s.eml.engrams.buildBrainState('project.top'))
    expect(shown).toMatch(/^# project\.top — brain state\n_Moved to the shared space EML team on 2026-11-03 — its engrams live there; nothing new is filed here\._\n\n## Status/)
    expect(shown).toContain('## Metadata\n- repo: r\n')
    expect(shown).not.toContain('moved_')
    expect(renderBrainStateMarkdown(s.eml.engrams.buildBrainState('project.leaf'))).not.toContain('Moved to')
    // the target has the tree's projects as they were in the source, the crossing link is gone
    expect(to.projects.get('child')!.parent_project).toBe('top')
    expect(count(s.eml, 'relations WHERE source_id = ?', s.decision.id)).toBe(0)
    unlocked(s.eml)
    expect(verify(raw(s.eml))).toMatchObject({ ok: true })
    expect(verify(raw(to))).toMatchObject({ ok: true })
    to.close(); s.eml.close()
  })

  it('without a target name, the archived project names the brain id', async () => {
    const s = source()
    const to = target()
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    await moveProject({ source: raw(s.eml), target: { db: raw(to) }, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'source.db') }, s.kai)
    expect(s.eml.projects.get('top')!.metadata).toEqual({ repo: 'r', moved_to: plan.target, moved_at: expect.stringMatching(/^2026-11-03T/) })
    expect(renderBrainStateMarkdown(s.eml.engrams.buildBrainState('project.top'))).toContain(`_Moved to the shared space ${plan.target} on 2026-11-03 — its engrams live there; nothing new is filed here._`)
    unlocked(s.eml)
    to.close(); s.eml.close()
  })

  it('into a project the target has: the engrams join it, its status stays the one there, the source keeps its own with the archived project', async () => {
    const s = source()
    const mine = writes(s.eml).store(validStatus({ scope: 'project.top', content: 'mine' }), s.kai)
    const to = target()
    createObject(to, 'project', { id: 'top', name: 'Top there' })
    const theirs = writes(to).store(validStatus({ scope: 'project.top', content: 'theirs' }))
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    const result = await moveProject({ source: raw(s.eml), target: { db: raw(to) }, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'source.db') }, s.kai)
    expect(result.created.projects).toEqual(['child'])
    expect(result.archived).toEqual(['top', 'child'])
    expect(inSet(to, s)).toBe(2)
    expect(to.projects.get('top')!.name).toBe('Top there')
    const statuses = (eml: EML) => raw(eml).prepare("SELECT id, status FROM engrams WHERE type = 'status' AND scope = 'project.top'").all()
    expect(statuses(to)).toEqual([{ id: theirs.id, status: 'active' }])
    expect(statuses(s.eml)).toEqual([{ id: mine.id, status: 'active' }])
    expect(s.eml.projects.get('top')!.status).toBe('archived')
    unlocked(s.eml)
    expect(verify(raw(s.eml))).toMatchObject({ ok: true })
    expect(verify(raw(to))).toMatchObject({ ok: true })
    to.close(); s.eml.close()
  })

  it('refuses a plan that is not the current one, and nothing changes', async () => {
    const s = source()
    const to = target()
    const stale = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' }).plan_hash
    writes(s.eml).trackTask(s.task.id, { text: 'after the plan' })
    const before = [opCount(s.eml), opCount(to)]
    const err = await rejected(() => moveProject({ source: raw(s.eml), target: { db: raw(to) }, project: 'top', plan_hash: stale, backup_path: join(dir(), 'a.db') }, s.kai))
    expect(err.code).toBe('CONFLICT')
    expect(err.message).toMatch(/the plan changed since it was made/)
    expect(err.data).toEqual({ plan_hash: planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' }).plan_hash })
    expect([opCount(s.eml), opCount(to)]).toEqual(before)
    unlocked(s.eml)
    to.close(); s.eml.close()
  })

  it('refuses legacy authorship before anything is written', async () => {
    const s = source()
    const to = target()
    createObject(s.eml, 'agent', { id: 'motti', name: 'Motti' })
    writes(s.eml).store(validNote({ scope: 'project.child', title: 'by-the-agent' }), s.eml.env({ handle: 'motti', ingestion_method: 'mcp' }))
    const plan = planProjectMove({ source: raw(s.eml), target: raw(to), project: 'top' })
    const before = [opCount(s.eml), opCount(to)]
    const err = await rejected(() => moveProject({ source: raw(s.eml), target: { db: raw(to) }, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'a.db') }, s.kai))
    expect(err.message).toMatch(/^move refused: 1 engrams and 0 journal entries are written under an agent's name \(motti\); run the agent upgrade first\. Nothing was moved\.$/)
    expect([opCount(s.eml), opCount(to)]).toEqual(before)
    unlocked(s.eml)
    to.close(); s.eml.close()
  })

  it('into a shared target: the import goes through the target\'s write; a write of the source meanwhile waits and fails; both verify', async () => {
    const file = join(dir(), 'source.db')
    const s = source(file)
    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    // another connection to the source, as another request of the server would hold one
    // (closed by hand below: an EML over a borrowed connection does not close it)
    const otherDb = new Database(file, { timeout: 50 })
    const other = EML.fromConnection(otherDb, 'other')
    let busy: unknown
    const t = sharedTarget(shared, {
      before: async () => {
        try { writes(other).store(validNote({ scope: 'project.elsewhere', title: 'during-the-move' })) } catch (e) { busy = e }
      },
    })
    const plan = planProjectMove({ source: raw(s.eml), target: raw(shared), project: 'top' })
    const result = await moveProject({ source: raw(s.eml), target: t, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'backup.db') }, s.kai)
    expect(String((busy as { code?: string })?.code)).toMatch(/SQLITE_BUSY/)
    expect(result.resumed).toBe(false)
    expect(inSet(shared, s)).toBe(2)
    expect(inSet(s.eml, s)).toBe(0)
    // the import is one op of the team brain's log, by its member
    const op = JSON.parse(raw(shared).prepare('SELECT payload FROM op_log WHERE op_id = ?').get(result.import.op_id)!['payload' as never]) as OpEnvelope
    expect(op).toMatchObject({ call: 'engram.import', provenance: { handle: 'kai' }, team: { brain: shared.teamBrain() } })
    // after the move the other connection writes again
    writes(other).store(validNote({ scope: 'project.elsewhere', title: 'after-the-move' }))
    expect(verify(raw(s.eml))).toMatchObject({ ok: true })
    expect(verify(raw(shared))).toMatchObject({ ok: true })
    otherDb.close(); shared.close(); s.eml.close()
  })

  it('a write that may still land: nothing removed, the source unlocked; the same plan again resumes without a second import', async () => {
    const s = source()
    // a status the set carries: once imported, the target's active status is this one, which holds nothing back
    writes(s.eml).store(validStatus({ scope: 'project.top', content: 'carried' }), s.kai)
    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const t = sharedTarget(shared, { after: async () => { throw new Error('the write may still land') } })
    const plan = planProjectMove({ source: raw(s.eml), target: raw(shared), project: 'top' })
    await expect(moveProject({ source: raw(s.eml), target: t, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'a.db') }, s.kai)).rejects.toThrow(/may still land/)
    expect(inSet(shared, s)).toBe(2)
    expect(inSet(s.eml, s)).toBe(2)
    expect(s.eml.projects.get('top')!.status).toBe('active')
    expect(raw(s.eml).inTransaction).toBe(false)
    const imports = () => count(shared, "op_log WHERE json_extract(payload, '$.call') = 'engram.import'")
    expect(imports()).toBe(1)

    // the plan is the same (the source did not change) and says it resumes: what a reopened dialog shows, with nothing to refuse
    const again = planProjectMove({ source: raw(s.eml), target: raw(shared), project: 'top' })
    expect(again.plan_hash).toBe(plan.plan_hash)
    expect(again.resume).toEqual({ seq: 2, op_id: expect.any(String) })
    expect(again.collisions).toEqual([])
    expect(again).toMatchObject({ kept_statuses: [], joins: [] })
    expect(again.created).toEqual({ projects: [], entities: [], users: [], agents: [], tags: [], subjects: [] })
    const result = await moveProject({ source: raw(s.eml), target: sharedTarget(shared), project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'b.db') }, s.kai)
    expect(result.resumed).toBe(true)
    expect(result.created).toEqual({ projects: [], entities: [], users: [], agents: [], tags: [], subjects: [] })
    expect(imports()).toBe(1)
    expect(inSet(s.eml, s)).toBe(0)
    expect(result.archived).toEqual(['top', 'child'])
    expect(verify(raw(s.eml))).toMatchObject({ ok: true })
    expect(verify(raw(shared))).toMatchObject({ ok: true })
    shared.close(); s.eml.close()
  })

  it('a rejected import in the target\'s log is not a resume', async () => {
    const s = source()
    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const t = sharedTarget(shared)
    const plan = planProjectMove({ source: raw(s.eml), target: raw(shared), project: 'top' })
    // the same import twice, as a lost answer and a resend would do: the second is rejected in the log
    const first = await t.write({ name: 'engram.import', input: (await importInput(s, shared)) as never })
    expect(first).toMatchObject({ moved: { engrams: 2 } })
    await expect(t.write({ name: 'engram.import', input: (await importInput(s, shared)) as never })).rejects.toThrow(/already in this brain/)
    expect(count(shared, 'op_log WHERE rejected IS NOT NULL')).toBe(1)
    const result = await moveProject({ source: raw(s.eml), target: t, project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'a.db') }, s.kai)
    expect(result.resumed).toBe(true)
    expect(result.import.seq).toBe(2)
    expect(inSet(s.eml, s)).toBe(0)
    shared.close(); s.eml.close()
  })

  it('a shared brain refuses engram.move_out: a member cannot remove engrams on the replicas', async () => {
    const s = source()
    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const plan = planProjectMove({ source: raw(s.eml), target: raw(shared), project: 'top' })
    await moveProject({ source: raw(s.eml), target: sharedTarget(shared), project: 'top', plan_hash: plan.plan_hash, backup_path: join(dir(), 'a.db') }, s.kai)
    const ids = [s.task.id]
    const set = exportSet(raw(shared), ids)
    await expect(sharedTarget(shared).write({ name: 'engram.move_out', input: { ids, set_hash: set.set_hash, drop_relations: set.crossing.map(r => r.id), target: { brain: 'elsewhere', op_id: 'x' } } }))
      .rejects.toThrow(/a shared brain takes no engram\.move_out/)
    expect(count(shared, 'engrams WHERE id = ?', s.task.id)).toBe(1)
    expect(count(shared, "op_log WHERE rejected LIKE 'INVALID: Invalid command: a shared brain takes no engram.move_out%'")).toBe(1)
    expect(verify(raw(shared))).toMatchObject({ ok: true })
    shared.close(); s.eml.close()
  })

  it('moveEngrams still takes any set: the caller\'s ids with the plan they confirmed', async () => {
    const s = source()
    const to = target()
    const ids = [s.task.id]
    const plan = planMove({ source: raw(s.eml), target: raw(to), ids })
    const result = await moveEngrams({ source: raw(s.eml), target: { db: raw(to) }, ids, plan_hash: plan.plan_hash, backup_path: join(dir(), 'a.db') }, s.kai)
    expect(result.moved.engrams).toBe(1)
    expect(s.eml.projects.get('top')!.status).toBe('active')
    to.close(); s.eml.close()
  })
})

async function importInput(s: ReturnType<typeof source>, to: EML) {
  const { exportSet, brainRef } = await import('../src/log/move')
  const set = exportSet(raw(s.eml), [s.task.id, s.decision.id])
  void to
  return { source: brainRef(raw(s.eml)), set_hash: set.set_hash, rows: set.rows }
}

describe('relation.move_end', () => {
  // spec team-brain-move-project-spec §4: a cross-brain reference keeps the
  // engram id and gets the brain id rewritten when the engram moves on.
  const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const MOVED_TO = '1f8fad5b-d9cb-469f-a165-70867728950e'
  const REMOTE_TASK = '2f8fad5b-d9cb-469f-a165-70867728950e'
  const REMOTE_LOG = '3f8fad5b-d9cb-469f-a165-70867728950e'

  /** An agent brain: a learning refining a task in OTHER, and a log of OTHER related to the learning. */
  function agentBrain() {
    const eml = brain('agent')
    createObject(eml, 'project', { id: 'elsewhere', name: 'Elsewhere' })
    const l = writes(eml).store(validNote({ scope: 'project.elsewhere', title: 'a-lesson' }))
    writes(eml).relate({ source_id: l.id, target_id: REMOTE_TASK, relation: 'refines', detection_method: 'manual', target_brain: OTHER })
    writes(eml).relate({ source_id: REMOTE_LOG, target_id: l.id, relation: 'related_to', detection_method: 'manual', source_brain: OTHER })
    const local = writes(eml).store(validNote({ scope: 'project.elsewhere', title: 'local' }))
    writes(eml).relate({ source_id: local.id, target_id: l.id, relation: 'supports', detection_method: 'manual' })
    const rels = (where: string) => (raw(eml).prepare(`SELECT id, source_brain, target_brain FROM relations WHERE ${where} ORDER BY ord`).all() as Array<{ id: string, source_brain: string | null, target_brain: string | null }>)
    return { eml, l, rels }
  }

  it('remoteReferences names the relations whose remote end is one of the ids in that brain', () => {
    const a = agentBrain()
    const [out, into] = a.rels('source_brain IS NOT NULL OR target_brain IS NOT NULL')
    expect(remoteReferences(raw(a.eml), OTHER, [REMOTE_TASK, REMOTE_LOG])).toEqual([out.id, into.id])
    expect(remoteReferences(raw(a.eml), OTHER, [REMOTE_TASK])).toEqual([out.id])
    expect(remoteReferences(raw(a.eml), MOVED_TO, [REMOTE_TASK, REMOTE_LOG])).toEqual([])
    expect(remoteReferences(raw(a.eml), OTHER, [a.l.id])).toEqual([])
    a.eml.close()
  })

  it('rewrites the brain of each named reference, on whichever side names it; local relations stay; a rebuild replays it', () => {
    const a = agentBrain()
    const ids = remoteReferences(raw(a.eml), OTHER, [REMOTE_TASK, REMOTE_LOG])
    expect(a.eml.apply({ name: 'relation.move_end', input: { from_brain: OTHER, to_brain: MOVED_TO, relations: ids } })).toEqual({ relations: 2 })
    expect(a.rels('1 = 1').map(r => [r.source_brain, r.target_brain])).toEqual([[null, MOVED_TO], [MOVED_TO, null], [null, null]])
    expect(remoteReferences(raw(a.eml), OTHER, [REMOTE_TASK, REMOTE_LOG])).toEqual([])
    expect(remoteReferences(raw(a.eml), MOVED_TO, [REMOTE_TASK, REMOTE_LOG])).toEqual(ids)
    expect(verify(raw(a.eml))).toMatchObject({ ok: true })
    a.eml.close()
  })

  it('refuses, and rewrites nothing: an unknown relation, one without an end in from_brain, this brain as to_brain, a shared brain, bad shapes', () => {
    const a = agentBrain()
    const ids = remoteReferences(raw(a.eml), OTHER, [REMOTE_TASK, REMOTE_LOG])
    const local = a.rels('source_brain IS NULL AND target_brain IS NULL')[0].id
    const attempt = (input: unknown) => { try { a.eml.apply({ name: 'relation.move_end', input: input as never }); throw new Error('not rejected') } catch (e) { if (e instanceof CommandError) return e; throw e } }
    const before = a.rels('1 = 1')
    expect(attempt({ from_brain: OTHER, to_brain: MOVED_TO, relations: ['nowhere'] })).toMatchObject({ code: 'NOT_FOUND' })
    expect(attempt({ from_brain: OTHER, to_brain: MOVED_TO, relations: [ids[0], local] }).message).toBe(`Invalid command: relation ${local} has no end in ${OTHER}.`)
    expect(attempt({ from_brain: MOVED_TO, to_brain: OTHER, relations: ids }).message).toMatch(/has no end in/)
    expect(attempt({ from_brain: OTHER, to_brain: a.eml.brainId(), relations: ids }).message).toMatch(/is this brain — a cross-brain reference names another one/)
    expect(attempt({ from_brain: OTHER, to_brain: OTHER, relations: ids }).message).toMatch(/must differ/)
    expect(attempt({ from_brain: OTHER, to_brain: 'main', relations: ids }).message).toMatch(/to_brain is a brain id/)
    expect(attempt({ from_brain: OTHER, to_brain: MOVED_TO, relations: [] }).message).toMatch(/relations is a list of relation ids/)
    expect(attempt({ from_brain: OTHER, to_brain: MOVED_TO, relations: [ids[0], ids[0]] }).message).toMatch(/appears twice/)
    expect(attempt({ from_brain: OTHER, to_brain: MOVED_TO, relations: ids, extra: 1 }).message).toMatch(/unknown field extra/)
    expect(a.rels('1 = 1')).toEqual(before)

    const shared = sharedBrain('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    const t = sharedTarget(shared)
    return expect(t.write({ name: 'relation.move_end', input: { from_brain: OTHER, to_brain: MOVED_TO, relations: ['x'] } } as never))
      .rejects.toThrow(/a shared brain holds no relation into another brain/)
      .then(() => { shared.close(); a.eml.close() })
  })
})
