import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-update-status-test-'))
process.env.EML_COCKPIT_HOME = home

const reports = join(home, 'data', 'migration-reports')
const migrated = { brainId: 'brain-1', brainName: 'motti', from: 17, to: 18, outcome: 'migrated', at: '2026-10-20T10:00:00.000Z' }

describe('update status (the update banner)', () => {
  let mods: typeof import('../src/update-status.js') & typeof import('../src/app-update.js')
  const lastResult = (patch: Record<string, unknown>) => {
    mkdirSync(join(home, 'app'), { recursive: true })
    writeFileSync(join(home, 'app', 'update.json'), JSON.stringify({ lastResult: { at: '2026-10-21T09:00:00.000Z', ...patch } }))
  }

  beforeAll(async () => {
    mods = { ...(await import('../src/update-status.js')), ...(await import('../src/app-update.js')) }
  })
  beforeEach(() => {
    for (const dir of ['data', 'app', 'update-status.json']) rmSync(join(home, dir), { recursive: true, force: true })
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('shows nothing without a report or an in-app update', () => {
    expect(mods.readUpdateStatus()).toEqual({ report: null, brain: null, acknowledged: false, resolved: false, updated: null })
  })

  it("names the report's brain by its space, else by the brain's own name", () => {
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, '20261020T100000Z-brain-1.json'), JSON.stringify(migrated))
    expect(mods.readUpdateStatus((id) => (id === 'brain-1' ? 'Main' : undefined)).brain).toBe('Main')
    expect(mods.readUpdateStatus().brain).toBe('motti')
  })

  it('reports an in-app update to the running version without a migration, until dismissed', () => {
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.readUpdateStatus().updated).toEqual({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus()).toEqual({ ok: true })
    expect(mods.readUpdateStatus().updated).toBeNull()
  })

  it('ignores a failed update and one to another version than the running one', () => {
    lastResult({ outcome: 'failed', from: '0.0.1', to: mods.ownVersion(), error: 'x' })
    expect(mods.readUpdateStatus().updated).toBeNull()
    lastResult({ outcome: 'updated', from: '0.0.1', to: '0.0.2' })
    expect(mods.readUpdateStatus().updated).toBeNull()
    expect(mods.acknowledgeUpdateStatus()).toEqual({ ok: false, reason: 'nothing to dismiss' })
  })

  it('dismisses the migration report and the update together', () => {
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, '20261020T100000Z-brain-1.json'), JSON.stringify(migrated))
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus()).toEqual({ ok: true })
    expect(mods.readUpdateStatus()).toMatchObject({ acknowledged: true, updated: null })
  })

  it('refuses to dismiss a failed migration that is not resolved', () => {
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, '20261020T100000Z-brain-1.json'), JSON.stringify({ ...migrated, outcome: 'restored', error: 'boom' }))
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus()).toEqual({ ok: false, reason: 'the brain update has not succeeded yet' })
    expect(mods.readUpdateStatus().updated).not.toBeNull()
  })
})
