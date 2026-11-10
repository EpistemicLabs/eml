import { brainIdFromProjectId, projectIdForBrain, ProjectPathError, type ProjectEntry, type ProjectRegistry } from './project-registry.js'
import type { BrainProjectsClient } from './brain-projects.js'

/**
 * Moving a project into a shared space (v0.21, spec team-brain-move-project-spec
 * §5; decision move-project-deterministic-ui). The brain server does the move
 * (POST /move/plan, POST /move on the source brain's token — the plan with
 * every reason it would be refused, the run against the plan's hash). The
 * host adds what is its own: the target named as a space, and the cockpit's
 * local state of the project — its folder, pin, hidden flag and custom name
 * in the source space's registry — re-homed into the target's registry once
 * the brain says the project moved. The server's answers pass through as they
 * are (status, `error`, `code`), like the brain proxy's.
 */

/** What the move needs of a space: its brain, and the cockpit's local state for it. */
export interface MoveSpace {
  id: string
  /** The space's display name; recorded on the archived project as where it went (eml_show names it). */
  name: string
  url: string
  token: string
  registry: ProjectRegistry
  projects: Pick<BrainProjectsClient, 'invalidate'>
}

export interface MoveAnswer {
  status: number
  body: Record<string, unknown>
}

/** The brain project id behind a route's project id: the sidebar's `bp-<id>`, or the id itself. */
export function brainProjectOf(projectId: string): string {
  return brainIdFromProjectId(projectId) ?? projectId
}

/** GET …/move-plan: the server's plan for moving `project` from `source` into `target`. Reads only. */
export async function planProjectMove(source: MoveSpace, target: MoveSpace, project: string): Promise<MoveAnswer> {
  return call(source, '/move/plan', { target: target.id, project })
}

/**
 * POST …/move: the server runs the move the user confirmed (plan_hash); on
 * success the cockpit's local state of every project the move emptied goes
 * from the source space's registry to the target's, and both project lists
 * are read again. `rehomed` names the project ids whose entry moved.
 */
export async function moveProject(source: MoveSpace, target: MoveSpace, project: string, planHash: string): Promise<MoveAnswer> {
  const answer = await call(source, '/move', { target: target.id, target_name: target.name, project, plan_hash: planHash })
  source.projects.invalidate()
  if (answer.status !== 200) return answer
  target.projects.invalidate()
  const archived = Array.isArray(answer.body.archived) ? (answer.body.archived as unknown[]).filter((id): id is string => typeof id === 'string') : []
  return { status: 200, body: { ...answer.body, rehomed: rehome(source.registry, target.registry, archived) } }
}

/**
 * The local entries of the moved projects, carried over: display name, pin,
 * hidden, folder. A folder that no longer exists is left behind (the target
 * gets the entry without it). Returns the brain project ids that had an entry.
 */
export function rehome(source: ProjectRegistry, target: ProjectRegistry, brainProjectIds: string[]): string[] {
  const moved: string[] = []
  for (const brainProjectId of brainProjectIds) {
    const projectId = projectIdForBrain(brainProjectId)
    const entry = source.get(projectId)
    if (!entry) continue
    carry(target, brainProjectId, entry)
    source.remove(projectId)
    moved.push(brainProjectId)
  }
  return moved
}

function carry(target: ProjectRegistry, brainProjectId: string, entry: ProjectEntry): void {
  target.ensureBrain(brainProjectId, entry.displayName)
  const projectId = projectIdForBrain(brainProjectId)
  // the brain's name as the registry knew it is the display name's fallback when there is no custom one
  target.update(projectId, { displayName: entry.customName, brainName: entry.displayName, starred: entry.starred, hidden: entry.hidden })
  if (entry.path) {
    try {
      target.update(projectId, { path: entry.path })
    } catch (err) {
      if (!(err instanceof ProjectPathError)) throw err
    }
  }
}

async function call(source: MoveSpace, route: string, body: Record<string, unknown>): Promise<MoveAnswer> {
  let upstream: Response
  try {
    upstream = await fetch(`${source.url}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${source.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { status: 502, body: { error: 'Failed to reach the brain API.', code: 'BRAIN_UNAVAILABLE' } }
  }
  const text = await upstream.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = { error: text } }
  return { status: upstream.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { error: String(parsed) } }
}
