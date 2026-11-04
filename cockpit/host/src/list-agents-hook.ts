/**
 * The ListAgents hook — what Claude Code runs after every ListAgents
 * (isolation.ts, listAgentsHookCommand):
 *
 *   node list-agents-hook.js
 *
 * ListAgents shows running sessions only, by address. This adds the cockpit
 * sessions the caller can message, stopped ones too, with their names and what
 * they are about (domain/session-directory.ts). Never fails: whatever goes
 * wrong here, the agent reads ListAgents' own result.
 */

/** Shorter than the hook's own timeout (LIST_AGENTS_HOOK_OPTIONS). */
const TIMEOUT_MS = 8_000

async function main(): Promise<void> {
  // The call comes on stdin; nothing in it changes the list, but Claude Code expects it read.
  for await (const _chunk of process.stdin) { /* drain */ }
  const { COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: token, COCKPIT_SESSION_ID: session } = process.env
  if (!url || !token || !session) return
  const res = await fetch(`${url}/api/session-directory?list=recent`, {
    headers: { 'X-Cockpit-Token': token, 'X-Cockpit-Session': session },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return
  const { text } = await res.json() as { text?: unknown }
  if (typeof text !== 'string' || !text) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }))
}

main().catch(() => {}).finally(() => { process.exitCode = 0 })
