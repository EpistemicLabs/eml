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
 *   POST /recall            { query: string, limit? }                → Recall
 *   POST /store             { content, type, scope, ... }            → DEPRECATED v0.7 — use /context
 *   POST /context           { content, type, scope, ... }            → Store an engram (v0.7)
 *   POST /update            { id, patch }                            → Update engram (v0.4)
 *   POST /relate            { source_id, target_id, relation, ... }  → Create relation (v0.4, v0.7 idempotent)
 *   GET  /list              ?type=&scope=&limit=&search=&tag=&label=&subject= → List engrams (v0.7 strict params; label v0.13.x, subject v0.14)
 *   GET  /engram/:id        ?with_relations=                         → Get single engram (v0.7)
 *   POST /project           { id, name, goal?, ... }                 → Create project (v0.4)
 *   GET  /projects          ?status=                                 → List projects (v0.4)
 *   POST /tag               { name, description? }                   → Register a tag (v0.12)
 *   GET  /tags                                                       → List registered tags (v0.12)
 *   POST /subject             { name, description? }                   → Register a subject (v0.14)
 *   GET  /subjects            ?status=                                 → List subjects with status + member count (v0.14)
 *   PUT  /subject/:id         { name?, description?, status? }         → Update / close / reopen a subject (v0.14)
 *   GET  /project/:id                                                → Curated brain state (v0.4)
 *   GET  /project/:id/engrams  ?type=&status=&limit=&offset=         → Paginated engram list (v0.4, v0.7 caller-aware)
 *   PUT  /project/:id       { name?, status?, ... }                  → Update project (v0.4)
 *   POST /user              { id, name, email?, ... }                → Create user (v0.5)
 *   GET  /users                                                      → List users (v0.5)
 *   GET  /user/:id                                                   → Get user (v0.5)
 *   PUT  /user/:id          { name?, email?, ... }                   → Update user (v0.5)
 *   POST /agent             { id, name, parent_id?, ... }            → Create agent (v0.5)
 *   GET  /agents                                                     → List agents (v0.5)
 *   GET  /agent/:id                                                  → Get agent (v0.5)
 *   PUT  /agent/:id         { name?, parent_id?, ... }               → Update agent (v0.5)
 *   POST /engram/:id/confirm-review                                   → Confirm a review (v0.8 C9; v0.15: tasks too)
 *   POST /task/:id/entry    { text, stage? }                         → Append a task entry (v0.15)
 *   POST /entity            { id, name, kind, description? }         → Create entity (v0.8 C6)
 *   GET  /entities          ?kind=                                   → List entities (v0.8 C6)
 *   GET  /entity/:id                                                 → Get entity (v0.8 C6)
 *   PUT  /entity/:id        { name?, kind?, description? }           → Update entity (v0.8 C6)
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
  boot,
  hygieneCheck,
  renderRecallMarkdown,
  renderBrainStateMarkdown,
  slugifySubject,
  ALL_RULES,
  type EngramType,
  type EngramStatus,
  type Significance,
  type EntityKind,
  type ProjectStatus,
  type SubjectStatus,
} from '@engramprotocol/core'
import { ConnectionPool } from './pool'
import { startReviewSweepScheduler } from './review-sweep'
import { authenticate as authMiddleware, type AuthContext } from './middleware/auth'
import { route as routeMiddleware } from './middleware/routing'

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

// v0.13: nightly deterministic review-label sweep — stamps the `review` label on
// active decision/rule/profile past their review_due_at. Runs once now (fresh
// labels post-deploy) + daily. The ONLY writer of the `review` label (MVP).
startReviewSweepScheduler({ control: controlDb, dataDir: DATA_DIR })

// --- Helpers ---
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
// v0.14 Cluster C: the relation verbs the DB CHECK accepts — validated in the
// /relate route so a bad verb is a 400, not a CHECK-constraint 500.
const RELATION_VERBS = new Set([
  'supports', 'contradicts', 'supersedes', 'derived_from', 'refines', 'related_to', 'blocks',
  'part_of', // v0.15: child task → parent task (tasks only, acyclic, one parent — enforced in core)
])

const ALLOWED_LIST_PARAMS = new Set([
  'type', 'scope', 'title',
  'status', 'significance',
  'search', 'order_by', 'limit', 'offset', 'has_relations',
  'assignee', // v0.11 team-brains: filter tasks by assignee handle (agent or user)
  'tag',      // v0.12: filter engrams by registered tag id
  'label',    // v0.13.x: filter engrams by label id (e.g. review)
  'subject',    // v0.14: filter engrams by subject id (cross-scope strand)
  'stage',    // v0.15: filter tasks by stage
])

const ALLOWED_PROJECT_ENGRAMS_PARAMS = new Set([
  'type', 'status', 'significance',
  'title', 'order_by', 'limit', 'offset', 'has_relations',
  'assignee', // v0.11 team-brains
  'tag',      // v0.12: filter engrams by registered tag id
  'label',    // v0.13.x: filter engrams by label id (e.g. review)
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

const STORE_DEPRECATION_HEADERS = {
  // RFC 8594 — HTTP-Date format (RFC 7231).
  'Deprecation': 'Tue, 28 Apr 2026 00:00:00 GMT',
  'Sunset': 'Sun, 28 Feb 2027 00:00:00 GMT',
  'Link': '</context>; rel="successor-version"',
  'Warning': '299 - "POST /store is deprecated. Use POST /context."',
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

  try {
    // POST /boot
    if (url === '/boot' && method === 'POST') {
      const body = await readBody(req)
      const reviewDays = parseInt(process.env.BOOT_REVIEW_THRESHOLD_DAYS || '14', 10)
      // budget: the caller's hard cap for the markdown, in characters — the
      // hook passes the limit of the harness it serves (core/boot.ts, "Size budget").
      const budget = typeof body.budget === 'number' && Number.isFinite(body.budget) && body.budget > 0
        ? Math.floor(body.budget) : undefined
      const result = boot(eml, body.agent || defaultAgent, {
        reviewDays,
        version: SERVER_VERSION,
        systemRules: ALL_RULES,
        ...(budget !== undefined && { budget }),
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

    // v0.7/v0.8: shared store logic for /store, /epistemic, /context.
    // v0.9.1 Cluster 1: no namespace/caller resolution anymore. The body is
    // passed 1:1 to EngramStore.store() — scope/properties come straight
    // from the client body.
    // v0.15: no default type — every store route requires `type` (a defaulted
    // `decision` would fail the create-time decision validation anyway).
    function buildStoreInput(body: RequestBody) {
      const scope = body.scope ?? 'global'
      const properties: Record<string, any> = { ...(body.properties ?? {}) }

      return {
        content: body.content,
        type: body.type,
        scope,
        title: body.title,
        status: body.status,
        significance: body.significance,
        properties: Object.keys(properties).length > 0 ? properties : undefined,
        ingestion_method: body.ingestion_method,
        session_id: body.session_id,
        // v0.12: registered tag ids; validated against the tag registry in core.
        tags: body.tags,
        // v0.14: registered subject ids; validated against the subject registry in core.
        subjects: body.subjects,
        // v0.15: parent task of a new task (part_of, atomic with the insert in core).
        parent_id: body.parent_id,
        // v0.15: task this decision/note was written in — edge + task entry in the
        // same core transaction; the entry's author is the caller (authCtx.caller).
        task_id: body.task_id,
      }
    }

    // v0.14: filing into a CLOSED subject is allowed (late filing) — but say so,
    // so the writer notices when it meant an active strand. Only for subjects the
    // request itself named; attached as `closed_subjects` when non-empty.
    function withClosedSubjectNotice<T extends { subjects: string[] }>(engram: T, requested: unknown): T & { closed_subjects?: string[] } {
      if (!Array.isArray(requested) || requested.length === 0) return engram
      const statuses = eml.subjects.statusByIds(engram.subjects)
      const closed = engram.subjects.filter(t => statuses.get(t) === 'closed')
      return closed.length > 0 ? { ...engram, closed_subjects: closed } : engram
    }

    // POST /store — DEPRECATED v0.7 (sunset v0.11). Still works.
    if (url === '/store' && method === 'POST') {
      const body = await readBody(req)
      if (!body.content) return json(res, 400, { error: 'content required' })
      if (!body.type) return json(res, 400, { error: 'type required' })

      console.warn(
        `[WARN] POST /store called (deprecated since v0.7) — token=${authCtx.tokenId}, ` +
        `type=${body.type}. Migrate to /context.`
      )

      const engram = eml.engrams.store(buildStoreInput(body), authCtx.caller)
      return respond(res, 201, withClosedSubjectNotice(engram, body.subjects), STORE_DEPRECATION_HEADERS)
    }

    // POST /context — the write path (MCP tools, cockpit).
    if (url === '/context' && method === 'POST') {
      const body = await readBody(req)
      if (!body.content) return json(res, 400, { error: 'content required' })
      if (!body.type) return json(res, 400, { error: 'type required' })

      const engram = eml.engrams.store(buildStoreInput(body), authCtx.caller)
      return json(res, 201, withClosedSubjectNotice(engram, body.subjects))
    }

    // GET /list — v0.9.1 Cluster 1: no namespace filter anymore (1 user = 1 brain).
    if (url === '/list' && method === 'GET') {
      const q = parseQuery(req.url)
      if (rejectUnknownParams(res, q, ALLOWED_LIST_PARAMS)) return

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
        label: q.label,
        subject: q.subject,
        stage: q.stage,
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

    // POST /update — engram update.
    // v0.9.1 Cluster 1: no namespace check anymore — all engrams in the brain
    // belong to its one user.
    if (url === '/update' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id) return json(res, 400, { error: 'id required' })
      if (!body.patch || typeof body.patch !== 'object') return json(res, 400, { error: 'patch object required' })

      const engram = eml.engrams.update(body.id, body.patch)
      if (!engram) return json(res, 404, { error: 'engram not found' })
      return json(res, 200, withClosedSubjectNotice(engram, body.patch.subjects))
    }

    // v0.15: POST /task/:id/entry { text, stage? } — append to a task's journal.
    // The author is the token's handle; unknown id → 404, not a task → 400 (core).
    if (url.match(/^\/task\/[^/]+\/entry$/) && method === 'POST') {
      const id = url.slice('/task/'.length, -'/entry'.length)
      const body = await readBody(req)
      if (!body.text) return json(res, 400, { error: 'text required' })
      const entry = eml.engrams.appendTaskEntry(id, { text: body.text, stage: body.stage }, authCtx.caller)
      if (!entry) return json(res, 404, { error: 'engram not found' })
      return json(res, 201, { entry })
    }

    // v0.8 C9: POST /engram/:id/confirm-review
    // Sets review_due_at = now() + default days[type] (decision/rule/profile);
    // v0.15: for a task it counts as a movement (updated_at bumped, label cleared).
    if (url.match(/^\/engram\/[^/]+\/confirm-review$/) && method === 'POST') {
      const id = url.slice('/engram/'.length, -'/confirm-review'.length)
      try {
        const engram = eml.engrams.confirmReview(id)
        if (!engram) return json(res, 404, { error: 'engram not found' })
        return json(res, 200, { engram })
      } catch (err: unknown) { const e = err as Error;
        return json(res, 400, { error: e.message })
      }
    }

    // POST /relate — create relation between two engrams.
    // v0.9.1 Cluster 1: no cross-namespace check anymore.
    if (url === '/relate' && method === 'POST') {
      const body = await readBody(req)
      if (!body.source_id || !body.target_id || !body.relation) {
        return json(res, 400, { error: 'source_id, target_id, relation required' })
      }
      if (!RELATION_VERBS.has(body.relation)) {
        return json(res, 400, { error: `invalid relation "${body.relation}" — one of ${[...RELATION_VERBS].join(', ')}` })
      }
      // v0.14 Cluster C: validate both endpoints exist so eml_relate can't draw a
      // dangling edge (relations has no FK). Self-links are meaningless → reject.
      if (body.source_id === body.target_id) {
        return json(res, 400, { error: 'source_id and target_id must differ' })
      }
      if (!eml.engrams.exists(body.source_id)) return json(res, 404, { error: `engram "${body.source_id}" not found` })
      if (!eml.engrams.exists(body.target_id)) return json(res, 404, { error: `engram "${body.target_id}" not found` })

      const created = eml.engrams.relate({
        source_id: body.source_id,
        target_id: body.target_id,
        relation: body.relation,
        detection_method: body.detection_method || 'manual',
        strength: body.strength,
        explanation: body.explanation,
        metadata: body.metadata,
      })
      return json(res, 201, { ok: true, created })
    }

    // === v0.12: Tags (registered facet vocabulary) ===

    // POST /tag — register a tag. id is the normalized slug of name; re-creating
    // an existing slug is a no-op returning the existing tag (reuse, not dup).
    if (url === '/tag' && method === 'POST') {
      const body = await readBody(req)
      if (!body.name) return json(res, 400, { error: 'name required' })
      const tag = eml.tags.create({ name: body.name, description: body.description })
      return json(res, 201, { tag })
    }

    // GET /tags — list the registered tag vocabulary (the recall-first surface).
    if (url === '/tags' && method === 'GET') {
      const tags = eml.tags.list()
      return json(res, 200, { count: tags.length, tags })
    }

    // === v0.14: Subjects (the "heavy facet": registry with description + lifecycle) ===

    // POST /subject — register a subject. id is the normalized slug of name;
    // re-creating an existing slug is a no-op returning the existing subject.
    if (url === '/subject' && method === 'POST') {
      const body = await readBody(req)
      if (!body.name) return json(res, 400, { error: 'name required' })
      // v0.14: signal whether this registered a NEW subject or returned an existing
      // one (create is a no-op on an existing slug — description is NOT overwritten,
      // so the caller must know its description didn't take). Mirrors /relate's { created }.
      const created = !eml.subjects.exists(slugifySubject(body.name))
      const subject = eml.subjects.create({ name: body.name, description: body.description })
      return json(res, 201, { subject, created })
    }

    // GET /subjects — the subject registry with status + member count (recall-first surface).
    if (url === '/subjects' && method === 'GET') {
      const q = parseQuery(req.url)
      if (q.status !== undefined && q.status !== 'active' && q.status !== 'closed') {
        return json(res, 400, { error: 'status must be active or closed' })
      }
      const subjects = eml.subjects.list(q.status as SubjectStatus | undefined)
      return json(res, 200, { count: subjects.length, subjects })
    }

    // PUT /subject/:id — rename, edit the description, close or reopen.
    if (url.startsWith('/subject/') && method === 'PUT') {
      const id = decodeURIComponent(url.slice('/subject/'.length).split('/')[0])
      if (!id) return json(res, 400, { error: 'subject id required' })
      const body = await readBody(req)
      if (!eml.subjects.get(id)) return json(res, 404, { error: `subject "${id}" not found` })
      const subject = eml.subjects.update(id, {
        name: body.name,
        description: body.description,
        status: body.status,
      })
      return json(res, 200, { subject })
    }

    // === v0.4: Projects (First-Class Entity) ===

    // POST /project — create project
    if (url === '/project' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id || !body.name) return json(res, 400, { error: 'id and name required' })
      try {
        const project = eml.projects.create({
          id: body.id,
          name: body.name,
          status: body.status,
          goal: body.goal,
          description: body.description,
          owner: body.owner,
          parent_project: body.parent_project,
          tags: body.tags,
          started_at: body.started_at,
          ended_at: body.ended_at,
          metadata: body.metadata,
        })
        return json(res, 201, { project })
      } catch (err: unknown) { const e = err as Error;
        if (String(e.message).includes('UNIQUE')) {
          return json(res, 409, { error: `project "${body.id}" already exists` })
        }
        throw err
      }
    }

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
          label: q.label,
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

    // PUT /project/:id — update
    if (url.startsWith('/project/') && method === 'PUT') {
      const id = url.slice('/project/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'project id required' })
      const body = await readBody(req)
      const project = eml.projects.update(id, body)
      if (!project) return json(res, 404, { error: `project "${id}" not found` })
      return json(res, 200, { project })
    }

    // === v0.5: Users (First-Class Entity) ===

    // POST /user — create user
    if (url === '/user' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id || !body.name) return json(res, 400, { error: 'id and name required' })
      try {
        const user = eml.users.create({
          id: body.id,
          name: body.name,
          email: body.email,
          description: body.description,
          metadata: body.metadata,
        })
        return json(res, 201, { user })
      } catch (err: unknown) { const e = err as Error;
        if (String(e.message).includes('UNIQUE')) {
          return json(res, 409, { error: `user "${body.id}" already exists` })
        }
        throw err
      }
    }

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

    // PUT /user/:id — update
    if (url.startsWith('/user/') && method === 'PUT') {
      const id = url.slice('/user/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'user id required' })
      const body = await readBody(req)
      const user = eml.users.update(id, body)
      if (!user) return json(res, 404, { error: `user "${id}" not found` })
      return json(res, 200, { user })
    }

    // === v0.5: Agents (First-Class Entity HTTP/CLI) ===

    // POST /agent — create agent
    if (url === '/agent' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id || !body.name) return json(res, 400, { error: 'id and name required' })
      try {
        const agent = eml.agents.store({
          id: body.id,
          name: body.name,
          parent_id: body.parent_id,
          domains: body.domains,
          description: body.description,
          metadata: body.metadata,
        })
        return json(res, 201, { agent })
      } catch (err: unknown) { const e = err as Error;
        if (String(e.message).includes('UNIQUE')) {
          return json(res, 409, { error: `agent "${body.id}" already exists` })
        }
        throw err
      }
    }

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

    // PUT /agent/:id — update
    if (url.startsWith('/agent/') && method === 'PUT') {
      const id = url.slice('/agent/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'agent id required' })
      const body = await readBody(req)
      const agent = eml.agents.update(id, body)
      if (!agent) return json(res, 404, { error: `agent "${id}" not found` })
      return json(res, 200, { agent })
    }

    // === v0.8 C6: Entities (First-Class) ===

    // POST /entity — create entity
    if (url === '/entity' && method === 'POST') {
      const body = await readBody(req)
      if (!body.id || !body.name || !body.kind) {
        return json(res, 400, { error: 'id, name and kind required' })
      }
      try {
        const entity = eml.entities.create({
          id: body.id,
          name: body.name,
          kind: body.kind,
          description: body.description,
        })
        return json(res, 201, { entity })
      } catch (err: unknown) { const e = err as Error;
        if (String(e.message).includes('UNIQUE')) {
          return json(res, 409, { error: `entity "${body.id}" already exists` })
        }
        if (String(e.message).includes('CHECK')) {
          return json(res, 400, { error: 'invalid kind (allowed: person, org, asset)' })
        }
        throw err
      }
    }

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

    // PUT /entity/:id — update
    if (url.startsWith('/entity/') && method === 'PUT') {
      const id = url.slice('/entity/'.length).split('/')[0]
      if (!id) return json(res, 400, { error: 'entity id required' })
      const body = await readBody(req)
      try {
        const entity = eml.entities.update(id, body)
        if (!entity) return json(res, 404, { error: `entity "${id}" not found` })
        return json(res, 200, { entity })
      } catch (err: unknown) { const e = err as Error;
        if (String(e.message).includes('CHECK')) {
          return json(res, 400, { error: 'invalid kind (allowed: person, org, asset)' })
        }
        throw err
      }
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
      return json(res, 200, { scope: q.scope, markdown: renderBrainStateMarkdown(state) })
    }

    // GET /hygiene — every hygiene check with what it requires, how to fix an
    // entry, and its findings (core hygiene.ts). Read by the cockpit, which opens
    // a brain-hygiene session when a check has findings.
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
    // v0.8: validation errors from validate.ts/engrams.ts are user-input
    // errors — return them as 400 instead of 500. The patterns match the
    // throw strings in validate.ts (validateScopePattern,
    // validateScopeExists, validateProperties, validateSourceType).
    // v0.15: all new validation errors share the `Invalid engram:` prefix.
    const msg = String(e.message || '')
    if (
      msg.startsWith('Invalid engram:') ||
      msg.startsWith('Invalid scope') ||
      msg.startsWith('Scope ') ||
      msg.startsWith('Missing required properties') ||
      msg.startsWith('Invalid source_type') ||
      msg.startsWith('tag "') ||           // v0.12: unknown tag on a write
      msg.startsWith('invalid tag name') ||  // v0.12: unslugifiable tag name
      msg.startsWith('subject "') ||           // v0.14: unknown subject on a write
      msg.startsWith('invalid subject') ||     // v0.14: unslugifiable name / bad status
      msg.startsWith('subject name must')      // v0.14: empty rename
    ) {
      return json(res, 400, { error: e.message })
    }
    json(res, 500, { error: e.message })
  }
}

// --- Server ---
const server = http.createServer(handleRequest)

server.listen(PORT, HOST, () => {
  console.log(`EML API v${SERVER_VERSION} running on http://${HOST}:${PORT}`)
  console.log(`Data dir: ${DATA_DIR}  |  Pool cap=${POOL_CAP}, idle=${POOL_IDLE_MIN}min`)
})

// Graceful shutdown — close pool + control DB; per-request EML.fromConnection
// has ownsConnection=false, so nothing is closed twice.
function shutdown(): void {
  try { pool.close() } catch { /* best-effort */ }
  try { controlDb.close() } catch { /* best-effort */ }
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
