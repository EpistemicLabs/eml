/**
 * Whatever a client can send twice is done once: the client names the operation (`opId`), and the same id again within
 * the window answers what the first did, without doing it again. A page's Start clicked twice, or cockpit-spawn
 * falling back to the spawn inbox after a fetch error the host did answer, would otherwise deliver a prompt twice.
 *
 * Only what was done is kept (an outcome below 400): a refusal or a failure did nothing, so the same id runs again. A
 * repeat while the first still runs waits for it. In memory and bounded: a restart forgets them, and beyond `max` the
 * oldest go first.
 */
export interface RecentOperations<T extends { status: number }> {
  /** `work`'s outcome under `opId`; without an id the work simply runs. */
  once(opId: string | null, work: () => Promise<T>): Promise<T>
}

export function createRecentOperations<T extends { status: number }>(opts: { ttlMs: number; max: number; now: () => number }): RecentOperations<T> {
  const kept = new Map<string, { at: number; outcome: Promise<T> }>()
  const forget = (opId: string, outcome: Promise<T>) => { if (kept.get(opId)?.outcome === outcome) kept.delete(opId) }
  return {
    once(opId, work) {
      if (opId === null) return work()
      const now = opts.now()
      for (const [id, entry] of kept) if (now - entry.at > opts.ttlMs) kept.delete(id)
      const existing = kept.get(opId)
      if (existing) return existing.outcome
      const outcome = work()
      kept.set(opId, { at: now, outcome })
      while (kept.size > opts.max) kept.delete(kept.keys().next().value!)
      outcome.then((done) => { if (done.status >= 400) forget(opId, outcome) }, () => forget(opId, outcome))
      return outcome
    },
  }
}

/** How long and how many operations the host keeps (POST /api/spawn and the spawn inbox, POST /api/tasks/run). */
export const RECENT_OPERATIONS = { ttlMs: 10 * 60_000, max: 1_000 }

/** The operation id a request body names (`opId`), or null when it names none that looks like one. */
export function operationId(body: Record<string, unknown>): string | null {
  return typeof body.opId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.opId) ? body.opId : null
}
