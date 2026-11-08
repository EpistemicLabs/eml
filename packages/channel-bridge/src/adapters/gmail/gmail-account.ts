import { createHash } from 'crypto'
import { z } from 'zod'
import type { Channel } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'
import type { ChannelAccount, ChannelUnavailable, OutgoingMessage, SendOutcome, SyncResult } from '../../ports/channel'
import { buildReply, header, toInboundMessage } from './gmail-mapping'
import type { GmailMessage } from './gmail-mapping'
import type { AccessTokens } from './google-refresh-token'

const headerSchema = z.object({ name: z.string(), value: z.string() })
const partSchema: z.ZodType<GmailMessage['payload']> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    headers: z.array(headerSchema).default([]),
    body: z.object({ size: z.number(), data: z.string().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }),
)
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string(),
  payload: partSchema,
})
const profileSchema = z.object({ historyId: z.string() })
const historySchema = z.object({
  history: z.array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional() })).optional(),
  historyId: z.string(),
  nextPageToken: z.string().optional(),
})
const listSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional() })
const threadSchema = z.object({ messages: z.array(z.object({ payload: z.object({ headers: z.array(headerSchema).default([]) }) })).default([]) })
const sentSchema = z.object({ id: z.string() })

export interface GmailAccountOptions {
  accountId: string
  space: string
  /** The mailbox's address, the sender of every reply. */
  address: string
  tokens: AccessTokens
  apiBase?: string
}

type Call<T> = { ok: true; value: T } | { ok: false; status: number | 'unreachable' | 'revoked' | 'bad_answer' }

/** A Gmail mailbox through the Gmail API: history since a cursor, and plain text replies. */
export class GmailAccount implements ChannelAccount {
  readonly channel: Channel = 'mail'
  readonly accountId: string
  readonly space: string
  private readonly api: string

  constructor(private readonly options: GmailAccountOptions) {
    this.accountId = options.accountId
    this.space = options.space
    this.api = `${options.apiBase ?? 'https://gmail.googleapis.com'}/gmail/v1/users/me`
  }

  async sync(cursor: string | null): Promise<SyncResult> {
    if (cursor === null) return this.fromNow(false)
    const ids: string[] = []
    let pageToken: string | undefined
    let latest = cursor
    do {
      const query = new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded' })
      if (pageToken) query.set('pageToken', pageToken)
      const page = await this.call(`/history?${query}`, historySchema)
      if (!page.ok) return page.status === 404 ? this.fromNow(true) : unavailable(page.status)
      for (const entry of page.value.history ?? []) {
        for (const added of entry.messagesAdded ?? []) if (!ids.includes(added.message.id)) ids.push(added.message.id)
      }
      latest = page.value.historyId
      pageToken = page.value.nextPageToken
    } while (pageToken)

    const messages: InboundMessage[] = []
    for (const id of ids) {
      const message = await this.call(`/messages/${encodeURIComponent(id)}?format=full`, messageSchema)
      if (!message.ok) {
        if (message.status === 404) continue
        return unavailable(message.status)
      }
      const inbound = toInboundMessage(message.value, this.accountId)
      if (inbound) messages.push(inbound)
    }
    return { kind: 'synced', messages, cursor: latest, gap: false }
  }

  /**
   * Sends a plain text reply. Its Message-ID is made from the idempotency key, and Gmail is asked
   * for a sent mail with that id first, so a retry after a cut-off send sends nothing twice.
   */
  async send(message: OutgoingMessage): Promise<SendOutcome> {
    const messageId = `<${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 32)}@channel-bridge.eml>`
    const earlier = await this.call(`/messages?${new URLSearchParams({ q: `rfc822msgid:${messageId}` })}`, listSchema)
    if (!earlier.ok) return failed(earlier.status)
    const found = earlier.value.messages?.[0]
    if (found) return { kind: 'sent', channelMessageId: found.id }

    let inReplyTo: string | null = null
    let references: string | null = null
    if (message.threadKey) {
      const query = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'Message-ID'], ['metadataHeaders', 'References']])
      const thread = await this.call(`/threads/${encodeURIComponent(message.threadKey)}?${query}`, threadSchema)
      if (!thread.ok) return failed(thread.status)
      const last = thread.value.messages.at(-1)?.payload.headers ?? []
      inReplyTo = header(last, 'Message-ID') ?? null
      references = [header(last, 'References'), inReplyTo].filter(Boolean).join(' ') || null
    }

    let raw: string
    try {
      raw = buildReply({ from: this.options.address, to: message.to, subject: message.subject, text: message.text, messageId, inReplyTo, references })
    } catch {
      return { kind: 'failed', reason: 'invalid_recipient', retryable: false }
    }
    const body = message.threadKey ? { raw, threadId: message.threadKey } : { raw }
    const sent = await this.call('/messages/send', sentSchema, body)
    return sent.ok ? { kind: 'sent', channelMessageId: sent.value.id } : failed(sent.status)
  }

  private async fromNow(gap: boolean): Promise<SyncResult> {
    const profile = await this.call('/profile', profileSchema)
    if (!profile.ok) return unavailable(profile.status)
    return { kind: 'synced', messages: [], cursor: profile.value.historyId, gap }
  }

  /** One API call with the current token; a refused token is renewed once. */
  private async call<T>(path: string, schema: z.ZodType<T>, body?: unknown, renewed = false): Promise<Call<T>> {
    const token = await this.options.tokens.get()
    if (token.kind !== 'token') return { ok: false, status: token.kind }
    let response: Response
    try {
      response = await fetch(`${this.api}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      return { ok: false, status: 'unreachable' }
    }
    if (response.status === 401 && !renewed) {
      this.options.tokens.forget()
      return this.call(path, schema, body, true)
    }
    if (!response.ok) return { ok: false, status: response.status === 401 ? 'revoked' : response.status }
    const parsed = schema.safeParse(await response.json().catch(() => null))
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: 'bad_answer' }
  }
}

function unavailable(status: number | 'unreachable' | 'revoked' | 'bad_answer'): ChannelUnavailable {
  if (status === 'revoked' || status === 403) return { kind: 'unavailable', reason: 'access_revoked', retryable: false }
  if (status === 429) return { kind: 'unavailable', reason: 'rate_limited', retryable: true }
  if (status === 'bad_answer') return { kind: 'unavailable', reason: 'bad_answer', retryable: true }
  return { kind: 'unavailable', reason: 'unreachable', retryable: true }
}

function failed(status: number | 'unreachable' | 'revoked' | 'bad_answer'): SendOutcome {
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 403 && status !== 429) {
    return { kind: 'failed', reason: 'rejected', retryable: false }
  }
  const answer = unavailable(status)
  return { kind: 'failed', reason: answer.reason, retryable: answer.retryable }
}
