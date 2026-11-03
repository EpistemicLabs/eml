import type Database from 'better-sqlite3'
import * as path from 'path'
import { CommandError, type Env } from '@engramprotocol/core'
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
// else's connection (the pool's serves the other requests meanwhile).

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
 * POST /move: runs the move the caller confirmed (plan_hash). The source is
 * opened for the move alone and closed after; the backup goes to
 * <backupDir>/move/<brain id>-<time>.db. Throws MoveRouteError for a refusal
 * (409 MOVE_REFUSED; 409 PLAN_CHANGED with the current plan_hash), and lets
 * the target write's own error through (503 read-only, 504 pending).
 */
export async function moveRoute(ctx: MoveContext, source: { brainId: string, brainFile: string }, body: { target?: unknown, project?: unknown, plan_hash?: unknown }, env: Env): Promise<ProjectMoveResult> {
  const target = targetOf(ctx, body.target, source.brainId)
  if (target.refusal) throw new MoveRouteError(409, 'MOVE_REFUSED', `move refused: ${target.refusal}. Nothing was moved.`)
  const project = projectOf(body.project)
  if (typeof body.plan_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.plan_hash)) throw new MoveRouteError(400, 'INVALID_PLAN', 'plan_hash is the hash of the plan being confirmed (POST /move/plan).')
  const sync = target.sync as Sync
  const moveTarget: MoveTarget = { db: target.db, write: (command) => sync.write(command, env, { deadlineMs: ctx.deadlineMs }) }
  const backup_path = path.join(ctx.backupDir, 'move', `${source.brainId}-${env.now().replace(/[:.]/g, '-')}.db`)
  const db = openBrain(path.resolve(ctx.dataDir, source.brainFile))
  try {
    return await moveProject({ source: db, target: moveTarget, project, plan_hash: body.plan_hash, backup_path }, env)
  } catch (err) {
    if (err instanceof CommandError && err.code === 'CONFLICT') {
      if (typeof err.data?.plan_hash === 'string') throw new MoveRouteError(409, 'PLAN_CHANGED', err.message, { plan_hash: err.data.plan_hash })
      throw new MoveRouteError(409, 'MOVE_REFUSED', err.message)
    }
    throw err
  } finally {
    db.close()
  }
}

function projectOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new MoveRouteError(400, 'INVALID_PROJECT', 'project is the id of the project to move.')
  return value
}
