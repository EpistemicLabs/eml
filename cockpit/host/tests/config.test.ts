import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the module.
const home = mkdtempSync(join(tmpdir(), 'cockpit-config-test-'))
process.env.EML_COCKPIT_HOME = home

describe('cockpit config writes', () => {
  let config: typeof import('../src/config.js')

  beforeAll(async () => {
    config = await import('../src/config.js')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('keeps every change when writers run at once', async () => {
    await config.writeCockpitConfig({ token: 't', onboarding: 'pending' })
    // A space rename, the end of onboarding and a new space, all at once: each
    // reads the config and writes it back. Unserialised, the later writes would
    // drop the earlier changes.
    await Promise.all([
      config.updateCockpitConfig((c) => c && { ...c, mainName: 'Work' }),
      config.updateCockpitConfig((c) => c && { ...c, onboarding: 'done' }),
      config.updateCockpitConfig((c) => c && { ...c, spaces: [...(c.spaces ?? []), { token: 'u', name: 'Privat' }] }),
    ])
    expect(await config.readCockpitConfig()).toEqual({
      token: 't',
      onboarding: 'done',
      mainName: 'Work',
      spaces: [{ token: 'u', name: 'Privat' }],
    })
  })

  it('leaves the file as it is when the change returns null', async () => {
    const before = readFileSync(join(home, 'config'), 'utf8')
    expect(await config.updateCockpitConfig(() => null)).toBeNull()
    expect(readFileSync(join(home, 'config'), 'utf8')).toBe(before)
  })

  it('keeps the chain going after a failed change', async () => {
    await expect(config.updateCockpitConfig(() => { throw new Error('boom') })).rejects.toThrow('boom')
    const next = await config.updateCockpitConfig((c) => c && { ...c, mainName: 'Again' })
    expect(next?.mainName).toBe('Again')
  })

  it('writes atomically: no temp file left, the config readable by the owner only', async () => {
    await config.updateCockpitConfig((c) => c && { ...c, mainName: 'Final' })
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(statSync(join(home, 'config')).mode & 0o777).toBe(0o600)
  })
})
