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

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

function readDevice(value: unknown): PushDevice | null {
  const entry = value as Partial<PushDevice> | null
  if (!entry || !isText(entry.id) || !isText(entry.endpoint) || !isText(entry.p256dh) || !isText(entry.auth) || !isText(entry.origin)) return null
  return {
    id: entry.id, endpoint: entry.endpoint, p256dh: entry.p256dh, auth: entry.auth, origin: entry.origin,
    label: typeof entry.label === 'string' ? entry.label : '', createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
  }
}

function load(file: string): PushFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PushFile>
    if (parsed.version !== 1) return empty()
    const vapid = parsed.vapid && isText(parsed.vapid.publicKey) && isText(parsed.vapid.privateKey)
      ? { publicKey: parsed.vapid.publicKey, privateKey: parsed.vapid.privateKey } : null
    const devices = Array.isArray(parsed.devices) ? parsed.devices.map(readDevice).filter((entry): entry is PushDevice => entry !== null) : []
    return { version: 1, vapid, devices }
  } catch {
    return empty()
  }
}

export class PushStore {
  private data: PushFile

  constructor(private file = PUSH_FILE, private generate: () => VapidKeys = generateVapidKeys) {
    this.data = load(file)
  }

  /** The server's key pair; made and kept on the first call. */
  vapid(): VapidKeys {
    if (!this.data.vapid) {
      this.data.vapid = this.generate()
      this.persist()
    }
    return this.data.vapid
  }

  devices(): PushDevice[] {
    return this.data.devices
  }

  /** One entry per endpoint: a browser that subscribes again replaces its keys. */
  subscribe(input: PushDeviceInput): PushDevice {
    const known = this.data.devices.find((entry) => entry.endpoint === input.endpoint)
    const device: PushDevice = { ...input, id: known?.id ?? randomUUID(), createdAt: known?.createdAt ?? new Date().toISOString() }
    this.data.devices = [...this.data.devices.filter((entry) => entry.endpoint !== input.endpoint), device]
    this.persist()
    return device
  }

  unsubscribe(endpoint: string): boolean {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((entry) => entry.endpoint !== endpoint)
    if (this.data.devices.length === before) return false
    this.persist()
    return true
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.chmodSync(this.file, 0o600)
    } catch (err) {
      process.stderr.write(`[push] persist failed: ${(err as Error).message}\n`)
    }
  }
}
