import type { CockpitConfig } from './config.js'
import { brainForLocalToken } from './brain-info.js'

/**
 * The home's agent brains (decision cockpit-identity-agent-brain): every agent
 * is its own brain in control.db, named after the agent id, holding the
 * agent's persona, rules and learnings and its view of the people it works
 * with (scopes agent.<id> and user.<handle>). A space binds one agent
 * (config: `agent`, `spaces[].agent`); the same agent may be bound to several
 * spaces and is the same agent in each.
 *
 * The brain's token is the host's alone: a session reaches its agent brain
 * only through the host's brain MCP endpoint (brain-mcp.ts), which routes the
 * identity engrams there and stamps every write with the agent.
 */
export interface AgentBrain {
  /** The agent id: the brain's name in control.db and the agent.<id> scope. */
  id: string
  /** The brain's id in control.db (= the genesis brain id a cross-brain reference names). */
  brainId: string
  /** Base URL of the brain server the agent brain lives on. */
  url: string
  token: string
}

export class AgentBrains {
  private readonly byId = new Map<string, AgentBrain>()

  constructor(agents: AgentBrain[] = []) {
    for (const agent of agents) this.byId.set(agent.id, agent)
  }

  add(agent: AgentBrain): void {
    this.byId.set(agent.id, agent)
  }

  get(id: string | null | undefined): AgentBrain | undefined {
    return id ? this.byId.get(id) : undefined
  }

  list(): AgentBrain[] {
    return [...this.byId.values()]
  }
}

/**
 * The agent brains of the config, each checked against control.db: the token
 * must belong to a brain named after the agent id. An entry that does not is
 * reported and skipped — the spaces bound to it then have no agent.
 */
export function loadAgentBrains(config: CockpitConfig | null, url: string, log: (line: string) => void): AgentBrains {
  const agents = new AgentBrains()
  for (const entry of config?.agents ?? []) {
    const row = brainForLocalToken(entry.token)
    if (!row) { log(`agent ${entry.id}: the configured token matches no brain — skipped`); continue }
    if (row.name !== entry.id) { log(`agent ${entry.id}: its token belongs to brain "${row.name}" — skipped`); continue }
    agents.add({ id: entry.id, brainId: row.id, url, token: entry.token })
  }
  return agents
}
