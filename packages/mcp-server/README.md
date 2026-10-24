# @engramprotocol/mcp-server

MCP wrapper around the EML HTTP API. Exposes the Engram Protocol as MCP tools for Claude Code (and other MCP clients) — stdio transport, Bearer-token auth against an EML server.

## Use

The EML Cockpit bundles this package and wires it into every Claude Code session it starts: the MCP
server, the hooks and the skills. Nothing to install by hand.

To use an EML server from a plain Claude Code install, register the MCP server with the server URL
and a token:

```bash
claude mcp add eml_brain \
  --env EML_API_URL=http://127.0.0.1:3117 --env EML_API_TOKEN=eml_<prefix><secret> \
  -- npx -y @engramprotocol/mcp-server
```

## Hooks

Four session hooks ship as CLI commands (node only, no bash/curl/jq). They fit any agent CLI with
Claude Code-style hooks (Claude Code, Codex):

```
eml-mcp-server hook session-start      [--config <path>] [--json]
eml-mcp-server hook user-prompt-submit [--config <path>] [--json] [--no-cwd-nudge]
eml-mcp-server hook project-block      [--config <path>] [--json]
eml-mcp-server hook stop               [--config <path>]
```

- **session-start** reads the client config, POSTs to `/boot` and prints the returned markdown to
  stdout. The agent CLI injects that into the model's context. The hook sends the boot's size
  budget (10,000 characters, the most a Claude Code hook may inject before the output lands in a
  file with only a preview shown; see `BOOT_BUDGET_CHARS`). The boot carries the core profiles, the
  rules of global, agent.<self> and user.<self> — always-rules in full, situational rules as an
  index of title + trigger — and the system rules. It always fits: whole entries fall back to
  title + id (situational rules, then always-rules longest first, then profiles beyond the first
  two) and, past that, are left out; nothing is cut mid-text and the system rules are never
  touched. A footer counts what gave way and the legacy entries. The hook log shows what it cost
  (`trim=none` normally, else e.g. `trim=situational:3,always:1`) and how many legacy entries
  await the short format. Fail-soft: a missing config or an
  unreachable server prints a warning and exits 0, so the session continues without the brain.
- **user-prompt-submit** is local only (no HTTP): a short reminder on turn 1, every 5th turn and
  after a pause of more than an hour. It names the working directory's likely project
  (`project.<basename>`); `--no-cwd-nudge` drops that line for a host that delivers the project
  block.
- **project-block** POSTs `EML_PROJECT_SCOPE` (set per session by the host; without it the hook is
  silent) to `/project-block` and prints the project's context: status, the first 10 open tasks
  with a preview and the rest as a count, the latest session log, ALL rules of the project and its
  parent projects (situational as title + trigger, always-rules in full, inherited ones marked),
  and the number of engrams due for review. Its own command, so its own 10,000-character budget;
  whole entries give way (task previews, tasks, the log line, triggers, always-rules), nothing is
  cut mid-text. Register it as a second `SessionStart` command without a matcher: it prints on
  every source (startup, resume, compact, clear), so the block is current after a compaction or a
  resume and the hook keeps no state. A project the brain does not know gets no block.
- **stop** asks for the `consolidate` skill before the context is compacted, because a
  compaction summary is written to continue the task, not to keep what belongs in the brain. When
  the agent ends a turn, the hook reads the context size from the transcript named in the hook
  input (Claude Code's and Codex's formats). Has the session grown by 150,000 tokens since its last
  save point, it blocks the stop once (`{"decision":"block","reason"}`), and the agent consolidates
  in the same turn — before the session goes idle, where it can be compacted with nobody there to
  give the agent a turn. A turn continued this way (`stop_hook_active`) is let through. With an
  unreadable transcript the hook stays silent.
- **After a compaction** `session-start` (`source: "compact"`) puts a hint with the transcript's
  path before the boot and takes its length off the boot's budget.
- **`--json`** prints the context in the hook JSON envelope
  (`{ "hookSpecificOutput": { "hookEventName", "additionalContext" } }`) instead of plain text. Codex
  needs it: it reads stdout that starts with `[` or `{` as JSON, and the reminder starts with
  `[EML Reminder]`. Claude Code takes both forms.

`--config` defaults to the path in `EML_HOOK_CONFIG`, then `~/.eml/config` (`key=value` lines: `EML_URL`, `EML_API_TOKEN`; parsed as
data, never evaluated). Logs, the reminder's turn counters and the save points live
next to the config file, so one config directory is one isolated EML client.

## Tools (v0.20.4)

All tools have an `eml_` prefix. Total: **22 tools**. Every tool schema is strict: an unknown parameter is an error, not silently dropped, and the server checks the same fields again (core enforces them for MCP, REST and CLI alike). An older client that still sends removed tools or fields (`significance`, `properties`, `kind`, …) gets an error asking to upgrade `@engramprotocol/mcp-server` to ≥ 0.19.

### Read

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_boot` | `POST /boot` | Manual brain-reload (the SessionStart hook does this at session start) |
| `eml_recall` | `POST /recall` | Topic search (FTS5 + recency) |
| `eml_show` | `GET /brain-state?scope=` | Curated snapshot for a scope: status (+ what it tracks), open tasks, latest log and its next step, rules (situational with trigger), ripe learnings, metadata |
| `eml_list` | `GET /list` | Filter-based engram list (type, scope, status, tag, subject, review_due, task_id, binding, …) |
| `eml_get` | `GET /engram/:id` | One engram with its entries: a task's journal and bound items, a learning's evidence and ripeness, review confirmations |
| `eml_stats` | `GET /stats` | Brain stats (counts per type/scope, container counts) |

### Create — one tool per engram type

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_decide` | `POST /engram/decision` | A choice between real alternatives (rationale + ≥ 1 alternative); with `task_id` also `binding` (task · standing) |
| `eml_set_status` | `POST /engram/status` | The current state of a scope; every call a new version, the previous one superseded |
| `eml_create_task` | `POST /engram/task` | Open a piece of work (title required; planned or active; `parent_id` for sub-tasks; `supersedes` hands over bound items) |
| `eml_note` | `POST /engram/note` | A thought that lives in the brain; a task's plan with `task_id` + `binding` |
| `eml_rule` | `POST /engram/rule` | A way of working the user agreed to (`agreed`, `why` required; `from_learning`) |
| `eml_event` | `POST /engram/event` | Something that happened at a point in time (`occurred_at`, `change_type`); corrected, never superseded |
| `eml_reference` | `POST /engram/reference` | A pointer to something outside the brain (`source` required) |
| `eml_log` | `POST /engram/log` | The session log, one per session: `what`, `landed`, `next`, `open_threads` (rendered as START HERE) |
| `eml_profile` | `POST /engram/profile` | A facet of who someone is; `core: true` is the identity the boot loads |
| `eml_learning` | `POST /learning` | A lesson about how to work, backed by evidence; one per topic (server-side topic check), ripeness in the response |

**Write-time conflict guardrail (v0.10.9).** A write may return an advisory `potential_conflicts` list — active same-scope engrams the write looks likely to duplicate or contradict (FTS-retrieved, term-coverage-gated). Since v0.19 events are compared with events (same `change_type`, close `occurred_at`) and new tasks also with planned ones. The write always succeeds; the agent resolves each (supersede / merge / relate / dismiss).

### Change

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_track_task` | `POST /task/:id/track` | Everything about an existing task: progress, stage, start, close (`outcome` + `text`, `keep` for bound items), reopen, edits, a move (`scope`), replacing other open tasks (`supersedes`) — each call writes the journal |
| `eml_update` | `POST /update` | Correct or retire any engram except a task; only its type's fields, `null` clears; `supersedes` after the fact (across types); `review_note` confirms a review |
| `eml_relate` | `POST /relate` | A directed semantic edge (supports / contradicts / derived_from / refines / related_to / blocks); idempotent |

### Objects

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_read_object` | `GET /object/:object` | Projects, entities, tags, subjects, users or agents with usage counts, or one by id |
| `eml_create_object` | `POST /object/:object` | Register a project, entity (required before its scope), tag, subject, user or agent |
| `eml_update_object` | `PUT /object/:object/:id` | Patch one (status, status_tracks, metadata, archive a tag, close a subject …); the response shows the diff |

**Tags and subjects.** A tag is what an engram is *about* (`architecture`, `deploy`) and never ends; a subject is the strand it *belongs to* (`v0.14-planning`) and closes when the strand is over. Both are registered objects (`eml_create_object`), listed with `eml_read_object`, applied via the `tags` / `subjects` params on the write tools; only registered ones are accepted. An archived tag stays on the engrams that carry it but is not assigned anew; filing into a closed subject still works and the response flags it (`closed_subjects`).

**Relations.** Three write paths: (1) `supersedes` on a write (or `eml_update(new, supersedes=[old])` when both exist) draws a `supersedes` edge and flips the old engram; (2) a `[[title-or-id]]` wikilink in content materializes a `related_to` edge (add-only; unresolved targets come back as `unresolved_links`); (3) `eml_relate` for explicit typed edges. `part_of` comes only from a task's `parent_id`.

**Tasks.** A task carries a piece of work end to end and acts as a hub. `status` says whether it is open, in progress or closed (planned · active · resolved / invalidated — closing needs an `outcome` and a `text`); the optional `stage` says how mature the work is and freezes while the task is closed. Decisions and notes written with `task_id` say whether they outlive the task (`binding: standing`) or close with it (`binding: task`); closing lists the bound ones and `keep` turns the ones that still hold into standing. The journal holds note entries (written by the agent) and change entries (one per field change, written by the server). An active task without movement for 30 days is `review_due`; a planned one is backlog.

**Learnings and rules.** A rule is only written with the user's yes (`agreed`). What the agent notices itself — a correction, a turned-down proposal, its own mistake — is a learning: one engram per topic, each incident an evidence entry. It is ripe with supporting evidence from two sessions, one of it from the user, and no open contradiction; then the agent asks the user whether to make it a rule (`eml_rule from_learning=[id]`).

**Provenance.** The MCP server stamps every write with the session (the cockpit's or Claude Code's session id), the harness (the MCP client) and, when it can know it, the model; the server adds the token's handle as `ingested_by`.

### Intentionally not exposed

- Session-awareness tools — deferred to their own version
- Agents and users — managed by setup and the cockpit
- `eml_*_delete` — by design not in the agent action space; cleanup is operator-only

## Error handling

Backend errors (e.g. 401 invalid token, 400 invalid scope) are returned as `isError: true` with a clear message — not as MCP protocol errors. The LLM can self-correct.

Protocol errors (malformed JSON-RPC, unknown tool name) are handled by the SDK.

## License

MIT — see [LICENSE](./LICENSE).
