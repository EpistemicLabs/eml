/**
 * The task hook — a SessionStart command next to the EML boot (isolation.ts,
 * codex/index.ts, taskHookCommand):
 *
 *   node task-hook.js
 *
 * Task system (application/session-task.ts): the host gives a session its
 * task, creating one when there is none, and this prints the task and the
 * handoff the session ends with. When the host answers with nothing, the hook
 * prints nothing. Never fails: the
 * session starts as before whatever goes wrong here.
 */

/** Shorter than the hook's own timeout (TASK_HOOK_OPTIONS). */
const TIMEOUT_MS = 8_000

async function main(): Promise<void> {
  // The start event comes on stdin; nothing in it changes the task, but the CLI expects it read.
  for await (const _chunk of process.stdin) { /* drain */ }
  const { COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: token, COCKPIT_SESSION_ID: session } = process.env
  if (!url || !token || !session) return
  const res = await fetch(`${url}/api/session-task`, {
    method: 'POST',
    headers: { 'X-Cockpit-Token': token, 'X-Cockpit-Session': session },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return
  const { text } = await res.json() as { text?: unknown }
  if (typeof text !== 'string' || !text) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
}

main().catch(() => {}).finally(() => { process.exitCode = 0 })
