import type { AgentProvider } from '../domain/agent-provider.js'
import type { ModelOption } from '../domain/session-runtime.js'

/**
 * The models each agent offers for a new chat, for the launchers' agent picker (GET /api/providers/models).
 * Only providers whose sessions can run in the chat and that are set up are listed: the picker offers no
 * other. A provider that lists its models without a session says them itself (AgentProvider.chatModels);
 * otherwise, or when it cannot say right now, the ones its last chat offered (reported-models.ts). No
 * models is an answer too: the picker then offers the agent with its default model alone.
 */

// The page waits no longer than this for a provider; a list still on its way is kept for the next look.
const ANSWER_TIMEOUT_MS = 5_000

export interface ChatModelsDeps {
  providers: AgentProvider[]
  /** The models this provider's last chat offered (reported-models.ts). */
  reported: (provider: string) => ModelOption[]
  timeoutMs?: number
}

export interface ProviderModels {
  id: string
  models: ModelOption[]
}

async function ownList(provider: AgentProvider, timeoutMs: number): Promise<ModelOption[]> {
  if (!provider.chatModels) return []
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      provider.chatModels().catch(() => []),
      new Promise<ModelOption[]>((resolve) => { timer = setTimeout(() => resolve([]), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function chatModels(deps: ChatModelsDeps): Promise<ProviderModels[]> {
  const offered = deps.providers.filter((provider) => provider.capabilities.chat.supported && provider.runtime.version() !== null)
  return Promise.all(offered.map(async (provider) => {
    const own = await ownList(provider, deps.timeoutMs ?? ANSWER_TIMEOUT_MS)
    return { id: provider.id, models: own.length > 0 ? own : deps.reported(provider.id) }
  }))
}
