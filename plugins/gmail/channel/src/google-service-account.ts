import { createSign } from 'crypto'
import { readFileSync } from 'fs'
import { z } from 'zod'
import { GoogleRefreshToken, type AccessToken, type AccessTokens } from './google-refresh-token'

const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url(),
})
const tokenAnswerSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() })

/** The Gmail scopes a Workspace admin grants a service account for a mailbox it acts as. */
export const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
]

const EARLY_MS = 60_000
const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/**
 * An access token for a Workspace mailbox from a service account with domain-wide delegation: the
 * key file is read at every renewal and the token acts as `subject`. No refresh token, so nothing
 * runs out; the Workspace admin's delegation decides which scopes it gets.
 */
export class GoogleServiceAccount implements AccessTokens {
  private cached: { token: string; until: number } | null = null

  constructor(private readonly options: { keyFile: string; subject: string; scopes?: string[]; now?: () => number }) {}

  async get(): Promise<AccessToken> {
    const now = this.options.now?.() ?? Date.now()
    if (this.cached && now < this.cached.until) return { kind: 'token', token: this.cached.token }
    const key = serviceAccountSchema.parse(JSON.parse(readFileSync(this.options.keyFile, 'utf8')))
    const issued = Math.floor(now / 1000)
    const claims = {
      iss: key.client_email, sub: this.options.subject, aud: key.token_uri,
      scope: (this.options.scopes ?? SERVICE_ACCOUNT_SCOPES).join(' '), iat: issued, exp: issued + 3600,
    }
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
    const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
    let response: Response
    try {
      response = await fetch(key.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return { kind: 'unreachable' }
    }
    // 400/401: the key is withdrawn or the delegation doesn't cover this mailbox or scope.
    if (response.status === 400 || response.status === 401) return { kind: 'revoked' }
    if (!response.ok) return { kind: 'unreachable' }
    const answer = tokenAnswerSchema.safeParse(await response.json().catch(() => null))
    if (!answer.success) return { kind: 'unreachable' }
    this.cached = { token: answer.data.access_token, until: now + answer.data.expires_in * 1000 - EARLY_MS }
    return { kind: 'token', token: answer.data.access_token }
  }

  forget(): void {
    this.cached = null
  }
}

/**
 * The access tokens for a mailbox from its credentials file: a service-account key acts as the
 * mailbox itself; an OAuth Desktop client needs the token file of the sign-in.
 */
export function googleAccessTokens(files: { credentialsFile: string; tokenFile?: string; address: string }): AccessTokens {
  let type: unknown
  try {
    type = (JSON.parse(readFileSync(files.credentialsFile, 'utf8')) as { type?: unknown }).type
  } catch {
    type = undefined
  }
  if (type === 'service_account') return new GoogleServiceAccount({ keyFile: files.credentialsFile, subject: files.address })
  if (!files.tokenFile) throw new Error('GOOGLE_TOKEN_FILE must be set for an OAuth client')
  return new GoogleRefreshToken({ credentialsFile: files.credentialsFile, tokenFile: files.tokenFile })
}
