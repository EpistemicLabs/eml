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
built on it keep working. The cockpit bundles the server as `dist/gmail-mcp.cjs` and starts one per
Google sign-in a space uses, named `gmail` or `gmail-<short name>`, with `GMAIL_ADDRESS`,
`GOOGLE_CREDENTIALS_FILE` (the user's own OAuth Desktop client) and `GOOGLE_TOKEN_FILE` (its refresh
token) from the sign-in. Scopes: gmail.modify, gmail.send, calendar.readonly.

Tests: `pnpm -F @engramprotocol/plugin-gmail-mcp test`, against a local fake of the Google APIs.
