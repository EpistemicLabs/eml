import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fingerprint, inviteLink, inviteNotice, joinAccept, newDeviceKeys, newInvite, openJoin, ready, type Invite } from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, EML, initControlDatabase, initDatabase, issueToken, provisionUser } from '@engramprotocol/core'
import { Sync } from '../src/sync/sync'
import { joinTeamBrain } from '../src/sync/join'
import { validNote } from '../../core/tests/fixtures'
import { teamFilePath, writeTeamFile } from '../src/sync/team-file'
import { FakeRelay, GRANT } from './fake-relay'
import { request, waitForReady, flat } from './http-helpers'
import { BRAIN, OTHER, Team, cert } from './team'

// v0.21 end to end: the spawned server founds a team brain in an empty brain
// (POST /team/create) or joins one with an invite link (POST /team/join, the
// inviter played here with the protocol package), syncs it with its relay,
// and an HTTP write to it is a confirmed write through the relay. A brain
// whose team file cannot be used is shared and read-only, with a fixed reason.

const BROKEN = '1c9e6679-7425-40de-944b-e07fc1f90a01'  // its team file is cut off in the middle of a seed
const RETRY = '2c9e6679-7425-40de-944b-e07fc1f90a02'   // created with a stale grant first
const EMPTY = '4c9e6679-7425-40de-944b-e07fc1f90a04'   // provisioned for a creation that never happens; discarded
const JOINED = '3c9e6679-7425-40de-944b-e07fc1f90a03'  // juno's team brain at another relay, which lasse's server joins
const NOW = '2026-11-03T08:00:00.000Z'

describe('a shared brain through the server', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let relay: FakeRelay
  let retryRelay: FakeRelay
  let joinRelay: FakeRelay
  let juno: Team
  let invite: Invite
  let stderr = ''
  let seed: string
  const tokens: Record<string, string> = {}
  const port = 31680 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const post = (brain: string, path: string, body: unknown) => request('POST', `${baseUrl}${path}`, { Authorization: `Bearer ${tokens[brain]}` }, JSON.stringify(body))
  const get = (brain: string, path: string) => request('GET', `${baseUrl}${path}`, { Authorization: `Bearer ${tokens[brain]}` })
  const del = (brain: string, path: string) => request('DELETE', `${baseUrl}${path}`, { Authorization: `Bearer ${tokens[brain]}` })

  beforeAll(async () => {
    await ready()
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-shared-sync-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'juno@example.com')`).run()
    // empty brains as the host provisions them for a creation: the schema, no rows, no log
    for (const id of [BRAIN, BROKEN, RETRY, EMPTY, JOINED]) {
      const brainFile = `brains/${id}.db`
      initDatabase(join(tmpDir, brainFile), undefined, id, { log: false }).close()
      control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(id, 'team', 'u1', brainFile, CURRENT_BRAIN_SCHEMA_VERSION)
      tokens[id] = issueToken(control, { userId: 'u1', brainId: id, name: 'juno' }).plaintext
    }
    // a private brain, provisioned as usual
    const own = provisionUser({ email: 'juno@example.com', agentId: 'pilot', userId: 'juno', control, dataDir: tmpDir })
    tokens[OTHER] = own.tokenPlaintext
    control.close()

    // BROKEN's team file: a good one, cut off inside the device's signing seed
    const device = newDeviceKeys()
    writeTeamFile(tmpDir, { v: 1, brain: BROKEN, relay: 'wss://relay.test', device })
    const text = readFileSync(teamFilePath(tmpDir, BROKEN), 'utf-8')
    seed = Buffer.from(device.sign.seed).toString('base64url')
    writeFileSync(teamFilePath(tmpDir, BROKEN), text.slice(0, text.indexOf(seed) + 20))

    relay = await FakeRelay.start(BRAIN)
    retryRelay = await FakeRelay.start(RETRY)
    // juno's brain JOINED at its relay, with an open invite for lasse
    juno = new Team(JOINED)
    joinRelay = await FakeRelay.start(JOINED, juno.genesis())
    juno.deliver(joinRelay.log[0].record, 1, joinRelay.log[0].at)
    joinRelay.putKey(juno.owner.device.sign.publicKey, juno.wrapped(0))
    invite = newInvite(joinRelay.host, JOINED, NOW)
    joinRelay.openInvite(inviteNotice(invite, juno.owner.device.sign))
    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await waitForReady(port)
  }, 10000)

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    await relay?.stop()
    await retryRelay?.stop()
    await joinRelay?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses a creation with a relay that is no origin, a handle that is none, or without a grant', async () => {
    expect(await post(BRAIN, '/team/create', { relay: 'https://relay.test', grant: GRANT, handle: 'juno' })).toMatchObject({ status: 400, body: { code: 'INVALID_RELAY', error: 'The relay is a wss:// origin (scheme and host, no path).' } })
    expect(await post(BRAIN, '/team/create', { relay: 'ws://relay.test', grant: GRANT, handle: 'juno' })).toMatchObject({ status: 400, body: { code: 'INVALID_RELAY' } })
    expect(await post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'Juno!' })).toMatchObject({ status: 400, body: { code: 'INVALID_HANDLE', error: 'A handle is 1–63 characters of a–z, 0–9, _ and -.' } })
    expect(await post(BRAIN, '/team/create', { relay: relay.origin, handle: 'juno' })).toMatchObject({ status: 400, body: { error: 'grant required' } })
    expect(relay.creates).toEqual([])
  })

  it('refuses a creation into a brain that has a log already', async () => {
    const r = await post(OTHER, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(r).toMatchObject({ status: 409, body: { code: 'TEAM_BRAIN_NOT_EMPTY', error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.' } })
  })

  it('an empty brain takes no write before its creation', async () => {
    const note = flat(validNote({ title: 't-before-creation' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY' } })
    expect(r.body.error).toBe('This shared brain is read-only right now: it is not created yet. Reads still work; try the write again once it is back.')
  })

  it('founds the team brain once for two requests that arrive together: 201 for both with the same member, again when asked again, and its team file holds no pending creation', async () => {
    const [r, twin] = await Promise.all([
      post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' }),
      post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' }),
    ])
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ brain: BRAIN, handle: 'juno' })
    expect(r.body.member).toMatch(/^([0-9a-f]{5} ){7}[0-9a-f]{5}$/)
    expect(twin).toMatchObject({ status: 201, body: r.body })
    expect(relay.log).toHaveLength(1)
    const again = await post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(again).toMatchObject({ status: 201, body: r.body })
    expect(relay.creates).toEqual([GRANT])
    for (let i = 0; i < 50 && relay.keyPuts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
    const file = JSON.parse(readFileSync(teamFilePath(tmpDir, BRAIN), 'utf-8'))
    expect(file.create).toBeUndefined()
    expect(file.key).toBeUndefined()
    expect(file.identity).toBeDefined()
  })

  it('writes through the relay: 201 with the engram, in the relay\'s log and readable, as the member', async () => {
    const note = flat(validNote({ title: 't-through-the-relay' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ title: 't-through-the-relay', ingested_by: 'juno' })
    expect(relay.log).toHaveLength(2)
    const list = await get(BRAIN, '/list?search=through')
    expect(list.body.engrams.map((e: { title: string }) => e.title)).toContain('t-through-the-relay')
  })

  it('GET /team: a private brain is not shared; the team brain shows its state, no read-only text, its member and the member set', async () => {
    expect(await get(OTHER, '/team')).toEqual({ status: 200, body: { shared: false } })
    const r = await get(BRAIN, '/team')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ shared: true, brain: BRAIN, relay: relay.origin, mode: 'create', state: { kind: 'live' }, read_only: null, invites: [] })
    expect(r.body.members).toHaveLength(1)
    expect(r.body.member).toMatchObject({ handle: 'juno', role: 'owner', devices: 1, self: true })
    expect(r.body.member.fingerprint).toMatch(/^[0-9a-f]{5}( [0-9a-f]{5}){7}$/)
    expect(r.body.members[0]).toEqual(r.body.member)
  })

  it('DELETE /team discards an empty brain — its file and its control rows — and refuses a brain with a log', async () => {
    expect(await get(EMPTY, '/team')).toEqual({ status: 200, body: { shared: false } })
    expect(await del(OTHER, '/team')).toMatchObject({ status: 409, body: { code: 'TEAM_BRAIN_HAS_LOG', error: 'A shared brain with a log is not discarded here.' } })
    expect(await del(BRAIN, '/team')).toMatchObject({ status: 409, body: { code: 'TEAM_BRAIN_HAS_LOG' } })
    expect((await del(EMPTY, '/team')).status).toBe(204)
    expect(existsSync(join(tmpDir, 'brains', `${EMPTY}.db`))).toBe(false)
    expect((await get(EMPTY, '/list')).status).toBe(401)  // its token is gone with the brain
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    try {
      expect(control.prepare('SELECT COUNT(*) AS n FROM brains WHERE id = ?').get(EMPTY)).toEqual({ n: 0 })
      expect(control.prepare('SELECT COUNT(*) AS n FROM tokens WHERE brain_id = ?').get(EMPTY)).toEqual({ n: 0 })
      expect(control.prepare('SELECT COUNT(*) AS n FROM brain_members WHERE brain_id = ?').get(EMPTY)).toEqual({ n: 0 })
    } finally {
      control.close()
    }
  })

  it('a creation the relay refuses leaves the brain new and empty: 403 GRANT_INVALID, then created with a good grant', async () => {
    const r = await post(RETRY, '/team/create', { relay: retryRelay.origin, grant: 'stale', handle: 'juno' })
    expect(r).toMatchObject({ status: 403, body: { code: 'GRANT_INVALID', error: 'The relay did not accept the creation grant: the grant is not good for this brain. Try again.' } })
    expect(existsSync(teamFilePath(tmpDir, RETRY))).toBe(false)
    const ok = await post(RETRY, '/team/create', { relay: retryRelay.origin, grant: GRANT, handle: 'juno' })
    expect(ok.status).toBe(201)
    expect(retryRelay.creates).toEqual(['stale', GRANT])
    expect(retryRelay.log).toHaveLength(1)
  })

  it('a brain whose team file cannot be used is read-only with a fixed reason, and nothing of the file is in the text or the log', async () => {
    const note = flat(validNote({ title: 't-broken' }))
    const r = await post(BROKEN, `/engram/${note.type}`, note.body)
    expect(r).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY' } })
    expect(r.body.error).toBe('This shared brain is read-only right now: it stopped: its team file cannot be used (it is not valid JSON). Reads still work; this needs the user — tell them.')
    const create = await post(BROKEN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(create).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY', error: r.body.error } })
    expect(stderr).toContain(`[sync] ${BROKEN}: its team file cannot be used (it is not valid JSON)`)
    for (let i = 0; i + 8 <= seed.length; i++) {
      expect(r.body.error).not.toContain(seed.slice(i, i + 8))
      expect(stderr).not.toContain(seed.slice(i, i + 8))
    }
    expect((await get(BROKEN, '/list')).status).toBe(200)
    const team = await get(BROKEN, '/team')
    expect(team.status).toBe(200)
    expect(team.body).toEqual({ shared: true, brain: BROKEN, relay: null, mode: null, state: { kind: 'stopped', why: 'its team file cannot be used (it is not valid JSON)' }, read_only: r.body.error, member: null, members: [], invites: [] })
  })

  it('DELETE /team discards a shared brain that never came to life, its unusable team file with it', async () => {
    expect((await del(BROKEN, '/team')).status).toBe(204)
    expect(existsSync(teamFilePath(tmpDir, BROKEN))).toBe(false)
    expect(existsSync(join(tmpDir, 'brains', `${BROKEN}.db`))).toBe(false)
    expect((await get(BROKEN, '/team')).status).toBe(401)
  })

  it('refuses a join with a link that is no invite link for this brain, or a handle that is none', async () => {
    const link = inviteLink(invite)
    expect(await post(JOINED, '/team/join', { link: 'https://relay.test/i/1/x', handle: 'lasse' })).toMatchObject({ status: 400, body: { code: 'INVALID_INVITE', error: 'This is not an invite link for this brain.' } })
    expect(await post(JOINED, '/team/join', { link: inviteLink(newInvite(joinRelay.host, BRAIN, NOW)), handle: 'lasse' })).toMatchObject({ status: 400, body: { code: 'INVALID_INVITE' } })
    expect(await post(JOINED, '/team/join', { link, handle: 'Lasse!' })).toMatchObject({ status: 400, body: { code: 'INVALID_HANDLE' } })
    // a host that is no relay origin: credentials, a path before the invite path
    expect(await post(JOINED, '/team/join', { link: link.replace('https://', 'https://user@'), handle: 'lasse' })).toMatchObject({ status: 400, body: { code: 'INVALID_INVITE' } })
    expect(await post(JOINED, '/team/join', { link: link.replace('/i/1/', '/path/i/1/'), handle: 'lasse' })).toMatchObject({ status: 400, body: { code: 'INVALID_INVITE' } })
    expect(joinRelay.joins).toEqual([])
    expect(existsSync(teamFilePath(tmpDir, JOINED))).toBe(false)
  })

  it('a join of an invite the relay does not have: 410 INVITE_CLOSED, and the brain stays new and empty', async () => {
    const r = await post(JOINED, '/team/join', { link: inviteLink(newInvite(joinRelay.host, JOINED, NOW)), handle: 'lasse' })
    expect(r).toMatchObject({ status: 410, body: { code: 'INVITE_CLOSED', error: 'This invite is closed (unknown); ask the owner for a new link.' } })
    expect(joinRelay.joins).toHaveLength(1)
    expect(existsSync(teamFilePath(tmpDir, JOINED))).toBe(false)
  })

  it('joins the team brain: 202 while the owner has not accepted, read-only meanwhile, 201 once the member is added and holds the key, then writes as the member', async () => {
    const link = inviteLink(invite)
    const r = await post(JOINED, '/team/join', { link, handle: 'lasse' })
    expect(r).toMatchObject({ status: 202, body: { code: 'TEAM_JOIN_PENDING', message: 'The join is with the relay; the brain is live once the owner has accepted it and this device holds the key.', brain: JOINED, handle: 'lasse' } })
    expect(r.body.member).toMatch(/^([0-9a-f]{5} ){7}[0-9a-f]{5}$/)
    const note = flat(validNote({ title: 't-while-joining' }))
    const early = await post(JOINED, `/engram/${note.type}`, note.body)
    expect(early).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY' } })
    expect(early.body.error).toBe('This shared brain is read-only right now: it is still joining its team brain. Reads still work; try the write again once it is back.')
    expect((await get(JOINED, '/list')).status).toBe(200)
    // the inviter: opens the join, accepts it, adds the member, wraps the key for lasse's device
    const join = openJoin(invite, joinRelay.joinOf(invite.invite_id), NOW)
    expect(join.handle).toBe('lasse')
    joinRelay.acceptJoin(joinAccept(invite, join.join_hash, cert(juno.owner, JOINED), juno.anchor()))
    joinRelay.inject(juno.addJoiner(join))
    joinRelay.putKey(join.device_cert.device_sign, juno.wrappedFor(0, join.device_cert.device_sign))
    let again = await post(JOINED, '/team/join', { link, handle: 'lasse' })
    for (let i = 0; i < 60 && again.status !== 201; i++) {
      await new Promise(resolve => setTimeout(resolve, 250))
      again = await post(JOINED, '/team/join', { link, handle: 'lasse' })
    }
    expect(again).toMatchObject({ status: 201, body: { brain: JOINED, member: r.body.member, handle: 'lasse' } })
    const file = JSON.parse(readFileSync(teamFilePath(tmpDir, JOINED), 'utf-8'))
    expect(file.join).toBeUndefined()
    expect(file.accept).toBeUndefined()
    expect(file.identity).toBeDefined()
    const written = await post(JOINED, `/engram/${note.type}`, note.body)
    expect(written).toMatchObject({ status: 201, body: { title: 't-while-joining', ingested_by: 'lasse' } })
    expect(joinRelay.log).toHaveLength(3)
    expect(joinRelay.joins).toHaveLength(2)
  }, 30000)

  it('invites and confirms through the server: the link from the owner, the join from another brain, the pending join in GET /team, the accept, both live', async () => {
    expect(await post(OTHER, '/team/invites', {})).toMatchObject({ status: 409, body: { code: 'NOT_SHARED', error: 'This brain is not a shared brain.' } })
    const invited = await post(BRAIN, '/team/invites', {})
    expect(invited.status).toBe(201)
    expect(invited.body.link).toMatch(new RegExp(`^https://${relay.host}/i/1/${BRAIN}/${invited.body.invite_id}#[A-Za-z0-9_-]{43}$`))
    expect((await get(BRAIN, '/team')).body.invites).toEqual([{ invite_id: invited.body.invite_id, expires_at: invited.body.expires_at, pending: null }])
    expect(JSON.stringify((await get(BRAIN, '/team')).body)).not.toContain(invited.body.link.split('#')[1])
    // lasse joins from another cockpit: an empty brain with the team brain's id, its Sync in join mode (here in-process), through the same relay
    const lasseDb = initDatabase(':memory:', undefined, BRAIN, { log: false })
    const lasseFile = joinTeamBrain({ brain: BRAIN, link: invited.body.link, handle: 'lasse', now: NOW })
    const lasse = new Sync(lasseDb, lasseFile, { deadlineMs: 3000, backoffMs: [20, 100] })
    lasse.start()
    try {
      expect(await lasse.whenLive()).toEqual({ kind: 'joining', waiting: 'accept' })
      const lasseFingerprint = fingerprint(lasseFile.identity!.publicKey)
      let team = await get(BRAIN, '/team')
      for (let i = 0; i < 40 && !team.body.invites[0]?.pending; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        team = await get(BRAIN, '/team')
      }
      expect(team.body.invites[0].pending).toMatchObject({ handle: 'lasse', fingerprint: lasseFingerprint })
      expect(await post(BRAIN, `/team/invites/${invited.body.invite_id}/accept`, { role: 'admin' })).toMatchObject({ status: 400, body: { code: 'INVALID_ROLE' } })
      expect(await post(BRAIN, '/team/invites/AAAAAAAAAAAAAAAAAAAAAA/accept', {})).toMatchObject({ status: 404, body: { code: 'NO_PENDING_JOIN', error: 'This invite has no join to confirm.' } })
      const confirmed = await post(BRAIN, `/team/invites/${invited.body.invite_id}/accept`, {})
      expect(confirmed).toMatchObject({ status: 200, body: { member: { handle: 'lasse', role: 'member', devices: 1, self: false, fingerprint: lasseFingerprint } } })
      expect((await get(BRAIN, '/team')).body.invites).toEqual([])
      for (let i = 0; i < 100 && lasse.state.kind !== 'live'; i++) await new Promise(resolve => setTimeout(resolve, 50))
      expect(lasse.state).toEqual({ kind: 'live' })
      expect(lasse.ownHandle()).toBe('lasse')
      const lasseEml = EML.fromConnection(lasseDb, 'test')
      const written = await lasse.write({ name: 'engram.create', input: validNote({ title: 't-by-lasse' }) }, lasseEml.env({ handle: 'x', ingestion_method: 'mcp' }))
      expect(written).toMatchObject({ title: 't-by-lasse', ingested_by: 'lasse' })
      let owner = await get(BRAIN, '/team')
      for (let i = 0; i < 40 && owner.body.members.length < 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        owner = await get(BRAIN, '/team')
      }
      expect(owner.body.members.map((m: { handle: string, role: string, self: boolean }) => [m.handle, m.role, m.self])).toEqual([['juno', 'owner', true], ['lasse', 'member', false]])
      expect(lasse.snapshot().member).toMatchObject({ handle: 'lasse', role: 'member', self: true })
      expect((await get(BRAIN, '/list')).body.engrams ?? (await get(BRAIN, '/list')).body).toBeTruthy()
    } finally {
      lasse.close()
    }
  }, 30000)

  it('cancels an invite: gone from GET /team, a second cancel is 404', async () => {
    const invited = await post(BRAIN, '/team/invites', {})
    expect(invited.status).toBe(201)
    expect((await get(BRAIN, '/team')).body.invites.map((i: { invite_id: string }) => i.invite_id)).toEqual([invited.body.invite_id])
    expect(await post(BRAIN, `/team/invites/${invited.body.invite_id}/cancel`, {})).toMatchObject({ status: 200, body: { invite_id: invited.body.invite_id, cancelled: true } })
    expect((await get(BRAIN, '/team')).body.invites).toEqual([])
    expect(await post(BRAIN, `/team/invites/${invited.body.invite_id}/cancel`, {})).toMatchObject({ status: 404, body: { code: 'NO_SUCH_INVITE' } })
    const file = JSON.parse(readFileSync(teamFilePath(tmpDir, BRAIN), 'utf-8'))
    expect(file.invites).toBeUndefined()
  })

  it('is read-only while the relay is away', async () => {
    await relay.stop()
    await new Promise(resolve => setTimeout(resolve, 200))  // the server sees the connection drop
    const note = flat(validNote({ title: 't-while-away' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('SHARED_BRAIN_READ_ONLY')
  })
})
