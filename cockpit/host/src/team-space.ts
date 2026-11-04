import { EmlApiError, HttpClient } from '@engramprotocol/mcp-server'
import { AccountApiError, requestGrant } from './account.js'
import type { BrainSpace } from './brain-space.js'
import { orphanBrains } from './brain-info.js'
import { addSpaceToConfig, bundledCore, issueBrainToken, provisionTeamBrain, revokeBrainToken, type AgentNames, type Core } from './provision.js'

/**
 * A shared space's host side (v0.21, spec team-brain-membership-flows-spec §4;
 * decision cockpit-identity-agent-brain: a team brain is a space like any
 * other). The brain server does everything that needs keys, the member set
 * or the relay — POST /team/create and /team/join, GET /team, the invites,
 * DELETE /team. The host does what is its own: it provisions the empty brain
 * the server founds or joins the team brain in (provision.ts), holds the
 * token, binds the agent and writes the space into the cockpit config once
 * the server took the brain, and discards a brain the server refused. Every
 * server answer passes through as it is (status, `error`, `code`), like the
 * brain proxy's.
 *
 * Secrets: the invite link comes back from the server once and goes to the
 * UI as it is — never logged, never kept. Nothing of the team file reaches
 * the host; a log line names a brain id at most.
 */

/** What the brain server answered: status and body, passed through. */
export interface TeamAnswer {
  status: number
  body: Record<string, unknown>
}

/** What a shared space needs of a space: its brain's address and token. */
export type TeamBrain = Pick<BrainSpace, 'url' | 'token'>

/** The brain server waits up to 30 s for a creation or a join to go live; the host waits a little longer than that. */
const LIVE_TIMEOUT_MS = 45_000
/** The boot-time GET /team per space: short, so a brain server that does not answer holds nothing up. */
const BOOT_TIMEOUT_MS = 3_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One call to a space's brain, the answer passed through; a server that cannot be reached answers 502 like the brain proxy. */
async function ask(brain: TeamBrain, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<TeamAnswer> {
  try {
    const answer = await new HttpClient({ url: brain.url, token: brain.token, timeoutMs }).call(method, path, body)
    return { status: answer.status, body: asObject(answer.body) }
  } catch (err) {
    if (!(err instanceof EmlApiError)) throw err
    return { status: 502, body: { error: 'Failed to reach the brain API.', code: 'BRAIN_UNAVAILABLE' } }
  }
}

const asObject = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}

// --- the shared brain as the server shows it ---

/** GET /team: the shared brain's state, read-only text, member and member set (a private brain: shared false). */
export const teamSnapshot = (brain: TeamBrain): Promise<TeamAnswer> => ask(brain, 'GET', '/team')

/** POST /team/invites: an invite link, returned once. */
export const createInvite = (brain: TeamBrain): Promise<TeamAnswer> => ask(brain, 'POST', '/team/invites')

/** POST /team/invites/:id/accept {role}: the owner confirmed the join waiting on the invite. */
export const confirmInvite = (brain: TeamBrain, inviteId: string, role: unknown): Promise<TeamAnswer> =>
  ask(brain, 'POST', `/team/invites/${encodeURIComponent(inviteId)}/accept`, role === undefined ? {} : { role })

/** POST /team/invites/:id/cancel: the invite is closed; also how an owner declines a join. */
export const cancelInvite = (brain: TeamBrain, inviteId: string): Promise<TeamAnswer> =>
  ask(brain, 'POST', `/team/invites/${encodeURIComponent(inviteId)}/cancel`)

/** DELETE /team: the server discards a brain without a log (204), or refuses (409 TEAM_BRAIN_HAS_LOG). */
const discardBrain = (brain: TeamBrain): Promise<TeamAnswer> => ask(brain, 'DELETE', '/team')

/**
 * Whether each space's brain is shared, asked of the brain server at boot —
 * in parallel, each with a short timeout. A space whose call did not answer
 * stays null (unknown), not local.
 */
export async function loadSharedFlags(spaces: BrainSpace[]): Promise<void> {
  await Promise.all(spaces.map(async (space) => {
    const answer = await ask(space, 'GET', '/team', undefined, BOOT_TIMEOUT_MS)
    space.shared = answer.status === 200 && typeof answer.body.shared === 'boolean' ? answer.body.shared : null
  }))
}

// --- create and join ---

/** What creating or joining needs of the home: the brain server, the binding every new space gets, the member handle. */
export interface TeamSpaceContext {
  url: string
  /** The agent the space binds (the main space's, as createSpace binds it). */
  agent: AgentNames
  /** The member's handle in the team brain: the token's name and ingested_by there. */
  handle: string
  core?: Core
}

/** A shared space the server took: its brain, token and the server's answer (201 live, or pending). */
export interface TeamSpaceMade {
  brainId: string
  token: string
  answer: TeamAnswer
}

/** The server or the account service refused: nothing was added, the answer passes through. */
export interface TeamSpaceRefused {
  refused: TeamAnswer
}

/**
 * A new shared brain: a creation grant from the account (signed in, in the
 * beta), the empty brain under the grant's id, then the server's create. The
 * space goes into the config once the server answered live (201) or pending
 * (504 TEAM_CREATE_PENDING: the relay took it, it finishes on its own); on
 * any other answer the brain is discarded again and nothing is added.
 */
export async function createTeamSpace(ctx: TeamSpaceContext, name: string): Promise<TeamSpaceMade | TeamSpaceRefused> {
  let grant
  try {
    grant = await requestGrant()
  } catch (err) {
    if (!(err instanceof AccountApiError)) throw err
    return { refused: { status: err.status, body: { error: { code: err.code, message: err.message } } } }
  }
  const brain = provisionTeamBrain(grant.brain, name, ctx.handle, ctx.core)
  const answer = await ask({ url: ctx.url, token: brain.token }, 'POST', '/team/create', { relay: grant.relay, grant: grant.grant, handle: ctx.handle }, LIVE_TIMEOUT_MS)
  const taken = answer.status === 201 || (answer.status === 504 && answer.body.code === 'TEAM_CREATE_PENDING')
  return taken ? keep(ctx, brain, name, answer) : refuse({ url: ctx.url, token: brain.token }, answer)
}

/** The team brain an invite link names: the UUID in its path (/i/1/<brain>/…); the server parses the rest. */
export function brainOfInviteLink(link: string): string | null {
  let url: URL
  try { url = new URL(link) } catch { return null }
  const [i, version, brain] = url.pathname.split('/').filter(Boolean)
  return i === 'i' && version === '1' && typeof brain === 'string' && UUID.test(brain) ? brain : null
}

/**
 * Joining a team brain with an invite link: the empty brain under the link's
 * brain id, then the server's join. The space goes into the config once the
 * relay has the join (202 TEAM_JOIN_PENDING) or the brain is live (201); on
 * any other answer the brain is discarded again. Called with `existing` — the
 * space this cockpit already has for that brain id (a new link after a join
 * that stopped) — the join goes to that space's brain and nothing is
 * provisioned or added; the server replaces the stopped join.
 */
export async function joinTeamSpace(ctx: TeamSpaceContext, name: string, link: string, existing?: BrainSpace): Promise<TeamSpaceMade | TeamSpaceRefused> {
  const brainId = brainOfInviteLink(link)
  if (!brainId) return { refused: { status: 400, body: { error: 'Invalid link.', code: 'INVALID_INVITE' } } }
  if (existing) {
    const answer = await ask(existing, 'POST', '/team/join', { link, handle: ctx.handle }, LIVE_TIMEOUT_MS)
    if (!joinTaken(answer)) return { refused: answer }
    existing.shared = true
    return { brainId: existing.id, token: existing.token, answer }
  }
  const brain = provisionTeamBrain(brainId, name, ctx.handle, ctx.core)
  const answer = await ask({ url: ctx.url, token: brain.token }, 'POST', '/team/join', { link, handle: ctx.handle }, LIVE_TIMEOUT_MS)
  return joinTaken(answer) ? keep(ctx, brain, name, answer) : refuse({ url: ctx.url, token: brain.token }, answer)
}

const joinTaken = (answer: TeamAnswer) => answer.status === 201 || (answer.status === 202 && answer.body.code === 'TEAM_JOIN_PENDING')

async function keep(ctx: TeamSpaceContext, brain: { brainId: string; token: string }, name: string, answer: TeamAnswer): Promise<TeamSpaceMade> {
  await addSpaceToConfig({ token: brain.token, name, agent: ctx.agent.id })
  return { brainId: brain.brainId, token: brain.token, answer }
}

/** The server refused the brain the host just provisioned: it is discarded again, the refusal passes through. */
async function refuse(brain: TeamBrain, answer: TeamAnswer): Promise<TeamSpaceRefused> {
  const discarded = await discardBrain(brain)
  if (discarded.status !== 204) console.error(`team: a brain the server refused could not be discarded (${discarded.status})`)
  return { refused: answer }
}

// --- remove ---

/**
 * DELETE /api/spaces/:id for a shared space that never came to life: the
 * server discards the brain (409 TEAM_BRAIN_HAS_LOG passes through when it
 * has a log), then the space leaves the registry and the config.
 */
export async function removeTeamSpace(space: BrainSpace, remove: (space: BrainSpace) => Promise<void>): Promise<TeamAnswer> {
  const answer = await discardBrain(space)
  if (answer.status !== 204) return answer
  await remove(space)
  return { status: 204, body: {} }
}

// --- the boot sweep ---

/**
 * The crash window between provisioning the empty brain and writing the
 * space into the config leaves a brain no token of the cockpit belongs to.
 * At boot the host asks the server to discard every such brain that has no
 * log — the server's empty-log check is the one gate; the host deletes no
 * file itself. A brain with a log is logged and left (visible, not silent),
 * one that needs intervention is not touched. The host has no token for such
 * a brain, so it issues one for the call and revokes it whatever the outcome.
 */
export async function sweepOrphanBrains(opts: { tokens: string[]; url: string; log: (line: string) => void; core?: Core }): Promise<void> {
  const core = opts.core ?? bundledCore()
  for (const brain of orphanBrains(opts.tokens)) {
    if (brain.status === 'needs_intervention') { opts.log(`brain ${brain.id}: needs intervention and has no space; left as is`); continue }
    const issued = issueBrainToken(brain.id, brain.ownerId, core)
    try {
      const answer = await discardBrain({ url: opts.url, token: issued.token })
      if (answer.status === 204) opts.log(`brain ${brain.id}: swept — empty and no space had it`)
      else if (answer.status === 409) opts.log(`brain ${brain.id}: has a log but no space; left as is`)
      else opts.log(`brain ${brain.id}: has no space and could not be checked (${answer.status}); left as is`)
    } finally {
      revokeBrainToken(issued.tokenId, core)
    }
  }
}
