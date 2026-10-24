import * as http from 'node:http'
import { createRequire } from 'node:module'
import { CORE_INDEX } from './paths.js'
import { provisionBrain, type BrainIdentity, type ProvisionedBrain } from './provision.js'
import { serveStatic } from './http.js'
import { requestGate } from './remote-access.js'

/**
 * First-run setup: a home without a brain gets a minimal server on the host's
 * port until the user has named themselves and their agent. Only then is the
 * brain provisioned — the two names become the ids (brain name, authorship
 * handle, the seeded profiles' scopes), which are fixed from then on.
 *
 *   GET  /api/setup  → { needed: true }    (the real host answers { needed: false })
 *   POST /api/setup  { userName, agentName } → provision, then hand the port over
 *
 * Every other /api/* call is refused with SETUP_REQUIRED; everything else is
 * the frontend, which shows its first-run screen while setup is needed.
 */

const require = createRequire(import.meta.url)

const MAX_NAME = 60

export type SetupError = { code: 'NAME_REQUIRED' | 'NAME_TOO_LONG' | 'NAME_UNUSABLE' | 'NAMES_COLLIDE'; message: string }

type Slugify = (name: string) => string

/** Validate the two names and derive their slugs. */
export function validateIdentity(body: Record<string, unknown>, slugify: Slugify): BrainIdentity | SetupError {
  const userName = typeof body.userName === 'string' ? body.userName.trim() : ''
  const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : ''
  if (!userName || !agentName) return { code: 'NAME_REQUIRED', message: 'Both names are required.' }
  if (userName.length > MAX_NAME || agentName.length > MAX_NAME) {
    return { code: 'NAME_TOO_LONG', message: `Names can be at most ${MAX_NAME} characters.` }
  }
  const userId = slugify(userName)
  const agentId = slugify(agentName)
  if (!userId || !agentId) {
    return { code: 'NAME_UNUSABLE', message: 'Each name needs at least one Latin letter or digit.' }
  }
  // Same slug → both profiles would share the title <id>-identity.
  if (userId === agentId) return { code: 'NAMES_COLLIDE', message: 'Your name and the agent\'s name must differ.' }
  return { userId, userName, agentId, agentName }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

export interface SetupServerOptions {
  port: number
  allowedOrigins: string[]
  /** Injected for tests; the host provisions through core. */
  provision?: (identity: BrainIdentity) => Promise<ProvisionedBrain>
  slugify?: Slugify
  onListening?: (url: string) => void
}

/**
 * Serve the setup until a POST succeeds, then close (connections included, so
 * the real host can bind the same port) and resolve with the new brain.
 */
export function runFirstRunSetup(opts: SetupServerOptions): Promise<ProvisionedBrain> {
  const provision = opts.provision ?? provisionBrain
  const slugify = opts.slugify ?? (require(CORE_INDEX).slugifyIdentityName as Slugify)
  let busy = false

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]
      const method = req.method ?? 'GET'
      if (url === '/health') { json(res, 200, { status: 'ok', setup: true }); return }
      // Same reach as the host (remote-access.ts).
      const gate = requestGate(req, opts.allowedOrigins)
      if (!gate.allowed) { json(res, 403, { error: { code: 'FORBIDDEN', message: 'Not allowed from here' } }); return }
      if (url === '/api/setup' && method === 'GET') { json(res, 200, { needed: true }); return }
      if (url === '/api/setup' && method === 'POST') {
        // Same CSRF rule as the host: only the cockpit's own page may write.
        if (!gate.origins.includes(req.headers.origin ?? '')) {
          json(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } })
          return
        }
        if (busy) { json(res, 409, { error: { code: 'SETUP_IN_PROGRESS', message: 'Setup is already running.' } }); return }
        busy = true
        void readJson(req).then(async (body) => {
          const identity = validateIdentity(body, slugify)
          if ('code' in identity) { busy = false; json(res, 400, { error: identity }); return }
          let brain: ProvisionedBrain
          try {
            brain = await provision(identity)
          } catch (err) {
            busy = false
            json(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } })
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ ok: true, userId: identity.userId, agentId: identity.agentId }), () => {
            server.close(() => resolve(brain))
            server.closeAllConnections()
          })
        }).catch((err) => { busy = false; json(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } }) })
        return
      }
      if (url.startsWith('/api/') || url.startsWith('/ws/')) {
        json(res, 503, { error: { code: 'SETUP_REQUIRED', message: 'The cockpit is not set up yet.' } })
        return
      }
      serveStatic(req, res)
    })
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => opts.onListening?.(`http://127.0.0.1:${opts.port}`))
  })
}
