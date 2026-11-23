import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { writeOwnerOnly, WriteQueue } from './owner-only-file.js'
import { readManifest, type ManifestResult, type PluginManifest } from '../../domain/plugin-manifest.js'

export interface PluginRegistryOptions {
  /** plugins/<id>/plugin.json, shipped with the cockpit. */
  officialDir: string
  /** The user's custom MCP plugins, owner-only. */
  customFile: string
  log?: (line: string) => void
}

/**
 * The plugins this cockpit knows: the official ones, read once from the
 * folder that ships with it, and the user's own custom MCP servers from the
 * cockpit home. A manifest that doesn't hold is left out and logged, so one
 * broken file doesn't take the others with it.
 */
export class PluginRegistry {
  private officialCache: PluginManifest[] | null = null
  private readonly writes = new WriteQueue()

  constructor(private readonly options: PluginRegistryOptions) {}

  official(): PluginManifest[] {
    this.officialCache ??= this.readOfficial()
    return this.officialCache
  }

  async custom(): Promise<PluginManifest[]> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(this.options.customFile, 'utf8'))
    } catch {
      return []
    }
    const entries = Array.isArray((raw as { plugins?: unknown })?.plugins) ? (raw as { plugins: unknown[] }).plugins : []
    const officialIds = new Set(this.official().map((manifest) => manifest.id))
    return entries.flatMap((entry) => {
      const result = readManifest(entry, 'custom')
      if (!result.ok) {
        this.options.log?.(`[plugins] a custom plugin is left out: ${result.reason}`)
        return []
      }
      return officialIds.has(result.manifest.id) ? [] : [result.manifest]
    })
  }

  /** Official plugins first, in folder order, then the custom ones in the order they were added. */
  async list(): Promise<PluginManifest[]> {
    return [...this.official(), ...(await this.custom())]
  }

  async get(id: string): Promise<PluginManifest | null> {
    return (await this.list()).find((manifest) => manifest.id === id) ?? null
  }

  /** Adds a custom MCP plugin; its id must be new. */
  addCustom(input: unknown): Promise<ManifestResult> {
    return this.writes.run(async () => {
      const result = readManifest({ ...(input as object), tier: 'custom' }, 'custom')
      if (!result.ok) return result
      if ((await this.get(result.manifest.id)) !== null) return { ok: false, reason: `a plugin with the id ${result.manifest.id} exists` }
      await this.writeCustom([...(await this.custom()), result.manifest])
      return result
    })
  }

  /** Sets how a custom plugin signs in (the first OAuth sign-in to its server); false when there is none. */
  setCustomAuth(id: string, auth: NonNullable<PluginManifest['auth']>): Promise<boolean> {
    return this.writes.run(async () => {
      const current = await this.custom()
      if (!current.some((manifest) => manifest.id === id)) return false
      await this.writeCustom(current.map((manifest) => (manifest.id === id ? { ...manifest, auth } : manifest)))
      return true
    })
  }

  /** Removes a custom plugin; false when there is none with that id. */
  removeCustom(id: string): Promise<boolean> {
    return this.writes.run(async () => {
      const current = await this.custom()
      const rest = current.filter((manifest) => manifest.id !== id)
      if (rest.length === current.length) return false
      await this.writeCustom(rest)
      return true
    })
  }

  private readOfficial(): PluginManifest[] {
    const dir = this.options.officialDir
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'plugin.json')))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(path.join(dir, entry.name, 'plugin.json'), 'utf8'))
        } catch {
          this.options.log?.(`[plugins] ${entry.name}/plugin.json is no JSON`)
          return []
        }
        const result = readManifest(raw, 'official')
        if (!result.ok || result.manifest.id !== entry.name) {
          this.options.log?.(`[plugins] ${entry.name}/plugin.json is left out: ${result.ok ? 'its id differs from its folder' : result.reason}`)
          return []
        }
        return [result.manifest]
      })
  }

  /** Owner-only: custom servers may carry tokens in their settings. */
  private writeCustom(plugins: PluginManifest[]): Promise<void> {
    return writeOwnerOnly(this.options.customFile, `${JSON.stringify({ plugins }, null, 2)}\n`)
  }
}
