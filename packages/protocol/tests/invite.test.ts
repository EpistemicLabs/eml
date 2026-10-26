import { describe, it, expect, beforeAll } from 'vitest'
import { createHmac, verify } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  INVITE_DAYS, ProtocolError, UnsupportedVersionError, applyMembership, canonicalJson, checkInviteOpen, inviteLink, inviteNotice,
  joinAccept, joinRequest, memberHandles, newInvite, openAccept, openJoin, parseInviteLink, ready, sha256Hex, signingKeyFromSeed,
  unwrapKey, verifyInviteNotice, wrapKey, type Invite,
} from '../src'
import { joinRequestWith } from '../src/invite'
import { BRAIN, K, addMember, cert, found, keyFor, nodeOpen, person, sha } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §5, block 6): the invite — the
// link with its secret in the fragment, the notice the relay keeps, the join
// with the invitee's handle sealed under the secret, the accept bound to the
// join — against the frozen vectors in vectors/invite.json, whose MACs and
// handle box node:crypto checks independently.

const I = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'invite.json'), 'utf-8'))
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')
const ED25519_SPKI = hex('302a300506032b6570032100')
const vectorInvite = (): Invite => ({ relay: I.invite.relay, brain: BRAIN, invite_id: I.invite.invite_id, secret: hex(I.invite.secret), expires_at: I.invite.expires_at, redeemed: false })
const DAY1 = '2026-10-27T08:00:00.000Z'
/** HMAC-SHA-512-256, as crypto_auth computes it: the first 32 bytes of HMAC-SHA-512. */
const nodeMac = (key: Buffer, text: string): string => createHmac('sha512', key).update(text, 'utf-8').digest().subarray(0, 32).toString('base64url')

beforeAll(() => ready())

describe('the vectors', () => {
  it('the link: https, the relay, version 1, the brain, the invite id, the secret in the fragment', () => {
    expect(inviteLink(vectorInvite())).toBe(I.invite.link)
    const parsed = parseInviteLink(I.invite.link)
    expect(parsed).toEqual({ relay: I.invite.relay, brain: BRAIN, invite_id: I.invite.invite_id, secret: new Uint8Array(hex(I.invite.secret)) })
    expect(new URL(I.invite.link).hash).toBe(`#${hex(I.invite.secret).toString('base64url')}`)
  })

  it('reproduces the join, and node:crypto checks its MAC and opens its handle', () => {
    const joiner = signingKeyFromSeed(sha('identity'))
    expect(joinRequestWith(sha('join nonce').subarray(0, 24), I.invite.link, joiner, K.device_cert.cert, 'juno')).toEqual(I.join)
    const { mac, ...body } = I.join
    expect(nodeMac(hex(I.keys.mac_key), canonicalJson({ t: 'eml-invite-join-v1', ...body }))).toBe(mac)
    const padded = nodeOpen(hex(I.keys.enc_key), b64(I.join.handle.nonce), canonicalJson({ brain: BRAIN, invite_id: I.invite.invite_id, member: I.join.member }), b64(I.join.handle.ct))
    expect(padded[0]).toBe(4)
    expect(padded.subarray(1, 5).toString('utf-8')).toBe('juno')
    expect(I.join_hash).toBe(sha256Hex(canonicalJson(I.join)))
  })

  it('the inviter opens the join; reproduces the accept, whose MAC node:crypto checks; the invitee opens it', () => {
    const opened = openJoin(vectorInvite(), I.join, DAY1)
    expect(opened).toEqual({ member: K.identity.public_key, device_cert: K.device_cert.cert, handle: 'juno', join_hash: I.join_hash })
    expect(joinAccept(vectorInvite(), I.join_hash, I.accept.inviter)).toEqual(I.accept)
    const { mac, ...body } = I.accept
    expect(nodeMac(hex(I.keys.mac_key), canonicalJson({ t: 'eml-invite-accept-v1', ...body }))).toBe(mac)
    expect(openAccept(I.invite.link, I.join, I.accept)).toEqual(I.accept.inviter)
  })

  it('the notice: node:crypto checks the inviter\'s signature; it carries no secret', () => {
    const { sig, ...body } = I.notice
    expect(verify(null, Buffer.from(`eml-invite-notice-v1\n${canonicalJson(body)}`, 'utf-8'), { key: Buffer.concat([ED25519_SPKI, b64(I.notice.inviter)]), format: 'der', type: 'spki' }, b64(sig))).toBe(true)
    expect(Object.keys(I.notice)).toEqual(['v', 'brain', 'invite_id', 'expires_at', 'inviter', 'sig'])
  })

  it('nothing the relay carries holds the secret, its keys or the handle', () => {
    const relaySees = JSON.stringify([I.notice, I.join, I.accept])
    for (const secret of [hex(I.invite.secret), hex(I.keys.mac_key), hex(I.keys.enc_key)]) {
      expect(relaySees).not.toContain(secret.toString('base64url'))
      expect(relaySees).not.toContain(secret.toString('hex'))
    }
    expect(relaySees).not.toContain('juno')
  })
})

describe('the link', () => {
  it('a new invite: random id and secret, open for 7 days, its link parses back', () => {
    const a = newInvite('relay.example.org', BRAIN, '2026-10-26T08:00:00.000Z')
    const b = newInvite('relay.example.org:8443', BRAIN, '2026-10-26T08:00:00.000Z')
    expect(INVITE_DAYS).toBe(7)
    expect(a.expires_at).toBe('2026-11-02T08:00:00.000Z')
    expect(a.redeemed).toBe(false)
    expect(a.invite_id).not.toBe(b.invite_id)
    expect(parseInviteLink(inviteLink(b)).relay).toBe('relay.example.org:8443')
    expect(() => newInvite('Relay.Example.org', BRAIN, '2026-10-26T08:00:00.000Z')).toThrow(/not a host name/)
    expect(() => newInvite('relay.example.org/x', BRAIN, '2026-10-26T08:00:00.000Z')).toThrow(ProtocolError)
    expect(() => newInvite('relay.example.org', BRAIN, 'today')).toThrow(/now is ISO/)
  })

  it('refuses what is not exactly an invite link', () => {
    const link = I.invite.link as string
    const [base, secret] = link.split('#')
    const cases: Array<[string, RegExp]> = [
      ['not a link', /not a URL/],
      [link.replace('https:', 'http:'), /not https/],
      [`${base}?x=1#${secret}`, /not https/],
      [link.replace('https://', 'https://user@'), /not https/],
      [base, /secret is not base64url|secret is 0 bytes/],
      [`${base}#${secret.slice(0, 20)}`, /invite secret/],
      [link.replace('/i/1/', '/j/1/'), /path/],
      [link.replace('/i/1/', '/i/1/x/'), /path/],
      [link.replace(BRAIN, BRAIN.toUpperCase()), /brain/],
      [link.replace(I.invite.invite_id, 'short'), /invite id/],
    ]
    for (const [bad, error] of cases) expect(() => parseInviteLink(bad), bad).toThrow(error)
    expect(() => parseInviteLink(link.replace('/i/1/', '/i/2/'))).toThrow(UnsupportedVersionError)
  })
})

describe('expiry and single use', () => {
  it('an invite is open until it expires and until it is used', () => {
    const open = { expires_at: '2026-11-02T08:00:00.000Z', redeemed: false }
    expect(() => checkInviteOpen(open, '2026-11-02T07:59:59.999Z')).not.toThrow()
    expect(() => checkInviteOpen(open, '2026-11-02T08:00:00.000Z')).toThrow(/expired/)
    expect(() => checkInviteOpen({ ...open, redeemed: true }, DAY1)).toThrow(/used already/)
    expect(() => openJoin({ ...vectorInvite(), redeemed: true }, I.join, DAY1)).toThrow(/used already/)
    expect(() => openJoin(vectorInvite(), I.join, '2026-11-03T08:00:00.000Z')).toThrow(/expired/)
  })
})

describe('the relay\'s notice', () => {
  it('is accepted from a current device of an owner, refused from a member, another brain or a forged signature', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const two = applyMembership(set, addMember(set, keys, ada, bo))
    const invite = newInvite('relay.example.org', BRAIN, '2026-10-26T08:00:00.000Z')
    const notice = inviteNotice(invite, ada.device.sign)
    expect(verifyInviteNotice(two, JSON.parse(JSON.stringify(notice)))).toEqual(notice)
    expect(JSON.stringify(notice)).not.toContain(Buffer.from(invite.secret).toString('base64url'))
    expect(() => verifyInviteNotice(two, inviteNotice(invite, bo.device.sign))).toThrow(/not from a current device of an owner/)
    expect(() => verifyInviteNotice(two, { ...notice, expires_at: '2027-01-01T00:00:00.000Z' })).toThrow(/not signed by its inviter/)
    expect(() => verifyInviteNotice(two, { ...notice, brain: '00000000-0000-4000-8000-000000000000' })).toThrow(/another brain/)
    expect(() => verifyInviteNotice(two, { ...notice, v: 2 })).toThrow(UnsupportedVersionError)
    expect(() => verifyInviteNotice(two, { ...notice, secret: 'x' })).toThrow(/no field secret/)
  })
})

describe('what the relay could swap', () => {
  const invite = vectorInvite
  const other = person('mallory')

  it('the join: another member, another device, another handle, a MAC under another secret', () => {
    expect(() => openJoin(invite(), { ...I.join, member: other.identity.publicKey }, DAY1)).toThrow(/MAC is not the invite's/)
    expect(() => openJoin(invite(), { ...I.join, device_cert: cert(other) }, DAY1)).toThrow(/MAC is not the invite's/)
    const flipped = b64(I.join.handle.ct)
    flipped[3] ^= 1
    expect(() => openJoin(invite(), { ...I.join, handle: { ...I.join.handle, ct: flipped.toString('base64url') } }, DAY1)).toThrow(/MAC is not the invite's/)
    // a join made with a guessed secret: well-formed, but not this invite's
    const guessed = I.invite.link.replace(/#.*/, `#${Buffer.alloc(32, 7).toString('base64url')}`)
    expect(() => openJoin(invite(), joinRequest(guessed, other.identity, cert(other), 'mallory'), DAY1)).toThrow(/MAC is not the invite's/)
    expect(() => openJoin(invite(), { ...I.join, invite_id: 'AAAAAAAAAAAAAAAAAAAAAA' }, DAY1)).toThrow(/another invite/)
    expect(() => openJoin(invite(), { ...I.join, v: 2 }, DAY1)).toThrow(UnsupportedVersionError)
    expect(() => openJoin(invite(), { ...I.join, note: 'x' }, DAY1)).toThrow(/no field note/)
  })

  it('a joiner with the secret but someone else\'s certificate is refused', () => {
    expect(() => joinRequest(I.invite.link, other.identity, K.device_cert.cert, 'mallory')).toThrow(/not the joiner's/)
  })

  it('the accept: another inviter certificate, an answer to another join, a MAC under another secret', () => {
    const mallory = cert(other)
    expect(() => openAccept(I.invite.link, I.join, { ...I.accept, inviter: mallory })).toThrow(/MAC is not the invite's/)
    const otherJoin = joinRequest(I.invite.link, signingKeyFromSeed(sha('identity')), K.device_cert.cert, 'juno')
    expect(() => openAccept(I.invite.link, otherJoin, I.accept)).toThrow(/answers another join/)
    const forged = joinAccept({ ...invite(), secret: Buffer.alloc(32, 9) }, I.join_hash, mallory)
    expect(() => openAccept(I.invite.link, I.join, forged)).toThrow(/MAC is not the invite's/)
  })
})

describe('a join played through', () => {
  it('invite → notice → join → the owner adds the member with its handle → wraps the key → accept → the invitee trusts the wrapper', () => {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    const invite = newInvite('relay.example.org', BRAIN, '2026-10-26T08:00:00.000Z')
    verifyInviteNotice(set, inviteNotice(invite, ada.device.sign))
    const link = inviteLink(invite)

    const request = joinRequest(link, bo.identity, cert(bo), 'bo')
    const joined = openJoin(invite, JSON.parse(JSON.stringify(request)), DAY1)
    expect(joined.handle).toBe('bo')
    invite.redeemed = true
    expect(() => openJoin(invite, request, DAY1)).toThrow(/used already/)

    const two = applyMembership(set, addMember(set, keys, ada, { ...bo, handle: joined.handle }))
    const wrapped = wrapKey(two, keys[0], bo.device.sign.publicKey, ada.device.sign)
    const accept = joinAccept(invite, joined.join_hash, cert(ada))
    const inviter = openAccept(link, request, JSON.parse(JSON.stringify(accept)))
    expect(inviter.device_sign).toBe(wrapped.wrapper)
    expect(unwrapKey(two, wrapped, bo.device)).toEqual(keys[0])
    expect(memberHandles(two, keyFor(keys))[bo.identity.publicKey]).toBe('bo')
  })
})
