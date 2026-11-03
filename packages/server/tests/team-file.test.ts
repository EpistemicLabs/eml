import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newBrainKey, newDeviceKeys, newSigningKey, ready } from '@engramprotocol/protocol'
import { TeamFileError, isRelayOrigin, readTeamFile, removeTeamFile, teamFilePath, writeTeamFile, type TeamFile } from '../src/sync/team-file'
import { BRAIN, OTHER } from './team'

// v0.21 (spec team-brain-sync-client-spec §4): what this device keeps for a
// shared brain, owner-only and whole; a file that cannot be used says why
// with a fixed reason and never with what it holds.

beforeAll(async () => { await ready() })

describe('the team file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-team-file-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const file = (extra: Partial<TeamFile> = {}): TeamFile => ({ v: 1, brain: BRAIN, relay: 'wss://relay.test', device: newDeviceKeys(), ...extra })
  const mode = () => statSync(teamFilePath(dir, BRAIN)).mode & 0o777

  it('round-trips, owner-only, named by the team brain', () => {
    const device = newDeviceKeys()
    expect(readTeamFile(dir, BRAIN)).toBeNull()
    writeTeamFile(dir, file({ device }))
    const back = readTeamFile(dir, BRAIN)
    expect(back?.device.sign.publicKey).toBe(device.sign.publicKey)
    expect(back?.device.enc.publicKey).toBe(device.enc.publicKey)
    expect(back?.identity).toBeUndefined()
    expect(back?.create).toBeUndefined()
    expect(back?.key).toBeUndefined()
    if (process.platform !== 'win32') expect(mode()).toBe(0o600)
  })

  it('keeps the identity, a pending creation and a key this device holds, and drops them when written without', () => {
    const identity = newSigningKey()
    const key = newBrainKey(0)
    const create = { genesis: { v: 1, kind: 'clear', brain: BRAIN }, grant: 'g' }
    writeTeamFile(dir, file({ identity, create, key }))
    const back = readTeamFile(dir, BRAIN)!
    expect(back.identity?.publicKey).toBe(identity.publicKey)
    expect(back.create).toEqual(create)
    expect(back.key?.epoch).toBe(0)
    expect(Buffer.from(back.key!.key)).toEqual(Buffer.from(key.key))
    delete back.create
    delete back.key
    writeTeamFile(dir, back)
    const again = readTeamFile(dir, BRAIN)!
    expect(again.create).toBeUndefined()
    expect(again.key).toBeUndefined()
    expect(again.identity?.publicKey).toBe(identity.publicKey)
  })

  it('is written whole: owner-only again after a file with wider bits, and no temporary file stays', () => {
    if (process.platform === 'win32') return
    writeTeamFile(dir, file())
    chmodSync(teamFilePath(dir, BRAIN), 0o644)
    writeTeamFile(dir, file())
    expect(mode()).toBe(0o600)
    expect(readdirSync(join(dir, 'team'))).toEqual([`${BRAIN}.json`])
  })

  it('is removed with removeTeamFile, also when it is not there', () => {
    writeTeamFile(dir, file())
    removeTeamFile(dir, BRAIN)
    expect(readTeamFile(dir, BRAIN)).toBeNull()
    removeTeamFile(dir, BRAIN)
  })

  describe('that cannot be used says why with a fixed reason', () => {
    const written = (text: string) => {
      mkdirSync(join(dir, 'team'), { recursive: true })
      writeFileSync(teamFilePath(dir, BRAIN), text)
    }
    const reason = (): string => {
      try {
        readTeamFile(dir, BRAIN)
      } catch (err) {
        expect(err).toBeInstanceOf(TeamFileError)
        return (err as Error).message
      }
      throw new Error('expected the file to be refused')
    }
    const good = () => { writeTeamFile(dir, file()); return JSON.parse(readFileSync(teamFilePath(dir, BRAIN), 'utf-8')) as Record<string, unknown> }

    it('not JSON, another version, another brain, a relay that is no origin', () => {
      written('{"v": 1,')
      expect(reason()).toBe('it is not valid JSON')
      written('[]')
      expect(reason()).toBe('it is not valid JSON')
      written(JSON.stringify({ ...good(), v: 2 }))
      expect(reason()).toBe('its version is not 1')
      written(JSON.stringify({ ...good(), brain: OTHER }))
      expect(reason()).toBe('it is for another brain')
      written(JSON.stringify({ ...good(), relay: 'https://relay.test' }))
      expect(reason()).toBe('the relay is not a ws(s):// origin')
      written(JSON.stringify({ ...good(), relay: 'wss://relay.test/path' }))
      expect(reason()).toBe('the relay is not a ws(s):// origin')
    })

    it('a seed that is not one, a creation or key that is malformed', () => {
      const ok = good()
      written(JSON.stringify({ ...ok, device: { ...(ok.device as object), sign_seed: 'AAAA' } }))
      expect(reason()).toBe('a seed is malformed')
      written(JSON.stringify({ ...ok, device: { ...(ok.device as object), enc_seed: 42 } }))
      expect(reason()).toBe('a seed is malformed')
      written(JSON.stringify({ ...ok, identity: { seed: 'x' } }))
      expect(reason()).toBe('a seed is malformed')
      written(JSON.stringify({ ...ok, identity: 'x' }))
      expect(reason()).toBe('a section is malformed')
      written(JSON.stringify({ ...ok, create: { genesis: 'x', grant: 'g' } }))
      expect(reason()).toBe('its creation is malformed')
      written(JSON.stringify({ ...ok, key: { epoch: -1, key: 'x' } }))
      expect(reason()).toBe('its key is malformed')
    })

    it('a file cut off in the middle of a seed: nothing of the seed is in the reason', () => {
      const device = newDeviceKeys()
      writeTeamFile(dir, file({ device }))
      const text = readFileSync(teamFilePath(dir, BRAIN), 'utf-8')
      const seed = Buffer.from(device.sign.seed).toString('base64url')
      const cut = text.slice(0, text.indexOf(seed) + 20)
      written(cut)
      const why = reason()
      expect(why).toBe('it is not valid JSON')
      for (let i = 0; i + 8 <= seed.length; i++) expect(why).not.toContain(seed.slice(i, i + 8))
    })
  })

  it('knows a relay origin: scheme and host, no path, no credentials', () => {
    expect(isRelayOrigin('wss://relay.engramprotocol.com')).toBe(true)
    expect(isRelayOrigin('ws://127.0.0.1:4321')).toBe(true)
    expect(isRelayOrigin('wss://relay.test/')).toBe(false)
    expect(isRelayOrigin('wss://relay.test/sync')).toBe(false)
    expect(isRelayOrigin('wss://relay.test?x=1')).toBe(false)
    expect(isRelayOrigin('wss://user:pw@relay.test')).toBe(false)
    expect(isRelayOrigin('https://relay.test')).toBe(false)
    expect(isRelayOrigin('relay.test')).toBe(false)
  })
})
