import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers'
import {
  ProtocolError, applyMembership, canonicalJson, checkAuthor, clearOp, genesisMembers, memberHandles, newDeviceKeys,
  openRecord, ready, sealHandle, signingKeyFromSeed, type OpenedOp, type TeamOp,
} from '../src'
import { sealHandleWith } from '../src/membership'
import { BRAIN, K, ZERO, addMember, cert, clear, envelope, found, keyFor, nodeOpen, person, rotation, sha, write } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §3, block 4): the membership
// records, the reducer every reader runs over them, and a member's check of
// an op's author — including the handle, which only members can read.

const V = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'membership.json'), 'utf-8'))

beforeAll(() => ready())

describe('the vector', () => {
  it('reproduces the handle box; it opens with the epoch-0 key and the canonical {brain, op_id, member}', () => {
    const at = JSON.parse(V.handle.aad)
    expect(sealHandleWith(sha('handle nonce').subarray(0, 24), V.handle.text, at, { epoch: 0, key: sha('brain key 0') })).toEqual(V.handle.box)
    const plain = nodeOpen(sha('brain key 0'), Buffer.from(V.handle.box.nonce, 'base64url'), V.handle.aad, Buffer.from(V.handle.box.ct, 'base64url'))
    // padded to 64 bytes: the length, the UTF-8 text, zeros — the ciphertext is the same size for every handle
    expect(plain).toHaveLength(64)
    expect(Array.from(plain.subarray(0, 5))).toEqual([4, ...Buffer.from('juno')])
    expect(plain.subarray(5).every(b => b === 0)).toBe(true)
  })

  it('every handle seals to the same size', () => {
    const at = JSON.parse(V.handle.aad)
    const key = { epoch: 0, key: sha('brain key 0') }
    expect(sealHandle('a', at, key).ct.length).toBe(sealHandle('z'.repeat(63), at, key).ct.length)
  })

  it('the genesis record founds the vector member set: the root as the one owner, epoch 0', () => {
    const set = genesisMembers(openRecord(V.genesis.record, BRAIN, () => undefined))
    expect(set).toEqual(V.genesis.member_set)
    expect(Object.keys(set.members)).toEqual([K.identity.public_key])
    expect(set.members[K.identity.public_key].role).toBe('owner')
    expect(memberHandles(set, e => (e === 0 ? sha('brain key 0') : undefined))).toEqual({ [K.identity.public_key]: 'juno' })
  })
})

describe('the reducer, played through a team brain', () => {
  it('founds, adds a member, and both write under their handles', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, bo))
    expect(Object.keys(two.members)).toEqual([ada.identity.publicKey, bo.identity.publicKey])
    expect(two.members[bo.identity.publicKey].role).toBe('member')
    const handles = memberHandles(two, keyFor(keys))
    expect(Object.values(handles)).toEqual(['ada', 'bo'])
    expect(() => checkAuthor(two, write(ada, keys, 0), handles)).not.toThrow()
    expect(() => checkAuthor(two, write(bo, keys, 0), handles)).not.toThrow()
    expect(set.members[bo.identity.publicKey]).toBeUndefined()  // the reducer returns a new set
  })

  it('only an owner adds a member; nobody joins twice; a certificate must be the joiner\'s and new', () => {
    const ada = person('ada')
    const bo = person('bo')
    const cy = person('cy')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, bo))
    expect(() => applyMembership(two, addMember(two, keys, bo, cy))).toThrow(/only an owner adds/)
    expect(() => applyMembership(two, addMember(two, keys, ada, bo))).toThrow(/a member already/)
    const stolen = { ...cy, device: bo.device }
    expect(() => applyMembership(two, addMember(two, keys, ada, stolen))).toThrow(/a device already/)
    expect(() => applyMembership(two, addMember(two, keys, ada, cy, 'admin'))).toThrow(/role is owner or member/)
    const foreign = clear(ada, 'team.add_member', { member: cy.identity.publicKey, role: 'member', device_cert: cert(bo), handle: sealHandle('cy', { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0]) })
    expect(() => applyMembership(two, foreign)).toThrow(/for another member/)
  })

  it('a member adds and revokes their own devices; another member\'s device only an owner revokes', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, bo))
    const phone = newDeviceKeys()
    const three = applyMembership(two, clear(bo, 'team.add_device', { device_cert: cert(bo, phone) }))
    expect(Object.keys(three.members[bo.identity.publicKey].devices)).toEqual([bo.device.sign.publicKey, phone.sign.publicKey])
    expect(() => applyMembership(three, clear(bo, 'team.add_device', { device_cert: cert(ada, newDeviceKeys()) }))).toThrow(/for another member/)
    expect(() => applyMembership(three, clear(bo, 'team.revoke_device', { device: ada.device.sign.publicKey }))).toThrow(/by its member or an owner/)
    const revoked = applyMembership(three, clear(bo, 'team.revoke_device', { device: phone.sign.publicKey }, phone))
    expect(Object.keys(revoked.members[bo.identity.publicKey].devices)).toEqual([bo.device.sign.publicKey])
    expect(revoked.rotation_due).toBe(true)
    const byOwner = applyMembership(three, clear(ada, 'team.revoke_device', { device: phone.sign.publicKey }))
    expect(byOwner.members[bo.identity.publicKey].devices).not.toHaveProperty(phone.sign.publicKey)
    // a revoked device signs nothing any more
    expect(() => applyMembership(revoked, clear(bo, 'team.add_device', { device_cert: cert(bo, newDeviceKeys()) }, phone))).toThrow(/not a current device/)
    expect(() => checkAuthor(revoked, write({ ...bo, device: phone }, keys, 0), memberHandles(revoked, keyFor(keys)))).toThrow(/not a current device/)
  })

  it('a removal makes a rotation due: until it comes, no sealed op and nobody new; then only the new epoch', () => {
    const ada = person('ada')
    const bo = person('bo')
    const cy = person('cy')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, bo))
    const removed = applyMembership(two, clear(ada, 'team.remove_member', { member: bo.identity.publicKey }))
    expect(Object.keys(removed.members)).toEqual([ada.identity.publicKey])
    expect(removed.rotation_due).toBe(true)
    expect(() => checkAuthor(removed, write(ada, keys, 0), memberHandles(removed, keyFor(keys)))).toThrow(/rotation is due/)
    expect(() => applyMembership(removed, addMember(removed, keys, ada, cy))).toThrow(/rotation is due/)
    expect(() => applyMembership(removed, clear(bo, 'team.add_device', { device_cert: cert(bo, newDeviceKeys()) }))).toThrow(/not a current device/)

    expect(() => applyMembership(removed, rotation(removed, [...keys], ada, 2))).toThrow(/next epoch is 1/)
    const rotated = applyMembership(removed, rotation(removed, keys, ada))
    expect(rotated).toMatchObject({ epoch: 1, rotation_due: false })
    const handles = memberHandles(rotated, keyFor(keys))
    expect(() => checkAuthor(rotated, write(ada, keys, 0), handles)).toThrow(/sealed under epoch 0, the brain is at 1/)
    expect(() => checkAuthor(rotated, write(ada, keys, 1), handles)).not.toThrow()
    // the handle sealed under epoch 0 still reads with the epoch-0 key
    expect(handles[ada.identity.publicKey]).toBe('ada')
  })

  it('the last owner stays; an owner leaves when another remains; members neither remove nor rotate', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    expect(() => applyMembership(set, clear(ada, 'team.remove_member', { member: ada.identity.publicKey }))).toThrow(/last owner/)
    const two = applyMembership(set, addMember(set, keys, ada, bo, 'owner'))
    expect(Object.keys(applyMembership(two, clear(ada, 'team.remove_member', { member: ada.identity.publicKey })).members)).toEqual([bo.identity.publicKey])
    const plain = applyMembership(set, addMember(set, keys, ada, bo))
    expect(() => applyMembership(plain, clear(bo, 'team.remove_member', { member: ada.identity.publicKey }))).toThrow(/only an owner removes/)
    expect(() => applyMembership(plain, rotation(plain, [...keys], bo))).toThrow(/only an owner rotates/)
    expect(() => applyMembership(plain, clear(ada, 'team.remove_member', { member: 'toString' }))).toThrow(/not a member/)
  })

  it('refuses unknown calls, extra fields and prototype names', () => {
    const ada = person('ada')
    const { set } = found(ada)
    expect(() => applyMembership(set, clear(ada, 'team.promote', { member: 'x' }))).toThrow(/not a membership record/)
    expect(() => applyMembership(set, clear(ada, 'team.revoke_device', { device: ada.device.sign.publicKey, why: 'lost' }))).toThrow(/no field why/)
    expect(() => applyMembership(set, clear(ada, 'team.revoke_device', { device: 'toString' }))).toThrow(/not a current device/)
  })
})

describe('handles and authors', () => {
  it('an op must name its member\'s handle', () => {
    const ada = person('ada')
    const { set, keys } = found(ada)
    const handles = memberHandles(set, keyFor(keys))
    expect(() => checkAuthor(set, write(ada, keys, 0, 'bo'), handles)).toThrow(/not its member's handle/)
    expect(() => checkAuthor(set, write(ada, keys, 0, null as unknown as string), handles)).toThrow(/not its member's handle/)
  })

  it('a handle taken already belongs to whoever joined with it first; the later member writes nothing', () => {
    const ada = person('ada')
    const twin = person('ada')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, twin))
    const handles = memberHandles(two, keyFor(keys))
    expect(handles).toEqual({ [ada.identity.publicKey]: 'ada', [twin.identity.publicKey]: null })
    expect(() => checkAuthor(two, write(twin, keys, 0), handles)).toThrow(/not its member's handle/)
    expect(() => checkAuthor(two, write(ada, keys, 0), handles)).not.toThrow()
  })

  it('a handle box moved to another member, sealed under a key nobody has, or without a key counts as no handle', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const moved = addMember(set, keys, ada, bo)
    ;(moved.envelope.args as { handle: unknown }).handle = set.handles[0].box
    const two = applyMembership(set, moved)
    expect(memberHandles(two, keyFor(keys))[bo.identity.publicKey]).toBeNull()
    expect(memberHandles(two, () => undefined)).toEqual({ [ada.identity.publicKey]: null, [bo.identity.publicKey]: null })
    expect(() => sealHandle(' ada', { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0])).toThrow(ProtocolError)
    expect(() => sealHandle('a'.repeat(64), { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0])).toThrow(/1–63 characters of a-z, 0-9, _ and -/)
    expect(() => sealHandle('', { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0])).toThrow(/1–63 characters/)
    expect(sealHandle('a'.repeat(63), { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0]).nonce).toHaveLength(32)
  })
})

describe('handle padding', () => {
  it('a box whose padding is not the canonical one counts as no handle', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const env = envelope(ada, 'team.add_member', {})
    const at = canonicalJson({ brain: BRAIN, op_id: env.op_id, member: bo.identity.publicKey })
    const sealPadded = (padded: Uint8Array) => {
      const nonce = sodium.randombytes_buf(24)
      return { nonce: Buffer.from(nonce).toString('base64url'), ct: Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, at, null, nonce, keys[0].key)).toString('base64url') }
    }
    const padded = new Uint8Array(64)
    padded.set([2, ...Buffer.from('bo')])
    const dirty = padded.slice()
    dirty[63] = 1
    const long = padded.slice()
    long[0] = 64
    for (const [plain, expected] of [[padded, 'bo'], [dirty, null], [long, null]] as const) {
      const args = { member: bo.identity.publicKey, role: 'member', device_cert: cert(bo), handle: sealPadded(plain) }
      const rec = openRecord(JSON.parse(JSON.stringify(clearOp({ ...env, args: args as never }, ada.device.sign).record)), BRAIN, () => undefined)
      expect(memberHandles(applyMembership(set, rec), keyFor(keys))[bo.identity.publicKey]).toBe(expected)
    }
  })
})

describe('the genesis', () => {
  const ada = () => signingKeyFromSeed(sha('device sign'))
  const genesis = () => openRecord(V.genesis.record, BRAIN, () => undefined)

  it('is signed by the root\'s device, names a certificate of the root member for this brain, has exactly its fields', () => {
    const g = genesis()
    const resign = (env: TeamOp, device = ada()) => openRecord(JSON.parse(JSON.stringify(clearOp(env, device).record)), BRAIN, () => undefined)
    const other = newDeviceKeys()
    const root = (g.envelope.args as { root: Record<string, unknown> }).root
    expect(() => genesisMembers(resign({ ...g.envelope, team: { ...g.envelope.team, device: other.sign.publicKey } }, other.sign))).toThrow(/not signed by the root's device/)
    expect(() => genesisMembers(resign({ ...g.envelope, args: { state_hash: ZERO, root: { ...root, member: K.device_sign.public_key } } }))).toThrow(/another member/)
    expect(() => genesisMembers(resign({ ...g.envelope, args: { state_hash: ZERO, root: { ...root, role: 'owner' } } }))).toThrow(/root has no field role/)
    expect(() => genesisMembers(resign({ ...g.envelope, args: { state_hash: ZERO } }))).toThrow(/lacks root/)
    expect(() => genesisMembers({ ...g, envelope: { ...g.envelope, call: 'team.add_member' } })).toThrow(/not brain.genesis/)
  })
})

// --- review fixes (eml-cd030656) ---------------------------------------------------

describe('a membership record\'s author is its device', () => {
  it('checkAuthor takes a clear record by its device alone; a sealed op still names its handle', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const record = addMember(set, keys, ada, bo)
    expect(record.envelope.provenance).toEqual({ handle: null, ingestion_method: null, session_id: null, model: null, harness: null })
    expect(() => checkAuthor(set, record, memberHandles(set, keyFor(keys)))).not.toThrow()
    expect(() => checkAuthor(set, record, {})).not.toThrow()  // the relay's view: no handles at all
    expect(() => checkAuthor(set, write(ada, keys, 0), {})).toThrow(/not its member's handle/)
  })
})

describe('an op_id appears once in a brain\'s log', () => {
  it('the same record twice is refused', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const record = addMember(set, keys, ada, bo)
    const two = applyMembership(set, record)
    expect(two.op_ids).toEqual([...set.op_ids, record.envelope.op_id])
    expect(() => applyMembership(two, record)).toThrow(/in the log already/)
  })

  it('a removed member is not added back by replaying their old add_member (PoC 1)', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const add = addMember(set, keys, ada, bo)
    let s = applyMembership(set, add)
    s = applyMembership(s, clear(ada, 'team.remove_member', { member: bo.identity.publicKey }))
    s = applyMembership(s, rotation(s, keys, ada))
    expect(() => applyMembership(s, add)).toThrow(/in the log already/)
  })

  it('a revoked device is not revived by replaying its old add_device (PoC 1b)', () => {
    const ada = person('ada')
    const phone = newDeviceKeys()
    const { set, keys } = found(ada)
    const addPhone = clear(ada, 'team.add_device', { device_cert: cert(ada, phone) })
    let s = applyMembership(set, addPhone)
    s = applyMembership(s, clear(ada, 'team.revoke_device', { device: phone.sign.publicKey }))
    s = applyMembership(s, rotation(s, keys, ada))
    expect(() => applyMembership(s, addPhone)).toThrow(/in the log already/)
  })

  it('the genesis op_id counts too', () => {
    const ada = person('ada')
    const { set, genesis } = found(ada)
    expect(set.op_ids).toEqual([genesis.envelope.op_id])
  })
})

describe('an owner always keeps a current device', () => {
  it('the only owner cannot revoke their only device (PoC 4)', () => {
    const ada = person('ada')
    const { set } = found(ada)
    expect(() => applyMembership(set, clear(ada, 'team.revoke_device', { device: ada.device.sign.publicKey }))).toThrow(/no owner would have a current device left/)
  })

  it('with a second device, or another owner with a device, it can', () => {
    const ada = person('ada')
    const bo = person('bo')
    const phone = newDeviceKeys()
    const { set, keys } = found(ada)
    const withPhone = applyMembership(set, clear(ada, 'team.add_device', { device_cert: cert(ada, phone) }))
    expect(() => applyMembership(withPhone, clear(ada, 'team.revoke_device', { device: ada.device.sign.publicKey }))).not.toThrow()
    const owners = applyMembership(set, addMember(set, keys, ada, bo, 'owner'))
    const boWithout = applyMembership(owners, clear(bo, 'team.revoke_device', { device: bo.device.sign.publicKey }))
    // now ada is the only owner with a device: she cannot revoke it, nor be removed — no owner could sign anything after
    expect(() => applyMembership(boWithout, clear(ada, 'team.revoke_device', { device: ada.device.sign.publicKey }))).toThrow(/no owner would have a current device left/)
  })

  it('removing the last owner who has a device is refused, even when another owner remains', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    let s = applyMembership(set, addMember(set, keys, ada, bo, 'owner'))
    s = applyMembership(s, clear(bo, 'team.revoke_device', { device: bo.device.sign.publicKey }))
    s = applyMembership(s, rotation(s, keys, ada))
    expect(() => applyMembership(s, clear(ada, 'team.remove_member', { member: ada.identity.publicKey }))).toThrow(/no owner would have a current device left/)
  })
})

describe('handles: lowercase ASCII, compared as strings, never reused', () => {
  const at = { brain: BRAIN, op_id: 'x', member: 'y' }
  const key = { epoch: 0, key: sha('brain key 0') }

  it('a handle is 1–63 characters of a-z, 0-9, _ and -', () => {
    for (const ok of ['ada', 'bo_2', 'mo-ti', '0', 'z'.repeat(63)]) expect(() => sealHandle(ok, at, key), ok).not.toThrow()
  })

  it('everything else is refused: upper case, accents in either form, look-alikes, invisible marks, other spaces (PoC 5)', () => {
    const refused = [
      'Ada',             // upper case
      'r\u00e9mi',       // é composed
      're\u0301mi',      // e + combining acute
      '\u0430da',        // Cyrillic а
      '\uff41da',        // fullwidth a
      'ada\ufe0f',       // variation selector
      'a\u034fda',       // combining grapheme joiner
      'a\u00a0da',       // no-break space
      'a da', ' ada', 'ada.', 'stra\u00dfe',
    ]
    for (const bad of refused) expect(() => sealHandle(bad, at, key), JSON.stringify(bad)).toThrow(/1–63 characters of a-z, 0-9, _ and -/)
  })

  it('the same handle twice: the later member has none', () => {
    const ada = person('ada')
    const twin = person('ada')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, twin))
    expect(memberHandles(two, keyFor(keys))).toEqual({ [ada.identity.publicKey]: 'ada', [twin.identity.publicKey]: null })
  })

  it('a removed member\'s handle stays theirs: a newcomer with it has none; the member back again has it', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    let s = applyMembership(set, addMember(set, keys, ada, bo))
    s = applyMembership(s, clear(ada, 'team.remove_member', { member: bo.identity.publicKey }))
    s = applyMembership(s, rotation(s, keys, ada))
    const bo2 = person('bo')
    s = applyMembership(s, addMember(s, keys, ada, bo2))
    expect(memberHandles(s, keyFor(keys))[bo2.identity.publicKey]).toBeNull()
    expect(s.handles.map(h => h.member)).toEqual([ada.identity.publicKey, bo.identity.publicKey, bo2.identity.publicKey])
    // bo himself joins again, with his own identity: his handle is still his
    s = applyMembership(s, clear(ada, 'team.remove_member', { member: bo2.identity.publicKey }))
    s = applyMembership(s, rotation(s, keys, ada))
    s = applyMembership(s, addMember(s, keys, ada, { ...bo, device: newDeviceKeys() }))
    expect(memberHandles(s, keyFor(keys))[bo.identity.publicKey]).toBe('bo')
  })

  it('a box whose handle is outside the charset counts as no handle', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    for (const text of [Buffer.from('re\u0301mi', 'utf-8'), Buffer.from('Bo', 'utf-8')]) {
      const env = envelope(ada, 'team.add_member', {})
      const padded = new Uint8Array(64)
      padded.set([text.length, ...text])
      const nonce = sodium.randombytes_buf(24)
      const handle = { nonce: Buffer.from(nonce).toString('base64url'), ct: Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, canonicalJson({ brain: BRAIN, op_id: env.op_id, member: bo.identity.publicKey }), null, nonce, keys[0].key)).toString('base64url') }
      const rec: OpenedOp = openRecord(JSON.parse(JSON.stringify(clearOp({ ...env, args: { member: bo.identity.publicKey, role: 'member', device_cert: cert(bo), handle } as never }, ada.device.sign).record)), BRAIN, () => undefined)
      expect(memberHandles(applyMembership(set, rec), keyFor(keys))[bo.identity.publicKey]).toBeNull()
    }
  })
})

describe('the genesis state_hash', () => {
  it('is 64 lowercase hex digits', () => {
    const g = openRecord(V.genesis.record, BRAIN, () => undefined)
    const args = g.envelope.args as { state_hash: string, root: never }
    expect(() => genesisMembers({ ...g, envelope: { ...g.envelope, args: { ...args, state_hash: 'abc' } } })).toThrow(/state_hash/)
    expect(() => genesisMembers({ ...g, envelope: { ...g.envelope, args: { ...args, state_hash: args.state_hash.toUpperCase() } } })).toThrow(/state_hash/)
  })
})

