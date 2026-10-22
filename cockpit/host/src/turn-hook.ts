/**
 * The turn-state hook — what Claude Code and Codex run on every turn event
 * (shared.ts, turnHookCommand):
 *
 *   node turn-hook.js <config file>
 *
 * Streams the hook's stdin JSON to the host's POST /api/hook (turn-state.ts).
 * The config file holds the URL and the per-boot token (writeTurnHookConfig);
 * the cockpit's session id comes from COCKPIT_SESSION_ID in the session's env.
 * No shell, no curl: the same command runs in sh, Git Bash and PowerShell.
 * Never fails: a host hiccup must not surface as a hook error in the session.
 */
import * as fs from 'node:fs'
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER } from './domain/agent-provider.js'

const TIMEOUT_MS = 3000

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const { url, token } = JSON.parse(fs.readFileSync(process.argv[2] ?? '', 'utf8')) as { url: string; token: string }
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HOOK_TOKEN_HEADER]: token,
      [HOOK_SESSION_HEADER]: process.env.COCKPIT_SESSION_ID ?? '',
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

main().catch(() => {}).finally(() => process.exit(0))
