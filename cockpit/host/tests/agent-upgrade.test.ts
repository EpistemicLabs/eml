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
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A legacy home: the brains as a cockpit before agent brains made them (seeded, named after the agent, token named after the agent). */
function legacyHome() {
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
  const learning = w({ type: 'learning', scope: 'user.dominik', title: 'ask-first', content: 'Ask before pushing.', tags: ['ops'], evidence: { source: 'user', happened: 'pushed unasked', quote: 'frag vorher' } })
  const profile = one(join(dataDir, main.brainFile), "SELECT id FROM engrams WHERE scope = 'agent.motti' AND type = 'profile'")
  const log1 = w({ type: 'log', scope: 'project.demo', title: 'session-1', content: 'x', properties: { what: 'w', landed: 'l', next: 'n' } })
  // crossing out: the learning refines the task; crossing in: the log relates to the persona; inner: the learning relates to a rule
  m.apply({ name: 'relation.create', input: { source_id: learning.id, target_id: task.id, relation: 'refines', detection_method: 'manual', explanation: 'came from the task' } }, motti)
  m.apply({ name: 'relation.create', input: { source_id: log1.id, target_id: profile.id, relation: 'related_to', detection_method: 'manual' } }, motti)
  const userRule = w({ type: 'rule', scope: 'user.dominik', title: 'push-on-yes', content: 'Push only on a yes.', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
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
  // A brain whose history predates the log, as a migrated home's does: the log starts with a genesis of this state.
  raw.prepare('DELETE FROM op_snapshots').run()
  raw.prepare('DELETE FROM op_log').run()
  writeGenesis(raw, core.CURRENT_BRAIN_SCHEMA_VERSION, '2026-11-04T00:00:00.000Z', main.brainId)
  m.close()
  Object.assign(ids, { task: task.id, learning: learning.id, profile: profile.id, log: log1.id, userRule: userRule.id, argusRule: argusRule.id, note: note.id, globalRule: globalRule.id, globalLearning: globalLearning.id })

  // Privat: the same seeds in user.motti (a legacy space set up with the agent's name as the user), one rule of its own.
  const p = open(privat.brainFile)
  const pm = p.env({ handle: 'motti', agent: null, ingestion_method: 'mcp', session_id: 's2' })
  const privatRule = p.apply({ name: 'engram.create', input: { type: 'rule', scope: 'user.motti', title: 'push-on-yes', content: 'Push only after a review.', properties: { applies: 'always', why: 'w', agreed: 'yes' } } }, pm)
  p.close()
  ids.privatRule = privatRule.id
  return { main, privat, ids, config: { token: main.tokenPlaintext, spaces: [{ token: privat.tokenPlaintext, name: 'Privat' }] } }
}

describe('agent upgrade', () => {
  const fixture = legacyHome()
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
    expect(deriveHandle(two, fixture.config)).toEqual({ reason: expect.stringMatching(/2 human users \(dominik, lasse\)/) })
    two.prepare("DELETE FROM users WHERE id != 'dominik'").run()
    two.prepare("DELETE FROM users").run()
    expect(deriveHandle(two, fixture.config)).toEqual({ reason: expect.stringMatching(/names no human user/) })
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

    // The config: the handle, both spaces bound, new tokens under the handle, the agent brain's token.
    expect(written).toHaveLength(1)
    const config = written[0]
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
    expect(core.verifyToken(new Database(control), config.token)).toMatchObject({ brainId: fixture.main.brainId, caller: 'dominik' })

    // Main: the identity set is gone, the work stays with its scope; the argus rule and the user note stay.
    const main = report.spaces[0]
    expect(main.moved).toMatchObject({ engrams: 9, entries: expect.any(Number), relations: 1 })
    expect(main.moved?.by).toEqual({ 'learning global': 1, 'learning user.dominik': 1, 'profile agent.motti': 1, 'profile user.dominik': 1, 'rule agent.motti': 3, 'rule global': 1, 'rule user.dominik': 1 })
    expect(q(mainFile, 'SELECT id, scope, type FROM engrams ORDER BY ord').map((r) => r.id)).toEqual([ids.task, ids.log, ids.argusRule, ids.note])
    expect(main.other_agents).toEqual([{ id: 'argus', engrams: 1 }])
    expect(main.rescoped).toEqual({ global_to_agent: [ids.globalRule, ids.globalLearning], user_to_handle: [] })
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
    expect(inAgent.find((r) => r.id === ids.learning)).toMatchObject({ scope: 'user.dominik', ingested_by: 'dominik', agent: 'motti' })
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
    expect(privat.rescoped?.user_to_handle).toHaveLength(2)
    expect(privat.collisions?.superseded.map((c) => c.title).sort()).toEqual(['motti-action-protocol', 'motti-engagement-style', 'motti-identity', 'motti-identity', 'motti-reasoning-discipline'])
    expect(privat.collisions?.needs_review).toEqual([{ id: ids.privatRule, existing: ids.userRule, title: 'push-on-yes', scope: 'user.dominik' }])
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1")[0].n).toBe(2)
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM relations WHERE relation = 'supersedes'")[0].n).toBe(4)
    expect(q(agentFile, "SELECT status FROM engrams WHERE title = 'motti-identity' AND scope = 'agent.motti' ORDER BY ord").map((r) => r.status)).toEqual(['active', 'invalidated'])
    expect(q(agentFile, "SELECT scope, status FROM engrams WHERE id = ?", ids.privatRule)).toEqual([{ scope: 'user.dominik', status: 'active' }])
    expect(q(agentFile, "SELECT COUNT(*) AS n FROM engrams WHERE scope LIKE 'user.motti%'")[0].n).toBe(0)
    // everything Privat held was identity: it is bound and empty of engrams now, its objects stay
    expect(privat.restamped?.space.engrams).toBe(0)
    expect(q(privatFile, 'SELECT COUNT(*) AS n FROM engrams')[0].n).toBe(0)
    expect(q(privatFile, 'SELECT id FROM users')).toEqual([{ id: 'motti' }])

    // Both logs verify, nothing dangles, the move backups are there.
    expect(log.verify(new Database(agentFile)).ok).toBe(true)
    expect(log.verify(new Database(mainFile)).ok).toBe(true)
    expect(readdirSync(join(dir, 'run')).sort()).toEqual([`${fixture.main.brainId.slice(0, 8)}-before-move.db`, `${fixture.privat.brainId.slice(0, 8)}-before-move.db`].sort())

    // Once bound, a second run has nothing to do.
    const again = await upgradeHome({ dataDir, config, backupsDir: join(home, 'backups'), modules, writeConfig: async () => { throw new Error('no write expected') } })
    expect(again.report.spaces.map((s) => [s.action, s.reason])).toEqual([['skipped', 'bound to motti already'], ['skipped', 'bound to motti already']])
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
