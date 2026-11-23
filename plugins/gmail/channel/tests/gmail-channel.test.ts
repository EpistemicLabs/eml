import { describe, it, expect } from 'vitest'
import { gmailChannel, GmailAccount } from '../src'

describe('gmailChannel', () => {
  it('creates a mailbox account from an accounts file entry', () => {
    const config = gmailChannel.configSchema.parse({
      type: 'gmail', accountId: 'a', spaces: ['support'], address: 'me@home.example', credentialsFile: '/x', tokenFile: '/y',
    })
    const account = gmailChannel.create(config, { accountId: 'a', spaces: ['support', 'sales'] })
    expect(account).toBeInstanceOf(GmailAccount)
    expect(account).toMatchObject({ channel: 'mail', accountId: 'a', spaces: ['support', 'sales'] })
  })

  it('refuses an entry without its sign-in files or with a bad address', () => {
    expect(gmailChannel.configSchema.safeParse({ type: 'gmail', address: 'me@home.example' }).success).toBe(false)
    expect(gmailChannel.configSchema.safeParse({ type: 'gmail', address: 'nope', credentialsFile: '/x', tokenFile: '/y' }).success).toBe(false)
  })
})
