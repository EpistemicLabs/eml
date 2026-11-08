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

/** A tool the user can lift for a limited job's session for a while. */
export type GrantableTool = 'SendMessage' | 'chrome'

/**
 * Tools a limited job's session does not get, since its text comes from strangers: no shell, no
 * messages to other sessions, and no scheduling jobs, which would run with its maker's wider tools.
 * Web tools stay on.
 */
const LIMITED_DENIED_TOOLS = ['Bash', 'SendMessage', 'mcp__cockpit__schedule']

/**
 * What a limited job's session may use: what its maker could not, minus the tools above unless the
 * user granted one for now; of its space's MCP servers only the brain. Its channel tools come from
 * the cockpit at every launch.
 */
export function channelJobProfile(base: ToolProfile | null, granted: GrantableTool[]): ToolProfile {
  const denied = base?.deniedTools ?? []
  const closed = LIMITED_DENIED_TOOLS.filter((tool) => !denied.includes(tool) && !granted.includes(tool as GrantableTool))
  return { deniedTools: [...denied, ...closed], mcpServers: [] }
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
