import { describe, it, expect, beforeAll } from 'vitest'
import { verify } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers'
import {
  ProtocolError, UnsupportedVersionError, applyMembership, canonicalJson, checkWrappedKey, encryptionKeyFromSeed, epochKeys, genesisMembers, keyId,
  newBrainKey, newDeviceKeys, openRecord, ready, rotateKey, signingKeyFromSeed, unwrapKey, wrapKey,
  type MemberSet,
} from '../src'
import { rotateKeyWith } from '../src/brainkey'
import { signText } from '../src/keys'
import { BRAIN, K, addMember, cert, clear, found, nodeOpen, person, rotation, sha } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §4, block 5): the brain key —
// its id, the rotation chain that lets the newest key open every older epoch,
// and keys wrapped for a device and signed by the device that wrapped them —
// against the frozen vectors in vectors/brainkeys.json.

const B = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'brainkeys.json'), 'utf-8'))
const M = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'membership.json'), 'utf-8'))
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')
const ED25519_SPKI = hex('302a300506032b6570032100')

beforeAll(() => ready())

describe('the vectors', () => {
  const genesisSet = (): MemberSet => genesisMembers(openRecord(M.genesis.record, BRAIN, () => undefined))
  const device = () => ({ sign: signingKeyFromSeed(sha('device sign')), enc: encryptionKeyFromSeed(sha('device enc')) })

  it('key_id is BLAKE2b-256 of "eml-brain-key-id-v1" keyed with the key; the genesis root names the epoch-0 key', () => {
    expect(keyId(hex(B.epoch0.key))).toBe(B.epoch0.key_id)
    expect(B.epoch0.key).toBe(sha('brain key 0').toString('hex'))
    expect(genesisSet().keys).toEqual([{ key_id: B.epoch0.key_id, prev: null }])
    expect(() => keyId(new Uint8Array(16))).toThrow(ProtocolError)
  })

  it('reproduces the rotation to epoch 1; node:crypto opens prev to the epoch-0 key', () => {
    const { next, args } = rotateKeyWith(hex(B.rotation.key), hex(B.rotation.prev_nonce), genesisSet(), { epoch: 0, key: hex(B.epoch0.key) })
    expect(args).toEqual(B.rotation.args)
    expect(next).toEqual({ epoch: 1, key: hex(B.rotation.key) })
    expect(B.rotation.aad).toBe(`{"brain":"${BRAIN}","epoch":1}`)
    expect(nodeOpen(hex(B.rotation.key), b64(args.prev.nonce), B.rotation.aad, b64(args.prev.ct)).toString('hex')).toBe(B.epoch0.key)
  })

  it('the wrapped key: node:crypto checks the wrapper\'s signature, the device opens it to the epoch-0 key', () => {
    const r = B.wrapped.record
    expect(verify(null, Buffer.from(B.wrapped.signed_text, 'utf-8'), { key: Buffer.concat([ED25519_SPKI, b64(r.wrapper)]), format: 'der', type: 'spki' }, b64(r.sig))).toBe(true)
    expect(Object.keys(r)).toEqual(['v', 'brain', 'epoch', 'recipient', 'sealed', 'wrapper', 'sig'])
    const own = sodium.crypto_box_seed_keypair(sha('device enc'))
    expect(Buffer.from(sodium.crypto_box_seal_open(b64(r.sealed), own.publicKey, own.privateKey)).toString('hex')).toBe(B.epoch0.key)
    expect(unwrapKey(genesisSet(), r, device())).toEqual({ epoch: 0, key: new Uint8Array(hex(B.epoch0.key)) })
    expect(r.recipient).toBe(K.device_sign.public_key)
  })
})

describe('rotation and the key chain', () => {
  it('after rotations, the newest key opens every older epoch, each checked against the log\'s key_id', () => {
    const ada = person('ada')
    const { set, keys } = found(ada)
    let s = applyMembership(set, rotation(set, keys, ada))
    s = applyMembership(s, rotation(s, keys, ada))
    expect(s.epoch).toBe(2)
    expect(s.keys.map(k => k.key_id)).toEqual(keys.map(k => keyId(k.key)))
    expect(epochKeys(s, keys[2])).toEqual(keys)
    expect(epochKeys(s, keys[1])).toEqual(keys.slice(0, 2))
    expect(epochKeys(s, keys[0])).toEqual(keys.slice(0, 1))
  })

  it('refuses a key that is not the log\'s, an epoch the log has not reached, a prev that does not open', () => {
    const ada = person('ada')
    const { set, keys } = found(ada)
    const s = applyMembership(set, rotation(set, keys, ada))
    expect(() => epochKeys(s, { epoch: 1, key: keys[0].key })).toThrow(/epoch 1 is not the one the log names/)
    expect(() => epochKeys(s, { epoch: 2, key: keys[1].key })).toThrow(/no epoch 2/)
    const forged = { ...s, keys: [s.keys[0], { ...s.keys[1], prev: { ...s.keys[1].prev!, nonce: Buffer.from(sodium.randombytes_buf(24)).toString('base64url') } }] }
    expect(() => epochKeys(forged, keys[1])).toThrow(/prev of epoch 1 does not open/)
  })

  it('rotates only the brain\'s current key', () => {
    const ada = person('ada')
    const { set, keys } = found(ada)
    expect(() => rotateKey(set, newBrainKey(0))).toThrow(/not the brain's current key/)
    expect(() => rotateKey(set, { ...keys[0], epoch: 1 })).toThrow(/not the brain's current key/)
    expect(rotateKey(set, keys[0]).args.epoch).toBe(1)
  })
})

describe('wrapped keys', () => {
  /** ada founds; bo joins as a member with a laptop and a phone. */
  function team() {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    let s = applyMembership(set, addMember(set, keys, ada, bo))
    const phone = newDeviceKeys()
    s = applyMembership(s, clear(bo, 'team.add_device', { device_cert: cert(bo, phone) }))
    return { ada, bo, phone, set: s, keys }
  }

  it('an owner wraps for a member\'s device; a member wraps for their own other device', () => {
    const { ada, bo, phone, set, keys } = team()
    const forBo = wrapKey(set, keys[0], bo.device.sign.publicKey, ada.device.sign)
    expect(unwrapKey(set, JSON.parse(JSON.stringify(forBo)), bo.device)).toEqual(keys[0])
    const forPhone = wrapKey(set, keys[0], phone.sign.publicKey, bo.device.sign)
    expect(unwrapKey(set, forPhone, phone)).toEqual(keys[0])
    const twice = wrapKey(set, keys[0], bo.device.sign.publicKey, ada.device.sign)
    expect(twice.sealed).not.toBe(forBo.sealed)  // sealed boxes are randomized
  })

  it('a rotation: the new key is wrapped before the rotation is in, and unwraps once it is', () => {
    const { ada, bo, set, keys } = team()
    const record = rotation(set, keys, ada)
    const wrapped = wrapKey(set, keys[1], bo.device.sign.publicKey, ada.device.sign)
    expect(() => unwrapKey(set, wrapped, bo.device)).toThrow(/no epoch 1/)
    const rotated = applyMembership(set, record)
    expect(unwrapKey(rotated, wrapped, bo.device)).toEqual(keys[1])
    expect(epochKeys(rotated, unwrapKey(rotated, wrapped, bo.device))).toEqual(keys)
  })

  it('refuses what a relay or another member could slip in', () => {
    const { ada, bo, phone, set, keys } = team()
    const good = wrapKey(set, keys[0], bo.device.sign.publicKey, ada.device.sign)
    const flip = (s: string): string => { const b = b64(s); b[7] ^= 1; return b.toString('base64url') }
    // the relay's own key, sealed for bo and "signed" by a device that is no member
    const relay = newDeviceKeys()
    expect(() => unwrapKey(set, wrapKey(set, newBrainKey(0), bo.device.sign.publicKey, relay.sign), bo.device)).toThrow(/wrapper is not a current device/)
    // a member wrapping for another member
    expect(() => unwrapKey(set, wrapKey(set, keys[0], ada.device.sign.publicKey, bo.device.sign), ada.device)).toThrow(/by an owner or by the recipient's own member/)
    // an owner wrapping a key the log does not name
    expect(() => unwrapKey(set, wrapKey(set, newBrainKey(0), bo.device.sign.publicKey, ada.device.sign), bo.device)).toThrow(/not the key the log names for epoch 0/)
    expect(() => unwrapKey(set, { ...good, sig: flip(good.sig) }, bo.device)).toThrow(/not signed by its wrapper/)
    expect(() => unwrapKey(set, { ...good, sealed: flip(good.sealed) }, bo.device)).toThrow(/not signed by its wrapper/)
    expect(() => unwrapKey(set, good, phone)).toThrow(/for another device/)
    expect(() => unwrapKey(set, { ...good, brain: '00000000-0000-4000-8000-000000000000' }, bo.device)).toThrow(/another brain/)
    expect(() => unwrapKey(set, { ...good, v: 2 }, bo.device)).toThrow(UnsupportedVersionError)
    expect(() => unwrapKey(set, { ...good, note: 'x' }, bo.device)).toThrow(/no field note/)
    // sealed for another device's encryption key, but the record names bo: correctly signed, does not open
    const misdirected = wrapKey(set, keys[0], phone.sign.publicKey, ada.device.sign)
    const resigned = (({ sig: _s, ...body }) => body)({ ...misdirected, recipient: bo.device.sign.publicKey })
    const forged = { ...resigned, sig: signText(ada.device.sign, 'eml-wrapped-key-v1\n', canonicalJson(resigned)) }
    expect(() => unwrapKey(set, forged, bo.device)).toThrow(/does not open with this device's key/)
    expect(() => wrapKey(set, keys[0], 'toString', ada.device.sign)).toThrow(/recipient is not a current device/)
  })

  it('what the relay checks without the recipient\'s key: everything but opening it, any epoch', () => {
    const { ada, bo, phone, set, keys } = team()
    const record = rotation(set, keys, ada)
    // the next epoch's key, put before the rotation is in the log: the relay keeps it, the device waits for the rotation
    const next = wrapKey(set, keys[1], bo.device.sign.publicKey, ada.device.sign)
    expect(checkWrappedKey(set, JSON.parse(JSON.stringify(next)))).toEqual(next)
    expect(() => unwrapKey(set, next, bo.device)).toThrow(/no epoch 1/)
    expect(unwrapKey(applyMembership(set, record), next, bo.device)).toEqual(keys[1])
    // the relay cannot tell a key the log does not name; the device can
    const foreign = wrapKey(set, newBrainKey(0), bo.device.sign.publicKey, ada.device.sign)
    expect(checkWrappedKey(set, foreign)).toEqual(foreign)
    expect(() => checkWrappedKey(set, wrapKey(set, keys[0], ada.device.sign.publicKey, bo.device.sign))).toThrow(/by an owner or by the recipient's own member/)
    const flipped = b64(next.sig)
    flipped[5] ^= 1
    expect(() => checkWrappedKey(set, { ...next, sig: flipped.toString('base64url') })).toThrow(/not signed by its wrapper/)
    expect(() => checkWrappedKey(set, { ...next, epoch: -1 })).toThrow(/epoch/)
    expect(() => checkWrappedKey(set, { ...next, sealed: 'short' })).toThrow(/sealed/)
    // a device that is no longer one: revoked, its keys are refused
    const revoked = applyMembership(set, clear(bo, 'team.revoke_device', { device: phone.sign.publicKey }))
    expect(() => checkWrappedKey(revoked, wrapKey(set, keys[0], phone.sign.publicKey, ada.device.sign))).toThrow(/recipient is not a current device/)
  })
})
