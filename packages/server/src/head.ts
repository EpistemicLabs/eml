import type Database from 'better-sqlite3'

// --- The log head (GET /head) -------------------------------------------------------
//
// Every write to a brain — a command run here, or an entry its relay delivered
// to a shared brain — is one entry in op_log with the next seq. The highest seq
// is the brain's change cursor: when it moves, something changed. The cockpit
// host watches it to refresh its task views within a second (decision
// task-board-live-updates-via-brain-log-head), the way a Kubernetes client
// watches from a resourceVersion.
//
// GET /head answers { seq } at once; with ?after=<seq>&wait=<ms> it holds the
// request until the head differs from `after` or `wait` runs out (a long poll).
// It reads the head again every HEAD_TICK_MS rather than hooking the writers:
// a writer appends inside its transaction, and a re-read sees only what was
// committed, whoever wrote it.

/** The longest a caller may wait for a change. */
export const HEAD_WAIT_MAX_MS = 30_000
/** How often a waiting request reads the head again. */
export const HEAD_TICK_MS = 200

/** The brain's newest seq; 0 for a log without entries. Throws when the brain has no op_log. */
export function logHead(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM op_log').get() as { seq: number | null } | undefined
  return row?.seq ?? 0
}

export interface WaitOptions {
  tickMs?: number
  /** True once the caller is gone: stop waiting. */
  closed?: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * The head once it differs from `after` (it moved on, or the brain was replaced
 * by one with a shorter log), or as it stands when `waitMs` ran out or the
 * caller left. `read` gives the head; an error from it ends the wait.
 */
export async function waitForHead(read: () => number, after: number, waitMs: number, opts: WaitOptions = {}): Promise<number> {
  const tick = opts.tickMs ?? HEAD_TICK_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const until = now() + Math.max(0, Math.min(waitMs, HEAD_WAIT_MAX_MS))
  for (;;) {
    const seq = read()
    if (seq !== after || now() >= until || opts.closed?.()) return seq
    await sleep(Math.min(tick, Math.max(0, until - now())))
  }
}

/** `after` and `wait` from the query: integers ≥ 0, or an error message. */
export function headQuery(q: Record<string, string | undefined>): { after: number | null, wait: number } | { error: string } {
  const int = (v: string | undefined) => v !== undefined && /^\d+$/.test(v) ? Number(v) : null
  if (q.after !== undefined && int(q.after) === null) return { error: 'after is the seq last seen, an integer ≥ 0' }
  if (q.wait !== undefined && int(q.wait) === null) return { error: `wait is in milliseconds, an integer from 0 to ${HEAD_WAIT_MAX_MS}` }
  return { after: int(q.after), wait: Math.min(int(q.wait) ?? 0, HEAD_WAIT_MAX_MS) }
}
