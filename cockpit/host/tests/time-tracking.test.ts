import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TimeTracker } from '../src/time-tracking.js'

// The Time plugin's clocks (time-tracking.ts): the user's from the browser's
// beats, to what was in front at the earlier beat; the agent's from the turns;
// nothing written while the plugin is off.

let dir: string
let now: number
let on: boolean
const sessions: Record<string, { projectId: string | null; taskId: string | null }> = {
  s1: { projectId: 'p1', taskId: 't1' },
  s2: { projectId: 'p2', taskId: null },
}

const tracker = () => new TimeTracker((id) => sessions[id] ?? null, async () => on, dir, () => now)
const today = (t: TimeTracker) => t.days(1)[0]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-time-test-'))
  now = new Date(2026, 10, 17, 10, 0, 0).getTime()
  on = true
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the user clock', () => {
  it('credits the time between beats to what was in front at the first', async () => {
    const t = tracker()
    await t.beat({ projectId: null, sessionId: 's1' })
    now += 30_000
    await t.beat({ projectId: 'p2', sessionId: null })
    now += 30_000
    await t.beat({ projectId: 'p2', sessionId: null })
    const day = today(t)
    expect(day.user).toBe(60)
    expect(day.projects).toEqual({ p1: { user: 30, agent: 0 }, p2: { user: 30, agent: 0 } })
    expect(day.tasks.t1).toEqual({ user: 30, agent: 0, projectId: 'p1' })
    expect(day.sessions.s1.user).toBe(30)
  })

  it('counts nothing across a gap, and keeps time on no project apart', async () => {
    const t = tracker()
    await t.beat({ projectId: null, sessionId: null })
    now += 30_000
    await t.beat({ projectId: null, sessionId: null })
    now += 10 * 60_000
    await t.beat({ projectId: 'p1', sessionId: null })
    expect(today(t).user).toBe(30)
    expect(today(t).projects['']).toEqual({ user: 30, agent: 0 })
  })

  it('writes nothing while the plugin is off', async () => {
    on = false
    const t = tracker()
    await t.beat({ projectId: 'p1', sessionId: null })
    now += 30_000
    await t.beat({ projectId: 'p1', sessionId: null })
    expect(readdirSync(dir)).toEqual([])
    expect(today(t).user).toBe(0)
  })
})

describe('the agent clock', () => {
  it('counts a turn from working to done, apart from the user total', async () => {
    const t = tracker()
    await t.turn({ sessionId: 's1', state: 'working', since: '' })
    now += 120_000
    // Still running: today's figures show it already.
    expect(today(t).sessions.s1.agent).toBe(120)
    now += 60_000
    await t.turn({ sessionId: 's1', state: 'done', since: '' })
    const day = today(t)
    expect(day.user).toBe(0)
    expect(day.projects.p1).toEqual({ user: 0, agent: 180 })
    expect(day.tasks.t1.agent).toBe(180)
    now += 60_000
    expect(today(t).sessions.s1.agent).toBe(180)
  })

  it('lists the last days oldest first, today last', async () => {
    const t = tracker()
    await t.turn({ sessionId: 's2', state: 'working', since: '' })
    now += 60_000
    await t.turn({ sessionId: 's2', state: 'waiting', since: '' })
    now += 24 * 3600_000
    const days = t.days(2)
    expect(days.map((d) => d.date)).toEqual(['2026-11-17', '2026-11-18'])
    expect(days[0].projects.p2.agent).toBe(60)
    expect(days[1].projects).toEqual({})
  })
})
