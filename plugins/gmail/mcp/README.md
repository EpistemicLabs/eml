# gmail plugin — MCP part

Mail and calendar tools for a person's own sessions, on the user's Google sign-in (the same
connection as the gmail plugin's channel part). A job's session never gets them: jobs send through
the channel bridge's outbox.

| Tool | What it does |
| --- | --- |
| `get_unanswered_emails` | inbox mail not replied to, from the last days |
| `search_emails` | a Gmail search query |
| `read_email` | a whole mail; its attachments saved to local files |
| `send_email` | a new mail, with the mailbox's own Gmail signature |
| `reply_to_email` | a reply to the sender, the others in copy, quoted, in its thread; then archives the thread |
| `done_thread`, `done_message` | out of the inbox ("Done"), nothing deleted |
| `calendar_events`, `calendar_freebusy` | events in a window; when calendars are busy |

The mail tools keep the names, arguments and answers of the Gmail MCP server they replace, so skills
built on it keep working. The cockpit bundles the server as `dist/gmail-mcp.cjs` and runs one per
Google sign-in for all sessions of the machine (the manifest's mcp part is `shared`), with
`GMAIL_ADDRESS`, `GOOGLE_CREDENTIALS_FILE` (the user's own OAuth Desktop client or a service-account
key) and `GOOGLE_TOKEN_FILE` (its refresh token) from the sign-in. Sessions reach it as `gmail` or
`gmail-<short name>` through the cockpit's relay (`/mcp-relay/<sign-in id>`), so a session no longer
starts processes of its own. Scopes: gmail.modify, gmail.send, calendar.readonly.

Two modes (`src/main.ts`):

- **stdio** (no `EML_MCP_HTTP_KEY`): one session's own server, as any stdio MCP server.
- **shared** (`EML_MCP_HTTP_KEY` set, `src/http.ts`): Streamable HTTP on 127.0.0.1 with a random port,
  every request with that key as bearer token, one MCP session per Claude session on one Google
  sign-in; it writes `EML_MCP_LISTENING <port>` to stdout and ends when its stdin closes. The cockpit
  (`cockpit/host/src/infrastructure/plugins/shared-mcp.ts`) starts it on the first call, starts it
  again when it ended or the sign-in changed, and ends it with the sign-in; a session whose server was
  restarted gets a 404 for its old MCP session and opens a new one.

Tests: `pnpm -F @engramprotocol/plugin-gmail-mcp test`, against a local fake of the Google APIs.
