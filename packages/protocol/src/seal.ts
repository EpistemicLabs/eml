import { canonicalJson, plainJson } from './canonical'
import { signText, verifyText, type KeyPair } from './keys'
import { provenanceProblem, sha256Hex, type OpEnvelope, type TeamFields } from './op'
import {
  HASH, KEY_BYTES, NONCE_BYTES, PROTOCOL_VERSION, ProtocolError, SIG_BYTES, TAG_BYTES, UUID,
  asObject, checkVersion, exactFields, fromBase64url, openBox, sealBox, sodium, toBase64url, utf8,
} from './wire'

// --- Ops on the wire (v0.21) -----------------------------------------------------
//
// An op of a shared brain travels as a record. The author signs the payload —
// the envelope's exact bytes, never re-encoded — with its device key; a brain
// write is then sealed with the brain key (sign, then encrypt: the relay sees
// neither the payload nor the signature), while a membership record goes in
// the clear, signed, because the relay controls access from it. Every reader
// opens a record the same way: one strict parse, the signature, the envelope
// (spec team-brain-protocol-package-spec §2).

/** A brain key and its epoch (spec §4). */
export interface BrainKey {
  epoch: number
  key: Uint8Array
}

/** A brain write as the relay stores it: a clear header and the sealed signature ‖ payload. */
export interface SealedRecord {
  v: 1
  kind: 'op'
  brain: string
  op_id: string
  epoch: number
  nonce: string
  ct: string
}

/** A membership record as the relay stores it: the payload and its signature, in the clear. */
export interface ClearRecord {
  v: 1
  kind: 'clear'
  brain: string
  op_id: string
  payload: string
  sig: string
}

export type LogRecord = SealedRecord | ClearRecord

/** An op of a shared brain: the F2 envelope with its team fields. */
export type TeamOp = OpEnvelope & { team: TeamFields }

/** An opened record: the envelope, the exact payload bytes (as text), the author's signature — what the replica logs — and the epoch it was sealed under (null in the clear). */
export interface OpenedOp {
  envelope: TeamOp
  payload: string
  sig: string
  epoch: number | null
}

const OP_DOMAIN = 'eml-op-v1\n'

/**
 * The largest payload, in bytes of UTF-8: 16 MiB. The largest op is an
 * engram.import of a big set — a whole brain of ~1400 engrams with their
 * journals and relations is ~6.5 MiB of JSON — so this leaves room, and caps
 * what a member can make every replica (and the relay) hold for one op.
 */
export const MAX_PAYLOAD = 16 * 1024 * 1024
const CALL = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/
const ENVELOPE_FIELDS = ['op_id', 'schema', 'call', 'args', 'provenance', 'team']
const TEAM_FIELDS = ['brain', 'device', 'base_seq', 'head_hash']
const SEALED_FIELDS = ['v', 'kind', 'brain', 'op_id', 'epoch', 'nonce', 'ct']
const CLEAR_FIELDS = ['v', 'kind', 'brain', 'op_id', 'payload', 'sig']

/** True for the calls that travel in the clear: the genesis with its root membership and the team.* records. */
export function isClearCall(call: string): boolean {
  return call === 'brain.genesis' || call.startsWith('team.')
}

/** Seals a brain write: signed by `device`, encrypted with `key`. Returns the record and what the author logs. */
export function sealOp(envelope: TeamOp, device: KeyPair, key: BrainKey): { record: SealedRecord } & OpenedOp {
  return sealOpWith(sodium.randombytes_buf(NONCE_BYTES), envelope, device, key)
}

/** sealOp with a given nonce — for the test vectors; a nonce is never used twice under one key. */
export function sealOpWith(nonce: Uint8Array, envelope: TeamOp, device: KeyPair, key: BrainKey): { record: SealedRecord } & OpenedOp {
  if (isClearCall(envelope.call)) throw new ProtocolError(`${envelope.call} travels in the clear, not sealed`)
  checkEpoch(key.epoch)
  if (nonce.length !== NONCE_BYTES) throw new ProtocolError(`a nonce is ${NONCE_BYTES} bytes`)
  if (key.key.length !== KEY_BYTES) throw new ProtocolError(`a brain key is ${KEY_BYTES} bytes`)
  const { payload, sig } = signed(envelope, device)
  const header = { v: PROTOCOL_VERSION, kind: 'op' as const, brain: envelope.team.brain, op_id: envelope.op_id, epoch: key.epoch, nonce: toBase64url(nonce) }
  const plaintext = new Uint8Array([...fromBase64url(sig, SIG_BYTES, 'the signature'), ...sodium.from_string(payload)])
  const { ct } = sealBox(plaintext, canonicalJson(header), nonce, key.key)
  return { record: { ...header, ct }, envelope: JSON.parse(payload) as TeamOp, payload, sig, epoch: key.epoch }
}

/** Signs a membership record (a clear call) with `device`. Returns the record and what the author logs. */
export function clearOp(envelope: TeamOp, device: KeyPair): { record: ClearRecord } & OpenedOp {
  if (!isClearCall(envelope.call)) throw new ProtocolError(`${envelope.call} is a brain write and travels sealed`)
  const { payload, sig } = signed(envelope, device)
  return { record: { v: PROTOCOL_VERSION, kind: 'clear', brain: envelope.team.brain, op_id: envelope.op_id, payload, sig }, envelope: JSON.parse(payload) as TeamOp, payload, sig, epoch: null }
}

/**
 * Opens a record of `brain` as the relay delivered it: exactly the fields of
 * its kind, the brain's own, decrypted with the key of its epoch (a sealed
 * record), the payload in its one byte form and a well-formed envelope, the
 * call in the right kind, and the signature of the device the envelope names.
 * Whether that device may write at this position and whether the epoch is
 * the current one is the member set's to say (block 4). Throws ProtocolError
 * (UnsupportedVersionError for a newer protocol).
 */
export function openRecord(record: unknown, brain: string, keyFor: (epoch: number) => Uint8Array | undefined): OpenedOp {
  const r = asObject(record, 'a record')
  checkVersion(r.v)
  if (r.kind !== 'op' && r.kind !== 'clear') throw new ProtocolError(`a record's kind is op or clear, not ${String(r.kind)}`)
  exactFields(r, r.kind === 'op' ? SEALED_FIELDS : CLEAR_FIELDS, `a ${r.kind} record`)
  if (r.brain !== brain) throw new ProtocolError('the record is for another brain')

  let payload: string
  let sig: string
  if (r.kind === 'op') {
    checkEpoch(r.epoch)
    if (typeof r.ct === 'string' && r.ct.length > Math.ceil((SIG_BYTES + MAX_PAYLOAD + TAG_BYTES) * 4 / 3)) throw new ProtocolError(`the payload is larger than ${MAX_PAYLOAD} bytes`)
    const key = keyFor(r.epoch as number)
    if (!key) throw new ProtocolError(`no brain key for epoch ${String(r.epoch)}`)
    const { ct, ...header } = r
    const plaintext = openBox(ct, r.nonce, canonicalJson(header), key, 'the record does not decrypt under the key of its epoch')
    if (plaintext.length <= SIG_BYTES) throw new ProtocolError('the sealed record holds no payload')
    sig = toBase64url(plaintext.subarray(0, SIG_BYTES))
    payload = utf8(plaintext.subarray(SIG_BYTES), 'the payload')
  } else {
    if (typeof r.payload !== 'string') throw new ProtocolError('the payload is a string')
    if (Buffer.byteLength(r.payload, 'utf-8') > MAX_PAYLOAD) throw new ProtocolError(`the payload is larger than ${MAX_PAYLOAD} bytes`)
    payload = r.payload
    sig = r.sig as string
    fromBase64url(sig, SIG_BYTES, 'the signature')
  }

  const envelope = parseEnvelope(payload, brain)
  if (envelope.op_id !== r.op_id) throw new ProtocolError('the record\'s op_id is not its payload\'s')
  if (isClearCall(envelope.call) !== (r.kind === 'clear')) {
    throw new ProtocolError(r.kind === 'clear' ? `${envelope.call} is a brain write and travels sealed` : `${envelope.call} travels in the clear, not sealed`)
  }
  if (!verifyText(envelope.team.device, OP_DOMAIN, sha256Hex(payload), sig)) throw new ProtocolError('the op is not signed by its device')
  return { envelope, payload, sig, epoch: r.kind === 'op' ? r.epoch as number : null }
}

/** The payload of `envelope` and the device's signature over it, after the same checks a reader makes. */
function signed(envelope: TeamOp, device: KeyPair): { payload: string, sig: string } {
  const payload = plainJson(envelope)
  if (Buffer.byteLength(payload, 'utf-8') > MAX_PAYLOAD) throw new ProtocolError(`the payload is larger than ${MAX_PAYLOAD} bytes`)
  parseEnvelope(payload, envelope.team?.brain)
  if (envelope.team.device !== device.publicKey) throw new ProtocolError('team.device is not the signing device\'s key')
  return { payload, sig: signText(device, OP_DOMAIN, sha256Hex(payload)) }
}

/**
 * The envelope in `payload`, when the payload is exactly one: plain JSON in
 * its one byte form (as plainJson writes it — no whitespace, no duplicate
 * keys), the F2 fields and the team fields and nothing else, each
 * well-formed, for `brain`. The provenance's values are the brain schema's to
 * check (core does, before an op runs).
 */
function parseEnvelope(payload: string, brain: unknown): TeamOp {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new ProtocolError('the payload is not JSON')
  }
  if (plainJson(value) !== payload) throw new ProtocolError('the payload is not in its one byte form (plain JSON without whitespace or repeated keys)')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError('the payload is an object')
  const op = value as Record<string, unknown>
  exactFields(op, ENVELOPE_FIELDS, 'an op')
  if (typeof op.op_id !== 'string' || !UUID.test(op.op_id)) throw new ProtocolError('op_id is not a lowercase UUID')
  if (!Number.isSafeInteger(op.schema) || (op.schema as number) < 1) throw new ProtocolError('schema is not a positive integer')
  if (typeof op.call !== 'string' || !CALL.test(op.call)) throw new ProtocolError('call is not a name like engram.create')
  const problem = provenanceProblem(op.provenance)
  if (problem) throw new ProtocolError(problem)
  // a membership record's author is its signing device alone; it names no handle, agent, session, model or harness
  if (isClearCall(op.call) && Object.values(op.provenance as object).some(v => v !== null)) {
    throw new ProtocolError(`${op.call} carries a provenance with every field null`)
  }
  const team = asObject(op.team, 'team')
  exactFields(team, TEAM_FIELDS, 'team')
  if (typeof team.brain !== 'string' || !UUID.test(team.brain)) throw new ProtocolError('team.brain is not a lowercase UUID')
  if (team.brain !== brain) throw new ProtocolError('the op is for another brain')
  fromBase64url(team.device, KEY_BYTES, 'team.device')
  if (!Number.isSafeInteger(team.base_seq) || (team.base_seq as number) < 0) throw new ProtocolError('team.base_seq is not a non-negative integer')
  if (typeof team.head_hash !== 'string' || !HASH.test(team.head_hash)) throw new ProtocolError('team.head_hash is not 64 lowercase hex digits')
  return op as unknown as TeamOp
}

function checkEpoch(epoch: unknown): void {
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) throw new ProtocolError('the epoch is not a non-negative integer')
}
