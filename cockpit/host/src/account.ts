import * as fs from 'node:fs'
import type * as http from 'node:http'
import { ACCOUNT_FILE, ACCOUNT_URL } from './paths.js'

/**
 * The EML account (Settings › Account): the cockpit host signs in with the
 * account service by email and a mailed code, keeps the session in
 * <home>/account (0600, host only — the browser never sees it) and asks the
 * service for the account, its team brains and, for the membership flow, a
 * creation grant. One home = one human = at most one account; nothing here
 * reads a main or a token of the brain.
 *
 * The four UI routes are write-gated by the host's Origin check like every
 * other /api route; none is a token endpoint a session could reach, and no
 * path to the account file goes into a session's env or files. Logged: that
 * a sign-in or sign-out happened — never the email, a code or the session.
 */

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

/** The file: which service the session was made against, whose it is, and the session itself. */
export interface AccountFile {
  url: string
  email: string
  session: string
}

export interface AccountBrain {
  brain: string
  created_at: string
  members: number
}

/** What GET /api/account answers. */
export type AccountStatus =
  | { signedIn: false, url: string }
  | {
    signedIn: true
    url: string
    email: string
    /** 'ok' when the service answered; 'unavailable' when it could not be reached and the rest is what the file knows. */
    service: 'ok' | 'unavailable'
    account: string | null
    beta: boolean
    brains: AccountBrain[] | null
  }

/** A grant from POST /v1/grants, as the membership flow hands it to the brain server's create. */
export interface CreationGrant {
  brain: string
  grant: string
  relay: string
  expires_at: string
}

/** What the service refused or could not do, with the status the UI gets. */
export class AccountApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const TIMEOUT_MS = 10_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// --- the file ---

export function readAccountFile(): AccountFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')) as Partial<AccountFile>
    if (typeof parsed.url !== 'string' || typeof parsed.email !== 'string' || typeof parsed.session !== 'string') return null
    return { url: parsed.url, email: parsed.email, session: parsed.session }
  } catch {
    return null
  }
}

/**
 * Writes the file whole: into a temporary file next to it, owner-only from
 * the first byte, then renamed over the old one — so a session is never
 * readable through an older file's wider bits, and a crash leaves the old
 * file or the new one, never a torn one (the team file's pattern).
 */
function writeAccountFile(file: AccountFile): void {
  const tmp = `${ACCOUNT_FILE}.tmp`
  fs.rmSync(tmp, { force: true })  // a leftover (a crash, or made with wider bits) would keep its mode
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(file, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, ACCOUNT_FILE)
}

function clearAccountFile(): void {
  fs.rmSync(ACCOUNT_FILE, { force: true })
}

// --- the service ---

interface ServiceReply { status: number, body: Record<string, unknown> }

/** One call to the service; a network failure or timeout is 'unavailable'. */
async function call(url: string, path: string, init: { method: string, body?: unknown, session?: string }): Promise<ServiceReply> {
  let res: Response
  try {
    res = await fetch(url + path, {
      method: init.method,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.session ? { authorization: `Bearer ${init.session}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AccountApiError(503, 'ACCOUNT_UNAVAILABLE', 'The account service cannot be reached right now.')
  }
  if (res.status === 204) return { status: 204, body: {} }
  let body: unknown = {}
  try { body = await res.json() } catch { /* no JSON body */ }
  return { status: res.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {} }
}

function brainList(value: unknown): AccountBrain[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((b: unknown) => {
    if (!b || typeof b !== 'object') return []
    const { brain, created_at, members } = b as Record<string, unknown>
    return typeof brain === 'string' && UUID.test(brain) && typeof created_at === 'string' && Number.isInteger(members)
      ? [{ brain, created_at, members: members as number }]
      : []
  })
}

/** The email a sign-in was started for, until its code is verified; in memory only. */
let pending: string | null = null

/** Starts a sign-in: the service mails a code (or, for an unknown email, does nothing — it answers the same). */
export async function startSignIn(email: unknown): Promise<void> {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!EMAIL.test(normalized)) throw new AccountApiError(400, 'INVALID_INPUT', 'That does not look like an email address.')
  const reply = await call(ACCOUNT_URL, '/v1/signin', { method: 'POST', body: { email: normalized } })
  if (reply.status !== 202) throw new AccountApiError(502, 'ACCOUNT_ERROR', `The account service answered ${reply.status}.`)
  pending = normalized
}

/** Finishes the sign-in with the mailed code: the session goes into the file. */
export async function finishSignIn(code: unknown): Promise<AccountStatus> {
  if (!pending) throw new AccountApiError(409, 'NO_SIGNIN_PENDING', 'Enter your email first.')
  const text = typeof code === 'string' ? code.replace(/\s+/g, '') : ''
  if (!/^\d{6}$/.test(text)) throw new AccountApiError(400, 'INVALID_INPUT', 'The code is 6 digits.')
  const reply = await call(ACCOUNT_URL, '/v1/signin/verify', { method: 'POST', body: { email: pending, code: text } })
  if (reply.status === 401) throw new AccountApiError(400, 'CODE_INVALID', 'That code is not valid. Check it, or ask for a new one.')
  if (reply.status !== 200 || typeof reply.body.session !== 'string') throw new AccountApiError(502, 'ACCOUNT_ERROR', `The account service answered ${reply.status}.`)
  writeAccountFile({ url: ACCOUNT_URL, email: pending, session: reply.body.session })
  pending = null
  console.log('account: signed in')
  return accountStatus()
}

/** The account as the service sees it; a session the service no longer knows is dropped from the file. */
export async function accountStatus(): Promise<AccountStatus> {
  const file = readAccountFile()
  if (!file) return { signedIn: false, url: ACCOUNT_URL }
  let reply: ServiceReply
  try {
    reply = await call(file.url, '/v1/me', { method: 'GET', session: file.session })
  } catch {
    return { signedIn: true, url: file.url, email: file.email, service: 'unavailable', account: null, beta: false, brains: null }
  }
  if (reply.status === 401) {
    clearAccountFile()
    console.log('account: the session is no longer valid, signed out')
    return { signedIn: false, url: ACCOUNT_URL }
  }
  if (reply.status !== 200) {
    return { signedIn: true, url: file.url, email: file.email, service: 'unavailable', account: null, beta: false, brains: null }
  }
  const { account, email, beta, brains } = reply.body
  return {
    signedIn: true,
    url: file.url,
    email: typeof email === 'string' ? email : file.email,
    service: 'ok',
    account: typeof account === 'string' ? account : null,
    beta: beta === true,
    brains: brainList(brains),
  }
}

/** Ends the session on the service and drops the file, whether or not the service answered. */
export async function signOut(): Promise<{ revoked: boolean }> {
  const file = readAccountFile()
  pending = null
  if (!file) return { revoked: false }
  let revoked = false
  try {
    const reply = await call(file.url, '/v1/signout', { method: 'POST', session: file.session })
    revoked = reply.status === 204 || reply.status === 401
  } catch { /* the service is not reachable: the file goes anyway */ }
  clearAccountFile()
  console.log('account: signed out')
  return { revoked }
}

/**
 * A creation grant for a new team brain — the membership flow hands it, with
 * the brain id and the relay URL, to the brain server's create. 403 without
 * the beta entitlement, 409 at the cap, as the service says.
 */
export async function requestGrant(): Promise<CreationGrant> {
  const file = readAccountFile()
  if (!file) throw new AccountApiError(401, 'NOT_SIGNED_IN', 'Sign in to your EML account first.')
  const reply = await call(file.url, '/v1/grants', { method: 'POST', session: file.session })
  if (reply.status === 401) { clearAccountFile(); throw new AccountApiError(401, 'NOT_SIGNED_IN', 'Your account session has ended. Sign in again.') }
  if (reply.status === 403) throw new AccountApiError(403, 'NO_BETA', 'Your account is not in the team-brain beta.')
  if (reply.status === 409) throw new AccountApiError(409, 'BRAIN_CAP', 'Your account has reached its number of team brains.')
  if (reply.status === 503) throw new AccountApiError(503, 'ACCOUNT_UNAVAILABLE', 'The account service cannot read the relay right now.')
  const { brain, grant, relay, expires_at } = reply.body
  if (reply.status !== 200 || typeof brain !== 'string' || !UUID.test(brain) || typeof grant !== 'string' || typeof relay !== 'string' || typeof expires_at !== 'string') {
    throw new AccountApiError(502, 'ACCOUNT_ERROR', `The account service answered ${reply.status}.`)
  }
  return { brain, grant, relay, expires_at }
}

/** The /api/account routes; false when the request is not one of them. */
export async function handleAccountApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string, json: Json, readJson: ReadJson): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'account', action?]
  if (parts[1] !== 'account' || parts.length > 3) return false
  const action = parts[2]
  try {
    if (!action && method === 'GET') { json(res, 200, await accountStatus()); return true }
    if (action === 'signin' && method === 'POST') {
      await startSignIn((await readJson(req)).email)
      json(res, 202, { ok: true })
      return true
    }
    if (action === 'code' && method === 'POST') { json(res, 200, await finishSignIn((await readJson(req)).code)); return true }
    if (action === 'signout' && method === 'POST') { json(res, 200, { ...(await signOut()), ...(await accountStatus()) }); return true }
    return false
  } catch (err) {
    if (err instanceof AccountApiError) json(res, err.status, { error: { code: err.code, message: err.message } })
    else json(res, 500, { error: { code: 'ACCOUNT_FAILED', message: (err as Error).message } })
    return true
  }
}
