import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-project-link-'))
process.env.EML_COCKPIT_HOME = home

type Mods = {
  ProjectRegistry: typeof import('../src/project-registry.js')['ProjectRegistry']
  isCockpitOwnFolder: typeof import('../src/project-registry.js')['isCockpitOwnFolder']
  SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
}

// Every project is a brain project (decision cockpit-brain-project-model): a folder-only project is linked to one.
describe('linking a folder to a brain project', () => {
  let mods: Mods
  const work = mkdtempSync(join(tmpdir(), 'cockpit-link-folders-'))
  const folder = (name: string) => { const dir = join(work, name); mkdirSync(dir, { recursive: true }); return dir }

  beforeAll(async () => {
    const registry = await import('../src/project-registry.js')
    const ledger = await import('../src/session-ledger.js')
    mods = { ProjectRegistry: registry.ProjectRegistry, isCockpitOwnFolder: registry.isCockpitOwnFolder, SessionLedger: ledger.SessionLedger }
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }) })

  it('the brain project takes the folder, the pin and the sessions; the folder-only entry goes', () => {
    const registry = new mods.ProjectRegistry(join(home, 'link-1.json'))
    const ledger = new mods.SessionLedger()
    const dir = folder('customer-success')
    const { project } = registry.create(dir)
    registry.update(project.projectId, { starred: true })
    ledger.recordSpawn('s-1', null, project.projectId, 'claude')
    ledger.recordSpawn('s-other-space', null, project.projectId, 'claude', false, null, 'other')

    const linked = registry.link(project.projectId, 'customer-success', 'Customer success')
    expect(linked).toMatchObject({ projectId: 'bp-customer-success', kind: 'brain', path: dir, starred: true })
    expect(registry.get(project.projectId)).toBeUndefined()
    expect(ledger.reassignProject(project.projectId, linked.projectId, null)).toBe(1)
    expect(ledger.get('s-1')?.projectId).toBe('bp-customer-success')
    // another space's session stays where it is
    expect(ledger.get('s-other-space')?.projectId).toBe(project.projectId)
  })

  it('refuses a brain project that runs in another folder, and the cockpit\'s own folders', () => {
    const registry = new mods.ProjectRegistry(join(home, 'link-2.json'))
    const { project } = registry.create(folder('eml-checkout'))
    registry.ensureBrain('eml', 'EML')
    registry.update('bp-eml', { path: folder('eml-elsewhere') })
    expect(() => registry.link(project.projectId, 'eml', 'EML')).toThrow(expect.objectContaining({ code: 'FOLDER_TAKEN' }))
    expect(registry.get(project.projectId)).toBeDefined()

    const own = join(home, 'brain-hygiene', 'space-1')
    mkdirSync(own, { recursive: true })
    const hygiene = registry.create(own, 'Brain hygiene').project
    expect(mods.isCockpitOwnFolder(hygiene)).toBe(true)
    expect(mods.isCockpitOwnFolder(project)).toBe(false)
    expect(() => registry.link(hygiene.projectId, 'eml', 'EML')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('links onto a brain project already on the same folder: the two entries become one', () => {
    const registry = new mods.ProjectRegistry(join(home, 'link-3.json'))
    const dir = folder('cs-dashboard-tools')
    const { project } = registry.create(dir)
    registry.ensureBrain('cs-dashboard-tools', 'CS Dashboard Tools')
    registry.update('bp-cs-dashboard-tools', { path: dir })
    expect(registry.link(project.projectId, 'cs-dashboard-tools', 'CS Dashboard Tools').path).toBe(dir)
    expect(registry.list().map((p) => p.projectId)).toEqual(['bp-cs-dashboard-tools'])
  })
})
