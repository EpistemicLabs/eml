import type { AgentProvider, ProviderId } from '../../domain/agent-provider.js'
import { createClaudeProvider } from './claude/index.js'
import { createCodexProvider } from './codex/index.js'

export interface RegistryOptions {
  /** The provider a known session runs with (the ledger's record). */
  providerOf?: (sessionId: string) => ProviderId | undefined
  /** The provider the user wants new sessions to start with (Settings › Models). */
  preferred?: () => ProviderId | undefined
  providers?: AgentProvider[]
}

/**
 * The agent providers this host can run sessions with. A session keeps the
 * provider it was started with (the ledger records it); a new one starts with
 * the one it names, else the user's default.
 */
export class ProviderRegistry {
  private readonly providers: Map<ProviderId, AgentProvider>
  private readonly providerOf: (sessionId: string) => ProviderId | undefined
  private readonly preferred: () => ProviderId | undefined

  constructor(options: RegistryOptions = {}) {
    const providers = options.providers ?? [createClaudeProvider(), createCodexProvider()]
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.providerOf = options.providerOf ?? (() => undefined)
    this.preferred = options.preferred ?? (() => undefined)
  }

  all(): AgentProvider[] {
    return [...this.providers.values()]
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id as ProviderId)
  }

  /**
   * The provider new sessions start with unless they name another: the user's
   * choice, else the first registered. A choice whose runtime cannot start
   * sessions right now (a failed update, a missing binary) falls back to the
   * first provider that can — a plain "New session" must not run into the
   * error of a CLI the user may not even be looking at.
   */
  default(): AgentProvider {
    const preferred = this.preferred()
    const chosen = (preferred && this.providers.get(preferred)) || this.all()[0]
    if (!chosen.runtime.problem()) return chosen
    return this.all().find((provider) => !provider.runtime.problem()) ?? chosen
  }

  /** The provider that runs — or ran — this session. */
  forSession(sessionId: string): AgentProvider {
    const id = this.providerOf(sessionId)
    return (id && this.providers.get(id)) || this.default()
  }
}
