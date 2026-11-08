import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { GmailMessage } from '../../src/adapters/gmail/gmail-mapping'

/**
 * A stand-in for Google's token endpoint and the parts of the Gmail API the bridge calls, with
 * placeholder data only. Tests put messages in, expire the history, revoke the grant or make the
 * API fail, and look at what was sent.
 */
export class FakeGmail {
  readonly sent: { raw: string; threadId?: string }[] = []
  readonly calls: string[] = []
  private readonly messages = new Map<string, GmailMessage>()
  private readonly history: { id: number; messageId: string }[] = []
  private historyId = 100
  private oldestHistoryId = 0
  private revoked = false
  private failing: number | null = null
  private server: Server | null = null
  url = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  deliver(message: GmailMessage): void {
    this.historyId += 1
    this.messages.set(message.id, message)
    this.history.push({ id: this.historyId, messageId: message.id })
  }

  /** History before now is gone, as when a cursor is older than Gmail keeps. */
  expireHistory(): void {
    this.oldestHistoryId = this.historyId + 1
  }

  revoke(): void {
    this.revoked = true
  }

  failWith(status: number | null): void {
    this.failing = status
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      this.calls.push(`${req.method} ${url.pathname}`)
      if (url.pathname === '/token') {
        const form = new URLSearchParams(raw)
        if (this.revoked || form.get('refresh_token') !== 'refresh-1') return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, { access_token: 'access-1', expires_in: 3600, token_type: 'Bearer' })
      }
      if (req.headers.authorization !== 'Bearer access-1') return json(res, 401, { error: { code: 401 } })
      if (this.failing) return json(res, this.failing, { error: { code: this.failing } })
      const base = '/gmail/v1/users/me'
      if (url.pathname === `${base}/profile`) return json(res, 200, { emailAddress: 'me@home.example', historyId: String(this.historyId) })
      if (url.pathname === `${base}/history`) {
        const start = Number(url.searchParams.get('startHistoryId'))
        if (start < this.oldestHistoryId) return json(res, 404, { error: { code: 404 } })
        const after = this.history.filter((entry) => entry.id > start)
        const page = url.searchParams.get('pageToken') === 'p2' ? after.slice(1) : after.slice(0, 1)
        const nextPageToken = !url.searchParams.get('pageToken') && after.length > 1 ? 'p2' : undefined
        return json(res, 200, {
          history: page.map((entry) => ({ id: String(entry.id), messagesAdded: [{ message: { id: entry.messageId, threadId: this.messages.get(entry.messageId)?.threadId } }] })),
          historyId: String(this.historyId),
          ...(nextPageToken ? { nextPageToken } : {}),
        })
      }
      const one = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/)
      if (req.method === 'GET' && one?.[1]) {
        const message = this.messages.get(one[1])
        return message ? json(res, 200, message) : json(res, 404, { error: { code: 404 } })
      }
      if (req.method === 'GET' && url.pathname === `${base}/messages`) {
        const wanted = (url.searchParams.get('q') ?? '').replace(/^rfc822msgid:/, '')
        const found = [...this.messages.values()].filter((message) =>
          message.payload.headers.some((h) => h.name === 'Message-ID' && h.value === wanted))
        return json(res, 200, found.length > 0 ? { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) } : { resultSizeEstimate: 0 })
      }
      const thread = url.pathname.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/)
      if (thread?.[1]) {
        const inThread = [...this.messages.values()].filter((message) => message.threadId === thread[1])
        return json(res, 200, { id: thread[1], messages: inThread.map((m) => ({ id: m.id, payload: { headers: m.payload.headers } })) })
      }
      if (req.method === 'POST' && url.pathname === `${base}/messages/send`) {
        const body = JSON.parse(raw) as { raw: string; threadId?: string }
        this.sent.push(body)
        const mail = Buffer.from(body.raw, 'base64url').toString('utf8')
        const messageId = mail.match(/^Message-ID: (.+)$/m)?.[1]?.trim() ?? ''
        const id = `sent-${this.sent.length}`
        this.messages.set(id, {
          id, threadId: body.threadId ?? id, labelIds: ['SENT'], internalDate: '0',
          payload: { mimeType: 'text/plain', headers: [{ name: 'Message-ID', value: messageId }] },
        })
        return json(res, 200, { id, threadId: body.threadId ?? id })
      }
      json(res, 404, { error: { code: 404 } })
    })
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A mail in the Gmail API's shape from a placeholder sender. */
export function gmailMessage(id: string, over: { threadId?: string; from?: string; subject?: string; text?: string } = {}): GmailMessage {
  const from = over.from ?? 'team@shop.example'
  const domain = from.split('@')[1] ?? ''
  return {
    id,
    threadId: over.threadId ?? `th-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1762596000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain}` },
        { name: 'From', value: `"Team" <${from}>` },
        { name: 'Subject', value: over.subject ?? 'Quote' },
        { name: 'Message-ID', value: `<${id}@${domain}>` },
      ],
      body: { size: 1, data: Buffer.from(over.text ?? 'Hello', 'utf8').toString('base64url') },
    },
  }
}
