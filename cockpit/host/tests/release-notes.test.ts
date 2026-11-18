import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the module.
// A token file keeps the updater from asking `gh` for one.
const home = mkdtempSync(join(tmpdir(), 'cockpit-release-notes-test-'))
process.env.EML_COCKPIT_HOME = home
writeFileSync(join(home, 'github-token'), 'github_pat_test\n')

const body = (...bullets: string[]) =>
  ['## EML vX', '', 'Intro.', '', "### What's new", '', ...bullets.map((b) => `- ${b}`), '', '### Details', '', '- not a highlight'].join('\n')

const release = (version: string, extra: Record<string, unknown> = {}) =>
  ({ tag_name: `v${version}`, html_url: `https://example.test/v${version}`, assets: [], body: body(`in ${version}`), ...extra })

describe('release notes after an update', () => {
  let mod: typeof import('../src/app-update.js')
  beforeAll(async () => { mod = await import('../src/app-update.js') })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it("takes the bullets of the What's new section as plain text", () => {
    expect(mod.extractReleaseHighlights(body('**Plugins.** See [the docs](https://x.test).', '`code` and _emphasis_'))).toEqual([
      'Plugins. See the docs.',
      'code and emphasis',
    ])
  })

  it('keeps underscores and stars inside words', () => {
    expect(mod.extractReleaseHighlights(body('QWEN_HOME and snake_case, 2 * 3, ~/.cache, __bold__ and ~~gone~~'))).toEqual([
      'QWEN_HOME and snake_case, 2 * 3, ~/.cache, bold and gone',
    ])
  })

  it('accepts a typographic apostrophe and finds nothing without the section', () => {
    expect(mod.extractReleaseHighlights('### What’s new\n* one\n')).toEqual(['one'])
    expect(mod.extractReleaseHighlights('### Cockpit\n- one\n')).toEqual([])
  })

  it('lists the stable releases after from up to to, newest first, and stops paging at from', async () => {
    const pages = [
      [release('0.22.0'), release('0.21.6', { draft: true }), release('0.21.5'), release('0.21.5-rc.1', { prerelease: true })],
      [release('0.21.4', { body: 'no section' }), release('0.21.3')],
      [release('0.21.2')],
    ]
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'))
      return new Response(JSON.stringify(pages[page - 1]), { headers: { link: '<next>; rel="next"' } })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await mod.releaseNotesBetween('0.21.3', '0.21.5')).toEqual([
      { version: '0.21.5', url: 'https://example.test/v0.21.5', highlights: ['in 0.21.5'] },
      { version: '0.21.4', url: 'https://example.test/v0.21.4', highlights: [] },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refuses a range that is not two versions', async () => {
    await expect(mod.releaseNotesBetween('', '0.21.5')).rejects.toThrow('X.Y.Z')
  })
})
