import { readFileSync } from 'fs'
import { z } from 'zod'

const credentialsSchema = z.object({
  installed: z.object({ client_id: z.string(), client_secret: z.string(), token_uri: z.string().url() }),
})
const tokenFileSchema = z.object({ refresh_token: z.string().min(1) })
const tokenAnswerSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() })

export type AccessToken = { kind: 'token'; token: string } | { kind: 'revoked' } | { kind: 'unreachable' }

export interface AccessTokens {
  get(): Promise<AccessToken>
  /** The token was refused; the next get asks for a new one. */
  forget(): void
}

const EARLY_MS = 60_000

/**
 * An access token from an existing Google sign-in: an OAuth "Desktop app" client file and the token
 * file its owner keeps up to date. Both are only read, at every refresh, so the owner's own renewals
 * are picked up; the access token lives in memory only.
 */
export class GoogleRefreshToken implements AccessTokens {
  private cached: { token: string; until: number } | null = null

  constructor(private readonly files: { credentialsFile: string; tokenFile: string }) {}

  async get(): Promise<AccessToken> {
    if (this.cached && Date.now() < this.cached.until) return { kind: 'token', token: this.cached.token }
    const client = credentialsSchema.parse(JSON.parse(readFileSync(this.files.credentialsFile, 'utf8'))).installed
    const { refresh_token } = tokenFileSchema.parse(JSON.parse(readFileSync(this.files.tokenFile, 'utf8')))
    let response: Response
    try {
      response = await fetch(client.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token, client_id: client.client_id, client_secret: client.client_secret,
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return { kind: 'unreachable' }
    }
    if (response.status === 400 || response.status === 401) return { kind: 'revoked' }
    if (!response.ok) return { kind: 'unreachable' }
    const answer = tokenAnswerSchema.safeParse(await response.json().catch(() => null))
    if (!answer.success) return { kind: 'unreachable' }
    this.cached = { token: answer.data.access_token, until: Date.now() + answer.data.expires_in * 1000 - EARLY_MS }
    return { kind: 'token', token: answer.data.access_token }
  }

  forget(): void {
    this.cached = null
  }
}
