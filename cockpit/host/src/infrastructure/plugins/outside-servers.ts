import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** A server that loads in the cockpit's Claude config without being a cockpit plugin. */
export interface OutsideServer {
  /** As Claude Code names it, the name a space switches it off by ("claude.ai Slack", "plugin:x:y"). */
  name: string
  kind: 'connector' | 'claude-plugin'
}

/** The lines of `claude mcp list` naming a claude.ai connector or a Claude Code plugin's server. */
export function parseMcpList(output: string): OutsideServer[] {
  const servers = output.split('\n').flatMap((line): OutsideServer[] => {
    const connector = /^(claude\.ai [^:]+):\s/.exec(line)
    if (connector) return [{ name: connector[1].trim(), kind: 'connector' }]
    const plugin = /^(plugin:[^:\s]+:[^:\s]+):\s/.exec(line)
    return plugin ? [{ name: plugin[1], kind: 'claude-plugin' }] : []
  })
  return [...new Map(servers.map((server) => [server.name, server])).values()]
}

/** Whether Claude Code holds a sign-in for a server: from its own files, without asking the server. */
export type OutsideSignIn = 'signed-in' | 'needs-sign-in' | 'unknown'

/**
 * The sign-in state of the servers Claude Code signs in to itself, read from its config folder:
 * `.credentials.json` (mcpOAuth entries, by server name: a token or none) and
 * `mcp-needs-auth-cache.json` (servers that asked for a sign-in). Only names and whether a token
 * is there leave this function, never a value. claude.ai connectors are signed in at claude.ai and
 * stay `unknown` unless Claude Code noted that one needs a sign-in.
 */
export async function readOutsideSignIns(configDir: string): Promise<Record<string, OutsideSignIn>> {
  const states: Record<string, OutsideSignIn> = {}
  const credentials = await readJsonFile(path.join(configDir, '.credentials.json'))
  const oauth = credentials && typeof credentials === 'object' ? (credentials as { mcpOAuth?: unknown }).mcpOAuth : null
  if (oauth && typeof oauth === 'object') {
    for (const entry of Object.values(oauth as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const { serverName, accessToken } = entry as { serverName?: unknown; accessToken?: unknown }
      if (typeof serverName !== 'string') continue
      const signedIn = typeof accessToken === 'string' && accessToken.length > 0
      // Several entries for one name (signed in again): one with a token wins.
      if (signedIn || states[serverName] !== 'signed-in') states[serverName] = signedIn ? 'signed-in' : 'needs-sign-in'
    }
  }
  const needsAuth = await readJsonFile(path.join(configDir, 'mcp-needs-auth-cache.json'))
  if (needsAuth && typeof needsAuth === 'object') {
    for (const name of Object.keys(needsAuth as Record<string, unknown>)) states[name] = 'needs-sign-in'
  }
  return states
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

const TTL_MS = 10 * 60_000

/**
 * The claude.ai connectors and Claude Code plugin servers of the cockpit's Claude config, asked of
 * `claude mcp list` (it checks each one, so it takes a while) and kept for ten minutes. Never a
 * secret: names only. An empty list when Claude Code can't be asked.
 */
export class OutsideServers {
  private cached: { at: number; servers: OutsideServer[] } | null = null
  private pending: Promise<OutsideServer[]> | null = null

  constructor(private readonly options: { bin: string; configDir: string; now?: () => number }) {}

  /** Claude Code's own sign-in state per server name, read fresh each time (two small files). */
  signIns(): Promise<Record<string, OutsideSignIn>> {
    return readOutsideSignIns(this.options.configDir)
  }

  list(): Promise<OutsideServer[]> {
    const now = this.options.now?.() ?? Date.now()
    if (this.cached && now - this.cached.at < TTL_MS) return Promise.resolve(this.cached.servers)
    this.pending ??= new Promise<OutsideServer[]>((resolve) => {
      execFile(this.options.bin, ['mcp', 'list'], {
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDE_CONFIG_DIR: this.options.configDir },
      }, (err, stdout) => resolve(err ? [] : parseMcpList(String(stdout))))
    }).then((servers) => {
      this.pending = null
      if (servers.length > 0) this.cached = { at: this.options.now?.() ?? Date.now(), servers }
      return servers
    })
    return this.pending
  }
}
