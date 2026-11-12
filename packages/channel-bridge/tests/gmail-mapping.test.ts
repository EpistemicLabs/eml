import { describe, it, expect } from 'vitest'
import { toInboundMessage, senderAddress, senderVerified, isAutomated, buildReply } from '../src/adapters/gmail/gmail-mapping'
import type { GmailMessage } from '../src/adapters/gmail/gmail-mapping'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

// A hand-made message in the Gmail API's shape, with placeholder people and domains only.
function gmail(over: { headers?: [string, string][]; labelIds?: string[]; parts?: GmailMessage['payload']['parts']; body?: string } = {}): GmailMessage {
  const headers = over.headers ?? [
    ['Authentication-Results', 'mx.google.com; dkim=pass header.i=@shop.example header.s=s1; spf=pass; dmarc=pass (p=NONE) header.from=shop.example'],
    ['From', '"Shop Team" <Team@Shop.Example>'],
    ['Subject', 'Your quote'],
    ['Message-ID', '<abc@shop.example>'],
  ]
  return {
    id: 'g-1',
    threadId: 'th-1',
    labelIds: over.labelIds ?? ['INBOX', 'UNREAD'],
    internalDate: '1762596000000',
    payload: {
      mimeType: over.parts ? 'multipart/alternative' : 'text/plain',
      headers: headers.map(([name, value]) => ({ name, value })),
      body: over.parts ? { size: 0 } : { size: 5, data: b64(over.body ?? 'Hello there') },
      parts: over.parts,
    },
  }
}

describe('toInboundMessage', () => {
  it('maps a mail to the bridge\'s shape', () => {
    expect(toInboundMessage(gmail(), 'acc-1')).toEqual({
      channel: 'mail',
      accountId: 'acc-1',
      channelMessageId: 'g-1',
      threadKey: 'th-1',
      from: 'team@shop.example',
      senderVerified: true,
      automated: false,
      receivedAt: '2025-11-08T10:00:00.000Z',
      subject: 'Your quote',
      text: 'Hello there',
    })
  })

  it('leaves out sent mail, drafts, spam and chats', () => {
    for (const label of ['SENT', 'DRAFT', 'SPAM', 'CHAT']) {
      expect(toInboundMessage(gmail({ labelIds: [label] }), 'acc-1')).toBeNull()
    }
  })

  it('takes the plain text part of a multipart mail, else the html without tags', () => {
    const plain = gmail({ parts: [
      { mimeType: 'text/html', body: { size: 1, data: b64('<p>Html</p>') } },
      { mimeType: 'text/plain', body: { size: 1, data: b64('Plain') } },
    ] })
    expect(toInboundMessage(plain, 'acc-1')?.text).toBe('Plain')
    const html = gmail({ parts: [{ mimeType: 'text/html', body: { size: 1, data: b64('<p>Only&nbsp;html</p>here') } }] })
    expect(toInboundMessage(html, 'acc-1')?.text).toBe('Only html\nhere')
  })
})

describe('senderAddress', () => {
  it('takes the address out of a From header', () => {
    expect(senderAddress('"Name, Inc." <A@B.example>')).toBe('a@b.example')
    expect(senderAddress('a@b.example')).toBe('a@b.example')
  })
})

describe('senderVerified', () => {
  const h = (...values: string[]) => values.map((value) => ({ name: 'Authentication-Results', value }))

  it('trusts a DMARC pass for the sender\'s domain from Gmail\'s own header', () => {
    expect(senderVerified(h('mx.google.com; dmarc=pass header.from=shop.example'), 'x@shop.example')).toBe(true)
  })

  it('trusts a DKIM pass signed by the sender\'s domain or its parent', () => {
    expect(senderVerified(h('mx.google.com; dkim=pass header.i=@shop.example'), 'x@mail.shop.example')).toBe(true)
    expect(senderVerified(h('mx.google.com; dkim=pass header.i=@other.example'), 'x@shop.example')).toBe(false)
  })

  it('reads only the topmost header, the one Gmail added, and only from Gmail', () => {
    expect(senderVerified(h('mx.google.com; dmarc=fail header.from=shop.example', 'mx.google.com; dmarc=pass header.from=shop.example'), 'x@shop.example')).toBe(false)
    expect(senderVerified(h('evil.example; dmarc=pass header.from=shop.example'), 'x@shop.example')).toBe(false)
    expect(senderVerified([], 'x@shop.example')).toBe(false)
  })
})

describe('isAutomated', () => {
  const h = (name: string, value: string) => [{ name, value }]

  it('recognises lists, bulk mail and automatic replies', () => {
    expect(isAutomated(h('List-Unsubscribe', '<mailto:u@shop.example>'))).toBe(true)
    expect(isAutomated(h('List-Id', 'news.shop.example'))).toBe(true)
    expect(isAutomated(h('Precedence', 'bulk'))).toBe(true)
    expect(isAutomated(h('Auto-Submitted', 'auto-replied'))).toBe(true)
    expect(isAutomated(h('Auto-Submitted', 'no'))).toBe(false)
    expect(isAutomated(h('Subject', 'Hello'))).toBe(false)
  })
})

describe('buildReply', () => {
  it('writes a plain text mail with threading headers, encoding what is not ASCII', () => {
    const raw = buildReply({
      from: 'me@home.example', to: 'team@shop.example', subject: 'Re: Grüße', text: 'Danke schön',
      messageId: '<k1@channel-bridge.eml>', inReplyTo: '<abc@shop.example>', references: '<root@shop.example> <abc@shop.example>',
    })
    const mail = Buffer.from(raw, 'base64url').toString('utf8')
    expect(mail).toContain('To: team@shop.example\r\n')
    expect(mail).toContain('Subject: =?UTF-8?B?')
    expect(mail).toContain('In-Reply-To: <abc@shop.example>\r\n')
    expect(mail).toContain('References: <root@shop.example> <abc@shop.example>\r\n')
    expect(mail).toContain('Message-ID: <k1@channel-bridge.eml>\r\n')
    expect(mail).toContain('Content-Type: text/plain; charset=UTF-8')
    const body = mail.split('\r\n\r\n')[1] ?? ''
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Danke schön')
  })

  it('refuses header injection through the recipient or the subject', () => {
    expect(() => buildReply({ from: 'me@home.example', to: 'a@b.example\r\nBcc: x@evil.example', subject: 's', text: 't', messageId: '<k@x>', inReplyTo: null, references: null })).toThrow()
    const raw = buildReply({ from: 'me@home.example', to: 'a@b.example', subject: 'Hi\r\nBcc: x@evil.example', text: 't', messageId: '<k@x>', inReplyTo: null, references: null })
    expect(Buffer.from(raw, 'base64url').toString('utf8')).not.toMatch(/^Bcc:/m)
  })
})
