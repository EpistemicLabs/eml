import type { ModelOption } from '../../../domain/session-runtime.js'
import { openAccountServer, spawnAccountServer, type SpawnAccountServer } from './account.js'
import { modelOption } from './chat-runtime.js'
import type { Model, ModelListResponse } from './protocol.js'

/**
 * The models a new Codex chat can start with, without a session: `model/list` from a short-lived
 * `codex app-server` of its own in the Codex home every session uses (account.ts), the same list a
 * running chat offers (chat-runtime.ts). Kept in memory for a while — the list changes with a Codex
 * update or another account, not from one minute to the next — and asked again sooner when it
 * could not be read.
 */

// A Codex release or a new model on the account shows within this.
const LIST_TTL_MS = 30 * 60_000
// Not signed in yet, offline, a slow start: tried again on the next look after this.
const FAILED_TTL_MS = 60_000
const READ_TIMEOUT_MS = 15_000
// model/list pages; more than a few pages of models is not a list a picker shows.
const MAX_PAGES = 5

/** What `model/list` offers for a chat: the models it does not hide, in its order. */
export async function listCodexModels(spawnServer: SpawnAccountServer = spawnAccountServer, timeoutMs = READ_TIMEOUT_MS): Promise<ModelOption[]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Codex did not list its models.')), timeoutMs) })
  // A process that never answers its handshake counts against the same time, and is closed once it does.
  const opening = openAccountServer(spawnServer)
  let client: Awaited<typeof opening>
  try {
    client = await Promise.race([opening, timeout])
  } catch (error) {
    clearTimeout(timer)
    void opening.then((late) => late.close(), () => {})
    throw error
  }
  try {
    const listed: Model[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer: ModelListResponse = await Promise.race([client.request('model/list', cursor ? { cursor } : {}), timeout])
      listed.push(...(Array.isArray(answer?.data) ? answer.data : []))
      cursor = typeof answer?.nextCursor === 'string' && answer.nextCursor ? answer.nextCursor : null
      if (!cursor) break
    }
    return listed.filter((model) => typeof model?.id === 'string' && model.id && !model.hidden).map(modelOption)
  } finally {
    clearTimeout(timer)
    await client.close()
  }
}

export interface CodexModelsDeps {
  /** Reads the list; rejects when Codex cannot say. */
  list?: () => Promise<ModelOption[]>
  /** The Codex version that would answer; the list is read again once it changes, and not at all without one. */
  version: () => string | null
  now?: () => number
  ttlMs?: number
  failedTtlMs?: number
}

export class CodexModels {
  private cached: { version: string; at: number; ttl: number; models: Promise<ModelOption[]> } | null = null

  constructor(private deps: CodexModelsDeps) {}

  /** The list, from memory while it is fresh; one read at a time. Empty when Codex is not set up or could not say. */
  get(): Promise<ModelOption[]> {
    const version = this.deps.version()
    if (!version) return Promise.resolve([])
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cached
    if (cached && cached.version === version && now - cached.at < cached.ttl) return cached.models
    const entry = { version, at: now, ttl: this.deps.ttlMs ?? LIST_TTL_MS, models: Promise.resolve<ModelOption[]>([]) }
    entry.models = (this.deps.list ?? (() => listCodexModels()))().then(
      (models) => {
        if (models.length === 0) entry.ttl = this.deps.failedTtlMs ?? FAILED_TTL_MS
        return models
      },
      () => {
        entry.ttl = this.deps.failedTtlMs ?? FAILED_TTL_MS
        return []
      },
    )
    this.cached = entry
    return entry.models
  }

  /** Forget the list: a sign-in ended, and another account may offer other models. */
  invalidate(): void {
    this.cached = null
  }
}
