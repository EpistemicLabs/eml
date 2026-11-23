import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-cycles-'))
process.env.EML_COCKPIT_HOME = home

// Cycles: one per ISO week in the user's time zone, a brain subject; a new
// week carries the last cycle's open tasks over and closes it.

describe('cycles', () => {
  let mod: typeof import('../src/application/cycles.js')
  beforeAll(async () => { mod = await import('../src/application/cycles.js') })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('names the ISO week in the user\'s zone, across a year end', () => {
    expect(mod.cycleOf(new Date('2026-11-18T10:00:00Z'), 'UTC')).toEqual({ id: 'cycle-2026-w47', week: 47, from: '2026-11-16', to: '2026-11-22' })
    // Sunday 23:30 UTC is already Monday in Singapore.
    expect(mod.cycleOf(new Date('2026-11-22T23:30:00Z'), 'Asia/Singapore').id).toBe('cycle-2026-w48')
    expect(mod.cycleOf(new Date('2027-01-01T12:00:00Z'), 'UTC').id).toBe('cycle-2026-w53')
    expect(mod.cycleOf(new Date('2026-11-18T10:00:00Z'), 'UTC', -1).id).toBe('cycle-2026-w46')
    expect(mod.rollovers(['cycle-2026-w46', 'cycle-2026-w47', 'homepage'])).toBe(1)
  })

  it('starts the week once: makes its subject, carries the open tasks over, closes the last', async () => {
    const subjects = new Set(['cycle-2026-w46'])
    const calls: string[] = []
    const brain = {
      async get(path: string, q?: Record<string, unknown>) {
        if (path.startsWith('/object/subject/')) { if (subjects.has(path.split('/').at(-1)!)) return {}; throw new Error('404') }
        if (path === '/list') return { engrams: q?.status === 'active' ? [{ id: 't1', subjects: ['cycle-2026-w46', 'website'] }] : [] }
        return {}
      },
      async post(path: string, body: Record<string, unknown>) {
        calls.push(`${path} ${JSON.stringify(body)}`)
        if (path === '/object/subject') subjects.add(String(body.name))
        return {}
      },
      async put(path: string, body: Record<string, unknown>) { calls.push(`PUT ${path} ${JSON.stringify(body)}`); return {} },
    }
    const cycles = mod.createCycles({
      spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain,
      timeZone: () => 'UTC', log: () => {}, now: () => new Date('2026-11-18T10:00:00Z'),
    })
    await cycles.ensure()
    await cycles.ensure()
    expect(calls).toEqual([
      '/object/subject {"name":"cycle-2026-w47","description":"Cycle, week 47: 2026-11-16 to 2026-11-22."}',
      '/task/t1/track {"subjects":["cycle-2026-w46","website","cycle-2026-w47"]}',
      'PUT /object/subject/cycle-2026-w46 {"status":"closed"}',
    ])
  })

  it('briefs the planner to read, propose and ask, and to keep a task\'s other subjects', () => {
    const now = new Date('2026-11-18T10:00:00Z')
    const text = mod.plannerPrompt(mod.cycleOf(now, 'UTC'), mod.cycleOf(now, 'UTC', 1), mod.cycleOf(now, 'UTC', -1))
    expect(text).toContain('This week is cycle-2026-w47')
    expect(text).toContain('subject=cycle-2026-w46')
    expect(text).toContain('Ask before you change anything')
    expect(text).toContain('its current subjects plus the cycle id')
  })
})
