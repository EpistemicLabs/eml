import { describe, it, expect, beforeAll } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers'
import {
  ProtocolError, applyMembership, certifyDevice, checkAuthor, clearOp, genesisMembers, memberHandles, newDeviceKeys,
  newSigningKey, openRecord, ready, sealHandle, sealOp, signingKeyFromSeed,
  type BrainKey, type DeviceKeys, type KeyPair, type MemberSet, type OpenedOp, type TeamOp,
} from '../src'
import { sealHandleWith } from '../src/membership'

// v0.21 (spec team-brain-protocol-package-spec §3, block 4): the membership
// records, the reducer every reader runs over them, and a member's check of
// an op's author — including the handle, which only members can read.

const V = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'membership.json'), 'utf-8'))
const K = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf-8'))
const sha = (n: string): Buffer => createHash('sha256').update(`eml protocol test vector: ${n}`).digest()
const BRAIN = K.device_cert.cert.brain as string
const ZERO = '0'.repeat(64)
const T = '2026-10-26T08:00:00.000Z'

beforeAll(() => ready())

describe('the vector', () => {
  it('reproduces the handle box; it opens with the epoch-0 key and the canonical {brain, op_id, member}', () => {
    const at = JSON.parse(V.handle.aad)
    expect(sealHandleWith(sha('handle nonce').subarray(0, 24), V.handle.text, at, { epoch: 0, key: sha('brain key 0') })).toEqual(V.handle.box)
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, Buffer.from(V.handle.box.ct, 'base64url'), V.handle.aad, Buffer.from(V.handle.box.nonce, 'base64url'), sha('brain key 0'))
    expect(sodium.to_string(plain)).toBe('juno')
  })

  it('the genesis record founds the vector member set: the root as the one owner, epoch 0', () => {
    const set = genesisMembers(openRecord(V.genesis.record, BRAIN, () => undefined))
    expect(set).toEqual(V.genesis.member_set)
    expect(Object.keys(set.members)).toEqual([K.identity.public_key])
    expect(set.members[K.identity.public_key].role).toBe('owner')
    expect(memberHandles(set, e => (e === 0 ? sha('brain key 0') : undefined))).toEqual({ [K.identity.public_key]: 'juno' })
  })
})

// --- a team brain played through ---------------------------------------------------

interface Person { identity: KeyPair, device: DeviceKeys, handle: string }
const person = (handle: string): Person => ({ identity: newSigningKey(), device: newDeviceKeys(), handle })
const cert = (p: Person, device = p.device) => certifyDevice(p.identity, { brain: BRAIN, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: T })

let seq = 0
const envelope = (author: Person, call: string, args: unknown, device = author.device, handle: string | null = author.handle): TeamOp => ({
  op_id: crypto.randomUUID(), schema: 21, call, args: args as never,
  provenance: { handle, ingestion_method: 'mcp', session_id: null, model: null, harness: null },
  team: { brain: BRAIN, device: device.sign.publicKey, base_seq: seq++, head_hash: ZERO },
})
const clear = (author: Person, call: string, args: unknown, device = author.device): OpenedOp => {
  const { record } = clearOp(envelope(author, call, args, device), device.sign)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, () => undefined)
}

/** A brain founded by `owner`, with its keys by epoch. */
function found(owner: Person): { set: MemberSet, keys: BrainKey[] } {
  const keys = [{ epoch: 0, key: sodium.randombytes_buf(32) }]
  const op_id = crypto.randomUUID()
  const env = {
    ...envelope(owner, 'brain.genesis', {
      state_hash: ZERO,
      root: { member: owner.identity.publicKey, device_cert: cert(owner), handle: sealHandle(owner.handle, { brain: BRAIN, op_id, member: owner.identity.publicKey }, keys[0]), key_id: Buffer.from(sodium.randombytes_buf(32)).toString('base64url') },
    }),
    op_id,
  }
  const genesis = openRecord(JSON.parse(JSON.stringify(clearOp(env, owner.device.sign).record)), BRAIN, () => undefined)
  return { set: genesisMembers(genesis), keys }
}
const keyFor = (keys: BrainKey[]) => (epoch: number) => keys.find(k => k.epoch === epoch)?.key

/** The add_member record `owner` writes for `joiner`, sealing the joiner's handle under the current epoch. */
function addMember(set: MemberSet, keys: BrainKey[], owner: Person, joiner: Person, role = 'member', handle = joiner.handle): OpenedOp {
  const env = envelope(owner, 'team.add_member', {})
  const args = { member: joiner.identity.publicKey, role, device_cert: cert(joiner), handle: sealHandle(handle, { brain: BRAIN, op_id: env.op_id, member: joiner.identity.publicKey }, keys.find(k => k.epoch === set.epoch)!) }
  const { record } = clearOp({ ...env, args }, owner.device.sign)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, () => undefined)
}

const rotation = (set: MemberSet, keys: BrainKey[], owner: Person, epoch = set.epoch + 1): OpenedOp => {
  keys.push({ epoch, key: sodium.randombytes_buf(32) })
  const prev = { nonce: Buffer.from(sodium.randombytes_buf(24)).toString('base64url'), ct: Buffer.from(sodium.randombytes_buf(48)).toString('base64url') }
  return clear(owner, 'team.rotate_key', { epoch, key_id: Buffer.from(sodium.randombytes_buf(32)).toString('base64url'), prev })
}
const write = (author: Person, keys: BrainKey[], epoch: number, handle = author.handle): OpenedOp => {
  const key = keys.find(k => k.epoch === epoch)!
  const { record } = sealOp(envelope(author, 'engram.create', { type: 'note', scope: 'global', title: 't', content: 'c' }, author.device, handle), author.device.sign, key)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, keyFor([key]))
}

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
    ;(moved.envelope.args as { handle: unknown }).handle = set.members[ada.identity.publicKey].handle.box
    const two = applyMembership(set, moved)
    expect(memberHandles(two, keyFor(keys))[bo.identity.publicKey]).toBeNull()
    expect(memberHandles(two, () => undefined)).toEqual({ [ada.identity.publicKey]: null, [bo.identity.publicKey]: null })
    expect(() => sealHandle(' ada', { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0])).toThrow(ProtocolError)
    expect(() => sealHandle('a'.repeat(65), { brain: BRAIN, op_id: 'x', member: 'y' }, keys[0])).toThrow(/1–64 characters/)
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
