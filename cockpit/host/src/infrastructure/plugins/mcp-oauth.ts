import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/**
 * Signing in to a remote MCP server with OAuth, as the MCP authorization spec describes it, so the
 * cockpit holds the tokens instead of each Claude config: the server's protected-resource metadata
 * names its authorization server, the cockpit registers itself there as a client (dynamic
 * registration), sends the user to the consent page with PKCE, and takes the code at its own
 * callback. The tokens it gets are renewed with the refresh token; a refused renewal means the user
 * signs in again.
 */

const resourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string().url()).min(1),
  scopes_supported: z.array(z.string()).optional(),
})
const serverMetadataSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url().optional(),
  revocation_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
})
const registrationSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().optional() })
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().optional() })

/** What a sign-in keeps in its connection, all as strings (connections.json is owner-only). */
export interface OAuthValues {
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  resource: string
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds; absent when the server gave no lifetime. */
  expiresAt?: string
  /** Where the tokens are revoked when the sign-in is removed (RFC 7009); absent when the server names none. */
  revocationEndpoint?: string
}

export type OAuthRefusal = { ok: false; reason: string; retryable: boolean }
type Pending = { verifier: string; clientId: string; clientSecret?: string; tokenEndpoint: string; revocationEndpoint?: string; resource: string; redirectUri: string; at: number }

const PENDING_MS = 15 * 60_000
const TIMEOUT_MS = 20_000

/** The well-known address under an origin, path-aware first (RFC 9728 / RFC 8414), then at the root. */
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base)
  const path = url.pathname.replace(/\/$/, '')
  return [...(path ? [`${url.origin}/.well-known/${name}${path}`] : []), `${url.origin}/.well-known/${name}`]
}

async function getJson<T>(urls: string[], schema: z.ZodType<T>): Promise<T | null> {
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) continue
      const parsed = schema.safeParse(await response.json().catch(() => null))
      if (parsed.success) return parsed.data
    } catch {
      // The next candidate.
    }
  }
  return null
}

export class McpOAuth {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: { clientName?: string; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * The consent page's address for a server, with a client registered for `redirectUri`. The
   * scopes are the ones the server asks for in its 401, else all it lists.
   */
  async start(serverUrl: string, redirectUri: string): Promise<{ ok: true; url: string; state: string } | OAuthRefusal> {
    const refuse = (reason: string, retryable = false): OAuthRefusal => ({ ok: false, reason, retryable })
    let metadataUrl: string | null = null
    let askedScope: string | null = null
    try {
      // An unauthenticated request: the 401's WWW-Authenticate names the resource metadata.
      const probe = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eml-cockpit', version: '1' } } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const challenge = probe.headers.get('www-authenticate') ?? ''
      metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? null
      askedScope = /scope="([^"]+)"/.exec(challenge)?.[1] ?? null
      await probe.body?.cancel().catch(() => undefined)
    } catch {
      return refuse('The server cannot be reached right now', true)
    }
    const resource = await getJson(metadataUrl ? [metadataUrl] : wellKnown(serverUrl, 'oauth-protected-resource'), resourceMetadataSchema)
    if (!resource) return refuse('This server names no OAuth sign-in (no protected-resource metadata)')
    const issuer = resource.authorization_servers[0]
    const server = await getJson([...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')], serverMetadataSchema)
    if (!server) return refuse('The server\'s sign-in service describes itself in no form the cockpit knows')
    if (!server.registration_endpoint) return refuse('The server\'s sign-in service lets no client register itself, so the cockpit cannot sign in there')
    let client: z.infer<typeof registrationSchema>
    try {
      const response = await fetch(server.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: this.options.clientName ?? 'EML Cockpit',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const parsed = registrationSchema.safeParse(await response.json().catch(() => null))
      if (!response.ok || !parsed.success) return refuse(`The sign-in service refused to register the cockpit (${response.status})`, response.status >= 500)
      client = parsed.data
    } catch {
      return refuse('The sign-in service cannot be reached right now', true)
    }
    const scopes = askedScope ?? (resource.scopes_supported ?? server.scopes_supported ?? []).join(' ')
    const now = this.now()
    for (const [key, entry] of this.pending) if (now - entry.at > PENDING_MS) this.pending.delete(key)
    const state = randomBytes(16).toString('hex')
    const verifier = randomBytes(32).toString('base64url')
    const resourceId = resource.resource ?? serverUrl
    this.pending.set(state, { verifier, clientId: client.client_id, clientSecret: client.client_secret, tokenEndpoint: server.token_endpoint, ...(server.revocation_endpoint ? { revocationEndpoint: server.revocation_endpoint } : {}), resource: resourceId, redirectUri, at: now })
    const url = new URL(server.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: resourceId,
      ...(scopes ? { scope: scopes } : {}),
    }).toString()
    return { ok: true, url: url.toString(), state }
  }

  /** Whether a callback's state belongs to a sign-in started here and not yet finished. */
  knows(state: string): boolean {
    return this.pending.has(state)
  }

  /** Trades the callback's code for tokens. The code is used up once the server answered. */
  async finish(state: string, code: string): Promise<{ ok: true; values: OAuthValues } | OAuthRefusal> {
    const pending = this.pending.get(state)
    if (!pending) return { ok: false, reason: 'This sign-in was not started here, or it is older than 15 minutes: start again', retryable: false }
    const answer = await this.token(pending.tokenEndpoint, {
      grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, client_id: pending.clientId, code_verifier: pending.verifier, resource: pending.resource,
      ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
    })
    if (answer.kind === 'unreachable') return { ok: false, reason: 'The sign-in service cannot be reached right now: open the link again', retryable: true }
    this.pending.delete(state)
    if (answer.kind === 'refused') return { ok: false, reason: 'The sign-in service refused the code: start again', retryable: false }
    return {
      ok: true,
      values: {
        tokenEndpoint: pending.tokenEndpoint, clientId: pending.clientId, ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        ...(pending.revocationEndpoint ? { revocationEndpoint: pending.revocationEndpoint } : {}),
        resource: pending.resource, ...this.tokenValues(answer.token),
      },
    }
  }

  /** New tokens from the refresh token; `refused` means the user signs in again. */
  async refresh(values: OAuthValues): Promise<{ kind: 'ok'; values: OAuthValues } | { kind: 'refused' } | { kind: 'unreachable' }> {
    if (!values.refreshToken) return { kind: 'refused' }
    const answer = await this.token(values.tokenEndpoint, {
      grant_type: 'refresh_token', refresh_token: values.refreshToken, client_id: values.clientId, resource: values.resource,
      ...(values.clientSecret ? { client_secret: values.clientSecret } : {}),
    })
    if (answer.kind !== 'ok') return answer
    // A server that rotates refresh tokens sends a new one; one that doesn't keeps the old.
    return { kind: 'ok', values: { ...values, refreshToken: values.refreshToken, ...this.tokenValues(answer.token) } }
  }

  /**
   * Revokes a removed sign-in's tokens at its server (RFC 7009): the refresh token, which ends the
   * grant, else the access token. Best effort: false when the server names no revocation endpoint or
   * can't be reached; the sign-in is removed here either way.
   */
  async revoke(values: OAuthValues): Promise<boolean> {
    if (!values.revocationEndpoint) return false
    const [token, hint] = values.refreshToken ? [values.refreshToken, 'refresh_token'] : [values.accessToken, 'access_token']
    try {
      const response = await fetch(values.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: values.clientId, ...(values.clientSecret ? { client_secret: values.clientSecret } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      await response.body?.cancel().catch(() => undefined)
      return response.ok
    } catch {
      return false
    }
  }

  private tokenValues(token: z.infer<typeof tokenSchema>): Pick<OAuthValues, 'accessToken' | 'refreshToken' | 'expiresAt'> {
    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: String(this.now() + token.expires_in * 1000) } : {}),
    }
  }

  private async token(endpoint: string, form: Record<string, string>): Promise<{ kind: 'ok'; token: z.infer<typeof tokenSchema> } | { kind: 'refused' } | { kind: 'unreachable' }> {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return { kind: 'unreachable' }
    }
    if (response.status >= 500) return { kind: 'unreachable' }
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null))
    if (!response.ok || !parsed.success) return { kind: 'refused' }
    return { kind: 'ok', token: parsed.data }
  }
}

/** The OAuth values of a connection, or null when it holds no OAuth sign-in. */
export function oauthValuesOf(values: Record<string, string>): OAuthValues | null {
  if (!values.tokenEndpoint || !values.clientId || !values.accessToken || !values.resource) return null
  return {
    tokenEndpoint: values.tokenEndpoint, clientId: values.clientId, resource: values.resource, accessToken: values.accessToken,
    ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
    ...(values.refreshToken ? { refreshToken: values.refreshToken } : {}),
    ...(values.expiresAt ? { expiresAt: values.expiresAt } : {}),
    ...(values.revocationEndpoint ? { revocationEndpoint: values.revocationEndpoint } : {}),
  }
}
