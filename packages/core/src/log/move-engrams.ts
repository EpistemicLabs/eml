import type Database from 'better-sqlite3'
import { EML } from '../index'
import { importProblems, missingObjects, type EngramImportResult } from '../commands/engram-import'
import { CommandError } from '../commands/types'
import type { Env } from '../env'
import { backupBrain } from '../forward-migrations'
import { commandStores, writeOp } from './apply-op'
import { brainRef, checkIds, exportSet, namesCrossing, type ExternalRef } from './move'

// --- Moving engrams between two brains (v0.21) -----------------------------------
//
// The two ops of a move (overview in log/move.ts), run in the order that loses
// nothing: two files cannot commit together, so the import commits first.
// Not in core's index: it needs the EML class at runtime (the same cycle as
// rebuild) — callers load it from dist/log.

export interface MoveArgs {
  source: Database.Database
  target: Database.Database
  /** The engrams that move; the selection is the caller's. */
  ids: string[]
  /** Exactly the relations crossing the set (planMove lists them): dropped in the source. */
  drop_relations: string[]
  /** Where the source backup goes; an existing file is refused. */
  backup_path: string
}

export interface MoveResult {
  backup_path: string
  import: { seq: number, op_id: string }
  move_out: { seq: number, op_id: string }
  moved: { engrams: number, entries: number, relations: number }
  /** What this call's import created in the target; none on a resume (the import ran before). */
  created: EngramImportResult['created']
  dropped_relations: string[]
  external_refs: ExternalRef[]
  /** The import was in the target already: only the move_out ran. */
  resumed: boolean
}

/**
 * Moves engrams `ids` with their history from `source` into `target`, as one
 * engram.import there and one engram.move_out here. The backup is written
 * before the source is locked; the lock (an IMMEDIATE transaction) holds
 * until the move_out commits and is released on any failure. Throws what a
 * command throws (CONFLICT …); the target then has the import only if it
 * committed, and calling again resumes.
 */
export function moveEngrams(args: MoveArgs, env: Env): MoveResult {
  const { source, target, ids, drop_relations, backup_path } = args
  checkIds(ids)
  const from = brainRef(source).brain
  const to = brainRef(target).brain
  if (from === to) throw new CommandError('INVALID', 'Invalid move: the source and the target are the same brain.')
  backupBrain(source, backup_path)

  return source.transaction((): MoveResult => {
    const set = exportSet(source, ids)
    if (!namesCrossing(set, drop_relations)) {
      throw new CommandError('CONFLICT', `move refused: drop_relations must name exactly the relations crossing the set (${set.crossing.map(r => r.id).join(', ') || 'none'}); nothing was moved.`)
    }
    const counts = { engrams: set.rows.engrams.length, entries: set.rows.entries.length, relations: set.rows.relations.length }

    let imported = importOf(target, from, set.set_hash, ids)
    const resumed = imported !== undefined
    let created: MoveResult['created'] = { projects: [], entities: [], users: [], agents: [], tags: [], subjects: [] }
    if (!imported) {
      created = writeOp(commandStores(EML.fromConnection(target, 'move'), target), {
        name: 'engram.import', input: { source: brainRef(source), set_hash: set.set_hash, rows: set.rows },
      }, env).created
      imported = importOf(target, from, set.set_hash, ids)!
    }

    const out = writeOp(commandStores(EML.fromConnection(source, 'move'), source), {
      name: 'engram.move_out', input: { ids, set_hash: set.set_hash, drop_relations, target: { brain: to, op_id: imported.op_id } },
    }, env)
    const head = source.prepare('SELECT seq, op_id FROM op_log ORDER BY seq DESC LIMIT 1').get() as { seq: number, op_id: string }
    return {
      backup_path, import: imported, move_out: head, moved: counts, created,
      dropped_relations: out.dropped_relations, external_refs: set.external_refs, resumed,
    }
  }).immediate()
}

/** The import of this exact set from `brain` in `db`'s log, while the set is still there (a set can move back and forth). */
function importOf(db: Database.Database, brain: string, setHash: string, ids: string[]): { seq: number, op_id: string } | undefined {
  const present = db.prepare('SELECT COUNT(*) AS n FROM engrams WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(ids)) as { n: number }
  if (present.n !== ids.length) return undefined
  return db.prepare(`
    SELECT seq, op_id FROM op_log
    WHERE json_extract(payload, '$.call') = 'engram.import'
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
  set_hash: string
  moved: { engrams: number, entries: number, relations: number }
  /** What the move drops in the source; their ids are the drop_relations to pass. */
  crossing: PlannedCrossing[]
  external_refs: ExternalRef[]
  /** Entries outside the set naming an engram in it: the move leaves them as they are. */
  incoming_refs: ExternalRef[]
  /** The scope objects, tags and subjects the import would create in the target. */
  created: EngramImportResult['created']
  /** Why the target would refuse the import; empty when it goes in. */
  collisions: string[]
}

/** What moving `ids` from `source` into `target` would do. Reads only. */
export function planMove(args: { source: Database.Database, target: Database.Database, ids: string[] }): MovePlan {
  const { source, target, ids } = args
  const set = exportSet(source, ids)
  const engram = source.prepare('SELECT id, type, title FROM engrams WHERE id = ?')
  const stores = commandStores(EML.fromConnection(target, 'plan'), target)
  const inSet = new Set(ids)
  return {
    set_hash: set.set_hash,
    moved: { engrams: set.rows.engrams.length, entries: set.rows.entries.length, relations: set.rows.relations.length },
    crossing: set.crossing.map(r => {
      const direction = inSet.has(r.source_id) ? 'out' : 'in'
      const other = engram.get(direction === 'out' ? r.target_id : r.source_id) as PlannedCrossing['other']
      return { id: r.id, relation: r.relation, direction, other }
    }),
    external_refs: set.external_refs,
    incoming_refs: set.incoming_refs,
    created: missingObjects(stores, set.rows),
    collisions: importProblems(stores, set.rows),
  }
}
