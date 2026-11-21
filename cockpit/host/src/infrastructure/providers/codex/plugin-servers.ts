import type { McpServerConfig } from '../../../domain/space-plugins.js'
import { tomlString, type TomlTable } from './toml.js'

/**
 * The spaces' plugin servers (application/space-plugins.ts) for Codex. One Codex home serves every
 * space, so each server is written once into config.toml, switched off (`enabled = false`), and a
 * session switches on its own space's with `--config mcp_servers.<name>.enabled=true`: no value
 * ever goes on a command line. A server name that two spaces fill differently (another connection)
 * gets a second entry, `<name>_2`. Codex has no SSE transport: such a server is left out.
 */
export function codexPluginTables(bySpace: Record<string, Record<string, McpServerConfig>>): { tables: TomlTable[]; names: Record<string, string[]> } {
  const entries = new Map<string, { name: string; config: McpServerConfig }>()
  const taken = new Set<string>(['eml_brain'])
  const names: Record<string, string[]> = {}
  for (const [spaceId, servers] of Object.entries(bySpace).sort(([a], [b]) => a.localeCompare(b))) {
    names[spaceId] = []
    for (const [serverName, config] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (config.type === 'sse') continue
      const key = `${serverName}\n${JSON.stringify(config)}`
      let entry = entries.get(key)
      if (!entry) {
        let name = serverName
        for (let n = 2; taken.has(name); n++) name = `${serverName}_${n}`
        taken.add(name)
        entry = { name, config }
        entries.set(key, entry)
      }
      names[spaceId].push(entry.name)
    }
  }
  const inline = (record: Record<string, string>) => `{ ${Object.entries(record).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`
  const tables = [...entries.values()].map(({ name, config }): TomlTable => ({
    header: `mcp_servers.${name}`,
    lines: config.type === 'stdio'
      ? [
          `command = ${tomlString(config.command)}`,
          `args = [${config.args.map(tomlString).join(', ')}]`,
          ...(Object.keys(config.env).length ? [`env = ${inline(config.env)}`] : []),
          'enabled = false',
        ]
      : [
          `url = ${tomlString(config.url)}`,
          ...(Object.keys(config.headers).length ? [`http_headers = ${inline(config.headers)}`] : []),
          'enabled = false',
        ],
  }))
  return { tables, names }
}

/** The arguments that switch a space's plugin servers on for one session. */
export function codexPluginArgs(names: string[]): string[] {
  return names.flatMap((name) => ['--config', `mcp_servers.${name}.enabled=true`])
}
