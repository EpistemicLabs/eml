import type Database from 'better-sqlite3'

// --- Runs (v0.23) ------------------------------------------------------------------
//
// A run is one session working on a task, as a member's cockpit knows it: who
// started it and why (origin), who drives it, its state, when something last
// happened in it (last_activity_at) and how it ended. It is written only when
// something happens — the start, each turn end, the end, a crash found at a
// restart — never as a heartbeat: every write is an op kept forever. It is an object,
// not an engram: no content, not in recall or the engram lists, no journal of
// its own — its start and end are journaled on its task. Its id is the
// session id. Only the member it names writes it (commands/object-*.ts), so
// every replica refuses another member's change to it.

export const RUN_ORIGINS = ['user', 'runner', 'job'] as const
export const RUN_DRIVERS = ['human', 'agent'] as const
export const RUN_STATES = ['running', 'idle', 'ended'] as const
export const RUN_END_REASONS = ['finished', 'put_away', 'failed', 'crashed'] as const
export type RunState = typeof RUN_STATES[number]

export interface Run {
  id: string
  task_id: string
  member: string
  agent: string | null
  origin: typeof RUN_ORIGINS[number]
  driver: typeof RUN_DRIVERS[number]
  state: RunState
  started_at: string
  last_activity_at: string
  ended_at: string | null
  end_reason: typeof RUN_END_REASONS[number] | null
  /** the result line of its last handoff */
  result: string | null
  created_at: string
  updated_at: string
}

/** The row of the runs table: the one INSERT (write/objects.ts insertRunRow). */
export type RunRow = Run

export class RunStore {
  constructor(private db: Database.Database) {}

  get(id: string): Run | null {
    return (this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined) ?? null
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id)
  }

  /**
   * The newest `perTask` runs of each task (by started_at, then id), whatever their state, newest first per task: the
   * first is what a task's delegation request is checked against (a request is open while no run started after it),
   * the rest are the task's earlier sessions.
   */
  latestPerTask(perTask = 1): Run[] {
    return (this.db.prepare(`
      SELECT * FROM (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC, id DESC) AS nth FROM runs r
      ) WHERE nth <= ? ORDER BY task_id, nth`).all(perTask) as Array<Run & { nth: number }>).map(({ nth: _nth, ...run }) => run)
  }

  /** The runs of a state (default: every one not ended), optionally of one task; newest start first, then by id. */
  list(opts: { state?: RunState, task_id?: string } = {}): Run[] {
    const where: string[] = [opts.state ? 'state = ?' : "state != 'ended'"]
    const params: unknown[] = opts.state ? [opts.state] : []
    if (opts.task_id !== undefined) { where.push('task_id = ?'); params.push(opts.task_id) }
    return this.db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id ASC`).all(...params) as Run[]
  }
}
