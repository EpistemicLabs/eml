import { z } from 'zod'
import { secretsOf, serverNameOf, type ConfigValue, type McpPart, type PluginManifest, type PluginPartKind } from './plugin-manifest.js'

/**
 * Which plugins each space has. A plugin is all or
 * nothing per space: switched on, the space gets every part of it that is on for the cockpit. A
 * plugin with a sign-in uses one or more of the user's connections in each space where it is on
 * (decision plugin-several-sign-ins-per-space: two mailboxes in one space).
 *
 * The claude.ai connectors and Claude Code's own plugin servers are not cockpit plugins: they load
 * in every space whose agent shares the cockpit's Claude config, unless switched off there by name
 * (written as deniedMcpServers into the space's settings.json).
 */

export const PART_KINDS = ['pane', 'mcp', 'channel'] as const

/**
 * A plugin on in a space: the user's sign-ins it uses there (none for a plugin without one). A file
 * written before several sign-ins per space names a single `connection`; it still reads.
 */
const pluginInSpaceSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || 'connections' in raw || !('connection' in raw)) return raw
    const single = (raw as { connection: unknown }).connection
    return { connections: typeof single === 'string' ? [single] : [] }
  },
  z.object({ connections: z.array(z.string()).default([]) }),
)

export const spacePluginsSchema = z.object({
  version: z.literal(1),
  spaces: z.record(z.string(), z.object({
    /** pluginId → the sign-ins it uses here. */
    plugins: z.record(z.string(), pluginInSpaceSchema).default({}),
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
  /** The channel bridge's account id, where it differs from the connection's (an account named before the plugins). */
  accountId: z.string().min(1).optional(),
  /** Names its MCP server next to the plugin's own (gmail-invoice); the plugin's name when left out. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/).optional(),
  /** Secret name → value; owner-only on disk, never sent to the page. */
  values: z.record(z.string(), z.string()).default({}),
  /** The server refused to renew this sign-in: the user signs in again. */
  signInNeeded: z.boolean().optional(),
  /** The parts this sign-in serves (a service account for the mcp part only); every part when left out. */
  parts: z.array(z.enum(['pane', 'mcp', 'channel'])).optional(),
})

/** Whether a connection serves a plugin's part. */
export const serves = (connection: Connection, part: PluginPartKind): boolean => connection.parts?.includes(part) ?? true
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

/** The sign-ins a plugin uses in a space; none when it is off there. */
export function connectionsIn(state: SpacePlugins, spaceId: string, pluginId: string): string[] {
  return state.spaces[spaceId]?.plugins[pluginId]?.connections ?? []
}

/** Switch a plugin on (with the sign-ins it uses) or off in a space. Pure: returns the new state. */
export function setPlugin(state: SpacePlugins, spaceId: string, pluginId: string, on: { connections: string[] } | null): SpacePlugins {
  const space = state.spaces[spaceId] ?? { plugins: {}, off: [] }
  const plugins = { ...space.plugins }
  if (on) plugins[pluginId] = { connections: [...new Set(on.connections)] }
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
  /** Placeholders a manifest may use in its command and arguments (${NODE}, ${COCKPIT_DIST}). */
  vars: Record<string, string> = {},
  /** The relay key of a shared server's sign-in (infrastructure/plugins/shared-mcp.ts); without it, shared parts run per session. */
  sharedKey?: (connectionId: string) => string,
): ResolvedServers {
  const servers: Record<string, McpServerConfig> = {}
  /** Which plugin a server name belongs to: an official plugin, listed first, keeps its names. */
  const owner = new Map<string, string>()
  const problems: string[] = []
  const expand = (text: string) => text.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => vars[name] ?? whole)
  for (const manifest of manifests) {
    const part = manifest.parts.mcp
    const base = serverNameOf(manifest)
    if (!part || !base || !isOn(state, spaceId, manifest.id) || !partOn(state, manifest.id, 'mcp')) continue
    const picked = connectionsIn(state, spaceId, manifest.id)
    // A remote server the cockpit signs in to: each sign-in the space picked through the relay, which
    // adds the token. Without one, the session reaches the server itself and Claude signs in there.
    if (manifest.auth?.kind === 'mcp-oauth' && part.transport !== 'stdio' && vars.RELAY && picked.length > 0) {
      for (const id of picked) {
        const connection = connections.find((c) => c.id === id && c.plugin === manifest.id)
        if (!connection?.values.relayKey) {
          problems.push(`${manifest.name}: a sign-in it should use here is gone`)
          continue
        }
        const wanted = connection.slug ? `${base}-${connection.slug}` : base
        if (owner.has(wanted) && owner.get(wanted) !== manifest.id) {
          problems.push(`${manifest.name}: left out, ${owner.get(wanted)} serves ${wanted} here`)
          continue
        }
        let name = wanted
        for (let n = 2; name in servers; n++) name = `${wanted}-${n}`
        servers[name] = { type: 'http', url: `${vars.RELAY}/${connection.id}`, headers: { 'x-eml-relay-key': connection.values.relayKey } }
        owner.set(name, manifest.id)
      }
      continue
    }
    // A server without secrets runs once; one with secrets once per sign-in the space picked.
    const targets: Array<Connection | null> = secretsOf(part).length === 0 ? [null] : picked.flatMap((id) => {
      const found = connections.find((c) => c.id === id && c.plugin === manifest.id)
      if (!found) problems.push(`${manifest.name}: a sign-in it should use here is gone`)
      return found && serves(found, 'mcp') ? [found] : []
    })
    if (secretsOf(part).length > 0 && picked.length === 0) problems.push(`${manifest.name}: no sign-in picked for this space`)
    for (const connection of targets) {
      const missing: string[] = []
      const fill = (value: ConfigValue): string => {
        if (typeof value === 'string') return expand(value)
        const filled = connection?.values[value.secret]
        if (filled === undefined && !value.optional) missing.push(value.secret)
        return filled ?? ''
      }
      let config: McpServerConfig
      if (part.transport === 'stdio') {
        const { missing: lacking, ...launch } = stdioLaunch(part, connection, vars)
        missing.push(...lacking)
        config = { type: 'stdio', ...launch }
      } else {
        config = { type: part.transport, url: fill(part.url), headers: mapValues(part.headers, fill) }
      }
      // A shared server: the session reaches the one process of this sign-in through the relay.
      if (part.transport === 'stdio' && part.shared && connection && vars.RELAY && sharedKey) {
        config = { type: 'http', url: `${vars.RELAY}/${connection.id}`, headers: { 'x-eml-relay-key': sharedKey(connection.id) } }
      }
      if (missing.length > 0) {
        problems.push(`${manifest.name}: ${connection ? `the sign-in ${connection.id} lacks ${missing.join(', ')}` : 'no sign-in picked for this space'}`)
        continue
      }
      // The first sign-in (or one without a short name) takes the plugin's own name; others add theirs.
      const wanted = connection?.slug ? `${base}-${connection.slug}` : base
      if (owner.has(wanted) && owner.get(wanted) !== manifest.id) {
        // Another plugin has the name (e.g. the gmail plugin replacing an imported gmail server): it stays out.
        problems.push(`${manifest.name}: left out, ${owner.get(wanted)} serves ${wanted} here`)
        continue
      }
      let name = wanted
      for (let n = 2; name in servers; n++) name = `${wanted}-${n}`
      servers[name] = config
      owner.set(name, manifest.id)
    }
  }
  return { servers, problems }
}

/** How the cockpit starts a stdio part's process for one sign-in; `missing` names the secrets it lacks. */
export function stdioLaunch(
  part: Extract<McpPart, { transport: 'stdio' }>,
  connection: Connection | null,
  vars: Record<string, string> = {},
): { command: string; args: string[]; env: Record<string, string>; missing: string[] } {
  const missing: string[] = []
  const expand = (text: string) => text.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => vars[name] ?? whole)
  const fill = (value: ConfigValue): string => {
    if (typeof value === 'string') return expand(value)
    const filled = connection?.values[value.secret]
    if (filled === undefined && !value.optional) missing.push(value.secret)
    return filled ?? ''
  }
  return { command: expand(part.command), args: part.args.map(fill), env: mapValues(part.env, fill), missing }
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
 * a channel part, on in every space that picked that connection (a space may pick several). The connection's id is the
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
      return on ? [{ spaceId, connections: on.connections }] : []
    })
    for (const { spaceId, connections: all } of bySpace) {
      // Sign-ins for other parts only (a service account for the mcp part) ask nothing of the bridge.
      const picked = all.filter((id) => { const found = connections.find((c) => c.id === id); return !found || serves(found, 'channel') })
      if (all.length > 0 && picked.length === 0) continue
      if (picked.length === 0) problems.push(`${manifest.name}: on in space ${spaceId} without a sign-in`)
      else if (!tokenSpaces.includes(spaceId)) problems.push(`${manifest.name}: space ${spaceId} takes no channel messages (no job token)`)
    }
    for (const connection of connections.filter((c) => c.plugin === manifest.id && serves(c, 'channel'))) {
      const spaces = bySpace.filter((on) => on.connections.includes(connection.id) && tokenSpaces.includes(on.spaceId)).map((on) => on.spaceId)
      if (spaces.length === 0) continue
      accounts.push({ ...connection.values, type: channel.adapter, accountId: connection.accountId ?? connection.id, spaces: spaces.sort() })
    }
  }
  return { accounts, problems }
}
