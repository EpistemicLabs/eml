import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createEmlMcpServer } from './factory'
import { HttpClient } from './http-client'
import { Provenance } from './provenance'

export { createEmlMcpServer, type EmlMcpServerOptions } from './factory'
export { HttpClient } from './http-client'
export { Provenance } from './provenance'
export { McpHttpEndpoint, type McpHttpCaller, type McpHttpEndpointOptions } from './http-endpoint'

/**
 * MCP server setup (v0.9-PROPOSAL §6).
 *
 * Single-mode HTTP client (no embedded SQLite). Self-host uses the same
 * invocation, just with `--url http://localhost:3117`.
 *
 * One factory (factory.ts), two transports: stdio, a local process spawned by
 * the agent CLI's MCP config (startMcpServer below), and Streamable HTTP, one
 * endpoint for many sessions (http-endpoint.ts, served by the EML cockpit's
 * host). Capabilities: tools only (static, listChanged=false).
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
  const client = new HttpClient({ url: opts.url, token: opts.token, writeHeaders: () => provenance.headers() })
  const server = createEmlMcpServer({ client, provenance, clientName: opts.clientName, serverVersion: opts.serverVersion })
  await server.connect(new StdioServerTransport())
}
