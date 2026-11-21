import type { PluginManifest } from '../domain/plugin-manifest.js'
import {
  connectionsIn,
  deniedFor,
  isOn,
  mcpServersFor,
  setOutsideServer,
  setPlugin,
  type Connection,
  type McpServerConfig,
  type SpacePlugins,
} from '../domain/space-plugins.js'
import { importMcpServers, type ImportResult, type ImportSource, type ImportSpace } from '../infrastructure/plugins/mcp-import.js'
import type { PluginRegistry } from '../infrastructure/plugins/plugin-registry.js'
import type { PluginStore } from '../infrastructure/plugins/plugin-store.js'

/** What a space's session files carry from its plugins (isolation.ts writeSpaceFiles). */
export interface SpacePluginFiles {
  /** Server name → config, next to the brain in the space's mcp.json. */
  mcpServers: Record<string, McpServerConfig>
  /** claude.ai connectors and Claude Code plugin servers its sessions must not load. */
  denied: string[]
  /** Plugins left out of mcp.json, and why. */
  problems: string[]
}

/** The plugins as they stand, read once: what each space's files get. */
export interface PluginSnapshot {
  manifests: PluginManifest[]
  state: SpacePlugins
  filesFor(spaceId: string): SpacePluginFiles
}

const CARRY_STEP = 'carry:switches'

/**
 * The plugins per space: the switches, the user's connections, and the session files
 * that follow from them. A change rewrites the space's files at once (`rewrite`), so its next session
 * starts with it; a session already running keeps what it started with.
 */
export class SpacePluginService {
  /** Rewrites one space's session files; false when no such space is open. Set once the spaces are. */
  private rewrite: (spaceId: string, files: SpacePluginFiles) => boolean = () => false

  constructor(
    private readonly registry: PluginRegistry,
    private readonly store: PluginStore,
    /** What a manifest's ${NAME} placeholders stand for: the node binary, the cockpit's bundles. */
    private readonly vars: Record<string, string> = {},
  ) {}

  onRewrite(rewrite: (spaceId: string, files: SpacePluginFiles) => boolean): void {
    this.rewrite = rewrite
  }

  /**
   * Once per home, before the spaces open: the cockpit-wide switches an older cockpit kept carry over to every
   * space, then the MCP servers configured outside the plugins are imported (mcp-import.ts).
   */
  async setup(spaces: ImportSpace[], legacy: Record<string, boolean>, source: ImportSource, backupsDir: string): Promise<ImportResult> {
    const state = await this.store.spaces()
    if (!state.done.includes(CARRY_STEP)) {
      const manifests = await this.registry.list()
      await this.store.updateSpaces((current) => {
        let next = current
        for (const manifest of manifests) {
          if (!(legacy[manifest.id] ?? manifest.defaultEnabled) || manifest.auth) continue
          for (const space of spaces) next = setPlugin(next, space.id, manifest.id, { connections: [] })
        }
        return { ...next, done: [...next.done, CARRY_STEP] }
      })
    }
    return importMcpServers(source, spaces, { registry: this.registry, store: this.store, backupsDir })
  }

  async snapshot(): Promise<PluginSnapshot> {
    const [manifests, state, connections] = await Promise.all([this.registry.list(), this.store.spaces(), this.store.connections()])
    return {
      manifests,
      state,
      filesFor: (spaceId) => {
        const { servers, problems } = mcpServersFor(spaceId, state, manifests, connections, this.vars)
        return { mcpServers: servers, problems, denied: deniedFor(spaceId, state) }
      },
    }
  }

  /** Whether a plugin is on in a space, and the part with it. */
  async enabled(spaceId: string, pluginId: string): Promise<boolean> {
    return isOn(await this.store.spaces(), spaceId, pluginId)
  }

  /**
   * Switch a plugin on (with the user's sign-ins it uses there) or off in a space. Switched on
   * without naming any, it keeps the ones it has there, else takes the plugin's only one.
   */
  async setPlugin(spaceId: string, pluginId: string, on: boolean, picked?: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const manifest = await this.registry.get(pluginId)
    if (!manifest) return { ok: false, reason: 'no such plugin' }
    const own = (await this.store.connections()).filter((c) => c.plugin === pluginId)
    if (on && picked?.some((id) => !own.some((c) => c.id === id))) return { ok: false, reason: 'no such connection for this plugin' }
    await this.store.updateSpaces((state) => {
      if (!on) return setPlugin(state, spaceId, pluginId, null)
      const current = connectionsIn(state, spaceId, pluginId)
      const connections = picked ?? (current.length > 0 ? current : own.length === 1 ? [own[0].id] : [])
      return setPlugin(state, spaceId, pluginId, { connections })
    })
    await this.refresh(spaceId)
    return { ok: true }
  }

  /** Switch a claude.ai connector or Claude Code plugin server on or off in a space. */
  async setOutside(spaceId: string, serverName: string, on: boolean): Promise<void> {
    await this.store.updateSpaces((state) => setOutsideServer(state, spaceId, serverName, on))
    await this.refresh(spaceId)
  }

  /** Switch one part of a plugin on or off for every space. */
  async setPart(pluginId: string, part: 'pane' | 'mcp' | 'channel', on: boolean): Promise<void> {
    await this.store.updateSpaces((state) => {
      const off = new Set(state.partsOff[pluginId] ?? [])
      if (on) off.delete(part)
      else off.add(part)
      return { ...state, partsOff: { ...state.partsOff, [pluginId]: [...off] } }
    })
    await this.refreshAll()
  }

  /** A new space starts with the panes of the main space, and no server: those it gets switched on. */
  async adoptSpace(spaceId: string, like: string): Promise<void> {
    const manifests = await this.registry.list()
    await this.store.updateSpaces((state) => manifests
      .filter((m) => m.parts.pane && !m.parts.mcp && !m.parts.channel && isOn(state, like, m.id))
      .reduce((next, m) => setPlugin(next, spaceId, m.id, { connections: [] }), state))
  }

  async connections(): Promise<Connection[]> {
    return this.store.connections()
  }

  async saveConnection(connection: Connection): Promise<void> {
    await this.store.updateConnections((all) => [...all.filter((c) => c.id !== connection.id), connection])
    await this.refreshAll()
  }

  /** Removes a connection; the spaces that used it keep the plugin on with the sign-ins left. */
  async removeConnection(id: string): Promise<boolean> {
    let removed = false
    await this.store.updateConnections((all) => {
      removed = all.some((c) => c.id === id)
      return all.filter((c) => c.id !== id)
    })
    if (removed) {
      await this.store.updateSpaces((state) => ({
        ...state,
        spaces: Object.fromEntries(Object.entries(state.spaces).map(([spaceId, space]) => [spaceId, {
          ...space,
          plugins: Object.fromEntries(Object.entries(space.plugins).map(([pluginId, on]) => [pluginId, { connections: on.connections.filter((c) => c !== id) }])),
        }])),
      }))
      await this.refreshAll()
    }
    return removed
  }

  /** A removed plugin leaves every space. */
  async forget(pluginId: string): Promise<void> {
    await this.store.updateSpaces((state) => Object.keys(state.spaces).reduce((next, spaceId) => setPlugin(next, spaceId, pluginId, null), state))
    await this.store.updateConnections((all) => all.filter((c) => c.plugin !== pluginId))
    await this.refreshAll()
  }

  private async refresh(spaceId: string): Promise<void> {
    const snapshot = await this.snapshot()
    this.rewrite(spaceId, snapshot.filesFor(spaceId))
  }

  private async refreshAll(): Promise<void> {
    const snapshot = await this.snapshot()
    for (const spaceId of Object.keys(snapshot.state.spaces)) this.rewrite(spaceId, snapshot.filesFor(spaceId))
  }
}
