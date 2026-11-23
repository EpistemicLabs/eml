import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the module.
// A token file keeps the updater from asking `gh` for one.
const home = mkdtempSync(join(tmpdir(), 'cockpit-update-channel-test-'))
process.env.EML_COCKPIT_HOME = home
writeFileSync(join(home, 'github-token'), 'github_pat_test\n')

const stateFile = join(home, 'app', 'update.json')
const release = (version: string, extra: Record<string, unknown> = {}) =>
  ({ tag_name: `v${version}`, html_url: `https://example.test/v${version}`, published_at: null, assets: [], body: `### What's new\n- in ${version}\n`, ...extra })

describe('update channels', () => {
  let mod: typeof import('../src/app-update.js')
  beforeAll(async () => { mod = await import('../src/app-update.js') })
  beforeEach(() => rmSync(join(home, 'app'), { recursive: true, force: true }))
  afterEach(() => vi.unstubAllGlobals())
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const stubReleases = (list: unknown[], latest?: unknown) => {
    const fetch = vi.fn(async (url: string) => {
      const { pathname } = new URL(url)
      if (pathname.endsWith('/releases/latest')) return new Response(JSON.stringify(latest))
      return new Response(JSON.stringify(list))
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('is on the stable channel until the user picks another', () => {
    expect(mod.readAppUpdateStatus().channel).toBe('stable')
  })

  it('stores the channel in the update state and forgets the release the other channel found', () => {
    mkdirSync(join(home, 'app'), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ latest: { version: '0.21.5', url: 'u', publishedAt: null }, skipVersion: '0.21.4' }))
    expect(mod.setUpdateChannel('alpha')).toBeNull()
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ channel: 'alpha', latest: null, skipVersion: '0.21.4' })
    expect(mod.readAppUpdateStatus()).toMatchObject({ channel: 'alpha', latest: null })
    expect(mod.setUpdateChannel('stable')).toBeNull()
    expect(mod.readAppUpdateStatus().channel).toBe('stable')
  })

  it('refuses a channel it does not know and keeps the current one', () => {
    expect(mod.setUpdateChannel('next')).toMatch(/stable or alpha/)
    expect(mod.setUpdateChannel(undefined)).toMatch(/stable or alpha/)
    expect(mod.readAppUpdateStatus().channel).toBe('stable')
  })

  it('stable asks for the latest release only, so a pre-release never counts', async () => {
    const fetch = stubReleases([release('0.22.0-alpha.2', { prerelease: true })], release('0.21.5'))
    expect((await mod.findLatestRelease('stable', null)).version).toBe('0.21.5')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/releases\/latest$/)
  })

  it('alpha takes the highest release, pre-releases included, drafts and other tags left out', async () => {
    stubReleases([
      release('0.22.0-alpha.11', { draft: true, prerelease: true }),
      release('0.22.0-alpha.3', { prerelease: true }),
      release('0.22.0-alpha.10', { prerelease: true }),
      { ...release('x'), tag_name: 'bench-baseline' },
      release('0.21.5'),
    ])
    expect((await mod.findLatestRelease('alpha', null)).version).toBe('0.22.0-alpha.10')
  })

  it('alpha moves on to a stable release once it is the highest', async () => {
    stubReleases([release('0.22.0'), release('0.22.0-alpha.10', { prerelease: true })])
    expect((await mod.findLatestRelease('alpha', null)).version).toBe('0.22.0')
  })

  it('alpha says so when there is no release at all', async () => {
    stubReleases([release('0.22.0-alpha.1', { draft: true })])
    await expect(mod.findLatestRelease('alpha', null)).rejects.toThrow(/No release found/)
  })

  it('on alpha, the notes after an update include the pre-releases it went through', async () => {
    mod.setUpdateChannel('alpha')
    stubReleases([
      release('0.22.0-alpha.3', { prerelease: true }),
      release('0.22.0-alpha.2', { prerelease: true }),
      release('0.22.0-alpha.1', { prerelease: true }),
    ])
    expect((await mod.releaseNotesBetween('0.22.0-alpha.1', '0.22.0-alpha.3')).map((n) => n.version)).toEqual(['0.22.0-alpha.3', '0.22.0-alpha.2'])
  })

  it('on stable, the notes leave the pre-releases out', async () => {
    stubReleases([release('0.22.0'), release('0.22.0-alpha.2', { prerelease: true }), release('0.21.5')])
    expect((await mod.releaseNotesBetween('0.21.5', '0.22.0')).map((n) => n.version)).toEqual(['0.22.0'])
  })
})
