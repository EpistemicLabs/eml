import { z } from 'zod'
import { defineChannelAdapter } from '@engramprotocol/channel-bridge-sdk'
import { GmailAccount } from './gmail-account'
import { GoogleRefreshToken } from './google-refresh-token'

export { GmailAccount } from './gmail-account'
export type { GmailAccountOptions } from './gmail-account'
export { GoogleRefreshToken } from './google-refresh-token'
export type { AccessToken, AccessTokens } from './google-refresh-token'

const gmailConfigSchema = z.object({
  type: z.literal('gmail'),
  address: z.string().email(),
  /** An OAuth Desktop app client file and the token file of an existing sign-in; both only read. */
  credentialsFile: z.string().min(1),
  tokenFile: z.string().min(1),
})

/** A Gmail mailbox, signed in with an existing OAuth refresh token. */
export const gmailChannel = defineChannelAdapter({
  type: 'gmail',
  configSchema: gmailConfigSchema,
  create: (config, { accountId, spaces }) =>
    new GmailAccount({
      accountId,
      spaces,
      address: config.address,
      tokens: new GoogleRefreshToken({ credentialsFile: config.credentialsFile, tokenFile: config.tokenFile }),
    }),
})
