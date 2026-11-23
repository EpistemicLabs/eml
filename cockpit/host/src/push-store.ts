import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PUSH_FILE } from './paths.js'
import { generateVapidKeys, type VapidKeys } from './infrastructure/push/web-push.js'

/**
 * push.json: the cockpit's web push key pair and the devices that subscribed.
 * One file, owner-only, rewritten whole through a temporary file on every
 * change, like jobs.json. The private key and the endpoints are secrets:
 * whoever has an endpoint and the key can push to that device.
 */

export interface PushDevice {
  id: string
  /** The push service URL the browser handed out. */
  endpoint: string
  p256dh: string
  auth: string
  /** The cockpit address it subscribed on: a tap opens the session there. */
  origin: string
  /** What Settings calls it ("iPhone", "Mac · Safari"). */
  label: string
  createdAt: string
}

export type PushDeviceInput = Omit<PushDevice, 'id' | 'createdAt'>

interface PushFile {
  version: 1
  /** Made on first use. */
  vapid: VapidKeys | null
  devices: PushDevice[]
}

const empty = (): PushFile => ({ version: 1, vapid: null, devices: [] })

export const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

function readDevice(value: unknown): PushDevice | null {
  const entry = value as Partial<PushDevice> | null
  if (!entry || !isText(entry.id) || !isText(entry.endpoint) || !isText(entry.p256dh) || !isText(entry.auth) || !isText(entry.origin)) return null
  return {
    id: entry.id, endpoint: entry.endpoint, p256dh: entry.p256dh, auth: entry.auth, origin: entry.origin,
    label: typeof entry.label === 'string' ? entry.label : '', createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
  }
}

/**
 * A file that is not there starts empty. One this version cannot read (a later
 * version, a broken write) is moved aside as push.json.unreadable rather than
 * written over: its devices can still be recovered by hand.
 */
function load(file: string): PushFile {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return empty()
  }
  let parsed: Partial<PushFile> | null = null
  try { parsed = JSON.parse(text) as Partial<PushFile> } catch { /* reported below */ }
  if (parsed?.version === 1) {
    const vapid = parsed.vapid && isText(parsed.vapid.publicKey) && isText(parsed.vapid.privateKey)
      ? { publicKey: parsed.vapid.publicKey, privateKey: parsed.vapid.privateKey } : null
    const devices = Array.isArray(parsed.devices) ? parsed.devices.map(readDevice).filter((entry): entry is PushDevice => entry !== null) : []
    return { version: 1, vapid, devices }
  }
  // The reason names no content: the file holds keys and device addresses.
  const reason = parsed ? `version ${String(parsed.version)}` : 'not JSON'
  try { fs.renameSync(file, `${file}.unreadable`) } catch { /* kept where it is; the next write replaces it */ }
  process.stderr.write(`[push] ${path.basename(file)} unreadable (${reason}), moved aside; starting without devices\n`)
  return empty()
}

export class PushStore {
  private data: PushFile

  constructor(private file = PUSH_FILE, private generate: () => VapidKeys = generateVapidKeys) {
    this.data = load(file)
  }

  /** The server's key pair, made on the first call; null while it cannot be written down (a key lost at restart would orphan every device). */
  vapid(): VapidKeys | null {
    if (this.data.vapid) return this.data.vapid
    const keys = this.generate()
    if (!this.persist({ ...this.data, vapid: keys })) return null
    return keys
  }

  devices(): PushDevice[] {
    return this.data.devices
  }

  /** One entry per endpoint: a browser that subscribes again replaces its keys. Null when it could not be written down. */
  subscribe(input: PushDeviceInput): PushDevice | null {
    const known = this.data.devices.find((entry) => entry.endpoint === input.endpoint)
    const device: PushDevice = { ...input, id: known?.id ?? randomUUID(), createdAt: known?.createdAt ?? new Date().toISOString() }
    const devices = [...this.data.devices.filter((entry) => entry.endpoint !== input.endpoint), device]
    return this.persist({ ...this.data, devices }) ? device : null
  }

  unsubscribe(endpoint: string): boolean {
    const devices = this.data.devices.filter((entry) => entry.endpoint !== endpoint)
    if (devices.length === this.data.devices.length) return false
    // Gone from the list even if the file keeps it: the push service no longer takes it.
    if (!this.persist({ ...this.data, devices })) this.data = { ...this.data, devices }
    return true
  }

  /** Writes the new state and takes it on only once it is on disk. */
  private persist(next: PushFile): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.chmodSync(this.file, 0o600)
      this.data = next
      return true
    } catch (err) {
      process.stderr.write(`[push] persist failed: ${(err as Error).message}\n`)
      return false
    }
  }
}
