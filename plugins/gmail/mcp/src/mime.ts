import { randomBytes } from 'crypto'

/** A Gmail message part as the API returns it. */
export interface Part {
  mimeType?: string
  filename?: string
  headers?: Array<{ name: string; value: string }>
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: Part[]
}

export function header(part: Part, name: string): string {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

function find(part: Part, mimeType: string): Part | null {
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return part
  for (const child of part.parts ?? []) {
    const found = find(child, mimeType)
    if (found) return found
  }
  return null
}

/** The message's HTML body, or null when it has none. */
export function htmlBody(payload: Part): string | null {
  const html = find(payload, 'text/html')
  return html?.body?.data ? decode(html.body.data) : null
}

/** The message's text: its plain part, else its HTML with the markup taken out. */
export function textBody(payload: Part): string {
  const plain = find(payload, 'text/plain')
  if (plain?.body?.data) return decode(plain.body.data)
  const html = htmlBody(payload)
  if (html === null) return payload.body?.data ? decode(payload.body.data) : ''
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The parts that are files, with what fetching each needs. */
export function attachments(payload: Part): Array<{ filename: string; attachmentId: string; mimeType: string }> {
  const out: Array<{ filename: string; attachmentId: string; mimeType: string }> = []
  const walk = (part: Part) => {
    if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType ?? 'application/octet-stream' })
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return out
}

/** Plain text as HTML: escaped, line breaks kept. */
export function plainToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>')
}

/** A header value with anything beyond ASCII as an RFC 2047 encoded word. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export interface OutgoingMail {
  from: string
  to: string
  cc?: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  files?: Array<{ filename: string; mimeType: string; content: Buffer }>
}

const wrap = (base64: string) => base64.replace(/.{1,76}/g, '$&\r\n')

/** An HTML mail with its attachments as the raw RFC 822 text Gmail sends, base64url encoded. */
export function buildRaw(mail: OutgoingMail): string {
  const head = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    ...(mail.references ? [`References: ${mail.references}`] : []),
    'MIME-Version: 1.0',
  ]
  const htmlPart = ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(mail.html, 'utf8').toString('base64'))]
  let text: string
  if (!mail.files?.length) {
    text = [...head, ...htmlPart].join('\r\n')
  } else {
    const boundary = `eml_${randomBytes(12).toString('hex')}`
    const files = mail.files.map((file) => [
      `--${boundary}`,
      `Content-Type: ${file.mimeType}; name="${encodeHeader(file.filename)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(file.filename)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(file.content.toString('base64')),
    ].join('\r\n'))
    text = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...htmlPart, ...files, `--${boundary}--`, ''].join('\r\n')
  }
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
