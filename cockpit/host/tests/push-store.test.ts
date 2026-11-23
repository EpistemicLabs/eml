import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushStore } from '../src/push-store.js'

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'push-store-')), 'push.json')
const device = (endpoint: string) => ({ endpoint, p256dh: 'p256dh-key', auth: 'auth-secret', origin: 'https://cockpit.example', label: 'iPhone' })

describe('PushStore', () => {
  it('makes the server key pair once and keeps it, owner-only', () => {
    const file = fileIn()
    let made = 0
    const generate = () => ({ publicKey: `public-${++made}`, privateKey: `private-${made}` })
    const first = new PushStore(file, generate).vapid()
    expect(new PushStore(file, generate).vapid()).toEqual(first)
    expect(made).toBe(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps one entry per endpoint: subscribing again updates it', () => {
    const store = new PushStore(fileIn())
    const first = store.subscribe(device('https://push.example/a'))
    const again = store.subscribe({ ...device('https://push.example/a'), auth: 'new-secret' })
    expect(again.id).toBe(first.id)
    expect(store.devices()).toHaveLength(1)
    expect(store.devices()[0].auth).toBe('new-secret')
  })

  it('removes a device by endpoint and survives a restart', () => {
    const file = fileIn()
    const store = new PushStore(file)
    store.subscribe(device('https://push.example/a'))
    store.subscribe(device('https://push.example/b'))
    expect(store.unsubscribe('https://push.example/a')).toBe(true)
    expect(store.unsubscribe('https://push.example/missing')).toBe(false)
    expect(new PushStore(file).devices().map((entry) => entry.endpoint)).toEqual(['https://push.example/b'])
  })

  it('moves a file it does not understand aside instead of writing over it', () => {
    const later = fileIn()
    writeFileSync(later, '{"version": 7}')
    const store = new PushStore(later, () => ({ publicKey: 'new-public', privateKey: 'new-private' }))
    expect(store.devices()).toEqual([])
    expect(readFileSync(`${later}.unreadable`, 'utf8')).toBe('{"version": 7}')
    store.vapid()
    expect(JSON.parse(readFileSync(later, 'utf8')).version).toBe(1)

    const garbled = fileIn()
    writeFileSync(garbled, '{not json')
    new PushStore(garbled)
    expect(existsSync(`${garbled}.unreadable`)).toBe(true)
  })

  it('hands out no key and keeps no device it could not write down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-store-'))
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      const store = new PushStore(join(locked, 'push.json'))
      expect(store.vapid()).toBeNull()
      expect(store.subscribe(device('https://push.example/a'))).toBeNull()
      expect(store.devices()).toEqual([])
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  it('ignores fields it does not know', () => {
    const extra = fileIn()
    writeFileSync(extra, JSON.stringify({ version: 1, vapid: null, devices: [{ ...device('https://push.example/a'), id: 'd1', createdAt: '2026-11-09T00:00:00.000Z', later: true }, { endpoint: 42 }] }))
    expect(new PushStore(extra).devices()).toEqual([{ ...device('https://push.example/a'), id: 'd1', createdAt: '2026-11-09T00:00:00.000Z' }])
    expect(JSON.parse(readFileSync(extra, 'utf8')).version).toBe(1)
  })
})
