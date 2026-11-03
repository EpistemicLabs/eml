#!/usr/bin/env node

/**
 * EML HTTP API Server
 *
 * Lightweight HTTP interface to the EML library.
 * No external dependencies — uses Node's built-in http module.
 *
 * Usage:
 *   node server.js [--port 3117] [--host 127.0.0.1] [--data-dir <dir>] [--backup-dir <dir>]
 *   Auth: per-token Bearer (eml_…) checked against <data-dir>/control.db —
 *   there is no shared server key.
 *
 * Endpoints:
 *   POST /boot              { agent?: string, budget?: number }      → Boot identity load (budget = max chars)
 *   POST /project-block     { scope: project.<id>, budget?: number } → Project block for a session (404: no such project)
 *   POST /recall            { query: string, limit? }                → Recall
 *   POST /engram/:type      { content, scope, title?, <type fields> } → Create an engram (v0.19; core enforces the type's fields)
 *   POST /task/:id/track    { text?, status?, outcome?, keep?, base_rev?, … } → Everything about an existing task (v0.19)
 *   POST /learning          { id?, content?, scope?, title?, source, happened, … } → A learning or its evidence (v0.19)
 *   POST /update            { id, patch, base_rev? }                            → Correct / retire an engram that is not a task (v0.19: flat typed patch)
 *   POST /relate            { source_id, target_id, relation, ... }  → Create relation (v0.4, v0.7 idempotent; v0.19 without supersedes / part_of)
 *   GET  /list              ?type=&scope=&limit=&search=&tag=&review_due=&subject=&binding=&task_id=&origin=&session_id= → List engrams
 *   GET  /engram/:id        ?with_relations=                         → Get single engram (v0.7; v0.19 with its entries)
 *   GET  /object/:object    ?id=&status=&kind=                       → Objects of a kind (project · entity · tag · subject · user · agent), or one (v0.19; kind: entities)
 *   GET  /object/:object/:id                                         → One object (the path form of ?id=)
 *   POST /object/:object    { name, … }                              → Create an object (v0.19)
 *   PUT  /object/:object/:id { … }                                   → Update an object (v0.19)
 *   GET  /projects          ?status=                                 → List projects (v0.4)
 *   GET  /tags                                                       → List registered tags (v0.12)
 *   GET  /subjects            ?status=                                 → List subjects with status + member count (v0.14)
 *   GET  /project/:id                                                → Curated brain state (v0.4)
 *   GET  /project/:id/engrams  ?type=&status=&limit=&offset=         → Paginated engram list (v0.4, v0.7 caller-aware)
 *   GET  /users                                                      → List users (v0.5)
 *   GET  /user/:id                                                   → Get user (v0.5)
 *   GET  /agents                                                     → List agents (v0.5)
 *   GET  /agent/:id                                                  → Get agent (v0.5)
 *   POST /engram/:id/confirm-review { text }                          → Confirm a review (v0.8 C9; v0.15: tasks too; v0.19: a review entry)
 *   GET  /entities          ?kind=                                   → List entities (v0.8 C6)
 *   GET  /entity/:id                                                 → Get entity (v0.8 C6)
 *   POST /team/create       { relay, grant, handle }                 → Found a team brain in this new, empty brain (v0.21; host-facing)
 *   POST /team/join         { link, handle }                         → Join a team brain with an invite link, in this new, empty brain (v0.21; host-facing)
 *   GET  /team                                                       → The shared brain as the host shows it: state, read-only text, members (v0.21; host-facing)
 *   DELETE /team                                                     → Discard a brain that has no log yet: files and control rows (v0.21; host-facing)
 *   POST /move/plan         { target, project }                      → What moving a project into another brain of this server would do (v0.21; host-facing)
 *   POST /move              { target, project, plan_hash }           → Move the project as planned: one import op in the target, one move_out here (v0.21; host-facing)
 *
 * Removed in v0.19 (410 with the upgrade hint): POST /store, /context,
 * /task/:id/entry, and the object writes POST /project, PUT /project/:id,
 * POST /tag, POST /subject, PUT /subject/:id, POST /entity, PUT /entity/:id.
 * Removed in v0.20 (410): POST /user, PUT /user/:id, POST /agent, PUT /agent/:id —
 * users and agents are objects (/object/user, /object/agent).
 *
 * v0.20: every write route decodes its request into one command and runs it
 * with eml.apply(command, env) (core commands/); core validates, the routes
 * keep only their query-string whitelists. v0.21: through applyWrite
 * (write.ts), which refuses a write to a shared brain while it is read-only.
 *
 * Provenance (v0.19): the MCP server sends X-EML-Session, X-EML-Model,
 * X-EML-Harness and X-EML-Ingestion; the server stamps them on every write
 * together with the token's handle. Other callers write as 'direct'. The
 * headers are taken as sent: they are attribution, not access control — the
 * token decides what a caller may do.
 *   GET  /stats                                                      → DB statistics
 *   GET  /hygiene                                                    → Brain-hygiene checks with their findings
 *   GET  /health                                                     → Health check
 */

import * as http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import * as path from 'path'
import * as fs from 'fs'
import type Database from 'better-sqlite3'
import {
  EML,
  initControlDatabase,
  runForwardMigrations,
  checkBrainIds,
  boot,
  projectBlock,
  inheritedRules,
  hygieneCheck,
  renderRecallMarkdown,
  renderBrainStateMarkdown,
  ALL_RULES,
  BOOT_PARTS,
  type BootPart,
  ENGRAM_TYPES,
  UPGRADE_HINT,
  splitFields,
  unknownFieldsError,
  readObject,
  CommandError,
  isValidationMessage,
  SEED_ORIGIN,
  type EngramType,
  type EngramStatus,
  type Significance,
  type EntityKind,
  type ProjectStatus,
  type SubjectStatus,
  type EngramInput,
} from '@engramprotocol/core'
import { ConnectionPool, openBrain } from './pool'
import { authenticate as authMiddleware, type AuthContext } from './middleware/auth'
import { route as routeMiddleware } from './middleware/routing'
import { applyWrite, SharedWriteError, readOnly } from './write'
import { Sync } from './sync/sync'
import { TeamFileError, isRelayOrigin, readTeamFile, removeTeamFile, writeTeamFile } from './sync/team-file'
import { createTeamBrain } from './sync/create'
import { MoveRouteError, moveRoute, moving, planMoveRoute } from './move'
import { joinTeamBrain } from './sync/join'
import { ProtocolError, UnsupportedVersionError, checkHandle, fingerprint, parseInviteLink, ready } from '@engramprotocol/protocol'

// v0.9.1 Cluster 1 Phase 1.3: the caller concept is removed entirely.
// Token = identity (1 user = 1 brain), no separate caller layer anymore.
// `AuthContext { tokenId, brainId }` suffices as the auth frame.

type OrderBy = 'created_at' | 'updated_at' | 'significance' | 'score'

// The body shape is heterogeneous per endpoint (untrusted JSON input). We type
// minimally at the endpoint level; `Record<string, any>` allows the existing
// property-access style. Cluster A will split up the routes and introduce
// narrower per-route types.
type RequestBody = Record<string, any>
type Query = Record<string, string | undefined>
type EngramRow = Record<string, any>

// --- .env Loader ---
// Default: <cwd>/.env. Override via EML_ENV_FILE.
const envPath = process.env.EML_ENV_FILE || path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}

// --- Config ---
const args = process.argv.slice(2)
function getArg(name: string, fallback: string | undefined): string | undefined {
  const idx = args.indexOf('--' + name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
}

const PORT = parseInt(getArg('port', process.env.EML_PORT || '3117') as string, 10)
const HOST = getArg('host', process.env.EML_HOST || '127.0.0.1') as string
const DATA_DIR = path.resolve(
  getArg('data-dir', process.env.EML_DATA_DIR) ?? path.resolve(process.cwd(), '.eml'),
)
// Pre-migration backups land in <backup-dir>/pre-migration (default <data-dir>/backups).
const BACKUP_DIR = path.resolve(getArg('backup-dir', process.env.EML_BACKUP_DIR) ?? path.join(DATA_DIR, 'backups'))
const POOL_CAP = parseInt(process.env.EML_POOL_CAP || '50', 10)
// v0.21: how long a project move waits for its import to be confirmed through the relay (one op of a few MB, applied on every replica)
const MOVE_DEADLINE_MS = parseInt(process.env.EML_MOVE_DEADLINE_MS || String(5 * 60_000), 10)
const POOL_IDLE_MIN = parseInt(process.env.EML_POOL_IDLE_TIMEOUT_MIN || '15', 10)

// v0.9: version from our own package.json. Loaded synchronously at module import
// so /health calls don't hit the file system.
const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch { return '0.0.0' }
})()
const STARTED_AT_MS = Date.now()

// v0.9 multi-tenant: control.db + the LRU pool are global server resources.
// Per request: token → user_id+brain_id → pool.acquire(brainId) → EML.fromConnection.
const CONTROL_PATH = path.join(DATA_DIR, 'control.db')
if (!fs.existsSync(CONTROL_PATH)) {
  console.error(`Error: control.db not found at ${CONTROL_PATH}`)
  console.error(`Run: eml control init --data-dir ${DATA_DIR}`)
  process.exit(1)
}
const controlDb: Database.Database = initControlDatabase(CONTROL_PATH)
const pool = new ConnectionPool({
  dataDir: DATA_DIR,
  cap: POOL_CAP,
  idleTimeoutMs: POOL_IDLE_MIN * 60_000,
})
pool.startIdleSweep()

// Forward-Migration-Runner — blocking-at-startup, with backup + preflight +
// auto-restore (see forward-migrations.ts). The "[migrations] migrating" line
// tells a supervising host (the cockpit) to wait longer for /health.
const migrationReport = runForwardMigrations({
  control: controlDb,
  dataDir: DATA_DIR,
  backupDir: BACKUP_DIR,
  codeVersion: SERVER_VERSION,
  // Synchronous write: the migration blocks the event loop right after this, and
  // pipe writes are async on macOS — console.log would arrive after the migration.
  onProgress: (line) => fs.writeSync(1, `[migrations] ${line}\n`),
})
if (migrationReport.failedCount > 0) {
  console.error(`[migrations] ${migrationReport.failedCount} brain(s) failed migration:`)
  for (const o of migrationReport.outcomes.filter(o => o.status === 'failed')) {
    console.error(`  - ${o.brainId} (${o.brainName}): ${o.kind}: ${o.error}`)
    if (o.reportPath) console.error(`    report: ${o.reportPath}`)
  }
}
if (migrationReport.migratedCount > 0) {
  console.log(`[migrations] migrated ${migrationReport.migratedCount} brain(s)`)
}
// v0.21: a brain's id is in its genesis; a control row naming another is refused until fixed.
for (const m of checkBrainIds({ control: controlDb, dataDir: DATA_DIR })) {
  console.error(`[brains] ${m.brainId} (${m.brainName}): its genesis names brain ${m.genesisId ?? 'none'} — set to needs_intervention`)
}

// v0.21: a shared brain — one with a team file, <data-dir>/team/<brain id>.json —
// is synced with its relay through its own connection to the brain file
// (sync/sync.ts); its writes go through it (write.ts). A team file that cannot
// be used still makes its brain shared: the Error here keeps it read-only.
const syncs = new Map<string, Sync | Error>()
const persistTeamFile = (file: Parameters<typeof writeTeamFile>[1]) => writeTeamFile(DATA_DIR, file)
function startSyncs(): void {
  let ids: string[]
  try {
    ids = fs.readdirSync(path.join(DATA_DIR, 'team')).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length))
  } catch {
    return
  }
  for (const id of ids) {
    const row = controlDb.prepare(`SELECT brain_file FROM brains WHERE id = ? AND status = 'ok'`).get(id) as { brain_file: string } | undefined
    if (!row) {
      console.error(`[sync] ${id}: a team file without a usable brain; not synced`)
      continue
    }
    try {
      const team = readTeamFile(DATA_DIR, id)
      if (!team) continue
      const file = path.isAbsolute(row.brain_file) ? row.brain_file : path.join(DATA_DIR, row.brain_file)
      const sync = new Sync(openBrain(file), team, { persist: persistTeamFile })
      syncs.set(id, sync)
      sync.start()
    } catch (err) {
      // a fixed reason (team-file.ts), or an open that failed: nothing of the file itself
      const why = err instanceof TeamFileError ? err.message : 'its brain file could not be opened'
      syncs.set(id, new Error(why))
      console.error(`[sync] ${id}: its team file cannot be used (${why})`)
    }
  }
}

// --- Helpers ---

/** A text as the body of a request carried it, or null. */
const bodyText = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

/** v0.21: a creation the relay never took leaves nothing behind — the Sync, its team file — and the brain is new and empty again. */
function discardTeam(brainId: string, sync: Sync): void {
  sync.discard()
  syncs.delete(brainId)
  removeTeamFile(DATA_DIR, brainId)
}

/**
 * v0.21: discards a brain that has no log yet — a shared brain that never came
 * to life, or an empty brain the host provisioned for one (DELETE /team): the
 * Sync and its team file, the pool's connection, the brain file, and the
 * control rows (brains; members, migrations and tokens go with it).
 */
function discardBrain(brainId: string, brainFile: string): void {
  const sync = syncs.get(brainId)
  if (sync instanceof Sync) sync.discard()
  syncs.delete(brainId)
  removeTeamFile(DATA_DIR, brainId)
  pool.evict(brainId)
  const file = path.resolve(DATA_DIR, brainFile)
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true })
  controlDb.prepare('DELETE FROM brains WHERE id = ?').run(brainId)
}

/** v0.20: the review_due list filter (true · false). */
function reviewDueParam(q: Record<string, string | undefined>): boolean | undefined | Error {
  if (q.review_due === undefined) return undefined
  if (q.review_due === 'true' || q.review_due === 'false') return q.review_due === 'true'
  return new Error('review_due is true or false')
}
function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw) as RequestBody) }
      catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function parseQuery(url: string | undefined): Query {
  if (!url) return {}
  const idx = url.indexOf('?')
  if (idx === -1) return {}
  const params: Query = {}
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent)
    params[k] = v
  }
  return params
}

// v0.9: auth is a bearer-token lookup against control.db (see middleware/auth.ts).
// Routing is a control-row lookup → ConnectionPool (see middleware/routing.ts).
// The whole authenticated request flow runs through handleAuthenticated().

// v0.7: response helper that supports custom headers (for deprecation headers).
function respond(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

// v0.7: strict query-param whitelists. Unknown keys → 400 (fail loud).
// Separate constants because the endpoints allow different param sets.
// v0.8 C7: domain, source_id, source_type removed from the whitelist — the columns
// are dropped; search via search/FTS or via the properties JSON.
// v0.9.1 Cluster 1: `caller` and `namespace` removed from all param whitelists.
// v0.20: the relation verbs are checked in core (relation.create).

const LEARNING_STATES = ['ripe', 'unclear', 'collecting', 'paused']
const BINDINGS = ['task', 'standing']

const ALLOWED_LIST_PARAMS = new Set([
  'type', 'scope', 'title',
  'status', 'significance',
  'search', 'order_by', 'limit', 'offset', 'has_relations',
  'assignee', // v0.11 team-brains: filter tasks by assignee handle (agent or user)
  'tag',      // v0.12: filter engrams by registered tag id
  'review_due', // v0.20: review due, computed at read time (replaces label=review)
  'subject',    // v0.14: filter engrams by subject id (cross-scope strand)
  'stage',    // v0.15: filter tasks by stage
  'binding', 'task_id', 'origin', 'session_id', // v0.19
  'state',    // v0.19: learnings by state (ripe · unclear · collecting · paused)
])

const ALLOWED_PROJECT_ENGRAMS_PARAMS = new Set([
  'type', 'status', 'significance',
  'title', 'order_by', 'limit', 'offset', 'has_relations',
  'assignee', // v0.11 team-brains
  'tag',      // v0.12: filter engrams by registered tag id
  'review_due', // v0.20: review due, computed at read time (replaces label=review)
  'subject',    // v0.14: filter engrams by subject id (cross-scope strand)
  'stage',    // v0.15: filter tasks by stage
])

const ALLOWED_ENGRAM_GET_PARAMS = new Set([
  'with_relations',
])

/**
 * v0.7: validate query params against a whitelist.
 * Returns true if response was sent (400 with allowed-list); caller should
 * return immediately. Returns false if all params are valid.
 */
function rejectUnknownParams(
  res: ServerResponse,
  query: Query,
  allowedSet: Set<string>,
): boolean {
  const unknown = Object.keys(query).filter(k => !allowedSet.has(k))
  if (unknown.length > 0) {
    json(res, 400, {
      error: 'unknown query params',
      unknown,
      allowed: [...allowedSet],
    })
    return true
  }
  return false
}

/** v0.19: routes an older client still calls — answered with the upgrade hint. */
function removedRoute(url: string, method: string | undefined): boolean {
  if (method === 'POST' && (url === '/store' || url === '/context' || /^\/task\/[^/]+\/entry$/.test(url))) return true
  if (method === 'POST' && (url === '/project' || url === '/tag' || url === '/subject' || url === '/entity')) return true
  if (method === 'PUT' && /^\/(project|subject|entity)\/[^/]+$/.test(url)) return true
  return false
}

/** v0.20: users and agents are objects — their own write routes are gone (decision write-command-set). */
function removedInV020(url: string, method: string | undefined): 'user' | 'agent' | null {
  const m = /^\/(user|agent)(?:\/[^/]+)?$/.exec(url)
  if (!m) return null
  const own = method === 'POST' ? url === `/${m[1]}` : method === 'PUT' ? url !== `/${m[1]}` : false
  return own ? m[1] as 'user' | 'agent' : null
}

/**
 * v0.19: the body is flat — a nested `properties` object comes from an older
 * client and would otherwise be dropped (create) or passed through (update).
 */
function rejectNestedProperties(type: EngramType, body: RequestBody): void {
  if (body && typeof body === 'object' && 'properties' in body) {
    throw unknownFieldsError(type, ['properties'], ['the type\'s fields, flat in the body'])
  }
}

/** An agent as provenance names it (core apply-op.ts AGENT; decision provenance-agent-field). */
const AGENT_HEADER = /^[a-z0-9_-]{1,63}$/

const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s.trim() !== '' ? s.trim().slice(0, 200) : null
}

// --- Recall logic (v0.9.1: 1 user = 1 brain, no namespace filter) ---
interface RecallResult {
  query: string
  engrams: number
  markdown: string
}

function recall(eml: EML, query: string, opts: RequestBody = {}): RecallResult {
  const results = eml.engrams.query({
    search: query,
    search_mode: 'or',
    significance: opts.min_significance || undefined,
    limit: opts.limit || 10,
    order_by: 'score',
    statuses: ['active', 'planned'], // v0.10.5: live knowledge + open work (decision recall-surfaces-active-and-planned)
  })

  // v0.10.5 DISPLAY: return ONLY the compact markdown (rendered in core). The full
  // engram array is intentionally NOT returned — callTool JSON-stringifies the whole
  // response, so returning full engrams would defeat the preview. Full body via eml_get.
  return {
    query,
    engrams: results.length,
    markdown: renderRecallMarkdown(query, results),
  }
}

// --- Routes ---
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0]
  const method = req.method

  // Health check — no auth needed (v0.9-PROPOSAL §5.10).
  // Public, no brain/DB check (health = "the process responds").
  // GET + HEAD both without auth — HEAD is semantically GET without a body and is
  // used by some health probes (curl -I, some monitoring tools).
  if (url === '/health' && (method === 'GET' || method === 'HEAD')) {
    return json(res, 200, {
      status: 'ok',
      version: SERVER_VERSION,
      uptime_sec: Math.floor((Date.now() - STARTED_AT_MS) / 1000),
    })
  }

  // v0.9 multi-tenant — auth + routing per request.
  // Bearer-Token → (user_id, brain_id) → ConnectionPool → brainDb → EML.
  const authResult = authMiddleware(controlDb, req.headers['authorization'])
  if (!authResult.ok) {
    return json(res, authResult.status, { error: authResult.error })
  }
  const authCtx = authResult.ctx
  const routingResult = routeMiddleware(controlDb, pool, authCtx.brainId)
  if (!routingResult.ok) {
    return json(res, routingResult.status, routingResult.code
      ? { error: routingResult.error, code: routingResult.code }
      : { error: routingResult.error })
  }
  const eml = EML.fromConnection(routingResult.ctx.brainDb, routingResult.ctx.brainName)
  const defaultAgent = routingResult.ctx.brainName
  const sync = syncs.get(routingResult.ctx.brainId)
  // v0.21: a project move holds this brain (move.ts); its writes are refused at once
  const held = moving.has(routingResult.ctx.brainId)

  try {
    // POST /boot
    if (url === '/boot' && method === 'POST') {
      const body = await readBody(req)
      const reviewDays = parseInt(process.env.BOOT_REVIEW_THRESHOLD_DAYS || '14', 10)
      // budget: the caller's hard cap for the markdown, in characters — the
      // hook passes the limit of the harness it serves (core/boot.ts, "Size budget").
      const budget = typeof body.budget === 'number' && Number.isFinite(body.budget) && body.budget > 0
        ? Math.floor(body.budget) : undefined
      // part: the cockpit host composes a session's boot from the agent's brain
      // (identity) and this server's system rules (core/boot.ts BootPart).
      if (body.part !== undefined && !BOOT_PARTS.includes(body.part)) {
        return json(res, 400, { error: `part must be one of ${BOOT_PARTS.join(', ')}` })
      }
      const result = boot(eml, body.agent || defaultAgent, {
        reviewDays,
        version: SERVER_VERSION,
        systemRules: ALL_RULES,
        ...(budget !== undefined && { budget }),
        ...(body.part !== undefined && { part: body.part as BootPart }),
      })
      return json(res, 200, result)
    }

    // POST /recall
    if (url === '/recall' && method === 'POST') {
      const body = await readBody(req)
      if (!body.query) return json(res, 400, { error: 'query required' })
      const result = recall(eml, body.query, body)
      return json(res, 200, result)
    }

    // v0.19: who writes. The token gives the handle; the MCP server adds the
    // session, model and harness it runs in. Other callers write as 'direct'.
    // v0.20: the write env — the brain's clock and ids with this actor.
    // v0.21: x-eml-agent names the agent that writes for the handle — set by
    // the cockpit host from the space's binding (decision cockpit-identity-agent-brain).
    const agent = header(req, 'x-eml-agent')
    if (agent !== null && !AGENT_HEADER.test(agent)) {
      return json(res, 400, { error: 'x-eml-agent is 1–63 characters of a-z, 0-9, _ and -' })
    }
    const env = eml.env({
      handle: authCtx.caller ?? null,
      agent,
      session_id: header(req, 'x-eml-session') ?? null,
      model: header(req, 'x-eml-model') ?? null,
      harness: header(req, 'x-eml-harness') ?? null,
      ingestion_method: header(req, 'x-eml-ingestion') === 'mcp' ? 'mcp' : 'direct',
    })

    // v0.14: filing into a CLOSED subject is allowed (late filing) — but say so,
    // so the writer notices when it meant an active strand. Only for subjects the
    // request itself named; attached as `closed_subjects` when non-empty.
    function withClosedSubjectNotice<T extends { subjects: string[] }>(engram: T, requested: unknown): T & { closed_subjects?: string[] } {
      if (!Array.isArray(requested) || requested.length === 0) return engram
      const statuses = eml.subjects.statusByIds(engram.subjects)
      const closed = engram.subjects.filter(t => statuses.get(t) === 'closed')
      return closed.length > 0 ? { ...engram, closed_subjects: closed } : engram
    }

    // v0.19: removed write routes — an older client gets the upgrade hint, not a half-state.
    if (removedRoute(url, method)) {
      return json(res, 410, { error: `${method} ${url} was removed in EML v0.19. ${UPGRADE_HINT}` })
    }
    const removedKind = removedInV020(url, method)
    if (removedKind) {
      return json(res, 410, { error: `${method} ${url} was removed in EML v0.20 — a ${removedKind} is an object: POST /object/${removedKind} to create, PUT /object/${removedKind}/<id> to update.` })
    }

    // POST /team/create {relay, grant, handle} — founds a team brain in this
    // brain, which must be new and empty (v0.21, spec team-brain-sync-client-spec
    // §5): keys, genesis and team file (sync/create.ts), then a Sync in create
    // mode; answers once the brain is live. Called again while that is under
    // way, it waits on the same creation.
    if (url === '/team/create' && method === 'POST') {
      const body = await readBody(req)
      // read again after the body: a creation another request started while
      // this body was read is in the map now; from here to syncs.set nothing waits
      const current = syncs.get(routingResult.ctx.brainId)
      if (current instanceof Error) return json(res, 503, { error: readOnly(`it stopped: its team file cannot be used (${current.message})`, true).message, code: 'SHARED_BRAIN_READ_ONLY' })
      const relay = bodyText(body.relay)
      const handle = bodyText(body.handle)
      const grant = bodyText(body.grant)
      if (relay === null || !isRelayOrigin(relay)) return json(res, 400, { error: 'The relay is a wss:// origin (scheme and host, no path).', code: 'INVALID_RELAY' })
      try {
        checkHandle(handle ?? '')
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err
        return json(res, 400, { error: 'A handle is 1–63 characters of a–z, 0–9, _ and -.', code: 'INVALID_HANDLE' })
      }
      if (grant === null) return json(res, 400, { error: 'grant required' })
      let creation = current
      // a creation that stopped before the relay took it (a stale grant after a restart): this one replaces it
      if (creation?.team.create && (creation.state.kind === 'stopped' || creation.state.kind === 'update_needed')) {
        discardTeam(routingResult.ctx.brainId, creation)
        creation = undefined
      }
      if (!creation) {
        if (eml.hasGenesis()) return json(res, 409, { error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.', code: 'TEAM_BRAIN_NOT_EMPTY' })
        const team = createTeamBrain({ brain: routingResult.ctx.brainId, relay, grant, handle: handle as string, stateHash: eml.stateHash(), now: eml.now() })
        writeTeamFile(DATA_DIR, team)
        creation = new Sync(openBrain(path.resolve(DATA_DIR, routingResult.ctx.brainFile)), team, { persist: persistTeamFile })
        syncs.set(routingResult.ctx.brainId, creation)
        creation.start()
      } else if (creation.mode !== 'create' && eml.hasGenesis()) {
        return json(res, 409, { error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.', code: 'TEAM_BRAIN_NOT_EMPTY' })
      }
      const state = await creation.whenLive()
      if (state.kind === 'live') {
        return json(res, 201, { brain: routingResult.ctx.brainId, member: creation.team.identity ? fingerprint(creation.team.identity.publicKey) : null, handle: creation.ownHandle() ?? handle })
      }
      if (state.kind === 'stopped' || state.kind === 'update_needed') {
        if (creation.team.create) discardTeam(routingResult.ctx.brainId, creation)
        const answer = state.kind === 'stopped' ? state.relay : undefined
        if (answer?.code === 'grant_invalid') return json(res, 403, { error: `The relay did not accept the creation grant: ${answer.message}. Try again.`, code: 'GRANT_INVALID' })
        if (answer?.code === 'brain_exists') return json(res, 409, { error: 'The relay already has a brain with this id.', code: 'BRAIN_EXISTS' })
        return json(res, 502, { error: `The relay did not create the brain: ${state.why}.`, code: 'TEAM_CREATE_FAILED' })
      }
      return json(res, 504, { error: 'The relay took the new brain but it is not live yet; it will finish on its own.', code: 'TEAM_CREATE_PENDING' })
    }

    // POST /team/join {link, handle} — joins the team brain an invite link
    // names, in this brain, which must be new and empty (v0.21, spec
    // team-brain-sync-client-spec §5): keys and the join (sync/join.ts), then a
    // Sync in join mode; answers once the relay has the join. The join goes on
    // by itself — the inviter's accept, the owner adding the member, the key —
    // and a call while it is under way answers where it stands. A join that
    // stopped before anything was written (its invite closed) is discarded,
    // so a new link starts over.
    if (url === '/team/join' && method === 'POST') {
      const body = await readBody(req)
      const current = syncs.get(routingResult.ctx.brainId)
      if (current instanceof Error) return json(res, 503, { error: readOnly(`it stopped: its team file cannot be used (${current.message})`, true).message, code: 'SHARED_BRAIN_READ_ONLY' })
      const link = bodyText(body.link)
      const handle = bodyText(body.handle)
      try {
        checkHandle(handle ?? '')
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err
        return json(res, 400, { error: 'A handle is 1–63 characters of a–z, 0–9, _ and -.', code: 'INVALID_HANDLE' })
      }
      const invalidInvite = () => json(res, 400, { error: 'This is not an invite link for this brain.', code: 'INVALID_INVITE' })
      let invite
      try {
        invite = parseInviteLink(link ?? '')
      } catch (err) {
        if (err instanceof ProtocolError || err instanceof UnsupportedVersionError) return invalidInvite()
        throw err
      }
      if (invite.brain !== routingResult.ctx.brainId) return invalidInvite()
      let joining = current
      // a join that stopped before anything was written (its invite closed, the relay refused it): this one replaces it
      if (joining?.mode === 'join' && (joining.state.kind === 'stopped' || joining.state.kind === 'update_needed') && !eml.hasGenesis()) {
        discardTeam(routingResult.ctx.brainId, joining)
        joining = undefined
      }
      if (!joining) {
        if (eml.hasGenesis()) return json(res, 409, { error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.', code: 'TEAM_BRAIN_NOT_EMPTY' })
        const team = joinTeamBrain({ brain: routingResult.ctx.brainId, link: link as string, handle: handle as string, now: eml.now() })
        writeTeamFile(DATA_DIR, team)
        joining = new Sync(openBrain(path.resolve(DATA_DIR, routingResult.ctx.brainFile)), team, { persist: persistTeamFile })
        syncs.set(routingResult.ctx.brainId, joining)
        joining.start()
      } else if (joining.mode !== 'join') {
        return json(res, 409, { error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.', code: 'TEAM_BRAIN_NOT_EMPTY' })
      }
      const state = await joining.whenLive()
      if (state.kind === 'live') {
        return json(res, 201, { brain: routingResult.ctx.brainId, member: joining.team.identity ? fingerprint(joining.team.identity.publicKey) : null, handle: joining.ownHandle() ?? handle })
      }
      if (state.kind === 'stopped' || state.kind === 'update_needed') {
        if (eml.hasGenesis()) return json(res, 503, { error: readOnly(`it stopped: ${state.why}`, true).message, code: 'SHARED_BRAIN_READ_ONLY' })
        discardTeam(routingResult.ctx.brainId, joining)
        const answer = state.kind === 'stopped' ? state.relay : undefined
        if (answer?.code === 'invite_closed') return json(res, 410, { error: `This invite is closed (${answer.message}); ask the owner for a new link.`, code: 'INVITE_CLOSED' })
        return json(res, 502, { error: `The relay did not take the join: ${state.why}.`, code: 'TEAM_JOIN_FAILED' })
      }
      return json(res, 202, { code: 'TEAM_JOIN_PENDING', message: 'The join is with the relay; the brain is live once the owner has accepted it and this device holds the key.', brain: routingResult.ctx.brainId, member: joining.team.identity ? fingerprint(joining.team.identity.publicKey) : null, handle })
    }

    // GET /team — the shared brain as the host shows it (v0.21, spec
    // team-brain-membership-flows-spec §2): its sync state, the read-only text a
    // write would get, its member and the member set. A private brain: shared false.
    if (url === '/team' && method === 'GET') {
      if (sync === undefined) return json(res, 200, { shared: false })
      if (sync instanceof Error) {
        const state = { kind: 'stopped', why: `its team file cannot be used (${sync.message})` }
        return json(res, 200, { shared: true, brain: routingResult.ctx.brainId, relay: null, mode: null, state, read_only: readOnly(`it stopped: ${state.why}`, true).message, member: null, members: [], invites: [] })
      }
      return json(res, 200, sync.snapshot())
    }

    // POST /move/plan, POST /move — a project with its sub-projects leaves this
    // brain for a team brain of this server (v0.21, spec team-brain-move-project-spec;
    // move.ts). The plan is read only and lists every reason the move would be
    // refused; the run takes the plan's hash as the confirmation.
    if ((url === '/move/plan' || url === '/move') && method === 'POST') {
      const body = await readBody(req)
      const moveCtx = { controlDb, pool, syncs, dataDir: DATA_DIR, backupDir: BACKUP_DIR, deadlineMs: MOVE_DEADLINE_MS }
      if (url === '/move/plan') return json(res, 200, planMoveRoute(moveCtx, { brainId: routingResult.ctx.brainId, db: routingResult.ctx.brainDb }, body))
      if (sync !== undefined) return json(res, 409, { error: 'move refused: a project moves out of a private brain only. Nothing was moved.', code: 'MOVE_REFUSED' })
      return json(res, 200, await moveRoute(moveCtx, { brainId: routingResult.ctx.brainId, brainFile: routingResult.ctx.brainFile }, body, env))
    }

    // DELETE /team — discards a brain that has no log yet: a shared brain that
    // never came to life (a stopped join, a creation the relay refused) or an
    // empty brain the host provisioned for one. The host's cleanup; a brain
    // with a log is not discarded here.
    if (url === '/team' && method === 'DELETE') {
      if (eml.hasGenesis()) return json(res, 409, { error: 'A shared brain with a log is not discarded here.', code: 'TEAM_BRAIN_HAS_LOG' })
      discardBrain(routingResult.ctx.brainId, routingResult.ctx.brainFile)
      res.writeHead(204)
      res.end()
      return
    }

    // POST /engram/:type — create an engram. The body is flat: the universal
    // fields plus the type's own; core splits and checks them (fields.ts).
    const createMatch = /^\/engram\/([a-z]+)$/.exec(url)
    if (createMatch && method === 'POST' && (ENGRAM_TYPES as readonly string[]).includes(createMatch[1])) {
      const type = createMatch[1] as EngramType
      const body = await readBody(req)
      rejectNestedProperties(type, body)
      // The default-brain seeds are written in-process only; over HTTP that origin
      // would skip a rule's agreement (decision v0.19-seed-rules-agreement).
      if (body.origin === SEED_ORIGIN) return json(res, 400, { error: `Invalid engram: origin ${SEED_ORIGIN} is set by the brain's own seed only.` })
      const { fields, rest } = splitFields(type, body)
      const input = { ...rest, type, properties: fields } as unknown as EngramInput
      const engram = await applyWrite(eml, { name: 'engram.create', input }, env, sync, held)
      return json(res, 201, withClosedSubjectNotice(engram, body.subjects))
    }

    // POST /task/:id/track — everything that happens to an existing task.
    const trackMatch = /^\/task\/([^/]+)\/track$/.exec(url)
    if (trackMatch && method === 'POST') {
      const body = await readBody(req)
      const task = await applyWrite(eml, { name: 'task.track', input: { ...body, id: trackMatch[1] } }, env, sync, held)
      return json(res, 200, withClosedSubjectNotice(task, body.subjects))
    }

    // POST /learning — a new learning (topic check first) or evidence for one (id).
    if (url === '/learning' && method === 'POST') {
      const body = await readBody(req)
      // id → learning.add_evidence; without → engram.create of a learning with its first evidence
      if (body.id !== undefined) {
        const r = await applyWrite(eml, { name: 'learning.add_evidence', input: body as never }, env, sync, held)
        return json(res, 201, { written: true, ...r })
      }
      const { source, happened, quote, stance, rule_id, ...lesson } = body
      const evidence = Object.fromEntries(Object.entries({ source, happened, quote, stance, rule_id }).filter(([, v]) => v !== undefined))
      try {
        const { learning, ...engram } = await applyWrite(eml, { name: 'engram.create', input: { ...lesson, type: 'learning', evidence } as never }, env, sync, held)
        return json(res, 201, { written: true, engram, learning })
      } catch (err) {
        // the topic check found a match: nothing written, the matches named (as since v0.19)
        if (err instanceof CommandError && err.code === 'TOPIC_EXISTS') return json(res, 200, { written: false, matches: err.data?.matches })
        throw err
      }
    }

    // GET /list — v0.9.1 Cluster 1: no namespace filter anymore (1 user = 1 brain).
    if (url === '/list' && method === 'GET') {
      const q = parseQuery(req.url)
      if (rejectUnknownParams(res, q, ALLOWED_LIST_PARAMS)) return
      if (q.state !== undefined && !LEARNING_STATES.includes(q.state)) {
        return json(res, 400, { error: `state is one of ${LEARNING_STATES.join(', ')} (learnings)` })
      }
      // An unknown type or binding used to answer 200 with an empty list.
      if (q.type !== undefined && !(ENGRAM_TYPES as readonly string[]).includes(q.type)) {
        return json(res, 400, { error: `type is one of ${ENGRAM_TYPES.join(', ')}` })
      }
      if (q.binding !== undefined && !BINDINGS.includes(q.binding)) {
        return json(res, 400, { error: `binding is one of ${BINDINGS.join(', ')}` })
      }
      const reviewDue = reviewDueParam(q)
      if (reviewDue instanceof Error) return json(res, 400, { error: reviewDue.message })

      const results = eml.engrams.query({
        type: q.type as EngramType | undefined,
        scope: q.scope,
        tag: q.tag,
        search: q.search,
        title: q.title,
        significance: q.significance as Significance | undefined,
        has_relations: q.has_relations === 'true' ? true : (q.has_relations === 'false' ? false : undefined),
        limit: q.limit ? parseInt(q.limit) : 50,
        offset: q.offset ? parseInt(q.offset) : 0,
        order_by: (q.order_by as OrderBy) || 'updated_at',
        status: q.status as EngramStatus | undefined,
        assignee: q.assignee,
        review_due: reviewDue,
        subject: q.subject,
        stage: q.stage,
        binding: q.binding as 'task' | 'standing' | undefined,
        task_id: q.task_id,
        origin: q.origin,
        session_id: q.session_id,
        learning_state: q.state as 'collecting' | 'ripe' | 'unclear' | 'paused' | undefined,
      })
      return json(res, 200, { count: results.length, engrams: results })
    }

    // === v0.4: engram API completion ===

    // GET /engram/:id — single-engram lookup.
    if (url.startsWith('/engram/') && method === 'GET') {
      const q = parseQuery(req.url)
      if (rejectUnknownParams(res, q, ALLOWED_ENGRAM_GET_PARAMS)) return

      const id = url.slice('/engram/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'engram id required' })

      const engram = eml.engrams.get(id)
      if (!engram) return json(res, 404, { error: 'engram not found' })

      // ?with_relations=true → with the relations array; otherwise engram fields only
      if (q.with_relations === 'true') {
        return json(res, 200, engram)
      }
      const { relations, ...rest } = engram
      return json(res, 200, rest)
    }

    // POST /update { id, patch } — correct or retire an engram that is not a
    // task. The patch is flat (content, title, …, the type's own fields,
    // supersedes, review_note); core splits it by the engram's type.
    if (url === '/update' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id) return json(res, 400, { error: 'id required' })
      if (!body.patch || typeof body.patch !== 'object') return json(res, 400, { error: 'patch object required' })
      const current = eml.engrams.get(body.id)
      if (!current) return json(res, 404, { error: 'engram not found' })
      rejectNestedProperties(current.type, body.patch)
      const { fields, rest } = splitFields(current.type, body.patch)
      const patch = Object.keys(fields).length > 0 ? { ...rest, properties: fields } : rest
      const engram = await applyWrite(eml, { name: 'engram.update', input: { id: body.id, patch: patch as never, ...(body.base_rev !== undefined ? { base_rev: body.base_rev } : {}) } }, env, sync, held)
      return json(res, 200, withClosedSubjectNotice(engram, body.patch.subjects))
    }

    // POST /engram/:id/confirm-review { text } — still holds: a review entry
    // (why) and a new review_due_at. For a task a movement.
    if (url.match(/^\/engram\/[^/]+\/confirm-review$/) && method === 'POST') {
      const id = url.slice('/engram/'.length, -'/confirm-review'.length)
      const body = await readBody(req)
      const engram = await applyWrite(eml, { name: 'engram.confirm_review', input: { id, ...(body.text !== undefined ? { text: body.text } : {}) } }, env, sync, held)
      return json(res, 200, { engram })
    }

    // === v0.19: objects (project · entity · tag · subject) ===
    const objectMatch = /^\/object\/([a-z]+)(?:\/([^/]+))?$/.exec(url)
    if (objectMatch) {
      const object = objectMatch[1]
      const id = objectMatch[2] !== undefined ? decodeURIComponent(objectMatch[2]) : undefined
      if (method === 'GET') {
        const q = parseQuery(req.url)
        if (rejectUnknownParams(res, q, new Set(['id', 'status', 'kind']))) return
        // The path form (/object/:object/:id, as PUT takes it) serves like ?id=.
        const wanted = id ?? q.id
        const result = readObject(eml, object, { id: wanted, status: q.status, kind: q.kind })
        if (wanted !== undefined && result === null) return json(res, 404, { error: `${object} "${wanted}" not found` })
        return json(res, 200, wanted !== undefined ? { object: result } : { count: (result as unknown[]).length, objects: result })
      }
      if (method === 'POST' && id === undefined) {
        const body = await readBody(req)
        const result = await applyWrite(eml, { name: 'object.create', input: { object, fields: body } }, env, sync, held)
        return json(res, 201, result)
      }
      if (method === 'PUT' && id !== undefined) {
        const body = await readBody(req)
        const result = await applyWrite(eml, { name: 'object.update', input: { object, id, patch: body } }, env, sync, held)
        return json(res, 200, result)
      }
    }

    // POST /relate — create relation between two engrams.
    // v0.9.1 Cluster 1: no cross-namespace check anymore.
    if (url === '/relate' && method === 'POST') {
      const body = await readBody(req)
      const { created } = await applyWrite(eml, { name: 'relation.create', input: body as never }, env, sync, held)
      return json(res, 201, { ok: true, created })
    }

    // === v0.12: Tags (registered facet vocabulary) ===

    // GET /tags — list the registered tag vocabulary (the recall-first surface).
    if (url === '/tags' && method === 'GET') {
      const q = parseQuery(req.url)
      const tags = eml.tags.list(q.status === 'archived' ? 'archived' : q.status === 'all' ? undefined : 'active')
      return json(res, 200, { count: tags.length, tags })
    }

    // === v0.14: Subjects (the "heavy facet": registry with description + lifecycle) ===

    // GET /subjects — the subject registry with status + member count (recall-first surface).
    if (url === '/subjects' && method === 'GET') {
      const q = parseQuery(req.url)
      if (q.status !== undefined && q.status !== 'active' && q.status !== 'closed') {
        return json(res, 400, { error: 'status must be active or closed' })
      }
      const subjects = eml.subjects.list(q.status as SubjectStatus | undefined)
      return json(res, 200, { count: subjects.length, subjects })
    }

    // === v0.4: Projects (First-Class Entity) ===

    // GET /projects — list projects
    if (url === '/projects' && method === 'GET') {
      const q = parseQuery(req.url)
      const projects = eml.projects.list({ status: q.status as ProjectStatus | undefined })
      return json(res, 200, { count: projects.length, projects })
    }

    // GET /project/:id  (+ optional suffix /engrams)
    if (url.startsWith('/project/') && method === 'GET') {
      const rest = url.slice('/project/'.length)
      const [id, suffix] = rest.split('/')
      if (!id) return json(res, 400, { error: 'project id required' })
      const q = parseQuery(req.url)

      if (suffix === 'engrams') {
        if (rejectUnknownParams(res, q, ALLOWED_PROJECT_ENGRAMS_PARAMS)) return
        const project = eml.projects.get(id)
        if (!project) return json(res, 404, { error: `project "${id}" not found` })

        const reviewDue = reviewDueParam(q)
        if (reviewDue instanceof Error) return json(res, 400, { error: reviewDue.message })
        const engrams = eml.engrams.query({
          scope: `project.${id}`,
          type: q.type as EngramType | undefined,
          status: q.status as EngramStatus | undefined,
          significance: q.significance as Significance | undefined,
          title: q.title,
          tag: q.tag,
          has_relations: q.has_relations === 'true' ? true : (q.has_relations === 'false' ? false : undefined),
          limit: q.limit ? parseInt(q.limit) : 50,
          offset: q.offset ? parseInt(q.offset) : 0,
          order_by: (q.order_by as OrderBy) || 'updated_at',
          assignee: q.assignee,
          review_due: reviewDue,
          subject: q.subject,
          stage: q.stage,
        })
        return json(res, 200, { count: engrams.length, engrams })
      }

      if (suffix === 'relations') {
        const project = eml.projects.get(id)
        if (!project) return json(res, 404, { error: `project "${id}" not found` })
        const relations = eml.engrams.relationsInScope(`project.${id}`)
        return json(res, 200, { count: relations.length, relations })
      }

      if (suffix && suffix !== '') {
        return json(res, 404, { error: 'Not found' })
      }

      // Brain state — v0.9.1 Cluster 1: no namespace param anymore.
      const state = eml.projects.getBrainState(id)
      if (!state) return json(res, 404, { error: `project "${id}" not found` })
      return json(res, 200, state)
    }

    // === v0.5: Users (First-Class Entity) ===

    // GET /users — list users
    if (url === '/users' && method === 'GET') {
      const users = eml.users.list()
      return json(res, 200, { count: users.length, users })
    }

    // GET /user/:id
    if (url.startsWith('/user/') && method === 'GET') {
      const id = url.slice('/user/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'user id required' })
      const user = eml.users.get(id)
      if (!user) return json(res, 404, { error: `user "${id}" not found` })
      return json(res, 200, { user })
    }

    // === v0.5: Agents (First-Class Entity HTTP/CLI) ===

    // GET /agents — list agents
    if (url === '/agents' && method === 'GET') {
      const agents = eml.agents.list()
      return json(res, 200, { count: agents.length, agents })
    }

    // GET /agent/:id
    if (url.startsWith('/agent/') && method === 'GET') {
      const id = url.slice('/agent/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'agent id required' })
      const agent = eml.agents.get(id)
      if (!agent) return json(res, 404, { error: `agent "${id}" not found` })
      return json(res, 200, { agent })
    }

    // === v0.8 C6: Entities (First-Class) ===

    // GET /entities — list entities (?kind=...)
    if (url === '/entities' && method === 'GET') {
      const q = parseQuery(req.url)
      if (rejectUnknownParams(res, q, new Set(['kind']))) return
      const entities = eml.entities.list(q.kind ? { kind: q.kind as EntityKind } : undefined)
      return json(res, 200, { count: entities.length, entities })
    }

    // GET /entity/:id
    if (url.startsWith('/entity/') && method === 'GET') {
      const id = url.slice('/entity/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'entity id required' })
      const entity = eml.entities.get(id)
      if (!entity) return json(res, 404, { error: `entity "${id}" not found` })
      return json(res, 200, { entity })
    }

    // GET /brain-state?scope=<scope> — generic BrainState (v0.9 Cluster 4).
    // Works for any scope pattern: global / project.X / entity.X /
    // agent.X / user.X. Returns a curated snapshot (status/tasks/decisions/logs/relations).
    // Used by the `eml_show(scope)` tool.
    if (url.startsWith('/brain-state') && method === 'GET') {
      const q = parseQuery(req.url)
      if (rejectUnknownParams(res, q, new Set(['scope']))) return
      if (!q.scope) return json(res, 400, { error: 'scope required' })
      // v0.10.5: return the compact dashboard markdown, not the full structured state
      // (callTool stringifies the whole response → full engrams would blow the budget).
      const state = eml.engrams.buildBrainState(q.scope)
      // A project's dashboard shows its parents' rules too, marked inherited.
      state.rules = [...(state.rules ?? []), ...inheritedRules(eml, q.scope)]
      return json(res, 200, { scope: q.scope, markdown: renderBrainStateMarkdown(state) })
    }

    // POST /project-block — the project context a host injects into a session
    // that works in one project (core/project-block.ts). budget: the caller's
    // hard cap for the markdown, in characters, as for /boot.
    if (url === '/project-block' && method === 'POST') {
      const body = await readBody(req)
      const scope = typeof body.scope === 'string' ? body.scope : ''
      if (!scope.startsWith('project.')) return json(res, 400, { error: 'scope project.<id> required' })
      const budget = typeof body.budget === 'number' && Number.isFinite(body.budget) && body.budget > 0
        ? Math.floor(body.budget) : undefined
      const result = projectBlock(eml, scope.slice('project.'.length), budget !== undefined ? { budget } : {})
      if (!result) return json(res, 404, { error: `project "${scope}" not found` })
      return json(res, 200, result)
    }

    // GET /hygiene — every hygiene check with what it requires, how to fix an
    // entry, and its findings (core hygiene.ts). Read by the cockpit, which
    // offers a brain-hygiene session when a check has findings.
    if (url === '/hygiene' && method === 'GET') {
      return json(res, 200, hygieneCheck(eml))
    }

    // GET /stats
    if (url === '/stats' && method === 'GET') {
      const all = eml.engrams.query({ limit: 10000 })
      const types: Record<string, number> = {}
      const scopes: Record<string, number> = {}
      for (const c of all) {
        types[c.type] = (types[c.type] || 0) + 1
        scopes[c.scope] = (scopes[c.scope] || 0) + 1
      }
      const agents = eml.agents.list()
      const projects = eml.projects.list()
      const users = eml.users.list()
      return json(res, 200, {
        total_engrams: all.length,
        by_type: types,
        by_scope: scopes,
        agents: agents.length,
        projects: projects.length,
        users: users.length,
      })
    }

    // 404
    json(res, 404, { error: 'Not found' })

  } catch (err: unknown) { const e = err as Error;
    // v0.21: a write to a shared brain that is read-only right now
    // v0.21: a write to a shared brain that did not happen as asked (write.ts, sync/sync.ts)
    if (err instanceof SharedWriteError) return json(res, err.status, { error: err.message, code: err.code })
    // v0.21: a project move the server or core refused (move.ts)
    if (err instanceof MoveRouteError) return json(res, err.status, { error: err.message, code: err.code, ...err.data })
    // v0.20: a rejected command — nothing was written
    if (err instanceof CommandError) {
      // CONFLICT: base_rev no longer matches (v0.20) — the caller re-reads at current_rev
      if (err.code === 'CONFLICT') return json(res, 409, { error: err.message, current_rev: err.data?.current_rev })
      return json(res, err.code === 'NOT_FOUND' ? 404 : err.code === 'TOPIC_EXISTS' ? 409 : 400, { error: err.message })
    }
    // v0.8: validation errors from validate.ts/engrams.ts are user-input
    // errors — return them as 400 instead of 500. The patterns match the
    // throw strings in validate.ts (validateScopePattern,
    // validateScopeExists, validateProperties, validateSourceType).
    // v0.15: all new validation errors share the `Invalid engram:` prefix.
    const msg = String(e.message || '')
    // a read rejected by core's rules (core/commands/types.ts isValidationMessage), or an unparseable body
    if (msg === 'Invalid JSON' || isValidationMessage(msg)) {
      return json(res, 400, { error: e.message })
    }
    json(res, 500, { error: e.message })
  }
}

// --- Server ---
const server = http.createServer(handleRequest)

// v0.21: libsodium first (the protocol's crypto), then each shared brain's
// connection to its relay, then the API.
ready().then(() => {
  startSyncs()
  server.listen(PORT, HOST, () => {
    console.log(`EML API v${SERVER_VERSION} running on http://${HOST}:${PORT}`)
    console.log(`Data dir: ${DATA_DIR}  |  Pool cap=${POOL_CAP}, idle=${POOL_IDLE_MIN}min`)
  })
})

// Graceful shutdown — close pool + control DB; per-request EML.fromConnection
// has ownsConnection=false, so nothing is closed twice.
function shutdown(): void {
  for (const sync of syncs.values()) if (sync instanceof Sync) sync.close()
  try { pool.close() } catch { /* best-effort */ }
  try { controlDb.close() } catch { /* best-effort */ }
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
