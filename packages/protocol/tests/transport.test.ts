import { describe, it, expect, beforeAll } from 'vitest'
import {
  CLOSE, ERROR_CODES, MAX_FRAME, MAX_PAYLOAD, PRE_LOGIN_MAX, ProtocolError, UnsupportedVersionError, clearOp, encodeFrame, frameLimit,
  inviteNotice, loginChallenge, loginResponse, newInvite, parseClientFrame, parseRelayFrame, parseSyncPath, ready, sealOp, syncPath,
  type ClientFrame, type RelayFrame,
} from '../src'
import { plainJson } from '../src/log'
import { BRAIN, envelope, person } from './helpers'

// v0.21 (spec team-brain-relay-service-spec §3): the frames a device and the
// relay exchange — exact fields per type, the byte limit checked before
// JSON.parse in both directions, pre-login frames only before the login, and
// the sync path.

const T0 = '2026-10-27T08:00:00.000Z'
const HOST = 'relay.example.org'
const json = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v))

beforeAll(() => ready())

describe('the frames', () => {
  it('every client and relay frame round-trips through encodeFrame and its reader', () => {
    const owner = person('dominik')
    const key = { epoch: 0, key: new Uint8Array(32) }
    const sealed = json(sealOp(envelope(owner, 'engram.create', { title: 't' }), owner.device.sign, key).record)
    const challenge = loginChallenge(HOST, BRAIN, T0)
    const response = loginResponse(challenge, HOST, BRAIN, owner.device.sign)
    const notice = inviteNotice(newInvite(HOST, BRAIN, T0), owner.device.sign)
    const genesis = json(clearOp(envelope(owner, 'brain.genesis', {}), owner.device.sign).record)
    const id = notice.invite_id
    const preLogin: ClientFrame[] = [
      { t: 'login', response: json(response) },
      { t: 'create', genesis, grant: 'opaque' },
      { t: 'join', join: { any: 'join' } },
    ]
    const client: ClientFrame[] = [
      ...preLogin,
      { t: 'subscribe', from: 1 },
      { t: 'append', req: 1, record: sealed },
      { t: 'key_put', req: 2, wrapped: { any: 'key' } },
      { t: 'keys', req: 3 },
      { t: 'invite_put', req: 4, notice: json(notice) },
      { t: 'invite_cancel', req: 5, invite_id: id },
      { t: 'invite_accept', req: 6, accept: { any: 'accept' } },
    ]
    for (const f of client) expect(parseClientFrame(encodeFrame(f, true), true)).toEqual(f)
    for (const f of preLogin) expect(parseClientFrame(encodeFrame(f, false), false)).toEqual(f)

    const relay: RelayFrame[] = [
      { t: 'challenge', challenge: json(challenge) },
      { t: 'welcome', member: owner.identity.publicKey, device: owner.device.sign.publicKey, head: { seq: 7, at: T0 } },
      { t: 'created', seq: 1, at: T0 },
      { t: 'op', seq: 8, at: T0, record: sealed },
      { t: 'caught_up', seq: 8 },
      { t: 'appended', req: 1, seq: 8, at: T0 },
      { t: 'ok', req: 2 },
      { t: 'keys', req: 3, wrapped: [{ any: 'key' }] },
      { t: 'key', wrapped: { any: 'key' } },
      { t: 'join', join: { any: 'join' } },
      { t: 'join_waiting', invite_id: id },
      { t: 'accept', accept: { any: 'accept' } },
      { t: 'invite_closed', invite_id: id, reason: 'cancelled' },
      { t: 'error', req: null, code: 'login_failed', message: 'the challenge is older than a minute' },
      { t: 'error', req: 4, code: 'refused', message: 'rotation due' },
    ]
    for (const f of relay) expect(parseRelayFrame(encodeFrame(f, true), true)).toEqual(f)
  })

  it('reads a frame from bytes as well as from text', () => {
    const raw = encodeFrame({ t: 'keys', req: 1 }, true)
    expect(parseClientFrame(Buffer.from(raw, 'utf8'), true)).toEqual({ t: 'keys', req: 1 })
    expect(parseClientFrame(new Uint8Array(Buffer.from(raw, 'utf8')), true)).toEqual({ t: 'keys', req: 1 })
  })

  it('a sealed record at MAX_PAYLOAD fits an append and an op frame', () => {
    const owner = person('dominik')
    const key = { epoch: 0, key: new Uint8Array(32) }
    const base = envelope(owner, 'engram.create', { content: '' })
    const pad = MAX_PAYLOAD - Buffer.byteLength(plainJson(base))
    const { record, payload } = sealOp({ ...base, args: { content: 'x'.repeat(pad) } }, owner.device.sign, key)
    expect(Buffer.byteLength(payload)).toBe(MAX_PAYLOAD)
    const op = encodeFrame({ t: 'op', seq: Number.MAX_SAFE_INTEGER, at: T0, record: json(record) }, true)
    expect(Buffer.byteLength(op)).toBeLessThan(MAX_FRAME)
    expect(parseRelayFrame(op, true)).toMatchObject({ t: 'op' })
    expect(parseClientFrame(encodeFrame({ t: 'append', req: Number.MAX_SAFE_INTEGER, record: json(record) }, true), true)).toMatchObject({ t: 'append' })
  })
})

describe('the size, before JSON.parse', () => {
  it('is 24 MiB after the login and 64 KiB before', () => {
    expect(MAX_FRAME).toBe(24 * 1024 * 1024)
    expect(PRE_LOGIN_MAX).toBe(64 * 1024)
    expect(frameLimit(true)).toBe(MAX_FRAME)
    expect(frameLimit(false)).toBe(PRE_LOGIN_MAX)
  })

  it('refuses a frame one byte over, as text and as bytes, without parsing it', () => {
    // not JSON: the size is what refuses it
    for (const [limit, loggedIn] of [[MAX_FRAME, true], [PRE_LOGIN_MAX, false]] as const) {
      const over = 'x'.repeat(limit + 1)
      expect(() => parseClientFrame(over, loggedIn)).toThrow(/larger than/)
      expect(() => parseRelayFrame(Buffer.from(over), loggedIn)).toThrow(/larger than/)
      expect(() => parseClientFrame('x'.repeat(limit), loggedIn)).toThrow(/not JSON/)
    }
  })

  it('counts UTF-8 bytes, not characters', () => {
    const half = 'é'.repeat(PRE_LOGIN_MAX / 2 + 1)
    expect(half.length).toBeLessThan(PRE_LOGIN_MAX)
    expect(() => parseClientFrame(half, false)).toThrow(/larger than/)
  })

  it('refuses to encode a frame the other side would not read', () => {
    const big: ClientFrame = { t: 'create', genesis: { pad: 'x'.repeat(PRE_LOGIN_MAX) }, grant: 'g' }
    expect(() => encodeFrame(big, false)).toThrow(/larger than/)
    expect(encodeFrame(big, true)).toContain('"t":"create"')
  })
})

describe('the login boundary', () => {
  it('only login, create and join before the login; the relay only its answers to them', () => {
    expect(() => parseClientFrame('{"t":"subscribe","from":1}', false)).toThrow(/after the login/)
    expect(() => parseClientFrame('{"t":"append","req":1,"record":{}}', false)).toThrow(/after the login/)
    expect(() => parseRelayFrame('{"t":"op","seq":1,"at":"2026-10-27T08:00:00.000Z","record":{}}', false)).toThrow(/after the login/)
    expect(() => parseRelayFrame('{"t":"join","join":{}}', false)).toThrow(/after the login/)
    expect(parseRelayFrame('{"t":"created","seq":1,"at":"2026-10-27T08:00:00.000Z"}', false)).toEqual({ t: 'created', seq: 1, at: T0 })
  })
})

describe('strict reading', () => {
  const at = '"at":"2026-10-27T08:00:00.000Z"'
  const refusedClient = [
    'null', '[]', '"keys"', '{}', '{"t":"nope"}', '{"t":"__proto__"}', '{"t":"toString"}', '{"t":1}',
    '{"t":"keys"}', '{"t":"keys","req":1,"extra":1}', '{"t":"keys","req":0}', '{"t":"keys","req":1.5}', '{"t":"keys","req":"1"}',
    '{"t":"subscribe","from":0}', '{"t":"append","req":1,"record":[]}', '{"t":"append","req":1,"record":null}',
    '{"t":"create","genesis":{},"grant":7}', '{"t":"invite_cancel","req":1,"invite_id":"AAAA"}',
    '{"t":"keys","req":1,"__proto__":{}}',
  ]
  const refusedRelay = [
    `{"t":"op","seq":-1,${at},"record":{}}`, '{"t":"op","seq":1,"at":"2026-10-27T08:00:00Z","record":{}}',
    `{"t":"created","seq":2,${at}}`, '{"t":"welcome","member":"x","device":"x","head":{"seq":1,"at":"2026-10-27T08:00:00.000Z"}}',
    '{"t":"keys","req":1,"wrapped":{}}', '{"t":"keys","req":1,"wrapped":[1]}',
    '{"t":"error","req":null,"code":"teapot","message":"m"}', '{"t":"error","code":"internal","message":"m"}',
    '{"t":"invite_closed","invite_id":"AAAAAAAAAAAAAAAAAAAAAA","reason":"gone"}',
  ]

  it.each(refusedClient)('refuses the client frame %s', raw => {
    expect(() => parseClientFrame(raw, true)).toThrow(ProtocolError)
  })
  it.each(refusedRelay)('refuses the relay frame %s', raw => {
    expect(() => parseRelayFrame(raw, true)).toThrow(ProtocolError)
  })

  it('refuses bytes that are not UTF-8 and text that is not JSON', () => {
    expect(() => parseClientFrame(new Uint8Array([0x7b, 0xff, 0x7d]), true)).toThrow(/not UTF-8/)
    expect(() => parseClientFrame('{"t":"keys",', true)).toThrow(/not JSON/)
  })

  it('names every error code and close code of the contract', () => {
    expect(ERROR_CODES).toContain('duplicate_op')
    expect(CLOSE).toEqual({ bad_frame: 4000, unsupported_version: 4001, login_failed: 4003, revoked: 4004, rate_limited: 4008, too_slow: 4009 })
  })
})

describe('the sync path', () => {
  it('names the protocol version and the brain', () => {
    expect(syncPath(BRAIN)).toBe(`/sync/1/${BRAIN}`)
    expect(parseSyncPath(syncPath(BRAIN))).toBe(BRAIN)
  })

  it('refuses another version as an update, and anything else as malformed', () => {
    expect(() => parseSyncPath(`/sync/2/${BRAIN}`)).toThrow(UnsupportedVersionError)
    for (const p of [`/sync/1/${BRAIN.toUpperCase()}`, `/sync/1/${BRAIN}/x`, `/sync/1`, `sync/1/${BRAIN}`, `/i/1/${BRAIN}`, `/sync/1/${BRAIN}?x=1`]) {
      expect(() => parseSyncPath(p)).toThrow(ProtocolError)
    }
    expect(() => syncPath('not-a-uuid')).toThrow(/lowercase UUID/)
  })
})
