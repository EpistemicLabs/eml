import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-hygiene-test-'))
process.env.EML_COCKPIT_HOME = home

type Mods = typeof import('../src/brain-hygiene.js') & typeof import('../src/project-registry.js') & typeof import('../src/spawn-queue.js')
type Report = import('../src/brain-hygiene.js').HygieneReport

const finding = (id: string) => ({ id, type: 'rule', scope: 'global', title: `t-${id}`, reason: 'r' })
const report = (migration: number, review: number, schema = 18): Report => ({
  schema,
  checks: [
    { id: 'rule-profile-format', kind: 'migration', since_schema: 18, what: 'W', how: 'H', findings: Array.from({ length: migration }, (_, i) => finding(`m${i}`)) },
    { id: 'review-due', kind: 'review', what: 'RW', how: 'RH', findings: Array.from({ length: review }, (_, i) => finding(`r${i}`)) },
  ],
  total: migration + review,
})
const NOW = new Date('2026-10-19T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const config = () => JSON.parse(readFileSync(join(home, 'config'), 'utf8'))

describe('brain hygiene (cockpit offer)', () => {
  let mods: Mods

  beforeAll(async () => {
    mods = {
      ...(await import('../src/brain-hygiene.js')),
      ...(await import('../src/project-registry.js')),
      ...(await import('../src/spawn-queue.js')),
    } as Mods
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  describe('hygieneOffer', () => {
    it('offers migration findings once per schema', () => {
      const offer = mods.hygieneOffer(report(3, 0), {}, NOW)
      expect(offer?.reasons).toEqual(['schema 18 changed the engram format — 3 entries need rewriting'])
      expect(offer?.checks.map((c) => c.id)).toEqual(['rule-profile-format'])
      expect(offer?.next).toEqual({ offeredSchema: 18 })
      expect(mods.hygieneOffer(report(3, 0), { offeredSchema: 18 }, NOW)).toBeNull()
      expect(mods.hygieneOffer(report(3, 0, 19), { offeredSchema: 18 }, NOW)?.checks.map((c) => c.id)).toEqual(['rule-profile-format'])
      expect(mods.hygieneOffer(report(0, 0), {}, NOW)).toBeNull()
      expect(mods.hygieneOffer(report(1, 0), {}, NOW)?.reasons).toEqual(['schema 18 changed the engram format — 1 entry needs rewriting'])
    })

    it('offers due reviews once a week, from one due review on', () => {
      const s = { offeredSchema: 18 }
      expect(mods.hygieneOffer(report(0, 1), s, NOW)?.reasons).toEqual(['1 review is due'])
      expect(mods.hygieneOffer(report(0, 9), s, NOW)?.next).toEqual({ offeredSchema: 18, reviewsOfferedAt: NOW.toISOString() })
      expect(mods.hygieneOffer(report(0, 9), { ...s, reviewsOfferedAt: daysAgo(6) }, NOW)).toBeNull()
      expect(mods.hygieneOffer(report(0, 9), { ...s, reviewsOfferedAt: daysAgo(7) }, NOW)?.reasons).toEqual(['9 reviews are due'])
    })

    it('puts both reasons into one offer, and only the offered checks into the session', () => {
      const both = mods.hygieneOffer(report(2, 6), {}, NOW)!
      expect(both.reasons).toEqual(['schema 18 changed the engram format — 2 entries need rewriting', '6 reviews are due'])
      expect(both.checks.map((c) => c.id)).toEqual(['rule-profile-format', 'review-due'])
      // Migration already offered for this schema: the review offer carries only the review check.
      const reviewsOnly = mods.hygieneOffer(report(2, 6), { offeredSchema: 18 }, NOW)!
      expect(reviewsOnly.checks.map((c) => c.id)).toEqual(['review-due'])
    })
  })

  it('hygienePrompt names the skill, the file and the count per check', () => {
    expect(mods.hygienePrompt(mods.hygieneOffer(report(12, 9), {}, NOW)!)).toBe(
      "Use the brain-hygiene skill. The cockpit wrote this brain's hygiene findings to findings.json in this folder: rule-profile-format 12, review-due 9.",
    )
  })

  describe('BrainHygiene', () => {
    let registry: InstanceType<Mods['ProjectRegistry']>
    let space: any

    beforeEach(() => {
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't' }))
      registry = new mods.ProjectRegistry(join(home, `registry-${Math.random()}.json`))
      space = { id: 'brain-1', name: 'Main', main: true, url: 'http://x', token: 't', registry }
    })

    const make = (r: Report, extra: Partial<ConstructorParameters<Mods['BrainHygiene']>[0]> = {}) => {
      const spawns = new mods.SpawnQueue()
      const hygiene = new mods.BrainHygiene({ spawns, isReady: async () => true, fetchReport: async () => r, now: () => NOW, ...extra })
      return { spawns, hygiene }
    }

    it('shows the offer, and nothing before the agent CLI is ready or during onboarding', async () => {
      expect(await make(report(2, 1)).hygiene.view(space)).toEqual({
        space: 'Main',
        reasons: ['schema 18 changed the engram format — 2 entries need rewriting', '1 review is due'],
        findings: 3,
      })
      expect(await make(report(2, 1), { isReady: async () => false }).hygiene.view(space)).toBeNull()
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', onboarding: 'pending' }))
      expect(await make(report(2, 1)).hygiene.view(space)).toBeNull()
    })

    it('Start writes findings.json, queues one session in the Brain hygiene folder and records the offer', async () => {
      const { spawns, hygiene } = make(report(2, 1))
      expect(await hygiene.start(space)).toEqual({ ok: true, findings: 3 })

      const dir = join(home, 'brain-hygiene', 'brain-1')
      const file = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'))
      expect(file).toEqual({
        space: 'Main', schema: 18, generated_at: NOW.toISOString(),
        checks: report(2, 1).checks,
      })
      expect(statSync(join(dir, 'findings.json')).mode & 0o777).toBe(0o600)

      const requests = spawns.list()
      expect(requests).toHaveLength(1)
      const project = registry.list().find((p) => p.kind === 'folder')
      expect(project?.displayName).toBe('Brain hygiene')
      expect(requests[0]).toMatchObject({ projectId: project!.projectId, title: 'Brain hygiene', fromSessionId: null })
      expect(requests[0].spaceId).toBeUndefined()
      expect(requests[0].prompt).toBe(
        "Use the brain-hygiene skill. The cockpit wrote this brain's hygiene findings to findings.json in this folder: rule-profile-format 2, review-due 1.",
      )
      expect(config().hygiene).toEqual({ 'brain-1': { offeredSchema: 18, reviewsOfferedAt: NOW.toISOString() } })
      expect(config().token).toBe('t')

      // Offered: no banner, a second Start opens nothing.
      expect(await hygiene.view(space)).toBeNull()
      expect(await hygiene.start(space)).toEqual({ ok: false, reason: 'nothing-due' })
      expect(spawns.list()).toHaveLength(1)
    })

    it('names the brain schema in findings.json also when only reviews are offered', async () => {
      writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', hygiene: { 'brain-1': { offeredSchema: 18 } } }))
      const { spawns, hygiene } = make(report(2, 3))
      expect(await hygiene.start(space)).toEqual({ ok: true, findings: 3 })
      const file = JSON.parse(readFileSync(join(home, 'brain-hygiene', 'brain-1', 'findings.json'), 'utf8'))
      expect(file.schema).toBe(18)
      expect(file.checks.map((c: { id: string }) => c.id)).toEqual(['review-due'])
      expect(spawns.list()[0].prompt).toMatch(/: review-due 3\.$/)
    })

    it('two Starts at once open one session', async () => {
      const { spawns, hygiene } = make(report(2, 0))
      const results = await Promise.all([hygiene.start(space), hygiene.start(space)])
      expect(results).toContainEqual({ ok: true, findings: 2 })
      expect(results).toContainEqual({ ok: false, reason: 'pending' })
      expect(spawns.list()).toHaveLength(1)
    })

    it("a further space gets its own folder, beside the main space's, and its spaceId on the request", async () => {
      const other = { id: 'brain-2', name: 'Privat', main: false, url: 'http://y', token: 'u', registry }
      const { spawns, hygiene } = make(report(1, 0))
      await hygiene.start(other)
      expect(JSON.parse(readFileSync(join(home, 'brain-hygiene', 'brain-2', 'findings.json'), 'utf8')).space).toBe('Privat')
      expect(spawns.list()[0].spaceId).toBe('brain-2')
      expect(config().hygiene).toEqual({ 'brain-2': { offeredSchema: 18 } })
    })

    it('Not now records the offer and opens nothing', async () => {
      const { spawns, hygiene } = make(report(2, 4))
      expect(await hygiene.dismiss(space)).toEqual({ ok: true, findings: 6 })
      expect(spawns.list()).toHaveLength(0)
      expect(config().hygiene).toEqual({ 'brain-1': { offeredSchema: 18, reviewsOfferedAt: NOW.toISOString() } })
      expect(await hygiene.view(space)).toBeNull()
    })
  })
})
