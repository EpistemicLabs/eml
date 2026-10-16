import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-hygiene-test-'))
process.env.EML_COCKPIT_HOME = home

type Mods = typeof import('../src/brain-hygiene.js') & typeof import('../src/project-registry.js') & typeof import('../src/spawn-queue.js')
type Report = import('../src/brain-hygiene.js').HygieneReport

const finding = (id: string, reason = 'r') => ({ id, type: 'rule', scope: 'global', title: `t-${id}`, reason })
const report = (migration: number, review: number): Report => ({
  checks: [
    { id: 'rule-profile-format', kind: 'migration', since: '0.17.18', what: 'W', how: 'H', findings: Array.from({ length: migration }, (_, i) => finding(`m${i}`)) },
    { id: 'review-due', kind: 'review', since: '0.17.18', what: 'RW', how: 'RH', findings: Array.from({ length: review }, (_, i) => finding(`r${i}`)) },
  ],
  total: migration + review,
})
const NOW = new Date('2026-10-15T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

describe('brain hygiene (host trigger)', () => {
  let mods: Mods

  beforeAll(async () => {
    mods = {
      ...(await import('../src/brain-hygiene.js')),
      ...(await import('../src/project-registry.js')),
      ...(await import('../src/spawn-queue.js')),
    } as Mods
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  describe('hygieneDue', () => {
    it('is due after an update while a migration check has findings, once per version', () => {
      const due = mods.hygieneDue(report(3, 0), {}, '0.17.18', NOW)
      expect(due?.reasons).toEqual(['after the update to v0.17.18, engrams do not fit a requirement of the current version'])
      expect(due?.checks.map((c) => c.id)).toEqual(['rule-profile-format'])
      expect(due?.next).toEqual({ version: '0.17.18', reviewAt: NOW.toISOString() })
      expect(mods.hygieneDue(report(3, 0), { version: '0.17.18' }, '0.17.18', NOW)).toBeNull()
      expect(mods.hygieneDue(report(3, 0), { version: '0.17.18' }, '0.17.19', NOW)).not.toBeNull()
      expect(mods.hygieneDue(report(0, 0), {}, '0.17.18', NOW)).toBeNull()
    })

    it('is due for reviews from the threshold on, at most every 7 days', () => {
      const v = { version: '0.17.18' }
      expect(mods.hygieneDue(report(0, mods.REVIEW_THRESHOLD - 1), v, '0.17.18', NOW)).toBeNull()
      expect(mods.hygieneDue(report(0, mods.REVIEW_THRESHOLD), v, '0.17.18', NOW)?.reasons).toEqual(['5 engrams are due for review'])
      expect(mods.hygieneDue(report(0, 9), { ...v, reviewAt: daysAgo(6) }, '0.17.18', NOW)).toBeNull()
      expect(mods.hygieneDue(report(0, 9), { ...v, reviewAt: daysAgo(7) }, '0.17.18', NOW)).not.toBeNull()
    })

    it('carries every check with findings into one session', () => {
      const due = mods.hygieneDue(report(2, 6), {}, '0.17.18', NOW)!
      expect(due.reasons).toHaveLength(2)
      expect(due.checks.map((c) => c.id)).toEqual(['rule-profile-format', 'review-due'])
    })
  })

  it('hygienePrompt names the skill, the reason and every finding with what and how', () => {
    const prompt = mods.hygienePrompt(mods.hygieneDue(report(1, 0), {}, '0.17.18', NOW)!)
    expect(prompt).toBe([
      'Use the brain-hygiene skill.',
      '',
      "The cockpit opened this session: after the update to v0.17.18, engrams do not fit a requirement of the current version. The brain's hygiene check found:",
      '',
      '## rule-profile-format (migration, since v0.17.18) — 1 finding',
      'What: W',
      'How: H',
      '- m0 · rule · global · t-m0 — r',
    ].join('\n'))
  })

  describe('BrainHygiene', () => {
    let registry: InstanceType<Mods['ProjectRegistry']>
    let space: any
    let spaces: any

    beforeEach(() => {
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't' }))
      registry = new mods.ProjectRegistry()
      space = { id: 'brain-1', name: 'Main', main: true, url: 'http://x', token: 't', registry }
      spaces = { list: () => [space] }
    })

    it('queues one session in the Brain hygiene project and records it when a tab claims it', async () => {
      const spawns = new mods.SpawnQueue()
      const hygiene = new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => true, fetchReport: async () => report(2, 0), now: () => NOW })
      await hygiene.check()
      await hygiene.check()

      const requests = spawns.list()
      expect(requests).toHaveLength(1)
      const project = registry.list().find((p) => p.kind === 'folder')
      expect(project?.displayName).toBe('Brain hygiene')
      expect(requests[0]).toMatchObject({ projectId: project!.projectId, title: 'Brain hygiene', fromSessionId: null })
      expect(requests[0].prompt.startsWith('Use the brain-hygiene skill.')).toBe(true)

      spawns.claim(requests[0].id)
      for (let i = 0; i < 100 && !JSON.parse(readFileSync(join(home, 'config'), 'utf8')).hygiene; i++) await new Promise((r) => setTimeout(r, 10))
      const config = JSON.parse(readFileSync(join(home, 'config'), 'utf8'))
      expect(config.hygiene).toEqual({ 'brain-1': { version: '0.17.18', reviewAt: NOW.toISOString() } })
      expect(config.token).toBe('t')

      // Recorded: the same version opens nothing more.
      await hygiene.check()
      expect(spawns.list()).toHaveLength(0)
    })

    it('keeps the state of every space when tabs claim their sessions at once', async () => {
      const other = { id: 'brain-2', name: 'Privat', main: false, url: 'http://y', token: 'u', registry }
      const spawns = new mods.SpawnQueue()
      const hygiene = new mods.BrainHygiene({ spaces: { list: () => [space, other] }, spawns, version: '0.17.18', isReady: async () => true, fetchReport: async () => report(2, 0), now: () => NOW })
      await hygiene.check()
      const requests = spawns.list()
      expect(requests).toHaveLength(2)

      for (const r of requests) spawns.claim(r.id)
      const recorded = () => Object.keys(JSON.parse(readFileSync(join(home, 'config'), 'utf8')).hygiene ?? {}).length
      for (let i = 0; i < 100 && recorded() < 2; i++) await new Promise((r) => setTimeout(r, 10))
      const config = JSON.parse(readFileSync(join(home, 'config'), 'utf8'))
      expect(config.hygiene).toEqual({
        'brain-1': { version: '0.17.18', reviewAt: NOW.toISOString() },
        'brain-2': { version: '0.17.18', reviewAt: NOW.toISOString() },
      })
    })

    it('opens nothing before the agent CLI is ready or during onboarding', async () => {
      const spawns = new mods.SpawnQueue()
      await new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => false, fetchReport: async () => report(2, 0) }).check()
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', onboarding: 'pending' }))
      await new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => true, fetchReport: async () => report(2, 0) }).check()
      expect(spawns.list()).toHaveLength(0)
    })

    it('skips a space whose check fails', async () => {
      const spawns = new mods.SpawnQueue()
      const lines: string[] = []
      await new mods.BrainHygiene({
        spaces, spawns, version: '0.17.18', isReady: async () => true, log: (l) => lines.push(l),
        fetchReport: async () => { throw new Error('GET /hygiene → 503') },
      }).check()
      expect(spawns.list()).toHaveLength(0)
      expect(lines).toEqual(['brain hygiene: check of Main failed — GET /hygiene → 503'])
    })

    it('runNow opens a session for one space below every threshold, once at a time', async () => {
      const spawns = new mods.SpawnQueue()
      // Already run for this version, reviews under the threshold: the scheduler opens nothing …
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', hygiene: { 'brain-1': { version: '0.17.18', reviewAt: NOW.toISOString() } } }))
      const hygiene = new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => true, fetchReport: async () => report(1, 2), now: () => NOW })
      await hygiene.check()
      expect(spawns.list()).toHaveLength(0)

      // … the manual run does, with every check that has findings.
      expect(await hygiene.runNow(space)).toEqual({ started: true, findings: 3 })
      const [request] = spawns.list()
      expect(request.prompt).toContain('The cockpit opened this session: the user started it from Settings › Brain.')
      expect(request.prompt).toContain('## rule-profile-format')
      expect(request.prompt).toContain('## review-due')
      expect(await hygiene.runNow(space)).toEqual({ started: false, reason: 'pending' })
    })

    it('runNow reports a clean brain and a missing agent CLI', async () => {
      const spawns = new mods.SpawnQueue()
      expect(await new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => true, fetchReport: async () => report(0, 0) }).runNow(space))
        .toEqual({ started: false, reason: 'clean' })
      expect(await new mods.BrainHygiene({ spaces, spawns, version: '0.17.18', isReady: async () => false, fetchReport: async () => report(2, 0) }).runNow(space))
        .toEqual({ started: false, reason: 'not-ready' })
      expect(spawns.list()).toHaveLength(0)
    })
  })
})
