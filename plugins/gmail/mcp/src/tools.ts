import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as path from 'path'
import type { GoogleApi } from './google-api'
import { attachments, buildRaw, header, htmlBody, plainToHtml, textBody, type Part } from './mime'

interface Message {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload: Part
}

export interface MailboxDeps {
  api: GoogleApi
  /** The mailbox's address: the sender of every mail, left out of a reply's copies. */
  address: string
  /** Where read_email saves a message's attachments, one folder per message. */
  attachmentsDir: string
}

const GMAIL = '/gmail/v1/users/me'

/** One line block per message, as the tools list them. */
function summary(message: Message): string {
  return [
    `ID: ${message.id}`,
    `From: ${header(message.payload, 'From')}`,
    `Subject: ${header(message.payload, 'Subject')}`,
    `Date: ${header(message.payload, 'Date')}`,
    `Snippet: ${message.snippet ?? ''}`,
  ].join('\n')
}

/** The addresses in a header list ("Name <a@b>, c@d"), lower case. */
export function addressesOf(value: string): string[] {
  return value.split(',').map((entry) => (/<([^>]+)>/.exec(entry)?.[1] ?? entry).trim().toLowerCase()).filter((a) => a.includes('@'))
}

/**
 * The tools of the gmail plugin's MCP part for one mailbox. Their names, arguments and answers are
 * those of the Gmail MCP server they replace, so skills built on it keep working.
 */
export class Mailbox {
  private signature: string | null | undefined

  constructor(private readonly deps: MailboxDeps) {}

  private async list(query: string, max: number): Promise<Message[]> {
    const found = await this.deps.api.get<{ messages?: Array<{ id: string }> }>(`${GMAIL}/messages`, { q: query, maxResults: max })
    return Promise.all((found.messages ?? []).map((m) => this.deps.api.get<Message>(`${GMAIL}/messages/${m.id}`, { format: 'metadata' })))
  }

  async unanswered(days = 7, max = 25): Promise<string> {
    const messages = await this.list(`is:inbox -is:replied newer_than:${days}d`, max)
    if (messages.length === 0) return 'No unanswered emails found.'
    return `Found ${messages.length} unanswered emails:\n\n${messages.map(summary).join('\n---\n')}`
  }

  async search(query: string, max = 10): Promise<string> {
    const messages = await this.list(query, max)
    if (messages.length === 0) return `No emails found for query: ${query}`
    return `Found ${messages.length} emails:\n\n${messages.map(summary).join('\n---\n')}`
  }

  /** The whole message, its attachments saved to a folder of its own. */
  async read(messageId: string): Promise<string> {
    const message = await this.deps.api.get<Message>(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, { format: 'full' })
    const saved: string[] = []
    const files = attachments(message.payload)
    if (files.length > 0) {
      const dir = path.join(this.deps.attachmentsDir, message.id.replace(/[^A-Za-z0-9_-]/g, ''))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const file of files) {
        const data = await this.deps.api.get<{ data: string }>(`${GMAIL}/messages/${message.id}/attachments/${file.attachmentId}`)
        const target = path.join(dir, path.basename(file.filename) || 'unnamed')
        writeFileSync(target, Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { mode: 0o600 })
        saved.push(target)
      }
    }
    const h = (name: string) => header(message.payload, name)
    return [
      `ID: ${message.id}`,
      `Thread ID: ${message.threadId}`,
      `From: ${h('From')}`,
      `To: ${h('To')}`,
      `Cc: ${h('Cc')}`,
      `Date: ${h('Date')}`,
      `Subject: ${h('Subject')}`,
      `Message-ID: ${h('Message-ID')}`,
      ...(saved.length ? [`Attachments:\n${saved.map((p) => `  - ${p}`).join('\n')}`] : []),
      '',
      textBody(message.payload),
    ].join('\n')
  }

  /** The mailbox's own Gmail signature (send-as settings), HTML; none when it has none. */
  private async ownSignature(): Promise<string | null> {
    if (this.signature === undefined) {
      const sendAs = await this.deps.api.get<{ signature?: string }>(`${GMAIL}/settings/sendAs/${encodeURIComponent(this.deps.address)}`).catch(() => null)
      this.signature = sendAs?.signature?.trim() || null
    }
    return this.signature
  }

  private files(list: string): Array<{ filename: string; mimeType: string; content: Buffer }> {
    return list.split(',').map((p) => p.trim()).filter(Boolean).map((file) => {
      if (!existsSync(file)) throw new Error(`Attachment not found: ${file}`)
      return { filename: path.basename(file), mimeType: mimeOf(file), content: readFileSync(file) }
    })
  }

  private async body(text: string): Promise<string> {
    const signature = await this.ownSignature()
    return `<div>${plainToHtml(text)}</div>${signature ? `<br><div>${signature}</div>` : ''}`
  }

  async send(to: string, subject: string, body: string, cc = '', attachmentList = ''): Promise<string> {
    const files = this.files(attachmentList)
    const raw = buildRaw({ from: this.deps.address, to, cc: cc || undefined, subject, html: await this.body(body), files })
    const sent = await this.deps.api.post<{ id: string }>(`${GMAIL}/messages/send`, { raw })
    return `Email sent successfully${files.length ? ` with ${files.length} attachment(s)` : ''}. Message ID: ${sent.id}`
  }

  /** A reply to the sender, the original's other recipients in copy, quoted, in its thread; the thread is then archived. */
  async reply(messageId: string, body: string, attachmentList = ''): Promise<string> {
    const original = await this.deps.api.get<Message>(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, { format: 'full' })
    const h = (name: string) => header(original.payload, name)
    const replyTo = addressesOf(h('Reply-To') || h('From'))[0] ?? h('From')
    const self = this.deps.address.toLowerCase()
    const cc = [...new Set(addressesOf(`${h('To')},${h('Cc')}`))].filter((a) => a !== self && a !== replyTo)
    const subject = /^re:/i.test(h('Subject')) ? h('Subject') : `Re: ${h('Subject')}`
    const quoted = htmlBody(original.payload) ?? plainToHtml(textBody(original.payload))
    const html = `${await this.body(body)}<br><div class="gmail_quote"><div>On ${plainToHtml(h('Date'))}, ${plainToHtml(h('From'))} wrote:</div><br>`
      + `<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${quoted}</blockquote></div>`
    const files = this.files(attachmentList)
    const references = [h('References'), h('Message-ID')].filter(Boolean).join(' ')
    const raw = buildRaw({ from: this.deps.address, to: replyTo, cc: cc.join(', ') || undefined, subject, html, inReplyTo: h('Message-ID') || undefined, references: references || undefined, files })
    const sent = await this.deps.api.post<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, { raw, threadId: original.threadId })
    await this.archiveThread(original.threadId)
    return `Reply sent${files.length ? ` with ${files.length} attachment(s)` : ''} & thread archived. Message ID: ${sent.id}, Thread ID: ${sent.threadId}`
  }

  private async archiveThread(threadId: string): Promise<number> {
    const thread = await this.deps.api.get<{ messages?: Message[] }>(`${GMAIL}/threads/${encodeURIComponent(threadId)}`, { format: 'minimal' })
    const inInbox = (thread.messages ?? []).filter((m) => m.labelIds?.includes('INBOX'))
    for (const m of inInbox) await this.deps.api.post(`${GMAIL}/messages/${m.id}/modify`, { removeLabelIds: ['INBOX'] })
    return inInbox.length
  }

  async doneThread(threadId: string): Promise<string> {
    const count = await this.archiveThread(threadId)
    return `Thread ${threadId} moved to Done. Archived ${count} message(s).`
  }

  async doneMessage(messageId: string): Promise<string> {
    const message = await this.deps.api.get<Message>(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, { format: 'minimal' })
    if (!message.labelIds?.includes('INBOX')) return `Message ${messageId} was not in inbox.`
    await this.deps.api.post(`${GMAIL}/messages/${encodeURIComponent(messageId)}/modify`, { removeLabelIds: ['INBOX', 'UNREAD'] })
    return `Message ${messageId} moved to Done.`
  }
}

/** The calendar tools: events in a window, and when people are busy. */
export class Calendar {
  constructor(private readonly api: GoogleApi) {}

  async events(timeMin: string, timeMax: string, calendarId = 'primary', max = 50): Promise<string> {
    const found = await this.api.get<{ items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; attendees?: Array<{ email: string; responseStatus?: string }>; hangoutLink?: string }> }>(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: max },
    )
    const items = found.items ?? []
    if (items.length === 0) return 'No events in this window.'
    return items.map((e) => [
      `${e.start?.dateTime ?? e.start?.date ?? '?'} – ${e.end?.dateTime ?? e.end?.date ?? '?'}: ${e.summary ?? '(no title)'}`,
      ...(e.location ? [`  Where: ${e.location}`] : []),
      ...(e.hangoutLink ? [`  Meet: ${e.hangoutLink}`] : []),
      ...(e.attendees?.length ? [`  With: ${e.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`).join(', ')}`] : []),
      `  ID: ${e.id}`,
    ].join('\n')).join('\n\n')
  }

  async freeBusy(timeMin: string, timeMax: string, calendars: string[] = ['primary']): Promise<string> {
    const answer = await this.api.post<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(
      '/calendar/v3/freeBusy',
      { timeMin, timeMax, items: calendars.map((id) => ({ id })) },
    )
    return Object.entries(answer.calendars ?? {}).map(([id, c]) => {
      if (c.errors?.length) return `${id}: not readable with this sign-in`
      const busy = c.busy ?? []
      return busy.length ? `${id} busy:\n${busy.map((b) => `  ${b.start} – ${b.end}`).join('\n')}` : `${id}: free the whole window`
    }).join('\n\n')
  }
}

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function mimeOf(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}
