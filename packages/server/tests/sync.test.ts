import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { ready } from '@engramprotocol/protocol'
import { EML, CommandError, initDatabase } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { Sync, untrusted, type SyncState } from '../src/sync/sync'
import { createTeamBrain } from '../src/sync/create'
import type { TeamFile } from '../src/sync/team-file'
import { SharedWriteError, applyWrite } from '../src/write'
import { FakeRelay, GRANT } from './fake-relay'
import { BRAIN, Team, person } from './team'

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
async function connected(opts: { withKey?: boolean, deadlineMs?: number } = {}): Promise<{ team: Team, relay: FakeRelay, sync: Sync, eml: EML }> {
  const team = new Team()
  relay = await FakeRelay.start(BRAIN, team.genesis())
  if (opts.withKey !== false) relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
  sync = new Sync(team.db, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device }, { deadlineMs: opts.deadlineMs ?? 3000, backoffMs: [20, 100] })
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
