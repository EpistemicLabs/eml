import type * as http from 'node:http'
import * as path from 'node:path'
import type { SpawnQueue, SpawnRequest } from './spawn-queue.js'
import { ownStart, unattended } from './domain/spawn-request.js'
import { workerInChat, type StartWorker } from './application/start-worker.js'
import { sessionMessaging } from './domain/agent-provider.js'
import type { MessageRequest } from './application/deliver-message.js'
import type { DeliveryOutcome } from './domain/session-delivery.js'
import { brainIdFromProjectId, projectIdForBrain } from './project-registry.js'
import { sessionAddress } from './session-address.js'
import { type BrainSpace, type BrainSpaces } from './brain-space.js'
import { parseToolProfile } from './domain/tool-profile.js'
import type { SessionLedger } from './session-ledger.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { routeToTaskHolder, takenSince, type LeaseRefusal, type RouteDeps } from './application/task-lease.js'
import { operationId, type RecentOperations } from './application/recent-operations.js'

/**
 * Worker spawns (skill spawn-session → cockpit-spawn → here):
 *   POST /api/spawn              from a session; X-Cockpit-Token = the per-boot
 *                                spawn token the host puts into every session's env.
 *                                Body: project, prompt, title?, provider?, fromSession?,
 *                                task? (the brain task it works on), step? (its task is a new step of the requester's)
 *                                or newTask? { title, in?, text? } (the host creates that task first, in project `in`
 *                                or else the worker's), opId? (the same id again answers the first outcome without
 *                                starting or delivering again, application/recent-operations.ts)
 *   <home>/spawn-inbox           the same request as a file, for sessions whose
 *                                sandbox has no network (spawn-inbox.ts)
 *   POST /api/spawns/<id>/claim  from the cockpit page (same-origin guarded in
 *                                http.ts); the first tab wins and opens the pane,
 *                                with the request id as the worker's session id.
 *                                A chat worker starts here; the answer's `runtime` says so
 * plus the `spawns` / `spawn` / `claimed` / `revoked` events on /api/events.
 *
 * One live session per task (domain/task-lease.ts): a worker asked for on an existing task (`task`) that a session
 * holds is not started; its prompt goes to that session as a message, and the answer names that session with
 * `routed: true`. A task with a request pending, or whose holder cannot take the message, refuses the spawn.
 *
 *   POST /api/sessions/<target>/message  a message for a session, by id or address; with the
 *                                spawn token, or from outside with the message token (message-token.ts)
 * The same token and inbox carry a session naming itself (session-title-cli.ts):
 *   PUT /api/session-title/<id> body: title — or the inbox request with kind 'session-title'.
 */

export interface SpawnDeps {
  spawns: SpawnQueue
  /** The agent CLIs a worker may run with (`provider` in the request). */
  providers: ProviderRegistry
  spawnToken: string
  /** The worker runs in the requesting session's space (ledger), else main. */
  spaces: BrainSpaces
  ledger: SessionLedger
  /** The message endpoint's use case (application/deliver-message.ts). */
  deliver: (request: MessageRequest) => Promise<DeliveryOutcome>
  /** A session named itself: its placeholder task takes the name (application/session-task.ts). */
  sessionNamed?: (sessionId: string, title: string) => void
  /** Task system: create a brain task in the space (spawn newTask); its id, or an error text. */
  createTask?: (space: BrainSpace, input: { title: string; content: string; scope: string; fromTaskId?: string }) => Promise<{ id: string } | { error: string }>
  /** How full a session's context is, from its provider's summary; null when unknown. Without it a holder is never replaced. */
  contextTokensOf?: (sessionId: string) => number | null
  /** Put a session away (stop it and archive it); an error text when it cannot be now, e.g. it is in a turn. */
  putAway?: (sessionId: string) => Promise<string | null>
  /** Why a queued request must not start any more (domain/task-lease.ts staleRunnerRequest), or null when it may. */
  stale?: (request: SpawnRequest) => string | null
  /** The outcomes of recent spawns by their opId, shared by POST /api/spawn and the inbox; without it each one runs. */
  operations?: RecentOperations<SpawnOutcome>
}

const MAX_PROMPT = 50_000
const MAX_TITLE = 60

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/**
 * A project as a session names it: the registry id, a brain project id or
 * name, or a folder path the cockpit already knows.
 */
export async function resolveProject(space: BrainSpace, input: string): Promise<string | null> {
  if (space.registry.get(input)) return input
  if (path.isAbsolute(input) || input === '~' || /^~[\\/]/.test(input)) {
    return space.registry.getByPath(input)?.projectId ?? null
  }
  const bare = input.startsWith('bp-') ? input.slice(3) : input
  const brain = await space.projects.list().catch(() => [])
  const match = brain.find((p) => p.id === bare) ?? brain.find((p) => p.name.toLowerCase() === input.toLowerCase())
  return match ? projectIdForBrain(match.id) : null
}

export interface SpawnOutcome {
  status: number
  /**
   * `address`: the worker's address for SendMessage (session-address.ts) — absent when its provider has no such messaging.
   * `routed`: no worker was queued; the task's session (`id`) got the prompt as a message (`queued` is then false).
   */
  payload: { id: string; projectId: string; queued: boolean; address?: string; taskId?: string; routed?: true } | { error: { code: string; message: string; retry?: boolean } }
}

/** A refusal of the task's lease (application/task-lease.ts): 409, with whether trying again later can help. */
export const leaseRefused = ({ code, message, retry }: LeaseRefusal): SpawnOutcome => ({ status: 409, payload: { error: { code, message, retry } } })

/** What routing a start on a task to its holder reads from the spawn deps. */
export const routeDepsOf = (deps: Pick<SpawnDeps, 'spawns' | 'ledger' | 'deliver' | 'contextTokensOf' | 'putAway'>): RouteDeps => ({
  pending: () => deps.spawns.list(), sessions: () => deps.ledger.list(), deliver: deps.deliver,
  ...(deps.contextTokensOf ? { contextTokensOf: deps.contextTokensOf } : {}), ...(deps.putAway ? { putAway: deps.putAway } : {}),
})

/**
 * Queue a worker request from a session — the one rule for both ways a request
 * arrives (POST /api/spawn, the spawn inbox). The caller has checked the token.
 * A request naming an operation (`opId`) the host saw lately gets that one's outcome: nothing starts or is delivered again.
 */
export async function requestSpawn(deps: SpawnDeps, body: Record<string, unknown>): Promise<SpawnOutcome> {
  const opId = operationId(body)
  if (!deps.operations || !opId) return queueSpawn(deps, body)
  return deps.operations.once(`${typeof body.fromSession === 'string' ? body.fromSession : ''}:${opId}`, () => queueSpawn(deps, body))
}

async function queueSpawn(deps: SpawnDeps, body: Record<string, unknown>): Promise<SpawnOutcome> {
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
  // Task system: an existing task to work on, or a new step of the requester's task; neither = a task of its own.
  const taskId = typeof body.task === 'string' && body.task.trim() ? body.task.trim() : null
  const stepOf = body.step === true ? (fromSessionId ? deps.ledger.get(fromSessionId)?.taskId ?? null : null) : null
  if (body.step === true && !stepOf) return fail(400, 'NO_TASK_FOR_STEP', 'step needs a requesting session that works on a task')
  const newTask = body.newTask && typeof body.newTask === 'object' ? body.newTask as Record<string, unknown> : null
  if ([taskId, stepOf, newTask].filter(Boolean).length > 1) return fail(400, 'TASK_OR_STEP', 'Give one of task, step and newTask')
  const toolProfile = parseToolProfile(body)
  if (toolProfile === 'invalid') return fail(400, 'INVALID_TOOLS', 'deniedTools and mcpServers are lists of names')
  const chosen = provider ?? deps.providers.default()
  if (toolProfile && !workerInChat(chosen, { toolProfile })) {
    const limits = chosen.capabilities.toolLimits
    return fail(400, 'TOOLS_NEED_CHAT', limits.supported ? 'Tool limits need the chat runtime, which this provider or sign-in does not use' : limits.reason)
  }
  // An existing task that a session or a pending request holds gets no second session (application/task-lease.ts).
  let replaced: string | null = null
  if (taskId) {
    const requester = fromSessionId ? deps.ledger.get(fromSessionId) : undefined
    const from = requester && fromSessionId ? sessionAddress(fromSessionId, requester.projectId) : null
    const route = await routeToTaskHolder(routeDepsOf(deps), { taskId, prompt, fromSessionId, from })
    if (route.kind === 'refused') return leaseRefused(route.refusal)
    if (route.kind === 'routed') {
      const holder = deps.ledger.get(route.session.sessionId)
      const holderProject = holder?.projectId ?? projectId
      const messaging = sessionMessaging(deps.providers.forSession(route.session.sessionId), holder).supported
      return { status: 200, payload: { id: route.session.sessionId, projectId: holderProject, queued: false, routed: true, taskId, ...(messaging ? { address: sessionAddress(route.session.sessionId, holderProject) } : {}) } }
    }
    replaced = route.replaced
  }
  // newTask: the task is made before the worker is queued, so it starts on it.
  let givenTask = taskId
  if (newTask) {
    const title = typeof newTask.title === 'string' ? newTask.title.trim() : ''
    if (!title) return fail(400, 'INVALID_NEW_TASK', 'newTask needs a title')
    if (!deps.createTask) return fail(400, 'NO_TASK_SYSTEM', 'This cockpit cannot create tasks')
    const inProject = typeof newTask.in === 'string' && newTask.in.trim() ? await resolveProject(space, newTask.in.trim()) : projectId
    if (!inProject) return fail(404, 'UNKNOWN_PROJECT', `Unknown project "${String(newTask.in)}" for the new task`)
    const brainId = brainIdFromProjectId(inProject)
    // A task belongs to a project of the brain; a folder-only project has none.
    if (!brainId) return fail(400, 'NEW_TASK_NEEDS_PROJECT', `The new task needs a project of the brain, and ${typeof newTask.in === 'string' && newTask.in.trim() ? `"${newTask.in.trim()}"` : 'this session\'s project'} is a folder only. Name one with in.`)
    const requester = fromSessionId ? deps.ledger.get(fromSessionId) : undefined
    const from = fromSessionId ? ` Started by session ${requester?.title ?? requester?.agentTitle ?? fromSessionId}.` : ''
    const text = typeof newTask.text === 'string' && newTask.text.trim() ? newTask.text.trim() : title
    const created = await deps.createTask(space, { title, content: `${text}${from}`, scope: `project.${brainId}`, ...(requester?.taskId ? { fromTaskId: requester.taskId } : {}) })
    if ('error' in created) return fail(400, 'NEW_TASK_FAILED', `The task could not be created: ${created.error}`)
    givenTask = created.id
  }
  // The lease once more, in the same tick as the add: nothing took the task since it was asked above.
  const taken = taskId ? takenSince(routeDepsOf(deps), taskId, replaced) : null
  if (taken) return leaseRefused(taken)
  const request = deps.spawns.add({
    projectId,
    prompt,
    ...(provider ? { provider: provider.id } : {}),
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : null,
    fromSessionId,
    ...(body.open === true ? { open: true } : {}),
    ...(body.wakeable === true ? { wakeable: true } : {}),
    ...(toolProfile ? { toolProfile } : {}),
    ...(givenTask ? { taskId: givenTask } : {}),
    // Named for a further space only; main is the default on both sides.
    ...(space.main ? {} : { spaceId: space.id }),
  })
  if (stepOf) deps.ledger.expectTaskParent(request.id, stepOf)
  // The request id becomes the worker's session id (the page opens the pane
  // under it), so the requester learns the worker's address before it runs.
  // Where it will run decides it for a provider that takes messages in the chat only (Codex).
  const runtime = (unattended(request) || ownStart(request)) && workerInChat(chosen, request) ? 'sdk' : 'terminal'
  const messaging = sessionMessaging(chosen, { runtime }).supported
  return { status: 202, payload: { id: request.id, projectId, queued: true, ...(messaging ? { address: sessionAddress(request.id, projectId) } : {}), ...(givenTask ? { taskId: givenTask } : {}) } }
}

/**
 * A session names itself — the one rule for both ways a request arrives (PUT
 * /api/session-title/<id>, the spawn inbox). The caller has checked the token.
 * Without a task the title goes into the ledger's agentTitle (a title the user chose wins); with one it can only
 * name a placeholder task.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/** What the agent of a session with a task learns when it names itself: the name lives on the task. */
export const TASKED_TITLE_NOTE = 'This session goes by its task\'s name; the title names the task only while it has none. Rename the task with eml_track_task display_title.'

export function requestSessionTitle(deps: Pick<SpawnDeps, 'ledger' | 'sessionNamed'>, sessionId: unknown, body: Record<string, unknown>): SpawnOutcome | { status: 200; payload: { title: string; note?: string } } {
  const fail = (status: number, code: string, message: string): SpawnOutcome => ({ status, payload: { error: { code, message } } })
  // Control characters and bidi overrides would let a title disguise itself in the sidebar.
  const title = typeof body.title === 'string'
    ? body.title.replace(/\s+/g, ' ').replace(INVISIBLE, '').trim()
    : ''
  if (!title || title.length > MAX_TITLE) return fail(400, 'INVALID_TITLE', `title is required (max ${MAX_TITLE} chars)`)
  const known = typeof sessionId === 'string' && sessionId ? deps.ledger.get(sessionId) : undefined
  if (!known) return fail(404, 'NOT_FOUND', 'Session not found')
  // A session with a task is called by its task: the title can only name a task that
  // has no name yet (session-task.ts named), and is not kept as the session's own.
  if (!known.taskId) deps.ledger.setAgentTitle(sessionId as string, title)
  deps.sessionNamed?.(sessionId as string, title)
  return { status: 200, payload: known.taskId ? { title, note: TASKED_TITLE_NOTE } : { title } }
}

const DELIVERY_STATUS: Record<DeliveryOutcome, number> = { delivered: 200, resumed: 200, busy: 409, unknown: 404, refused: 403, running: 409 }

/**
 * A message for a session — the one rule for all ways it arrives (POST
 * /api/sessions/<target>/message, the spawn inbox). The caller has checked the token.
 */
export async function requestMessage(
  deps: Pick<SpawnDeps, 'deliver'>, caller: MessageRequest['caller'], target: unknown, body: Record<string, unknown>,
): Promise<{ status: number; payload: { outcome: DeliveryOutcome } | { error: { code: string; message: string } } }> {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > MAX_PROMPT) return { status: 400, payload: { error: { code: 'INVALID_TEXT', message: `text is required (max ${MAX_PROMPT} chars)` } } }
  if (typeof target !== 'string' || !target) return { status: 400, payload: { error: { code: 'INVALID_TARGET', message: 'target is required' } } }
  const from = typeof body.from === 'string' ? body.from.replace(INVISIBLE, '').trim().slice(0, MAX_TITLE) : ''
  const outcome = await deps.deliver({ target, text, from: from || null, caller, ...(typeof body.onlyIfStoppedFor === 'string' ? { onlyIfStoppedFor: body.onlyIfStoppedFor } : {}) })
  return { status: DELIVERY_STATUS[outcome], payload: { outcome } }
}

export async function handleSpawnApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SpawnDeps & { workers: StartWorker; outsideToken: string },
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

  const message = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_.:-]+)\/message$/)
  if (message && method === 'POST') {
    const token = req.headers['x-cockpit-token']
    const caller = token === deps.spawnToken ? 'session' : token === deps.outsideToken ? 'outside' : null
    if (!caller) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session or a service holding the message token can send this' } })
      return true
    }
    const result = await requestMessage(deps, caller, message[1], await readJson(req))
    json(res, result.status, result.payload)
    return true
  }

  const named = pathname.match(/^\/api\/session-title\/([0-9a-f-]{36})$/)
  if (named && method === 'PUT') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can name itself' } })
      return true
    }
    const result = requestSessionTitle(deps, named[1], await readJson(req))
    json(res, result.status, result.payload)
    return true
  }

  const claim = pathname.match(/^\/api\/spawns\/([0-9a-f-]{36})\/claim$/)
  if (claim && method === 'POST') {
    // Without room it stays queued, and the host starts it once there is (worker-start.ts).
    const waiting = deps.spawns.list().find((candidate) => candidate.id === claim[1])
    // Fencing: a runner request whose task someone took over meanwhile is revoked, not handed out (domain/task-lease.ts).
    const stale = waiting ? deps.stale?.(waiting) ?? null : null
    if (waiting && stale) {
      deps.spawns.revoke(waiting.id, stale)
      json(res, 409, { error: { code: 'REVOKED', message: `No longer needed: ${stale}`, retry: false } })
      return true
    }
    if (waiting && unattended(waiting) && !deps.workers.hasRoom()) {
      json(res, 409, { error: { code: 'NO_ROOM', message: 'Too little free memory for another worker right now' } })
      return true
    }
    const request = deps.spawns.claim(claim[1])
    if (!request) {
      json(res, 409, { error: { code: 'ALREADY_CLAIMED', message: 'Taken by another tab or expired' } })
      return true
    }
    const runtime = deps.workers.forPane(request)
    if (runtime) json(res, 200, { ...request, runtime })
    else json(res, 500, { error: { code: 'NOT_STARTED', message: 'The worker could not start; the host log says why' } })
    return true
  }
  return false
}

/** Wire spawn requests into an /api/events stream; returns the detach function. */
export function attachSpawnEvents(spawns: SpawnQueue, send: (event: string, data: unknown) => void): () => void {
  const leave = spawns.watch()
  send('spawns', spawns.list())
  const onSpawn = (request: SpawnRequest) => send('spawn', request)
  const onClaimed = (id: string) => send('claimed', { id })
  // A revoked request is gone like a claimed one: tabs drop it.
  const onRevoked = (id: string) => send('revoked', { id })
  spawns.on('spawn', onSpawn)
  spawns.on('claimed', onClaimed)
  spawns.on('revoked', onRevoked)
  return () => {
    leave()
    spawns.off('spawn', onSpawn)
    spawns.off('claimed', onClaimed)
    spawns.off('revoked', onRevoked)
  }
}
