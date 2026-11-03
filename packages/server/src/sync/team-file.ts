import * as fs from 'fs'
import * as path from 'path'
import {
  encryptionKeyFromSeed, signingKeyFromSeed,
  type BrainKey, type DeviceCert, type DeviceKeys, type JoinRequest, type KeyPair, type LogAnchor,
} from '@engramprotocol/protocol'

// --- The team file (v0.21, spec team-brain-sync-client-spec §4) -------------------
//
// What this device holds for one shared brain, outside brains/ and its
// backups: <data-dir>/team/<team brain id>.json, owner-only, written whole or
// not at all. It is named by the team brain id the brain's genesis carries;
// nothing here is derived locally. It holds the relay, the device's seeds and
// — from create or join on — the member's identity seed (decision
// team-file-keeps-member-identity-seed), nothing the log already says: the
// handle comes from the log, the brain keys from the relay (wrapped for this
// device), and stay in memory. While a creation is under way it also carries
// what the relay has not taken yet: the genesis with its grant until the
// relay created the brain, the epoch-0 key until it is put for this device.
// While a join is under way (§5) it carries the join with its invite link
// until the inviter's accept is in, then the accept until the brain key the
// inviter wrapped for this device is taken. An owner's open invites live here
// too (spec team-brain-membership-flows-spec §3): their secrets are what opens
// a join and MACs the accept, so they have to survive a restart; each leaves
// once it is accepted, cancelled or expired.

export interface TeamFile {
  v: 1
  /** the team brain id, as the genesis names it */
  brain: string
  /** the relay's origin, wss://<host> (ws:// only for a local test relay) */
  relay: string
  device: DeviceKeys
  /** the member's identity key — on the device that created or joined as the member; it certifies further devices */
  identity?: KeyPair
  /** a creation the relay has not confirmed yet: the genesis record and the grant to send with it */
  create?: { genesis: Record<string, unknown>, grant: string }
  /** a brain key this device holds but has not put at the relay for itself yet */
  key?: BrainKey
  /** a join the inviter has not accepted yet: the invite link (it holds the secret the accept is checked with) and the join as sent */
  join?: { link: string, request: JoinRequest }
  /** an accepted join whose brain key is not in yet: the inviter's device, which alone wraps this device's first key, and the log anchor it named */
  accept?: { inviter: DeviceCert, anchor: LogAnchor }
  /** the open invites this device made, by their secret: what opens a join and answers it */
  invites?: StoredInvite[]
}

/** An invite as the team file keeps it: the id the relay knows, the secret only this device knows, and when it expires. */
export interface StoredInvite {
  invite_id: string
  secret: Uint8Array
  expires_at: string
}

/** Why a team file cannot be used — a fixed reason, never the file's text or a field's value. */
export class TeamFileError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'TeamFileError'
  }
}

/** Seeds and brain keys are 32 bytes: 43 characters of base64url. */
const SEED_BYTES = 32
const SEED_TEXT = /^[A-Za-z0-9_-]{43}$/
/** An invite id is 16 bytes: 22 characters of base64url. */
const INVITE_ID_TEXT = /^[A-Za-z0-9_-]{22}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function teamFilePath(dataDir: string, brain: string): string {
  return path.join(dataDir, 'team', `${brain}.json`)
}

/**
 * The team file of `brain`, or null when this server has none. Throws
 * TeamFileError with a fixed reason when it is malformed or for another brain.
 */
export function readTeamFile(dataDir: string, brain: string): TeamFile | null {
  let text: string
  try {
    text = fs.readFileSync(teamFilePath(dataDir, brain), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    raw = parsed as Record<string, unknown>
  } catch {
    throw new TeamFileError('it is not valid JSON')
  }
  if (raw.v !== 1) throw new TeamFileError('its version is not 1')
  if (raw.brain !== brain) throw new TeamFileError('it is for another brain')
  if (typeof raw.relay !== 'string' || !isRelayOrigin(raw.relay)) throw new TeamFileError('the relay is not a ws(s):// origin')
  const device = field(raw.device)
  const file: TeamFile = {
    v: 1,
    brain,
    relay: raw.relay,
    device: { sign: signingKeyFromSeed(seed(device.sign_seed)), enc: encryptionKeyFromSeed(seed(device.enc_seed)) },
  }
  if (raw.identity !== undefined) file.identity = signingKeyFromSeed(seed(field(raw.identity).seed))
  if (raw.create !== undefined) {
    const create = field(raw.create)
    if (typeof create.genesis !== 'object' || create.genesis === null || Array.isArray(create.genesis) || typeof create.grant !== 'string') {
      throw new TeamFileError('its creation is malformed')
    }
    file.create = { genesis: create.genesis as Record<string, unknown>, grant: create.grant }
  }
  if (raw.key !== undefined) {
    const key = field(raw.key)
    if (!Number.isSafeInteger(key.epoch) || (key.epoch as number) < 0) throw new TeamFileError('its key is malformed')
    file.key = { epoch: key.epoch as number, key: seed(key.key) }
  }
  if (raw.join !== undefined) {
    const join = field(raw.join)
    if (typeof join.link !== 'string' || !isObject(join.request)) throw new TeamFileError('its join is malformed')
    file.join = { link: join.link, request: join.request as unknown as JoinRequest }
  }
  if (raw.accept !== undefined) {
    const accept = field(raw.accept)
    const anchor = accept.anchor
    if (!isObject(accept.inviter) || !isObject(anchor) || typeof anchor.genesis !== 'string' || !Number.isSafeInteger(anchor.seq) || typeof anchor.head_hash !== 'string') {
      throw new TeamFileError('its accept is malformed')
    }
    file.accept = { inviter: accept.inviter as unknown as DeviceCert, anchor: { genesis: anchor.genesis, seq: anchor.seq as number, head_hash: anchor.head_hash } }
  }
  if (raw.invites !== undefined) {
    if (!Array.isArray(raw.invites)) throw new TeamFileError('its invites are malformed')
    file.invites = raw.invites.map((value): StoredInvite => {
      const invite = field(value)
      if (typeof invite.invite_id !== 'string' || !INVITE_ID_TEXT.test(invite.invite_id) || typeof invite.expires_at !== 'string' || !ISO_MS.test(invite.expires_at)) {
        throw new TeamFileError('an invite is malformed')
      }
      return { invite_id: invite.invite_id, secret: seed(invite.secret), expires_at: invite.expires_at }
    })
  }
  return file
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Writes the team file whole: into a temporary file next to it, owner-only,
 * synced, then renamed over the old one — a crash leaves the old file or the
 * new one, never a torn one.
 */
export function writeTeamFile(dataDir: string, file: TeamFile): void {
  const target = teamFilePath(dataDir, file.brain)
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const body = {
    v: file.v,
    brain: file.brain,
    relay: file.relay,
    device: { sign_seed: text(file.device.sign.seed), enc_seed: text(file.device.enc.seed) },
    ...(file.identity ? { identity: { seed: text(file.identity.seed) } } : {}),
    ...(file.create ? { create: file.create } : {}),
    ...(file.key ? { key: { epoch: file.key.epoch, key: text(file.key.key) } } : {}),
    ...(file.join ? { join: file.join } : {}),
    ...(file.accept ? { accept: file.accept } : {}),
    ...(file.invites && file.invites.length > 0 ? { invites: file.invites.map(i => ({ invite_id: i.invite_id, secret: text(i.secret), expires_at: i.expires_at })) } : {}),
  }
  const tmp = `${target}.tmp`
  fs.rmSync(tmp, { force: true })  // a leftover (a crash, or made with wider bits) would keep its mode
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(body, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, target)
  syncDir(dir)
}

/** Removes the team file of `brain` (a creation that never reached the relay). */
export function removeTeamFile(dataDir: string, brain: string): void {
  fs.rmSync(teamFilePath(dataDir, brain), { force: true })
  syncDir(path.join(dataDir, 'team'))
}

/**
 * True for a relay as the team file and the create route take it: a wss://
 * origin — scheme and host, no path. ws:// only to a loopback host, for a
 * local test relay; a relay elsewhere is reached over TLS or not at all.
 */
export function isRelayOrigin(value: string): boolean {
  if (!/^wss?:\/\/[^/?#@]+$/.test(value)) return false
  try {
    const url = new URL(value)
    if (url.origin !== value && url.href !== `${value}/`) return false
    return url.protocol === 'wss:' || LOOPBACK.has(url.hostname)
  } catch {
    return false
  }
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** The relay origin for the host an invite link names: wss://<host>, or ws://<host> for a loopback host (a local test relay). */
export function relayOriginFor(host: string): string {
  const hostname = new URL(`wss://${host}`).hostname
  return `${LOOPBACK.has(hostname) ? 'ws' : 'wss'}://${host}`
}

/** The rename is durable once the directory is: fsync it (Windows cannot open a directory for that). */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number
  try {
    fd = fs.openSync(dir, 'r')
  } catch {
    return  // the directory is gone (nothing to make durable)
  }
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** A section of the file as an object; TeamFileError (fixed reason) otherwise. */
function field(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TeamFileError('a section is malformed')
  return value as Record<string, unknown>
}

/** A 32-byte seed or key from its text form; TeamFileError (fixed reason) otherwise. */
function seed(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !SEED_TEXT.test(value)) throw new TeamFileError('a seed is malformed')
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
  if (bytes.length !== SEED_BYTES) throw new TeamFileError('a seed is malformed')
  return bytes
}
