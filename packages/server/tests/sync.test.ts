import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { ready } from '@engramprotocol/protocol'
import { EML, CommandError } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { Sync, type SyncState } from '../src/sync/sync'
import { SharedWriteError, applyWrite } from '../src/write'
import { FakeRelay } from './fake-relay'
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
