#!/usr/bin/env node

import { startMcpServer } from './server'

/**
 * @engramprotocol/mcp-server CLI entry.
 *
 * Two modes, dispatched by first arg:
 *   - no args (or --url/--token/etc.) → MCP-server mode (stdio JSON-RPC for Claude Code)
 *   - `hook [session-start|user-prompt-submit|stop] [--config <path>]` → Claude Code
 *     hooks (boot, reminder, consolidate before a compaction) without bash/jq,
 *     for apps that embed the client
 *
 * Server-mode usage:
 *   eml-mcp-server --url <api-url> --token <bearer> [--name <client-name>]
 *
 *   --url     | EML_API_URL     (required) — e.g. http://localhost:3117
 *   --token   | EML_API_TOKEN   (required) — Bearer token (eml_<prefix><secret>)
 *   --name    | EML_CLIENT_NAME (default: "eml-mcp-server") — for server logs
 *
 * Logging: stderr (stdout is reserved for MCP JSON-RPC in server-mode).
 */

interface CliArgs {
  url?: string
  token?: string
  name?: string
  help?: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--url')   { out.url   = argv[++i]; continue }
    if (a === '--token') { out.token = argv[++i]; continue }
    if (a === '--name')  { out.name  = argv[++i]; continue }
  }
  return out
}

function printHelpAndExit(code: number): never {
  const msg = `eml-mcp-server — MCP wrapper for the EML HTTP API

Usage:
  eml-mcp-server --url <api-url> --token <bearer> [--name <client-name>]

Args:
  --url     EML_API_URL      EML API URL (e.g. http://localhost:3117)
  --token   EML_API_TOKEN    Bearer token (eml_<prefix><secret>)
  --name    EML_CLIENT_NAME  Client name in server logs (default: eml-mcp-server)
  --help

Example — Claude Code MCP config:
  {
    "mcpServers": {
      "eml_brain": {
        "command": "npx",
        "args": ["-y", "@engramprotocol/mcp-server"],
        "env": {
          "EML_API_URL": "http://127.0.0.1:3117",
          "EML_API_TOKEN": "eml_..."
        }
      }
    }
  }
`
  process.stderr.write(msg)
  process.exit(code)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // Dispatch: hook-mode vs server-mode
  if (argv[0] === 'hook') {
    const { runHook } = await import('./hooks/index.js')
    await runHook(argv.slice(1))
    return
  }

  // Server-mode (default)
  const args = parseArgs(argv)
  if (args.help) printHelpAndExit(0)

  const url = args.url ?? process.env.EML_API_URL
  const token = args.token ?? process.env.EML_API_TOKEN
  const clientName = args.name ?? process.env.EML_CLIENT_NAME ?? 'eml-mcp-server'

  if (!url || !token) {
    process.stderr.write('Error: --url + --token (or EML_API_URL + EML_API_TOKEN) are required.\n\n')
    printHelpAndExit(1)
  }

  try {
    await startMcpServer({ url, token, clientName })
    process.stderr.write(`[eml-mcp-server] connected, stdio-transport ready (${clientName} → ${url})\n`)
  } catch (err: unknown) {
    const e = err as Error
    process.stderr.write(`[eml-mcp-server] startup failed: ${e.message}\n`)
    process.exit(1)
  }
}

main()
