import { describe, it, expect, beforeAll } from 'vitest'
import { createHash, verify } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers'
import {
  ProtocolError, UnsupportedVersionError, canonicalJson, clearOp, newDeviceKeys, newSigningKey, openRecord, ready,
  sealOp, sha256Hex, signingKeyFromSeed, type KeyPair, type TeamOp,
} from '../src'
import { sealOpWith } from '../src/seal'
import { signText } from '../src/keys'
import { hchacha20, nodeOpen } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §2, block 3): ops on the wire —
// the team envelope, the op signature, sealed and clear records — against the
// frozen vectors in vectors/ops.json, which node:crypto checks independently
// (Ed25519; XChaCha20-Poly1305 as HChaCha20 plus OpenSSL's ChaCha20-Poly1305).

const V = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'ops.json'), 'utf-8'))
const K = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf-8'))
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')
const BRAIN = K.device_cert.cert.brain as string
const KEY = hex(V.brain_key.key)
const keyFor = (epoch: number) => (epoch === 0 ? KEY : undefined)

const ED25519_SPKI = hex('302a300506032b6570032100')
const nodeVerify = (publicKey: string, text: string, sig: string): boolean =>
  verify(null, Buffer.from(text, 'utf-8'), { key: Buffer.concat([ED25519_SPKI, b64(publicKey)]), format: 'der', type: 'spki' }, b64(sig))

/** A sealed record built by hand: any header, any plaintext — what a forger or a broken peer could send. */
function forge(header: Record<string, unknown>, plaintext: Uint8Array, key: Uint8Array = KEY): Record<string, unknown> {
  const nonce = sodium.randombytes_buf(24)
  const h = { ...header, nonce: Buffer.from(nonce).toString('base64url') }
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, canonicalJson(h), null, nonce, key)
  return { ...h, ct: Buffer.from(ct).toString('base64url') }
}
const signedPlaintext = (device: KeyPair, payload: string): Uint8Array =>
  new Uint8Array([...b64(signText(device, 'eml-op-v1\n', sha256Hex(payload))), ...Buffer.from(payload, 'utf-8')])

beforeAll(() => ready())

describe('HChaCha20 (test helper)', () => {
  it('matches draft-irtf-cfrg-xchacha §2.2.1', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
    expect(hchacha20(key, hex('000000090000004a0000000031415927')).toString('hex'))
      .toBe('82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc')
  })
})

describe('sealed records', () => {
  const device = () => signingKeyFromSeed(createHash('sha256').update('eml protocol test vector: device sign').digest())

  it('reproduces the vector: the payload is plainJson of the envelope, signed under eml-op-v1, sealed with the header as AAD', () => {
    const sealed = sealOpWith(hex(V.nonce), V.sealed.envelope, device(), { epoch: 0, key: KEY })
    expect(sealed.payload).toBe(V.sealed.payload)
    expect(sealed.sig).toBe(V.sealed.sig)
    expect(sealed.record).toEqual(V.sealed.record)
    expect(Object.keys(sealed.record)).toEqual(['v', 'kind', 'brain', 'op_id', 'epoch', 'nonce', 'ct'])
    expect(sha256Hex(V.sealed.payload)).toBe(V.sealed.payload_hash)
    expect(V.sealed.signed_text).toBe(`eml-op-v1\n${V.sealed.payload_hash}`)
  })

  it('node:crypto checks the vector: the signature, and the ciphertext opens to signature ‖ payload', () => {
    expect(nodeVerify(V.sealed.envelope.team.device, V.sealed.signed_text, V.sealed.sig)).toBe(true)
    const { ct, ...header } = V.sealed.record
    expect(canonicalJson(header)).toBe(V.sealed.aad)
    const plain = nodeOpen(KEY, b64(V.sealed.record.nonce), V.sealed.aad, b64(ct))
    expect(plain.subarray(0, 64).toString('base64url')).toBe(V.sealed.sig)
    expect(plain.subarray(64).toString('utf-8')).toBe(V.sealed.payload)
  })

  it('opens the vector to its envelope, payload and signature', () => {
    const opened = openRecord(V.sealed.record, BRAIN, keyFor)
    expect(opened).toEqual({ envelope: V.sealed.envelope, payload: V.sealed.payload, sig: V.sealed.sig, epoch: 0 })
  })

  it('round-trips a fresh op with random keys and nonces; two seals of one op differ', () => {
    const d = newDeviceKeys().sign
    const key = { epoch: 3, key: sodium.randombytes_buf(32) }
    const op = { ...V.sealed.envelope, team: { ...V.sealed.envelope.team, device: d.publicKey } } as TeamOp
    const a = sealOp(op, d, key)
    const b = sealOp(op, d, key)
    expect(a.record.nonce).not.toBe(b.record.nonce)
    expect(openRecord(JSON.parse(JSON.stringify(a.record)), BRAIN, e => (e === 3 ? key.key : undefined))).toEqual({ envelope: op, payload: a.payload, sig: a.sig, epoch: 3 })
  })
})

describe('clear records', () => {
  const device = () => signingKeyFromSeed(createHash('sha256').update('eml protocol test vector: device sign').digest())

  it('reproduces the vector and node:crypto checks its signature', () => {
    const clear = clearOp(V.clear.envelope, device())
    expect(clear.record).toEqual(V.clear.record)
    expect(Object.keys(clear.record)).toEqual(['v', 'kind', 'brain', 'op_id', 'payload', 'sig'])
    expect(nodeVerify(V.clear.envelope.team.device, V.clear.signed_text, V.clear.record.sig)).toBe(true)
    expect(openRecord(V.clear.record, BRAIN, () => undefined)).toEqual({ envelope: V.clear.envelope, payload: V.clear.payload, sig: V.clear.record.sig, epoch: null })
  })
})

describe('what an author refuses to send', () => {
  const d = signingKeyFromSeed(createHash('sha256').update('eml protocol test vector: device sign').digest())
  const key = { epoch: 0, key: KEY }
  const op = V.sealed.envelope as TeamOp
  const cases: Array<[string, unknown, RegExp]> = [
    ['an op without team fields', (({ team: _t, ...rest }) => rest)(op), /lacks team/],
    ['an extra envelope field', { ...op, author: 'x' }, /no field author/],
    ['an extra provenance field', { ...op, provenance: { ...op.provenance, device: 'x' } }, /provenance has the fields/],
    ['a provenance value that is not a string', { ...op, provenance: { ...op.provenance, model: 1 } }, /provenance.model/],
    ['an uppercase op_id', { ...op, op_id: op.op_id.toUpperCase() }, /op_id/],
    ['a schema of 0', { ...op, schema: 0 }, /schema/],
    ['a call that is no name', { ...op, call: 'Engram Create' }, /call/],
    ['a negative base_seq', { ...op, team: { ...op.team, base_seq: -1 } }, /base_seq/],
    ['a short head_hash', { ...op, team: { ...op.team, head_hash: 'abc' } }, /head_hash/],
    ['another device\'s key in team.device', { ...op, team: { ...op.team, device: K.identity.public_key } }, /not the signing device/],
    ['a membership record sealed', { ...op, call: 'team.add_device' }, /travels in the clear/],
    ['a genesis sealed', { ...op, call: 'brain.genesis' }, /travels in the clear/],
  ]
  for (const [what, value, error] of cases) {
    it(`refuses ${what}`, () => expect(() => sealOp(value as TeamOp, d, key)).toThrow(error))
  }

  it('refuses a brain write in the clear, a short nonce, a short key', () => {
    expect(() => clearOp(op, d)).toThrow(/travels sealed/)
    expect(() => sealOpWith(new Uint8Array(12), op, d, key)).toThrow(/nonce/)
    expect(() => sealOp(op, d, { epoch: 0, key: new Uint8Array(16) })).toThrow(/brain key/)
  })
})

describe('what a reader refuses', () => {
  const d = signingKeyFromSeed(createHash('sha256').update('eml protocol test vector: device sign').digest())
  const rec = V.sealed.record
  const header = (({ ct: _c, nonce: _n, ...h }) => h)(rec)
  const flip = (s: string, at: number): string => {
    const bytes = b64(s)
    bytes[at] ^= 1
    return bytes.toString('base64url')
  }
  const refuse = (record: unknown, error: RegExp, brain = BRAIN) => {
    expect(() => openRecord(record, brain, keyFor)).toThrow(ProtocolError)
    expect(() => openRecord(record, brain, keyFor)).toThrow(error)
  }

  it('a newer protocol version, as UnsupportedVersionError', () => {
    expect(() => openRecord({ ...rec, v: 2 }, BRAIN, keyFor)).toThrow(UnsupportedVersionError)
  })
  it('an unknown kind, an extra or a missing field', () => {
    refuse({ ...rec, kind: 'snapshot' }, /kind/)
    refuse({ ...rec, seq: 9 }, /no field seq/)
    refuse((({ epoch: _e, ...r }) => r)(rec), /lacks epoch/)
    refuse('record', /object/)
  })
  it('a record of another brain', () => refuse(rec, /another brain/, '00000000-0000-4000-8000-000000000000'))
  it('an epoch without a key', () => refuse({ ...rec, epoch: 1 }, /no brain key for epoch 1/))
  it('a flipped byte anywhere in the ciphertext, a flipped nonce, a changed header', () => {
    for (const at of [0, 40, b64(rec.ct).length - 1]) refuse({ ...rec, ct: flip(rec.ct, at) }, /does not decrypt/)
    refuse({ ...rec, nonce: flip(rec.nonce, 3) }, /does not decrypt/)
    refuse({ ...rec, op_id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d' }, /does not decrypt/)
  })
  it('the right header under the wrong key', () => {
    expect(() => openRecord(rec, BRAIN, () => sodium.randombytes_buf(32))).toThrow(/does not decrypt/)
  })
  it('a signature of another device than team.device — a member re-signing another member\'s op', () => {
    refuse(forge(header, signedPlaintext(newSigningKey(), V.sealed.payload)), /not signed by its device/)
  })
  it('a payload whose op_id is not the record\'s', () => {
    refuse(forge({ ...header, op_id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d' }, signedPlaintext(d, V.sealed.payload)), /op_id/)
  })
  it('a payload not in its one byte form: whitespace, a repeated key', () => {
    const spaced = V.sealed.payload.replace('"schema":21', '"schema": 21')
    refuse(forge(header, signedPlaintext(d, spaced)), /one byte form/)
    const repeated = V.sealed.payload.replace('"schema":21', '"schema":20,"schema":21')
    refuse(forge(header, signedPlaintext(d, repeated)), /one byte form/)
  })
  it('a payload that is not UTF-8, or no payload at all', () => {
    refuse(forge(header, new Uint8Array([...b64(V.sealed.sig), 0xff, 0xfe])), /UTF-8/)
    refuse(forge(header, b64(V.sealed.sig)), /no payload/)
  })
  it('a membership record sealed, a brain write in the clear', () => {
    const member = V.clear.payload as string
    refuse(forge({ ...header, op_id: V.clear.record.op_id }, signedPlaintext(d, member)), /travels in the clear/)
    refuse({ ...V.clear.record, op_id: rec.op_id, payload: V.sealed.payload, sig: V.sealed.sig }, /travels sealed/)
  })
  it('a clear record with a changed payload or a flipped signature', () => {
    refuse({ ...V.clear.record, payload: V.clear.payload.replace('"base_seq":8', '"base_seq":9') }, /not signed by its device/)
    refuse({ ...V.clear.record, sig: flip(V.clear.record.sig, 10) }, /not signed by its device/)
  })
  it('an op whose team.brain is not the record\'s brain', () => {
    const other = '00000000-0000-4000-8000-000000000000'
    const payload = V.clear.payload.replace(`"team":{"brain":"${BRAIN}"`, `"team":{"brain":"${other}"`)
    expect(payload).not.toBe(V.clear.payload)
    const sig = signText(d, 'eml-op-v1\n', sha256Hex(payload))
    refuse({ ...V.clear.record, payload, sig }, /op is for another brain/)
  })
})
