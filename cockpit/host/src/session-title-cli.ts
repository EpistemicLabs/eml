/**
 * cockpit-session-title — a session names itself in the cockpit's sidebar.
 *
 *   node '<path of this file>' '<a few words>'
 *
 * The greeting names the literal path (TITLE_COMMAND), which the space settings allow;
 * $COCKPIT_TITLE_JS holds the same path for anyone calling it by hand.
 *
 * For a session that opened with the cockpit's greeting (session-greeting.ts):
 * the greeting says nothing about what the session is for, so the agent names
 * it once the user's reply does. A title the user chose in the sidebar wins.
 * Reads COCKPIT_SESSION_ID next to the variables host-request.ts needs.
 */
import { fail, requestHost } from './host-request.js'

const CLI = 'cockpit-session-title'

async function main(): Promise<void> {
  const session = process.env.COCKPIT_SESSION_ID
  if (!session) fail(CLI, 'not inside a cockpit session (COCKPIT_SESSION_ID missing)')
  const title = process.argv.slice(2).join(' ').trim()
  if (!title) fail(CLI, 'usage: node "$COCKPIT_TITLE_JS" "<title>"')

  const answer = await requestHost<{ title?: string }>(
    CLI,
    { method: 'PUT', path: `/api/session-title/${encodeURIComponent(session)}` },
    { kind: 'session-title', session, title },
  )
  if (!answer) fail(CLI, `cockpit host unreachable at ${process.env.COCKPIT_URL}`)
  if (answer.status >= 400) fail(CLI, answer.body.error?.message ?? `HTTP ${answer.status}`)
  process.stdout.write(`Session named "${answer.body.title}".\n`)
}

void main()
