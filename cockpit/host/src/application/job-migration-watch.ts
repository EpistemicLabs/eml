import type { NotificationInput } from '../notifications.js'
import type { JobMigrationResult } from './job-migration.js'

/**
 * Keeps the migration of the version 1 jobs (application/job-migration.ts) going after the host's start, and tells
 * the user while it is not through.
 *
 * Until a space's jobs have moved onto their tasks nothing fires them: the engine waits for the migration
 * (application/job-runner.ts waitsForMigration). A brain that is not up yet, one still at the schema of before, or a
 * brain server that has not said whether a space is shared comes back later, so a pass that leaves jobs waiting is
 * tried again: after 1, 5 and 15 minutes, then every 15 minutes for as long as jobs wait. A space the pass could not
 * look through yet for schedules left without a job is tried again the same way, without a word to the user.
 *
 * A space whose jobs have waited for more than ten minutes is told to the user once, through the notifier the
 * engine tells a paused schedule with (notifications.ts; "Schedule paused · <space>" on the user's devices), and the
 * log says so. When its jobs have moved, a second notice under the same tag replaces the first one: a push cannot
 * be taken back, only replaced.
 */

/** A space that still has version 1 jobs waiting. `key`: what its jobs carry as spaceId, null for the main space. */
export interface PendingSpace { key: string | null; name: string; jobs: number }

/** A space this cockpit no longer has, as the user is told of jobs that still name it. */
export const SPACE_GONE = 'A space this cockpit no longer has'

/** The spaces that still have version 1 jobs waiting, each with how many, by what the jobs carry as spaceId. */
export function pendingSpaces(jobs: ReadonlyArray<{ spaceId?: string | null }>, spaces: ReadonlyArray<{ key: string | null; name: string }>): PendingSpace[] {
  const waiting = new Map<string | null, number>()
  for (const job of jobs) waiting.set(job.spaceId ?? null, (waiting.get(job.spaceId ?? null) ?? 0) + 1)
  return [...waiting].map(([key, count]) => ({ key, name: spaces.find((space) => space.key === key)?.name ?? SPACE_GONE, jobs: count }))
}

export interface MigrationWatchDeps {
  /** One pass of the migration; `unlooked`: the spaces it could not look through yet for left-over schedules. */
  run(): Promise<Pick<JobMigrationResult, 'unlooked'>>
  /** The spaces that still have version 1 jobs waiting, as the store has them now. */
  pending(): PendingSpace[]
  notify(input: NotificationInput): void
  now(): number
  log(line: string): void
  /** Call `fn` after `ms`; the host passes a timer that does not keep the process alive. */
  later(fn: () => void, ms: number): void
}

export const MIGRATION_RETRY = {
  /** The first retries after a pass that left jobs waiting. */
  quickMs: [60_000, 5 * 60_000, 15 * 60_000],
  /** After them: for as long as jobs wait. */
  everyMs: 15 * 60_000,
  /** A space whose jobs have waited this long is told to the user. */
  tellAfterMs: 10 * 60_000,
} as const

/** The id a space's notices carry where a job's id goes: one tag per space, so its second notice replaces its first. */
const noticeId = (key: string | null) => `jobs-migration:${key ?? 'main'}`

export function createMigrationWatch(deps: MigrationWatchDeps) {
  /** Since when each space's jobs wait, and whether the user was told. */
  const waiting = new Map<string | null, { since: number; told: boolean; name: string }>()
  let running: Promise<void> = Promise.resolve()

  const look = (): boolean => {
    const now = deps.now()
    const pending = deps.pending().filter((space) => space.jobs > 0)
    const keys = new Set(pending.map((space) => space.key))
    for (const [key, state] of waiting) {
      if (keys.has(key)) continue
      waiting.delete(key)
      if (!state.told) continue
      deps.log(`[jobs] migration, space ${key ?? 'main'}: its schedules have moved onto their tasks and fire again`)
      deps.notify({ kind: 'done', title: state.name, body: 'Its schedules have moved onto their tasks and fire again.', jobId: noticeId(key), sessionId: null, spaceId: key })
    }
    for (const space of pending) {
      const state = waiting.get(space.key) ?? { since: now, told: false, name: space.name }
      waiting.set(space.key, state)
      if (state.told || now - state.since <= MIGRATION_RETRY.tellAfterMs) continue
      state.told = true
      const what = space.jobs === 1 ? '1 job from before the update has not moved onto its task' : `${space.jobs} jobs from before the update have not moved onto their tasks`
      deps.log(`[jobs] migration, space ${space.key ?? 'main'}: its schedules are not firing yet: ${what}; the user is told`)
      deps.notify({
        kind: 'paused', title: space.name, jobId: noticeId(space.key), sessionId: null, spaceId: space.key,
        body: `The schedules of this space are not firing yet: ${what}. The cockpit tries again every 15 minutes; its log says why.`,
      })
    }
    return pending.length > 0
  }

  const pass = async (attempt: number): Promise<void> => {
    let unlooked = 0
    try {
      unlooked = (await deps.run()).unlooked
    } catch (err) {
      deps.log(`[jobs] migration failed: ${(err as Error).message}`)
    }
    // Jobs that wait are tried again, and so is a space still to be looked through: the engine takes up no schedule there meanwhile.
    const waits = look()
    if (!waits && !(unlooked > 0)) return
    const wait = MIGRATION_RETRY.quickMs[attempt] ?? MIGRATION_RETRY.everyMs
    deps.later(() => { running = pass(attempt + 1) }, wait)
  }

  return {
    /** The first pass, now; what it leaves waiting is tried again. */
    start(): void { running = pass(0) },
    /** The pass under way is over (for tests). */
    idle: (): Promise<void> => running,
  }
}
