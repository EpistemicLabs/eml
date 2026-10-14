import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-onboarding-test-'))
process.env.EML_COCKPIT_HOME = home

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('startOnboarding', () => {
  let mods: {
    startOnboarding: typeof import('../src/onboarding.js')['startOnboarding']
    queueSignInSession: typeof import('../src/onboarding.js')['queueSignInSession']
    ONBOARDING_DIR: string
    ProjectRegistry: typeof import('../src/project-registry.js')['ProjectRegistry']
    SpawnQueue: typeof import('../src/spawn-queue.js')['SpawnQueue']
  }

  beforeAll(async () => {
    const onboarding = await import('../src/onboarding.js')
    const registry = await import('../src/project-registry.js')
    const queue = await import('../src/spawn-queue.js')
    mods = { ...onboarding, ...registry, ...queue }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('queues the session (and registers its project) only when Claude is ready, marks done on claim', async () => {
    writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', onboarding: 'pending' }))
    const projects = new mods.ProjectRegistry()
    const spawns = new mods.SpawnQueue()
    let ready = false
    const stop = mods.startOnboarding({ projects, spawns, isClaudeReady: async () => ready, pollMs: 5 })

    // Not signed in yet: nothing is queued (the sign-in session comes from Settings › Models).
    await new Promise((r) => setTimeout(r, 30))
    expect(spawns.list()).toHaveLength(0)

    expect(projects.list()).toHaveLength(0)

    ready = true
    await until(() => spawns.list().length === 1)
    expect(existsSync(mods.ONBOARDING_DIR)).toBe(true)
    const project = projects.list().find((p) => p.kind === 'folder')
    expect(project?.displayName).toBe('Getting started')
    const [request] = spawns.list()
    expect(request).toMatchObject({ projectId: project!.projectId, prompt: '/getting-started', fromSessionId: null, placement: 'replace-empty-desk' })

    spawns.claim(request.id)
    await until(() => JSON.parse(readFileSync(join(home, 'config'), 'utf8')).onboarding === 'done')
    expect(JSON.parse(readFileSync(join(home, 'config'), 'utf8')).token).toBe('t')
    stop()
  })

  it('queues a /login session in the given project, or in Getting started without one', async () => {
    const projects = new mods.ProjectRegistry()
    const spawns = new mods.SpawnQueue()
    mods.queueSignInSession(projects, spawns, 'bp-acme')
    mods.queueSignInSession(projects, spawns, null)
    const [own, fallback] = spawns.list()
    expect(own).toMatchObject({ projectId: 'bp-acme', prompt: '/login', placement: 'replace-empty-desk' })
    expect(fallback.projectId).toBe(projects.list().find((p) => p.displayName === 'Getting started')?.projectId)
  })
})
