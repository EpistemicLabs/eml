import type * as http from 'node:http'
import * as os from 'node:os'
import type { SpawnQueue, SpawnRequest } from './spawn-queue.js'
import { projectIdForBrain } from './project-registry.js'
import type { BrainSpace, BrainSpaces } from './brain-space.js'
import type { SessionLedger } from './session-ledger.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'

/**
 * Worker spawns (skill spawn-session → cockpit-spawn → here):
 *   POST /api/spawn              from a session; X-Cockpit-Token = the per-boot
 *                                spawn token the host puts into every session's env.
 *                                Body: project, prompt, title?, provider?, fromSession?
 *   <home>/spawn-inbox           the same request as a file, for sessions whose
 *                                sandbox has no network (spawn-inbox.ts)
 *   POST /api/spawns/<id>/claim  from the cockpit page (same-origin guarded in
 *                                http.ts); the first tab wins and opens the pane
 * plus the `spawns` / `spawn` / `claimed` events on /api/events.
 */

export interface SpawnDeps {
  spawns: SpawnQueue
  /** The agent CLIs a worker may run with (`provider` in the request). */
  providers: ProviderRegistry
  spawnToken: string
  /** The worker runs in the requesting session's space (ledger), else main. */
  spaces: BrainSpaces
  ledger: SessionLedger
}

const MAX_PROMPT = 50_000

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/**
 * A project as a session names it: the registry id, a brain project id or
 * name, or a folder path the cockpit already knows.
 */
async function resolveProject(space: BrainSpace, input: string): Promise<string | null> {
  if (space.registry.get(input)) return input
  if (input.startsWith('/') || input.startsWith('~')) {
    const expanded = input.startsWith('~') ? os.homedir() + input.slice(1) : input
    return space.registry.getByPath(expanded)?.projectId ?? null
  }
  const bare = input.startsWith('bp-') ? input.slice(3) : input
  const brain = await space.projects.list().catch(() => [])
  const match = brain.find((p) => p.id === bare) ?? brain.find((p) => p.name.toLowerCase() === input.toLowerCase())
  return match ? projectIdForBrain(match.id) : null
}

export interface SpawnOutcome {
  status: number
  payload: { id: string; projectId: string; queued: true } | { error: { code: string; message: string } }
}

/**
 * Queue a worker request from a session — the one rule for both ways a request
 * arrives (POST /api/spawn, the spawn inbox). The caller has checked the token.
 */
export async function requestSpawn(deps: SpawnDeps, body: Record<string, unknown>): Promise<SpawnOutcome> {
  const fail = (status: number, code: string, message: string): SpawnOutcome => ({ status, payload: { error: { code, message } } })
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const project = typeof body.project === 'string' ? body.project.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT) return fail(400, 'INVALID_PROMPT', `prompt is required (max ${MAX_PROMPT} chars)`)
  const fromSessionId = typeof body.fromSession === 'string' && body.fromSession ? body.fromSession : null
  const space = deps.spaces.resolve(fromSessionId ? deps.ledger.get(fromSessionId)?.spaceId : null)
  const projectId = project ? await resolveProject(space, project) : null
  if (!projectId) {
    const known = [
      ...(await space.projects.list().catch(() => [])).map((p) => p.id),
      ...space.registry.list().filter((p) => p.kind === 'folder').map((p) => p.path),
    ]
    return fail(404, 'UNKNOWN_PROJECT', `Unknown project "${project}". Known: ${known.join(', ')}`)
  }
  const provider = typeof body.provider === 'string' && body.provider ? deps.providers.get(body.provider) : undefined
  if (typeof body.provider === 'string' && body.provider && !provider) {
    return fail(400, 'UNKNOWN_PROVIDER', `Unknown provider "${body.provider}". Known: ${deps.providers.all().map((p) => p.id).join(', ')}`)
  }
  const request = deps.spawns.add({
    projectId,
    prompt,
    ...(provider ? { provider: provider.id } : {}),
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : null,
    fromSessionId,
    // Named for a further space only; main is the default on both sides.
    ...(space.main ? {} : { spaceId: space.id }),
  })
  return { status: 202, payload: { id: request.id, projectId, queued: true } }
}

export async function handleSpawnApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SpawnDeps,
  pathname: string,
  method: string,
  json: Json,
  readJson: ReadJson,
): Promise<boolean> {
  if (pathname === '/api/spawn' && method === 'POST') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Spawning is only possible from a cockpit session' } })
      return true
    }
    const result = await requestSpawn(deps, await readJson(req))
    json(res, result.status, result.payload)
    return true
  }

  const claim = pathname.match(/^\/api\/spawns\/([0-9a-f-]{36})\/claim$/)
  if (claim && method === 'POST') {
    const request = deps.spawns.claim(claim[1])
    if (!request) json(res, 409, { error: { code: 'ALREADY_CLAIMED', message: 'Taken by another tab or expired' } })
    else json(res, 200, request)
    return true
  }
  return false
}

/** Wire spawn requests into an /api/events stream; returns the detach function. */
export function attachSpawnEvents(spawns: SpawnQueue, send: (event: string, data: unknown) => void): () => void {
  send('spawns', spawns.list())
  const onSpawn = (request: SpawnRequest) => send('spawn', request)
  const onClaimed = (id: string) => send('claimed', { id })
  spawns.on('spawn', onSpawn)
  spawns.on('claimed', onClaimed)
  return () => {
    spawns.off('spawn', onSpawn)
    spawns.off('claimed', onClaimed)
  }
}
