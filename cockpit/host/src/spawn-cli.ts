/**
 * cockpit-spawn — open a worker session in the cockpit from inside a session.
 *
 *   node "$COCKPIT_SPAWN_JS" --project <brain project id | name | folder path>
 *        (--prompt-file <file> | --prompt <text>) [--title <pane title>]
 *        [--provider <claude | codex | qwen>] [--open] [--wakeable]
 *        [--deny-tools <a,b>] [--mcp-servers <a,b>]
 *        [--task <task id> | --step | --new-task <title> [--in <project>] [--task-text <what to do>]]
 *
 * Reads COCKPIT_SESSION_ID next to the variables host-request.ts needs, which
 * the host puts into every session's env; without network (a sandboxed
 * session) the request goes as a file into COCKPIT_SPAWN_DIR. The worker
 * starts right away without a pane, with the prompt as its first message, and
 * shows in the sidebar under this session; --open gives it a pane next to this
 * session instead (with no cockpit tab open it starts without one). A prompt file keeps
 * multi-line prompts free of shell quoting. --provider picks the agent CLI the
 * worker runs with; without it the worker uses the cockpit's default. For a
 * worker that can message other sessions, the CLI prints its address. --wakeable
 * lets an outside service message it; --deny-tools and --mcp-servers limit what it
 * may use, for its whole life. Task system: --task makes the worker work on that
 * brain task; --step makes its task a new step of this session's task;
 * --new-task creates that task first (in --in, else the worker's project) and
 * puts the worker on it. Without any, it gets a task of its own.
 *
 * A task has one live session at a time: with --task on a task that already has its session, no worker starts; the
 * prompt goes to that session as a message, and the CLI says so and prints that session's address.
 */
import * as fs from 'node:fs'
import { fail, requestHost } from './host-request.js'
import { spawnAnswerLines, type SpawnAnswer } from './spawn-answer.js'

const CLI = 'cockpit-spawn'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const list = (name: string): string[] | undefined => arg(name)?.split(',').map((item) => item.trim()).filter(Boolean)

async function main(): Promise<void> {
  const project = arg('project')
  if (!project) fail(CLI, '--project is required')
  const promptFile = arg('prompt-file')
  let prompt = arg('prompt')
  if (promptFile) {
    try { prompt = fs.readFileSync(promptFile, 'utf8') } catch { fail(CLI, `cannot read ${promptFile}`) }
  }
  if (!prompt?.trim()) fail(CLI, '--prompt-file or --prompt is required')

  const answer = await requestHost<SpawnAnswer>(CLI, { method: 'POST', path: '/api/spawn' }, {
    project,
    prompt,
    title: arg('title'),
    provider: arg('provider'),
    fromSession: process.env.COCKPIT_SESSION_ID,
    ...(process.argv.includes('--open') ? { open: true } : {}),
    ...(process.argv.includes('--wakeable') ? { wakeable: true } : {}),
    ...(list('deny-tools') ? { deniedTools: list('deny-tools') } : {}),
    ...(list('mcp-servers') ? { mcpServers: list('mcp-servers') } : {}),
    ...(arg('task') ? { task: arg('task') } : {}),
    ...(process.argv.includes('--step') ? { step: true } : {}),
    ...(arg('new-task') ? { newTask: { title: arg('new-task'), ...(arg('in') ? { in: arg('in') } : {}), ...(arg('task-text') ? { text: arg('task-text') } : {}) } } : {}),
  })
  if (!answer) fail(CLI, `cockpit host unreachable at ${process.env.COCKPIT_URL}`)
  if (answer.status >= 400) fail(CLI, answer.body.error?.message ?? `HTTP ${answer.status}`)
  for (const line of spawnAnswerLines(answer.body, { open: process.argv.includes('--open') })) process.stdout.write(`${line}\n`)
}

void main()
