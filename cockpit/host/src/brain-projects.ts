/**
 * Host-side read of the brain's project list (decision
 * cockpit-brain-project-model): the cockpit's project list IS the brain's
 * project list, so GET /api/projects merges these with the local registry
 * (folder, pin, hide) and the folder-only projects. Loopback + Bearer, like
 * the /api/brain proxy; a short cache absorbs the frontend's 5s poll.
 *
 * The one write is rename(): a brain project's name lives in the brain, so
 * renaming it in the sidebar changes it there — agents see the same name.
 */

export interface BrainProject {
  id: string
  name: string
  status: 'active' | 'paused' | 'archived'
  goal: string | null
}

const CACHE_TTL_MS = 5_000

/** The brain answered a rename with a non-2xx status (404: no such project). */
export class BrainRenameError extends Error {
  constructor(public status: number) {
    super(`brain PUT /project → ${status}`)
  }
}

export class BrainProjectsClient {
  private cache: { at: number; projects: BrainProject[] } | null = null
  private inflight: Promise<BrainProject[]> | null = null

  constructor(private loopbackUrl: string, private token: string) {}

  /** All brain projects (every status). Throws when the brain is unreachable. */
  async list(): Promise<BrainProject[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.projects
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  /** Last fetched list without hitting the brain (null when nothing cached). */
  cached(): BrainProject[] | null {
    return this.cache?.projects ?? null
  }

  /** Drop the cache (after the UI created a project through the proxy). */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Rename a project in the brain. Only the name changes — the id, and with it
   * every scope and relation, stays. Throws BrainRenameError on a non-2xx
   * answer and the fetch error when the brain is unreachable.
   */
  async rename(id: string, name: string): Promise<void> {
    const res = await fetch(`${this.loopbackUrl}/project/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw new BrainRenameError(res.status)
    this.invalidate()
  }

  private async fetch(): Promise<BrainProject[]> {
    const res = await fetch(`${this.loopbackUrl}/projects`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`brain /projects → ${res.status}`)
    const body = (await res.json()) as { projects?: Array<Record<string, unknown>> }
    const projects: BrainProject[] = []
    for (const p of body.projects ?? []) {
      if (typeof p.id !== 'string' || typeof p.name !== 'string') continue
      const status = p.status === 'paused' || p.status === 'archived' ? p.status : 'active'
      projects.push({ id: p.id, name: p.name, status, goal: typeof p.goal === 'string' ? p.goal : null })
    }
    this.cache = { at: Date.now(), projects }
    return projects
  }
}
