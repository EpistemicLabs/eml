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
