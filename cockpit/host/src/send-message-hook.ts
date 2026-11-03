/**
 * The SendMessage hook — what Claude Code runs before every SendMessage
 * (isolation.ts, sendMessageHookCommand):
 *
 *   node send-message-hook.js
 *
 * Asks the host to take the message if the target has stopped. If it did, the
 * call is cancelled with a result that says so, else SendMessage goes ahead.
 * URL, token and the sender's id and address come from the session's env. Never fails:
 * whatever goes wrong here, SendMessage runs as it would without the hook.
 */
import { wakeRequest, wakeResult } from './domain/send-message-wake.js'

/** Shorter than the hook's own timeout (SEND_MESSAGE_HOOK_OPTIONS). */
const TIMEOUT_MS = 30_000

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const request = wakeRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const { COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: token, COCKPIT_SESSION_ADDRESS: from, COCKPIT_SESSION_ID: session } = process.env
  if (!request || !url || !token || !session) return
  const res = await fetch(`${url}/api/sessions/${encodeURIComponent(request.target)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cockpit-Token': token },
    body: JSON.stringify({ text: request.text, from, onlyIfStoppedFor: session }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const { outcome } = await res.json() as { outcome?: unknown }
  const result = wakeResult(outcome, request, from)
  if (result) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result } }))
}

main().catch(() => {}).finally(() => { process.exitCode = 0 })
