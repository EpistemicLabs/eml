import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, secretsOf } from '../src/domain/plugin-manifest.js'
import { PluginRegistry } from '../src/infrastructure/plugins/plugin-registry.js'
import { OFFICIAL_PLUGINS_DIR } from '../src/paths.js'

// Plugin manifests (domain/plugin-manifest.ts) and where the cockpit finds
// them (infrastructure/plugins/plugin-registry.ts).

const mcp = { transport: 'stdio', command: 'x-mcp', env: { X_KEY: { secret: 'key' }, X_MODE: 'fast' } }

describe('readManifest', () => {
  it('takes a pane-only community plugin and fills the defaults', () => {
    const result = readManifest({ id: 'clock', name: 'Clock', tier: 'community', parts: { pane: { entry: 'index.html' } } }, 'community')
    expect(result).toMatchObject({ ok: true, manifest: { description: '', defaultEnabled: false } })
  })

  it('keeps server parts away from community plugins and channels and panes away from custom ones', () => {
    expect(readManifest({ id: 'x', name: 'X', tier: 'community', parts: { mcp } }, 'community')).toMatchObject({ ok: false })
    expect(readManifest({ id: 'x', name: 'X', tier: 'custom', parts: { channel: { adapter: 'gmail' } } }, 'custom')).toMatchObject({ ok: false })
    expect(readManifest({ id: 'x', name: 'X', tier: 'custom', parts: { mcp } }, 'custom')).toMatchObject({ ok: true })
  })

  it('refuses a plugin claiming another tier than where it was found, or one without parts', () => {
    expect(readManifest({ id: 'x', name: 'X', tier: 'official', parts: { mcp } }, 'custom')).toMatchObject({ ok: false })
    expect(readManifest({ id: 'x', name: 'X', tier: 'official', parts: {} }, 'official')).toMatchObject({ ok: false })
  })

  it('names the secrets an MCP part asks for', () => {
    const result = readManifest({ id: 'x', name: 'X', tier: 'custom', parts: { mcp } }, 'custom')
    if (!result.ok || !result.manifest.parts.mcp) throw new Error('expected a manifest')
    expect(secretsOf(result.manifest.parts.mcp)).toEqual(['key'])
  })
})

describe('PluginRegistry', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cockpit-plugin-registry-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const official = (id: string, manifest: unknown) => {
    mkdirSync(join(dir, 'official', id), { recursive: true })
    writeFileSync(join(dir, 'official', id, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }

  it('leaves out a broken manifest or one whose id differs from its folder, and logs it', async () => {
    official('good', { id: 'good', name: 'Good', tier: 'official', parts: { pane: { builtin: 'good' } } })
    official('broken', '{ not json')
    official('other', { id: 'elsewhere', name: 'E', tier: 'official', parts: { pane: { builtin: 'e' } } })
    official('raised', { id: 'raised', name: 'R', tier: 'community', parts: { pane: { builtin: 'r' } } })
    const lines: string[] = []
    const registry = new PluginRegistry({ officialDir: join(dir, 'official'), customFile: join(dir, 'home', 'custom.json'), log: (line) => lines.push(line) })
    expect((await registry.list()).map((m) => m.id)).toEqual(['good'])
    expect(lines).toHaveLength(3)
  })

  it('serialises additions, so two at once both stay', async () => {
    const registry = new PluginRegistry({ officialDir: join(dir, 'none'), customFile: join(dir, 'home', 'custom.json') })
    const results = await Promise.all(['a', 'b'].map((id) => registry.addCustom({ id, name: id, parts: { mcp } })))
    expect(results.every((r) => r.ok)).toBe(true)
    expect((await registry.custom()).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('reads every official plugin the repository ships', async () => {
    const lines: string[] = []
    const registry = new PluginRegistry({ officialDir: OFFICIAL_PLUGINS_DIR, customFile: join(dir, 'custom.json'), log: (line) => lines.push(line) })
    expect((await registry.list()).map((m) => m.id).sort()).toEqual(['brain', 'gmail', 'note', 'repository', 'shell', 'time', 'worktrees'])
    expect(lines).toEqual([])
  })
})
