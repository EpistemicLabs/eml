import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-space-color-test-'))
process.env.EML_COCKPIT_HOME = home

describe('space colours', () => {
  let mods: {
    space: typeof import('../src/brain-space.js')
    color: typeof import('../src/domain/space-color.js')
    config: typeof import('../src/config.js')
    isolation: ReturnType<typeof import('../src/infrastructure/providers/claude/isolation.js')['writeIsolationFiles']>
    configFile: string
  }

  beforeAll(async () => {
    const isolation = await import('../src/infrastructure/providers/claude/isolation.js')
    const paths = await import('../src/paths.js')
    mods = {
      space: await import('../src/brain-space.js'),
      color: await import('../src/domain/space-color.js'),
      config: await import('../src/config.js'),
      isolation: isolation.writeIsolationFiles('http://127.0.0.1:4318/api/hook', 'hooktoken0123456789'),
      configFile: paths.CONFIG_FILE,
    }
  })

  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const open = (id: string, main: boolean, token: string, color?: 'violet') => mods.space.openBrainSpace({
    id, name: id, brainName: id, main, url: 'http://127.0.0.1:60000', token, color,
    turnHookConfig: mods.isolation.turnHookConfig,
  })

  it('takes the first free colour, and the least used once all are taken', () => {
    const { SPACE_COLORS, nextSpaceColor } = mods.color
    expect(nextSpaceColor(['coral'])).toBe('amber')
    expect(nextSpaceColor(['coral', 'amber', null])).toBe('green')
    expect(nextSpaceColor([...SPACE_COLORS, 'coral'])).toBe('amber')
  })

  it('accepts only the palette\'s names', () => {
    expect(mods.color.isSpaceColor('violet')).toBe(true)
    expect(mods.color.isSpaceColor('#ff0000')).toBe(false)
    expect(mods.color.isSpaceColor(undefined)).toBe(false)
  })

  it('gives main coral and a space without a colour the next free, and keeps a stored one', () => {
    const spaces = new mods.space.BrainSpaces(open('a0000000-0000-4000-8000-000000000001', true, 'eml_a_secret'))
    const stored = open('a0000000-0000-4000-8000-000000000002', false, 'eml_b_secret', 'violet')
    const fresh = open('a0000000-0000-4000-8000-000000000003', false, 'eml_c_secret')
    spaces.add(stored)
    spaces.add(fresh)
    expect(spaces.list().map((space) => space.color)).toEqual(['coral', 'violet', 'amber'])
    expect(mods.space.spaceView(fresh).color).toBe('amber')
  })

  it('stores a colour per space and drops one that is not in the palette', async () => {
    writeFileSync(mods.configFile, JSON.stringify({
      token: 'eml_a_secret',
      spaces: [{ token: 'eml_b_secret' }, { token: 'eml_c_secret', color: 'hotpink' }],
    }))
    const main = open('a0000000-0000-4000-8000-000000000001', true, 'eml_a_secret')
    const other = open('a0000000-0000-4000-8000-000000000002', false, 'eml_b_secret')
    const spaces = new mods.space.BrainSpaces(main)
    spaces.add(other)
    await spaces.setColor(other, 'pink')
    await spaces.setColor(main, 'blue')
    const config = await mods.config.readCockpitConfig()
    expect(config?.mainColor).toBe('blue')
    expect(config?.spaces).toEqual([{ token: 'eml_b_secret', color: 'pink' }, { token: 'eml_c_secret' }])
    expect(other.color).toBe('pink')
  })
})
