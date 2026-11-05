import { describe, it, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The agent upgrade (agent-upgrade.ts) on a home from before agent brains,
// built with core: two spaces named after their agent motti, the identity
// inside them with its relations to the work, legacy stamps, a global rule
// and learning, another agent's rule, a second space in user.motti with the
// same seeds. A dry run leaves the home byte-identical; the run gives motti
// its brain with the set, the references and the handle on every row, and
// binds both spaces; a second run has nothing to do.

const home = mkdtempSync(join(tmpdir(), 'cockpit-agent-upgrade-test-'))
process.env.EML_COCKPIT_HOME = home
const require = createRequire(import.meta.url)
const core = require('@engramprotocol/core')
const log = { ...require('@engramprotocol/core/dist/log/move-engrams'), ...require('@engramprotocol/core/dist/log/rebuild') }
const { writeGenesis } = require('@engramprotocol/core/dist/log/log')
const Database = require('better-sqlite3')
const modules = { core, log }

afterAll(() => rmSync(home, { recursive: true, force: true }))

type Row = Record<string, any>
const dataDir = join(home, 'data')
const q = (file: string, sql: string, ...params: unknown[]): Row[] => {
  const db = new Database(file, { readonly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
const one = (file: string, sql: string, ...params: unknown[]): Row => q(file, sql, ...params)[0]
// every handle closed before the home is removed: Windows refuses to unlink an open database file
const withDb = <T>(file: string, fn: (db: any) => T): T => {
  const db = new Database(file, { readonly: true })
  try { return fn(db) } finally { db.close() }
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A legacy home: the brains as a cockpit before agent brains made them (seeded, named after the agent, token named after the agent). */
function legacyHome(dataDir: string) {
  mkdirSync(join(dataDir, 'brains'), { recursive: true })
  const control = core.initControlDatabase(join(dataDir, 'control.db'))
  const main = core.provisionUser({ email: 'dominik@local', agentId: 'motti', userId: 'dominik', agentName: 'Motti', userName: 'Dominik', control, dataDir, tokenName: 'motti' })
  const privat = core.provisionUser({ email: 'dominik@local', agentId: 'motti', userId: 'motti', agentName: 'Motti', userName: 'motti', control, dataDir, tokenName: 'cockpit-local' })
  control.close()
  const open = (file: string) => new core.EML({ dbPath: join(dataDir, file), namespace: 'motti' })
  const ids: Record<string, string> = {}

  // Main: work in project demo, identity around it, written by the agent's token (ingested_by motti).
  const m = open(main.brainFile)
  const motti = m.env({ handle: 'motti', agent: null, ingestion_method: 'mcp', session_id: 's1' })
  const w = (input: Row, env = motti) => m.apply({ name: 'engram.create', input }, env)
  m.apply({ name: 'object.create', input: { object: 'project', fields: { id: 'demo', name: 'Demo' } } }, motti)
  m.apply({ name: 'object.create', input: { object: 'agent', fields: { id: 'argus', name: 'Argus' } } }, motti)
  m.apply({ name: 'object.create', input: { object: 'tag', fields: { name: 'ops' } } }, motti)
  const task = w({ type: 'task', scope: 'project.demo', title: 'hub', content: 'the work', status: 'active' })
  m.apply({ name: 'task.track', input: { id: task.id, text: 'went on' } }, motti)
  const learning = w({ type: 'learning', scope: 'agent.motti', title: 'ask-first', content: 'Ask before pushing.', tags: ['ops'], evidence: { source: 'user', happened: 'pushed unasked', quote: 'frag vorher' } })
  const profile = one(join(dataDir, main.brainFile), "SELECT id FROM engrams WHERE scope = 'agent.motti' AND type = 'profile'")
  const log1 = w({ type: 'log', scope: 'project.demo', title: 'session-1', content: 'x', properties: { what: 'w', landed: 'l', next: 'n' } })
  // crossing out: the learning refines the task; crossing in: the log relates to the persona; inner: the learning relates to a rule
  m.apply({ name: 'relation.create', input: { source_id: learning.id, target_id: task.id, relation: 'refines', detection_method: 'manual', explanation: 'came from the task' } }, motti)
  m.apply({ name: 'relation.create', input: { source_id: log1.id, target_id: profile.id, relation: 'related_to', detection_method: 'manual' } }, motti)
  // a rule in a user scope, as a brain from before v0.21 holds it (no rule is written there any more): written to the agent, re-scoped raw below
  const userRule = w({ type: 'rule', scope: 'agent.motti', title: 'push-on-yes', content: 'Push only on a yes.', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
  m.apply({ name: 'relation.create', input: { source_id: learning.id, target_id: userRule.id, relation: 'related_to', detection_method: 'manual' } }, motti)
  const argusRule = w({ type: 'rule', scope: 'agent.argus', title: 'argus-watch', content: 'Watch.', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
  const note = w({ type: 'note', scope: 'user.dominik', title: 'about-dominik', content: 'a note in a user scope stays' })
  // a rule and a learning left in global, as a brain before v0.21 holds them
  const globalRule = w({ type: 'rule', scope: 'agent.motti', title: 'finish-first', content: 'Finish before forking.', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
  const globalLearning = w({ type: 'learning', scope: 'agent.motti', title: 'verify-claims', content: 'Verify a claim first.', evidence: { source: 'self', happened: 'guessed' } })
  const raw = (m as any).db
  for (const id of [globalRule.id, globalLearning.id]) {
    raw.prepare("UPDATE engrams SET scope = 'global' WHERE id = ?").run(id)
    raw.prepare("UPDATE engrams_fts SET scope = 'global' WHERE id = ?").run(id)
  }
  for (const id of [userRule.id, learning.id]) {
    raw.prepare("UPDATE engrams SET scope = 'user.dominik' WHERE id = ?").run(id)
    raw.prepare("UPDATE engrams_fts SET scope = 'user.dominik' WHERE id = ?").run(id)
  }
  // A brain whose history predates the log, as a migrated home's does: the log starts with a genesis of this state.
  raw.prepare('DELETE FROM op_snapshots').run()
  raw.prepare('DELETE FROM op_log').run()
  writeGenesis(raw, core.CURRENT_BRAIN_SCHEMA_VERSION, '2026-11-04T00:00:00.000Z', main.brainId)
  m.close()
  Object.assign(ids, { task: task.id, learning: learning.id, profile: profile.id, log: log1.id, userRule: userRule.id, argusRule: argusRule.id, note: note.id, globalRule: globalRule.id, globalLearning: globalLearning.id })

  // Privat: the same seeds in user.motti (a legacy space set up with the agent's name as the user), one rule of its own.
  const p = open(privat.brainFile)
  const pm = p.env({ handle: 'motti', agent: null, ingestion_method: 'mcp', session_id: 's2' })
  const privatRule = p.apply({ name: 'engram.create', input: { type: 'rule', scope: 'agent.motti', title: 'push-on-yes', content: 'Push only after a review.', properties: { applies: 'always', why: 'w', agreed: 'yes' } } }, pm)
  const praw = (p as any).db
  praw.prepare("UPDATE engrams SET scope = 'user.motti' WHERE id = ?").run(privatRule.id)
  praw.prepare("UPDATE engrams_fts SET scope = 'user.motti' WHERE id = ?").run(privatRule.id)
  praw.prepare('DELETE FROM op_snapshots').run()
  praw.prepare('DELETE FROM op_log').run()
  writeGenesis(praw, core.CURRENT_BRAIN_SCHEMA_VERSION, '2026-11-04T00:00:00.000Z', privat.brainId)
  p.close()
  ids.privatRule = privatRule.id
  return { main, privat, ids, config: { token: main.tokenPlaintext, spaces: [{ token: privat.tokenPlaintext, name: 'Privat' }] } }
}

describe('agent upgrade', () => {
  const fixture = legacyHome(dataDir)
  const mainFile = join(dataDir, fixture.main.brainFile)
  const privatFile = join(dataDir, fixture.privat.brainFile)

  it('a dry run reports what the run would do and leaves the home byte-identical', async () => {
    const { dryRun } = await import('../src/agent-upgrade.js')
    const before = { main: sha(mainFile), privat: sha(privatFile), control: sha(join(dataDir, 'control.db')) }
    const report = await dryRun({ dataDir, config: fixture.config, dir: join(home, 'dry'), modules })
    if (report.reason) console.error('REASON', report.reason)
    expect(report.reason).toBeUndefined()
    expect(report.status).toBe('ok')
    expect(report.mode).toBe('dry-run')
    expect(report.handle).toBe('dominik')
    expect(report.spaces.map((s) => [s.name, s.action, s.agent])).toEqual([['Main', 'upgraded', 'motti'], ['Privat', 'upgraded', 'motti']])
    expect(report.spaces[0].moved?.engrams).toBe(9)
    expect(report.spaces[0].crossing).toMatchObject({ planned: 2, recreated: 2 })
    expect({ main: sha(mainFile), privat: sha(privatFile), control: sha(join(dataDir, 'control.db')) }).toEqual(before)
    expect(existsSync(join(home, 'dry', 'dry', 'data', 'control.db'))).toBe(true)
    expect(readdirSync(dataDir)).toEqual(['brains', 'control.db'])
  })

  it('needs a handle it can tell: the config\'s, the caller\'s, else the one human user of the main space', async () => {
    const { deriveHandle, dryRun } = await import('../src/agent-upgrade.js')
    const db = new Database(mainFile)
    expect(deriveHandle(db, fixture.config)).toEqual({ handle: 'dominik' })
    expect(deriveHandle(db, { ...fixture.config, handle: 'dom' })).toEqual({ handle: 'dom' })
    expect(deriveHandle(db, fixture.config, 'given')).toEqual({ handle: 'given' })
    db.close()
    // A copy with a second human: the upgrade waits, every space skipped with the reason.
    const copy = join(home, 'two-humans.db')
    const src = new Database(mainFile, { readonly: true })
    src.prepare('VACUUM INTO ?').run(copy)
    src.close()
    const two = new Database(copy)
    two.prepare("INSERT INTO users (id, name, created_at, updated_at) VALUES ('lasse', 'Lasse', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')").run()
    expect(deriveHandle(two, fixture.config)).toEqual({ reason: 'the main space names 2 human users (dominik, lasse), so your handle cannot be told' })
    two.prepare("DELETE FROM users WHERE id != 'dominik'").run()
    two.prepare("DELETE FROM users").run()
    expect(deriveHandle(two, fixture.config)).toEqual({ reason: 'the main space names no human user, so your handle cannot be told' })
    two.close()
    const given = await dryRun({ dataDir, config: fixture.config, dir: join(home, 'dry3'), modules, handle: 'dom' })
    expect(given.status).toBe('ok')
    expect(given.handle).toBe('dom')
  })

  it('the run: motti gets its brain with the identity, its history, the references and the handle; the spaces are bound', async () => {
    const { upgradeHome, needsUpgrade } = await import('../src/agent-upgrade.js')
    const written: Row[] = []
    const { report, dir } = await upgradeHome({
      dataDir, config: fixture.config, backupsDir: join(home, 'backups'), modules,
      writeConfig: async (c) => { written.push(c) },
    })
    expect(report.reason).toBeUndefined()
    expect(report.status).toBe('ok')
    expect(report.mode).toBe('run')
    expect(existsSync(join(dir, 'dry-run.json'))).toBe(true)
    expect(existsSync(join(dir, 'run.json'))).toBe(true)
    expect(existsSync(join(dir, 'before', 'data', 'control.db'))).toBe(true)
    expect(report.agents).toEqual([{ id: 'motti', brainId: expect.any(String), created: true }])
    const agentFile = join(dataDir, 'brains', `${report.agents[0].brainId}.db`)
    const ids = fixture.ids

    // The config, written as the run went: the agent brain first, then each space as it was bound, the whole at the end.
    expect(written).toHaveLength(4)
    expect(written[0]).toMatchObject({ handle: 'dominik', agents: [{ id: 'motti' }] })
    expect(written[0].agent).toBeUndefined()
    expect(written[1]).toMatchObject({ agent: 'motti', spaces: [{ name: 'Privat' }] })
    expect(written[1].spaces[0].agent).toBeUndefined()
    const config = written[3]
    expect(config).toMatchObject({ handle: 'dominik', agent: 'motti', spaces: [{ name: 'Privat', agent: 'motti' }] })
    expect(config.token).not.toBe(fixture.config.token)
    expect(config.spaces[0].token).not.toBe(fixture.config.spaces[0].token)
    expect(config.agents).toHaveLength(1)
    expect(needsUpgrade(config)).toBe(false)
    const control = join(dataDir, 'control.db')
    expect(q(control, 'SELECT b.name, t.name AS token, t.revoked_at IS NOT NULL AS revoked FROM tokens t JOIN brains b ON b.id = t.brain_id ORDER BY t.rowid'))
      .toEqual([
        { name: 'motti', token: 'motti', revoked: 1 }, { name: 'motti', token: 'cockpit-local', revoked: 1 },
        { name: 'motti', token: 'dominik', revoked: 0 }, { name: 'motti', token: 'dominik', revoked: 0 }, { name: 'motti', token: 'dominik', revoked: 0 },
      ])
    expect(withDb(control, (db) => core.verifyToken(db, config.token))).toMatchObject({ brainId: fixture.main.brainId, caller: 'dominik' })

    // Main: the identity set is gone, the work stays with its scope; the argus rule and the user note stay.
    const main = report.spaces[0]
    expect(main.moved).toMatchObject({ engrams: 9, entries: expect.any(Number), relations: 1 })
    expect(main.moved?.by).toEqual({ 'learning global': 1, 'learning user.dominik': 1, 'profile agent.motti': 1, 'profile user.dominik': 1, 'rule agent.motti': 3, 'rule global': 1, 'rule user.dominik': 1 })
    expect(q(mainFile, 'SELECT id, scope, type FROM engrams ORDER BY ord').map((r) => r.id)).toEqual([ids.task, ids.log, ids.argusRule, ids.note])
    expect(main.other_agents).toEqual([{ id: 'argus', engrams: 1 }])
    expect(main.rescoped).toEqual({ global_to_agent: [ids.globalRule, ids.globalLearning], user_to_agent: [ids.learning, ids.userRule], user_to_handle: [] })
    expect(main.crossing?.items.map((c) => [c.direction, c.relation, c.other])).toEqual([['out', 'refines', ids.task], ['in', 'related_to', ids.log]])
    // the five seeds were written without a handle (direct); the four engrams the agent's token wrote get the handle via motti
    expect(main.restamped).toEqual({ space: { engrams: 4, entries: expect.any(Number) }, agent: { engrams: 4, entries: expect.any(Number) } })
    expect(main.token).toBe('reissued')
    expect(main.dangling).toEqual({ space: 0, agent: 0 })
    expect(main.verify).toEqual({ space: true, agent: true })
    expect(q(mainFile, 'SELECT COUNT(*) AS n FROM relations')[0].n).toBe(0)

    // The agent brain: the set with its scopes settled, the references naming the space, every row stamped dominik via motti.
    const inAgent = q(agentFile, 'SELECT id, type, scope, status, ingested_by, agent FROM engrams ORDER BY ord')
    expect(inAgent.find((r) => r.id === ids.globalRule)).toMatchObject({ scope: 'agent.motti', ingested_by: 'dominik', agent: 'motti' })
    expect(inAgent.find((r) => r.id === ids.globalLearning)).toMatchObject({ scope: 'agent.motti', status: 'active' })
    // a rule or learning in a user scope is the agent's now (decision agent-brain-rules-at-agent-user-is-profile), with its id and content
    expect(inAgent.find((r) => r.id === ids.learning)).toMatchObject({ scope: 'agent.motti', ingested_by: 'dominik', agent: 'motti' })
    expect(inAgent.find((r) => r.id === ids.userRule)).toMatchObject({ scope: 'agent.motti', status: 'active' })
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE type IN ('rule', 'learning') AND scope LIKE 'user.%'")[0].n).toBe(0)
    expect(inAgent.filter((r) => r.ingested_by === 'motti')).toEqual([])
    // (the supersedes edges of Privat's settled duplicates come on top, checked below)
    expect(q(agentFile, "SELECT source_id, target_id, relation, source_brain, target_brain, explanation FROM relations WHERE relation != 'supersedes' ORDER BY ord")).toEqual([
      { source_id: ids.learning, target_id: ids.userRule, relation: 'related_to', source_brain: null, target_brain: null, explanation: null },
      { source_id: ids.learning, target_id: ids.task, relation: 'refines', source_brain: null, target_brain: fixture.main.brainId, explanation: 'came from the task' },
      { source_id: ids.log, target_id: ids.profile, relation: 'related_to', source_brain: fixture.main.brainId, target_brain: null, explanation: null },
    ])
    expect(q(agentFile, "SELECT id FROM tags")).toEqual([{ id: 'ops' }])
    expect(q(agentFile, "SELECT engram_id, tag_id FROM engram_tags")).toEqual([{ engram_id: ids.learning, tag_id: 'ops' }])
    expect(q(agentFile, 'SELECT COUNT(*) AS n FROM entries WHERE engram_id = ?', ids.learning)[0].n).toBeGreaterThan(0)
    expect(q(agentFile, "SELECT author, agent FROM entries WHERE engram_id = ? AND kind = 'evidence'", ids.learning)).toEqual([{ author: 'dominik', agent: 'motti' }])

    // Privat: the seeds again are superseded by Main's, user.motti became user.dominik, the variant rule waits for review.
    const privat = report.spaces[1]
    expect(privat.moved?.engrams).toBe(6)
    expect(privat.rescoped?.user_to_handle).toHaveLength(1)
    expect(privat.rescoped?.user_to_agent).toEqual([ids.privatRule])
    // the agent's core profile could not arrive next to Main's and was retired before the move; the other seeds retire after it
    expect(privat.collisions?.superseded.map((c) => c.title)).toEqual(['motti-identity'])
    expect(privat.collisions?.seeds_retired).toHaveLength(4)
    expect(privat.collisions?.needs_review).toEqual([{ id: ids.privatRule, existing: ids.userRule, title: 'push-on-yes', scope: 'agent.motti' }])
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1")[0].n).toBe(2)
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM relations WHERE relation = 'supersedes'")[0].n).toBe(0)
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE origin = 'eml-default-brain' AND status = 'invalidated'")[0].n).toBe(5)
    expect(q(agentFile, "SELECT status FROM engrams WHERE title = 'motti-identity' AND scope = 'agent.motti' ORDER BY ord").map((r) => r.status)).toEqual(['active', 'invalidated'])
    expect(q(agentFile, "SELECT scope, status FROM engrams WHERE id = ?", ids.privatRule)).toEqual([{ scope: 'agent.motti', status: 'active' }])
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE scope LIKE 'user.motti%'")[0].n).toBe(0)
    // everything Privat held was identity: it is bound and empty of engrams now, its objects stay
    expect(privat.restamped?.space.engrams).toBe(0)
    expect(q(privatFile, 'SELECT COUNT(*) AS n FROM engrams')[0].n).toBe(0)
    expect(q(privatFile, 'SELECT id FROM users')).toEqual([{ id: 'motti' }])

    // Both logs verify, nothing dangles, the move backups are there.
    expect(withDb(agentFile, (db) => log.verify(db).ok)).toBe(true)
    expect(withDb(mainFile, (db) => log.verify(db).ok)).toBe(true)
    expect(readdirSync(join(dir, 'run')).sort()).toEqual([`${fixture.main.brainId.slice(0, 8)}-before-move.db`, `${fixture.privat.brainId.slice(0, 8)}-before-move.db`].sort())

    // Once bound, a second run has nothing to do.
    const again = await upgradeHome({ dataDir, config, backupsDir: join(home, 'backups'), modules, writeConfig: async () => { throw new Error('no write expected') } })
    expect(again.report.spaces.map((s) => [s.action, s.reason])).toEqual([['skipped', 'bound to motti already'], ['skipped', 'bound to motti already']])
    expect(again.dir).toBeNull()
  })

  it('a run interrupted after the move and before the config was written is resumed with its own agent brain, never built twice', async () => {
    const { upgradeHome } = await import('../src/agent-upgrade.js')
    const data2 = join(home, 'home2', 'data')
    const f = legacyHome(data2)
    const main2 = join(data2, f.main.brainFile)
    const backups = join(home, 'home2', 'backups')
    // The first run dies at the config write that would bind Main — after the agent brain was made and
    // Main's identity moved — and the host went down before the earlier write reached the disk, so the next
    // start reads the config as it was: no agents, nothing bound.
    let calls = 0
    const first = await upgradeHome({ dataDir: data2, config: f.config, backupsDir: backups, modules, writeConfig: async () => { if (++calls === 2) throw new Error('disk full') } })
    expect(first.report.status).toBe('failed')
    expect(first.report.reason).toMatch(/Main: disk full/)
    const control = join(data2, 'control.db')
    const brains = q(control, "SELECT id, name FROM brains ORDER BY created_at, rowid")
    expect(brains).toHaveLength(3)
    const orphan = brains[2]
    expect(orphan.name).toBe('motti')
    expect(q(join(data2, 'brains', `${orphan.id}.db`), 'SELECT COUNT(*) AS n FROM engrams')[0].n).toBe(9)
    expect(q(main2, "SELECT COUNT(*) AS n FROM engrams WHERE scope = 'user.dominik' AND type = 'rule'")[0].n).toBe(0)
    // Its crossing relations are gone from the space and wait in the journal.
    expect(q(main2, 'SELECT COUNT(*) AS n FROM relations')[0].n).toBe(0)
    expect(existsSync(join(backups, 'agent-upgrade', 'pending', `${f.main.brainId}.json`))).toBe(true)
    // The next start: the same config as before (nothing was written), the orphan found and taken up.
    const written: Row[] = []
    const second = await upgradeHome({ dataDir: data2, config: f.config, backupsDir: backups, modules, writeConfig: async (c) => { written.push(c) } })
    expect(second.report.reason).toBeUndefined()
    expect(second.report.status).toBe('ok')
    expect(second.report.agents).toEqual([{ id: 'motti', brainId: orphan.id, created: false, resumed: true }])
    expect(q(control, "SELECT COUNT(*) AS n FROM brains WHERE name = 'motti'")[0].n).toBe(3)
    const main = second.report.spaces[0]
    // nothing left to move: the resumed run binds, re-creates the references from the journal and finishes the re-scope
    expect(main.action).toBe('bound')
    expect(main.moved?.engrams).toBe(0)
    expect(main.crossing).toMatchObject({ planned: 2, recreated: 2 })
    // the first run got as far as the re-scope and the re-stamp before it died; nothing is left of either
    expect(main.rescoped?.global_to_agent).toHaveLength(0)
    expect(main.restamped).toEqual({ space: { engrams: 0, entries: 0 }, agent: { engrams: 0, entries: 0 } })
    expect(main.verify).toEqual({ space: true, agent: true })
    const agentFile = join(data2, 'brains', `${orphan.id}.db`)
    expect(q(agentFile, "SELECT relation, source_brain, target_brain FROM relations WHERE source_brain IS NOT NULL OR target_brain IS NOT NULL ORDER BY ord"))
      .toEqual([{ relation: 'refines', source_brain: null, target_brain: f.main.brainId }, { relation: 'related_to', source_brain: f.main.brainId, target_brain: null }])
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE scope = 'global'")[0].n).toBe(0)
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE ingested_by = 'motti'")[0].n).toBe(0)
    expect(written.at(-1)).toMatchObject({ handle: 'dominik', agent: 'motti', agents: [{ id: 'motti' }], spaces: [{ name: 'Privat', agent: 'motti' }] })
    expect(withDb(control, (db) => core.verifyToken(db, written.at(-1).agents[0].token))).toMatchObject({ brainId: orphan.id, caller: 'dominik' })
    expect(q(control, "SELECT COUNT(*) AS n FROM tokens WHERE brain_id = ? AND revoked_at IS NULL", orphan.id)[0].n).toBe(1)
    expect(existsSync(join(backups, 'agent-upgrade', 'pending', `${f.main.brainId}.json`))).toBe(false)
  })

  it('a run that dies right after the move still gets its references: from the journal, on the next run', async () => {
    const { upgradeHome } = await import('../src/agent-upgrade.js')
    const data3 = join(home, 'home3', 'data')
    const f = legacyHome(data3)
    const backups = join(home, 'home3', 'backups')
    // the dry run moves both spaces on the copies (two calls); the real run's first move is the third, and the power goes right after it
    let moves = 0
    const cut = { ...modules, log: { ...modules.log, moveEngrams: async (...args: unknown[]) => { const r = await (modules.log.moveEngrams as (...a: unknown[]) => Promise<unknown>)(...args); if (++moves === 3) throw new Error('power cut'); return r } } }
    const first = await upgradeHome({ dataDir: data3, config: f.config, backupsDir: backups, modules: cut, writeConfig: async () => {} })
    expect(first.report).toMatchObject({ status: 'failed', reason: 'Main: power cut' })
    const main3 = join(data3, f.main.brainFile)
    expect(q(main3, 'SELECT COUNT(*) AS n FROM relations')[0].n).toBe(0)
    const journal = JSON.parse(readFileSync(join(backups, 'agent-upgrade', 'pending', `${f.main.brainId}.json`), 'utf8'))
    expect(journal.map((r: Row) => [r.direction, r.relation])).toEqual([['out', 'refines'], ['in', 'related_to']])
    const written: Row[] = []
    const second = await upgradeHome({ dataDir: data3, config: written.at(-1) ?? f.config, backupsDir: backups, modules, writeConfig: async (c) => { written.push(c) } })
    expect(second.report.reason).toBeUndefined()
    const main = second.report.spaces[0]
    expect(main.crossing).toMatchObject({ planned: 2, recreated: 2 })
    expect(main.rescoped?.global_to_agent).toHaveLength(2)
    expect(main.restamped?.agent.engrams).toBe(4)
    const agentFile = join(data3, 'brains', `${second.report.agents[0].brainId}.db`)
    expect(q(agentFile, 'SELECT COUNT(*) AS n FROM relations WHERE source_brain IS NOT NULL OR target_brain IS NOT NULL')[0].n).toBe(2)
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE scope = 'global' OR ingested_by = 'motti'")[0].n).toBe(0)
    expect(withDb(agentFile, (db) => log.verify(db).ok)).toBe(true)
  })

  it('the host start after a run that failed once the first space was bound: the file\'s config wins, that space works, the rest carries the reason', async () => {
    const { upgradeAtStart, needsUpgrade } = await import('../src/agent-upgrade.js')
    const data4 = join(home, 'home4', 'data')
    const f = legacyHome(data4)
    const backups = join(home, 'home4', 'backups')
    // The config file as the host keeps it: every write lands, until the one that would bind Privat.
    let file: Row = f.config
    let writes = 0
    const fail = { on: 3 }
    const io = {
      readConfig: async () => structuredClone(file),
      writeConfig: async (c: Row) => { if (++writes === fail.on) throw new Error('disk full'); file = structuredClone(c) },
    }
    const lines: string[] = []
    const start = await upgradeAtStart({ dataDir: data4, backupsDir: backups, modules, log: (l) => lines.push(l), ...io })
    expect(start.upgrade).toMatchObject({ reason: 'Privat: disk full' })
    // What the start opens the spaces with: the file's config — Main bound with its new token, Privat as before.
    const control = join(data4, 'control.db')
    expect(start.config).toMatchObject({ handle: 'dominik', agent: 'motti', agents: [{ id: 'motti' }], spaces: [{ name: 'Privat', token: f.config.spaces[0].token }] })
    expect(start.config?.spaces?.[0].agent).toBeUndefined()
    expect(start.config?.token).not.toBe(f.config.token)
    expect(withDb(control, (db) => core.verifyToken(db, start.config!.token))).toMatchObject({ brainId: f.main.brainId, caller: 'dominik' })
    expect(withDb(control, (db) => core.verifyToken(db, start.config!.spaces![0].token))).toMatchObject({ brainId: f.privat.brainId })
    expect(withDb(control, (db) => core.verifyToken(db, f.config.token))).toBeNull()
    expect(needsUpgrade(start.config!)).toBe(true)
    // The next start finishes Privat with the same agent brain; nothing is built twice.
    fail.on = 0
    const again = await upgradeAtStart({ dataDir: data4, backupsDir: backups, modules, log: (l) => lines.push(l), ...io })
    expect(again.upgrade).toBeNull()
    expect(again.config).toMatchObject({ agent: 'motti', spaces: [{ name: 'Privat', agent: 'motti' }] })
    expect(again.config?.agents).toHaveLength(1)
    expect(q(control, "SELECT COUNT(*) AS n FROM brains WHERE name = 'motti'")[0].n).toBe(3)
    expect(needsUpgrade(again.config!)).toBe(false)
    // and a third start does nothing
    const third = await upgradeAtStart({ dataDir: data4, backupsDir: backups, modules, log: (l) => lines.push(l), ...io })
    expect(third.upgrade).toBeNull()
    expect(lines.filter((l) => l.includes('nothing to do'))).toHaveLength(0)
  })

  it('renders the report as text', async () => {
    const { renderReport, summary } = await import('../src/agent-upgrade.js')
    const run = JSON.parse(readFileSync(join(home, 'backups', 'agent-upgrade', readdirSync(join(home, 'backups', 'agent-upgrade'))[0], 'run.json'), 'utf8'))
    const text = renderReport(run)
    expect(text).toContain('agent upgrade (run) at')
    expect(text).toContain('space Main (')
    expect(text).toContain('crossing relations: 2 planned, 2 re-created as references')
    expect(text).toContain('needs review (same title, other content): push-on-yes')
    expect(summary(run)).toBe('2 space(s) upgraded, 0 bound, 0 skipped; 15 engrams moved, 2 references')
  })
})
