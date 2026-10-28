import * as fs from 'fs'
import * as path from 'path'
import { encryptionKeyFromSeed, signingKeyFromSeed, type DeviceKeys } from '@engramprotocol/protocol'

// --- The team file (v0.21, spec team-brain-sync-client-spec §4) -------------------
//
// What this device holds for one shared brain, outside brains/ and its
// backups: <data-dir>/team/<team brain id>.json, owner-only. It is named by the
// team brain id the brain's genesis carries; nothing here is derived locally.
// It holds the device's seeds and nothing the log already says: the member and
// its handle come from the log, the brain keys from the relay (wrapped for
// this device), and stay in memory.

export interface TeamFile {
  v: 1
  /** the team brain id, as the genesis names it */
  brain: string
  device: DeviceKeys
}

export function teamFilePath(dataDir: string, brain: string): string {
  return path.join(dataDir, 'team', `${brain}.json`)
}

/** The team file of `brain`, or null when this server has none. Throws when it is malformed or for another brain. */
export function readTeamFile(dataDir: string, brain: string): TeamFile | null {
  let text: string
  try {
    text = fs.readFileSync(teamFilePath(dataDir, brain), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const raw = JSON.parse(text) as { v?: unknown, brain?: unknown, device?: { sign_seed?: unknown, enc_seed?: unknown } }
  if (raw.v !== 1) throw new Error(`team file of ${brain}: version ${String(raw.v)} is not 1`)
  if (raw.brain !== brain) throw new Error(`team file of ${brain}: it is for brain ${String(raw.brain)}`)
  return {
    v: 1,
    brain,
    device: { sign: signingKeyFromSeed(seed(raw.device?.sign_seed)), enc: encryptionKeyFromSeed(seed(raw.device?.enc_seed)) },
  }
}

/** Writes the team file, owner-only. */
export function writeTeamFile(dataDir: string, file: TeamFile): void {
  const target = teamFilePath(dataDir, file.brain)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const body = {
    v: file.v,
    brain: file.brain,
    device: { sign_seed: Buffer.from(file.device.sign.seed).toString('base64url'), enc_seed: Buffer.from(file.device.enc.seed).toString('base64url') },
  }
  fs.writeFileSync(target, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
}

function seed(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('team file: a seed is a base64url string')
  return new Uint8Array(Buffer.from(value, 'base64url'))
}
