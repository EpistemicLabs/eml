import type Database from 'better-sqlite3'
import * as path from 'path'
import { CommandError, EML, type Env } from '@engramprotocol/core'
import { remoteReferences } from '@engramprotocol/core/dist/log/move'
import { moveProject, planProjectMove, type MoveTarget, type ProjectMovePlan, type ProjectMoveResult } from '@engramprotocol/core/dist/log/move-engrams'
import { openBrain, type ConnectionPool } from './pool'
import { route } from './middleware/routing'
import { Sync } from './sync/sync'

// --- Moving a project into a team brain (v0.21, spec team-brain-move-project-spec) ---
//
// Host-facing, on the source brain's token: the plan (what moves, what is
// dropped, what the move refuses) and the run, both over core's project move
// (core/log/move-engrams.ts — loaded from dist/log, like rebuild: it is not in
// core's index). The target is another brain of this server, named by its
// id; it must be a live team brain — the one gate the server adds, since the
// server owns the relay connection. The import goes through that connection
// as a confirmed write with a longer deadline; the source is opened once more
// for the move alone, so the lock it holds across the wait is on no one
// else's connection; a write of another request to that brain meanwhile is
// refused at once (write.ts busy, through `moving`) instead of waiting on
// the lock. Once the move committed, every other private brain of this
// server that holds a reference into the source at one of the moved engrams
// (an agent brain's learning refining a task, spec §4) gets one
// relation.move_end op, so the reference names the target now.

/** The brains a move holds right now: their writes are refused at once (write.ts busy) instead of waiting on the move's lock. */
export const moving = new Set<string>()

/** What the move's routes need of the server. */
export interface MoveContext {
  controlDb: Database.Database
  pool: ConnectionPool
  syncs: Map<string, Sync | Error>
  dataDir: string
  /** Backups of a source before a move go to <backupDir>/move. */
  backupDir: string
  /** How long the import's confirmed write waits (ms). */
  deadlineMs: number
}

/** The plan as the host gets it: core's, with the target's own refusal first when it has one. */
export type MovePlanView = ProjectMovePlan

/** The move's answer: core's result, and per other brain the references the move pointed at the target. */
export interface MoveRouteResult extends ProjectMoveResult {
  references: Array<{ brain: string, relations: number, error?: string }>
}

export class MoveRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'MoveRouteError'
  }
}

interface Target {
  brainId: string
  db: Database.Database
  /** why the target takes no move right now, or null */
  refusal: string | null
  sync: Sync | null
}

/**
 * The target brain `id` for a move from `sourceId`: its pooled connection
 * (what the plan reads) and, as the gate, why it takes no move — not a team
 * brain of this server, or not live.
 */
function targetOf(ctx: MoveContext, id: unknown, sourceId: string): Target {
  if (typeof id !== 'string' || id === '') throw new MoveRouteError(400, 'INVALID_TARGET', 'target is the id of the brain to move into.')
  if (id === sourceId) throw new MoveRouteError(400, 'INVALID_TARGET', 'The target is this brain itself.')
  const routed = route(ctx.controlDb, ctx.pool, id)
  if (!routed.ok) throw new MoveRouteError(routed.status === 404 ? 404 : routed.status, routed.status === 404 ? 'TARGET_NOT_FOUND' : (routed.code ?? 'TARGET_UNAVAILABLE'), routed.status === 404 ? 'The target brain is not on this server.' : `The target brain: ${routed.error}`)
  const sync = ctx.syncs.get(id)
  if (sync === undefined) return { brainId: id, db: routed.ctx.brainDb, sync: null, refusal: 'the target is not a team brain of this cockpit; a project moves into a shared space' }
  if (sync instanceof Error) return { brainId: id, db: routed.ctx.brainDb, sync: null, refusal: `the target stopped: its team file cannot be used (${sync.message})` }
  const readOnly = sync.snapshot().read_only
  return { brainId: id, db: routed.ctx.brainDb, sync, refusal: readOnly ? `the target takes no write right now: ${readOnly}` : null }
}

/** POST /move/plan: what moving `project` from the source into `target` would do, with every reason it would be refused. Reads only. */
export function planMoveRoute(ctx: MoveContext, source: { brainId: string, db: Database.Database }, body: { target?: unknown, project?: unknown }): MovePlanView {
  const target = targetOf(ctx, body.target, source.brainId)
  const plan = planProjectMove({ source: source.db, target: target.db, project: projectOf(body.project) })
  if (target.refusal) plan.collisions.unshift(target.refusal)
  return plan
}

/**
 * POST /move: runs the move the caller confirmed (plan_hash); target_name, when
 * given, is recorded on the archived projects (targetNameOf). The source is
 * opened for the move alone and closed after; the backup goes to
 * <backupDir>/move/<brain id>-<time>.db. Throws MoveRouteError for a refusal
 * (409 MOVE_REFUSED; 409 PLAN_CHANGED with the current plan_hash), and lets
 * the target write's own error through (503 read-only, 504 pending).
 */
export async function moveRoute(ctx: MoveContext, source: { brainId: string, brainFile: string }, body: { target?: unknown, project?: unknown, plan_hash?: unknown, target_name?: unknown }, env: Env): Promise<MoveRouteResult> {
  if (moving.has(source.brainId)) throw new MoveRouteError(409, 'MOVE_REFUSED', 'move refused: a move out of this brain is under way. Nothing was moved.')
  const target = targetOf(ctx, body.target, source.brainId)
  if (target.refusal) throw new MoveRouteError(409, 'MOVE_REFUSED', `move refused: ${target.refusal}. Nothing was moved.`)
  const project = projectOf(body.project)
  if (typeof body.plan_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.plan_hash)) throw new MoveRouteError(400, 'INVALID_PLAN', 'plan_hash is the hash of the plan being confirmed (POST /move/plan).')
  const target_name = targetNameOf(body.target_name)
  const sync = target.sync as Sync
  const moveTarget: MoveTarget = { db: target.db, write: (command) => sync.write(command, env, { deadlineMs: ctx.deadlineMs }) }
  const backup_path = path.join(ctx.backupDir, 'move', `${source.brainId}-${env.now().replace(/[:.]/g, '-')}.db`)
  const db = openBrain(path.resolve(ctx.dataDir, source.brainFile))
  moving.add(source.brainId)
  let result: ProjectMoveResult
  try {
    result = await moveProject({ source: db, target: moveTarget, project, plan_hash: body.plan_hash, backup_path, target_name }, env)
  } catch (err) {
    if (err instanceof CommandError && err.code === 'CONFLICT') {
      if (typeof err.data?.plan_hash === 'string') throw new MoveRouteError(409, 'PLAN_CHANGED', err.message, { plan_hash: err.data.plan_hash })
      throw new MoveRouteError(409, 'MOVE_REFUSED', err.message)
    }
    throw err
  } finally {
    moving.delete(source.brainId)
    db.close()
  }
  return { ...result, references: pointReferences(ctx, source.brainId, target.brainId, result.ids, env) }
}

/**
 * The references other brains of this server hold into `from` at the moved
 * engrams now name `to`: one relation.move_end op per private brain that has
 * any (a shared brain holds none). The move is done by now, so a brain that
 * cannot be written is reported, not thrown — the audit lists what is left.
 */
function pointReferences(ctx: MoveContext, from: string, to: string, ids: string[], env: Env): MoveRouteResult['references'] {
  const out: MoveRouteResult['references'] = []
  const brains = ctx.controlDb.prepare(`SELECT id, name FROM brains WHERE status = 'ok' AND id NOT IN (?, ?) ORDER BY id`).all(from, to) as Array<{ id: string, name: string }>
  for (const brain of brains) {
    const routed = route(ctx.controlDb, ctx.pool, brain.id)
    if (!routed.ok) { out.push({ brain: brain.id, relations: 0, error: routed.error }); continue }
    const eml = EML.fromConnection(routed.ctx.brainDb, routed.ctx.brainName)
    if (eml.teamBrain() !== null) continue
    const relations = remoteReferences(routed.ctx.brainDb, from, ids)
    if (relations.length === 0) continue
    try {
      eml.apply({ name: 'relation.move_end', input: { from_brain: from, to_brain: to, relations } }, env)
      out.push({ brain: brain.id, relations: relations.length })
    } catch (err) {
      out.push({ brain: brain.id, relations: relations.length, error: (err as Error).message })
    }
  }
  return out
}

/** The longest target name recorded on an archived project (it ends up in agent-facing text). */
export const TARGET_NAME_MAX_CHARS = 80

/**
 * `target_name` of POST /move: the name the caller's cockpit gives the target
 * space, recorded on the archived projects for eml_show. Absent or blank → not
 * recorded (eml_show names the brain id). Control characters go, whitespace
 * collapses, the rest is cut at TARGET_NAME_MAX_CHARS.
 */
export function targetNameOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new MoveRouteError(400, 'INVALID_TARGET_NAME', 'target_name is the name of the target space, as text.')
  const clean = value.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, TARGET_NAME_MAX_CHARS).trim()
  return clean === '' ? undefined : clean
}

function projectOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new MoveRouteError(400, 'INVALID_PROJECT', 'project is the id of the project to move.')
  return value
}
