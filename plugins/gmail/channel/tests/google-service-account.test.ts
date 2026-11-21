import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createVerify, generateKeyPairSync } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GoogleRefreshToken } from '../src/google-refresh-token'
import { GoogleServiceAccount, googleAccessTokens } from '../src/google-service-account'

// A Workspace service account acting as a mailbox, against a local fake of Google's token endpoint.
// The key is generated for the test; every address is a placeholder.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
let server: Server
let dir: string
let keyFile: string
let status = 200
const assertions: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gmail-sa-test-'))
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      assertions.push(new URLSearchParams(body).get('assertion') ?? '')
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { access_token: 'access-1', expires_in: 3600 } : { error: 'unauthorized_client' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  keyFile = join(dir, 'service-account.json')
  writeFileSync(keyFile, JSON.stringify({
    type: 'service_account', client_email: 'robot@project.example', token_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }))
})
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

describe('GoogleServiceAccount', () => {
  it('signs a JWT that acts as the mailbox with the Gmail scopes, and keeps the token until it nears its end', async () => {
    assertions.length = 0
    let now = Date.parse('2026-11-21T10:00:00Z')
    const tokens = new GoogleServiceAccount({ keyFile, subject: 'me@work.example', now: () => now })
    expect(await tokens.get()).toEqual({ kind: 'token', token: 'access-1' })
    const [head, claims, signature] = assertions[0].split('.')
    expect(createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))
    expect(decoded).toMatchObject({ iss: 'robot@project.example', sub: 'me@work.example', iat: now / 1000, exp: now / 1000 + 3600 })
    expect(decoded.scope.split(' ')).toContain('https://www.googleapis.com/auth/gmail.modify')
    await tokens.get()
    expect(assertions).toHaveLength(1)
    now += 3600_000
    await tokens.get()
    expect(assertions).toHaveLength(2)
  })

  it('counts a refused delegation as revoked and an unreachable endpoint as unreachable', async () => {
    status = 401
    try {
      expect(await new GoogleServiceAccount({ keyFile, subject: 'other@work.example' }).get()).toEqual({ kind: 'revoked' })
    } finally {
      status = 200
    }
    const away = join(dir, 'away.json')
    writeFileSync(away, JSON.stringify({ type: 'service_account', client_email: 'r@p.example', token_uri: 'http://127.0.0.1:1/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }))
    expect(await new GoogleServiceAccount({ keyFile: away, subject: 'me@work.example' }).get()).toEqual({ kind: 'unreachable' })
  })
})

describe('googleAccessTokens', () => {
  it('uses a service-account key as the mailbox, and an OAuth client with its token file', () => {
    expect(googleAccessTokens({ credentialsFile: keyFile, address: 'me@work.example' })).toBeInstanceOf(GoogleServiceAccount)
    const client = join(dir, 'client.json')
    writeFileSync(client, JSON.stringify({ installed: { client_id: 'id', client_secret: 'placeholder', token_uri: 'https://oauth2.example/token' } }))
    expect(googleAccessTokens({ credentialsFile: client, tokenFile: join(dir, 't.json'), address: 'me@work.example' })).toBeInstanceOf(GoogleRefreshToken)
    expect(() => googleAccessTokens({ credentialsFile: client, address: 'me@work.example' })).toThrow('GOOGLE_TOKEN_FILE')
  })
})
