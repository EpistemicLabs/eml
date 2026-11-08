/**
 * What a session may use, set when it starts and kept for its whole life, in the
 * chat view and the terminal alike. Neutral data: a provider turns it into its own flags.
 */
export interface ToolProfile {
  /** Built-in tools it may not use. */
  deniedTools: string[]
  /** The only MCP servers it gets, besides the brain; null: all its space has. */
  mcpServers: string[] | null
}

/** An MCP server a session gets beside its space's, as a provider writes it into its config. */
export interface McpServerSpec {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

/** Built-in tools a session that answers outside messages never gets: its text comes from strangers. */
const CHANNEL_JOB_DENIED_TOOLS = ['Bash']

/**
 * What a channel job's session may use: what its maker could not, and no shell; of its space's MCP
 * servers only the brain. Its channel tools come from the cockpit at every launch.
 */
export function channelJobProfile(base: ToolProfile | null): ToolProfile {
  const denied = base?.deniedTools ?? []
  return { deniedTools: [...denied, ...CHANNEL_JOB_DENIED_TOOLS.filter((tool) => !denied.includes(tool))], mcpServers: [] }
}

const names = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((name) => typeof name === 'string' && /^[\w.:*()-]+$/.test(name)) ? value as string[] : null

/** From a request body: the profile, null for none, or 'invalid'. */
export function parseToolProfile(body: { deniedTools?: unknown; mcpServers?: unknown }): ToolProfile | null | 'invalid' {
  if (body.deniedTools === undefined && body.mcpServers === undefined) return null
  const deniedTools = body.deniedTools === undefined ? [] : names(body.deniedTools)
  const mcpServers = body.mcpServers === undefined ? null : names(body.mcpServers)
  if (!deniedTools || (body.mcpServers !== undefined && !mcpServers)) return 'invalid'
  return { deniedTools, mcpServers }
}
