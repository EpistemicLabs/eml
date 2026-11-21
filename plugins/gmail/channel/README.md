# gmail plugin — channel part

A Gmail mailbox as a channel bridge account, through the Gmail API: history since a cursor, and
plain text replies in the mail's thread. It implements the contract in
`packages/channel-bridge-sdk` and is exported as `gmailChannel` (accounts file `type: "gmail"`);
the bridge lists it in `packages/channel-bridge/src/entrypoints/channel-adapters.ts`.

An account entry names the mailbox's `address`, an OAuth Desktop app client file
(`credentialsFile`) and the token file of an existing sign-in (`tokenFile`); both files are only
read, so another program can keep renewing the token. See `packages/channel-bridge/README.md` for
the accounts file.

Tests: `pnpm -F @engramprotocol/plugin-gmail-channel test`, against a local fake of the Gmail API
(`tests/support/fake-gmail.ts`), including the SDK's channel account contract.
