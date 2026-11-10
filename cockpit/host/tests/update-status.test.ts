import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-update-status-test-'))
process.env.EML_COCKPIT_HOME = home

const reports = join(home, 'data', 'migration-reports')
const migrated = { brainId: 'brain-1', brainName: 'motti', from: 17, to: 18, outcome: 'migrated', at: '2026-10-20T10:00:00.000Z' }
const writeReport = (file: string, report: Record<string, unknown>) => {
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, file), JSON.stringify(report))
}

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
    expect(mods.readUpdateStatus()).toEqual({ brains: {}, updated: null })
  })

  it("names the report's brain by its space, else by the brain's own name", () => {
    writeReport('20261020T100000Z-brain-1.json', migrated)
    expect(mods.readUpdateStatus((id) => (id === 'brain-1' ? 'Main' : undefined)).brains['brain-1'].brain).toBe('Main')
    expect(mods.readUpdateStatus().brains['brain-1'].brain).toBe('motti')
  })

  it('reports an in-app update to the running version without a migration, until dismissed', () => {
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.readUpdateStatus().updated).toEqual({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus('brain-1')).toEqual({ ok: true })
    expect(mods.readUpdateStatus().updated).toBeNull()
  })

  it('ignores a failed update and one to another version than the running one', () => {
    lastResult({ outcome: 'failed', from: '0.0.1', to: mods.ownVersion(), error: 'x' })
    expect(mods.readUpdateStatus().updated).toBeNull()
    lastResult({ outcome: 'updated', from: '0.0.1', to: '0.0.2' })
    expect(mods.readUpdateStatus().updated).toBeNull()
    expect(mods.acknowledgeUpdateStatus('brain-1')).toEqual({ ok: false, reason: 'nothing to dismiss' })
  })

  it("dismisses the space's migration report and the update together", () => {
    writeReport('20261020T100000Z-brain-1.json', migrated)
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus('brain-1')).toEqual({ ok: true })
    expect(mods.readUpdateStatus()).toMatchObject({ brains: { 'brain-1': { acknowledged: true } }, updated: null })
  })

  it("keeps each brain's newest report: every space sees its own brain", () => {
    // one start migrates both brains, the second a few ms later
    writeReport('20261019T100000Z-brain-2.json', { ...migrated, brainId: 'brain-2', from: 16, to: 17 })
    writeReport('20261024T013524158Z-brain-1.json', migrated)
    writeReport('20261024T013524174Z-brain-2.json', { ...migrated, brainId: 'brain-2' })
    const { brains } = mods.readUpdateStatus((id) => ({ 'brain-1': 'Main', 'brain-2': 'Privat' })[id])
    expect(Object.keys(brains).sort()).toEqual(['brain-1', 'brain-2'])
    expect(brains['brain-1']).toMatchObject({ brain: 'Main', report: { file: '20261024T013524158Z-brain-1.json' } })
    expect(brains['brain-2']).toMatchObject({ brain: 'Privat', report: { file: '20261024T013524174Z-brain-2.json', from: 17 } })
  })

  it("a later brain's success does not hide an earlier brain's failure", () => {
    writeReport('20261024T013524158Z-brain-1.json', { ...migrated, outcome: 'restored', error: 'boom' })
    writeReport('20261024T013524174Z-brain-2.json', { ...migrated, brainId: 'brain-2' })
    const { brains } = mods.readUpdateStatus()
    expect(brains['brain-1']).toMatchObject({ resolved: false, report: { outcome: 'restored' } })
    expect(brains['brain-2']).toMatchObject({ resolved: true, report: { outcome: 'migrated' } })
  })

  it("dismissing in one space leaves the other space's report", () => {
    writeReport('20261024T013524158Z-brain-1.json', migrated)
    writeReport('20261024T013524174Z-brain-2.json', { ...migrated, brainId: 'brain-2' })
    expect(mods.acknowledgeUpdateStatus('brain-1')).toEqual({ ok: true })
    expect(mods.readUpdateStatus().brains).toMatchObject({ 'brain-1': { acknowledged: true }, 'brain-2': { acknowledged: false } })
    expect(mods.acknowledgeUpdateStatus('brain-2')).toEqual({ ok: true })
    expect(mods.readUpdateStatus().brains).toMatchObject({ 'brain-1': { acknowledged: true }, 'brain-2': { acknowledged: true } })
  })

  it('reads a dismissal written by an earlier version (a single file name)', () => {
    writeReport('20261024T013524174Z-brain-2.json', { ...migrated, brainId: 'brain-2' })
    writeFileSync(join(home, 'update-status.json'), JSON.stringify({ acknowledged: '20261024T013524174Z-brain-2.json' }))
    expect(mods.readUpdateStatus().brains['brain-2'].acknowledged).toBe(true)
  })

  it('refuses to dismiss a failed migration that is not resolved', () => {
    writeReport('20261020T100000Z-brain-1.json', { ...migrated, outcome: 'restored', error: 'boom' })
    lastResult({ outcome: 'updated', from: '0.0.1', to: mods.ownVersion() })
    expect(mods.acknowledgeUpdateStatus('brain-1')).toEqual({ ok: false, reason: 'the brain update has not succeeded yet' })
    expect(mods.readUpdateStatus().updated).not.toBeNull()
  })
})
