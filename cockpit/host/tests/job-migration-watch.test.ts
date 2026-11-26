import { describe, it, expect } from 'vitest'
import { createMigrationWatch, MIGRATION_RETRY, type PendingSpace } from '../src/application/job-migration-watch.js'
import type { NotificationInput } from '../src/notifications.js'

// The jobs of before brain schema 24 move onto their tasks at the host's start. What does not move at once (a brain
// that is not up, or not migrated yet) is tried again for as long as jobs wait, and the user is told once per space.

const MIN = 60_000

function world(pendingAfter: Array<PendingSpace[]>) {
  let now = Date.parse('2026-11-26T10:00:00.000Z')
  let pass = 0
  let pending: PendingSpace[] = pendingAfter[0] ?? []
  const timers: Array<{ at: number; fn: () => void }> = []
  const notices: NotificationInput[] = []
  const logs: string[] = []
  const watch = createMigrationWatch({
    run: async () => {
      pending = pendingAfter[Math.min(pass, pendingAfter.length - 1)] ?? []
      pass += 1
      return { moved: 0, dropped: 0, left: 0, failed: pending.map((p) => `${p.name}: its brain did not answer`), reports: [] }
    },
    pending: () => pending,
    notify: (input) => { notices.push(input) },
    now: () => now,
    log: (line) => logs.push(line),
    later: (fn, ms) => { timers.push({ at: now + ms, fn }) },
  })
  /** Run the next timer: the clock jumps to it. Returns how long the wait was, or null when nothing is set. */
  const next = async (): Promise<number | null> => {
    const timer = timers.shift()
    if (!timer) return null
    const waited = timer.at - now
    now = timer.at
    timer.fn()
    await watch.idle()
    return waited
  }
  return { watch, next, notices, logs, passes: () => pass, timers }
}

const TEAM: PendingSpace = { key: 'space-2', name: 'Team', jobs: 3 }

describe('the jobs migration keeps trying, and tells the user', () => {
  it('a pass that moves everything sets no retry and tells nothing', async () => {
    const w = world([[]])
    w.watch.start()
    await w.watch.idle()
    expect(w.passes()).toBe(1)
    expect(await w.next()).toBeNull()
    expect(w.notices).toEqual([])
  })

  it('retries after 1, 5 and 15 minutes, then every 15 minutes for as long as jobs wait', async () => {
    const w = world([[TEAM]])
    w.watch.start()
    await w.watch.idle()
    const waits: Array<number | null> = []
    for (let i = 0; i < 8; i++) waits.push(await w.next())
    expect(waits).toEqual([1, 5, 15, 15, 15, 15, 15, 15].map((m) => m * MIN))
    expect(MIGRATION_RETRY).toEqual({ quickMs: [1 * MIN, 5 * MIN, 15 * MIN], everyMs: 15 * MIN, tellAfterMs: 10 * MIN })
    expect(w.passes()).toBe(9)
    // it stops once nothing waits any more
    const done = world([[TEAM], [TEAM], []])
    done.watch.start()
    await done.watch.idle()
    expect([await done.next(), await done.next(), await done.next()]).toEqual([1 * MIN, 5 * MIN, null])
  })

  it('tells the user once per space whose jobs have waited more than ten minutes, naming the space, and takes it back when they have moved', async () => {
    const w = world([[TEAM], [TEAM], [TEAM], [TEAM], [TEAM], []])
    w.watch.start()
    await w.watch.idle()
    await w.next() // 1 min
    await w.next() // 6 min
    expect(w.notices).toEqual([])
    await w.next() // 21 min
    expect(w.notices).toEqual([{
      kind: 'paused', title: 'Team', sessionId: null, spaceId: 'space-2', jobId: 'jobs-migration:space-2',
      body: 'The schedules of this space are not firing yet: 3 jobs from before the update have not moved onto their tasks. The cockpit tries again every 15 minutes; its log says why.',
    }])
    await w.next() // 36 min: still waiting, not told again
    expect(w.notices).toHaveLength(1)
    await w.next() // 51 min: moved
    expect(w.notices).toHaveLength(2)
    expect(w.notices[1]).toEqual({ kind: 'done', title: 'Team', sessionId: null, spaceId: 'space-2', jobId: 'jobs-migration:space-2', body: 'Its schedules have moved onto their tasks and fire again.' })
    expect(await w.next()).toBeNull()
  })

  it('tells each space on its own, the main space by its name, and a space that moved in time never', async () => {
    const main: PendingSpace = { key: null, name: 'Main', jobs: 1 }
    const w = world([[main, TEAM], [main], [main], [main]])
    w.watch.start()
    await w.watch.idle()
    for (let i = 0; i < 3; i++) await w.next()
    expect(w.notices.map((n) => [n.title, n.spaceId, n.jobId, n.body.includes('1 job from before')])).toEqual([['Main', null, 'jobs-migration:main', true]])
  })

  it('a pass that throws is tried again like one that left jobs', async () => {
    const timers: Array<() => void> = []
    const logs: string[] = []
    const watch = createMigrationWatch({
      run: async () => { throw new Error('jobs.json cannot be read') }, pending: () => [TEAM], notify: () => {}, now: () => 0, log: (line) => logs.push(line),
      later: (fn) => { timers.push(fn) },
    })
    watch.start()
    await watch.idle()
    expect(logs).toEqual(['[jobs] migration failed: jobs.json cannot be read'])
    expect(timers).toHaveLength(1)
  })
})
