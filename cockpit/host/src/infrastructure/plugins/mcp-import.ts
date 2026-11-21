import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ConfigValue } from '../../domain/plugin-manifest.js'
import { setPlugin, type Connection, type SpacePlugins } from '../../domain/space-plugins.js'
import { redactSecrets } from '../../diagnostics/redact.js'
import type { PluginRegistry } from './plugin-registry.js'
import type { PluginStore } from './plugin-store.js'

/**
 * One-time import of the MCP servers configured outside the plugins (plan phase 3), so that from
 * then on a space's sessions get exactly the plugins switched on for it:
 *
 *   - the user-level servers in the cockpit's Claude config (<home>/claude-config/.claude.json
 *     mcpServers), which every space without an agent runtime of its own loads today;
 *   - each agent runtime's agents/<id>/mcp-servers.json, filtered by its agent.json list.
 *
 * Each server becomes a custom MCP plugin under its own server name (its tools keep their names),
 * switched on in exactly the spaces that load it today. Its values (env, headers, a URL with a key,
 * an argument after --token …) go into a connection, owner-only, never into the plugin's manifest.
 * The Claude config is copied to <home>/plugins/backups/ before the servers leave it; an agent's own
 * files stay as they are. Each step is recorded in spaces.json `done`, so a second run changes
 * nothing. To undo: copy the backup back over .claude.json, and remove the imported plugins
 * (custom.json), their connections and the step from spaces.json.
 */

export interface ImportSpace {
  id: string
  agent: string | null
  ownRuntime: boolean
}

export interface ImportSource {
  claudeJson: string
  /** The agents with a runtime of their own: the servers they may use, from their definitions. */
  agents: Array<{ id: string; allowed: string[]; definitions: Record<string, unknown> | null }>
}

export interface ImportResult {
  imported: Array<{ plugin: string; serverName: string; spaces: string[] }>
  skipped: Array<{ serverName: string; reason: string }>
  backup: string | null
}

const CLAUDE_STEP = 'import:claude-json'
const agentStep = (agentId: string) => `import:agent:${agentId}`

export async function importMcpServers(
  source: ImportSource,
  spaces: ImportSpace[],
  deps: { registry: PluginRegistry; store: PluginStore; backupsDir: string; now?: () => Date },
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], backup: null }
  const done = new Set((await deps.store.spaces()).done)

  if (!done.has(CLAUDE_STEP)) {
    const shared = spaces.filter((space) => !space.ownRuntime).map((space) => space.id)
    const config = await readJsonObject(source.claudeJson)
    const servers = asRecord(config?.mcpServers)
    const taken: string[] = []
    if (config && servers && Object.keys(servers).length > 0) {
      result.backup = await backup(source.claudeJson, deps.backupsDir, deps.now?.() ?? new Date())
      for (const [serverName, definition] of Object.entries(servers)) {
        const outcome = await importOne(serverName, definition, shared, 'claude-config', deps)
        if (outcome.ok) {
          result.imported.push(outcome.entry)
          taken.push(serverName)
        } else result.skipped.push({ serverName, reason: outcome.reason })
      }
      // Only what became a plugin leaves the config; what couldn't be read stays where it was.
      const rest = Object.fromEntries(Object.entries(servers).filter(([name]) => !taken.includes(name)))
      await writeJsonAtomic(source.claudeJson, { ...config, mcpServers: rest })
    }
    await deps.store.updateSpaces((state) => markDone(state, CLAUDE_STEP))
  }

  for (const agent of source.agents) {
    if (done.has(agentStep(agent.id))) continue
    const own = spaces.filter((space) => space.ownRuntime && space.agent === agent.id).map((space) => space.id)
    for (const serverName of agent.allowed) {
      const definition = agent.definitions?.[serverName]
      if (definition === undefined) {
        result.skipped.push({ serverName, reason: `agent ${agent.id} lists it without a definition` })
        continue
      }
      const outcome = await importOne(serverName, definition, own, `agent-${agent.id}`, deps)
      if (outcome.ok) result.imported.push(outcome.entry)
      else result.skipped.push({ serverName, reason: outcome.reason })
    }
    await deps.store.updateSpaces((state) => markDone(state, agentStep(agent.id)))
  }
  return result
}

type Outcome = { ok: true; entry: ImportResult['imported'][number] } | { ok: false; reason: string }

async function importOne(
  serverName: string,
  definition: unknown,
  spaces: string[],
  origin: string,
  deps: { registry: PluginRegistry; store: PluginStore },
): Promise<Outcome> {
  const split = splitDefinition(definition)
  if (!split) return { ok: false, reason: 'not a stdio or http server definition the cockpit can read' }
  const id = await freeId(serverName, origin, deps.registry)
  const added = await deps.registry.addCustom({
    id,
    name: serverName,
    description: origin === 'claude-config' ? 'Imported from the cockpit\'s Claude config.' : `Imported from agent ${origin.slice('agent-'.length)}'s MCP file.`,
    parts: { mcp: { ...split.part, serverName } },
  })
  if (!added.ok) return { ok: false, reason: added.reason }
  const hasSecrets = Object.keys(split.values).length > 0
  const connection: Connection | null = hasSecrets ? { id: `${id}-imported`, plugin: id, label: 'Imported settings', values: split.values } : null
  if (connection) await deps.store.updateConnections((connections) => [...connections.filter((c) => c.id !== connection.id), connection])
  await deps.store.updateSpaces((state) => {
    const next = spaces.reduce((acc, space) => setPlugin(acc, space, id, { connections: connection ? [connection.id] : [] }), state)
    return { ...next, imported: [...new Set([...next.imported, id])] }
  })
  return { ok: true, entry: { plugin: id, serverName, spaces } }
}

/** A plugin id from the server name, not yet taken: the name itself where it fits, else with the origin added. */
async function freeId(serverName: string, origin: string, registry: PluginRegistry): Promise<string> {
  const base = serverName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 30) || 'server'
  for (const candidate of [base, `${base}-${origin}`.slice(0, 40).replace(/-+$/, '')]) {
    if ((await registry.get(candidate)) === null) return candidate
  }
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 34)}-${n}`
    if ((await registry.get(candidate)) === null) return candidate
  }
}

/** Arguments after a flag like this carry a secret. */
const SECRET_FLAG = /^--?([a-z-]*(api[-_]?key|token|secret|password|passwd|auth|credential|key))(=.*)?$/i

/**
 * A server definition split into a manifest part with secret references and the values they stand
 * for. Every env and header value counts as secret, so is a URL with a query or credentials in it
 * and an argument that looks like a token or follows a token flag.
 */
export function splitDefinition(definition: unknown): { part: Record<string, unknown>; values: Record<string, string> } | null {
  const def = asRecord(definition)
  if (!def) return null
  const values: Record<string, string> = {}
  const secret = (name: string, value: string): ConfigValue => {
    values[name] = value
    return { secret: name }
  }
  const strings = (record: unknown, prefix: string): Record<string, ConfigValue> | null => {
    const entries = asRecord(record ?? {})
    if (!entries || !Object.values(entries).every((v) => typeof v === 'string')) return null
    return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, secret(`${prefix}${key}`, value as string)]))
  }
  const type = typeof def.type === 'string' ? def.type : typeof def.command === 'string' ? 'stdio' : typeof def.url === 'string' ? 'http' : null
  if (type === 'stdio' && typeof def.command === 'string') {
    const args = Array.isArray(def.args) ? def.args : []
    if (!args.every((a) => typeof a === 'string')) return null
    const env = strings(def.env, 'env:')
    if (!env) return null
    const part = {
      transport: 'stdio',
      command: def.command,
      args: (args as string[]).map((arg, i): ConfigValue => {
        const afterFlag = i > 0 && SECRET_FLAG.test((args as string[])[i - 1]) && !(args as string[])[i - 1].includes('=')
        const inline = SECRET_FLAG.exec(arg)?.[3]
        if (afterFlag || inline || redactSecrets(arg) !== arg) return secret(`arg:${i}`, arg)
        return arg
      }),
      env,
    }
    return { part, values }
  }
  if ((type === 'http' || type === 'sse') && typeof def.url === 'string') {
    const headers = strings(def.headers, 'header:')
    if (!headers) return null
    let url: ConfigValue = def.url
    try {
      const parsed = new URL(def.url)
      if (parsed.search || parsed.username || parsed.password) url = secret('url', def.url)
    } catch {
      return null
    }
    return { part: { transport: type, url, headers }, values }
  }
  return null
}

function markDone(state: SpacePlugins, step: string): SpacePlugins {
  return state.done.includes(step) ? state : { ...state, done: [...state.done, step] }
}

async function backup(file: string, dir: string, now: Date): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `${path.basename(file).replace(/^\./, '')}.${now.toISOString().replace(/[:.]/g, '-')}`)
  await fs.copyFile(file, target)
  await fs.chmod(target, 0o600)
  return target
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
