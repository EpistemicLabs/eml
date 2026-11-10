import * as fs from 'node:fs'
import * as path from 'node:path'
import { AGENTS_DIR } from './paths.js'
import type { ProviderId, SessionAgentRuntime } from './domain/agent-provider.js'

/**
 * An agent's own runtime: its config folder per agent CLI, its login (kept in
 * that folder by the CLI itself), its MCP allowlist and its skill list. `agent`
 * always means the agent (identity, agent brain, agents.ts); this is where its
 * sessions run. An agent without one runs on the home's runtime as always.
 *
 *   <home>/agents/<agent id>/agent.json        the record, free of any one agent CLI's format
 *   <home>/agents/<agent id>/mcp-servers.json  definitions of the allowed MCP servers (chmod 600)
 *   <folder the record names>                  generated files and the CLI's own login
 *
 * The config folder's path is stored in the record and never derived, so moving
 * it is a one-line change. That an agent has a runtime is the `runtime` of its
 * entry in the cockpit config (config.ts), not the presence of a folder: a
 * deleted runtime must stop its sessions, not send them into the shared folder.
 * The runtime follows the agent into every space that binds it.
 *
 * This is the runtime only: who the agent is lives in its brain (agents.ts).
 *
 * This separates context, not access: every agent runs as the same OS user, so
 * one agent's shell can read another agent's folder and login.
 */

/** agent.json. */
export interface AgentRuntime {
  agentId: string
  /** The MCP servers its sessions get next to the brain. */
  mcpServers: string[]
  /** The skills its sessions get next to the cockpit's managed ones. */
  skills: string[]
  /** Its own temp folder. */
  tempDir: string
  /** What each agent CLI this agent runs with keeps per agent. */
  harnesses: Partial<Record<ProviderId, { configDir: string }>>
  /** Browser control (Claude in Chrome): off unless set. It reaches every site the browser is signed in to. */
  chrome?: boolean
}

/** Also the agent's name in the brain (scope agent.<id>). */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
/** The MCP server name of the brain, which the host always adds itself. */
export const BRAIN_MCP_SERVER = 'eml_brain'

export const agentDir = (agentId: string) => path.join(AGENTS_DIR, agentId)
export const agentRuntimeFile = (agentId: string) => path.join(agentDir(agentId), 'agent.json')
export const agentMcpFile = (agentId: string) => path.join(agentDir(agentId), 'mcp-servers.json')

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)

/** The record of an agent; throws with what is wrong (the pane shows it). */
export function readAgentRuntime(agentId: string): AgentRuntime {
  const file = agentRuntimeFile(agentId)
  let parsed: Partial<AgentRuntime>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentRuntime>
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${file} is missing` : `${file} cannot be read as JSON`)
  }
  if (parsed.agentId !== agentId) throw new Error(`${file} names another agent`)
  if (!isStringList(parsed.mcpServers)) throw new Error(`${file}: mcpServers must be a list of names`)
  if (!isStringList(parsed.skills)) throw new Error(`${file}: skills must be a list of names`)
  if (typeof parsed.tempDir !== 'string' || !path.isAbsolute(parsed.tempDir)) throw new Error(`${file}: tempDir must be an absolute path`)
  const harnesses = parsed.harnesses
  if (!harnesses || typeof harnesses !== 'object') throw new Error(`${file} names no config folder`)
  if (parsed.chrome !== undefined && typeof parsed.chrome !== 'boolean') throw new Error(`${file}: chrome must be true or false`)
  for (const harness of Object.values(harnesses)) {
    if (typeof harness?.configDir !== 'string' || !path.isAbsolute(harness.configDir)) throw new Error(`${file}: configDir must be an absolute path`)
  }
  return parsed as AgentRuntime
}

export function writeAgentRuntime(record: AgentRuntime): void {
  fs.mkdirSync(agentDir(record.agentId), { recursive: true, mode: 0o700 })
  fs.writeFileSync(agentRuntimeFile(record.agentId), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
}

/** The definitions of an agent's MCP file, by name; throws when the file is missing or broken. Values are never part of a message. */
export function readAgentMcpDefinitions(agentId: string): Record<string, unknown> {
  const file = agentMcpFile(agentId)
  let parsed: { mcpServers?: unknown }
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown }
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `its MCP file ${file} is missing` : `its MCP file ${file} cannot be read as JSON`)
  }
  const servers = parsed.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`its MCP file ${file} has no mcpServers object`)
  return servers as Record<string, unknown>
}

/** The allowed servers out of the definitions; a name without a definition, or one that claims the brain's name, is an error. */
export function allowedMcpServers(allowed: string[], definitions: Record<string, unknown>): Record<string, unknown> {
  const servers: Record<string, unknown> = {}
  for (const name of allowed) {
    if (name === BRAIN_MCP_SERVER) throw new Error(`"${BRAIN_MCP_SERVER}" is the brain's server and cannot be listed`)
    if (!(name in definitions)) throw new Error(`the allowed MCP server "${name}" has no definition in its MCP file`)
    servers[name] = definitions[name]
  }
  return servers
}

/** What a space with a runtime needs at boot and before every launch. */
export interface SpaceRuntime extends SessionAgentRuntime {
  /** The record, or null when it could not be read (then `problem` says why for every CLI). */
  record: AgentRuntime | null
}

const stop = (agentId: string, why: string) => `Agent "${agentId}": ${why}. The session did not start; it never falls back to the shared config.`

/**
 * Open the runtime of the agent bound to a space. Nothing is created here: a missing folder
 * stays missing and the space's sessions say so. `bootProblem` is what the boot
 * found (a broken record, a skill or definition missing); the folder and the MCP
 * files are looked at again before every launch, since they can go at any time.
 */
export function openSpaceRuntime(agentId: string, mcpConfig: (configDir: string) => string): SpaceRuntime {
  let record: AgentRuntime | null = null
  let bootProblem: string | null = null
  try {
    record = readAgentRuntime(agentId)
  } catch (err) {
    bootProblem = (err as Error).message
  }
  const runtime: SpaceRuntime = {
    id: agentId,
    record,
    configDirs: record ? Object.fromEntries(Object.entries(record.harnesses).map(([id, h]) => [id, h.configDir])) : {},
    tempDir: record?.tempDir ?? '',
    chrome: record?.chrome === true,
    setProblem(why) { bootProblem = why },
    problem(provider) {
      if (bootProblem) return stop(agentId, bootProblem)
      const configDir = record?.harnesses[provider]?.configDir
      if (!configDir) return stop(agentId, `it has no config folder for ${provider}`)
      if (!fs.existsSync(configDir)) return stop(agentId, `its config folder ${configDir} is missing`)
      if (!fs.existsSync(agentMcpFile(agentId))) return stop(agentId, `its MCP file ${agentMcpFile(agentId)} is missing`)
      if (!fs.existsSync(mcpConfig(configDir))) return stop(agentId, `its generated MCP file ${mcpConfig(configDir)} is missing; restart the cockpit to write it`)
      return null
    },
  }
  return runtime
}
