import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { serveShared } from '../src/http'
import { GoogleApi } from '../src/google-api'
import { createGmailServer } from '../src/server'
import { Calendar, Mailbox, addressesOf } from '../src/tools'

// The gmail plugin's MCP part against a local fake of the Gmail and Calendar APIs. Every address
// and text is a placeholder.

const b64 = (text: string) => Buffer.from(text).toString('base64url')
const msg = (id: string, from: string, subject: string, labels = ['INBOX']) => ({
  id, threadId: `t-${id}`, labelIds: labels, snippet: `about ${subject}`,
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: from }, { name: 'To', value: 'Me <me@work.example>, colleague@work.example' },
      { name: 'Cc', value: 'boss@client.example' }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Sat, 21 Nov 2026 10:00:00 +0000' },
      { name: 'Message-ID', value: `<${id}@client.example>` },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Hello, can we meet?') } },
      { mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'att-1', size: 3 } },
    ],
  },
})

let server: Server
let base: string
let dir: string
const sent: Array<{ raw: string; threadId?: string }> = []
const modified: Array<{ id: string; removeLabelIds: string[] }> = []
let lastQuery = ''
let failArchive = false

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gmail-mcp-test-'))
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      const p = url.pathname
      if (p === '/gmail/v1/users/me/messages') { lastQuery = url.searchParams.get('q') ?? ''; return json({ messages: [{ id: 'm1' }] }) }
      if (p === '/gmail/v1/users/me/messages/m1') return json(msg('m1', 'Anna <anna@client.example>', 'Meeting'))
      if (p === '/gmail/v1/users/me/messages/m1/attachments/att-1') return json({ data: b64('PDF') })
      if (p === '/gmail/v1/users/me/messages/send') { sent.push(JSON.parse(body)); return json({ id: 'sent-1', threadId: JSON.parse(body).threadId ?? 'new' }) }
      if (p === '/gmail/v1/users/me/threads/t-m1') {
        if (failArchive) { res.writeHead(500); return res.end('{}') }
        return json({ messages: [{ id: 'm1', labelIds: ['INBOX'] }, { id: 'm0', labelIds: [] }] })
      }
      if (p === '/gmail/v1/users/me/messages/odd') return json({ unexpected: true })
      if (p === '/calendar/v3/calendars/scoped/events') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } })) }
      const modify = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(p)
      if (modify) { modified.push({ id: modify[1], ...JSON.parse(body) }); return json({}) }
      if (p.startsWith('/gmail/v1/users/me/settings/sendAs/')) return json({ signature: '<b>Me</b> · Work' })
      if (p === '/calendar/v3/calendars/primary/events') return json({ items: [{ id: 'e1', summary: 'Call', start: { dateTime: '2026-11-23T10:00:00+01:00' }, end: { dateTime: '2026-11-23T10:30:00+01:00' }, attendees: [{ email: 'anna@client.example', responseStatus: 'accepted' }] }] })
      if (p === '/calendar/v3/freeBusy') return json({ calendars: { primary: { busy: [{ start: '2026-11-23T09:00:00Z', end: '2026-11-23T10:00:00Z' }] } } })
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

const api = () => new GoogleApi({ get: async () => ({ kind: 'token', token: 't' }), forget: () => undefined }, base)
const mailbox = () => new Mailbox({ api: api(), address: 'me@work.example', attachmentsDir: dir })
const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

describe('Mailbox', () => {
  it('lists unanswered and found mail in the agreed text format', async () => {
    expect(await mailbox().unanswered(3, 5)).toBe('Found 1 unanswered emails:\n\nID: m1\nFrom: Anna <anna@client.example>\nSubject: Meeting\nDate: Sat, 21 Nov 2026 10:00:00 +0000\nSnippet: about Meeting')
    expect(lastQuery).toBe('is:inbox -is:replied newer_than:3d')
    expect(await mailbox().search('from:anna')).toMatch(/^Found 1 emails:/)
  })

  it('reads a mail with its text and saves its attachments', async () => {
    const text = await mailbox().read('m1')
    expect(text).toContain('Thread ID: t-m1')
    expect(text).toContain('Hello, can we meet?')
    const saved = join(dir, 'm1', 'offer.pdf')
    expect(text).toContain(saved)
    expect(readFileSync(saved, 'utf8')).toBe('PDF')
  })

  it('replies to the sender with the others in copy, in the thread, signed and quoted, then archives the thread', async () => {
    sent.length = 0
    modified.length = 0
    const answer = await mailbox().reply('m1', 'Yes, Monday at 10.')
    expect(answer).toBe('Reply sent & thread archived. Message ID: sent-1, Thread ID: t-m1')
    const raw = decodeRaw(sent[0].raw)
    expect(sent[0].threadId).toBe('t-m1')
    expect(raw).toContain('To: anna@client.example\r\n')
    expect(raw).toContain('Cc: colleague@work.example, boss@client.example\r\n')
    expect(raw).toContain('Subject: Re: Meeting\r\n')
    expect(raw).toContain('In-Reply-To: <m1@client.example>\r\n')
    const html = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
    expect(html).toContain('Yes, Monday at 10.')
    expect(html).toContain('<b>Me</b> · Work')
    expect(html).toContain('Hello, can we meet?')
    expect(modified).toEqual([{ id: 'm1', removeLabelIds: ['INBOX'] }])
  })

  it('sends a new mail with an attachment and a non-ASCII subject', async () => {
    sent.length = 0
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'hi')
    expect(await mailbox().send('anna@client.example', 'Grüße', 'Hallo', '', file)).toBe('Email sent successfully with 1 attachment(s). Message ID: sent-1')
    const raw = decodeRaw(sent[0].raw)
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain('Content-Disposition: attachment; filename="note.txt"')
    expect(await mailbox().send('a@b.example', 's', 'b', '', join(dir, 'missing.pdf'))).toBe(`Attachment not found: ${join(dir, 'missing.pdf')}`)
  })

  it('archives a message, and says so when it was not in the inbox', async () => {
    expect(await mailbox().doneMessage('m1')).toBe('Message m1 moved to Done.')
    expect(await mailbox().doneThread('t-m1')).toBe('Thread t-m1 moved to Done. Archived 1 message(s).')
  })

  it('says a send Google did not answer may have gone out, rather than inviting a second one', async () => {
    const away = new Mailbox({ api: new GoogleApi({ get: async () => ({ kind: 'token', token: 't' }), forget: () => undefined }, 'http://127.0.0.1:1'), address: 'me@work.example', attachmentsDir: dir })
    expect(await away.send('anna@client.example', 'Hi', 'Hello')).toContain('may have been sent')
  })

  it('reports a reply as sent when only archiving the thread failed', async () => {
    failArchive = true
    try {
      const answer = await mailbox().reply('m1', 'Thanks')
      expect(answer).toMatch(/^Reply sent\. Message ID: sent-1, Thread ID: t-m1\. Archiving the thread failed: /)
    } finally {
      failArchive = false
    }
  })

  it('answers with a refusal, not a crash, for an unknown answer shape or a missing scope', async () => {
    expect(await mailbox().read('odd')).toBe('Google answered in a form this tool does not know.')
    expect(await new Calendar(api()).events('2026-11-23T00:00:00Z', '2026-11-24T00:00:00Z', 'scoped')).toContain('sign in again')
  })

  it('reads addresses out of header lists', () => {
    expect(addressesOf('Anna <ANNA@client.example>, bob@x.example, nobody')).toEqual(['anna@client.example', 'bob@x.example'])
  })
})

describe('Calendar', () => {
  it('lists events and busy times', async () => {
    const calendar = new Calendar(api())
    expect(await calendar.events('2026-11-23T00:00:00+01:00', '2026-11-24T00:00:00+01:00')).toContain('Call\n  With: anna@client.example (accepted)')
    expect(await calendar.freeBusy('2026-11-23T00:00:00Z', '2026-11-24T00:00:00Z')).toBe('primary busy:\n  2026-11-23T09:00:00Z – 2026-11-23T10:00:00Z')
  })
})

describe('the MCP server', () => {
  it('offers the mail and calendar tools', async () => {
    const mcp = createGmailServer({ GMAIL_ADDRESS: 'me@work.example', GMAIL_ATTACHMENTS_DIR: dir }, api())
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverSide)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(clientSide)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['calendar_events', 'calendar_freebusy', 'done_message', 'done_thread', 'get_unanswered_emails', 'read_email', 'reply_to_email', 'search_emails', 'send_email'])
    const result = await client.callTool({ name: 'search_emails', arguments: { query: 'from:anna' } })
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/^Found 1 emails/)
    await client.close()
  })

  it('refuses to start without its mailbox and sign-in', () => {
    expect(() => createGmailServer({})).toThrow('GMAIL_ADDRESS')
  })
})

describe('the shared server', () => {
  const connect = async (url: string, key: string) => {
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }))
    return client
  }

  it('serves several sessions from one process on one sign-in', async () => {
    const google = api()
    const shared = await serveShared({ key: 'k'.repeat(32), newServer: () => createGmailServer({ GMAIL_ADDRESS: 'me@work.example', GMAIL_ATTACHMENTS_DIR: dir }, google) })
    const url = `http://127.0.0.1:${shared.port}/mcp`
    try {
      const [a, b] = await Promise.all([connect(url, 'k'.repeat(32)), connect(url, 'k'.repeat(32))])
      expect(shared.sessions()).toBe(2)
      expect((await a.listTools()).tools).toHaveLength(9)
      const result = await b.callTool({ name: 'search_emails', arguments: { query: 'from:anna' } })
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(/^Found 1 emails/)
      await a.close()
      await b.close()
    } finally {
      await shared.close()
    }
  })

  it('refuses a wrong key and an unknown session', async () => {
    const shared = await serveShared({ key: 'k'.repeat(32), newServer: () => createGmailServer({ GMAIL_ADDRESS: 'me@work.example' }, api()) })
    const url = `http://127.0.0.1:${shared.port}/mcp`
    try {
      await expect(connect(url, 'wrong')).rejects.toThrow()
      const post = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401)
      expect((await post({ authorization: `Bearer ${'k'.repeat(32)}`, 'mcp-session-id': 'gone' })).status).toBe(404)
      expect((await post({ authorization: `Bearer ${'k'.repeat(32)}` })).status).toBe(400)
      expect(shared.sessions()).toBe(0)
    } finally {
      await shared.close()
    }
  })
})
