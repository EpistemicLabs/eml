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
const sessions: Record<string, { spaceId: string | null; projectId: string | null; taskId: string | null }> = {
  s1: { spaceId: null, projectId: 'p1', taskId: 't1' },
  s2: { spaceId: 'team', projectId: 'p2', taskId: null },
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
    await t.beat({ spaceId: null, projectId: null, sessionId: 's1' })
    now += 30_000
    await t.beat({ spaceId: null, projectId: 'p2', sessionId: null })
    now += 30_000
    await t.beat({ spaceId: null, projectId: 'p2', sessionId: null })
    const day = today(t)
    expect(day.user).toBe(60)
    expect(day.projects).toEqual({
      '/p1': { user: 30, agent: 0, spaceId: null, projectId: 'p1' },
      '/p2': { user: 30, agent: 0, spaceId: null, projectId: 'p2' },
    })
    expect(day.tasks.t1).toEqual({ user: 30, agent: 0, spaceId: null, projectId: 'p1' })
    expect(day.sessions.s1.user).toBe(30)
  })

  it('keeps an id like __proto__ a record of its own', async () => {
    const t = tracker()
    const odd = { spaceId: '__proto__', projectId: 'constructor', sessionId: '__proto__' }
    await t.beat(odd)
    now += 30_000
    await t.beat(odd)
    expect(({} as Record<string, unknown>).user).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('user')
    expect(today(t).sessions['__proto__']).toMatchObject({ user: 30 })
    // And so it stays after the day file is read back.
    expect(tracker().days(1)[0].sessions['__proto__']).toMatchObject({ user: 30 })
  })

  it('counts nothing across a gap, and keeps time on no project apart', async () => {
    const t = tracker()
    await t.beat({ spaceId: null, projectId: null, sessionId: null })
    now += 30_000
    await t.beat({ spaceId: null, projectId: null, sessionId: null })
    now += 10 * 60_000
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    expect(today(t).user).toBe(30)
    expect(today(t).projects['/']).toEqual({ user: 30, agent: 0, spaceId: null, projectId: null })
  })

  it('counts no gap before a fresh beat: the user is back after a pause', async () => {
    const t = tracker()
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    now += 60_000
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null }, true)
    now += 30_000
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    expect(today(t).user).toBe(30)
  })

  it('writes nothing while the plugin is off', async () => {
    on = false
    const t = tracker()
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    now += 30_000
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    expect(readdirSync(dir)).toEqual([])
    expect(today(t).user).toBe(0)
  })
})

describe('across spaces', () => {
  it('keeps the same project id in two spaces apart, a session in its own space', async () => {
    const t = tracker()
    await t.beat({ spaceId: 'team', projectId: 'p1', sessionId: null })
    now += 30_000
    await t.beat({ spaceId: null, projectId: 'p1', sessionId: null })
    now += 30_000
    // The pane's space is the open one, the session runs in 'team'.
    await t.beat({ spaceId: null, projectId: null, sessionId: 's2' })
    now += 30_000
    await t.beat({ spaceId: null, projectId: null, sessionId: null })
    const day = today(t)
    expect(day.user).toBe(90)
    expect(Object.keys(day.projects).sort()).toEqual(['/p1', 'team/p1', 'team/p2'])
    expect(day.sessions.s2.spaceId).toBe('team')
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
    expect(day.projects['/p1']).toEqual({ user: 0, agent: 180, spaceId: null, projectId: 'p1' })
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
    // The session's own space, from the ledger.
    expect(days[0].projects['team/p2'].agent).toBe(60)
    expect(days[1].projects).toEqual({})
  })
})
