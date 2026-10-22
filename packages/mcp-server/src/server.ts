import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HttpClient } from './http-client'
import { Provenance } from './provenance'
import { registerAllTools } from './tools'

/**
 * MCP server setup (v0.9-PROPOSAL §6).
 *
 * Single-mode HTTP client (no embedded SQLite). Self-host uses the same
 * invocation, just with `--url http://localhost:3117`.
 *
 * Stdio transport: local process spawned by Claude Code's MCP config.
 * Capabilities: tools only (static, listChanged=false). Resources/prompts
 * are v0.9.x polish.
 */

export interface McpServerOptions {
  url: string
  token: string
  clientName?: string
  serverVersion?: string
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  // v0.19: every write carries the session, harness and model (provenance.ts).
  const provenance = new Provenance()
  const httpClient = new HttpClient({ url: opts.url, token: opts.token, writeHeaders: () => provenance.headers() })

  const server = new McpServer({
    name: opts.clientName ?? 'eml-mcp-server',
    version: opts.serverVersion ?? '0.9.0',
  })
  server.server.oninitialized = () => provenance.setHarness(server.server.getClientVersion()?.name)

  registerAllTools(server, httpClient)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
