import { domainOf, normalizeMailAddress } from '../../domain/address'
import type { InboundMessage } from '../../domain/inbound-message'

/** The part of a Gmail API message (format=full) the bridge reads. */
export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  mimeType: string
  headers?: GmailHeader[]
  body?: { size: number; data?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate: string
  payload: GmailPart & { headers: GmailHeader[] }
}

const SKIPPED_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'CHAT'])

/** A Gmail message in the bridge's shape, or null for one the bridge leaves alone (sent, draft, spam, chat). */
export function toInboundMessage(message: GmailMessage, accountId: string): InboundMessage | null {
  if ((message.labelIds ?? []).some((label) => SKIPPED_LABELS.has(label))) return null
  const headers = message.payload.headers
  const from = senderAddress(header(headers, 'From') ?? '')
  return {
    channel: 'mail',
    accountId,
    channelMessageId: message.id,
    threadKey: message.threadId,
    from,
    senderVerified: senderVerified(headers, from),
    automated: isAutomated(headers),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    subject: header(headers, 'Subject') ?? null,
    text: bodyText(message.payload),
  }
}

/** The address in a From header, without its display name. */
export function senderAddress(from: string): string {
  const angled = from.match(/<([^<>]+)>\s*$/)
  return normalizeMailAddress(angled?.[1] ?? from)
}

/**
 * Whether Gmail vouches for the sender's domain: its own Authentication-Results header, the topmost
 * one, says DMARC passed for that domain, or DKIM passed for it or a parent. Headers a sender added
 * below Gmail's are never read.
 */
export function senderVerified(headers: GmailHeader[], from: string): boolean {
  const results = headers.find((entry) => entry.name.toLowerCase() === 'authentication-results')?.value
  const domain = domainOf(from)
  if (!results || !domain) return false
  const [authority, ...checks] = results.split(';').map((part) => part.trim())
  if (authority?.toLowerCase() !== 'mx.google.com') return false
  return checks.some((check) => {
    const dmarc = check.match(/^dmarc=pass\b.*\bheader\.from=([^\s;]+)/i)
    if (dmarc?.[1]) return normalizeMailAddress(dmarc[1]) === domain
    const dkim = check.match(/^dkim=pass\b.*\bheader\.(?:i|d)=@?([^\s;]+)/i)
    if (dkim?.[1]) {
      const signer = normalizeMailAddress(dkim[1])
      return domain === signer || domain.endsWith(`.${signer}`)
    }
    return false
  })
}

/** Sent by a machine: a list, bulk mail or an automatic reply. */
export function isAutomated(headers: GmailHeader[]): boolean {
  if (header(headers, 'List-Unsubscribe') !== undefined || header(headers, 'List-Id') !== undefined) return true
  const precedence = header(headers, 'Precedence')?.toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true
  const autoSubmitted = header(headers, 'Auto-Submitted')?.toLowerCase()
  return autoSubmitted !== undefined && autoSubmitted !== 'no'
}

export function header(headers: GmailHeader[], name: string): string | undefined {
  return headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value
}

function bodyText(part: GmailPart): string {
  const plain = findPart(part, 'text/plain')
  if (plain?.body?.data) return decode(plain.body.data)
  const html = findPart(part, 'text/html')
  return html?.body?.data ? stripHtml(decode(html.body.data)) : ''
}

function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return null
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ReplyParts {
  from: string
  to: string
  subject: string | null
  text: string
  messageId: string
  inReplyTo: string | null
  references: string | null
}

const PLAIN_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/

/** An RFC 2822 plain text mail, base64url-encoded for messages.send. */
export function buildReply(parts: ReplyParts): string {
  if (!PLAIN_ADDRESS.test(parts.to) || !PLAIN_ADDRESS.test(parts.from)) throw new Error('not a plain mail address')
  const lines = [
    `From: ${parts.from}`,
    `To: ${parts.to}`,
    `Subject: ${encodeHeader(oneLine(parts.subject ?? ''))}`,
    `Message-ID: ${oneLine(parts.messageId)}`,
    ...(parts.inReplyTo ? [`In-Reply-To: ${oneLine(parts.inReplyTo)}`] : []),
    ...(parts.references ? [`References: ${oneLine(parts.references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(parts.text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** A header value outside printable ASCII is sent RFC 2047-encoded. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}
