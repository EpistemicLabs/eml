import { z } from 'zod'
import { serverNameOf, type ConfigValue, type PluginManifest, type PluginPartKind } from './plugin-manifest.js'

/**
 * Which plugins each space has (plan cockpit-plugins-mcp-channels-plan, item 4). A plugin is all or
 * nothing per space: switched on, the space gets every part of it that is on for the cockpit. A
 * plugin with a sign-in uses one of the user's connections in each space where it is on.
 *
 * The claude.ai connectors and Claude Code's own plugin servers are not cockpit plugins: they load
 * in every space whose agent shares the cockpit's Claude config, unless switched off there by name
 * (written as deniedMcpServers into the space's settings.json).
 */

export const PART_KINDS = ['pane', 'mcp', 'channel'] as const

export const spacePluginsSchema = z.object({
  version: z.literal(1),
  spaces: z.record(z.string(), z.object({
    /** pluginId → the connection it uses here; null for a plugin without a sign-in. */
    plugins: z.record(z.string(), z.object({ connection: z.string().nullable() })).default({}),
    /** claude.ai connectors and Claude Code plugin servers switched off here, by server name. */
    off: z.array(z.string()).default([]),
  })).default({}),
  /** pluginId → its parts switched off for the whole cockpit. */
  partsOff: z.record(z.string(), z.array(z.enum(PART_KINDS))).default({}),
  /** One-time steps already taken (the switches carried over, the imports), so none runs twice. */
  done: z.array(z.string()).default([]),
  /** The plugins the one-time import made, and whether the user has seen the notice about them. */
  imported: z.array(z.string()).default([]),
  importNoticeDone: z.boolean().default(false),
})
export type SpacePlugins = z.infer<typeof spacePluginsSchema>

export const emptySpacePlugins = (): SpacePlugins => ({ version: 1, spaces: {}, partsOff: {}, done: [], imported: [], importNoticeDone: false })

/** A sign-in or a set of secrets the user keeps once, for every space that picks it. */
export const connectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  plugin: z.string(),
  /** What the user recognises it by ("work mailbox"); never a secret. */
  label: z.string().max(80),
  /** Secret name → value; owner-only on disk, never sent to the page. */
  values: z.record(z.string(), z.string()).default({}),
})
export type Connection = z.infer<typeof connectionSchema>

export function isOn(state: SpacePlugins, spaceId: string, pluginId: string): boolean {
  return state.spaces[spaceId]?.plugins[pluginId] !== undefined
}

export function partOn(state: SpacePlugins, pluginId: string, part: PluginPartKind): boolean {
  return !(state.partsOff[pluginId] ?? []).includes(part)
}

/** The spaces a plugin is on in. */
export function spacesOf(state: SpacePlugins, pluginId: string): string[] {
  return Object.entries(state.spaces).filter(([, space]) => space.plugins[pluginId] !== undefined).map(([id]) => id)
}

/** Switch a plugin on (with its connection) or off in a space. Pure: returns the new state. */
export function setPlugin(state: SpacePlugins, spaceId: string, pluginId: string, on: { connection: string | null } | null): SpacePlugins {
  const space = state.spaces[spaceId] ?? { plugins: {}, off: [] }
  const plugins = { ...space.plugins }
  if (on) plugins[pluginId] = { connection: on.connection }
  else delete plugins[pluginId]
  return { ...state, spaces: { ...state.spaces, [spaceId]: { ...space, plugins } } }
}

/** Switch a claude.ai connector or Claude Code plugin server on or off in a space. */
export function setOutsideServer(state: SpacePlugins, spaceId: string, serverName: string, on: boolean): SpacePlugins {
  const space = state.spaces[spaceId] ?? { plugins: {}, off: [] }
  const off = on ? space.off.filter((name) => name !== serverName) : [...new Set([...space.off, serverName])]
  return { ...state, spaces: { ...state.spaces, [spaceId]: { ...space, off } } }
}

/** An MCP server as Claude Code's mcp.json writes it. */
export type McpServerConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> }

export interface ResolvedServers {
  /** Server name → config, for the space's mcp.json. */
  servers: Record<string, McpServerConfig>
  /** Plugins left out, and why (a missing connection or secret); no value is ever part of it. */
  problems: string[]
}

/**
 * The MCP servers of the plugins on in a space, with their secrets filled in from the connection
 * each uses there. A plugin whose secret can't be filled is left out rather than started half set up.
 */
export function mcpServersFor(
  spaceId: string,
  state: SpacePlugins,
  manifests: PluginManifest[],
  connections: Connection[],
): ResolvedServers {
  const servers: Record<string, McpServerConfig> = {}
  const problems: string[] = []
  for (const manifest of manifests) {
    const part = manifest.parts.mcp
    const name = serverNameOf(manifest)
    if (!part || !name || !isOn(state, spaceId, manifest.id) || !partOn(state, manifest.id, 'mcp')) continue
    const connectionId = state.spaces[spaceId]?.plugins[manifest.id]?.connection ?? null
    const connection = connectionId ? connections.find((c) => c.id === connectionId && c.plugin === manifest.id) ?? null : null
    const missing: string[] = []
    const fill = (value: ConfigValue): string => {
      if (typeof value === 'string') return value
      const filled = connection?.values[value.secret]
      if (filled === undefined) missing.push(value.secret)
      return filled ?? ''
    }
    const config: McpServerConfig = part.transport === 'stdio'
      ? { type: 'stdio', command: part.command, args: part.args.map(fill), env: mapValues(part.env, fill) }
      : { type: part.transport, url: fill(part.url), headers: mapValues(part.headers, fill) }
    if (missing.length > 0) {
      problems.push(`${manifest.name}: ${connection ? `its connection lacks ${missing.join(', ')}` : 'no connection picked for this space'}`)
      continue
    }
    servers[name] = config
  }
  return { servers, problems }
}

/** The claude.ai connectors and Claude Code plugin servers a space's sessions must not load. */
export function deniedFor(spaceId: string, state: SpacePlugins): string[] {
  return [...(state.spaces[spaceId]?.off ?? [])].sort()
}

function mapValues(record: Record<string, ConfigValue>, fill: (value: ConfigValue) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]))
}

/** One entry of the channel bridge's accounts file: its type, id, spaces and the adapter's settings. */
export type BridgeAccount = { type: string; accountId: string; spaces: string[] } & Record<string, unknown>

/**
 * The channel bridge's accounts (plan item 5, no home space): one per connection of a plugin with
 * a channel part, on in every space that picked that connection. The connection's id is the
 * account's id, so the bridge's cursors and threads carry on; its values are the adapter's
 * settings. A space the bridge has no token for (a shared space) is left out of the list.
 */
export function bridgeAccountsFor(
  state: SpacePlugins,
  manifests: PluginManifest[],
  connections: Connection[],
  tokenSpaces: string[],
): { accounts: BridgeAccount[]; problems: string[] } {
  const accounts: BridgeAccount[] = []
  const problems: string[] = []
  for (const manifest of manifests) {
    const channel = manifest.parts.channel
    if (!channel || !partOn(state, manifest.id, 'channel')) continue
    const bySpace = Object.entries(state.spaces).flatMap(([spaceId, space]) => {
      const on = space.plugins[manifest.id]
      return on ? [{ spaceId, connection: on.connection }] : []
    })
    for (const { spaceId, connection } of bySpace) {
      if (connection === null) problems.push(`${manifest.name}: on in space ${spaceId} without a connection`)
      else if (!tokenSpaces.includes(spaceId)) problems.push(`${manifest.name}: space ${spaceId} takes no channel messages (no job token)`)
    }
    for (const connection of connections.filter((c) => c.plugin === manifest.id)) {
      const spaces = bySpace.filter((on) => on.connection === connection.id && tokenSpaces.includes(on.spaceId)).map((on) => on.spaceId)
      if (spaces.length === 0) continue
      accounts.push({ ...connection.values, type: channel.adapter, accountId: connection.id, spaces: spaces.sort() })
    }
  }
  return { accounts, problems }
}
