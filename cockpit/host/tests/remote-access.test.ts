import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { describe, it, expect } from 'vitest'
import { readRemoteAccess, requestGate, type RemoteAccess } from '../src/remote-access.js'
import { parseTailscaleStatus, proxiesTo } from '../src/remote.js'

// Remote access through tailscale serve (remote-access.ts): who may reach the
// cockpit, and from which origins its page may write.

const LOCAL = ['http://127.0.0.1:4317', 'http://localhost:4317']
const ORIGIN = 'https://box.tailnet-1234.ts.net'
const ON: RemoteAccess = { origins: [ORIGIN], users: ['jane@example.com'] }

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
const viaServe = (extra: Record<string, string> = {}) =>
  req({ host: 'box.tailnet-1234.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'jane@example.com', ...extra })

describe('request gate', () => {
  it('lets this machine in with the local origins, whatever the loopback port', () => {
    expect(requestGate(req({ host: '127.0.0.1:4317' }), LOCAL, ON)).toEqual({ allowed: true, origins: LOCAL })
    expect(requestGate(req({ host: 'localhost:4319' }), LOCAL, ON)).toEqual({ allowed: true, origins: LOCAL })
    expect(requestGate(req({ host: '[::1]:4317' }), LOCAL, ON)).toEqual({ allowed: true, origins: LOCAL })
  })

  it('refuses a foreign Host (a DNS-rebinding page)', () => {
    expect(requestGate(req({ host: 'evil.example:4317' }), LOCAL, ON)).toEqual({ allowed: false })
  })

  it('refuses every remote request while remote access is off', () => {
    expect(requestGate(viaServe(), LOCAL, { origins: [], users: [] })).toEqual({ allowed: false })
  })

  it('lets a listed tailnet user in on the enabled host, writing only from the remote origins', () => {
    expect(requestGate(viaServe(), LOCAL, ON)).toEqual({ allowed: true, origins: [ORIGIN] })
  })

  it('compares logins without case and lets every tailnet user in when the list is empty', () => {
    expect(requestGate(viaServe({ 'tailscale-user-login': 'Jane@Example.com' }), LOCAL, ON).allowed).toBe(true)
    expect(requestGate(viaServe({ 'tailscale-user-login': 'joe@example.com' }), LOCAL, { origins: [ORIGIN], users: [] }).allowed).toBe(true)
  })

  it('refuses a tailnet user not in the list', () => {
    expect(requestGate(viaServe({ 'tailscale-user-login': 'joe@example.com' }), LOCAL, ON)).toEqual({ allowed: false })
  })

  it('refuses a request without a tailnet user, and any Funnel request from the internet', () => {
    expect(requestGate(viaServe({ 'tailscale-user-login': '' }), LOCAL, { origins: [ORIGIN], users: [] })).toEqual({ allowed: false })
    expect(requestGate(viaServe({ 'tailscale-funnel-request': '?1' }), LOCAL, { origins: [ORIGIN], users: [] })).toEqual({ allowed: false })
  })

  it('refuses a host other than the enabled one, and a proxied request on a loopback Host', () => {
    expect(requestGate(viaServe({ host: 'other.tailnet-1234.ts.net' }), LOCAL, ON)).toEqual({ allowed: false })
    expect(requestGate(viaServe({ host: '127.0.0.1:4317' }), LOCAL, ON)).toEqual({ allowed: false })
  })
})

describe('remote.json', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')), 'remote.json')

  it('reads nothing as off', () => {
    expect(readRemoteAccess(file)).toEqual({ origins: [], users: [] })
  })

  it('keeps only https origins, lowercase and without a path; logins lowercase', () => {
    fs.writeFileSync(file, JSON.stringify({
      origins: ['HTTPS://Box.Tailnet-1234.ts.net/', 'http://box.tailnet-1234.ts.net', 'https://x.ts.net/path', 7],
      users: ['Jane@Example.com', '', 'jane@example.com'],
    }))
    expect(readRemoteAccess(file)).toEqual({ origins: [ORIGIN], users: ['jane@example.com'] })
  })

  it('reads a broken file as off', () => {
    fs.writeFileSync(file, '{ not json')
    expect(readRemoteAccess(file)).toEqual({ origins: [], users: [] })
  })
})

describe('tailscale status', () => {
  const status = (over: Record<string, unknown> = {}) => JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'Box.tailnet-1234.ts.net.', UserID: 42 },
    User: { 42: { LoginName: 'Jane@Example.com' } },
    CertDomains: ['box.tailnet-1234.ts.net'],
    ...over,
  })

  it('names the machine and its user', () => {
    expect(parseTailscaleStatus(status())).toEqual({
      dnsName: 'box.tailnet-1234.ts.net',
      login: 'jane@example.com',
      certDomains: ['box.tailnet-1234.ts.net'],
    })
  })

  it('says so when tailscale is not connected', () => {
    expect(() => parseTailscaleStatus(status({ BackendState: 'NeedsLogin' }))).toThrow(/not connected/)
  })
})

describe('tailscale serve status', () => {
  const serving = JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { 'box.tailnet-1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } } } },
  })

  it('finds a proxy to the cockpit on the https port', () => {
    expect(proxiesTo(serving, 443, 'http://127.0.0.1:4317')).toBe(true)
  })

  it('does not take another port or target for it', () => {
    expect(proxiesTo(serving, 8443, 'http://127.0.0.1:4317')).toBe(false)
    expect(proxiesTo(serving, 443, 'http://127.0.0.1:4318')).toBe(false)
    expect(proxiesTo('{}', 443, 'http://127.0.0.1:4317')).toBe(false)
  })
})
