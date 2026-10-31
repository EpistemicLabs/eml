import * as fs from 'node:fs'
import * as path from 'node:path'
import { AGENTS_DIR } from './paths.js'
import type { ProviderId, SessionAgent } from './domain/agent-provider.js'

/**
 * A brain space's own agent: its id, its config folder per agent CLI, its login
 * (kept in that folder by the CLI itself), its MCP allowlist and its skill list.
 * A space without one runs in the shared config as always.
 *
 *   <home>/agents/<agent id>/agent.json        the record, free of any one agent CLI's format
 *   <home>/agents/<agent id>/mcp-servers.json  definitions of the allowed MCP servers (chmod 600)
 *   <folder the record names>                  generated files and the CLI's own login
 *
 * The config folder's path is stored in the record and never derived, so moving
 * it is a one-line change. The binding is the `agent` of the space's entry in
 * the cockpit config (config.ts), not the presence of a folder: a deleted agent
 * must stop the space's sessions, not send them into the shared folder.
 *
 * The session's identity comes from the host, not the brain's name: the session
 * files name the agent the session boots as (EML_AGENT), and the agent has its
 * own token, whose name the brain server stamps into new engrams. So one brain
 * can have several agents, each with its record on its own person's machine.
 *
 * This separates context, not access: every agent runs as the same OS user, so
 * one agent's shell can read another agent's folder and login.
 */

/** agent.json. */
export interface AgentRecord {
  agentId: string
  /** The brain of the space this agent belongs to. */
  brainId: string
  /** The MCP servers its sessions get next to the brain. */
  mcpServers: string[]
  /** The skills its sessions get next to the cockpit's managed ones. */
  skills: string[]
  /** Its own temp folder. */
  tempDir: string
  /** What each agent CLI this agent runs with keeps per agent. */
  harnesses: Partial<Record<ProviderId, { configDir: string }>>
}

/** Also the agent's name in the brain (scope agent.<id>) and, for now, its token's name. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
/** The MCP server name of the brain, which the host always adds itself. */
export const BRAIN_MCP_SERVER = 'eml_brain'

export const agentDir = (agentId: string) => path.join(AGENTS_DIR, agentId)
export const agentRecordFile = (agentId: string) => path.join(agentDir(agentId), 'agent.json')
export const agentMcpFile = (agentId: string) => path.join(agentDir(agentId), 'mcp-servers.json')

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)

/** The record of an agent; throws with what is wrong (the pane shows it). */
export function readAgentRecord(agentId: string): AgentRecord {
  const file = agentRecordFile(agentId)
  let parsed: Partial<AgentRecord>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentRecord>
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${file} is missing` : `${file} cannot be read as JSON`)
  }
  if (parsed.agentId !== agentId) throw new Error(`${file} names another agent`)
  if (typeof parsed.brainId !== 'string' || !parsed.brainId) throw new Error(`${file} names no brain`)
  if (!isStringList(parsed.mcpServers)) throw new Error(`${file}: mcpServers must be a list of names`)
  if (!isStringList(parsed.skills)) throw new Error(`${file}: skills must be a list of names`)
  if (typeof parsed.tempDir !== 'string' || !path.isAbsolute(parsed.tempDir)) throw new Error(`${file}: tempDir must be an absolute path`)
  const harnesses = parsed.harnesses
  if (!harnesses || typeof harnesses !== 'object') throw new Error(`${file} names no config folder`)
  for (const harness of Object.values(harnesses)) {
    if (typeof harness?.configDir !== 'string' || !path.isAbsolute(harness.configDir)) throw new Error(`${file}: configDir must be an absolute path`)
  }
  return parsed as AgentRecord
}

export function writeAgentRecord(record: AgentRecord): void {
  fs.mkdirSync(agentDir(record.agentId), { recursive: true, mode: 0o700 })
  fs.writeFileSync(agentRecordFile(record.agentId), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
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

/** What a space with an agent needs at boot and before every launch. */
export interface SpaceAgent extends SessionAgent {
  /** The record, or null when it could not be read (then `problem` says why for every CLI). */
  record: AgentRecord | null
}

const stop = (agentId: string, why: string) => `Agent "${agentId}": ${why}. The session did not start; it never falls back to the shared config.`

/**
 * Open the agent bound to a space. Nothing is created here: a missing folder
 * stays missing and the space's sessions say so. `bootProblem` is what the boot
 * found (a broken record, a skill or definition missing); the folder and the MCP
 * files are looked at again before every launch, since they can go at any time.
 */
export function openSpaceAgent(agentId: string, spaceId: string, mcpConfig: (configDir: string) => string): SpaceAgent {
  let record: AgentRecord | null = null
  let bootProblem: string | null = null
  try {
    record = readAgentRecord(agentId)
    if (record.brainId !== spaceId) bootProblem = `its record names another brain than this space's (${record.brainId})`
  } catch (err) {
    bootProblem = (err as Error).message
  }
  const agent: SpaceAgent = {
    id: agentId,
    record,
    configDirs: record ? Object.fromEntries(Object.entries(record.harnesses).map(([id, h]) => [id, h.configDir])) : {},
    tempDir: record?.tempDir ?? '',
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
  return agent
}
