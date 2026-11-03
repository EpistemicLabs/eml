import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home and the account URL at import time — set them before loading the module.
const home = mkdtempSync(join(tmpdir(), 'cockpit-account-test-'))
process.env.EML_COCKPIT_HOME = home
process.env.EML_ACCOUNT_URL = 'http://account.test/'

import { expectOwnerOnly } from './helpers/owner-only.js'

type Mod = typeof import('../src/account.js')

// Settings › Account's host side against a fake account service: the file
// (0600, url + email + session), the sign-in by code, the status with the
// session dropped when the service no longer knows it, sign-out with and
// without the service, and the grant for the membership flow.
describe('account', () => {
  let mod: Mod
  const file = join(home, 'account')
  /** What the fake service got, and what it answers next. */
  const calls: Array<{ path: string, method: string, auth?: string, body?: unknown }> = []
  let answers: Record<string, { status: number, body?: unknown }> = {}
  let down = false

  beforeAll(async () => {
    mod = await import('../src/account.js')
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string, body?: string, headers?: Record<string, string> }) => {
      if (down) throw new TypeError('fetch failed')
      const path = new URL(url).pathname
      calls.push({ path, method: init?.method ?? 'GET', auth: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : undefined })
      const answer = answers[path] ?? { status: 404, body: { error: 'not_found' } }
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
    })
  })
  afterAll(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }) })
  beforeEach(async () => { calls.length = 0; answers = {}; down = false; await mod.signOut().catch(() => {}); calls.length = 0 })

  const me = { account: '7d1e4b2a-3c5f-4e6d-8a9b-0c1d2e3f4a5b', email: 'dominik@example.com', beta: true, brains: [{ brain: '0f7c2b8e-4d3a-4c1b-9a6e-2b5d8f1e3c7a', created_at: '2026-11-01T00:00:00.000Z', members: 2 }] }
  async function signedIn() {
    answers['/v1/signin'] = { status: 202, body: {} }
    answers['/v1/signin/verify'] = { status: 200, body: { session: 'emla_' + 'A'.repeat(43) } }
    answers['/v1/me'] = { status: 200, body: me }
    await mod.startSignIn(' Dominik@Example.com ')
    return mod.finishSignIn('123 456')
  }
  const refused = async (run: () => Promise<unknown>, status: number, code: string) => {
    let error: unknown
    try { await run() } catch (e) { error = e }
    expect(error).toBeInstanceOf(mod.AccountApiError)
    expect([(error as InstanceType<Mod['AccountApiError']>).status, (error as InstanceType<Mod['AccountApiError']>).code]).toEqual([status, code])
  }

  it('is signed out without a file, against the configured service', async () => {
    expect(await mod.accountStatus()).toEqual({ signedIn: false, url: 'http://account.test' })
    expect(calls).toEqual([])
  })

  it('signs in: email → code → the file with the session, then the status from the service', async () => {
    const status = await signedIn()
    expect(calls.map(c => [c.method, c.path])).toEqual([['POST', '/v1/signin'], ['POST', '/v1/signin/verify'], ['GET', '/v1/me']])
    expect(calls[0].body).toEqual({ email: 'dominik@example.com' })
    expect(calls[1].body).toEqual({ email: 'dominik@example.com', code: '123456' })
    expect(calls[2].auth).toBe('Bearer emla_' + 'A'.repeat(43))
    expectOwnerOnly(file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://account.test', email: 'dominik@example.com', session: 'emla_' + 'A'.repeat(43) })
    expect(status).toEqual({ signedIn: true, url: 'http://account.test', email: 'dominik@example.com', service: 'ok', account: me.account, beta: true, brains: me.brains })
  })

  it('refuses a bad email, a code without a pending sign-in, a malformed code and a wrong code', async () => {
    await refused(() => mod.startSignIn('nobody'), 400, 'INVALID_INPUT')
    await refused(() => mod.finishSignIn('123456'), 409, 'NO_SIGNIN_PENDING')
    answers['/v1/signin'] = { status: 202, body: {} }
    await mod.startSignIn('dominik@example.com')
    await refused(() => mod.finishSignIn('12'), 400, 'INVALID_INPUT')
    answers['/v1/signin/verify'] = { status: 401, body: { error: 'code_invalid' } }
    await refused(() => mod.finishSignIn('000000'), 400, 'CODE_INVALID')
    expect(existsSync(file)).toBe(false)
  })

  it('drops the file when the service no longer knows the session', async () => {
    await signedIn()
    answers['/v1/me'] = { status: 401, body: { error: 'unauthorized' } }
    expect(await mod.accountStatus()).toEqual({ signedIn: false, url: 'http://account.test' })
    expect(existsSync(file)).toBe(false)
  })

  it('stays signed in with the service unavailable, from what the file knows', async () => {
    await signedIn()
    down = true
    expect(await mod.accountStatus()).toEqual({ signedIn: true, url: 'http://account.test', email: 'dominik@example.com', service: 'unavailable', account: null, beta: false, brains: null })
    down = false
    answers['/v1/me'] = { status: 503, body: { error: 'relay_unavailable' } }
    expect((await mod.accountStatus()).signedIn && (await mod.accountStatus()).service).toBe('unavailable')
    expect(existsSync(file)).toBe(true)
  })

  it('uses the url the file names, not the configured one', async () => {
    writeFileSync(file, JSON.stringify({ url: 'http://other.test', email: 'x@y.zz', session: 'emla_x' }), { mode: 0o600 })
    answers['/v1/me'] = { status: 200, body: { ...me, email: 'x@y.zz', brains: [] } }
    const status = await mod.accountStatus()
    expect(status.signedIn && status.url).toBe('http://other.test')
    expect(calls[0]).toMatchObject({ path: '/v1/me', auth: 'Bearer emla_x' })
  })

  it('signs out on the service and drops the file — also when the service is down', async () => {
    await signedIn()
    answers['/v1/signout'] = { status: 204 }
    expect(await mod.signOut()).toEqual({ revoked: true })
    expect(existsSync(file)).toBe(false)
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/signout', auth: 'Bearer emla_' + 'A'.repeat(43) })
    await signedIn()
    down = true
    expect(await mod.signOut()).toEqual({ revoked: false })
    expect(existsSync(file)).toBe(false)
  })

  it('asks for a creation grant and maps what the service refuses', async () => {
    await refused(() => mod.requestGrant(), 401, 'NOT_SIGNED_IN')
    await signedIn()
    const grant = { brain: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', grant: 'eml-grant-1.x.y', relay: 'wss://relay.test', expires_at: '2026-11-03T12:05:00.000Z' }
    answers['/v1/grants'] = { status: 200, body: grant }
    expect(await mod.requestGrant()).toEqual(grant)
    answers['/v1/grants'] = { status: 403, body: { error: 'no_beta' } }
    await refused(() => mod.requestGrant(), 403, 'NO_BETA')
    answers['/v1/grants'] = { status: 409, body: { error: 'cap' } }
    await refused(() => mod.requestGrant(), 409, 'BRAIN_CAP')
    answers['/v1/grants'] = { status: 503, body: { error: 'relay_unavailable' } }
    await refused(() => mod.requestGrant(), 503, 'ACCOUNT_UNAVAILABLE')
    answers['/v1/grants'] = { status: 200, body: { brain: 'nope' } }
    await refused(() => mod.requestGrant(), 502, 'ACCOUNT_ERROR')
    answers['/v1/grants'] = { status: 401, body: { error: 'unauthorized' } }
    await refused(() => mod.requestGrant(), 401, 'NOT_SIGNED_IN')
    expect(existsSync(file)).toBe(false)
  })

  it('serves the four routes and nothing else', async () => {
    const sent: Array<{ status: number, payload: unknown }> = []
    const json = (_res: unknown, status: number, payload: unknown) => { sent.push({ status, payload }) }
    const route = (path: string, method: string, body: Record<string, unknown> = {}) =>
      mod.handleAccountApi({} as never, {} as never, new URL(`http://localhost${path}`), method, json, async () => body)
    expect(await route('/api/account/other', 'GET')).toBe(false)
    expect(await route('/api/account', 'DELETE')).toBe(false)
    expect(await route('/api/accounts', 'GET')).toBe(false)
    answers['/v1/signin'] = { status: 202, body: {} }
    answers['/v1/signin/verify'] = { status: 200, body: { session: 'emla_s' } }
    answers['/v1/me'] = { status: 200, body: me }
    answers['/v1/signout'] = { status: 204 }
    expect(await route('/api/account', 'GET')).toBe(true)
    expect(await route('/api/account/signin', 'POST', { email: 'dominik@example.com' })).toBe(true)
    expect(await route('/api/account/code', 'POST', { code: 'abc' })).toBe(true)
    expect(await route('/api/account/code', 'POST', { code: '123456' })).toBe(true)
    expect(await route('/api/account/signout', 'POST')).toBe(true)
    expect(sent.map(s => s.status)).toEqual([200, 202, 400, 200, 200])
    expect(sent[0].payload).toEqual({ signedIn: false, url: 'http://account.test' })
    expect(sent[2].payload).toEqual({ error: { code: 'INVALID_INPUT', message: 'The code is 6 digits.' } })
    expect((sent[3].payload as { signedIn: boolean }).signedIn).toBe(true)
    expect(sent[4].payload).toMatchObject({ revoked: true, signedIn: false })
  })
})
