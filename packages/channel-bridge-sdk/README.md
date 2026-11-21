# @engramprotocol/channel-bridge-sdk

The contract between the channel bridge (`packages/channel-bridge`) and a plugin's channel part:
what a channel account is, the shape of the messages it hands over and takes, and the adapter the
bridge creates accounts with.

- `ChannelAccount`: one account on one channel (a mailbox, later a number). `sync(cursor)` returns
  the messages since the cursor as `InboundMessage`s with the next cursor, or says the channel is
  `unavailable` and whether asking again can help; `send(message)` sends an `OutgoingMessage` once
  per `idempotencyKey`.
- `ChannelAdapter`: `{ type, configSchema, create(config, { accountId, space }) }`. The bridge picks
  the adapter by an accounts file entry's `type`, checks the entry with `configSchema` and creates
  the account. `defineChannelAdapter` keeps the config type checked where the adapter is declared.
- `normalizeMailAddress`, `domainOf`: how mail addresses compare.
- `@engramprotocol/channel-bridge-sdk/testing`: `channelAccountContract`, the suite every channel
  account must pass. Call it from the plugin's tests with the runner's `describe`, `it` and `expect`.

Message text from outside is untrusted: a channel maps it to `text` as data, and the bridge never
hands it to a session as instructions.
