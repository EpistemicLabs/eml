# @engramprotocol/mcp-server

MCP wrapper around the EML HTTP API. Exposes the Engram Protocol as MCP tools for Claude Code (and other MCP clients) — stdio transport, Bearer-token auth against an EML server.

## Use

The EML Cockpit bundles this package and wires it into every Claude Code session it starts: the MCP
server, the two hooks and the skills. Nothing to install by hand.

To use an EML server from a plain Claude Code install, register the MCP server with the server URL
and a token:

```bash
claude mcp add eml_brain \
  --env EML_API_URL=http://127.0.0.1:3117 --env EML_API_TOKEN=eml_<prefix><secret> \
  -- npx -y @engramprotocol/mcp-server
```

## Hooks

Three session hooks ship as CLI commands (node only, no bash/curl/jq). They fit any agent CLI with
Claude Code-style hooks (Claude Code, Codex):

```
eml-mcp-server hook session-start      [--config <path>] [--json]
eml-mcp-server hook user-prompt-submit [--config <path>] [--json]
eml-mcp-server hook stop               [--config <path>]
```

- **session-start** reads the client config, POSTs to `/boot` and prints the returned markdown to
  stdout. The agent CLI injects that into the model's context. The hook sends the boot's size
  budget (10,000 characters, the most a Claude Code hook may inject before the output lands in a
  file with only a preview shown; see `BOOT_BUDGET_CHARS`), and the server trims the boot to fit:
  behavior rules get shorter, then are listed by name only, system rules and footer stay. The
  hook log shows what it cost (`trim=none` normally). Fail-soft: a missing config or an
  unreachable server prints a warning and exits 0, so the session continues without the brain.
- **user-prompt-submit** is local only (no HTTP): a short reminder on turn 1, every 5th turn and
  after a pause of more than an hour.
- **stop** asks for the `consolidate` skill's auto mode before the context is compacted, because a
  compaction summary is written to continue the task, not to keep what belongs in the brain. When
  the agent ends a turn, the hook reads the context size from the transcript named in the hook
  input (Claude Code's and Codex's formats). Has the session grown by 250,000 tokens since its last
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

## Tools (v0.17.19)

All tools have an `eml_` prefix. Total: **24 tools**.

### Boot / Recall

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_boot` | `POST /boot` | Manual brain-reload (SessionStart-Hook does this automatically at session start) |
| `eml_recall` | `POST /recall` | Topic search (FTS5 + recency) |

### Write (typed)

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_decide` | `POST /context` (type=decision) | Record a choice between real alternatives (≥ 1 alternative + rationale required; optional `task_id` links it to a task) |
| `eml_set_status` | `POST /context` (type=status) | Set current status for a scope (auto-supersedes old active status) |
| `eml_track_task` | `POST /context` (type=task) | Open a task: status, optional stage, priority, due date; `parent_id` for sub-tasks |
| `eml_task_entry` | `POST /task/:id/entry` | Append a journal entry to a task (progress, step back, hand-off); optional stage change |
| `eml_note` | `POST /context` (kind-discriminated) | Notes (default kind `note`) + rule/profile/event/reference/log; optional `task_id` (e.g. a task's plan) |

**Write-time conflict guardrail (v0.10.9).** A typed write may return an advisory `potential_conflicts` list — active same-scope engrams the write looks likely to duplicate or contradict (FTS-retrieved, term-coverage-gated, top by coverage). The write always succeeds; the field is non-binding and the agent resolves each (supersede / merge / relate / dismiss). Surfaced inline at the write tool, so the prompt to resolve reaches the agent at the moment of the write.

### Read / Find

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_show` | `GET /brain-state?scope=` | Curated snapshot for any scope |
| `eml_list` | `GET /list` | Filter-based engram list |
| `eml_get` | `GET /engram/:id` | Single engram + relations; a task comes with its entries |
| `eml_projects` | `GET /projects` | List projects (filter: status) |
| `eml_entities` | `GET /entities` | List entities (filter: kind) |
| `eml_tags` | `GET /tags` | List the registered tag vocabulary (recall-first before tagging) |
| `eml_subjects` | `GET /subjects` | List subjects with status + member count (recall-first before assigning) |

### Self-awareness / Edit

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_stats` | `GET /stats` | Brain stats (counts per type/scope, container counts) |
| `eml_update` | `POST /update` | Patch engram (status/properties/etc.) |

### Container CRUD

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_project_create` | `POST /project` | Register a project (required before `scope=project.<id>`) |
| `eml_project_update` | `PUT /project/:id` | Patch project fields |
| `eml_entity_create` | `POST /entity` | Register an entity (required before `scope=entity.<id>`) |
| `eml_entity_update` | `PUT /entity/:id` | Patch entity fields |
| `eml_tag_create` | `POST /tag` | Register a tag (required before an engram may carry it) |
| `eml_subject_create` | `POST /subject` | Register a subject (required before an engram may belong to it) |
| `eml_subject_update` | `PUT /subject/:id` | Close / reopen / rename / re-describe a subject |

### Graph

| Tool | HTTP endpoint | Use case |
|---|---|---|
| `eml_relate` | `POST /relate` | Draw a directed semantic edge (source → target, one of 8 verbs); idempotent |

**Tags (v0.12).** Engrams carry registered tags — an abstract, recurring category (`architecture`, `deploy`) orthogonal to scope and type; a tag has no end. Register via `eml_tag_create`, list via `eml_tags`, apply via the `tags` param on the write tools; only registered tags are accepted (unknown → rejected). Filter with `eml_list tag=<id>`.

**Subjects (v0.14; called themes until v0.17).** A subject is a concrete strand with a lifecycle (`v0.14-planning`, `norway-trip`) — what an engram *belongs to*, across scopes. Test: can it be "done"? Then it is a subject, not a tag. Register via `eml_subject_create` (with a description), list via `eml_subjects`, assign via the `subjects` param on the write tools and `eml_update` (replaces the set), close via `eml_subject_update(status=closed)`. Closing keeps the memberships; filing into a closed subject later still works and the write response flags it (`closed_subjects`). Filter with `eml_list subject=<id>`.

**Relations (v0.14 Cluster C).** The semantic graph has three write paths: (1) `properties.supersedes` on a write auto-draws a `supersedes` edge + flips the old engram; (2) a `[[title-or-id]]` wikilink in content auto-materializes a `related_to` edge to the resolved engram on create AND update (add-only, idempotent; unresolved targets come back as `unresolved_links` on the write response); (3) `eml_relate` for explicit typed edges (8 verbs: supports / contradicts / supersedes / derived_from / refines / related_to / blocks / part_of), idempotent, both endpoints must exist; `part_of` only between tasks (no cycles, one parent).

**Tasks (v0.15).** A task carries a piece of work end to end and acts as a hub. `status` says whether it is open, in progress or closed (planned · active · resolved / invalidated — closing needs an `outcome`); the optional `stage` says how mature the work is (ideation → planning → ready → implementation) and freezes when the task closes. What outlives the task gets its own engram, linked by `task_id`: a decision via `eml_decide(task_id)` (`derived_from`), the plan via `eml_note(task_id)` (`refines`); each such write also adds an entry to the task's journal. Progress goes into that journal with `eml_task_entry` (append-only, stamped with time and author), not into rewrites of the task. Sub-tasks link with `parent_id` (`part_of`): a parent can't be resolved while a sub-task is open, invalidating it invalidates them, superseding it lists them. An open task without movement for 30 days gets the `review` label.

### Intentionally not exposed (v0.10.0)

- `eml_confirm_review` — deferred to brain-hygiene cluster
- Session-Awareness tools — deferred to its own future version
- `eml_*_delete` — by design not in the agent action space; cleanup is operator-only

## Error handling

Backend errors (e.g. 401 invalid token, 400 invalid scope) are returned as `isError: true` with a clear message — not as MCP protocol errors. The LLM can self-correct.

Protocol errors (malformed JSON-RPC, unknown tool name) are handled by the SDK.

## License

MIT — see [LICENSE](./LICENSE).
