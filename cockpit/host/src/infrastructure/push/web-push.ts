import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'

/**
 * Web push without a library: message encryption (RFC 8291, aes128gcm of
 * RFC 8188) and the application server's signature (VAPID, RFC 8292), sent
 * to the push service the browser named in its subscription (RFC 8030).
 * Only the browser that subscribed can read a message; the push service sees
 * its size and when it is sent.
 */

/** A browser's subscription keys, base64url as PushSubscription.toJSON() gives them. */
export interface ReceiverKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes). */
  p256dh: string
  /** The 16-byte authentication secret. */
  auth: string
}

/** The application server's key pair, base64url: the raw public key (65 bytes) and the private scalar (32 bytes). */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

const RECORD_SIZE = 4096

/**
 * One push message body: the aes128gcm header (salt, record size, sender key)
 * and a single encrypted record. `fixed` takes the sender key and salt for
 * tests; otherwise both are new for every message, as the RFC requires.
 */
export function encryptPayload(plaintext: Buffer, receiver: ReceiverKeys, fixed?: { senderPrivateKey: Buffer; salt: Buffer }): Buffer {
  const receiverPublic = Buffer.from(receiver.p256dh, 'base64url')
  const authSecret = Buffer.from(receiver.auth, 'base64url')
  const sender = createECDH('prime256v1')
  if (fixed) sender.setPrivateKey(fixed.senderPrivateKey)
  else sender.generateKeys()
  const senderPublic = sender.getPublicKey()
  const salt = fixed?.salt ?? randomBytes(16)

  const ecdhSecret = sender.computeSecret(receiverPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  // The last (and only) record ends with the delimiter 0x02.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(senderPublic.length, 20)
  return Buffer.concat([header, senderPublic, record])
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  return { publicKey: raw.toString('base64url'), privateKey: jwk.d! }
}

/** Twelve hours: RFC 8292 caps a token at 24. */
const TOKEN_LIFETIME_S = 12 * 3600

/** The Authorization header for one push service: a token for its origin, signed with the server's key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp: nowSeconds + TOKEN_LIFETIME_S, sub: subject })}`
  const raw = Buffer.from(keys.publicKey, 'base64url')
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  })
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`
}

export interface PushTarget extends ReceiverKeys {
  endpoint: string
}

export interface PushOptions {
  /** How long the push service keeps it for a device that is offline. */
  ttlSeconds: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
  /** A newer message with the same topic replaces one still waiting at the push service (base64url, at most 32 characters). */
  topic?: string
}

/** Sends one message. The answer is the push service's status: 201 taken, 404 or 410 the subscription is gone. */
export async function sendPush(target: PushTarget, payload: Buffer, keys: VapidKeys, subject: string, options: PushOptions): Promise<number> {
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttlSeconds),
      Urgency: options.urgency,
      ...(options.topic ? { Topic: options.topic } : {}),
    },
    body: new Uint8Array(encryptPayload(payload, target)),
    signal: AbortSignal.timeout(10_000),
  })
  await response.body?.cancel()
  return response.status
}
