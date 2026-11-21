import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { refusalText, type ApiResult, type GoogleApi } from './google-api'
import { attachments, buildRaw, header, htmlBody, plainToHtml, textBody, type Part } from './mime'

// The shapes of the Gmail and Calendar answers the tools read; anything else is a refusal.
const partSchema: z.ZodType<Part> = z.lazy(() => z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}))
const messageSchema = z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()).optional(), snippet: z.string().optional(), payload: partSchema })
type Message = z.infer<typeof messageSchema>
const minimalSchema = z.object({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional() })
const listSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional() })
const attachmentSchema = z.object({ data: z.string() })
const sentSchema = z.object({ id: z.string(), threadId: z.string().optional() })
const threadSchema = z.object({ messages: z.array(minimalSchema).optional() })
const sendAsSchema = z.object({ signature: z.string().optional() })
const anySchema = z.unknown()
const eventsSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    summary: z.string().optional(),
    start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    location: z.string().optional(),
    hangoutLink: z.string().optional(),
    attendees: z.array(z.object({ email: z.string(), responseStatus: z.string().optional() })).optional(),
  })).optional(),
})
const freeBusySchema = z.object({
  calendars: z.record(z.string(), z.object({ busy: z.array(z.object({ start: z.string(), end: z.string() })).optional(), errors: z.array(z.unknown()).optional() })).optional(),
})

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

type Files = { ok: true; files: Array<{ filename: string; mimeType: string; content: Buffer }> } | { ok: false; text: string }

/**
 * The tools of the gmail plugin's MCP part for one mailbox. Their names, arguments and answers are
 * those of the Gmail MCP server they replace, so skills built on it keep working. Each answers with
 * text, also when Google refuses: what went wrong is an answer, not an exception.
 */
export class Mailbox {
  private signature: string | null | undefined

  constructor(private readonly deps: MailboxDeps) {}

  private async list(query: string, max: number): Promise<ApiResult<Message[]>> {
    const found = await this.deps.api.get(`${GMAIL}/messages`, listSchema, { q: query, maxResults: max })
    if (!found.ok) return found
    const messages: Message[] = []
    for (const m of found.value.messages ?? []) {
      const message = await this.deps.api.get(`${GMAIL}/messages/${m.id}`, messageSchema, { format: 'metadata' })
      if (!message.ok) return message
      messages.push(message.value)
    }
    return { ok: true, value: messages }
  }

  async unanswered(days = 7, max = 25): Promise<string> {
    const messages = await this.list(`is:inbox -is:replied newer_than:${days}d`, max)
    if (!messages.ok) return refusalText(messages)
    if (messages.value.length === 0) return 'No unanswered emails found.'
    return `Found ${messages.value.length} unanswered emails:\n\n${messages.value.map(summary).join('\n---\n')}`
  }

  async search(query: string, max = 10): Promise<string> {
    const messages = await this.list(query, max)
    if (!messages.ok) return refusalText(messages)
    if (messages.value.length === 0) return `No emails found for query: ${query}`
    return `Found ${messages.value.length} emails:\n\n${messages.value.map(summary).join('\n---\n')}`
  }

  /** The whole message, its attachments saved to a folder of its own. */
  async read(messageId: string): Promise<string> {
    const found = await this.deps.api.get(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, messageSchema, { format: 'full' })
    if (!found.ok) return refusalText(found)
    const message = found.value
    const saved: string[] = []
    const files = attachments(message.payload)
    if (files.length > 0) {
      const dir = path.join(this.deps.attachmentsDir, message.id.replace(/[^A-Za-z0-9_-]/g, ''))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const file of files) {
        const data = await this.deps.api.get(`${GMAIL}/messages/${message.id}/attachments/${file.attachmentId}`, attachmentSchema)
        if (!data.ok) continue
        const target = path.join(dir, path.basename(file.filename) || 'unnamed')
        writeFileSync(target, Buffer.from(data.value.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { mode: 0o600 })
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
      ...(saved.length < files.length ? [`(${files.length - saved.length} attachment(s) could not be fetched)`] : []),
      '',
      textBody(message.payload),
    ].join('\n')
  }

  /** The mailbox's own Gmail signature (send-as settings), HTML; none when it has none or can't be read. */
  private async ownSignature(): Promise<string | null> {
    if (this.signature === undefined) {
      const sendAs = await this.deps.api.get(`${GMAIL}/settings/sendAs/${encodeURIComponent(this.deps.address)}`, sendAsSchema)
      this.signature = sendAs.ok ? sendAs.value.signature?.trim() || null : null
    }
    return this.signature
  }

  private files(list: string): Files {
    const files: Array<{ filename: string; mimeType: string; content: Buffer }> = []
    for (const file of list.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (!existsSync(file)) return { ok: false, text: `Attachment not found: ${file}` }
      files.push({ filename: path.basename(file), mimeType: mimeOf(file), content: readFileSync(file) })
    }
    return { ok: true, files }
  }

  private async body(text: string): Promise<string> {
    const signature = await this.ownSignature()
    return `<div>${plainToHtml(text)}</div>${signature ? `<br><div>${signature}</div>` : ''}`
  }

  /** A send Google didn't answer may still have gone out: say so, rather than inviting a second one. */
  private sendRefused(refusal: Exclude<ApiResult<unknown>, { ok: true }>): string {
    return refusal.reason === 'unreachable'
      ? 'Google did not answer in time: the mail may have been sent. Check the Sent folder (search_emails "in:sent") before sending it again.'
      : refusalText(refusal)
  }

  async send(to: string, subject: string, body: string, cc = '', attachmentList = ''): Promise<string> {
    const files = this.files(attachmentList)
    if (!files.ok) return files.text
    const raw = buildRaw({ from: this.deps.address, to, cc: cc || undefined, subject, html: await this.body(body), files: files.files })
    const sent = await this.deps.api.post(`${GMAIL}/messages/send`, { raw }, sentSchema)
    if (!sent.ok) return this.sendRefused(sent)
    return `Email sent successfully${files.files.length ? ` with ${files.files.length} attachment(s)` : ''}. Message ID: ${sent.value.id}`
  }

  /** A reply to the sender, the original's other recipients in copy, quoted, in its thread; the thread is then archived. */
  async reply(messageId: string, body: string, attachmentList = ''): Promise<string> {
    const found = await this.deps.api.get(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, messageSchema, { format: 'full' })
    if (!found.ok) return refusalText(found)
    const original = found.value
    const h = (name: string) => header(original.payload, name)
    const replyTo = addressesOf(h('Reply-To') || h('From'))[0] ?? h('From')
    const self = this.deps.address.toLowerCase()
    const cc = [...new Set(addressesOf(`${h('To')},${h('Cc')}`))].filter((a) => a !== self && a !== replyTo)
    const subject = /^re:/i.test(h('Subject')) ? h('Subject') : `Re: ${h('Subject')}`
    const quoted = htmlBody(original.payload) ?? plainToHtml(textBody(original.payload))
    const html = `${await this.body(body)}<br><div class="gmail_quote"><div>On ${plainToHtml(h('Date'))}, ${plainToHtml(h('From'))} wrote:</div><br>`
      + `<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${quoted}</blockquote></div>`
    const files = this.files(attachmentList)
    if (!files.ok) return files.text
    const references = [h('References'), h('Message-ID')].filter(Boolean).join(' ')
    const raw = buildRaw({ from: this.deps.address, to: replyTo, cc: cc.join(', ') || undefined, subject, html, inReplyTo: h('Message-ID') || undefined, references: references || undefined, files: files.files })
    const sent = await this.deps.api.post(`${GMAIL}/messages/send`, { raw, threadId: original.threadId }, sentSchema)
    if (!sent.ok) return this.sendRefused(sent)
    const what = `Reply sent${files.files.length ? ` with ${files.files.length} attachment(s)` : ''}`
    // The reply is out; archiving only accompanies it and never turns it into a failure.
    const archived = await this.archiveThread(original.threadId)
    return archived.ok
      ? `${what} & thread archived. Message ID: ${sent.value.id}, Thread ID: ${sent.value.threadId ?? original.threadId}`
      : `${what}. Message ID: ${sent.value.id}, Thread ID: ${sent.value.threadId ?? original.threadId}. Archiving the thread failed: ${refusalText(archived)}`
  }

  private async archiveThread(threadId: string): Promise<ApiResult<number>> {
    const thread = await this.deps.api.get(`${GMAIL}/threads/${encodeURIComponent(threadId)}`, threadSchema, { format: 'minimal' })
    if (!thread.ok) return thread
    const inInbox = (thread.value.messages ?? []).filter((m) => m.labelIds?.includes('INBOX'))
    for (const m of inInbox) {
      const modified = await this.deps.api.post(`${GMAIL}/messages/${m.id}/modify`, { removeLabelIds: ['INBOX'] }, anySchema)
      if (!modified.ok) return modified
    }
    return { ok: true, value: inInbox.length }
  }

  async doneThread(threadId: string): Promise<string> {
    const archived = await this.archiveThread(threadId)
    return archived.ok ? `Thread ${threadId} moved to Done. Archived ${archived.value} message(s).` : refusalText(archived)
  }

  async doneMessage(messageId: string): Promise<string> {
    const message = await this.deps.api.get(`${GMAIL}/messages/${encodeURIComponent(messageId)}`, minimalSchema, { format: 'minimal' })
    if (!message.ok) return refusalText(message)
    if (!message.value.labelIds?.includes('INBOX')) return `Message ${messageId} was not in inbox.`
    const modified = await this.deps.api.post(`${GMAIL}/messages/${encodeURIComponent(messageId)}/modify`, { removeLabelIds: ['INBOX', 'UNREAD'] }, anySchema)
    return modified.ok ? `Message ${messageId} moved to Done.` : refusalText(modified)
  }
}

/** The calendar tools: events in a window, and when people are busy. */
export class Calendar {
  constructor(private readonly api: GoogleApi) {}

  async events(timeMin: string, timeMax: string, calendarId = 'primary', max = 50): Promise<string> {
    const found = await this.api.get(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, eventsSchema, { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: max })
    if (!found.ok) return refusalText(found)
    const items = found.value.items ?? []
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
    const answer = await this.api.post('/calendar/v3/freeBusy', { timeMin, timeMax, items: calendars.map((id) => ({ id })) }, freeBusySchema)
    if (!answer.ok) return refusalText(answer)
    return Object.entries(answer.value.calendars ?? {}).map(([id, c]) => {
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
