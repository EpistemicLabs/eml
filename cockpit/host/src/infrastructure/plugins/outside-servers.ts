import { execFile } from 'node:child_process'

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
