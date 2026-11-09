import { describe, it, expect } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPublicKey, verify } from 'node:crypto'
import { encryptPayload, generateVapidKeys, sendPush, vapidAuthorization, vapidSubject } from '../src/infrastructure/push/web-push.js'

const b64 = (text: string) => Buffer.from(text.replace(/\s+/g, ''), 'base64url')

// RFC 8291 section 5 and appendix A: the worked example, with its fixed sender key and salt.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
}

describe('encryptPayload', () => {
  it('produces the body of the RFC 8291 example from its keys and salt', () => {
    const body = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.receiverPublic, auth: RFC.authSecret }, {
      senderPrivateKey: b64(RFC.senderPrivate), salt: b64(RFC.salt),
    })
    expect(body.toString('base64url')).toBe(RFC.body.replace(/\s+/g, ''))
  })

  it('uses a fresh sender key and salt for every message', () => {
    const receiver = { p256dh: RFC.receiverPublic, auth: RFC.authSecret }
    const first = encryptPayload(Buffer.from('same'), receiver)
    const second = encryptPayload(Buffer.from('same'), receiver)
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(first.equals(second)).toBe(false)
  })
})

describe('vapidAuthorization', () => {
  it('signs a token for the push service origin that the public key verifies', () => {
    const keys = generateVapidKeys()
    const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH', keys, 'https://cockpit.example', 1_000_000)
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, token, key] = match!
    expect(key).toBe(keys.publicKey)
    const [head, claims, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    // An expiry under 24 hours ahead, as RFC 8292 asks.
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: 1_000_000 + 12 * 3600, sub: 'https://cockpit.example' })
    const raw = Buffer.from(keys.publicKey, 'base64url')
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  })
})

describe('sendPush', () => {
  it('posts the encrypted message with its headers and answers the push service\'s status', async () => {
    const seen: http.IncomingHttpHeaders[] = []
    const service = http.createServer((req, res) => {
      seen.push(req.headers)
      req.resume()
      req.on('end', () => { res.writeHead(410); res.end() })
    })
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    try {
      const endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}/push/abc`
      const status = await sendPush({ endpoint, p256dh: RFC.receiverPublic, auth: RFC.authSecret }, Buffer.from('{}'), generateVapidKeys(), 'https://cockpit.example',
        { ttlSeconds: 3600, urgency: 'high', topic: 'session-1' })
      expect(status).toBe(410)
      expect(seen[0]).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '3600', urgency: 'high', topic: 'session-1' })
      expect(seen[0].authorization).toMatch(/^vapid t=.+, k=.+$/)
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()))
    }
  })
})

describe('vapidSubject', () => {
  it('names the cockpit by its https address, and by the project page where it has none', () => {
    expect(vapidSubject('https://cockpit.example:8443')).toBe('https://cockpit.example:8443')
    expect(vapidSubject('http://localhost:4317')).toBe('https://github.com/EpistemicLabs/eml')
  })
})
