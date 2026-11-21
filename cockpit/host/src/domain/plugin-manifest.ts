import { z } from 'zod'

/**
 * A cockpit plugin: one service, made of parts.
 *
 *   pane     a view in a pane: one of the cockpit's built-in views, or later a sandboxed page
 *   mcp      an MCP server the space's sessions get
 *   channel  a channel bridge adapter (packages/channel-bridge-sdk), named by its account type
 *
 * The tier says where a plugin comes from and decides which parts it may have
 * (decision cockpit-plugin-isolation): server parts (mcp, channel) run with the
 * user's rights, so only official plugins (in the repo, pinned with the
 * cockpit), the user's own custom ones and local dev plugins may have them; a
 * community plugin is a pane only. A community plugin the user promotes
 * becomes custom and keeps its pane; the file itself never raises its tier.
 */

export const PLUGIN_TIERS = ['official', 'custom', 'community', 'dev'] as const
export type PluginTier = (typeof PLUGIN_TIERS)[number]

/** Lower case, digits and dashes: it names folders, config keys and MCP servers. */
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lower case letters, digits and dashes, starting with a letter')

/**
 * A value an MCP part passes to its server: written as it is, or a secret the
 * cockpit fills in from one of the user's connections when it writes the
 * space's MCP config (never stored in the manifest). An optional secret a
 * connection lacks is passed as an empty value instead of leaving the server out.
 */
export const configValueSchema = z.union([z.string(), z.strictObject({ secret: z.string().min(1).max(64), optional: z.literal(true).optional() })])
export type ConfigValue = z.infer<typeof configValueSchema>

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
const headerNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)

/** The name sessions know the server by (its tools are mcp__<name>__…); the plugin id when left out. */
const serverNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

export const mcpPartSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    serverName: serverNameSchema.optional(),
    command: z.string().min(1),
    args: z.array(configValueSchema).default([]),
    env: z.record(envNameSchema, configValueSchema).default({}),
  }),
  z.strictObject({
    /** Streamable HTTP, or the older server-sent events transport. */
    transport: z.enum(['http', 'sse']),
    serverName: serverNameSchema.optional(),
    /** A URL with a key in it is a secret as a whole. */
    url: z.union([z.string().url(), z.strictObject({ secret: z.string().min(1).max(64) })]),
    headers: z.record(headerNameSchema, configValueSchema).default({}),
  }),
])
export type McpPart = z.infer<typeof mcpPartSchema>

export const panePartSchema = z.union([
  /** One of the cockpit's own views (frontend lib/pane-views.ts). */
  z.strictObject({ builtin: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }),
  /** A page the cockpit shows in a sandboxed frame; not served yet. */
  z.strictObject({ entry: z.string().min(1) }),
])
export type PanePart = z.infer<typeof panePartSchema>

export const channelPartSchema = z.strictObject({
  /** The accounts file `type` the bridge's adapter serves, e.g. "gmail". */
  adapter: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
})
export type ChannelPart = z.infer<typeof channelPartSchema>

export const pluginAuthSchema = z.strictObject({
  /** How the user signs in; a connection of this kind serves every space. */
  kind: z.enum(['google-oauth', 'token']),
  /** What the sign-in must allow, as the provider names it. */
  scopes: z.array(z.string()).default([]),
})
export type PluginAuth = z.infer<typeof pluginAuthSchema>

export const pluginManifestSchema = z.strictObject({
  id: pluginIdSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(400).default(''),
  tier: z.enum(PLUGIN_TIERS),
  /** Its state until the user switches it (decision cockpit-plugin-defaults: only the first plugins start on). */
  defaultEnabled: z.boolean().default(false),
  parts: z.strictObject({
    pane: panePartSchema.optional(),
    mcp: mcpPartSchema.optional(),
    channel: channelPartSchema.optional(),
  }),
  auth: pluginAuthSchema.optional(),
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

export type PluginPartKind = keyof PluginManifest['parts']

/** The parts a plugin has, in a fixed order. */
export function partsOf(manifest: PluginManifest): PluginPartKind[] {
  return (['pane', 'mcp', 'channel'] as const).filter((kind) => manifest.parts[kind] !== undefined)
}

/** Tiers whose plugins may run code with the user's rights (mcp, channel). */
const SERVER_TIERS: ReadonlySet<PluginTier> = new Set(['official', 'custom', 'dev'])

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; reason: string }

/**
 * A manifest as read from a file or a request, checked against the schema and
 * the tier's rules. `tier` is where it was found: a file can't raise itself to
 * official by writing so.
 */
export function readManifest(raw: unknown, tier: PluginTier): ManifestResult {
  const parsed = pluginManifestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; ') }
  const manifest = parsed.data
  if (manifest.tier !== tier) return { ok: false, reason: `a plugin found as ${tier} says it is ${manifest.tier}` }
  if (partsOf(manifest).length === 0) return { ok: false, reason: 'a plugin needs at least one part' }
  if (!SERVER_TIERS.has(tier) && (manifest.parts.mcp || manifest.parts.channel)) {
    return { ok: false, reason: `a ${tier} plugin may only have a pane` }
  }
  return { ok: true, manifest }
}

/** The name sessions know a plugin's MCP server by. */
export function serverNameOf(manifest: PluginManifest): string | null {
  return manifest.parts.mcp ? (manifest.parts.mcp.serverName ?? manifest.id) : null
}

/** The names of the secrets a part asks for, e.g. to tell which connection it needs. */
export function secretsOf(part: McpPart): string[] {
  const values: ConfigValue[] = part.transport === 'stdio'
    ? [...part.args, ...Object.values(part.env)]
    : [part.url, ...Object.values(part.headers)]
  return [...new Set(values.flatMap((value) => (typeof value === 'string' ? [] : [value.secret])))]
}
