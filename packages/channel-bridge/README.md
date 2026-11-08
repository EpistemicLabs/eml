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
src/adapters/      sqlite/ (the bridge's database), memory/ (fakes for tests), fake-channel/ (scripted accounts)
```

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
