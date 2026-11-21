import type { AccessTokens } from '@engramprotocol/plugin-gmail-channel'

/** A request Google refused or couldn't answer, with what a person can do about it. */
export class GoogleApiError extends Error {}

/**
 * The Google REST APIs (Gmail, Calendar) on the user's sign-in: a fresh access token on every
 * call, and once more after Google refused one (it may have just expired).
 */
export class GoogleApi {
  constructor(private readonly tokens: AccessTokens, private readonly base = 'https://www.googleapis.com') {}

  get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
    return this.call<T>('GET', `${path}${params.size ? `?${params}` : ''}`)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, body)
  }

  private async call<T>(method: string, path: string, body?: unknown, renewed = false): Promise<T> {
    const token = await this.tokens.get()
    if (token.kind === 'revoked') throw new GoogleApiError('The Google sign-in was withdrawn or expired: sign in again in Settings › Plugins › Gmail.')
    if (token.kind === 'unreachable') throw new GoogleApiError('Google cannot be reached right now; try again in a moment.')
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new GoogleApiError('Google cannot be reached right now; try again in a moment.')
    }
    if (response.status === 401 && !renewed) {
      this.tokens.forget()
      return this.call<T>(method, path, body, true)
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { message?: string } } | null
      if (response.status === 403 && /insufficient authentication scopes/i.test(detail?.error?.message ?? '')) {
        throw new GoogleApiError('This Google sign-in does not allow it yet (it was made before this tool): sign in again in Settings › Plugins › Gmail.')
      }
      throw new GoogleApiError(`Google answered ${response.status}${detail?.error?.message ? `: ${detail.error.message}` : ''}`)
    }
    return (response.status === 204 ? null : await response.json()) as T
  }
}
