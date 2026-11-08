# @engramprotocol/channel-bridge

The channel bridge watches mail (later chat) accounts, routes each incoming message to the
cockpit job it belongs to, and holds a job's outgoing messages as drafts until a person approves
them, or sends them directly where the job may. It never runs an agent: it tells the cockpit that a
job has news, and the cockpit wakes the job's session.

The cockpit owns the jobs; the bridge owns messages, cursors, wakes and the outbox.

## Layout

Domain-driven, cut as ports and adapters. Dependencies point inward.

```
src/domain/        rules with no imports from outside: routing, send policy, outbox states, wakes
src/ports/         what the use cases need: channel accounts, stores, the job directory, the cockpit, clock, ids
src/application/   use cases, one per file: sync a channel, dispatch wakes, request a send, approve or skip a draft
src/adapters/      gmail/ (a mailbox through the Gmail API), sqlite/ (the bridge's database),
                   cockpit-http/ (the cockpit's /v1 job routes and wakes),
                   bridge-http/ (the job tools' side of the bridge API), memory/ (fakes for tests),
                   fake-channel/ (scripted accounts)
src/entrypoints/   main (the bridge process), bridge-api (its loopback /v1 API), bridge-loop (sync and wake
                   rounds), mcp-server and job-tools (msg_read and msg_reply for a job's session): wiring only
```

## Running

The cockpit does not start the bridge yet: for now `node dist/entrypoints/main.js` runs it and
`node dist/entrypoints/mcp-server.js` serves one job's tools. Both refuse to start without their
settings; the bridge also needs a non-empty token for at least one space.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CHANNEL_BRIDGE_HOME` | bridge | folder for `bridge.db`, `tool-token` and `cockpit-token` (owner-only, made on first start) and `url`, the bridge's current address |
| `CHANNEL_BRIDGE_PORT` | bridge | loopback port of the bridge API |
| `COCKPIT_URL` | bridge | the cockpit's address |
| `COCKPIT_JOB_TOKENS_DIR` | bridge | one file per space, named after it, holding that space's job token |
| `CHANNEL_BRIDGE_ACCOUNTS_FILE` | bridge | the mailboxes to watch, a JSON list (below) |
| `CHANNEL_BRIDGE_URL_FILE` | job tools | the bridge's `url` file, read at every call |
| `CHANNEL_BRIDGE_JOB_ID` | job tools | the job the session works for, set by the cockpit |
| `CHANNEL_BRIDGE_TOOL_TOKEN_FILE` | job tools | path of the bridge's `tool-token` |

### Accounts

```json
[
  {
    "type": "gmail",
    "accountId": "home-mail",
    "space": "<the space's id>",
    "address": "me@home.example",
    "credentialsFile": "<path to the OAuth Desktop app client file>",
    "tokenFile": "<path to the token file of an existing sign-in>"
  }
]
```

Each account belongs to one space the bridge has a token for. A Gmail account uses an existing
sign-in: the bridge only reads its two files and keeps the access token in memory, so another
program can keep renewing the token file. It needs the Gmail scopes to read, modify and send. On
its first sync it starts from now; when Gmail's history no longer reaches back to the cursor, it
starts again from now and logs a gap. A sign-in Google has withdrawn is logged on every round
until it is renewed.

## The bridge API (/v1, loopback)

| Route | Token | Answer |
| --- | --- | --- |
| `POST /v1/jobs/<jobId>/messages/read` `{ ack }` | tool | the job's messages it has not confirmed; `ack` lists the ids of the last read to confirm them |
| `POST /v1/jobs/<jobId>/messages/<messageId>/reply` `{ text }` | tool | `drafted`, `sent`, `failed` or `refused` |
| `GET /health` | none | `{ ok: true }` once the bridge listens |
| `GET /v1/jobs/<jobId>/drafts` | cockpit | the job's drafts waiting for a person, each with the message it answers |
| `POST /v1/outbox/<id>/edit` `{ text }` | cockpit | changes a draft's text; `edited` or `refused` |
| `POST /v1/outbox/<id>/approve` | cockpit | sends a draft; `sent`, `failed` or `refused` |
| `POST /v1/outbox/<id>/skip` | cockpit | drops a draft; `skipped` or `refused` |

A refusal carries `reason` and `retryable`; 4xx means a retry cannot help, 5xx that it may
(`unavailable` when the cockpit cannot answer, `failed` with `retryable` for a channel that may take
it later). Approving or skipping again answers with the outcome and does nothing twice.

## The cockpit routes the bridge calls (contract v1)

The cockpit owns this contract (`cockpit/host/src/domain/job-contract.ts`); both sides test
against the same examples in `tests/fixtures/job-contract.v1.json`. Every request carries
`Authorization: Bearer <token>` with the token of one space, and reaches only that space's jobs.

| Route | Answer |
| --- | --- |
| `GET /v1/jobs?space=<space>&channel=mail` | the space's open jobs with a mail trigger: `[{ jobId, space, matches, reply }]` |
| `POST /v1/jobs/<jobId>/wake` `{ text, idempotencyKey }` | `{ outcome: 'delivered' \| 'retry' \| 'refused' }` |

The bridge reads routes tolerantly: a match kind or reply mode it does not know is left out or
counts as draft, a route it cannot read is skipped. A wake's text names counts only. The same
`idempotencyKey` twice is one wake. A 4xx other than 408 and 429 refuses a wake; 408, 429, 5xx, an
unreadable answer or an unreachable cockpit retry it.

## Data kept

The bridge's database holds incoming messages (sender, subject, text), outgoing drafts and sends,
sync cursors and open wakes. Nothing is deleted yet; how long messages and drafts are kept is still
to be decided.

## Rules the code holds

- A message is stored once per channel, account and channel message id; a sync moves the cursor
  only after everything is stored.
- Routing: the job that owns the thread, then an exact address, then the sender's domain, and a
  domain only for a verified sender. A tie, no match or an unverified sender goes to the inbox;
  automated mail is ignored.
- A job writes only to its own contacts, even where it may send freely. Its reply setting per
  channel decides between sending and a draft.
- Wakes collect messages for a window after the first; a draft decision wakes at once. A wake the
  cockpit cannot take is retried with a doubling wait, one it refuses is kept as dead.
- Message text comes from outside: a wake names counts only, and the session reads the content
  through its tools as data.
- Logs carry ids, outcomes and sizes, never message content or addresses.

## Tests

`pnpm -F @engramprotocol/channel-bridge test`. Use cases run against the in-memory fakes; each
store port has a contract suite (`tests/contracts/`) that runs against the fake and the SQLite
adapter alike; `tests/scripted-conversation.test.ts` runs a customer job end to end over SQLite.
