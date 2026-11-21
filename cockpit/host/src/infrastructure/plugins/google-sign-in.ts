import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

/**
 * Signing in to Google with the user's own OAuth client (decision gmail-plugin-mcp-scope-and-sign-in):
 * an OAuth "Desktop app" client the user made in their Google Cloud project, stored once, owner-only.
 * Its refresh tokens serve the gmail plugin's channel and MCP alike.
 *
 * The consent page sends the browser to a loopback address afterwards. That page doesn't load when the
 * cockpit is used from another device (remote access) and often not even on this one — so the user
 * pastes the address the browser ended on, and the cockpit takes the code from it. No server listens.
 */

const clientFileSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    auth_uri: z.string().url().default('https://accounts.google.com/o/oauth2/v2/auth'),
    token_uri: z.string().url().default('https://oauth2.googleapis.com/token'),
  }),
})
export type GoogleClient = z.infer<typeof clientFileSchema>['installed']

/** The redirect a Desktop client may always use; nothing has to listen there. */
const REDIRECT = 'http://127.0.0.1:53682/'
const PENDING_MS = 15 * 60_000

export interface SignedIn {
  address: string
  credentialsFile: string
  tokenFile: string
}

export class GoogleSignIn {
  private readonly pending = new Map<string, { verifier: string; scopes: string[]; at: number }>()

  constructor(private readonly options: { dir: string; gmailApi?: string; now?: () => number }) {}

  get clientFile(): string {
    return path.join(this.options.dir, 'client.json')
  }

  /** The stored client, or null without one or with one that doesn't read. */
  async client(): Promise<GoogleClient | null> {
    try {
      return clientFileSchema.parse(JSON.parse(await fs.readFile(this.clientFile, 'utf8'))).installed
    } catch {
      return null
    }
  }

  /** Stores the client the user downloaded from Google Cloud; only a Desktop app client will do. */
  async saveClient(raw: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, reason: 'That is not the JSON file Google Cloud gives for an OAuth client' }
      }
    }
    const client = clientFileSchema.safeParse(parsed)
    if (!client.success) return { ok: false, reason: 'Use an OAuth client of type "Desktop app" (its file starts with {"installed": …})' }
    await this.writeOwnerOnly(this.clientFile, `${JSON.stringify({ installed: client.data.installed }, null, 2)}\n`)
    return { ok: true }
  }

  /** The consent page's address for these scopes. */
  async start(scopes: string[]): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
    const client = await this.client()
    if (!client) return { ok: false, reason: 'Add your Google OAuth client first' }
    const now = this.options.now?.() ?? Date.now()
    for (const [key, entry] of this.pending) if (now - entry.at > PENDING_MS) this.pending.delete(key)
    const state = randomBytes(16).toString('hex')
    const verifier = randomBytes(32).toString('base64url')
    this.pending.set(state, { verifier, scopes, at: now })
    const url = new URL(client.auth_uri)
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      // Asked every time, so Google hands out a refresh token also on a second sign-in.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return { ok: true, url: url.toString() }
  }

  /** Takes the code from the address the browser ended on, and keeps the refresh token Google gives for it. */
  async finish(redirected: string): Promise<{ ok: true; signedIn: SignedIn } | { ok: false; reason: string }> {
    let url: URL
    try {
      url = new URL(redirected.trim())
    } catch {
      return { ok: false, reason: 'Paste the whole address from the browser, starting with http://127.0.0.1' }
    }
    if (url.searchParams.get('error')) return { ok: false, reason: `Google said: ${url.searchParams.get('error')}` }
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code')
    const pending = this.pending.get(state)
    if (!pending || !code) return { ok: false, reason: 'This address belongs to no sign-in started here (or it is older than 15 minutes): start again' }
    this.pending.delete(state)
    const client = await this.client()
    if (!client) return { ok: false, reason: 'The Google OAuth client is gone' }
    const tokenAnswer = await fetch(client.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: pending.verifier }),
    }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) as { refresh_token?: string; access_token?: string; scope?: string; error_description?: string } | null }))
      .catch(() => ({ ok: false, body: null }))
    if (!tokenAnswer.ok || !tokenAnswer.body?.refresh_token || !tokenAnswer.body.access_token) {
      return { ok: false, reason: `Google gave no sign-in for it${tokenAnswer.body?.error_description ? `: ${tokenAnswer.body.error_description}` : ''}` }
    }
    const granted = (tokenAnswer.body.scope ?? '').split(' ')
    const missing = pending.scopes.filter((s) => !granted.includes(s))
    if (missing.length > 0) return { ok: false, reason: `The sign-in lacks ${missing.map((s) => s.split('/').pop()).join(', ')}: tick every box on Google's page` }
    const profile = await fetch(`${this.options.gmailApi ?? 'https://gmail.googleapis.com'}/gmail/v1/users/me/profile`, { headers: { authorization: `Bearer ${tokenAnswer.body.access_token}` } })
      .then((r) => (r.ok ? r.json() as Promise<{ emailAddress?: string }> : null)).catch(() => null)
    if (!profile?.emailAddress) return { ok: false, reason: 'Signed in, but Gmail did not name the mailbox' }
    // Named by chance, not by the mailbox: the name shows up in listings and logs.
    const tokenFile = path.join(this.options.dir, `${randomBytes(8).toString('hex')}.token.json`)
    await this.writeOwnerOnly(tokenFile, `${JSON.stringify({ refresh_token: tokenAnswer.body.refresh_token })}\n`)
    return { ok: true, signedIn: { address: profile.emailAddress, credentialsFile: this.clientFile, tokenFile } }
  }

  private async writeOwnerOnly(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await fs.chmod(path.dirname(file), 0o700)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, text, { mode: 0o600 })
    await fs.rename(tmp, file)
  }
}
