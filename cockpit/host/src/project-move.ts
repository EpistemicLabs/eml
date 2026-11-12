import * as http from 'node:http'
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
 * gets the entry without it). A project the target space has an entry for
 * already (the engrams joined it) keeps that entry as it is there: its
 * sessions run in its folder, so the moved entry only fills what it lacks.
 * Returns the brain project ids that had an entry.
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
  const projectId = projectIdForBrain(brainProjectId)
  const there = target.get(projectId)
  if (there) {
    target.update(projectId, { ...(there.customName || !entry.customName ? {} : { displayName: entry.customName }), starred: there.starred || entry.starred })
    if (!there.path) carryPath(target, projectId, entry.path)
    return
  }
  target.ensureBrain(brainProjectId, entry.displayName)
  // the brain's name as the registry knew it is the display name's fallback when there is no custom one
  target.update(projectId, { displayName: entry.customName, brainName: entry.displayName, starred: entry.starred, hidden: entry.hidden })
  carryPath(target, projectId, entry.path)
}

function carryPath(target: ProjectRegistry, projectId: string, folder: string | null): void {
  if (!folder) return
  try {
    target.update(projectId, { path: folder })
  } catch (err) {
    if (!(err instanceof ProjectPathError)) throw err
  }
}

async function call(source: MoveSpace, route: string, body: Record<string, unknown>): Promise<MoveAnswer> {
  let upstream: { status: number; text: string }
  try {
    upstream = await post(`${source.url}${route}`, source.token, JSON.stringify(body))
  } catch {
    return { status: 502, body: { error: 'Failed to reach the brain API.', code: 'BRAIN_UNAVAILABLE' } }
  }
  let parsed: unknown
  try { parsed = JSON.parse(upstream.text) } catch { parsed = { error: upstream.text } }
  return { status: upstream.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { error: String(parsed) } }
}

/**
 * A POST to the (local) brain server with no time limit of its own: a move
 * waits on the relay up to the server's deadline (EML_MOVE_DEADLINE_MS, five
 * minutes) and then answers 504 SHARED_WRITE_PENDING. Node's fetch gives up
 * waiting for a response after 300 s (undici's headersTimeout) — the same
 * moment — and the move would read as "Failed to reach the brain API" while
 * it may still land.
 */
function post(url: string, token: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}
