# Recorded `codex app-server` sessions

What `codex app-server` (codex-cli 0.172.0) and a client said to each other over stdio, one
message per line: `{"dir":"out","msg":…}` is what the client wrote, `{"dir":"in","msg":…}` what the
server wrote. The messages are as they were on the wire (JSON-RPC without the `"jsonrpc"` field).
The tests of the Codex chat runtime play them (`codex-app-server-client.test.ts`,
`codex-event-mapper.test.ts`).

| File | What it holds |
| --- | --- |
| `handshake.jsonl` | `initialize`, `initialized`, `model/list` |
| `turn-approval.jsonl` | A new thread and one turn: commentary, a command that asks for approval and is accepted, the final answer |
| `interrupt.jsonl` | A turn stopped with `turn/interrupt` while its answer streams |
| `history.jsonl` | `thread/turns/list` with `itemsView: "full"` for a thread of four turns, newest first |

They are cut down and scrubbed, not raw recordings:

- Paths are placeholders: `/workspace/project` (the session's folder), `/codex-home` (CODEX_HOME),
  `/cockpit-home`. The host's OS version in `userAgent`, local ports and the process id are placeholders too.
- Everything about the account is left out: the `account/read` exchange (the request after it is
  renumbered), `account/updated` and `account/rateLimits/updated`.
- Left out as noise for these tests: `hook/started`, `hook/completed`, `configWarning`,
  `remoteControl/status/changed`, `deprecationNotice`, `thread/goal/cleared`, and the recorder's own
  timing fields.
- A run of `item/agentMessage/delta` keeps its first three, so the deltas of a message do not add
  up to its complete text.
- `model/list` keeps two models.

Thread, turn and item ids are the random ones of the recording.
