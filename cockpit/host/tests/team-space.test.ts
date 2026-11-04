import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home and the account URL at import time — set them before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-team-space-test-'))
process.env.EML_COCKPIT_HOME = home
process.env.EML_ACCOUNT_URL = 'http://account.test/'

const require = createRequire(import.meta.url)
const core = require('@engramprotocol/core')
const Database = require('better-sqlite3')

// A shared space's host side (team-space.ts, spec team-brain-membership-flows-spec
// §4) against a stand-in brain server and a stubbed account service, with the
// real core provisioning the empty brain: create and join put the space into
// the config only once the server took the brain, a refused brain is
// discarded again, a new link goes to the space the cockpit has, a shared
// space without a log is removed, the boot sweep discards what a crash left.

interface Seen { method: string; url: string; auth: string | undefined; body: Record<string, unknown> }
type Answer = { status: number; body?: unknown }

const BRAIN_A = '0f7c2b8e-4d3a-4c1b-9a6e-2b5d8f1e3c7a'
const BRAIN_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const BRAIN_C = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'
const BRAIN_D = '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f'
const BRAIN_E = '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a'
const BRAIN_F = '5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8a9b'
const GRANT = { grant: 'g.' + 'A'.repeat(40), relay: 'wss://relay.test', expires_at: '2026-11-04T12:00:00.000Z' }
const link = (brain: string) => `https://relay.test/i/1/${brain}/abcdefghijklmnopqrstuv#${'B'.repeat(43)}`

let server: Server
let url: string
const seen: Seen[] = []
/** What the stand-in brain server answers next, by "METHOD /path". */
const brainAnswers = new Map<string, Answer | ((call: Seen) => Answer)>()
/** What the stubbed account service answers next, by path. */
const accountAnswers = new Map<string, Answer>()
const accountSeen: Array<{ path: string; auth?: string }> = []

const SESSION = 'emla_' + 'S'.repeat(43)
const signedIn = () => writeFileSync(join(home, 'account'), JSON.stringify({ url: 'http://account.test', email: 'alex@example.com', session: SESSION }), { mode: 0o600 })

let mods: {
  team: typeof import('../src/team-space.js')
  provision: typeof import('../src/provision.js')
  config: typeof import('../src/config.js')
  DATA_DIR: string
}
let main: { token: string; brainId?: string }
let agentToken: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const call: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} }
      seen.push(call)
      const key = `${call.method} ${call.url}`
      const answer = brainAnswers.get(key)
      const { status, body } = typeof answer === 'function' ? answer(call) : answer ?? { status: 404, body: { error: `no answer for ${key}` } }
      res.statusCode = status
      if (body === undefined) { res.end(); return }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The account service is stubbed; everything else (the stand-in brain server) is fetched for real.
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input instanceof Request ? input.url : input))
    if (target.origin !== 'http://account.test') return realFetch(input, init)
    accountSeen.push({ path: target.pathname, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
    const answer = accountAnswers.get(target.pathname) ?? { status: 404, body: { error: 'not_found' } }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
  })

  const provision = await import('../src/provision.js')
  const team = await import('../src/team-space.js')
  const config = await import('../src/config.js')
  const { DATA_DIR } = await import('../src/paths.js')
  mods = { team, provision, config, DATA_DIR }
  main = await provision.provisionBrain({ userId: 'alex', userName: 'Alex Doe', agentId: 'juno', agentName: 'Juno' }, core)
  agentToken = (await config.readCockpitConfig())?.agents?.[0].token as string
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
})
beforeEach(() => {
  seen.length = 0
  accountSeen.length = 0
  brainAnswers.clear()
  accountAnswers.clear()
  rmSync(join(home, 'account'), { force: true })
})

const ctx = () => ({ url, agent: { id: 'juno', name: 'Juno' }, handle: 'alex', core })
const spaces = async () => (await mods.config.readCockpitConfig())?.spaces ?? []

/** The control rows of one brain: its row and its tokens (name, revoked). */
function controlRows(brainId: string) {
  const control = new Database(join(mods.DATA_DIR, 'control.db'), { readonly: true })
  try {
    const brain = control.prepare('SELECT id, name, status FROM brains WHERE id = ?').get(brainId) as { id: string; name: string; status: string } | undefined
    const tokens = control.prepare('SELECT name, revoked_at FROM tokens WHERE brain_id = ? ORDER BY rowid').all(brainId) as Array<{ name: string; revoked_at: string | null }>
    return { brain, tokens }
  } finally {
    control.close()
  }
}

describe('brainOfInviteLink', () => {
  it('reads the brain id from the link\'s path and nothing else', async () => {
    const { brainOfInviteLink } = mods.team
    expect(brainOfInviteLink(link(BRAIN_A))).toBe(BRAIN_A)
    expect(brainOfInviteLink('https://relay.test/i/2/' + BRAIN_A + '/x')).toBeNull()
    expect(brainOfInviteLink('https://relay.test/i/1/not-a-uuid/x')).toBeNull()
    expect(brainOfInviteLink('not a link')).toBeNull()
  })
})

describe('createTeamSpace', () => {
  it('asks the account for a grant, provisions the empty brain under its id, founds it on the server and writes the space into the config', async () => {
    signedIn()
    accountAnswers.set('/v1/grants', { status: 200, body: { brain: BRAIN_A, ...GRANT } })
    brainAnswers.set('POST /team/create', { status: 201, body: { brain: BRAIN_A, member: 'fp', handle: 'alex' } })

    const result = await mods.team.createTeamSpace(ctx(), 'Team')
    expect('refused' in result).toBe(false)
    const made = result as import('../src/team-space.js').TeamSpaceMade
    expect(made.brainId).toBe(BRAIN_A)
    expect(made.answer).toEqual({ status: 201, body: { brain: BRAIN_A, member: 'fp', handle: 'alex' } })

    expect(accountSeen).toEqual([{ path: '/v1/grants', auth: `Bearer ${SESSION}` }])
    expect(seen).toEqual([{ method: 'POST', url: '/team/create', auth: `Bearer ${made.token}`, body: { relay: GRANT.relay, grant: GRANT.grant, handle: 'alex' } }])
    // The brain: the space's name in control.db, the token under the member handle, no seed, no genesis.
    expect(controlRows(BRAIN_A)).toEqual({ brain: { id: BRAIN_A, name: 'Team', status: 'ok' }, tokens: [{ name: 'alex', revoked_at: null }] })
    const brain = new Database(join(mods.DATA_DIR, 'brains', `${BRAIN_A}.db`), { readonly: true })
    try {
      expect((brain.prepare('SELECT COUNT(*) AS n FROM engrams').get() as { n: number }).n).toBe(0)
      expect((brain.prepare('SELECT COUNT(*) AS n FROM op_log').get() as { n: number }).n).toBe(0)
    } finally {
      brain.close()
    }
    expect(await spaces()).toEqual([{ token: made.token, name: 'Team', agent: 'juno' }])
  })

  it('keeps a brain the relay took but that is not live yet (504 TEAM_CREATE_PENDING)', async () => {
    signedIn()
    accountAnswers.set('/v1/grants', { status: 200, body: { brain: BRAIN_B, ...GRANT } })
    brainAnswers.set('POST /team/create', { status: 504, body: { error: 'The relay took the new brain but it is not live yet; it will finish on its own.', code: 'TEAM_CREATE_PENDING' } })
    const result = await mods.team.createTeamSpace(ctx(), 'Pending') as import('../src/team-space.js').TeamSpaceMade
    expect(result.brainId).toBe(BRAIN_B)
    expect(result.answer.status).toBe(504)
    expect(seen.map((c) => c.url)).toEqual(['/team/create'])
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending'])
  })

  it('discards the brain again when the server refused the creation, and passes the refusal through', async () => {
    signedIn()
    accountAnswers.set('/v1/grants', { status: 200, body: { brain: BRAIN_C, ...GRANT } })
    brainAnswers.set('POST /team/create', { status: 403, body: { error: 'The relay did not accept the creation grant: expired. Try again.', code: 'GRANT_INVALID' } })
    brainAnswers.set('DELETE /team', { status: 204 })
    const result = await mods.team.createTeamSpace(ctx(), 'Refused')
    expect(result).toEqual({ refused: { status: 403, body: { error: 'The relay did not accept the creation grant: expired. Try again.', code: 'GRANT_INVALID' } } })
    expect(seen.map((c) => [c.method, c.url])).toEqual([['POST', '/team/create'], ['DELETE', '/team']])
    expect(seen[1].auth).toBe(seen[0].auth)
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending'])
  })

  it('stops at the account: not signed in, or not in the beta — nothing provisioned, the server not asked', async () => {
    expect(await mods.team.createTeamSpace(ctx(), 'None')).toEqual({ refused: { status: 401, body: { error: { code: 'NOT_SIGNED_IN', message: 'Sign in to your EML account first.' } } } })
    signedIn()
    accountAnswers.set('/v1/grants', { status: 403 })
    expect(await mods.team.createTeamSpace(ctx(), 'None')).toEqual({ refused: { status: 403, body: { error: { code: 'NO_BETA', message: 'Your account is not in the team-brain beta.' } } } })
    expect(seen).toEqual([])
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending'])
  })
})

describe('joinTeamSpace', () => {
  it('provisions the empty brain under the link\'s brain id and keeps the space once the relay has the join (202)', async () => {
    brainAnswers.set('POST /team/join', { status: 202, body: { code: 'TEAM_JOIN_PENDING', message: 'The join is with the relay; the brain is live once the owner has accepted it and this device holds the key.', brain: BRAIN_D, member: 'fp', handle: 'alex' } })
    const result = await mods.team.joinTeamSpace(ctx(), 'Joined', link(BRAIN_D)) as import('../src/team-space.js').TeamSpaceMade
    expect(result.brainId).toBe(BRAIN_D)
    expect(result.answer.status).toBe(202)
    expect(seen).toEqual([{ method: 'POST', url: '/team/join', auth: `Bearer ${result.token}`, body: { link: link(BRAIN_D), handle: 'alex' } }])
    expect(controlRows(BRAIN_D)).toEqual({ brain: { id: BRAIN_D, name: 'Joined', status: 'ok' }, tokens: [{ name: 'alex', revoked_at: null }] })
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending', 'Joined'])
    expect(accountSeen).toEqual([])
  })

  it('discards the brain again when the invite is closed (410), and refuses a link that is none before provisioning', async () => {
    brainAnswers.set('POST /team/join', { status: 410, body: { error: 'This invite is closed (cancelled); ask the owner for a new link.', code: 'INVITE_CLOSED' } })
    brainAnswers.set('DELETE /team', { status: 204 })
    expect(await mods.team.joinTeamSpace(ctx(), 'Closed', link(BRAIN_E))).toEqual({ refused: { status: 410, body: { error: 'This invite is closed (cancelled); ask the owner for a new link.', code: 'INVITE_CLOSED' } } })
    expect(seen.map((c) => [c.method, c.url])).toEqual([['POST', '/team/join'], ['DELETE', '/team']])
    expect(seen[1].auth).toBe(seen[0].auth)

    seen.length = 0
    expect(await mods.team.joinTeamSpace(ctx(), 'Bad', 'https://relay.test/i/1/nope')).toEqual({ refused: { status: 400, body: { error: 'Invalid link.', code: 'INVALID_INVITE' } } })
    expect(seen).toEqual([])
    expect(controlRows(BRAIN_F).brain).toBeUndefined()
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending', 'Joined'])
  })

  it('a new link for a brain the cockpit has goes to that space: no provisioning, no config write, the server replaces the stopped join', async () => {
    const existing = { id: BRAIN_D, name: 'Joined', url, token: 'tok-existing', shared: null } as unknown as import('../src/brain-space.js').BrainSpace
    brainAnswers.set('POST /team/join', { status: 502, body: { error: 'The relay did not take the join: no route.', code: 'TEAM_JOIN_FAILED' } })
    expect(await mods.team.joinTeamSpace(ctx(), 'Ignored', link(BRAIN_D), existing)).toEqual({ refused: { status: 502, body: { error: 'The relay did not take the join: no route.', code: 'TEAM_JOIN_FAILED' } } })
    expect(seen.map((c) => [c.method, c.url, c.auth])).toEqual([['POST', '/team/join', 'Bearer tok-existing']])
    expect(existing.shared).toBeNull()

    seen.length = 0
    brainAnswers.set('POST /team/join', { status: 202, body: { code: 'TEAM_JOIN_PENDING' } })
    const result = await mods.team.joinTeamSpace(ctx(), 'Ignored', link(BRAIN_D), existing) as import('../src/team-space.js').TeamSpaceMade
    expect([result.brainId, result.token, result.answer.status]).toEqual([BRAIN_D, 'tok-existing', 202])
    expect(seen.map((c) => [c.method, c.url, c.auth])).toEqual([['POST', '/team/join', 'Bearer tok-existing']])
    expect(existing.shared).toBe(true)
    expect(controlRows(BRAIN_D).tokens).toHaveLength(1)
    expect((await spaces()).map((s) => s.name)).toEqual(['Team', 'Pending', 'Joined'])
  })
})

describe('the team routes', () => {
  it('pass the server\'s answers through on the space\'s token', async () => {
    const space = { url, token: 'tok-space' }
    brainAnswers.set('GET /team', { status: 200, body: { shared: true, state: { kind: 'live' }, read_only: null, invites: [] } })
    brainAnswers.set('POST /team/invites', { status: 201, body: { invite_id: 'inv', link: 'https://relay.test/i/1/x/inv#secret', expires_at: 'later' } })
    brainAnswers.set('POST /team/invites/inv/accept', { status: 200, body: { member: { id: 'm', role: 'owner' } } })
    brainAnswers.set('POST /team/invites/inv/cancel', { status: 404, body: { error: 'No such invite.', code: 'NO_SUCH_INVITE' } })
    expect(await mods.team.teamSnapshot(space)).toEqual({ status: 200, body: { shared: true, state: { kind: 'live' }, read_only: null, invites: [] } })
    expect(await mods.team.createInvite(space, 'owner')).toEqual({ status: 201, body: { invite_id: 'inv', link: 'https://relay.test/i/1/x/inv#secret', expires_at: 'later' } })
    expect(await mods.team.createInvite(space, undefined)).toEqual({ status: 201, body: { invite_id: 'inv', link: 'https://relay.test/i/1/x/inv#secret', expires_at: 'later' } })
    expect(await mods.team.confirmInvite(space, 'inv')).toEqual({ status: 200, body: { member: { id: 'm', role: 'owner' } } })
    expect(await mods.team.cancelInvite(space, 'inv')).toEqual({ status: 404, body: { error: 'No such invite.', code: 'NO_SUCH_INVITE' } })
    expect(seen.map((c) => [c.method, c.url, c.auth, c.body])).toEqual([
      ['GET', '/team', 'Bearer tok-space', {}],
      ['POST', '/team/invites', 'Bearer tok-space', { role: 'owner' }],
      ['POST', '/team/invites', 'Bearer tok-space', {}],
      ['POST', '/team/invites/inv/accept', 'Bearer tok-space', {}],
      ['POST', '/team/invites/inv/cancel', 'Bearer tok-space', {}],
    ])
  })

  it('answer 502 when the brain server cannot be reached', async () => {
    expect(await mods.team.teamSnapshot({ url: 'http://127.0.0.1:1', token: 't' })).toEqual({ status: 502, body: { error: 'Failed to reach the brain API.', code: 'BRAIN_UNAVAILABLE' } })
  })
})

describe('removeTeamSpace', () => {
  it('removes the space once the server discarded the brain; a brain with a log is refused and the space stays', async () => {
    const space = { id: BRAIN_D, url, token: 'tok-space' } as unknown as import('../src/brain-space.js').BrainSpace
    const removed: string[] = []
    const remove = async (s: import('../src/brain-space.js').BrainSpace) => { removed.push(s.id) }
    brainAnswers.set('DELETE /team', { status: 409, body: { error: 'A shared brain with a log is not discarded here.', code: 'TEAM_BRAIN_HAS_LOG' } })
    expect(await mods.team.removeTeamSpace(space, remove)).toEqual({ status: 409, body: { error: 'A shared brain with a log is not discarded here.', code: 'TEAM_BRAIN_HAS_LOG' } })
    expect(removed).toEqual([])
    brainAnswers.set('DELETE /team', { status: 204 })
    expect(await mods.team.removeTeamSpace(space, remove)).toEqual({ status: 204, body: {} })
    expect(removed).toEqual([BRAIN_D])
    expect(seen.map((c) => [c.method, c.url, c.auth])).toEqual([['DELETE', '/team', 'Bearer tok-space'], ['DELETE', '/team', 'Bearer tok-space']])
  })
})

describe('loadSharedFlags', () => {
  it('asks the server per space; a space whose call did not answer stays unknown', async () => {
    brainAnswers.set('GET /team', (call) => call.auth === 'Bearer tok-shared' ? { status: 200, body: { shared: true } } : { status: 200, body: { shared: false } })
    const shared = { url, token: 'tok-shared', shared: null } as unknown as import('../src/brain-space.js').BrainSpace
    const local = { url, token: 'tok-local', shared: null } as unknown as import('../src/brain-space.js').BrainSpace
    const unreachable = { url: 'http://127.0.0.1:1', token: 'tok-gone', shared: null } as unknown as import('../src/brain-space.js').BrainSpace
    await mods.team.loadSharedFlags([shared, local, unreachable])
    expect([shared.shared, local.shared, unreachable.shared]).toEqual([true, false, null])
  })
})

describe('sweepOrphanBrains', () => {
  it('asks the server to discard every brain no config token holds, through a token it issues and revokes; a brain with a log or in need of intervention is left', async () => {
    const config = await mods.config.readCockpitConfig()
    const held = [main.token, agentToken, ...(config?.spaces ?? []).map((s) => s.token)]
    // What a crash between provisioning and the config write leaves: brains without a space.
    // The refused creation (BRAIN_C) and the closed join (BRAIN_E) left their rows here because the
    // stand-in server deletes nothing; one more is provisioned and never reaches the config.
    const orphanLogged = mods.provision.provisionTeamBrain(BRAIN_F, 'Logged', 'alex', core)
    const control = new Database(join(mods.DATA_DIR, 'control.db'))
    control.prepare("UPDATE brains SET status = 'needs_intervention' WHERE id = ?").run(BRAIN_C)
    control.close()
    const lines: string[] = []
    // The server: the first brain asked about is empty, the second has a log.
    let calls = 0
    brainAnswers.set('DELETE /team', () => (++calls === 1 ? { status: 204 } : { status: 409, body: { error: 'A shared brain with a log is not discarded here.', code: 'TEAM_BRAIN_HAS_LOG' } }))

    await mods.team.sweepOrphanBrains({ tokens: held, url, log: (l) => lines.push(l), core })

    expect(lines).toEqual([
      `brain ${BRAIN_C}: needs intervention and has no space; left as is`,
      `brain ${BRAIN_E}: swept — empty and no space had it`,
      `brain ${BRAIN_F}: has a log but no space; left as is`,
    ])
    // Each call went with a token issued for it, not with any token the config holds; every issued token is revoked.
    expect(seen.map((c) => [c.method, c.url])).toEqual([['DELETE', '/team'], ['DELETE', '/team']])
    for (const call of seen) expect(held.concat(orphanLogged.token).map((t) => `Bearer ${t}`)).not.toContain(call.auth)
    expect(controlRows(BRAIN_E).tokens).toEqual([{ name: 'alex', revoked_at: null }, { name: 'cockpit sweep', revoked_at: expect.any(String) }])
    expect(controlRows(BRAIN_F).tokens).toEqual([{ name: 'alex', revoked_at: null }, { name: 'cockpit sweep', revoked_at: expect.any(String) }])
    expect(controlRows(BRAIN_C).tokens.map((t) => t.name)).toEqual(['alex'])
    for (const line of lines) for (const token of held.concat(orphanLogged.token)) expect(line).not.toContain(token)
  })
})
