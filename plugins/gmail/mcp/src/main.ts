import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LISTENING_PREFIX, serveShared } from './http'
import { createGmailServer, googleApiFrom } from './server'

export { createGmailServer, googleApiFrom } from './server'
export { LISTENING_PREFIX, serveShared, type SharedHttpOptions, type SharedHttpServer } from './http'
export { GoogleApi, refusalText, type ApiResult, type Refusal } from './google-api'
export { Calendar, Mailbox, addressesOf } from './tools'

/**
 * Two ways to run: a session's own server on stdio, or, with EML_MCP_HTTP_KEY set, the one server
 * the cockpit runs for every session (a shared MCP part): HTTP on the loopback address, its port
 * written to stdout. A shared server ends when the cockpit that started it does (its stdin closes).
 */
async function run(env: NodeJS.ProcessEnv): Promise<void> {
  const key = env.EML_MCP_HTTP_KEY
  if (!key) {
    await createGmailServer(env).connect(new StdioServerTransport())
    return
  }
  const google = googleApiFrom(env)
  const shared = await serveShared({ key, newServer: () => createGmailServer(env, google) })
  process.stdout.write(`${LISTENING_PREFIX}${shared.port}\n`)
  const stop = () => { void shared.close().finally(() => process.exit(0)) }
  process.stdin.on('end', stop).on('error', stop).resume()
  process.on('SIGTERM', stop)
}

if (require.main === module) {
  run(process.env).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  })
}
