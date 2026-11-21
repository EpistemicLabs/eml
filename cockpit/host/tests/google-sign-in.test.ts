import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoogleSignIn } from '../src/infrastructure/plugins/google-sign-in.js'

// A Google sign-in with the user's own OAuth client (google-sign-in.ts), against a fake Google.
// Every id and token is a placeholder.

let server: Server
let base: string
let dir: string
let lastTokenRequest: URLSearchParams | null = null
let grantedScope = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-google-sign-in-'))
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/token') { lastTokenRequest = new URLSearchParams(body); return res.end(JSON.stringify({ access_token: 'access-placeholder', refresh_token: 'refresh-placeholder', scope: grantedScope })) }
      if (req.url === '/gmail/v1/users/me/profile') return res.end(JSON.stringify({ emailAddress: 'Me@Work.example' }))
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

const client = () => ({ installed: { client_id: 'client-placeholder', client_secret: 'secret-placeholder', auth_uri: `${base}/auth`, token_uri: `${base}/token` } })
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.readonly']

describe('GoogleSignIn', () => {
  it('takes only a Desktop app client, and keeps it owner-only', async () => {
    const google = new GoogleSignIn({ dir: join(dir, 'a'), gmailApi: base })
    expect(await google.saveClient({ web: { client_id: 'x' } })).toMatchObject({ ok: false })
    expect(await google.saveClient('not json')).toMatchObject({ ok: false })
    expect(await google.saveClient(JSON.stringify(client()))).toEqual({ ok: true })
    expect(statSync(google.clientFile).mode & 0o777).toBe(0o600)
    expect(await google.client()).toMatchObject({ client_id: 'client-placeholder' })
  })

  it('signs in through consent and the pasted address, with PKCE, and keeps the refresh token owner-only', async () => {
    const google = new GoogleSignIn({ dir: join(dir, 'b'), gmailApi: base })
    expect(await google.start(SCOPES)).toMatchObject({ ok: false })
    await google.saveClient(client())
    const started = await google.start(SCOPES)
    if (!started.ok) throw new Error(started.reason)
    const consent = new URL(started.url)
    expect(consent.searchParams.get('access_type')).toBe('offline')
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256')
    expect(consent.searchParams.get('scope')).toBe(SCOPES.join(' '))
    grantedScope = SCOPES.join(' ')
    const finished = await google.finish(`http://127.0.0.1:53682/?state=${consent.searchParams.get('state')}&code=code-placeholder&scope=x`)
    if (!finished.ok) throw new Error(finished.reason)
    expect(finished.signedIn.address).toBe('Me@Work.example')
    expect(lastTokenRequest?.get('code_verifier')).toBeTruthy()
    expect(JSON.parse(readFileSync(finished.signedIn.tokenFile, 'utf8'))).toEqual({ refresh_token: 'refresh-placeholder' })
    expect(statSync(finished.signedIn.tokenFile).mode & 0o777).toBe(0o600)
    // The same address again belongs to no sign-in started here.
    expect(await google.finish(`http://127.0.0.1:53682/?state=${consent.searchParams.get('state')}&code=code-placeholder`)).toMatchObject({ ok: false })
  })

  it('refuses a sign-in that lacks a scope, an error from Google, and a pasted text that is no address', async () => {
    const google = new GoogleSignIn({ dir: join(dir, 'c'), gmailApi: base })
    await google.saveClient(client())
    const started = await google.start(SCOPES)
    if (!started.ok) throw new Error(started.reason)
    grantedScope = SCOPES[0]
    const state = new URL(started.url).searchParams.get('state')
    expect(await google.finish(`http://127.0.0.1:53682/?state=${state}&code=c`)).toMatchObject({ ok: false, reason: expect.stringContaining('calendar.readonly') })
    expect(await google.finish('http://127.0.0.1:53682/?error=access_denied')).toMatchObject({ ok: false, reason: 'Google said: access_denied' })
    expect(await google.finish('the code was 1234')).toMatchObject({ ok: false })
  })
})
