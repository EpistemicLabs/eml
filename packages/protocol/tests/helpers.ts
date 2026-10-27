import { createDecipheriv, createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers'
import {
  certifyDevice, clearOp, genesisMembers, isClearCall, keyId, newDeviceKeys, newSigningKey, openRecord, rotateKey, sealHandle, sealOp,
  type BrainKey, type DeviceKeys, type KeyPair, type MemberSet, type OpenedOp, type TeamOp,
} from '../src'

// Shared by the tests: independent checks for the vectors — XChaCha20-Poly1305
// through node:crypto (HChaCha20 here, ChaCha20-Poly1305 from OpenSSL), so a
// vector is not only checked by the library that made it — and a team brain
// to play through: people, records, the genesis, members, rotations, writes.

export const K = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf-8'))
export const sha = (n: string): Buffer => createHash('sha256').update(`eml protocol test vector: ${n}`).digest()
export const BRAIN = K.device_cert.cert.brain as string
export const ZERO = '0'.repeat(64)
const T = '2026-10-26T08:00:00.000Z'

/** HChaCha20 (draft-irtf-cfrg-xchacha §2.2): the subkey XChaCha20 derives from the key and the nonce's first 16 bytes. */
export function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  const s = new Uint32Array(16)
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(4 * i)
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(4 * i)
  const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n))
  const qr = (a: number, b: number, c: number, d: number) => {
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16)
    s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12)
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8)
    s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7)
  }
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
  }
  const out = Buffer.alloc(32)
  ;[0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], 4 * i))
  return out
}

/** XChaCha20-Poly1305 decryption through node:crypto. */
export function nodeOpen(key: Buffer, nonce: Buffer, aad: string, ct: Buffer): Buffer {
  const d = createDecipheriv('chacha20-poly1305', hchacha20(key, nonce.subarray(0, 16)), Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]), { authTagLength: 16 })
  d.setAAD(Buffer.from(aad, 'utf-8'), { plaintextLength: ct.length - 16 })
  d.setAuthTag(ct.subarray(-16))
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()])
}

export interface Person { identity: KeyPair, device: DeviceKeys, handle: string }
export const person = (handle: string): Person => ({ identity: newSigningKey(), device: newDeviceKeys(), handle })
export const cert = (p: Person, device = p.device) => certifyDevice(p.identity, { brain: BRAIN, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: T })

let seq = 0
/** An op by `author`: a sealed call names the author's handle, a membership record (clear call) a provenance of nulls. */
export const envelope = (author: Person, call: string, args: unknown, device = author.device, handle: string | null = author.handle): TeamOp => ({
  op_id: crypto.randomUUID(), schema: 21, call, args: args as never,
  provenance: isClearCall(call) ? NO_PROVENANCE : { handle, ingestion_method: 'mcp', session_id: null, model: null, harness: null },
  team: { brain: BRAIN, device: device.sign.publicKey, base_seq: seq++, head_hash: ZERO },
})
export const NO_PROVENANCE = { handle: null, ingestion_method: null, session_id: null, model: null, harness: null }
export const clear = (author: Person, call: string, args: unknown, device = author.device): OpenedOp => {
  const { record } = clearOp(envelope(author, call, args, device), device.sign)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, () => undefined)
}

/** A brain founded by `owner`, with its keys by epoch. */
/** A brain founded by `owner`: its member set, its keys by epoch, and its genesis record as a reader opened it. */
export function found(owner: Person): { set: MemberSet, keys: BrainKey[], genesis: OpenedOp } {
  const keys = [{ epoch: 0, key: sodium.randombytes_buf(32) }]
  const op_id = crypto.randomUUID()
  const env = {
    ...envelope(owner, 'brain.genesis', {
      state_hash: ZERO,
      root: { member: owner.identity.publicKey, device_cert: cert(owner), handle: sealHandle(owner.handle, { brain: BRAIN, op_id, member: owner.identity.publicKey }, keys[0]), key_id: keyId(keys[0].key) },
    }),
    op_id,
  }
  const genesis = openRecord(JSON.parse(JSON.stringify(clearOp(env, owner.device.sign).record)), BRAIN, () => undefined)
  return { set: genesisMembers(genesis), keys, genesis }
}
export const keyFor = (keys: BrainKey[]) => (epoch: number) => keys.find(k => k.epoch === epoch)?.key

/** The add_member record `owner` writes for `joiner`, sealing the joiner's handle under the current epoch. */
export function addMember(set: MemberSet, keys: BrainKey[], owner: Person, joiner: Person, role = 'member', handle = joiner.handle): OpenedOp {
  const env = envelope(owner, 'team.add_member', {})
  const args = { member: joiner.identity.publicKey, role, device_cert: cert(joiner), handle: sealHandle(handle, { brain: BRAIN, op_id: env.op_id, member: joiner.identity.publicKey }, keys.find(k => k.epoch === set.epoch)!) }
  const { record } = clearOp({ ...env, args: args as never }, owner.device.sign)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, () => undefined)
}

/** The team.rotate_key record `owner` writes for the brain's next key (pushed onto `keys`); `epoch` overrides the one it announces. */
export const rotation = (set: MemberSet, keys: BrainKey[], owner: Person, epoch?: number): OpenedOp => {
  const { next, args } = rotateKey(set, keys.find(k => k.epoch === set.epoch)!)
  keys.push(next)
  return clear(owner, 'team.rotate_key', { ...args, epoch: epoch ?? args.epoch })
}
export const write = (author: Person, keys: BrainKey[], epoch: number, handle = author.handle): OpenedOp => {
  const key = keys.find(k => k.epoch === epoch)!
  const { record } = sealOp(envelope(author, 'engram.create', { type: 'note', scope: 'global', title: 't', content: 'c' }, author.device, handle), author.device.sign, key)
  return openRecord(JSON.parse(JSON.stringify(record)), BRAIN, keyFor([key]))
}
