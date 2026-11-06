/**
 * cockpit-sessions — find a cockpit session by what your user calls it.
 *
 *   node "$COCKPIT_SESSIONS_JS" <words> [--running|--stopped] [--archived] [--project <words>] [--limit <n>]
 *
 * Every word has to occur in the session's name, what it was asked, its last
 * status or its project. Lists the sessions this one can message, stopped ones
 * too, with the address to send to (domain/session-directory.ts).
 */
const CLI = 'cockpit-sessions'
const USAGE = `usage: node "$COCKPIT_SESSIONS_JS" <words> [--running|--stopped] [--archived] [--project <words>] [--limit <n>]`

function fail(message: string): never {
  process.stderr.write(`${CLI}: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const params = new URLSearchParams()
  const words: string[] = []
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--running' || arg === '--stopped') params.set('state', arg.slice(2))
    else if (arg === '--archived') params.set('archived', '1')
    else if (arg === '--project' || arg === '--limit') {
      const value = args[i += 1]
      if (!value) fail(USAGE)
      params.set(arg.slice(2), value)
    } else if (arg.startsWith('--')) fail(USAGE)
    else words.push(arg)
  }
  params.set('q', words.join(' '))

  const { COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: token, COCKPIT_SESSION_ID: session } = process.env
  if (!url || !token || !session) fail('not inside a cockpit session (COCKPIT_URL / COCKPIT_SPAWN_TOKEN / COCKPIT_SESSION_ID missing)')
  let res: Response
  try {
    res = await fetch(`${url}/api/session-directory?${params}`, { headers: { 'X-Cockpit-Token': token, 'X-Cockpit-Session': session } })
  } catch {
    fail(`cockpit host unreachable at ${url}`)
  }
  const body = await res.json().catch(() => ({})) as { text?: string; error?: { message?: string } }
  if (!res.ok || typeof body.text !== 'string') fail(body.error?.message ?? `HTTP ${res.status}`)
  process.stdout.write(`${body.text}\n`)
}

void main()
