import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from './http-client'
import type { Provenance } from './provenance'
import { registerAllTools } from './tools'

export interface EmlMcpServerOptions {
  /** The EML API client the tools call; its write headers carry `provenance`. */
  client: HttpClient
  /** Who writes (provenance.ts); the harness is set from the initialize handshake. */
  provenance: Provenance
  clientName?: string
  serverVersion?: string
}

/** The MCP server with every EML tool registered, not yet connected to a transport. */
export function createEmlMcpServer(opts: EmlMcpServerOptions): McpServer {
  const server = new McpServer({
    name: opts.clientName ?? 'eml-mcp-server',
    version: opts.serverVersion ?? '0.9.0',
  })
  server.server.oninitialized = () => opts.provenance.setHarness(server.server.getClientVersion()?.name)
  registerAllTools(server, opts.client)
  return server
}
