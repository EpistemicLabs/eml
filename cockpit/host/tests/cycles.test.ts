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
      spaces: { list: () => [{ shared: false, name: 'Main' } as never] }, brain: () => brain, me: 'lasse',
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

  /** A shared brain the other member's cockpit works in too: subjects with their status, tasks with owner and subjects. */
  function sharedBrain(subjects: Record<string, string>, tasks: Array<{ id: string; status: string; subjects: string[]; ingested_by: string; properties?: { assignee_ids?: string[] } }>, opts: { createFails?: boolean } = {}) {
    const calls: string[] = []
    return {
      calls,
      async get(path: string, q?: Record<string, unknown>) {
        if (path.startsWith('/object/subject/')) {
          const name = path.split('/').at(-1)!
          if (!(name in subjects)) throw new Error('404')
          return { object: { id: name, name, status: subjects[name] } }
        }
        if (path === '/list') return { engrams: tasks.filter((t) => t.status === q?.status && t.subjects.includes(String(q?.subject))) }
        return {}
      },
      async post(path: string, body: Record<string, unknown>) {
        calls.push(`${path} ${JSON.stringify(body)}`)
        if (path === '/object/subject') {
          // The other member's cockpit made it a moment earlier.
          subjects[String(body.name)] = 'active'
          if (opts.createFails) throw new Error('subject "cycle-2026-w47" already exists')
          return {}
        }
        const task = tasks.find((t) => path === `/task/${t.id}/track`)!
        task.subjects = body.subjects as string[]
        return {}
      },
      async put(path: string, body: Record<string, unknown>) {
        calls.push(`PUT ${path} ${JSON.stringify(body)}`)
        subjects[path.split('/').at(-1)!] = String(body.status)
        return {}
      },
    }
  }

  const sharedCycles = (brain: ReturnType<typeof sharedBrain>, logs: string[] = [], shared: boolean | null = true) => mod.createCycles({
    spaces: { list: () => [{ shared, name: 'Team' } as never] }, brain: () => brain, me: 'lasse',
    timeZone: () => 'UTC', log: (l) => logs.push(l), now: () => new Date('2026-11-18T10:00:00Z'),
  })

  it('in a shared space carries only the member\'s own open tasks, also when the other cockpit made the week, and closes the last once', async () => {
    const brain = sharedBrain({ 'cycle-2026-w46': 'active', 'cycle-2026-w47': 'active' }, [
      { id: 'authored', status: 'active', subjects: ['cycle-2026-w46'], ingested_by: 'lasse' },
      { id: 'assigned', status: 'planned', subjects: ['cycle-2026-w46', 'website'], ingested_by: 'dominik', properties: { assignee_ids: ['lasse'] } },
      { id: 'theirs', status: 'active', subjects: ['cycle-2026-w46'], ingested_by: 'lasse', properties: { assignee_ids: ['dominik'] } },
      { id: 'their-own', status: 'planned', subjects: ['cycle-2026-w46'], ingested_by: 'dominik' },
      { id: 'carried', status: 'active', subjects: ['cycle-2026-w46', 'cycle-2026-w47'], ingested_by: 'lasse' },
    ])
    const cycles = sharedCycles(brain)
    await cycles.ensure()
    await cycles.ensure()
    expect(brain.calls).toEqual([
      '/task/assigned/track {"subjects":["cycle-2026-w46","website","cycle-2026-w47"]}',
      '/task/authored/track {"subjects":["cycle-2026-w46","cycle-2026-w47"]}',
      'PUT /object/subject/cycle-2026-w46 {"status":"closed"}',
    ])
  })

  it('in a shared space writes nothing when nothing is left to carry and the last cycle is closed', async () => {
    const brain = sharedBrain({ 'cycle-2026-w46': 'closed', 'cycle-2026-w47': 'active' }, [
      { id: 'theirs', status: 'active', subjects: ['cycle-2026-w46'], ingested_by: 'dominik' },
    ])
    await sharedCycles(brain, [], null).ensure()
    expect(brain.calls).toEqual([])
  })

  it('in a shared space takes a week the other cockpit made at the same moment, without an error', async () => {
    const brain = sharedBrain({ 'cycle-2026-w46': 'active' }, [
      { id: 'authored', status: 'active', subjects: ['cycle-2026-w46'], ingested_by: 'lasse' },
    ], { createFails: true })
    const logs: string[] = []
    await sharedCycles(brain, logs).ensure()
    expect(brain.calls.slice(1)).toEqual([
      '/task/authored/track {"subjects":["cycle-2026-w46","cycle-2026-w47"]}',
      'PUT /object/subject/cycle-2026-w46 {"status":"closed"}',
    ])
    expect(logs.join('\n')).not.toContain('already exists')
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
