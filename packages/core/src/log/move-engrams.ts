import type Database from 'better-sqlite3'
import { MAX_PAYLOAD, canonicalJson, sha256Hex } from '@engramprotocol/protocol/log'
import { EML } from '../index'
import { checkImportRows, importProblems, missingObjects, type EngramImportInput, type EngramImportResult } from '../commands/engram-import'
import type { CommandMap, CommandName } from '../commands'
import { CommandError } from '../commands/types'
import type { Env } from '../env'
import { backupBrain } from '../forward-migrations'
import { commandStores, writeOp } from './apply-op'
import { teamBrainOf } from './log'
import {
  brainRef, checkIds, exportSet, legacyAuthorship, projectSet,
  type ExportedSet, type ExternalRef, type LegacyAuthorship, type MovedRows, type ProjectTreeEntry,
} from './move'

// --- Moving engrams between two brains (v0.21) -----------------------------------
//
// The two ops of a move (overview in log/move.ts), run in the order that loses
// nothing: two files cannot commit together, so the import commits first. The
// target is written where its writes go — a private brain directly, a shared
// one through its relay (MoveTarget.write, the server's confirmed write) — so
// the move awaits, and the source stays locked across that wait.
//
// Plan → confirm → run (decision move-project-deterministic-ui): planMove is
// a pure function of the two brains' state and names the plan with a hash;
// the run makes the plan again under the lock and refuses when the hash
// differs. moveProject is the product's move: a project with its sub-projects,
// refused while its rows still name an agent as author, the emptied projects
// archived in the source with a pointer to where they went.
//
// Not in core's index: it needs the EML class at runtime (the same cycle as
// rebuild) — callers load it from dist/log.

/**
 * Where a move writes: the target's connection (what the plan reads, and
 * where a private target is written) and, for a shared target, its confirmed
 * write — the command as an op through the relay, resolved once this replica
 * took it, or rejected with what the brain or the relay said.
 */
export interface MoveTarget {
  db: Database.Database
  write?: <N extends CommandName>(command: { name: N, input: CommandMap[N][0] }) => Promise<CommandMap[N][1]>
}

export interface MoveArgs {
  /** The source's connection, used by nothing else during the move: it is locked (BEGIN IMMEDIATE) until the move commits or fails. */
  source: Database.Database
  target: MoveTarget
  /** The engrams that move; the selection is the caller's (moveProject selects a project). */
  ids: string[]
  /** The plan the caller confirmed (planMove().plan_hash); the move refuses when the plan it makes now differs. */
  plan_hash: string
  /** Where the source backup goes; an existing file is refused. */
  backup_path: string
}

export interface MoveResult {
  backup_path: string
  /** The engrams that moved: what a cross-brain reference elsewhere may name (remoteReferences, relation.move_end). */
  ids: string[]
  import: { seq: number, op_id: string }
  move_out: { seq: number, op_id: string }
  moved: { engrams: number, entries: number, relations: number }
  /** What this call's import created in the target; none on a resume (the import ran before). */
  created: EngramImportResult['created']
  dropped_relations: string[]
  external_refs: ExternalRef[]
  /** Entries left outside the set that name a moved engram by id. */
  incoming_refs: ExternalRef[]
  /** The import was in the target already: only the move_out ran. */
  resumed: boolean
}

/**
 * Moves engrams `ids` with their history from `source` into `target`, as one
 * engram.import there and one engram.move_out here. A move the plan refuses
 * now is refused before anything is written; otherwise the backup is written,
 * then the source is locked; the lock holds until the move_out commits and
 * is released on any failure. Rejects with what a command throws (CONFLICT:
 * the plan changed, the target refused …) or what the target's write throws
 * (a write that may still land); the target then has the import only if it
 * committed, and calling again resumes.
 */
export async function moveEngrams(args: MoveArgs, env: Env): Promise<MoveResult> {
  const { source, target, ids, plan_hash, backup_path } = args
  checkIds(ids)
  const { from, to } = ends(source, target.db)
  // refused before the backup when the plan says so now; checked again under the lock
  refusalOf({ target, ids, ...planned(source, target.db, ids), plan_hash, from })
  backupBrain(source, backup_path)
  return locked(source, async () => {
    const { plan, set } = planned(source, target.db, ids)
    return runMove({ source, target, ids, plan, set, plan_hash, backup_path, from, to }, env)
  })
}

const empty = (): EngramImportResult['created'] => ({ projects: [], entities: [], users: [], agents: [], tags: [], subjects: [] })

/** The two ops, inside the source lock, against a plan made there. */
async function runMove(
  m: { source: Database.Database, target: MoveTarget, ids: string[], plan: MovePlan, set: ExportedSet, plan_hash: string, backup_path: string, from: string, to: string },
  env: Env,
): Promise<MoveResult> {
  const { source, target, ids, plan, set, from, to } = m
  let imported = refusalOf(m)
  const resumed = imported !== undefined
  let created = empty()
  if (!imported) {
    const input: EngramImportInput = { source: brainRef(source), set_hash: set.set_hash, rows: set.rows }
    created = (await writeTarget(target, { name: 'engram.import', input }, env)).created
    imported = importOf(target.db, from, set.set_hash, ids)
    if (!imported) throw new Error('the import is not in the target\'s log after its write')
  }
  const out = writeOp(commandStores(EML.fromConnection(source, 'move'), source), {
    name: 'engram.move_out', input: { ids, set_hash: set.set_hash, drop_relations: set.crossing.map(r => r.id), target: { brain: to, op_id: imported.op_id } },
  }, env)
  const head = source.prepare('SELECT seq, op_id FROM op_log ORDER BY seq DESC LIMIT 1').get() as { seq: number, op_id: string }
  return {
    backup_path: m.backup_path, ids, import: imported, move_out: head, moved: plan.moved, created,
    dropped_relations: out.dropped_relations, external_refs: set.external_refs, incoming_refs: set.incoming_refs, resumed,
  }
}

/**
 * Why the move does not run: the plan is not the one confirmed, or — unless
 * the import is in the target already (a resume, returned) — the plan refuses.
 */
function refusalOf(m: { target: MoveTarget, ids: string[], plan: MovePlan, set: ExportedSet, plan_hash: string, from: string }): { seq: number, op_id: string } | undefined {
  if (m.plan.plan_hash !== m.plan_hash) {
    throw new CommandError('CONFLICT', 'move refused: the plan changed since it was made (what moves or what is dropped differs); make the plan again. Nothing was moved.', { plan_hash: m.plan.plan_hash })
  }
  const imported = importOf(m.target.db, m.from, m.set.set_hash, m.ids)
  if (!imported && m.plan.collisions.length > 0) throw new CommandError('CONFLICT', `move refused: ${m.plan.collisions.join('; ')}. Nothing was moved.`)
  return imported
}

/** A write to the target where its writes go: through the relay for a shared brain, writeOp for a private one. */
function writeTarget<N extends CommandName>(target: MoveTarget, command: { name: N, input: CommandMap[N][0] }, env: Env): Promise<CommandMap[N][1]> {
  if (target.write) return target.write(command)
  return Promise.resolve(writeOp(commandStores(EML.fromConnection(target.db, 'move'), target.db), command, env))
}

/** The source and the target as a move names them; the same brain is INVALID. */
function ends(source: Database.Database, target: Database.Database): { from: string, to: string } {
  const from = brainRef(source).brain
  const to = brainRef(target).brain
  if (from === to) throw new CommandError('INVALID', 'Invalid move: the source and the target are the same brain.')
  return { from, to }
}

/**
 * `fn` with the source locked: BEGIN IMMEDIATE held across every await, so
 * no other writer gets in between the plan and the move_out (one waits the
 * busy timeout, then fails); committed when `fn` returns, rolled back when it
 * throws. The connection must be the move's alone: a write of another caller
 * on it would land inside this transaction.
 */
async function locked<T>(source: Database.Database, fn: () => Promise<T>): Promise<T> {
  source.exec('BEGIN IMMEDIATE')
  try {
    const result = await fn()
    source.exec('COMMIT')
    return result
  } catch (err) {
    if (source.inTransaction) source.exec('ROLLBACK')
    throw err
  }
}

/** The applied import of this exact set from `brain` in `db`'s log, while the set is still there (a set can move back and forth). */
function importOf(db: Database.Database, brain: string, setHash: string, ids: string[]): { seq: number, op_id: string } | undefined {
  const present = db.prepare('SELECT COUNT(*) AS n FROM engrams WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(ids)) as { n: number }
  if (present.n !== ids.length) return undefined
  return db.prepare(`
    SELECT seq, op_id FROM op_log
    WHERE rejected IS NULL AND json_extract(payload, '$.call') = 'engram.import'
      AND json_extract(payload, '$.args.source.brain') = ? AND json_extract(payload, '$.args.set_hash') = ?
    ORDER BY seq DESC LIMIT 1
  `).get(brain, setHash) as { seq: number, op_id: string } | undefined
}

/** A relation that does not move, seen from the set: which way it points and what is at its other end. */
export interface PlannedCrossing {
  id: string
  relation: string
  /** out: from an engram of the set; in: towards one. */
  direction: 'out' | 'in'
  other: { id: string, type: string, title: string | null }
}

export interface MovePlan {
  /** The two brains' ids. */
  source: string
  target: string
  set_hash: string
  /** Names this plan: the same state of both brains gives the same hash; the run takes it as the confirmation. */
  plan_hash: string
  moved: { engrams: number, entries: number, relations: number }
  /** What the move drops in the source. */
  crossing: PlannedCrossing[]
  external_refs: ExternalRef[]
  /** Entries outside the set naming an engram in it: the move leaves them as they are. */
  incoming_refs: ExternalRef[]
  /** The scope objects, tags and subjects the import would create in the target. */
  created: EngramImportResult['created']
  /** The import's args as JSON, in bytes: one op into a team brain carries at most MAX_PAYLOAD. */
  payload_bytes: number
  /** Why the move is refused (none: it goes): the rows' own checks, the target's collisions, a team brain as the source, a set too large for one op. */
  collisions: string[]
}

/** What moving `ids` from `source` into `target` would do. Reads only. */
export function planMove(args: { source: Database.Database, target: Database.Database, ids: string[] }): MovePlan {
  return planned(args.source, args.target, args.ids).plan
}

function planned(source: Database.Database, target: Database.Database, ids: string[]): { plan: MovePlan, set: ExportedSet } {
  const set = exportSet(source, ids)
  const engram = source.prepare('SELECT id, type, title FROM engrams WHERE id = ?')
  const stores = commandStores(EML.fromConnection(target, 'plan'), target)
  const inSet = new Set(ids)
  const from = brainRef(source).brain
  const to = brainRef(target).brain
  const crossing: PlannedCrossing[] = set.crossing.map(r => {
    const direction = inSet.has(r.source_id) ? 'out' : 'in'
    const other = engram.get(direction === 'out' ? r.target_id : r.source_id) as PlannedCrossing['other']
    return { id: r.id, relation: r.relation, direction, other }
  })
  const payload_bytes = Buffer.byteLength(canonicalJson({ source: { brain: from, head_seq: 0 }, set_hash: set.set_hash, rows: set.rows }))
  const collisions = rowProblems(set.rows) ?? importProblems(stores, set.rows)
  if (from === to) collisions.unshift('the source and the target are the same brain')
  if (teamBrainOf(source) !== null) collisions.unshift('the source is a team brain; a move takes engrams out of a private brain only')
  if (teamBrainOf(target) !== null && payload_bytes > MAX_PAYLOAD) {
    collisions.unshift(`the set is ${(payload_bytes / 1024 / 1024).toFixed(1)} MiB of JSON; one op into a team brain carries at most ${MAX_PAYLOAD / 1024 / 1024} MiB`)
  }
  const plan: MovePlan = {
    source: from, target: to, set_hash: set.set_hash,
    plan_hash: sha256Hex(canonicalJson({ source: from, target: to, ids, set_hash: set.set_hash, crossing: crossing.map(r => r.id) })),
    moved: { engrams: set.rows.engrams.length, entries: set.rows.entries.length, relations: set.rows.relations.length },
    crossing, external_refs: set.external_refs, incoming_refs: set.incoming_refs,
    created: missingObjects(stores, set.rows), payload_bytes, collisions,
  }
  return { plan, set }
}

/** The import's own refusal of the rows (its validate), as a problem list; undefined when they pass. */
function rowProblems(rows: MovedRows): string[] | undefined {
  try {
    checkImportRows(rows)
    return undefined
  } catch (err) {
    if (err instanceof CommandError) return [err.message]
    throw err
  }
}

// --- A project move -------------------------------------------------------------

export interface ProjectMovePlan extends MovePlan {
  project: string
  /** The project and its sub-projects, parents first, each with the engrams it holds. */
  tree: ProjectTreeEntry[]
  /** Rows still written under an agent's name — the move refuses them (collisions says so). */
  legacy: LegacyAuthorship
}

/**
 * What moving project `project` with its sub-projects from `source` into
 * `target` would do (reads only): the plan of its set, the tree, and the
 * refusals of a project move on top — rows an agent is named as author of
 * (the agent-brain upgrade has not run). A project without engrams is INVALID.
 */
export function planProjectMove(args: { source: Database.Database, target: Database.Database, project: string }): ProjectMovePlan {
  return projectPlanned(args.source, args.target, args.project).plan
}

function projectPlanned(source: Database.Database, target: Database.Database, project: string): { plan: ProjectMovePlan, set: ExportedSet, ids: string[] } {
  const { tree, ids } = projectSet(source, project)
  if (ids.length === 0) throw new CommandError('INVALID', `Invalid move: project ${project} has no engrams to move.`)
  const { plan, set } = planned(source, target, ids)
  const legacy = legacyAuthorship(source, ids)
  if (legacy.engrams + legacy.entries > 0) {
    plan.collisions.unshift(`${legacy.engrams} engrams and ${legacy.entries} journal entries are written under an agent's name (${legacy.agents.join(', ')}); run the agent upgrade first`)
  }
  return { plan: { ...plan, project, tree, legacy }, set, ids }
}

/** Legacy authorship refuses a project move whatever else the plan says, a resume included. */
function refuseLegacy(plan: ProjectMovePlan): void {
  if (plan.legacy.engrams + plan.legacy.entries > 0) throw new CommandError('CONFLICT', `move refused: ${plan.collisions[0]}. Nothing was moved.`)
}

export interface ProjectMoveArgs {
  source: Database.Database
  target: MoveTarget
  project: string
  plan_hash: string
  backup_path: string
}

export interface ProjectMoveResult extends MoveResult {
  project: string
  tree: ProjectTreeEntry[]
  /** The source projects archived by this move, with moved_to / moved_at in their metadata. */
  archived: string[]
}

/**
 * Moves project `project` with its sub-projects (planProjectMove) and, in the
 * same source transaction, archives every project the set emptied with
 * metadata moved_to (the target's brain id) and moved_at — one object.update op each, so the
 * source says where the project went. Refuses like moveEngrams, and while the
 * set has legacy authorship.
 */
export async function moveProject(args: ProjectMoveArgs, env: Env): Promise<ProjectMoveResult> {
  const { source, target, project, plan_hash, backup_path } = args
  const { from, to } = ends(source, target.db)
  // refused before the backup when the plan says so now; made and checked again under the lock
  const first = projectPlanned(source, target.db, project)
  refuseLegacy(first.plan)
  refusalOf({ target, ids: first.ids, plan: first.plan, set: first.set, plan_hash, from })
  backupBrain(source, backup_path)
  return locked(source, async () => {
    const { plan, set, ids } = projectPlanned(source, target.db, project)
    refuseLegacy(plan)
    const result = await runMove({ source, target, ids, plan, set, plan_hash, backup_path, from, to }, env)
    const stores = commandStores(EML.fromConnection(source, 'move'), source)
    const archived: string[] = []
    for (const entry of plan.tree) {
      if (entry.engrams === 0) continue
      const row = source.prepare('SELECT metadata FROM projects WHERE id = ?').get(entry.id) as { metadata: string | null }
      // metadata is a flat map of text: where it went and when; the move_out op in the log names the import
      const metadata = { ...(row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}), moved_to: to, moved_at: env.now() }
      writeOp(stores, { name: 'object.update', input: { object: 'project', id: entry.id, patch: { status: 'archived', metadata } } }, env)
      archived.push(entry.id)
    }
    return { ...result, project, tree: plan.tree, archived }
  })
}
