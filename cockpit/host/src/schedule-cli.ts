/**
 * cockpit-schedule — the schedule tool for sessions that do not have it (a
 * terminal session, Codex): the same actions and fields (application/jobs.ts).
 *
 *   node "$COCKPIT_SCHEDULE_JS" list
 *   node "$COCKPIT_SCHEDULE_JS" create --name 'Daily brief' --cron '0 8 * * 1-5' --prompt '…'
 *   node "$COCKPIT_SCHEDULE_JS" pause --job 'Daily brief'
 *   node "$COCKPIT_SCHEDULE_JS" '{"action":"create","name":"…","at":"2026-11-13T10:00","prompt":"…"}'
 *
 * Flags are the tool's fields with dashes (--max-runs, --ends-at, --task-id,
 * --deny-tools a,b). Reads COCKPIT_SESSION_ID next to what host-request.ts needs.
 */
import { fail, requestHost } from './host-request.js'

const CLI = 'cockpit-schedule'
const USAGE = `usage: node "$COCKPIT_SCHEDULE_JS" <create|list|update|pause|resume|delete|run_now> [--field value …] — or one JSON object`

function parse(argv: string[]): Record<string, unknown> {
  if (argv.length === 1 && argv[0].trim().startsWith('{')) {
    try { return JSON.parse(argv[0]) as Record<string, unknown> } catch { fail(CLI, 'the JSON argument does not parse') }
  }
  const [action, ...rest] = argv
  if (!action) fail(CLI, USAGE)
  const input: Record<string, unknown> = { action }
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!flag.startsWith('--') || value === undefined) fail(CLI, `${flag}: expected --field value. ${USAGE}`)
    const key = flag.slice(2).replace(/-/g, '_')
    input[key] = key === 'max_runs' ? Number(value) : key === 'deny_tools' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value
  }
  return input
}

async function main(): Promise<void> {
  const session = process.env.COCKPIT_SESSION_ID
  if (!session) fail(CLI, 'not inside a cockpit session (COCKPIT_SESSION_ID missing)')
  const input = parse(process.argv.slice(2))
  const answer = await requestHost<{ text?: string }>(CLI, { method: 'POST', path: '/api/jobs' }, { kind: 'schedule', ...input, fromSession: session })
  if (!answer) fail(CLI, `cockpit host unreachable at ${process.env.COCKPIT_URL}`)
  const text = answer.body.text ?? answer.body.error?.message ?? `HTTP ${answer.status}`
  if (answer.status >= 400) fail(CLI, text)
  process.stdout.write(`${text}\n`)
}

void main()
