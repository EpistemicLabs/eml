import { describe, it, expect, beforeAll } from 'vitest'
import { verify } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LOGIN_WINDOW_MS, ProtocolError, UnsupportedVersionError, applyMembership, genesisMembers, loginChallenge, loginResponse,
  openRecord, ready, signingKeyFromSeed, verifyLogin, type LoginChallenge,
} from '../src'
import { BRAIN, K, addMember, clear, found, person, sha } from './helpers'

// v0.21 (spec team-brain-protocol-package-spec §7, block 7): the relay login —
// a challenge for one host and brain, the device's signed response, and the
// relay's check — against the frozen vector in vectors/login.json.

const L = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'login.json'), 'utf-8'))
const M = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'membership.json'), 'utf-8'))
const HOST = 'relay.example.org'
const T0 = '2026-10-26T08:00:00.000Z'
const T1 = '2026-10-26T08:00:01.000Z'
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const issued = (c: LoginChallenge, used = false) => ({ ...c, used })

beforeAll(() => ready())

describe('the vector', () => {
  it('reproduces the response, node:crypto checks its signature, the relay logs the root device in', () => {
    const device = signingKeyFromSeed(sha('device sign'))
    expect(loginResponse(L.challenge, HOST, BRAIN, device)).toEqual(L.response)
    expect(verify(null, Buffer.from(L.signed_text, 'utf-8'), { key: Buffer.concat([ED25519_SPKI, Buffer.from(L.response.device, 'base64url')]), format: 'der', type: 'spki' }, Buffer.from(L.response.sig, 'base64url'))).toBe(true)
    const set = genesisMembers(openRecord(M.genesis.record, BRAIN, () => undefined))
    expect(verifyLogin(set, issued(L.challenge), L.response, T1)).toEqual({ member: K.identity.public_key, device: L.response.device })
  })
})

describe('the challenge', () => {
  it('a fresh 32-byte nonce for one host and brain', () => {
    const a = loginChallenge(HOST, BRAIN, T0)
    const b = loginChallenge(HOST, BRAIN, T0)
    expect(a).toMatchObject({ v: 1, relay: HOST, brain: BRAIN, issued_at: T0 })
    expect(Buffer.from(a.nonce, 'base64url')).toHaveLength(32)
    expect(a.nonce).not.toBe(b.nonce)
    expect(() => loginChallenge(HOST, BRAIN.toUpperCase(), T0)).toThrow(/brain/)
    expect(() => loginChallenge(HOST, BRAIN, 'now')).toThrow(/now/)
  })
})

describe('logging in', () => {
  function team() {
    const ada = person('ada')
    const bo = person('bo')
    const { set, keys } = found(ada)
    return { ada, bo, set: applyMembership(set, addMember(set, keys, ada, bo)) }
  }

  it('a current device of a member logs in once', () => {
    const { bo, set } = team()
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const response = loginResponse(challenge, HOST, BRAIN, bo.device.sign)
    expect(verifyLogin(set, issued(challenge), JSON.parse(JSON.stringify(response)), T1)).toEqual({ member: bo.identity.publicKey, device: bo.device.sign.publicKey })
  })

  it('a replayed response: the used challenge refuses it, and a new challenge does not take it', () => {
    const { bo, set } = team()
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const response = loginResponse(challenge, HOST, BRAIN, bo.device.sign)
    expect(() => verifyLogin(set, issued(challenge, true), response, T1)).toThrow(/answered already/)
    expect(() => verifyLogin(set, issued(loginChallenge(HOST, BRAIN, T0)), response, T1)).toThrow(/answers another challenge/)
  })

  it('the wrong host: the device refuses another relay\'s challenge; the relay refuses a response for another host', () => {
    const { bo, set } = team()
    const elsewhere = loginChallenge('other-relay.example.org', BRAIN, T0)
    expect(() => loginResponse(elsewhere, HOST, BRAIN, bo.device.sign)).toThrow(/for the relay other-relay.example.org, not relay.example.org/)
    // a response to the other relay's challenge, passed through to this one
    const passed = loginResponse(elsewhere, 'other-relay.example.org', BRAIN, bo.device.sign)
    expect(() => verifyLogin(set, issued({ ...elsewhere, relay: HOST }), passed, T1)).toThrow(/answers another challenge/)
  })

  it('the wrong brain: the device refuses the challenge; the relay refuses the response', () => {
    const { bo, set } = team()
    const other = '00000000-0000-4000-8000-000000000000'
    expect(() => loginResponse(loginChallenge(HOST, other, T0), HOST, BRAIN, bo.device.sign)).toThrow(/another brain/)
    const challenge = loginChallenge(HOST, other, T0)
    const response = loginResponse(challenge, HOST, other, bo.device.sign)
    expect(() => verifyLogin(set, issued(challenge), response, T1)).toThrow(/member set is for another brain/)
  })

  it('a revoked device, a removed member, a device of nobody', () => {
    const { ada, bo, set } = team()
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const revoked = applyMembership(set, clear(bo, 'team.revoke_device', { device: bo.device.sign.publicKey }))
    expect(() => verifyLogin(revoked, issued(challenge), loginResponse(challenge, HOST, BRAIN, bo.device.sign), T1)).toThrow(/not a current device/)
    const removed = applyMembership(set, clear(ada, 'team.remove_member', { member: bo.identity.publicKey }))
    expect(() => verifyLogin(removed, issued(challenge), loginResponse(challenge, HOST, BRAIN, bo.device.sign), T1)).toThrow(/not a current device/)
    expect(() => verifyLogin(set, issued(challenge), loginResponse(challenge, HOST, BRAIN, person('x').device.sign), T1)).toThrow(/not a current device/)
  })

  it('a challenge older than a minute, a time before it was issued', () => {
    const { bo, set } = team()
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const response = loginResponse(challenge, HOST, BRAIN, bo.device.sign)
    const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
    expect(() => verifyLogin(set, issued(challenge), response, at(LOGIN_WINDOW_MS - 1))).not.toThrow()
    expect(() => verifyLogin(set, issued(challenge), response, at(LOGIN_WINDOW_MS))).toThrow(/older than a minute/)
    expect(() => verifyLogin(set, issued(challenge), response, at(-1))).toThrow(/older than a minute/)
  })

  it('a forged signature, another device\'s key, a newer version, an extra field', () => {
    const { ada, bo, set } = team()
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const response = loginResponse(challenge, HOST, BRAIN, bo.device.sign)
    const sig = Buffer.from(response.sig, 'base64url')
    sig[0] ^= 1
    expect(() => verifyLogin(set, issued(challenge), { ...response, sig: sig.toString('base64url') }, T1)).toThrow(/not signed by its device/)
    expect(() => verifyLogin(set, issued(challenge), { ...response, device: ada.device.sign.publicKey }, T1)).toThrow(/not signed by its device/)
    expect(() => verifyLogin(set, issued(challenge), { ...response, v: 2 }, T1)).toThrow(UnsupportedVersionError)
    expect(() => verifyLogin(set, issued(challenge), { ...response, token: 'x' }, T1)).toThrow(/no field token/)
    expect(() => loginResponse({ ...challenge, v: 2 }, HOST, BRAIN, bo.device.sign)).toThrow(UnsupportedVersionError)
    expect(() => loginResponse({ ...challenge, nonce: 'short' }, HOST, BRAIN, bo.device.sign)).toThrow(ProtocolError)
  })
})
