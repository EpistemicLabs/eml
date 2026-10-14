/**
 * cockpit-spawn — open a worker session in the cockpit from inside a session.
 *
 *   node "$COCKPIT_SPAWN_JS" --project <brain project id | name | folder path>
 *        (--prompt-file <file> | --prompt <text>) [--title <pane title>]
 *        [--provider <claude | codex>]
 *
 * Reads COCKPIT_URL, COCKPIT_SPAWN_TOKEN and COCKPIT_SESSION_ID, which the host
 * puts into every session's env. Without network (a sandboxed session) the
 * request goes as a file into COCKPIT_SPAWN_DIR instead. The worker opens as a new pane next to this
 * session and starts with the prompt as its first message. A prompt file keeps
 * multi-line prompts free of shell quoting. --provider picks the agent CLI the
 * worker runs with; without it the worker uses the cockpit's default.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message: string): never {
  process.stderr.write(`cockpit-spawn: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const url = process.env.COCKPIT_URL
  const token = process.env.COCKPIT_SPAWN_TOKEN
  if (!url || !token) fail('not inside a cockpit session (COCKPIT_URL / COCKPIT_SPAWN_TOKEN missing)')

  const project = arg('project')
  if (!project) fail('--project is required')
  const promptFile = arg('prompt-file')
  let prompt = arg('prompt')
  if (promptFile) {
    try { prompt = fs.readFileSync(promptFile, 'utf8') } catch { fail(`cannot read ${promptFile}`) }
  }
  if (!prompt?.trim()) fail('--prompt-file or --prompt is required')

  const request = {
    project,
    prompt,
    title: arg('title'),
    provider: arg('provider'),
    fromSession: process.env.COCKPIT_SESSION_ID,
  }
  let status: number
  let body: { projectId?: string; error?: { message?: string } }
  try {
    const res = await fetch(`${url}/api/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Token': token },
      body: JSON.stringify(request),
    })
    status = res.status
    body = (await res.json().catch(() => ({}))) as typeof body
  } catch {
    // No network: a sandboxed session. Hand the request over as a file.
    const viaInbox = await requestViaInbox({ ...request, token })
    if (!viaInbox) fail(`cockpit host unreachable at ${url}`)
    ;({ status, body } = viaInbox)
  }
  if (status >= 400) fail(body.error?.message ?? `HTTP ${status}`)
  process.stdout.write(`Worker requested in project ${body.projectId} — it opens as a new pane next to this session (or as soon as a cockpit tab is open).\n`)
}

/**
 * The request as a file in the cockpit's spawn inbox (COCKPIT_SPAWN_DIR), for
 * a session whose sandbox blocks the network but may write there. Waits for
 * the host's answer. Null when there is no inbox or the host does not answer.
 */
async function requestViaInbox(request: Record<string, unknown>): Promise<{ status: number; body: { projectId?: string; error?: { message?: string } } } | null> {
  const dir = process.env.COCKPIT_SPAWN_DIR
  if (!dir) return null
  const id = randomUUID()
  const file = path.join(dir, `${id}.json`)
  const result = path.join(dir, `${id}.result.json`)
  try {
    // Written under another name first: the host must never read half a request.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
  } catch {
    return null
  }
  for (let waited = 0; waited < 10_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      const { status, payload } = JSON.parse(fs.readFileSync(result, 'utf8')) as { status: number; payload: { projectId?: string; error?: { message?: string } } }
      return { status, body: payload }
    } catch { /* not answered yet */ }
  }
  fs.rmSync(file, { force: true })
  return null
}

void main()
