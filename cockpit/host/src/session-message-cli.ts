/**
 * cockpit-session-message — send another cockpit session a message.
 *
 *   node "$COCKPIT_MESSAGE_JS" <address> '<text>'
 *
 * Reaches a stopped session too: the host resumes it first. SendMessage does the same
 * through its hook (send-message-hook.ts); this is for scripts and sessions without it.
 * Reads COCKPIT_SESSION_ADDRESS next to the variables host-request.ts needs.
 */
import { fail, requestHost } from './host-request.js'

const CLI = 'cockpit-session-message'

async function main(): Promise<void> {
  const [target, ...words] = process.argv.slice(2)
  const text = words.join(' ').trim()
  if (!target || !text) fail(CLI, `usage: node "$COCKPIT_MESSAGE_JS" <address> '<text>'`)
  const from = process.env.COCKPIT_SESSION_ADDRESS

  const answer = await requestHost<{ outcome?: string }>(
    CLI,
    { method: 'POST', path: `/api/sessions/${encodeURIComponent(target)}/message` },
    { kind: 'session-message', target, text, from },
  )
  if (!answer) fail(CLI, `cockpit host unreachable at ${process.env.COCKPIT_URL}`)
  if (answer.status === 409) fail(CLI, 'that session cannot take it right now (it runs in a terminal, or is switching); try again later, or use SendMessage')
  if (answer.status >= 400) fail(CLI, answer.body.error?.message ?? answer.body.outcome ?? `HTTP ${answer.status}`)
  process.stdout.write(`Message ${answer.body.outcome}.\n`)
}

void main()
