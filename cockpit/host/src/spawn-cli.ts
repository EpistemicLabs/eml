/**
 * cockpit-spawn — open a worker session in the cockpit from inside a session.
 *
 *   node "$COCKPIT_SPAWN_JS" --project <brain project id | name | folder path>
 *        (--prompt-file <file> | --prompt <text>) [--title <pane title>]
 *        [--provider <claude | codex>]
 *
 * Reads COCKPIT_SESSION_ID next to the variables host-request.ts needs, which
 * the host puts into every session's env; without network (a sandboxed
 * session) the request goes as a file into COCKPIT_SPAWN_DIR. The worker
 * opens as a new pane next to this session and starts with the prompt as its
 * first message. A prompt file keeps
 * multi-line prompts free of shell quoting. --provider picks the agent CLI the
 * worker runs with; without it the worker uses the cockpit's default.
 */
import * as fs from 'node:fs'
import { fail, requestHost } from './host-request.js'

const CLI = 'cockpit-spawn'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const project = arg('project')
  if (!project) fail(CLI, '--project is required')
  const promptFile = arg('prompt-file')
  let prompt = arg('prompt')
  if (promptFile) {
    try { prompt = fs.readFileSync(promptFile, 'utf8') } catch { fail(CLI, `cannot read ${promptFile}`) }
  }
  if (!prompt?.trim()) fail(CLI, '--prompt-file or --prompt is required')

  const answer = await requestHost<{ projectId?: string }>(CLI, { method: 'POST', path: '/api/spawn' }, {
    project,
    prompt,
    title: arg('title'),
    provider: arg('provider'),
    fromSession: process.env.COCKPIT_SESSION_ID,
  })
  if (!answer) fail(CLI, `cockpit host unreachable at ${process.env.COCKPIT_URL}`)
  if (answer.status >= 400) fail(CLI, answer.body.error?.message ?? `HTTP ${answer.status}`)
  process.stdout.write(`Worker requested in project ${answer.body.projectId} — it opens as a new pane next to this session (or as soon as a cockpit tab is open).\n`)
}

void main()
