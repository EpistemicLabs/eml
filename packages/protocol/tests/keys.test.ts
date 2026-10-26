import { describe, it, expect, beforeAll } from 'vitest'
import { createHash, createPrivateKey, createPublicKey, verify } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ProtocolError, certifyDevice, encryptionKeyFromSeed, fingerprint, newDeviceKeys, newSigningKey, ready,
  signingKeyFromSeed, verifyDeviceCert, type DeviceCert,
} from '../src'

// v0.21 (spec team-brain-protocol-package-spec §3, block 2): identity and
// device keys, the device certificate and the fingerprint — against the frozen
// vectors in vectors/keys.json, which node:crypto checks independently.

const V = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf-8'))
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')

// node:crypto takes raw 25519 keys only inside a DER envelope (RFC 8410)
const ED25519_PKCS8 = hex('302e020100300506032b657004220420')
const ED25519_SPKI = hex('302a300506032b6570032100')
const X25519_PKCS8 = hex('302e020100300506032b656e04220420')
const nodeEd25519Public = (seed: Buffer): Buffer => createPublicKey(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(-32)
const nodeX25519Public = (secret: Buffer): Buffer => createPublicKey(createPrivateKey({ key: Buffer.concat([X25519_PKCS8, secret]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(-32)
const nodeVerify = (publicKey: string, text: string, sig: string): boolean =>
  verify(null, Buffer.from(text, 'utf-8'), { key: Buffer.concat([ED25519_SPKI, b64(publicKey)]), format: 'der', type: 'spki' }, b64(sig))

beforeAll(() => ready())

describe('key pairs', () => {
  it('Ed25519 from a seed matches RFC 8032 §7.1 test 1', () => {
    const key = signingKeyFromSeed(hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'))
    expect(b64(key.publicKey).toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  })

  it('reproduces the vector keys, and node:crypto derives the same public keys', () => {
    expect(V.identity.seed).toBe(createHash('sha256').update('eml protocol test vector: identity').digest('hex'))
    for (const k of [V.identity, V.device_sign]) {
      expect(signingKeyFromSeed(hex(k.seed)).publicKey).toBe(k.public_key)
      expect(nodeEd25519Public(hex(k.seed)).toString('base64url')).toBe(k.public_key)
    }
    expect(encryptionKeyFromSeed(hex(V.device_enc.seed)).publicKey).toBe(V.device_enc.public_key)
    // crypto_box_seed_keypair: the X25519 private key is the first half of SHA-512(seed)
    const secret = createHash('sha512').update(hex(V.device_enc.seed)).digest().subarray(0, 32)
    expect(nodeX25519Public(secret).toString('base64url')).toBe(V.device_enc.public_key)
  })

  it('new keys are random and 32 bytes; a seed of another length is refused', () => {
    const a = newDeviceKeys()
    const b = newDeviceKeys()
    expect(a.sign.publicKey).not.toBe(b.sign.publicKey)
    expect(a.enc.publicKey).not.toBe(b.enc.publicKey)
    expect(b64(a.sign.publicKey)).toHaveLength(32)
    expect(a.sign.seed).toHaveLength(32)
    expect(() => signingKeyFromSeed(new Uint8Array(31))).toThrow(ProtocolError)
    expect(() => encryptionKeyFromSeed(new Uint8Array(33))).toThrow(ProtocolError)
  })
})

describe('device certificates', () => {
  const identity = () => signingKeyFromSeed(hex(V.identity.seed))
  const cert = V.device_cert.cert as DeviceCert
  const fields = { brain: cert.brain, device_sign: cert.device_sign, device_enc: cert.device_enc, created_at: cert.created_at }

  it('reproduces the vector: the identity key signs the domain tag and the canonical body', () => {
    expect(certifyDevice(identity(), fields)).toEqual(cert)
    expect(Object.keys(certifyDevice(identity(), fields))).toEqual(Object.keys(cert))
    expect(nodeVerify(cert.member, V.device_cert.signed_text, cert.sig)).toBe(true)
  })

  it('accepts the vector and a fresh certificate', () => {
    expect(verifyDeviceCert(cert)).toEqual(cert)
    const member = newSigningKey()
    const device = newDeviceKeys()
    const fresh = certifyDevice(member, { ...fields, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey })
    expect(verifyDeviceCert(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh)
  })

  const flip = (s: string): string => {
    const bytes = b64(s)
    bytes[5] ^= 1
    return bytes.toString('base64url')
  }
  // 32 bytes take 43 characters; the last one carries 2 bits and 4 zero bits — set one of those
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const nonCanonical = (s: string): string => s.slice(0, -1) + ALPHABET[ALPHABET.indexOf(s[42]) | 1]
  const refused: Array<[string, unknown, RegExp]> = [
    ['not an object', 'cert', /object/],
    ['an extra field', { ...cert, label: 'laptop' }, /no field label/],
    ['a missing field', (({ created_at: _c, ...rest }) => rest)(cert), /lacks created_at/],
    ['another version', { ...cert, v: 2 }, /version 2/],
    ['an uppercase brain id', { ...cert, brain: cert.brain.toUpperCase() }, /UUID/],
    ['a short key', { ...cert, device_sign: cert.device_sign.slice(0, 40) }, /device signing key/],
    ['padded base64', { ...cert, device_enc: `${cert.device_enc}=` }, /base64url/],
    ['standard base64', { ...cert, device_enc: b64(cert.device_enc).toString('base64').replace(/=+$/, '') }, /base64url/],
    ['a key with a line break', { ...cert, device_enc: `${cert.device_enc}\n` }, /base64url/],
    ['a non-canonical spelling', { ...cert, device_enc: nonCanonical(cert.device_enc) }, /base64url/],
    ['a time without milliseconds', { ...cert, created_at: '2026-10-26T08:00:00Z' }, /created_at/],
    ['a flipped signature byte', { ...cert, sig: flip(cert.sig) }, /not signed/],
    ['a swapped device key', { ...cert, device_sign: V.identity.public_key }, /not signed/],
    ['another member', { ...cert, member: V.device_sign.public_key }, /not signed/],
  ]
  for (const [what, value, error] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => verifyDeviceCert(value)).toThrow(ProtocolError)
      expect(() => verifyDeviceCert(value)).toThrow(error)
    })
  }

  it('certifyDevice refuses malformed fields instead of signing them', () => {
    expect(() => certifyDevice(identity(), { ...fields, created_at: 'now' })).toThrow(/created_at/)
    expect(() => certifyDevice(identity(), { ...fields, device_enc: 'x' })).toThrow(ProtocolError)
  })
})

describe('fingerprint', () => {
  it('is the first 20 bytes of sha256 over the key, in 8 groups of 5 hex digits (vector)', () => {
    expect(fingerprint(V.identity.public_key)).toBe(V.identity.fingerprint)
    const digest = createHash('sha256').update(b64(V.identity.public_key)).digest('hex')
    expect(V.identity.fingerprint.replace(/ /g, '')).toBe(digest.slice(0, 40))
    expect(V.identity.fingerprint).toMatch(/^([0-9a-f]{5} ){7}[0-9a-f]{5}$/)
  })

  it('refuses what is not a public key', () => {
    expect(() => fingerprint('abc')).toThrow(ProtocolError)
  })
})
