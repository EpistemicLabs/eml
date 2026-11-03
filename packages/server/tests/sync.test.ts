import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { inviteLink, inviteNotice, joinAccept, newInvite, openJoin, openRecord, ready, type Invite } from '@engramprotocol/protocol'
import { EML, CommandError, initDatabase } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHECKPOINT_EVERY, InviteError, Sync, untrusted, type SyncState } from '../src/sync/sync'
import { createTeamBrain } from '../src/sync/create'
import { joinTeamBrain } from '../src/sync/join'
import { readTeamFile, writeTeamFile, type TeamFile } from '../src/sync/team-file'
import { SharedWriteError, applyWrite } from '../src/write'
import { FakeRelay, GRANT } from './fake-relay'
import { BRAIN, Team, cert, person } from './team'

// v0.21 sync (spec team-brain-sync-client-spec §4): a shared brain's
// connection to its relay — login, keys, the log stream into the replica, and
// confirmed writes — against an in-process relay.

let relay: FakeRelay | null = null
let sync: Sync | null = null

beforeAll(async () => { await ready() })
afterEach(async () => {
  sync?.close()
  await relay?.stop()
  sync = null
  relay = null
})

/** juno's team, its relay holding the genesis (and juno's epoch-0 key unless `withKey` is false), and juno's device synced to it. */
async function connected(opts: { withKey?: boolean, deadlineMs?: number, checkpointEvery?: number } = {}): Promise<{ team: Team, relay: FakeRelay, sync: Sync, eml: EML }> {
  const team = new Team()
  relay = await FakeRelay.start(BRAIN, team.genesis())
  if (opts.withKey !== false) relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
  sync = new Sync(team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device }, { deadlineMs: opts.deadlineMs ?? 3000, backoffMs: [20, 100], checkpointEvery: opts.checkpointEvery })
  sync.start()
  await until(() => sync!.state.kind === 'live')
  return { team, relay, sync, eml: EML.fromConnection(team.db, 'test') }
}

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out; sync state ${JSON.stringify(sync?.state)}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const env = (eml: EML) => eml.env({ handle: 'token-name', ingestion_method: 'mcp', session_id: 's1', model: 'm1', harness: 'h1' })
const titles = (eml: EML): string[] => eml.engrams.query({}).map(e => e.title).filter((t): t is string => !!t && t.startsWith('t-')).sort()
const failure = async (p: Promise<unknown>): Promise<unknown> => p.then(() => { throw new Error('expected a failure') }, (err: unknown) => err)

describe('a shared brain\'s sync', () => {
  it('replays the relay\'s log, then writes confirmed: the result once its entry is applied, as the member', async () => {
    const { relay, sync, eml } = await connected()
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-mine' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-mine', ingested_by: 'juno', agent: null, session_id: 's1', model: 'm1', harness: 'h1' })
    expect(relay.log).toHaveLength(2)
    expect(titles(eml)).toEqual(['t-mine'])
  })

  it('takes another member\'s writes as the relay pushes them', async () => {
    const { team, relay, eml } = await connected()
    const ava = person('ava')
    relay.inject(team.addMember(ava))
    await until(() => team.head === 2)
    relay.inject(team.write(ava, 't-ava'))
    await until(() => titles(eml).includes('t-ava'))
    expect(eml.engrams.query({}).find(e => e.title === 't-ava')?.ingested_by).toBe('ava')
  })

  it('answers a write the brain refuses with the error a private brain gives, and keeps it as rejected', async () => {
    const { sync, eml, team } = await connected()
    const err = await failure(sync.write({ name: 'task.track', input: { id: '00000000-0000-4000-8000-000000000000', text: 'x' } }, env(eml)))
    expect(err).toBeInstanceOf(CommandError)
    expect((err as CommandError).code).toBe('NOT_FOUND')
    const rejected = team.db.prepare('SELECT rejected FROM op_log WHERE seq = 2').get() as { rejected: string }
    expect(rejected.rejected).toMatch(/^INVALID: /)
  })

  it('answers a write the relay refuses with 409 SHARED_WRITE_REFUSED; nothing is written', async () => {
    const { sync, eml, relay } = await connected()
    relay.refuseNext = { code: 'refused', message: 'the op is sealed under an old epoch' }
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-refused' }) }, env(eml)))
    expect(err).toBeInstanceOf(SharedWriteError)
    expect(err).toMatchObject({ status: 409, code: 'SHARED_WRITE_REFUSED' })
    expect((err as Error).message).toMatch(/^The shared brain's relay refused this write \(refused\): the op is sealed under an old epoch\. Nothing was written\.$/)
    expect(relay.log).toHaveLength(1)
  })

  it('answers 504 SHARED_WRITE_PENDING when its entry does not arrive in time', async () => {
    const { sync, eml, relay } = await connected({ deadlineMs: 200 })
    relay.hold = true
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-held' }) }, env(eml)))
    expect(err).toMatchObject({ status: 504, code: 'SHARED_WRITE_PENDING' })
    expect((err as Error).message).toMatch(/may still land/)
  })

  it('does not resend a write whose answer was lost: its entry comes in after the reconnect, and it lands once', async () => {
    const { sync, eml, relay } = await connected()
    relay.dropNextAnswer = true
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-answer-lost' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-answer-lost' })
    await until(() => sync.state.kind === 'live')
    await sync.write({ name: 'engram.create', input: validNote({ title: 't-after' }) }, env(eml))  // a resend would reach the relay before it
    expect(relay.appends).toHaveLength(2)
    expect(new Set(relay.appends).size).toBe(2)
    expect(relay.log).toHaveLength(3)
    expect(titles(eml)).toEqual(['t-after', 't-answer-lost'])
  })

  it('resends a write the relay did not take after a reconnect; it lands once', async () => {
    const { sync, eml, relay } = await connected()
    relay.dropNextAppend = true
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-resent' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-resent' })
    expect(relay.appends).toHaveLength(2)
    expect(relay.log).toHaveLength(2)
    expect(titles(eml)).toEqual(['t-resent'])
  })

  it('is read-only, with the reason, when it is not live', async () => {
    const { sync, eml, relay } = await connected()
    relay.closeAll()
    await until(() => sync.state.kind !== 'live')
    expect(sync.state).toEqual({ kind: 'offline' } satisfies SyncState)
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-offline' }) }, env(eml)))
    expect(err).toMatchObject({ status: 503, code: 'SHARED_BRAIN_READ_ONLY' })
    expect((err as Error).message).toBe('This shared brain is read-only right now: it is not connected to its relay. Reads still work; try the write again once it is back.')
    await until(() => sync.state.kind === 'live')
  })

  it('without a key for the current epoch, is read-only; a sealed entry waits until the key is pushed', async () => {
    const { team, relay, sync, eml } = await connected({ withKey: false })
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-nokey' }) }, env(eml)))
    expect((err as Error).message).toMatch(/read-only right now: this device has no key for it yet/)
    relay.inject(team.write(team.owner, 't-from-another-device'))
    await until(() => sync.state.kind === 'waiting_key')
    relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
    await until(() => sync.state.kind === 'live')
    expect(titles(eml)).toEqual(['t-from-another-device'])
  })

  it('is shared before its genesis arrived: a write is read-only, not written privately', async () => {
    const team = new Team()
    relay = await FakeRelay.start(BRAIN, team.genesis())
    sync = new Sync(team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device }, { backoffMs: [20, 100] })
    const eml = EML.fromConnection(team.db, 'test')
    expect(eml.teamBrain()).toBeNull()
    const err = await failure(applyWrite(eml, { name: 'engram.create', input: validNote({ title: 't-early' }) }, env(eml), sync))
    expect(err).toMatchObject({ status: 503, code: 'SHARED_BRAIN_READ_ONLY' })
    expect(titles(eml)).toEqual([])
  })

  it('stops when the relay\'s log is shorter than this brain\'s', async () => {
    const first = await connected()
    await first.sync.write({ name: 'engram.create', input: validNote({ title: 't-1' }) }, env(first.eml))
    const genesis = first.relay.log[0].record
    first.sync.close()
    await first.relay.stop()
    relay = await FakeRelay.start(BRAIN, genesis)  // a relay that lost the write
    sync = new Sync(first.team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: first.team.owner.device }, { backoffMs: [20, 100] })
    sync.start()
    await until(() => sync!.state.kind === 'stopped')
    expect(sync.state).toEqual({ kind: 'stopped', why: 'the relay\'s log is shorter than this brain\'s' })
  })

  it('stops when the relay closes the session because the device left the brain (4004)', async () => {
    const { sync, eml, relay } = await connected()
    relay.closeAll(4004)
    await until(() => sync.state.kind === 'stopped')
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-gone' }) }, env(eml)))
    expect((err as Error).message).toMatch(/read-only right now: it stopped: this device or its member left the brain\. Reads still work; this needs the user — tell them\.$/)
  })
})

// v0.21 create (spec §5, block 6a): the owner's device founds the brain at the
// relay from an empty brain file — genesis and grant first, then the login,
// the genesis back through the log, and its own epoch-0 key put for itself.

describe('creating a team brain', () => {
  const NOW = '2026-11-03T08:00:00.000Z'
  /** An empty brain, its creation (team file in memory) and what the Sync persisted of it. */
  function creation(opts: { grant?: string, handle?: string } = {}) {
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    const eml = EML.fromConnection(db, 'test')
    const team = createTeamBrain({ brain: BRAIN, relay: relay!.origin, grant: opts.grant ?? GRANT, handle: opts.handle ?? 'juno', stateHash: eml.stateHash(), now: NOW })
    return { db, eml, team }
  }
  const persisted: TeamFile[] = []
  const persist = (file: TeamFile) => { persisted.push(JSON.parse(JSON.stringify({ create: file.create ?? null, key: file.key ? 'held' : null, identity: file.identity ? 'held' : null }))) }
  const started = (db: ReturnType<typeof initDatabase>, team: TeamFile, opts: { persist?: (f: TeamFile) => void, deadlineMs?: number } = {}): Sync => {
    sync = new Sync(db, team, { deadlineMs: opts.deadlineMs ?? 3000, backoffMs: [20, 100], persist: opts.persist ?? persist })
    sync.start()
    return sync
  }
  beforeEach(() => { persisted.length = 0 })

  it('founds the brain: genesis and grant to the relay, the genesis back through the log, the key put for itself, then live and writable as the member', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { eml, db, team } = creation()
    expect(eml.hasGenesis()).toBe(false)
    const sync = started(db, team)
    expect(sync.mode).toBe('create')
    expect(await sync.whenLive()).toEqual({ kind: 'live' })
    expect(relay.creates).toEqual([GRANT])
    expect(relay.log).toHaveLength(1)
    expect(eml.brainId()).toBe(BRAIN)
    expect(eml.teamBrain()).toBe(BRAIN)
    expect(sync.ownHandle()).toBe('juno')
    await until(() => relay!.keyPuts.length === 1)
    expect(relay.keyPuts).toEqual([team.device.sign.publicKey])
    expect(team.create).toBeUndefined()
    await until(() => team.key === undefined)
    expect(persisted.map(p => [p.create === null, p.key])).toEqual([[true, 'held'], [true, null]])
    expect(persisted.every(p => p.identity === 'held')).toBe(true)
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-founded' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-founded', ingested_by: 'juno' })
    expect(relay.log).toHaveLength(2)
  })

  it('is read-only as not created yet until the genesis is in', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { eml, db, team } = creation()
    const sync = started(db, team)
    const err = await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-too-early' }) }, env(eml)))
    expect((err as Error).message).toBe('This shared brain is read-only right now: it is not created yet. Reads still work; try the write again once it is back.')
    const direct = await failure(applyWrite(eml, { name: 'engram.create', input: validNote({ title: 't-too-early' }) }, env(eml), undefined))
    expect((direct as Error).message).toMatch(/read-only right now: it is not created yet\./)
    expect(await sync.whenLive()).toEqual({ kind: 'live' })
  })

  it('snapshot: the read-only text a write would get while it is not created, then live with the member and the member set', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { db, team } = creation()
    const sync = started(db, team)
    const early = sync.snapshot()
    expect(early).toMatchObject({ shared: true, brain: BRAIN, relay: relay.origin, mode: 'create', member: null, members: [], invites: [] })
    expect(early.read_only).toBe('This shared brain is read-only right now: it is not created yet. Reads still work; try the write again once it is back.')
    expect(await sync.whenLive()).toEqual({ kind: 'live' })
    const live = sync.snapshot()
    expect(live.state).toEqual({ kind: 'live' })
    expect(live.read_only).toBeNull()
    expect(live.members).toHaveLength(1)
    expect(live.member).toEqual({ id: team.identity!.publicKey, fingerprint: expect.stringMatching(/^[0-9a-f]{5}( [0-9a-f]{5}){7}$/), handle: 'juno', role: 'owner', devices: 1, self: true })
    expect(JSON.stringify(live)).not.toContain(Buffer.from(team.device.sign.seed).toString('base64url'))
  })

  it('stops when the relay does not accept the grant: nothing created, the creation kept for a retry', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { db, team } = creation({ grant: 'stale' })
    const sync = started(db, team)
    const state = await sync.whenLive()
    expect(state).toEqual({ kind: 'stopped', why: 'the relay did not accept the creation grant: the grant is not good for this brain', relay: { code: 'grant_invalid', message: 'the grant is not good for this brain' } })
    expect(relay.log).toHaveLength(0)
    expect(team.create).toBeDefined()
    expect(persisted).toEqual([])
  })

  it('after a restart with the creation still in the file, logs in when the relay has the brain already', async () => {
    relay = await FakeRelay.start(BRAIN)
    const first = creation()
    const asWritten: TeamFile = { ...first.team, create: JSON.parse(JSON.stringify(first.team.create)), key: { epoch: 0, key: new Uint8Array(first.team.key!.key) } }
    expect(await started(first.db, first.team).whenLive()).toEqual({ kind: 'live' })
    sync!.close()
    // the same device again, its file as before the relay answered
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    const team = asWritten
    const again = started(db, team)
    expect(await again.whenLive()).toEqual({ kind: 'live' })
    expect(relay.creates).toHaveLength(2)
    expect(relay.log).toHaveLength(1)
    expect(team.create).toBeUndefined()
    expect(again.ownHandle()).toBe('juno')
  })

  it('stops when the relay has a brain with this id that is not this device\'s', async () => {
    const other = new Team()
    relay = await FakeRelay.start(BRAIN, other.genesis())
    const { db, team } = creation()
    const sync = started(db, team)
    const state = await sync.whenLive()
    expect(state).toMatchObject({ kind: 'stopped', relay: { code: 'brain_exists' } })
    expect((state as { why: string }).why).toBe('the relay has a brain with this id that this device is no member of')
    expect(team.create).toBeDefined()
  })

  it('puts its key again after a restart that left it in the file', async () => {
    relay = await FakeRelay.start(BRAIN)
    const first = creation()
    const key = { epoch: 0, key: new Uint8Array(first.team.key!.key) }
    expect(await started(first.db, first.team).whenLive()).toEqual({ kind: 'live' })
    await until(() => relay!.keyPuts.length === 1)
    sync!.close()
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    const team: TeamFile = { ...first.team, key }
    delete team.create
    const again = started(db, team)
    expect(again.mode).toBe('member')
    expect(await again.whenLive()).toEqual({ kind: 'live' })
    await until(() => relay!.keyPuts.length === 2)
    await until(() => team.key === undefined)
  })

  it('stops when the team file cannot be written once the relay took the genesis', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { db, team } = creation()
    const sync = started(db, team, { persist: () => { throw new Error('disk full') } })
    expect(await sync.whenLive()).toEqual({ kind: 'stopped', why: 'its team file could not be written' })
    expect(team.create).toBeDefined()
    expect(relay.log).toHaveLength(1)
  })

  it('answers whenLive with the state as it is once the deadline passed', async () => {
    relay = await FakeRelay.start(BRAIN)
    const { db, team } = creation()
    await relay.stop()  // nobody answers
    const sync = started(db, team, { deadlineMs: 100 })
    expect(await sync.whenLive()).toEqual({ kind: 'offline' })
  })
})

describe('a text the relay sent', () => {
  it('loses its control characters and is capped at 200 characters', () => {
    expect(untrusted('ok\u0000\u001b[31m fine\u007f\u0085')).toBe('ok[31m fine')
    expect(untrusted('x'.repeat(300))).toHaveLength(200)
  })
})

describe('joining a team brain', () => {
  const NOW = '2026-11-03T08:00:00.000Z'
  const READ_ONLY = 'This shared brain is read-only right now: it is still joining its team brain. Reads still work; try the write again once it is back.'
  /** what the team file held each time the Sync persisted it */
  const persisted: string[][] = []
  const persist = (file: TeamFile) => { persisted.push((['join', 'accept', 'identity', 'key'] as const).filter(k => file[k] !== undefined)) }
  beforeEach(() => { persisted.length = 0 })

  /** juno's team at its relay, juno's own replica holding the log, and an open invite. */
  async function invited(): Promise<{ team: Team, invite: Invite, link: string }> {
    const team = new Team()
    relay = await FakeRelay.start(BRAIN, team.genesis())
    team.deliver(relay.log[0].record, 1, relay.log[0].at)  // juno's replica holds the log as the relay has it: the anchor comes from it
    relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
    const invite = newInvite(relay.host, BRAIN, NOW)
    relay.openInvite(inviteNotice(invite, team.owner.device.sign))
    return { team, invite, link: inviteLink(invite) }
  }
  /** An empty brain and its join (team file in memory). */
  function joiner(link: string, handle = 'lasse') {
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    return { db, eml: EML.fromConnection(db, 'test'), file: joinTeamBrain({ brain: BRAIN, link, handle, now: NOW }) }
  }
  const started = (db: ReturnType<typeof initDatabase>, file: TeamFile, opts: { persist?: (f: TeamFile) => void } = {}): Sync => {
    sync = new Sync(db, file, { deadlineMs: 3000, backoffMs: [20, 100], persist: opts.persist ?? persist })
    sync.start()
    return sync
  }
  /** The inviter's moves, one at a time: open and accept the join, add the member, wrap the key for the joiner's device. */
  function inviter(team: Team, invite: Invite) {
    return {
      accept() {
        const join = openJoin(invite, relay!.joinOf(invite.invite_id), NOW)
        relay!.acceptJoin(joinAccept(invite, join.join_hash, cert(team.owner), team.anchor()))
        return join
      },
      add(join: ReturnType<typeof openJoin>) { relay!.inject(team.addJoiner(join)) },
      key(deviceSign: string, wrapper = team.owner.device, epoch = 0) { relay!.putKey(deviceSign, team.wrappedFor(epoch, deviceSign, wrapper)) },
    }
  }
  const waiting = (s: Sync) => s.state.kind === 'joining' ? s.state.waiting : s.state.kind

  it('joins: the join to the relay, the accept, the login once the owner added the member, the key from the inviter, then live and writable as the member', async () => {
    const { team, invite, link } = await invited()
    const { db, eml, file } = joiner(link)
    const sync = started(db, file)
    expect(sync.mode).toBe('join')
    expect(await sync.whenLive()).toEqual({ kind: 'joining', waiting: 'accept' })
    expect(relay.joins).toHaveLength(1)
    expect(relay.joinOf(invite.invite_id)).toEqual(file.join!.request)
    expect((await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-joining' }) }, env(eml))) as Error).message).toBe(READ_ONLY)
    const play = inviter(team, invite)
    const join = play.accept()
    expect(join.handle).toBe('lasse')
    await until(() => waiting(sync) === 'membership')
    expect(file.join).toBeUndefined()
    expect(file.accept?.inviter).toEqual(cert(team.owner))
    expect(file.accept?.anchor).toEqual(team.anchor())
    // the login is tried again and again while the owner has not added the member
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(waiting(sync)).toBe('membership')
    expect(relay.joins).toHaveLength(1)
    play.add(join)
    await until(() => waiting(sync) === 'key')
    expect(eml.teamBrain()).toBe(BRAIN)
    expect((await failure(sync.write({ name: 'engram.create', input: validNote({ title: 't-no-key' }) }, env(eml))) as Error).message).toBe(READ_ONLY)
    play.key(file.device.sign.publicKey)
    await until(() => sync.state.kind === 'live')
    expect(file.accept).toBeUndefined()
    expect(sync.ownHandle()).toBe('lasse')
    expect(persisted).toEqual([['accept', 'identity'], ['identity']])
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-joined' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-joined', ingested_by: 'lasse' })
    expect(relay.log).toHaveLength(3)
  })

  it('joins a brain that rotated before the invite, sealed entries in both epochs ahead of its add_member: the later key opens them all', async () => {
    const { team, invite, link } = await invited()
    relay.inject(team.write(team.owner, 't-epoch-0'))
    relay.inject(team.rotate())
    relay.inject(team.write(team.owner, 't-epoch-1'))
    const { db, eml, file } = joiner(link)
    const sync = started(db, file)
    await sync.whenLive()
    const play = inviter(team, invite)
    const join = play.accept()
    play.add(join)  // the handle sealed under epoch 1
    await until(() => waiting(sync) === 'key')
    play.key(file.device.sign.publicKey, team.owner.device, 1)
    await until(() => sync.state.kind === 'live')
    expect(titles(eml)).toEqual(['t-epoch-0', 't-epoch-1'])
    expect(sync.ownHandle()).toBe('lasse')
    const engram = await sync.write({ name: 'engram.create', input: validNote({ title: 't-after-rotation' }) }, env(eml))
    expect(engram).toMatchObject({ title: 't-after-rotation', ingested_by: 'lasse' })
    expect(relay.log).toHaveLength(6)
  })

  it('takes its first key from the inviter\'s device only', async () => {
    const { team, invite, link } = await invited()
    const mira = person('mira')
    relay.inject(team.addMember(mira))
    const { db, file } = joiner(link)
    const sync = started(db, file)
    await sync.whenLive()
    const play = inviter(team, invite)
    const join = play.accept()
    play.add(join)
    play.key(file.device.sign.publicKey, mira.device)  // mira is a member, but not the inviter
    await until(() => waiting(sync) === 'key')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(waiting(sync)).toBe('key')
    expect(file.accept).toBeDefined()
    play.key(file.device.sign.publicKey)
    await until(() => sync.state.kind === 'live')
    expect(file.accept).toBeUndefined()
  })

  it('stops when the invite closes under it: cancelled, taken by another join, or not open at the relay', async () => {
    const { invite, link } = await invited()
    const first = joiner(link)
    const sync = started(first.db, first.file)
    await sync.whenLive()
    const second = joiner(link, 'nilo')
    const other = new Sync(second.db, second.file, { deadlineMs: 3000, backoffMs: [20, 100] })
    other.start()
    try {
      expect(await other.whenLive()).toEqual({ kind: 'stopped', why: 'its invite was closed (taken)', relay: { code: 'invite_closed', message: 'taken' } })
    } finally {
      other.close()
    }
    relay.closeInvite(invite.invite_id, 'cancelled')
    await until(() => sync.state.kind === 'stopped')
    expect(sync.state).toEqual({ kind: 'stopped', why: 'its invite was closed (cancelled)', relay: { code: 'invite_closed', message: 'cancelled' } })
    expect(first.eml.hasGenesis()).toBe(false)
    expect(first.file.join).toBeDefined()
    sync.close()
    const unknown = joiner(inviteLink(newInvite(relay.host, BRAIN, NOW)))
    const stray = started(unknown.db, unknown.file)
    expect(await stray.whenLive()).toEqual({ kind: 'stopped', why: 'its invite was closed (unknown)', relay: { code: 'invite_closed', message: 'unknown' } })
    expect(persisted).toEqual([])
  })

  it('sends the same join again after a restart or a closed connection, and logs in straight away once the accept is in the file', async () => {
    const { team, invite, link } = await invited()
    const { db, file } = joiner(link)
    let sync = started(db, file)
    await sync.whenLive()
    relay.closeAll(1000)  // the relay waits only so long for an accept
    await until(() => relay!.joins.length === 2 && waiting(sync) === 'accept')
    sync.close()
    sync = started(db, file)
    expect(await sync.whenLive()).toEqual({ kind: 'joining', waiting: 'accept' })
    expect(relay.joins).toHaveLength(3)
    expect(new Set(relay.joins).size).toBe(1)
    const play = inviter(team, invite)
    const join = play.accept()
    await until(() => waiting(sync) === 'membership')
    sync.close()
    sync = started(db, file)
    play.add(join)
    play.key(file.device.sign.publicKey)
    await until(() => sync.state.kind === 'live')
    expect(relay.joins).toHaveLength(3)
  })

  /** The inviter's checkpoint right after the member was added, with `stateHash` (default: the right one), in the relay's log. */
  function checkpointed(team: Team, join: ReturnType<typeof openJoin>, stateHash?: string): void {
    const added = team.addJoiner(join)
    relay!.inject(added)
    team.deliver(added, 2, relay!.log[1].at)
    relay!.inject(team.write(team.owner, '', { call: 'brain.checkpoint', args: { seq: 2, state_hash: stateHash ?? team.stateHash() } }))
  }

  it('replays the checkpoint the inviter wrote and reaches the state it names', async () => {
    const { team, invite, link } = await invited()
    const { db, eml, file } = joiner(link)
    const sync = started(db, file)
    await sync.whenLive()
    const play = inviter(team, invite)
    checkpointed(team, play.accept())
    play.key(file.device.sign.publicKey)
    await until(() => sync.state.kind === 'live')
    expect(eml.hasGenesis()).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM op_log WHERE rejected IS NULL').get()).toEqual({ n: 3 })
  })

  it('stops when the checkpoint the inviter wrote names another state', async () => {
    const { team, invite, link } = await invited()
    const { db, file } = joiner(link)
    const sync = started(db, file)
    await sync.whenLive()
    const play = inviter(team, invite)
    checkpointed(team, play.accept(), 'f'.repeat(64))
    play.key(file.device.sign.publicKey)
    await until(() => sync.state.kind === 'stopped')
    expect(sync.state).toEqual({ kind: 'stopped', why: 'the state at seq 2 differs from the checkpoint' })
  })

  it('stops when the accept cannot be kept in the team file, with the join still there for a restart', async () => {
    const { team, invite, link } = await invited()
    const { db, file } = joiner(link)
    const sync = started(db, file, { persist: () => { throw new Error('disk full') } })
    await sync.whenLive()
    inviter(team, invite).accept()
    await until(() => sync.state.kind === 'stopped')
    expect(sync.state).toEqual({ kind: 'stopped', why: 'its team file could not be written' })
    expect(file.join).toBeDefined()
    expect(file.accept).toBeUndefined()
  })
})

describe('checkpoints', () => {
  /** The opened envelope of a relay log entry (juno's team holds every epoch key). */
  const opened = (team: Team, entry: { record: Record<string, unknown> }) => openRecord(entry.record, BRAIN, epoch => team.keys[epoch]?.key).envelope
  const checkpoint = (team: Team, entry: { record: Record<string, unknown> }, seq: number) => {
    const op = opened(team, entry)
    expect(op.call).toBe('brain.checkpoint')
    expect(op.args).toEqual({ seq, state_hash: team.stateHash() })
    expect(op.provenance.handle).toBe('juno')
  }
  /** mira, a member whose device writes from elsewhere. */
  async function withMira(): Promise<{ team: Team, relay: FakeRelay, sync: Sync, eml: EML, mira: ReturnType<typeof person> }> {
    const c = await connected()
    const mira = person('mira')
    c.relay.inject(c.team.addMember(mira))
    await until(() => c.team.head === 2)
    return { ...c, mira }
  }

  it('writes the hash of the state after its head, right after it, as a sealed op of its member', async () => {
    const { team, relay, sync, eml } = await connected()
    expect(await sync.checkpoint()).toEqual({ seq: 2 })
    checkpoint(team, relay.log[1], 1)
    await sync.write({ name: 'engram.create', input: validNote({ title: 't-after' }) }, env(eml))
    expect(await sync.checkpoint()).toEqual({ seq: 4 })
    checkpoint(team, relay.log[3], 3)
    expect(relay.log).toHaveLength(4)
    expect(CHECKPOINT_EVERY).toBe(200)
  })

  it('tries again when another write came in between — three times, then CHECKPOINT_NOT_ADJACENT', async () => {
    const { team, relay, sync, mira } = await withMira()
    relay.onAppend = (n) => { if (n <= 2) relay.inject(team.write(mira, `t-slip-${n}`)) }
    expect(await sync.checkpoint()).toEqual({ seq: 7 })  // 3 slip, 4 stale, 5 slip, 6 stale, 7 counts
    expect(relay.appends).toHaveLength(3)
    checkpoint(team, relay.log[6], 6)
    relay.onAppend = (n) => relay.inject(team.write(mira, `t-slip-${n}`))
    const err = await failure(sync.checkpoint())
    expect(err).toBeInstanceOf(SharedWriteError)
    expect(err).toMatchObject({ status: 409, code: 'CHECKPOINT_NOT_ADJACENT', message: 'The checkpoint did not land right after the state it names; other writes came in between. Try again.' })
    expect(relay.appends).toHaveLength(6)
    expect(relay.log).toHaveLength(13)
    relay.onAppend = null
    expect(await sync.checkpoint()).toEqual({ seq: 14 })
  })

  it('is read-only like a write', async () => {
    const { relay, sync } = await connected()
    relay.closeAll()
    await until(() => sync.state.kind === 'offline')
    expect(((await failure(sync.checkpoint())) as Error).message).toMatch(/read-only right now: it is not connected to its relay/)
  })

  it('writes one by itself once the log grew by checkpointEvery entries, and stands back when another device\'s counted first', async () => {
    const { team, relay, sync, mira } = await (async () => {
      const c = await connected({ checkpointEvery: 4 })
      const mira = person('mira')
      c.relay.inject(c.team.addMember(mira))  // entry 2: one since the genesis
      await until(() => c.team.head === 2)
      return { ...c, mira }
    })()
    for (let i = 1; i <= 3; i++) relay.inject(team.write(mira, `t-${i}`))  // 3, 4, 5: four since the genesis
    await until(() => relay!.log.length === 6)
    checkpoint(team, relay.log[5], 5)
    expect(relay.appends).toHaveLength(1)
    // mira's checkpoint lands before this device's: the own one is not tried again
    relay.onAppend = () => relay.inject(team.write(mira, '', { call: 'brain.checkpoint', args: { seq: team.head, state_hash: team.stateHash() } }))
    for (let i = 4; i <= 7; i++) relay.inject(team.write(mira, `t-${i}`))  // 7..10
    await until(() => relay!.log.length === 12)  // 11 mira's checkpoint, 12 this device's, stale
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(relay.log).toHaveLength(12)
    expect(relay.appends).toHaveLength(2)
    expect(sync.state).toEqual({ kind: 'live' })
  })

  it('counts from the last checkpoint in the log when it starts', async () => {
    const team = new Team()
    relay = await FakeRelay.start(BRAIN, team.genesis())
    relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
    const other = new Sync(team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device }, { deadlineMs: 3000, backoffMs: [20, 100], checkpointEvery: 1000 })
    other.start()
    await until(() => other.state.kind === 'live')
    for (let i = 1; i <= 3; i++) await other.write({ name: 'engram.create', input: validNote({ title: `t-${i}` }) }, env(EML.fromConnection(team.db, 'test')))
    other.close()
    sync = new Sync(team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device }, { deadlineMs: 3000, backoffMs: [20, 100], checkpointEvery: 3 })
    sync.start()
    await until(() => relay!.log.length === 5)
    checkpoint(team, relay.log[4], 4)
  })
})

describe('inviting into a team brain', () => {
  const NOW = '2026-10-28T09:00:00.000Z'  // the fake relay's clock starts here; a notice may expire at most 7 days after the relay's now
  const persisted: Array<string[]> = []
  const persist = (file: TeamFile) => { persisted.push((file.invites ?? []).map(i => i.invite_id)) }
  beforeEach(() => { persisted.length = 0 })
  const others: Sync[] = []
  afterEach(() => { for (const o of others) o.close(); others.length = 0 })

  /** juno's device, live at its relay, keeping its team file through `persist`. */
  async function owner(): Promise<{ team: Team, relay: FakeRelay, sync: Sync, eml: EML, file: TeamFile }> {
    const team = new Team()
    relay = await FakeRelay.start(BRAIN, team.genesis())
    relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
    const file: TeamFile = { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device, identity: team.owner.identity }
    sync = new Sync(team.db, file, { deadlineMs: 3000, backoffMs: [20, 100], persist })
    sync.start()
    await until(() => sync!.state.kind === 'live')
    return { team, relay, sync, eml: EML.fromConnection(team.db, 'test'), file }
  }
  /** An invitee's empty brain joining with `link`; its Sync is closed with the test. */
  function joiner(link: string, handle = 'lasse') {
    const db = initDatabase(':memory:', undefined, BRAIN, { log: false })
    const file = joinTeamBrain({ brain: BRAIN, link, handle, now: NOW })
    const s = new Sync(db, file, { deadlineMs: 3000, backoffMs: [20, 100] })
    others.push(s)
    s.start()
    return { db, eml: EML.fromConnection(db, 'test'), file, sync: s }
  }
  const pendingOf = (s: Sync, inviteId: string) => s.snapshot().invites.find(i => i.invite_id === inviteId)?.pending ?? null

  it('invites: the notice at the relay, the secret in the team file, the link once; the join comes back opened and waits for the owner', async () => {
    const { sync, file } = await owner()
    const invite = await sync.createInvite(NOW)
    expect(invite.link).toBe(`https://${relay!.host}/i/1/${BRAIN}/${invite.invite_id}#${Buffer.from(file.invites![0].secret).toString('base64url')}`)
    expect(invite.expires_at).toBe('2026-11-04T09:00:00.000Z')
    expect(relay!.invitePuts).toEqual([invite.invite_id])
    expect(relay!.noticeOf(invite.invite_id)).toMatchObject({ invite_id: invite.invite_id, inviter: file.device.sign.publicKey })
    expect(persisted).toEqual([[invite.invite_id]])
    expect(sync.snapshot().invites).toEqual([{ invite_id: invite.invite_id, expires_at: invite.expires_at, pending: null }])
    expect(JSON.stringify(sync.snapshot())).not.toContain(Buffer.from(file.invites![0].secret).toString('base64url'))
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    expect(pendingOf(sync, invite.invite_id)).toMatchObject({ member: lasse.file.identity!.publicKey, handle: 'lasse', received_at: expect.stringMatching(/Z$/) })
    expect(pendingOf(sync, invite.invite_id)!.fingerprint).toMatch(/^[0-9a-f]{5}( [0-9a-f]{5}){7}$/)
    expect(lasse.sync.state).toEqual({ kind: 'joining', waiting: 'accept' })
  })

  it('confirms: the member added with the role, the key wrapped for the new device, the join answered — the joiner goes live and both see two members', async () => {
    const { sync, team, eml } = await owner()
    const invite = await sync.createInvite(NOW)
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    const member = await sync.confirmJoin(invite.invite_id, 'member', NOW)
    expect(member).toMatchObject({ id: lasse.file.identity!.publicKey, handle: 'lasse', role: 'member', devices: 1, self: false })
    expect(sync.snapshot().invites).toEqual([])
    expect(relay!.accepts).toEqual([invite.invite_id])
    expect(relay!.keyPuts).toContain(lasse.file.device.sign.publicKey)
    await until(() => lasse.sync.state.kind === 'live')
    expect(lasse.sync.ownHandle()).toBe('lasse')
    const written = await lasse.sync.write({ name: 'engram.create', input: validNote({ title: 't-by-lasse' }) }, env(lasse.eml))
    expect(written).toMatchObject({ title: 't-by-lasse', ingested_by: 'lasse' })
    await until(() => titles(eml).includes('t-by-lasse'))
    expect(sync.snapshot().members.map(m => [m.handle, m.role, m.self])).toEqual([['juno', 'owner', true], ['lasse', 'member', false]])
    expect(lasse.sync.snapshot().members.map(m => [m.handle, m.role, m.self])).toEqual([['juno', 'owner', false], ['lasse', 'member', true]])
    expect(team.db.prepare("SELECT COUNT(*) AS n FROM op_log WHERE json_extract(payload, '$.call') = 'team.add_member'").get()).toEqual({ n: 1 })
  })

  it('confirms as owner when asked; the new owner can invite', async () => {
    const { sync } = await owner()
    const invite = await sync.createInvite(NOW)
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    expect(await sync.confirmJoin(invite.invite_id, 'owner', NOW)).toMatchObject({ handle: 'lasse', role: 'owner' })
    await until(() => lasse.sync.state.kind === 'live')
    const second = await lasse.sync.createInvite(NOW)
    expect(relay!.invitePuts).toEqual([invite.invite_id, second.invite_id])
  })

  it('a member who is no owner cannot invite; a confirm without a waiting join is null; nobody confirms an unknown invite', async () => {
    const { sync } = await owner()
    const invite = await sync.createInvite(NOW)
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    await sync.confirmJoin(invite.invite_id, 'member', NOW)
    await until(() => lasse.sync.state.kind === 'live')
    const err = await failure(lasse.sync.createInvite(NOW)) as InviteError
    expect(err).toBeInstanceOf(InviteError)
    expect([err.status, err.code, err.message]).toEqual([403, 'NOT_OWNER', 'Only an owner can invite.'])
    expect(await sync.confirmJoin(invite.invite_id, 'member', NOW)).toBeNull()
    expect(await sync.confirmJoin('AAAAAAAAAAAAAAAAAAAAAA', 'member', NOW)).toBeNull()
    expect(await sync.cancelInvite('AAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
  })

  it('cancels: the waiting invitee stops, the invite is gone from the file and the snapshot', async () => {
    const { sync } = await owner()
    const invite = await sync.createInvite(NOW)
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    expect(await sync.cancelInvite(invite.invite_id)).toBe(true)
    await until(() => lasse.sync.state.kind === 'stopped')
    expect(lasse.sync.state).toEqual({ kind: 'stopped', why: 'its invite was closed (cancelled)', relay: { code: 'invite_closed', message: 'cancelled' } })
    expect(sync.snapshot().invites).toEqual([])
    expect(persisted.at(-1)).toEqual([])
    expect(lasse.eml.hasGenesis()).toBe(false)
  })

  it('finishes a confirm that was cut short: the member already in the log is not added again, the key is put, the join answered', async () => {
    const { sync, team } = await owner()
    const invite = await sync.createInvite(NOW)
    const lasse = joiner(invite.link)
    await until(() => pendingOf(sync, invite.invite_id) !== null)
    // as if an earlier confirm had appended add_member and died: the record is in the relay's log already
    const join = pendingOf(sync, invite.invite_id)!
    relay!.inject(team.addJoiner({ member: join.member, device_cert: relay!.joinOf(invite.invite_id)!.device_cert, handle: join.handle }))
    await until(() => sync.snapshot().members.length === 2)
    expect(await sync.confirmJoin(invite.invite_id, 'member', NOW)).toMatchObject({ handle: 'lasse', role: 'member' })
    expect(team.db.prepare("SELECT COUNT(*) AS n FROM op_log WHERE json_extract(payload, '$.call') = 'team.add_member'").get()).toEqual({ n: 1 })
    await until(() => lasse.sync.state.kind === 'live')
    expect(lasse.sync.ownHandle()).toBe('lasse')
  })

  it('refuses a join whose handle the log binds already: HANDLE_TAKEN, the invite stays open for a decline', async () => {
    const { sync } = await owner()
    const first = await sync.createInvite(NOW)
    const lasse = joiner(first.link)
    await until(() => pendingOf(sync, first.invite_id) !== null)
    await sync.confirmJoin(first.invite_id, 'member', NOW)
    await until(() => lasse.sync.state.kind === 'live')
    const second = await sync.createInvite(NOW)
    joiner(second.link, 'lasse')
    await until(() => pendingOf(sync, second.invite_id) !== null)
    const err = await failure(sync.confirmJoin(second.invite_id, 'member', NOW)) as InviteError
    expect([err.status, err.code, err.message]).toEqual([409, 'HANDLE_TAKEN', 'The handle lasse is taken in this brain; the invitee has to choose another.'])
    expect(sync.snapshot().invites.map(i => i.invite_id)).toEqual([second.invite_id])
    expect(await sync.cancelInvite(second.invite_id)).toBe(true)
  })

  it('drops a join for an invite it does not hold, and an expired invite with its join', async () => {
    const { sync, file } = await owner()
    const invite = await sync.createInvite(NOW)
    // another owner device's invite, unknown here
    const stray = newInvite(relay!.host, BRAIN, NOW)
    relay!.openInvite(inviteNotice(stray, file.device.sign))
    joiner(inviteLink(stray), 'nilo')
    await until(() => relay!.joins.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sync.snapshot().invites).toEqual([{ invite_id: invite.invite_id, expires_at: invite.expires_at, pending: null }])
    // the invite expired before its join came: both go
    file.invites![0].expires_at = '2026-01-01T00:00:00.000Z'
    joiner(invite.link)
    await until(() => relay!.joins.length >= 2)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sync.snapshot().invites).toEqual([])
    expect(file.invites).toBeUndefined()
  })

  it('a team file keeps its invites across a restart, and a pending join is pushed again after the login', async () => {
    const { team, relay: r, file } = await owner()
    const invite = await sync!.createInvite(NOW)
    joiner(invite.link)
    await until(() => r.joins.length === 1)
    sync!.close()
    const written = readTeamFileRoundTrip(file)
    expect(written.invites).toEqual([{ invite_id: invite.invite_id, secret: file.invites![0].secret, expires_at: invite.expires_at }])
    sync = new Sync(team.db, written, { deadlineMs: 3000, backoffMs: [20, 100], persist })
    sync.start()
    await until(() => pendingOf(sync!, invite.invite_id) !== null)
    expect(pendingOf(sync!, invite.invite_id)).toMatchObject({ handle: 'lasse' })
  })
})

/** The team file as written and read back through team-file.ts, in a temporary data dir. */
function readTeamFileRoundTrip(file: TeamFile): TeamFile {
  const dir = mkdtempSync(join(tmpdir(), 'eml-team-file-'))
  try {
    writeTeamFile(dir, file)
    return readTeamFile(dir, file.brain) as TeamFile
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
