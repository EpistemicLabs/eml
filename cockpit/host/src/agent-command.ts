import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { readCockpitConfig, updateCockpitConfig, type CockpitConfig } from './config.js'
import {
  AGENT_ID, BRAIN_MCP_SERVER, agentDir, agentMcpFile, agentRecordFile, allowedMcpServers, readAgentRecord,
  writeAgentRecord, type AgentRecord,
} from './agent-config.js'
import { copyAgentSkills, agentLoginStatus } from './infrastructure/providers/claude/isolation.js'
import { AGENTS_DIR, CONFIG_DIR, CORE_INDEX, DATA_DIR } from './paths.js'

/**
 * `eml-cockpit agent create|status|sync-skills` and `eml-cockpit rotate-brain-token`:
 * set up a space's own agent (agent-config.ts) and replace a brain token. No
 * command prints a credential or the value of an MCP definition.
 *
 * agent create <id> --space <name|brain id> [--name <display name>] [--profile <text>]
 *              [--mcp <a,b>] [--mcp-from <json file>] [--skills <x,y>] [--skills-from <folder>]
 *   With the cockpit stopped: makes the agent's folder, adds its agent row and
 *   profile to the brain, and binds it to the space with a token of its own in
 *   place of the space's old one, so new engrams show the agent (old rows stay as
 *   they are). The brain itself keeps its name. Start the cockpit afterwards; then
 *   run /login once in a session of the space.
 *
 * agent status [<id>]
 *   Reads the agent's files only. Never starts `claude`: a short-lived CLI process
 *   may begin a token refresh and exit before saving it, which blanks the login.
 *
 * rotate-brain-token <main|name|brain id>
 *   With the cockpit stopped: issues a new token under the old one's name, stores
 *   it in the cockpit config and revokes the old one.
 */

const require = createRequire(import.meta.url)
const say = (line: string) => process.stdout.write(`${line}\n`)

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const names = (raw: string | undefined) => (raw ?? '').split(',').map((n) => n.trim()).filter(Boolean)

interface ControlDb {
  prepare(sql: string): { run(...args: unknown[]): { changes: number }; get(...args: unknown[]): unknown }
  close(): void
}

interface Core {
  initControlDatabase(file: string): ControlDb
  verifyToken(control: ControlDb, token: string): { tokenId: string; userId: string; brainId: string; caller: string | null } | null
  issueToken(control: ControlDb, opts: { userId: string; brainId: string; name?: string | null }): { plaintext: string }
  revokeToken(control: ControlDb, tokenId: string): boolean
  EML: new (config: { dbPath: string; namespace: string }) => {
    agents: { exists(id: string): boolean }
    env(actor: { ingestion_method: string; handle: string }): unknown
    apply(command: { name: string; input: unknown }, env: unknown): unknown
    close(): void
  }
}

const loadCore = () => require(CORE_INDEX) as Core
const controlPath = () => path.join(DATA_DIR, 'control.db')

/** The token and display name of a further space, by its display name or brain id. */
function findSpace(config: CockpitConfig, control: ControlDb, core: Core, wanted: string) {
  for (const space of config.spaces ?? []) {
    const verified = core.verifyToken(control, space.token)
    if (verified && (verified.brainId === wanted || space.name === wanted)) return { ...space, verified }
  }
  return null
}

function parseCreate(argv: string[]) {
  const agentId = argv[0]
  if (!agentId || !AGENT_ID.test(agentId)) throw new Error('agent create <id>: the id is lower-case letters, digits and hyphens')
  const spaceName = flag(argv, 'space')
  if (!spaceName) throw new Error('agent create: --space <name|brain id> is required (the main space keeps the shared config)')
  return {
    agentId, spaceName,
    name: flag(argv, 'name') ?? agentId,
    profile: flag(argv, 'profile'),
    mcp: names(flag(argv, 'mcp')),
    mcpFrom: flag(argv, 'mcp-from'),
    skills: names(flag(argv, 'skills')),
    skillsFrom: flag(argv, 'skills-from') ?? path.join(CONFIG_DIR, 'skills'),
  }
}

/** The definitions of the allowed servers out of --mcp-from; the file itself is left alone. */
function chosenDefinitions(allowed: string[], from: string | undefined): Record<string, unknown> {
  if (allowed.length === 0) return {}
  if (!from) throw new Error('agent create: --mcp needs --mcp-from <json file with mcpServers>')
  let parsed: { mcpServers?: Record<string, unknown> }
  try {
    parsed = JSON.parse(fs.readFileSync(from, 'utf8')) as { mcpServers?: Record<string, unknown> }
  } catch {
    throw new Error(`agent create: ${from} cannot be read as JSON`)
  }
  return allowedMcpServers(allowed, parsed.mcpServers ?? {})
}

async function createAgent(argv: string[]): Promise<void> {
  const opts = parseCreate(argv)
  await refuseRunningHost('agent create')
  if (opts.mcp.includes(BRAIN_MCP_SERVER)) throw new Error(`agent create: the brain's server "${BRAIN_MCP_SERVER}" is always there and cannot be listed`)
  if (fs.existsSync(agentDir(opts.agentId))) throw new Error(`agent create: ${agentDir(opts.agentId)} already exists`)
  const definitions = chosenDefinitions(opts.mcp, opts.mcpFrom)
  for (const skill of opts.skills) {
    if (!fs.existsSync(path.join(opts.skillsFrom, skill, 'SKILL.md'))) throw new Error(`agent create: no skill "${skill}" in ${opts.skillsFrom}`)
  }
  const config = await readCockpitConfig()
  if (!config) throw new Error('agent create: this home has no cockpit config')

  const core = loadCore()
  const control = core.initControlDatabase(controlPath())
  try {
    const space = findSpace(config, control, core, opts.spaceName)
    if (!space) throw new Error(`agent create: no further space "${opts.spaceName}" (the main space keeps the shared config)`)
    const brain = control.prepare('SELECT brain_file FROM brains WHERE id = ?').get(space.verified.brainId) as { brain_file: string } | undefined
    if (!brain) throw new Error('agent create: the space\'s brain is not in control.db')

    const dir = agentDir(opts.agentId)
    const configDir = path.join(dir, 'claude-config')
    const tempDir = path.join(dir, 'tmp')
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 })
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(agentMcpFile(opts.agentId), JSON.stringify({ mcpServers: definitions }, null, 2) + '\n', { mode: 0o600 })
    copyAgentSkills(opts.skills, opts.skillsFrom, configDir)
    const record: AgentRecord = {
      agentId: opts.agentId,
      brainId: space.verified.brainId,
      mcpServers: opts.mcp,
      skills: opts.skills,
      tempDir,
      harnesses: { claude: { configDir } },
    }
    writeAgentRecord(record)

    // The identity. The brain server boots the agent the brain is named after,
    // and stamps the token's name into every new engram; both are read per request.
    const eml = new core.EML({ dbPath: path.join(DATA_DIR, brain.brain_file), namespace: opts.agentId })
    try {
      if (!eml.agents.exists(opts.agentId)) {
        const env = eml.env({ ingestion_method: 'direct', handle: opts.agentId })
        eml.apply({ name: 'object.create', input: { object: 'agent', fields: { id: opts.agentId, name: opts.name } } }, env)
        eml.apply({
          name: 'engram.create',
          input: {
            type: 'profile',
            scope: `agent.${opts.agentId}`,
            title: `${opts.agentId}-identity`,
            content: opts.profile ?? `I am ${opts.name}, the agent of the brain space "${space.name ?? opts.spaceName}". The brain makes me ${opts.name} across sessions: it is canonical, the conversation is supplementary.`,
            properties: { core: true },
          },
        }, env)
      }
    } finally {
      eml.close()
    }
    // The token's name is what the brain server stamps into new engrams.
    const issued = core.issueToken(control, { userId: space.verified.userId, brainId: space.verified.brainId, name: opts.agentId })
    // Last, so a failed run above leaves the space as it was.
    await updateCockpitConfig((current) => current && ({
      ...current,
      spaces: (current.spaces ?? []).map((s) => (s.token === space.token ? { ...s, token: issued.plaintext, agent: opts.agentId } : s)),
    }))
    core.revokeToken(control, space.verified.tokenId)
    say(`agent ${opts.agentId}: created for brain ${space.verified.brainId} (${opts.mcp.length} MCP servers + the brain, ${opts.skills.length} skills + the managed ones)`)
    say(`config folder: ${configDir}`)
    say('Start the cockpit, then run /login once in a session of this space.')
  } finally {
    control.close()
  }
}

function statusLines(record: AgentRecord): string[] {
  const configDir = record.harnesses.claude?.configDir
  const lines = [
    `agent ${record.agentId}`,
    `  brain: ${record.brainId}`,
    `  MCP allowlist: ${record.mcpServers.join(', ') || '(only the brain)'}`,
    `  MCP file: ${fs.existsSync(agentMcpFile(record.agentId)) ? 'present' : 'MISSING'}`,
    `  skill list: ${record.skills.join(', ') || '(only the managed ones)'}`,
  ]
  if (!configDir) return [...lines, '  config folder: none for Claude Code']
  lines.push(`  config folder: ${configDir}${fs.existsSync(configDir) ? '' : ' (MISSING)'}`)
  try {
    lines.push(`  skills in the folder: ${fs.readdirSync(path.join(configDir, 'skills')).length}`)
  } catch {
    lines.push('  skills in the folder: none yet')
  }
  const login = agentLoginStatus(configDir)
  lines.push(`  login: ${login.state}${login.expiresAt ? `, access token expires ${login.expiresAt}` : ''}${login.changedAt ? `, stored ${login.changedAt}` : ''}`)
  return lines
}

function showStatus(wanted: string | undefined): void {
  let ids: string[] = []
  if (wanted) ids = [wanted]
  else {
    try { ids = fs.readdirSync(AGENTS_DIR).filter((id) => fs.existsSync(agentRecordFile(id))) } catch { /* no agents yet */ }
  }
  if (ids.length === 0) say('no agents in this home')
  for (const id of ids) {
    try {
      for (const line of statusLines(readAgentRecord(id))) say(line)
    } catch (err) {
      say(`agent ${id}: ${(err as Error).message}`)
    }
  }
}

function syncSkills(argv: string[]): void {
  const agentId = argv[0]
  if (!agentId) throw new Error('agent sync-skills <id> [--skills-from <folder>]')
  const record = readAgentRecord(agentId)
  const configDir = record.harnesses.claude?.configDir
  if (!configDir || !fs.existsSync(configDir)) throw new Error(`agent sync-skills: the config folder of ${agentId} is missing`)
  const from = flag(argv, 'skills-from') ?? path.join(CONFIG_DIR, 'skills')
  for (const skill of record.skills) {
    if (!fs.existsSync(path.join(from, skill, 'SKILL.md'))) throw new Error(`agent sync-skills: no skill "${skill}" in ${from}`)
  }
  copyAgentSkills(record.skills, from, configDir)
  say(`agent ${agentId}: ${record.skills.length} skills copied. The next cockpit start removes what is not on the list.`)
}

/** Whether a host answers on this cockpit's port: its running brain clients hold the token in memory. */
function hostRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function refuseRunningHost(command: string): Promise<void> {
  const port = Number(process.env.COCKPIT_PORT) || 4317
  if (await hostRunning(port)) throw new Error(`${command}: a cockpit answers on port ${port}. Stop it first (COCKPIT_PORT names another port).`)
}

async function rotateBrainToken(argv: string[]): Promise<void> {
  const wanted = argv[0]
  if (!wanted) throw new Error('rotate-brain-token <main|name|brain id>')
  await refuseRunningHost('rotate-brain-token')
  const config = await readCockpitConfig()
  if (!config) throw new Error('rotate-brain-token: this home has no cockpit config')

  const core = loadCore()
  const control = core.initControlDatabase(controlPath())
  try {
    const main = wanted === 'main'
    const verified = main ? core.verifyToken(control, config.token) : findSpace(config, control, core, wanted)?.verified
    const oldToken = main ? config.token : findSpace(config, control, core, wanted)?.token
    if (!verified || !oldToken) throw new Error(`rotate-brain-token: no space "${wanted}" with a valid token`)
    const issued = core.issueToken(control, { userId: verified.userId, brainId: verified.brainId, name: verified.caller })
    await updateCockpitConfig((current) => current && (main
      ? { ...current, token: issued.plaintext }
      : { ...current, spaces: (current.spaces ?? []).map((s) => (s.token === oldToken ? { ...s, token: issued.plaintext } : s)) }))
    // Only once the new token is stored: a failed write must not leave a brain without one.
    core.revokeToken(control, verified.tokenId)
    say(`brain ${verified.brainId}: new token stored in the cockpit config, old token revoked. The next cockpit start writes it to the session files.`)
  } finally {
    control.close()
  }
}

export async function runAgentCommand(argv: string[]): Promise<boolean> {
  if (argv[0] === 'rotate-brain-token') {
    await rotateBrainToken(argv.slice(1))
    return true
  }
  if (argv[0] !== 'agent') return false
  const [, sub, ...rest] = argv
  if (sub === 'create') await createAgent(rest)
  else if (sub === 'status') showStatus(rest[0])
  else if (sub === 'sync-skills') syncSkills(rest)
  else throw new Error('usage: eml-cockpit agent create|status|sync-skills')
  return true
}

