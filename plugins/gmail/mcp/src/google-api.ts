import type { z } from 'zod'
import type { AccessTokens } from '@engramprotocol/plugin-gmail-channel'

/**
 * Why Google gave no answer the tools can use: the sign-in was withdrawn, it lacks a scope, Google
 * can't be reached, it refused the request, or it answered in a shape the tools don't know.
 */
export type Refusal =
  | { ok: false; reason: 'revoked' | 'scopes' | 'unreachable' | 'bad_answer' }
  | { ok: false; reason: 'refused'; status: number; message: string | null }

export type ApiResult<T> = { ok: true; value: T } | Refusal

/** What a refusal tells the person (through the agent), and what they can do about it. */
export function refusalText(refusal: Refusal): string {
  switch (refusal.reason) {
    case 'revoked': return 'The Google sign-in was withdrawn or expired: sign in again in Settings › Plugins › Gmail.'
    case 'scopes': return 'This Google sign-in does not allow it yet (it was made before this tool): sign in again in Settings › Plugins › Gmail.'
    case 'unreachable': return 'Google cannot be reached right now; try again in a moment.'
    case 'bad_answer': return 'Google answered in a form this tool does not know.'
    case 'refused': return `Google answered ${refusal.status}${refusal.message ? `: ${refusal.message}` : ''}`
  }
}

/**
 * The Google REST APIs (Gmail, Calendar) on the user's sign-in: a fresh access token on every call,
 * and once more after Google refused one (it may have just expired). Every answer is checked against
 * the schema the caller names; what can go wrong comes back as a refusal, not an exception.
 */
export class GoogleApi {
  constructor(private readonly tokens: AccessTokens, private readonly base = 'https://www.googleapis.com') {}

  get<T>(path: string, schema: z.ZodType<T>, query: Record<string, string | number | undefined> = {}): Promise<ApiResult<T>> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
    return this.call('GET', `${path}${params.size ? `?${params}` : ''}`, schema)
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<ApiResult<T>> {
    return this.call('POST', path, schema, body)
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, renewed = false): Promise<ApiResult<T>> {
    const token = await this.tokens.get()
    if (token.kind === 'revoked') return { ok: false, reason: 'revoked' }
    if (token.kind === 'unreachable') return { ok: false, reason: 'unreachable' }
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (response.status === 401 && !renewed) {
      this.tokens.forget()
      return this.call(method, path, schema, body, true)
    }
    const json: unknown = response.status === 204 ? {} : await response.json().catch(() => null)
    if (!response.ok) {
      const message = (json as { error?: { message?: unknown } } | null)?.error?.message
      if (response.status === 403 && typeof message === 'string' && /insufficient authentication scopes/i.test(message)) return { ok: false, reason: 'scopes' }
      if (response.status >= 500) return { ok: false, reason: 'unreachable' }
      return { ok: false, reason: 'refused', status: response.status, message: typeof message === 'string' ? message : null }
    }
    const parsed = schema.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'bad_answer' }
  }
}
