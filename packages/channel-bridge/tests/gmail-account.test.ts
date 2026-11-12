import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GmailAccount } from '../src/adapters/gmail/gmail-account'
import { GoogleRefreshToken } from '../src/adapters/gmail/google-refresh-token'
import { ScriptedChannel } from '../src/adapters/fake-channel/scripted-channel'
import { FakeGmail, gmailMessage } from './support/fake-gmail'
import { channelAccountContract } from './contracts/channel-account-contract'

let gmail: FakeGmail
let dir: string

async function account(): Promise<GmailAccount> {
  return new GmailAccount({
    accountId: 'acc-gmail', space: 'errands', address: 'me@home.example', apiBase: gmail.url,
    tokens: new GoogleRefreshToken({ credentialsFile: join(dir, 'credentials.json'), tokenFile: join(dir, 'token.json') }),
  })
}

beforeEach(async () => {
  gmail = new FakeGmail()
  await gmail.start()
  dir = mkdtempSync(join(tmpdir(), 'channel-bridge-gmail-'))
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'client-1', client_secret: 'secret-1', token_uri: `${gmail.url}/token` } }))
  writeFileSync(join(dir, 'token.json'), JSON.stringify({ refresh_token: 'refresh-1', token: 'stale', client_id: 'client-1' }))
})
afterEach(async () => {
  await gmail.stop()
  rmSync(dir, { recursive: true, force: true })
})

channelAccountContract('scripted', async () => {
  const channel = new ScriptedChannel('acc-1', 'support')
  return {
    account: channel,
    arrive: (id) => channel.receive({
      channelMessageId: id, threadKey: `t-${id}`, from: 'team@shop.example', senderVerified: true, automated: false,
      receivedAt: '2026-11-08T10:00:00.000Z', subject: 'Hi', text: 'Hello',
    }),
  }
})
channelAccountContract('gmail', async () => ({ account: await account(), arrive: (id) => gmail.deliver(gmailMessage(id)) }))

describe('GmailAccount', () => {
  it('follows history pages and skips its own sent mail', async () => {
    const a = await account()
    const start = await a.sync(null)
    if (start.kind !== 'synced') throw new Error('expected synced')
    gmail.deliver(gmailMessage('m-1'))
    gmail.deliver({ ...gmailMessage('m-2'), labelIds: ['SENT'] })
    gmail.deliver(gmailMessage('m-3'))
    const next = await a.sync(start.cursor)
    expect(next.kind === 'synced' && next.messages.map((m) => m.channelMessageId)).toEqual(['m-1', 'm-3'])
  })

  it('starts again from now and reports a gap when the history has expired', async () => {
    const a = await account()
    const start = await a.sync(null)
    if (start.kind !== 'synced') throw new Error('expected synced')
    gmail.deliver(gmailMessage('m-1'))
    gmail.expireHistory()
    expect(await a.sync(start.cursor)).toMatchObject({ kind: 'synced', messages: [], gap: true })
  })

  it('reports a revoked grant as unavailable for good, and Gmail failures as retryable', async () => {
    const a = await account()
    gmail.failWith(503)
    expect(await a.sync('100')).toEqual({ kind: 'unavailable', reason: 'unreachable', retryable: true })
    gmail.failWith(429)
    expect(await a.sync('100')).toEqual({ kind: 'unavailable', reason: 'rate_limited', retryable: true })
    gmail.failWith(null)
    gmail.revoke()
    const fresh = await account()
    expect(await fresh.sync('100')).toEqual({ kind: 'unavailable', reason: 'access_revoked', retryable: false })
  })

  it('replies in the thread with its headers, from the account\'s address', async () => {
    gmail.deliver(gmailMessage('m-1', { threadId: 'th-9' }))
    const a = await account()
    expect(await a.send({ to: 'team@shop.example', threadKey: 'th-9', subject: 'Re: Quote', text: 'Thanks', idempotencyKey: 'k-9' })).toMatchObject({ kind: 'sent' })
    const sent = gmail.sent[0]
    expect(sent?.threadId).toBe('th-9')
    const mail = Buffer.from(sent?.raw ?? '', 'base64url').toString('utf8')
    expect(mail).toContain('From: me@home.example\r\n')
    expect(mail).toContain('In-Reply-To: <m-1@shop.example>\r\n')
    expect(mail).toContain('References: <m-1@shop.example>\r\n')
  })

  it('refuses a recipient that is not a plain address without calling Gmail', async () => {
    const a = await account()
    expect(await a.send({ to: 'a@b.example\r\nBcc: x@evil.example', threadKey: null, subject: 's', text: 't', idempotencyKey: 'k' }))
      .toEqual({ kind: 'failed', reason: 'invalid_recipient', retryable: false })
    expect(gmail.sent).toEqual([])
  })

  it('never writes the sign-in files it reads', async () => {
    const before = readFileSync(join(dir, 'token.json'), 'utf8')
    const a = await account()
    await a.sync(null)
    expect(readFileSync(join(dir, 'token.json'), 'utf8')).toBe(before)
  })
})
