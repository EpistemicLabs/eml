import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CockpitConfig } from './config.js'
import { AGENT_ID } from './config.js'
import { CORE_INDEX, CORE_LOG } from './paths.js'

/**
 * The agent upgrade (decision cockpit-identity-agent-brain, spec
 * agent-brain-spec §4–§5): a home from before agent brains keeps every
 * agent's identity inside its spaces. The upgrade gives each space's agent
 * its own brain and moves the identity there — with its history, its
 * relations to the work it came from as cross-brain references, the human's
 * handle on every row — and binds the space to the agent.
 *
 * Selection, per space, deterministic: the agent is the brain's name in
 * control.db (how a space was provisioned before: named after its agent).
 * The identity set is every engram, any status, of type profile, rule or
 * learning in agent.<that agent> or user.<any>, plus every rule and learning
 * in global (a rule has an owner; one written before v0.21 in global is the
 * agent's). Everything else stays in the space with its scope: tasks,
 * decisions, notes, logs, status and references also in an agent or user
 * scope, project rules, entity profiles, global facts. Other agents found in the
 * space stay there and are listed.
 *
 * Steps, per space: plan the move (core planMove) and check that every
 * crossing relation can become a reference; move the set into the agent brain
 * (core moveEngrams: the space is backed up, the set imported with its
 * entries, inner relations, tags and subjects, then taken out of the space,
 * the crossing relations dropped there); re-create each crossing relation in
 * the agent brain as a cross-brain reference naming the space (direction,
 * verb, explanation and strength kept); re-scope global → agent.<id> and
 * user.<other> → user.<handle> as recorded ops; settle collisions with what
 * the agent brain holds already (a second core profile for a scope, and an
 * engram identical in type, title and content, are superseded by the first;
 * same type, scope and title with other content is kept and listed for
 * review); re-stamp the legacy authorship (ingested_by = the agent's name →
 * the handle, via the agent) in both brains; re-issue the space's token under
 * the handle; bind the space in the config. Both op logs verify and no
 * relation dangles, or the run fails.
 *
 * Two ways to run it on the same code: the host at start (agentUpgradeAtStart
 * — after the brain server's migrations, before any space opens: a dry run on
 * copies first, the real run only when every check passes, else the home
 * stays as it was and the spaces carry the reason for the banner), and the
 * CLI `eml-cockpit upgrade-agents` (dry run by default, --run by hand, host
 * down). The handle is the config's, else the one human user of the main
 * space (a users row that is not an agent id); with none or several the
 * upgrade waits for it. Backups go to backups/agent-upgrade/<stamp>/.
 */

const require = createRequire(import.meta.url)

// better-sqlite3 is a runtime dependency of the host; typed locally to what is used here.
type Statement = { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes: number } }
export type Db = { prepare(sql: string): Statement; pragma(s: string): unknown; close(): void; exec(sql: string): void }
const Database = require('better-sqlite3') as new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => Db

type Env = unknown
interface Eml {
  apply(command: { name: string; input: unknown }, env?: Env): unknown
  env(actor: Record<string, unknown>): Env
  brainId(): string | null
  close(): void
}

/** The core module (dist/core.cjs) and its op-log tools (dist/core-log.cjs); tests pass the workspace packages. */
export interface CoreModules {
  core: {
    initControlDatabase(file: string): Db
    provisionUser(opts: Record<string, unknown>): { brainId: string; brainFile: string; tokenPlaintext: string; tokenId: string; userId: string }
    issueToken(control: Db, opts: { userId: string; brainId: string; name?: string | null }): { tokenId: string; plaintext: string }
    revokeToken(control: Db, tokenId: string): boolean
    verifyToken(control: Db, plaintext: string | null | undefined): { tokenId: string; userId: string; brainId: string; caller: string | null } | null
    EML: { fromConnection(db: unknown, namespace: string): Eml }
  }
  log: {
    planMove(args: { source: unknown; target: unknown; ids: string[] }): MovePlan
    moveEngrams(args: { source: unknown; target: { db: unknown }; ids: string[]; plan_hash: string; backup_path: string }, env: Env): Promise<{ backup_path: string; ids: string[] }>
    verify(db: unknown): { ok: true } | { ok: false; problem: string }
  }
}

interface MovePlan {
  source: string
  target: string
  plan_hash: string
  moved: { engrams: number; entries: number; relations: number }
  crossing: Array<{ id: string; relation: string; direction: 'out' | 'in'; other: { id: string; type: string; title: string | null } }>
  external_refs: unknown[]
  incoming_refs: unknown[]
  collisions: string[]
}

export const bundledCoreModules = (): CoreModules => ({ core: require(CORE_INDEX), log: require(CORE_LOG) })

export interface UpgradeInput {
  /** control.db and brains/ (the home's data dir, or the dry run's copy). */
  dataDir: string
  config: CockpitConfig
  /** Where the move backups of this run go. */
  backupDir: string
  /** Other agents found in a space that get a brain too (default: none; they stay). */
  agents?: string[]
  /** The home's human when the config has none and it cannot be derived. */
  handle?: string
  modules?: CoreModules
  now?: () => Date
}

export interface SpaceReport {
  id: string
  name: string
  main: boolean
  action: 'upgraded' | 'bound' | 'skipped'
  reason?: string
  agent: string | null
  counts?: { space: Counts; agent: Counts }
  before?: { space: Counts; agent: Counts }
  moved?: { engrams: number; entries: number; relations: number; by: Record<string, number> }
  crossing?: { planned: number; recreated: number; items: Array<{ id: string; relation: string; direction: 'out' | 'in'; other: string }> }
  refs?: { external: number; incoming: number }
  rescoped?: { global_to_agent: string[]; user_to_handle: string[] }
  /** superseded: the same identity again (a core profile for a scope that has one, an engram identical in type, title and content) — the first space's wins; seeds_retired: a later space's default seeds (origin eml-default-brain), which add nothing to an agent brain filled by an earlier space; needs_review: same type, scope and title with other content, both kept. */
  collisions?: { superseded: Array<{ id: string; by: string; title: string | null }>; seeds_retired: string[]; needs_review: Array<{ id: string; existing: string; title: string | null; scope: string }> }
  restamped?: { space: { engrams: number; entries: number }; agent: { engrams: number; entries: number } }
  other_agents?: Array<{ id: string; engrams: number }>
  token?: 'reissued' | 'kept'
  dangling?: { space: number; agent: number }
  verify?: { space: boolean; agent: boolean }
}

export interface Counts { engrams: number; entries: number; relations: number }

export interface UpgradeReport {
  mode: 'dry-run' | 'run'
  at: string
  /** ok: every space is bound (or was); waiting: nothing changed, `reason` says what is missing; failed: a check failed, `reason` says which. */
  status: 'ok' | 'waiting' | 'failed'
  reason?: string
  handle: string | null
  agents: Array<{ id: string; brainId: string; created: boolean }>
  spaces: SpaceReport[]
  /** The config as the run leaves it (the caller writes it on a real run). */
  config: CockpitConfig
}

const IDENTITY_SET_SQL = `SELECT id FROM engrams WHERE
  (type IN ('profile', 'rule', 'learning') AND (scope = ? OR scope LIKE 'user.%'))
  OR (type IN ('rule', 'learning') AND scope = 'global')
  ORDER BY ord`

interface BrainRow { id: string; name: string; brain_file: string; status: string; owner_id: string }

function openBrain(file: string): Db {
  const db = new Database(file, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

const counts = (db: Db): Counts => ({
  engrams: (db.prepare('SELECT COUNT(*) AS n FROM engrams').get() as { n: number }).n,
  entries: (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n,
  relations: (db.prepare('SELECT COUNT(*) AS n FROM relations').get() as { n: number }).n,
})

/** Relations whose local end names no engram of this brain: must be zero after a move. */
const dangling = (db: Db): number => (db.prepare(`SELECT COUNT(*) AS n FROM relations
  WHERE (source_brain IS NULL AND source_id NOT IN (SELECT id FROM engrams))
     OR (target_brain IS NULL AND target_id NOT IN (SELECT id FROM engrams))`).get() as { n: number }).n

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')

/** The brain a config token belongs to, with the token's row. */
function brainOfToken(modules: CoreModules, control: Db, token: string): { brain: BrainRow; tokenId: string; tokenName: string | null; userId: string } | null {
  const verified = modules.core.verifyToken(control, token)
  if (!verified) return null
  const brain = control.prepare('SELECT id, name, brain_file, status, owner_id FROM brains WHERE id = ?').get(verified.brainId) as BrainRow | undefined
  if (!brain) return null
  return { brain, tokenId: verified.tokenId, tokenName: verified.caller, userId: verified.userId }
}

/**
 * The home's human: the config's handle, the caller's, else the one user of
 * the main space that is not an agent. Null with the reason when it cannot be told.
 */
export function deriveHandle(mainDb: Db, config: CockpitConfig, given?: string): { handle: string } | { reason: string } {
  if (config.handle) return { handle: config.handle }
  if (given) return { handle: given }
  const humans = (mainDb.prepare('SELECT id FROM users WHERE id NOT IN (SELECT id FROM agents) ORDER BY id').all() as Array<{ id: string }>).map((u) => u.id)
  if (humans.length === 1) return { handle: humans[0] }
  return {
    reason: humans.length === 0
      ? 'the main space names no human user, so the handle every token is issued under cannot be told — set it (upgrade-agents --handle <handle>)'
      : `the main space names ${humans.length} human users (${humans.join(', ')}), so the handle cannot be told — set it (upgrade-agents --handle <handle>)`,
  }
}

/**
 * Run the upgrade on `dataDir`. Reads the config, writes the brains and
 * control.db there, and returns the report with the config as it should be
 * written (the caller persists it; a dry run never does).
 */
export async function upgradeAgents(input: UpgradeInput, mode: 'dry-run' | 'run'): Promise<UpgradeReport> {
  const modules = input.modules ?? bundledCoreModules()
  const now = input.now ?? (() => new Date())
  const at = now().toISOString()
  const control = modules.core.initControlDatabase(path.join(input.dataDir, 'control.db'))
  const open: Db[] = []
  const report: UpgradeReport = { mode, at, status: 'ok', handle: input.config.handle ?? null, agents: [], spaces: [], config: structuredClone(input.config) }
  try {
    // The spaces: main first, then the config's order.
    const entries = [
      { token: input.config.token, name: input.config.mainName ?? 'Main', main: true, bound: input.config.agent ?? null },
      ...(input.config.spaces ?? []).map((s) => ({ token: s.token, name: s.name ?? '', main: false, bound: s.agent ?? null })),
    ]
    const spaces = entries.map((e) => ({ ...e, found: brainOfToken(modules, control, e.token) }))
    const mainFound = spaces[0].found
    if (!mainFound) return failed(report, 'the main space\'s token matches no brain')
    const mainDb = openBrain(path.join(input.dataDir, mainFound.brain.brain_file)); open.push(mainDb)

    const handle = deriveHandle(mainDb, input.config, input.handle)
    if ('reason' in handle) {
      report.status = 'waiting'
      report.reason = handle.reason
      report.spaces = spaces.map((s) => ({ id: s.found?.brain.id ?? '?', name: s.name || s.found?.brain.name || '?', main: s.main, action: 'skipped', reason: handle.reason, agent: s.bound }))
      return report
    }
    report.handle = handle.handle
    report.config.handle = handle.handle

    // The agent brains this home has (config) and the ones this run creates.
    const agentBrains = new Map<string, { brainId: string; file: string; token: string; created: boolean }>()
    for (const a of input.config.agents ?? []) {
      const found = brainOfToken(modules, control, a.token)
      if (found && found.brain.name === a.id) agentBrains.set(a.id, { brainId: found.brain.id, file: found.brain.brain_file, token: a.token, created: false })
    }
    const agentFor = (id: string, names: { agent: string; human: string }) => {
      const have = agentBrains.get(id)
      if (have) return have
      const res = modules.core.provisionUser({
        email: `${handle.handle}@local`, agentId: id, userId: handle.handle, agentName: names.agent, userName: names.human,
        control, dataDir: input.dataDir, tokenName: handle.handle, name: id, seedIdentity: false,
      })
      const made = { brainId: res.brainId, file: res.brainFile, token: res.tokenPlaintext, created: true }
      agentBrains.set(id, made)
      report.config.agents = [...(report.config.agents ?? []), { id, token: res.tokenPlaintext }]
      return made
    }

    for (const [i, space] of spaces.entries()) {
      const found = space.found
      const name = space.name || found?.brain.name || '?'
      if (!found) { report.spaces.push({ id: '?', name, main: space.main, action: 'skipped', reason: 'its token matches no brain', agent: space.bound }); continue }
      const sr: SpaceReport = { id: found.brain.id, name, main: space.main, action: 'skipped', agent: space.bound }
      report.spaces.push(sr)
      if (space.bound && agentBrains.has(space.bound)) { sr.reason = `bound to ${space.bound} already`; continue }
      // A refused write or an I/O error inside a space ends the run with the report naming it; a dry run has touched copies only.
      try {
      if (found.brain.status !== 'ok') { sr.reason = `brain status ${found.brain.status} — it needs intervention first`; continue }
      const agentId = found.brain.name
      if (!AGENT_ID.test(agentId)) { sr.reason = `the brain's name "${agentId}" is not an agent id — bind an agent by hand`; continue }
      sr.agent = agentId

      const spaceDb = i === 0 ? mainDb : openBrain(path.join(input.dataDir, found.brain.brain_file))
      if (i !== 0) open.push(spaceDb)
      const spaceEml = modules.core.EML.fromConnection(spaceDb, agentId)
      const env = spaceEml.env({ handle: null, agent: null, ingestion_method: 'direct' })
      const agentName = (spaceDb.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId
      const humanName = (spaceDb.prepare('SELECT name FROM users WHERE id = ?').get(handle.handle) as { name: string } | undefined)?.name ?? handle.handle
      const agentBrain = agentFor(agentId, { agent: agentName, human: humanName })
      const agentDb = openBrain(path.join(input.dataDir, agentBrain.file)); open.push(agentDb)
      const agentEml = modules.core.EML.fromConnection(agentDb, agentId)
      const agentEnv = agentEml.env({ handle: null, agent: null, ingestion_method: 'direct' })

      sr.other_agents = (spaceDb.prepare(`SELECT a.id, (SELECT COUNT(*) FROM engrams e WHERE e.scope = 'agent.' || a.id) AS engrams FROM agents a WHERE a.id != ? ORDER BY a.id`).all(agentId) as Array<{ id: string; engrams: number }>)
      sr.before = { space: counts(spaceDb), agent: counts(agentDb) }

      // The identity set and the plan; every crossing relation must be buildable as a reference before anything moves.
      const ids = (spaceDb.prepare(IDENTITY_SET_SQL).all(`agent.${agentId}`) as Array<{ id: string }>).map((r) => r.id)
      const existingIds = new Set((agentDb.prepare('SELECT id FROM engrams').all() as Array<{ id: string }>).map((r) => r.id))
      let crossingRows: Array<Record<string, unknown>> = []
      let plan: MovePlan | null = null
      sr.collisions = { superseded: [], seeds_retired: [], needs_review: [] }
      if (ids.length > 0) {
        // A core profile arriving for a scope the agent brain already has one for (an earlier space's)
        // cannot be imported next to it: the first wins, the second is retired in the space before the move.
        const arrivingCore = spaceDb.prepare(`SELECT id, scope, title FROM engrams WHERE id IN (SELECT value FROM json_each(?)) AND type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1`).all(JSON.stringify(ids)) as Array<{ id: string; scope: string; title: string | null }>
        for (const e of arrivingCore) {
          const other = (agentDb.prepare(`SELECT id FROM engrams WHERE scope = ? AND type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1`).get(e.scope) as { id: string } | undefined)?.id
          if (!other) continue
          spaceEml.apply({ name: 'engram.update', input: { id: e.id, patch: { status: 'invalidated' } } }, env)
          sr.collisions.superseded.push({ id: e.id, by: other, title: e.title })
        }
        plan = modules.log.planMove({ source: spaceDb, target: agentDb, ids })
        if (plan.collisions.length > 0) return failed(report, `${name}: the move is refused — ${plan.collisions.join('; ')}`)
        const row = spaceDb.prepare('SELECT id, source_id, target_id, relation, detection_method, strength, explanation, metadata FROM relations WHERE id = ?')
        for (const c of plan.crossing) {
          const r = row.get(c.id) as Record<string, unknown> | undefined
          if (!r || !c.other?.id) return failed(report, `${name}: crossing relation ${c.id} cannot become a reference (its other end is unknown)`)
          crossingRows.push({ ...r, direction: c.direction })
        }
        const moved = await modules.log.moveEngrams({
          source: spaceDb, target: { db: agentDb }, ids, plan_hash: plan.plan_hash,
          backup_path: path.join(input.backupDir, `${found.brain.id.slice(0, 8)}-before-move.db`),
        }, env)
        if (moved.ids.length !== ids.length) return failed(report, `${name}: the move reports ${moved.ids.length} of ${ids.length} engrams`)
      }
      const by: Record<string, number> = {}
      for (const r of (agentDb.prepare(`SELECT type, scope, COUNT(*) AS n FROM engrams WHERE id IN (SELECT value FROM json_each(?)) GROUP BY type, scope ORDER BY type, scope`).all(JSON.stringify(ids)) as Array<{ type: string; scope: string; n: number }>)) by[`${r.type} ${r.scope}`] = r.n
      sr.moved = { engrams: plan?.moved.engrams ?? 0, entries: plan?.moved.entries ?? 0, relations: plan?.moved.relations ?? 0, by }
      sr.refs = { external: plan?.external_refs.length ?? 0, incoming: plan?.incoming_refs.length ?? 0 }

      // The crossing relations, now references from the agent brain into the space.
      let recreated = 0
      for (const r of crossingRows) {
        const brainEnd = r.direction === 'out' ? { target_brain: found.brain.id } : { source_brain: found.brain.id }
        const res = agentEml.apply({ name: 'relation.create', input: {
          source_id: r.source_id, target_id: r.target_id, relation: r.relation,
          detection_method: r.detection_method ?? 'manual',
          ...(typeof r.strength === 'number' ? { strength: r.strength } : {}),
          ...(typeof r.explanation === 'string' ? { explanation: r.explanation } : {}),
          ...(typeof r.metadata === 'string' && r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
          ...brainEnd,
        } }, agentEnv) as { created: boolean }
        if (res.created) recreated++
      }
      sr.crossing = {
        planned: crossingRows.length, recreated,
        items: crossingRows.map((r) => ({ id: r.id as string, relation: r.relation as string, direction: r.direction as 'out' | 'in', other: (r.direction === 'out' ? r.target_id : r.source_id) as string })),
      }
      if (recreated !== crossingRows.length) return failed(report, `${name}: ${crossingRows.length} crossing relations, ${recreated} references re-created`)

      const movedRows = agentDb.prepare(`SELECT id, type, scope, title, content, status, origin, json_extract(properties, '$.core') AS core FROM engrams WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ord`).all(JSON.stringify(ids)) as Array<{ id: string; type: string; scope: string; title: string | null; content: string; status: string; origin: string | null; core: number | null }>
      // A later space's default seeds (every space was seeded alike): the agent brain has its identity from the first space; they add nothing and retire.
      if (existingIds.size > 0) {
        for (const e of movedRows) {
          if (e.origin !== 'eml-default-brain' || e.status !== 'active') continue
          agentEml.apply({ name: 'engram.update', input: { id: e.id, patch: { status: 'invalidated' } } }, agentEnv)
          sr.collisions.seeds_retired.push(e.id)
          e.status = 'invalidated'
        }
      }
      // Re-scope: a rule or learning left in global is the agent's; another handle's user scope is the human's.
      sr.rescoped = { global_to_agent: [], user_to_handle: [] }
      const activeCore = (scope: string, except: string) => (agentDb.prepare(`SELECT id FROM engrams WHERE scope = ? AND type = 'profile' AND status = 'active' AND id != ? AND json_extract(properties, '$.core') = 1`).get(scope, except) as { id: string } | undefined)?.id
      for (const e of movedRows) {
        const target = e.scope === 'global' ? `agent.${agentId}` : /^user\./.test(e.scope) && e.scope !== `user.${handle.handle}` ? `user.${handle.handle}` : e.scope
        if (e.type === 'profile' && e.core === 1 && e.status === 'active' && target !== e.scope) {
          // A core profile re-scoped into a scope the agent brain has one for already (an earlier
          // space's): the first wins, and the superseded one still follows its owner's scope.
          const other = activeCore(target, e.id)
          if (other && existingIds.has(other)) {
            agentEml.apply({ name: 'engram.update', input: { id: other, patch: { supersedes: [e.id] } } }, agentEnv)
            sr.collisions.superseded.push({ id: e.id, by: other, title: e.title })
            e.status = 'superseded'
          }
        }
        if (target === e.scope) continue
        agentEml.apply({ name: 'engram.update', input: { id: e.id, patch: { scope: target } } }, agentEnv)
        ;(e.scope === 'global' ? sr.rescoped.global_to_agent : sr.rescoped.user_to_handle).push(e.id)
        e.scope = target
      }
      // Collisions with what was there before this space: the same engram again is superseded, a variant is listed.
      if (existingIds.size > 0) {
        const same = agentDb.prepare(`SELECT id, content FROM engrams WHERE type = ? AND scope = ? AND title = ? AND status = 'active' AND id IN (SELECT value FROM json_each(?))`)
        const existing = JSON.stringify([...existingIds])
        for (const e of movedRows) {
          if (e.status !== 'active' || e.title === null) continue
          const twins = same.all(e.type, e.scope, e.title, existing) as Array<{ id: string; content: string }>
          if (twins.length === 0) continue
          const identical = twins.find((t) => t.content === e.content)
          if (identical) {
            agentEml.apply({ name: 'engram.update', input: { id: identical.id, patch: { supersedes: [e.id] } } }, agentEnv)
            sr.collisions.superseded.push({ id: e.id, by: identical.id, title: e.title })
          } else {
            sr.collisions.needs_review.push({ id: e.id, existing: twins[0].id, title: e.title, scope: e.scope })
          }
        }
      }

      // The legacy authorship: rows the agent's name stamped as the handle, in both brains.
      const restamp = (eml: Eml, e: Env) => eml.apply({ name: 'provenance.restamp', input: { from_handle: agentId, to_handle: handle.handle, agent: agentId } }, e) as { engrams: number; entries: number }
      sr.restamped = { space: restamp(spaceEml, env), agent: restamp(agentEml, agentEnv) }

      // The space's token under the handle; the config takes the new one and the binding.
      let token = space.token
      if (found.tokenName !== handle.handle) {
        const issued = modules.core.issueToken(control, { userId: found.userId, brainId: found.brain.id, name: handle.handle })
        modules.core.revokeToken(control, found.tokenId)
        token = issued.plaintext
        sr.token = 'reissued'
      } else {
        sr.token = 'kept'
      }
      if (space.main) {
        report.config.token = token
        report.config.agent = agentId
      } else {
        const list = [...(report.config.spaces ?? [])]
        list[i - 1] = { ...list[i - 1], token, agent: agentId }
        report.config.spaces = list
      }

      sr.counts = { space: counts(spaceDb), agent: counts(agentDb) }
      sr.dangling = { space: dangling(spaceDb), agent: dangling(agentDb) }
      const v = { space: modules.log.verify(spaceDb), agent: modules.log.verify(agentDb) }
      sr.verify = { space: v.space.ok, agent: v.agent.ok }
      sr.action = ids.length > 0 ? 'upgraded' : 'bound'
      if (sr.dangling.space + sr.dangling.agent > 0) return failed(report, `${name}: ${sr.dangling.space + sr.dangling.agent} dangling relation(s) after the move`)
      if (!v.space.ok) return failed(report, `${name}: the space's log does not verify — ${v.space.problem}`)
      if (!v.agent.ok) return failed(report, `${name}: the agent brain's log does not verify — ${v.agent.problem}`)
      } catch (err) {
        return failed(report, `${name}: ${(err as Error).message}`)
      }
    }
    report.agents = [...agentBrains.entries()].map(([id, a]) => ({ id, brainId: a.brainId, created: a.created }))
    return report
  } finally {
    for (const db of open) { try { db.close() } catch { /* closed */ } }
    control.close()
  }
}

function failed(report: UpgradeReport, reason: string): UpgradeReport {
  report.status = 'failed'
  report.reason = reason
  return report
}

/** Whether the config leaves any space without a bound agent: the upgrade has something to do. */
export function needsUpgrade(config: CockpitConfig): boolean {
  return !config.agent || (config.spaces ?? []).some((s) => !s.agent)
}

/**
 * The upgrade as the host runs it: a dry run on copies of control.db and
 * every brain file first; the real run only when the dry run passed every
 * check, after a backup of the same files; the config written last. Returns
 * the dry run's report when it did not pass, else the real run's.
 */
export async function upgradeHome(input: Omit<UpgradeInput, 'backupDir'> & { backupsDir: string; writeConfig: (config: CockpitConfig) => Promise<void>; log?: (line: string) => void }): Promise<{ report: UpgradeReport; dir: string }> {
  const now = input.now ?? (() => new Date())
  const base = path.join(input.backupsDir, 'agent-upgrade', stamp(now()))
  let dir = base
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`
  const log = input.log ?? (() => {})
  const dry = await dryRun({ ...input, dir })
  fs.writeFileSync(path.join(dir, 'dry-run.json'), JSON.stringify(dry, null, 2) + '\n', { mode: 0o600 })
  if (dry.status !== 'ok') { log(`agent upgrade: dry run ${dry.status} — ${dry.reason}`); return { report: dry, dir } }
  if (!changes(dry)) { log('agent upgrade: nothing to do'); return { report: dry, dir } }
  log(`agent upgrade: dry run ok (${summary(dry)}); running on the home`)
  copyData(input.dataDir, input.config, path.join(dir, 'before'), input.modules ?? bundledCoreModules())
  const report = await upgradeAgents({ ...input, backupDir: path.join(dir, 'run') }, 'run')
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  if (report.status === 'ok') await input.writeConfig(report.config)
  log(`agent upgrade: ${report.status}${report.reason ? ` — ${report.reason}` : ''} (${summary(report)})`)
  return { report, dir }
}

/** The upgrade on copies of the home's data: the report says what the real run would do; nothing of the home changes. */
export async function dryRun(input: Omit<UpgradeInput, 'backupDir'> & { dir: string }): Promise<UpgradeReport> {
  const modules = input.modules ?? bundledCoreModules()
  const copy = path.join(input.dir, 'dry')
  copyData(input.dataDir, input.config, copy, modules)
  return upgradeAgents({ ...input, modules, dataDir: path.join(copy, 'data'), backupDir: path.join(copy, 'move-backups') }, 'dry-run')
}

/** control.db and the brain files the config's tokens name, consistently (VACUUM INTO), into <dir>/data/. */
function copyData(dataDir: string, config: CockpitConfig, dir: string, modules: CoreModules): void {
  const data = path.join(dir, 'data')
  fs.mkdirSync(path.join(data, 'brains'), { recursive: true, mode: 0o700 })
  const control = modules.core.initControlDatabase(path.join(dataDir, 'control.db'))
  try {
    control.prepare('VACUUM INTO ?').run(path.join(data, 'control.db'))
    const tokens = [config.token, ...(config.spaces ?? []).map((s) => s.token), ...(config.agents ?? []).map((a) => a.token)]
    for (const token of tokens) {
      const found = brainOfToken(modules, control, token)
      if (!found) continue
      const src = openBrain(path.join(dataDir, found.brain.brain_file))
      try { src.prepare('VACUUM INTO ?').run(path.join(data, found.brain.brain_file)) } finally { src.close() }
    }
  } finally {
    control.close()
  }
  for (const f of fs.readdirSync(path.join(data, 'brains'))) fs.chmodSync(path.join(data, 'brains', f), 0o600)
  fs.chmodSync(path.join(data, 'control.db'), 0o600)
}

/** Whether a report binds or upgrades anything (else the config stays as it is). */
const changes = (r: UpgradeReport) => r.spaces.some((s) => s.action !== 'skipped') || r.agents.some((a) => a.created)

/** One line per report: what it did. */
export function summary(r: UpgradeReport): string {
  const upgraded = r.spaces.filter((s) => s.action === 'upgraded')
  const moved = upgraded.reduce((n, s) => n + (s.moved?.engrams ?? 0), 0)
  const refs = upgraded.reduce((n, s) => n + (s.crossing?.recreated ?? 0), 0)
  return `${upgraded.length} space(s) upgraded, ${r.spaces.filter((s) => s.action === 'bound').length} bound, ${r.spaces.filter((s) => s.action === 'skipped').length} skipped; ${moved} engrams moved, ${refs} references`
}

/** The report as text (the CLI, the host log). */
export function renderReport(r: UpgradeReport): string {
  const lines: string[] = [`agent upgrade (${r.mode}) at ${r.at}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`, `handle: ${r.handle ?? '(not known)'}`]
  for (const a of r.agents) lines.push(`agent ${a.id}: brain ${a.brainId}${a.created ? ' (created)' : ''}`)
  for (const s of r.spaces) {
    lines.push(`space ${s.name} (${s.id.slice(0, 8)}${s.main ? ', main' : ''}): ${s.action}${s.reason ? ` — ${s.reason}` : ''}${s.agent ? ` → ${s.agent}` : ''}`)
    if (s.action === 'skipped') continue
    const c = (x?: Counts) => (x ? `${x.engrams} engrams, ${x.entries} entries, ${x.relations} relations` : '?')
    lines.push(`  before: space ${c(s.before?.space)} | agent ${c(s.before?.agent)}`)
    lines.push(`  after:  space ${c(s.counts?.space)} | agent ${c(s.counts?.agent)}`)
    if (s.moved) lines.push(`  moved: ${s.moved.engrams} engrams, ${s.moved.entries} entries, ${s.moved.relations} inner relations${Object.keys(s.moved.by).length ? ` — ${Object.entries(s.moved.by).map(([k, n]) => `${k}: ${n}`).join(', ')}` : ''}`)
    if (s.crossing) {
      lines.push(`  crossing relations: ${s.crossing.planned} planned, ${s.crossing.recreated} re-created as references`)
      for (const i of s.crossing.items) lines.push(`    ${i.direction === 'out' ? '→' : '←'} ${i.relation} ${i.other} (${i.id.slice(0, 8)})`)
    }
    if (s.refs) lines.push(`  entry references left as text: ${s.refs.external} outward, ${s.refs.incoming} inward`)
    if (s.rescoped) lines.push(`  re-scoped: ${s.rescoped.global_to_agent.length} global → agent.${s.agent}, ${s.rescoped.user_to_handle.length} user.<other> → user.${r.handle}`)
    if (s.collisions) {
      for (const x of s.collisions.superseded) lines.push(`  superseded (same again): ${x.title ?? x.id} ${x.id.slice(0, 8)} by ${x.by.slice(0, 8)}`)
      if (s.collisions.seeds_retired.length) lines.push(`  default seeds retired (a later space's copy): ${s.collisions.seeds_retired.length}`)
      for (const x of s.collisions.needs_review) lines.push(`  needs review (same title, other content): ${x.title ?? x.id} ${x.id.slice(0, 8)} vs ${x.existing.slice(0, 8)} in ${x.scope}`)
    }
    if (s.restamped) lines.push(`  re-stamped: space ${s.restamped.space.engrams} engrams / ${s.restamped.space.entries} entries, agent ${s.restamped.agent.engrams} / ${s.restamped.agent.entries}`)
    if (s.other_agents?.length) lines.push(`  other agents staying: ${s.other_agents.map((a) => `${a.id} (${a.engrams} in agent.${a.id})`).join(', ')}`)
    if (s.token) lines.push(`  token: ${s.token}`)
    if (s.dangling) lines.push(`  dangling relations: ${s.dangling.space} space, ${s.dangling.agent} agent; logs verify: space ${s.verify?.space}, agent ${s.verify?.agent}`)
  }
  return lines.join('\n')
}
