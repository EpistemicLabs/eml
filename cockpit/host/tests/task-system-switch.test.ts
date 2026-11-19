import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-system-test-'))
process.env.EML_COCKPIT_HOME = home

describe('task system switch', () => {
  let mods: {
    writeCockpitConfig: typeof import('../src/config.js')['writeCockpitConfig']
    readCockpitConfig: typeof import('../src/config.js')['readCockpitConfig']
    taskSystemOn: typeof import('../src/brain-space.js')['taskSystemOn']
  }

  beforeAll(async () => {
    const config = await import('../src/config.js')
    const space = await import('../src/brain-space.js')
    mods = { writeCockpitConfig: config.writeCockpitConfig, readCockpitConfig: config.readCockpitConfig, taskSystemOn: space.taskSystemOn }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('reads the switch for the main space and per extra space, and only a literal true', async () => {
    await mods.writeCockpitConfig({
      token: 'eml_main_token',
      mainTaskSystem: true,
      spaces: [
        { token: 'eml_on_token', taskSystem: true },
        { token: 'eml_odd_token', taskSystem: 'yes' as unknown as true },
        { token: 'eml_off_token' },
      ],
    })
    const config = await mods.readCockpitConfig()
    expect(config?.mainTaskSystem).toBe(true)
    expect(config?.spaces?.map((s) => s.taskSystem)).toEqual([true, undefined, undefined])
  })

  it('leaves it off when the config does not name it', async () => {
    await mods.writeCockpitConfig({ token: 'eml_main_token' })
    expect((await mods.readCockpitConfig())?.mainTaskSystem).toBeUndefined()
  })

  it('runs only in a local brain the server confirmed', () => {
    const space = (taskSystem: boolean, shared: boolean | null) => ({ taskSystem, shared }) as Parameters<typeof mods.taskSystemOn>[0]
    expect(mods.taskSystemOn(space(true, false))).toBe(true)
    expect(mods.taskSystemOn(space(true, true))).toBe(false)
    expect(mods.taskSystemOn(space(true, null))).toBe(false)
    expect(mods.taskSystemOn(space(false, false))).toBe(false)
  })
})
