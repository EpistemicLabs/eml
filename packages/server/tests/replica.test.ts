import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import {
  GENESIS_PREV_HASH, applyMembership, certifyDevice, clearOp, genesisMembers, keyId, newBrainKey, newDeviceKeys, newSigningKey,
  openRecord, ready, rotateKey, sealHandle, sealOp, wrapKey,
  type BrainKey, type DeviceKeys, type KeyPair, type MemberSet, type TeamOp,
} from '@engramprotocol/protocol'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '@engramprotocol/core'
import { verify } from '../../core/src/log/rebuild'
import { validNote } from '../../core/tests/fixtures'
import { Replica } from '../src/sync/replica'
import { readTeamFile, teamFilePath, writeTeamFile } from '../src/sync/team-file'

// v0.21 replica (spec team-brain-sync-client-spec §4): a shared brain takes
// the entries its relay delivers. The test plays the relay: records built with
// the protocol package, delivered at the next seq, a second apart.

const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const OTHER = '0f8fad5b-d9cb-469f-a165-70867728950e'
const T0 = Date.parse('2026-10-28T08:00:00.000Z')
const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }

interface Person { identity: KeyPair, device: DeviceKeys, handle: string }
const person = (handle: string): Person => ({ identity: newSigningKey(), device: newDeviceKeys(), handle })
const cert = (p: Person) => certifyDevice(p.identity, { brain: BRAIN, device_sign: p.device.sign.publicKey, device_enc: p.device.enc.publicKey, created_at: '2026-10-28T08:00:00.000Z' })
const json = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value))
const time = (seq: number): string => new Date(T0 + seq * 1000).toISOString()

/**
 * A team brain: its owner juno, whose device this replica runs on, the brain
 * keys, and the member set as the relay's log has it. Records are built
 * against the replica's own log (base_seq = its head).
 */
class Team {
  readonly owner = person('juno')
  readonly keys: BrainKey[] = [newBrainKey(0)]
  readonly db: Database.Database
  replica: Replica
  set!: MemberSet

  constructor() {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    this.db = (eml as any).db
    this.db.exec('DELETE FROM op_snapshots; DELETE FROM op_log')  // a new brain file writes a private genesis
    this.replica = new Replica(this.db, { v: 1, brain: BRAIN, device: this.owner.device })
  }

  get head(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM op_log').get() as { n: number }).n
  }

  /** The genesis: juno founds the brain as its root, epoch 0, at the empty state. */
  genesis(): Record<string, unknown> {
    const op_id = crypto.randomUUID()
    const member = this.owner.identity.publicKey
    const record = json(clearOp(this.envelope(this.owner, 'brain.genesis', {
      state_hash: EML.fromConnection(this.db, 'test').stateHash(),
      root: { member, device_cert: cert(this.owner), handle: sealHandle(this.owner.handle, { brain: BRAIN, op_id, member }, this.keys[0]), key_id: keyId(this.keys[0].key) },
    }, op_id), this.owner.device.sign).record)
    this.set = genesisMembers(openRecord(record, BRAIN, () => undefined))
    return record
  }

  /** A sealed op by `author` (default: an engram.create titled `title`) under the current epoch. */
  write(author: Person, title: string, opts: { epoch?: number, handle?: string, args?: unknown, call?: string, schema?: number, team?: Partial<TeamOp['team']> } = {}): Record<string, unknown> {
    const env = this.envelope(author, opts.call ?? 'engram.create', opts.args ?? validNote({ title }), crypto.randomUUID(), opts.team)
    env.provenance = { ...NONE, handle: opts.handle ?? author.handle, ingestion_method: 'mcp' }
    if (opts.schema !== undefined) env.schema = opts.schema
    return json(sealOp(env, author.device.sign, this.keys[opts.epoch ?? this.set.epoch]).record)
  }

  /** juno adds `joiner`; the relay's member set follows (unless it refuses the record). */
  addMember(joiner: Person): Record<string, unknown> {
    const op_id = crypto.randomUUID()
    const member = joiner.identity.publicKey
    const handle = sealHandle(joiner.handle, { brain: BRAIN, op_id, member }, this.keys[this.set.epoch])
    return this.membership(this.envelope(this.owner, 'team.add_member', { member, role: 'member', device_cert: cert(joiner), handle }, op_id))
  }

  /** juno rotates to the next brain key; the relay's member set follows. */
  rotate(): Record<string, unknown> {
    const { next, args } = rotateKey(this.set, this.keys[this.set.epoch])
    this.keys.push(next)
    return this.membership(this.envelope(this.owner, 'team.rotate_key', args))
  }

  /** The key of `epoch`, wrapped by juno for `device` (default: this replica's). */
  wrapped(epoch: number, device = this.owner.device): unknown {
    return json(wrapKey(this.set, this.keys[epoch], device.sign.publicKey, this.owner.device.sign))
  }

  deliver(record: unknown, seq = this.head + 1, at = time(seq)) {
    return this.replica.take({ seq, at, record })
  }

  private membership(env: TeamOp): Record<string, unknown> {
    const record = json(clearOp(env, this.owner.device.sign).record)
    try {
      this.set = applyMembership(this.set, openRecord(record, BRAIN, () => undefined))
    } catch {
      // a record the member set refuses: the log keeps it, the set stays
    }
    return record
  }

  private envelope(author: Person, call: string, args: unknown, op_id: string = crypto.randomUUID(), team: Partial<TeamOp['team']> = {}): TeamOp {
    const head = this.head
    const link = head === 0 ? GENESIS_PREV_HASH : (this.db.prepare('SELECT hash FROM op_log WHERE seq = ?').get(head) as { hash: string }).hash
    return {
      op_id, schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never, provenance: NONE,
      team: { brain: BRAIN, device: author.device.sign.publicKey, base_seq: head, head_hash: link, ...team },
    }
  }
}

/** A team whose genesis the replica took, holding the epoch-0 key. */
function founded(): Team {
  const team = new Team()
  expect(team.deliver(team.genesis())).toEqual({ kind: 'applied' })
  team.replica.addKey(team.wrapped(0))
  return team
}

const titles = (db: Database.Database): string[] =>
  (db.prepare(`SELECT title FROM engrams WHERE title LIKE 't-%' ORDER BY title`).all() as Array<{ title: string }>).map(r => r.title)
const entries = (db: Database.Database) => db.prepare('SELECT seq, op_id, rejected FROM op_log ORDER BY seq').all() as Array<{ seq: number, op_id: string | null, rejected: string | null }>

beforeAll(async () => { await ready() })

describe('the replica', () => {
  it('replays a log from its genesis: the genesis, members, a rotation and their writes', () => {
    const team = founded()
    const ava = person('ava')
    expect(team.deliver(team.write(team.owner, 't-juno'))).toEqual({ kind: 'applied' })
    expect(team.deliver(team.addMember(ava))).toEqual({ kind: 'applied' })
    expect(team.deliver(team.write(ava, 't-ava'))).toEqual({ kind: 'applied' })
    expect(team.deliver(team.rotate())).toEqual({ kind: 'applied' })
    team.replica.addKey(team.wrapped(1))
    expect(team.deliver(team.write(ava, 't-ava-1'))).toEqual({ kind: 'applied' })
    expect(titles(team.db)).toEqual(['t-ava', 't-ava-1', 't-juno'])
    const byAva = team.db.prepare(`SELECT ingested_by FROM engrams WHERE title = 't-ava'`).get() as { ingested_by: string }
    expect(byAva.ingested_by).toBe('ava')
    expect(entries(team.db).every(e => e.rejected === null)).toBe(true)
    expect(verify(team.db)).toMatchObject({ ok: true, entries: 6 })
    expect(team.replica.state).toEqual({ kind: 'live' })
  })

  it('waits for the key of the current epoch, writes nothing, and goes on once the key is there', () => {
    const team = new Team()
    expect(team.deliver(team.genesis())).toEqual({ kind: 'applied' })
    const write = team.write(team.owner, 't-later')
    expect(team.deliver(write)).toEqual({ kind: 'waiting', epoch: 0 })
    expect(team.replica.state).toEqual({ kind: 'waiting', epoch: 0 })
    expect(team.head).toBe(1)
    team.replica.addKey(team.wrapped(0))
    expect(team.deliver(write)).toEqual({ kind: 'applied' })
    expect(team.replica.state).toEqual({ kind: 'live' })
  })

  it('refuses a key that is not the log\'s, or not wrapped for this device', () => {
    const team = founded()
    const stranger = newBrainKey(0)
    const forged = json(wrapKey(team.set, stranger, team.owner.device.sign.publicKey, team.owner.device.sign))
    expect(() => team.replica.addKey(forged)).toThrow(/not the key the log names/)
    expect(() => team.replica.addKey(team.wrapped(0, newDeviceKeys()))).toThrow()
  })

  describe('keeps as rejected, in the chain and changing nothing', () => {
    it('a record whose op_id is in the log already, unopened', () => {
      const team = founded()
      const write = team.write(team.owner, 't-once')
      expect(team.deliver(write)).toEqual({ kind: 'applied' })
      const again = team.deliver(write)
      expect(again).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^DUPLICATE: /) })
      const dup = team.db.prepare('SELECT op_id, payload, signature FROM op_log WHERE seq = 3').get() as { op_id: string, payload: string, signature: Buffer | null }
      expect(dup.op_id).toBe(write.op_id)
      expect(JSON.parse(dup.payload)).toEqual(write)
      expect(dup.signature).toBeNull()
      expect(titles(team.db)).toEqual(['t-once'])
    })

    it('a record that does not open, with its op_id only when it is one', () => {
      const team = founded()
      const garbled = { ...team.write(team.owner, 't-garbled'), ct: 'AAAA' }
      expect(team.deliver(garbled)).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^UNOPENABLE: /) })
      const nameless = { ...team.write(team.owner, 't-nameless'), op_id: 'not-a-uuid' }
      expect(team.deliver(nameless)).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^UNOPENABLE: /) })
      expect(entries(team.db).slice(1).map(e => e.op_id)).toEqual([garbled.op_id, null])
      expect(team.deliver(team.write(team.owner, 't-after'))).toEqual({ kind: 'applied' })
      expect(titles(team.db)).toEqual(['t-after'])
      expect(verify(team.db)).toMatchObject({ ok: true, entries: 4 })
    })

    it('a sealed record under an older epoch, unopened, though this device holds that key', () => {
      const team = founded()
      expect(team.deliver(team.rotate())).toEqual({ kind: 'applied' })
      team.replica.addKey(team.wrapped(1))
      const stale = team.write(team.owner, 't-stale', { epoch: 0 })
      expect(team.deliver(stale)).toEqual({ kind: 'rejected', why: 'REFUSED: the op is sealed under epoch 0, the brain is at 1' })
      const kept = team.db.prepare('SELECT payload FROM op_log WHERE seq = 3').get() as { payload: string }
      expect(JSON.parse(kept.payload)).toEqual(stale)
      expect(titles(team.db)).toEqual([])
    })

    it('a sealed record under an epoch the log has not reached', () => {
      const team = founded()
      team.keys.push(newBrainKey(1))
      expect(team.deliver(team.write(team.owner, 't-ahead', { epoch: 1 }))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: .*epoch 1, the brain is at 0/) })
    })

    it('an op whose author is not allowed: a handle that is not its member\'s, a device that is no member\'s', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-posing', { handle: 'ava' }))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: .*handle/) })
      expect(team.deliver(team.write(person('mallory'), 't-stranger'))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: .*not a current device/) })
      expect(titles(team.db)).toEqual([])
    })

    it('a membership record the member set does not allow', () => {
      const team = founded()
      const ava = person('ava')
      expect(team.deliver(team.addMember(ava))).toEqual({ kind: 'applied' })
      expect(team.deliver(team.addMember(ava))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: .*member already/) })
    })

    it('an op written after its own seq', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-future', { team: { base_seq: 2 } }))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: base_seq 2/) })
    })

    it('an op the brain refuses, and a rebuild skips it', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-empty', { args: { ...validNote({ title: 't-empty' }), content: '' } }))).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^INVALID: /) })
      expect(team.deliver(team.write(team.owner, 't-kept'))).toEqual({ kind: 'applied' })
      expect(titles(team.db)).toEqual(['t-kept'])
      expect(verify(team.db)).toMatchObject({ ok: true, entries: 3 })
    })

    it('a checkpoint before the head: its format is checked, not its hash', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-1'))).toEqual({ kind: 'applied' })
      const old = team.write(team.owner, '', { call: 'brain.checkpoint', args: { seq: 1, state_hash: 'f'.repeat(64) }, team: { base_seq: 1, head_hash: (team.db.prepare('SELECT hash FROM op_log WHERE seq = 1').get() as { hash: string }).hash } })
      expect(team.deliver(old)).toEqual({ kind: 'applied' })
      const malformed = team.write(team.owner, '', { call: 'brain.checkpoint', args: { seq: 3, state_hash: 'nope' } })
      expect(team.deliver(malformed)).toMatchObject({ kind: 'rejected', why: expect.stringMatching(/^REFUSED: state_hash/) })
    })
  })

  describe('stops, writes nothing and takes nothing more', () => {
    const stopped = (team: Team, why: RegExp) => {
      const before = team.head
      expect(team.replica.state).toMatchObject({ kind: 'stopped', why: expect.stringMatching(why) })
      expect(team.deliver(team.write(team.owner, 't-after-stop'))).toMatchObject({ kind: 'stopped' })
      expect(team.head).toBe(before)
    }

    it('on a gap', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-gap'), 3)).toMatchObject({ kind: 'stopped' })
      stopped(team, /expects seq 2/)
    })

    it('on a time that goes back', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-back'), 2, time(-1))).toMatchObject({ kind: 'stopped' })
      stopped(team, /before the head/)
    })

    it('on a fork: the author\'s link at base_seq is not this log\'s', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-fork', { team: { head_hash: 'a'.repeat(64) } }))).toMatchObject({ kind: 'stopped' })
      stopped(team, /author's log differs/)
    })

    it('on a checkpoint at the head whose state is not this replica\'s', () => {
      const team = founded()
      const checkpoint = team.write(team.owner, '', { call: 'brain.checkpoint', args: { seq: 1, state_hash: 'f'.repeat(64) } })
      expect(team.deliver(checkpoint)).toMatchObject({ kind: 'stopped' })
      stopped(team, /differs from the checkpoint/)
    })

    it('on a log that does not start with a genesis', () => {
      const team = new Team()
      team.genesis()
      expect(team.deliver(team.write(team.owner, 't-first'))).toMatchObject({ kind: 'stopped', why: expect.stringMatching(/does not start with a genesis/) })
      expect(team.head).toBe(0)
    })

    it('on a genesis that names another state than the empty brain\'s', () => {
      const team = new Team()
      EML.fromConnection(team.db, 'test').apply({ name: 'engram.create', input: validNote({ title: 't-local' }) })
      team.db.exec('DELETE FROM op_snapshots; DELETE FROM op_log')
      const genesis = team.genesis()
      team.db.exec(`DELETE FROM engrams WHERE title = 't-local'`)
      expect(team.deliver(genesis)).toMatchObject({ kind: 'stopped', why: expect.stringMatching(/does not found this brain/) })
      expect(team.head).toBe(0)
    })

    it('until an update, on a newer brain schema or protocol version', () => {
      const team = founded()
      expect(team.deliver(team.write(team.owner, 't-newer', { schema: CURRENT_BRAIN_SCHEMA_VERSION + 1 }))).toMatchObject({ kind: 'update_needed' })
      expect(team.head).toBe(1)
      const other = founded()
      expect(other.deliver({ ...other.write(other.owner, 't-v2'), v: 2 })).toMatchObject({ kind: 'update_needed' })
    })

    it('when the team file is for another brain than the genesis names', () => {
      const team = founded()
      const elsewhere = new Replica(team.db, { v: 1, brain: OTHER, device: team.owner.device })
      expect(elsewhere.state).toMatchObject({ kind: 'stopped', why: expect.stringMatching(/team file/) })
    })
  })

  it('after a restart, knows the members, the epoch and the handles again from the log', () => {
    const team = founded()
    const ava = person('ava')
    team.deliver(team.addMember(ava))
    team.deliver(team.rotate())
    team.replica = new Replica(team.db, { v: 1, brain: BRAIN, device: team.owner.device })
    team.replica.addKey(team.wrapped(1))
    expect(team.deliver(team.write(ava, 't-ava-after-restart'))).toEqual({ kind: 'applied' })
    expect(team.deliver(team.write(team.owner, 't-posing-after-restart', { handle: 'ava' }))).toMatchObject({ kind: 'rejected' })
  })
})

describe('the team file', () => {
  it('round-trips, owner-only, named by the team brain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eml-team-file-'))
    try {
      const device = newDeviceKeys()
      expect(readTeamFile(dir, BRAIN)).toBeNull()
      writeTeamFile(dir, { v: 1, brain: BRAIN, device })
      const back = readTeamFile(dir, BRAIN)
      expect(back?.device.sign.publicKey).toBe(device.sign.publicKey)
      expect(back?.device.enc.publicKey).toBe(device.enc.publicKey)
      if (process.platform !== 'win32') expect(statSync(teamFilePath(dir, BRAIN)).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
