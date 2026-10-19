import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initControlDatabase, provisionUser, issueToken, revokeToken, type ProvisionResult } from '@engramprotocol/core'
import { validDecision } from '../../core/tests/fixtures'

/**
 * E2E multi-tenant acceptance (v0.9-PROPOSAL §9 Cluster A test plan).
 *
 * - Token A → brain A engrams; token B → brain B engrams
 * - Cross-brain leak test (negative): no engrams from another brain
 * - Auth validation: 200 valid / 401 invalid+revoked+missing
 *
 * Spawns the built server against tempDataDir with two provisioned users.
 */

interface HttpResult { status: number, body: any }

function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8')
          const parsed = text ? JSON.parse(text) : null
          resolve({ status: res.statusCode || 0, body: parsed })
        } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')))
  })
}

function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else if (Date.now() - start > timeoutMs) reject(new Error(`health=${res.statusCode}`))
        else setTimeout(tick, 100)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server never came up'))
        else setTimeout(tick, 100)
      })
    }
    tick()
  })
}

describe('Cluster-A E2E — Token-Bound Routing + Cross-Brain-Isolation', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let provA: ProvisionResult
  let provB: ProvisionResult
  const port = 31280 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-e2e-test-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })

    // v0.9 bootstrap: init control.db + provision two users, each with their own brain
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    provA = provisionUser({ email: 'alice@example.com', agentId: 'alice', userId: 'alice', control, dataDir: tmpDir })
    provB = provisionUser({ email: 'bob@example.com',   agentId: 'bob',   userId: 'bob',   control, dataDir: tmpDir })
    control.close()

    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(port)
  }, 10000)

  afterAll(() => {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('auth', () => {
    it('missing Authorization → 401', async () => {
      const r = await request('GET', `${baseUrl}/agents`)
      expect(r.status).toBe(401)
    })

    it('malformed Authorization (not Bearer) → 401', async () => {
      const r = await request('GET', `${baseUrl}/agents`, { Authorization: 'Basic xxx' })
      expect(r.status).toBe(401)
    })

    it('unknown bearer token → 401', async () => {
      const fake = 'eml_' + 'f'.repeat(40)
      const r = await request('GET', `${baseUrl}/agents`, { Authorization: `Bearer ${fake}` })
      expect(r.status).toBe(401)
    })

    it('valid token → 200', async () => {
      const r = await request('GET', `${baseUrl}/agents`, { Authorization: `Bearer ${provA.tokenPlaintext}` })
      expect(r.status).toBe(200)
    })
  })

  describe('cross-brain isolation', () => {
    it('token A writes an agent → token B does NOT see the agent', async () => {
      // Token A creates a unique agent in brain A
      const created = await request('POST', `${baseUrl}/agent`,
        { Authorization: `Bearer ${provA.tokenPlaintext}` },
        JSON.stringify({ id: 'alice-only-agent', name: 'Alice Only' }),
      )
      expect(created.status).toBe(201)

      // Token A sees it
      const aSees = await request('GET', `${baseUrl}/agent/alice-only-agent`,
        { Authorization: `Bearer ${provA.tokenPlaintext}` })
      expect(aSees.status).toBe(200)
      expect(aSees.body.agent.id).toBe('alice-only-agent')

      // Token B does NOT see it (different brain)
      const bSees = await request('GET', `${baseUrl}/agent/alice-only-agent`,
        { Authorization: `Bearer ${provB.tokenPlaintext}` })
      expect(bSees.status).toBe(404)
    })

    it('both brains have separate engram lists (default-brain hello-world per brain)', async () => {
      const aList = await request('GET', `${baseUrl}/list`,
        { Authorization: `Bearer ${provA.tokenPlaintext}` })
      const bList = await request('GET', `${baseUrl}/list`,
        { Authorization: `Bearer ${provB.tokenPlaintext}` })

      expect(aList.status).toBe(200)
      expect(bList.status).toBe(200)
      // Each brain has its own seed engram (and possibly the test agent for A);
      // engram IDs are UUID-disjoint between brains
      const aIds = new Set((aList.body.engrams as Array<{ id: string }>).map(e => e.id))
      const bIds = new Set((bList.body.engrams as Array<{ id: string }>).map(e => e.id))
      const intersection = [...aIds].filter(id => bIds.has(id))
      expect(intersection).toEqual([])
    })
  })

  describe('revoke-token', () => {
    it('revoked token → 401 even if it was 200 before', async () => {
      // Provision a fresh user so the revoke doesn't affect alice/bob
      const control = initControlDatabase(join(tmpDir, 'control.db'))
      const charlie = provisionUser({ email: 'charlie@example.com', agentId: 'charlie', userId: 'charlie', control, dataDir: tmpDir })

      const before = await request('GET', `${baseUrl}/agents`, { Authorization: `Bearer ${charlie.tokenPlaintext}` })
      expect(before.status).toBe(200)

      revokeToken(control, charlie.tokenId)
      control.close()

      const after = await request('GET', `${baseUrl}/agents`, { Authorization: `Bearer ${charlie.tokenPlaintext}` })
      expect(after.status).toBe(401)
    })
  })

  // v0.11 team-brains: two named tokens on the SAME brain → server stamps each
  // engram's ingested_by from the authenticated token's name. Proves per-engram
  // authorship in a shared brain is distinct per token AND unforgeable (a client
  // can't override it via the request body).
  describe('authorship stamping (shared brain, server-side)', () => {
    let carolToken: string
    let daveToken: string

    beforeAll(() => {
      const control = initControlDatabase(join(tmpDir, 'control.db'))
      // both tokens point at brain A (provA's user + brain) — a shared team brain
      carolToken = issueToken(control, { userId: provA.userId, brainId: provA.brainId, name: 'carol' }).plaintext
      daveToken = issueToken(control, { userId: provA.userId, brainId: provA.brainId, name: 'dave' }).plaintext
      control.close()
    })

    it('engram stamped with the writing token name', async () => {
      const r = await request('POST', `${baseUrl}/context`,
        { Authorization: `Bearer ${carolToken}` },
        JSON.stringify(validDecision({ scope: 'global', content: 'carol decision' })),
      )
      expect(r.status).toBe(201)
      expect(r.body.ingested_by).toBe('carol')

      // read back independently → still carol (GET /engram/:id returns fields directly)
      const got = await request('GET', `${baseUrl}/engram/${r.body.id}`,
        { Authorization: `Bearer ${carolToken}` })
      expect(got.body.ingested_by).toBe('carol')
    })

    it('a different token on the same brain stamps its own name', async () => {
      const r = await request('POST', `${baseUrl}/context`,
        { Authorization: `Bearer ${daveToken}` },
        JSON.stringify(validDecision({ scope: 'global', content: 'dave decision' })),
      )
      expect(r.status).toBe(201)
      expect(r.body.ingested_by).toBe('dave')
    })

    it('client cannot forge authorship via request body', async () => {
      const r = await request('POST', `${baseUrl}/context`,
        { Authorization: `Bearer ${carolToken}` },
        JSON.stringify({ ...validDecision({ scope: 'global', content: 'spoof attempt' }), ingested_by: 'dave' }),
      )
      expect(r.status).toBe(201)
      // server stamps from the token, ignoring the body's ingested_by
      expect(r.body.ingested_by).toBe('carol')
    })
  })

  // v0.11 team-brains: assignee filter exposed on /list (agent or user handle).
  describe('task assignee filter', () => {
    it('GET /list?type=task&assignee=<handle> returns only that handle\'s tasks', async () => {
      const mkTask = (assignee: string, content: string) =>
        request('POST', `${baseUrl}/context`,
          { Authorization: `Bearer ${provB.tokenPlaintext}` },
          JSON.stringify({ type: 'task', scope: 'global', content, properties: { assignee_id: assignee } }),
        )
      await mkTask('carol', 'carol task one')
      await mkTask('dave', 'dave task')
      await mkTask('carol', 'carol task two')

      const r = await request('GET', `${baseUrl}/list?type=task&assignee=carol`,
        { Authorization: `Bearer ${provB.tokenPlaintext}` })
      expect(r.status).toBe(200)
      const contents = (r.body.engrams as Array<{ content: string }>).map(e => e.content).sort()
      expect(contents).toEqual(['carol task one', 'carol task two'])
    })
  })

  describe('boot uses caller-aware namespace', () => {
    it('token A boot with caller=alice → boot markdown', async () => {
      const r = await request('POST', `${baseUrl}/boot`,
        { Authorization: `Bearer ${provA.tokenPlaintext}` },
        JSON.stringify({ agent: 'default' }),
      )
      expect(r.status).toBe(200)
      expect(r.body.markdown).toContain('Boot')
    })

    // The hook sends the harness budget (mcp-server BOOT_BUDGET_CHARS); the
    // server passes it to boot() and returns the trim report next to the markdown.
    it('budget in the body → markdown within it, budget report returned', async () => {
      const r = await request('POST', `${baseUrl}/boot`,
        { Authorization: `Bearer ${provA.tokenPlaintext}` },
        JSON.stringify({ agent: 'default', budget: 10_000 }),
      )
      expect(r.status).toBe(200)
      expect(r.body.budget).toMatchObject({ limit: 10_000, fits: true })
      expect(r.body.markdown.length).toBe(r.body.budget.chars)
      expect(r.body.markdown.length).toBeLessThanOrEqual(10_000)
    })

    it('no or invalid budget → no trim, no report', async () => {
      for (const body of [{ agent: 'default' }, { agent: 'default', budget: -5 }, { agent: 'default', budget: '10000' }]) {
        const r = await request('POST', `${baseUrl}/boot`,
          { Authorization: `Bearer ${provA.tokenPlaintext}` },
          JSON.stringify(body),
        )
        expect(r.status).toBe(200)
        expect(r.body.budget).toBeUndefined()
      }
    })
  })

  describe('/health remains public', () => {
    it('no auth required, returns spec format', async () => {
      const r = await request('GET', `${baseUrl}/health`)
      expect(r.status).toBe(200)
      expect(r.body.status).toBe('ok')
      expect(r.body.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof r.body.uptime_sec).toBe('number')
    })
  })

  // v0.10.9: the advisory potential_conflicts field must survive the core → server
  // JSON response verbatim (server passes the store() return through json(res,201,…),
  // no reshaping). This locks the delivery path the conflict guardrail depends on.
  describe('write-time conflict guardrail — HTTP passthrough', () => {
    it('POST /context surfaces potential_conflicts when a vocab-overlapping different-title write hits an active candidate', async () => {
      const auth = { Authorization: `Bearer ${provA.tokenPlaintext}` }

      const seed = await request('POST', `${baseUrl}/context`, auth,
        JSON.stringify(validDecision({
          scope: 'global', title: 'brand-and-domain',
          content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
        })),
      )
      expect(seed.status).toBe(201)

      const res = await request('POST', `${baseUrl}/context`, auth,
        JSON.stringify(validDecision({
          scope: 'global', title: 'brand-rename',
          content: 'Engram Protocol brand naming and domain choice canonical.',
        })),
      )
      expect(res.status).toBe(201)
      expect(res.body.potential_conflicts).toBeDefined()
      const hit = (res.body.potential_conflicts as Array<{ id: string, coverage: number, overlap: string }>)
        .find(c => c.id === seed.body.id)
      expect(hit).toBeDefined()
      expect(hit!.coverage).toBeGreaterThanOrEqual(0.5)
      expect(hit!.overlap).toBe('fts')
    })

    it('POST /context on a clean novel write omits potential_conflicts entirely', async () => {
      const res = await request('POST', `${baseUrl}/context`,
        { Authorization: `Bearer ${provB.tokenPlaintext}` },
        JSON.stringify(validDecision({
          scope: 'global', title: 'pick-ci-runner',
          content: 'Use GitHub Actions for continuous integration pipelines on pushes.',
        })),
      )
      expect(res.status).toBe(201)
      expect(res.body.potential_conflicts).toBeUndefined()
    })
  })

  // v0.14 Cluster C: relations write-path — /relate validation + created flag, and
  // [[wikilink]] auto-materialize on the write path.
  describe('relations write-path', () => {
    const auth = () => ({ Authorization: `Bearer ${provB.tokenPlaintext}` })
    const src = { source_id: 'x', source_type: 'agent' }

    it('a [[title]] in content auto-draws a related_to edge, visible with_relations', async () => {
      const target = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', title: 'wiki-target', content: 'the target', properties: src }))
      const linker = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', content: 'points at [[wiki-target]]', properties: src }))
      expect(linker.status).toBe(201)
      expect(linker.body.unresolved_links).toBeUndefined()

      const got = await request('GET', `${baseUrl}/engram/${linker.body.id}?with_relations=true`, auth())
      const edge = (got.body.relations as Array<{ target_id: string, relation: string, detection_method: string }>)
        .find(r => r.target_id === target.body.id && r.relation === 'related_to')
      expect(edge).toBeTruthy()
      expect(edge!.detection_method).toBe('agent_declared')
    })

    it('an unresolved [[link]] is surfaced on the write response', async () => {
      const r = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', content: 'dangling [[nope-not-here]]', properties: src }))
      expect(r.body.unresolved_links).toEqual(['nope-not-here'])
    })

    it('POST /relate validates verb + existence and reports created (idempotent)', async () => {
      const a = await request('POST', `${baseUrl}/context`, auth(), JSON.stringify({ type: 'note', scope: 'global', content: 'A', properties: src }))
      const b = await request('POST', `${baseUrl}/context`, auth(), JSON.stringify({ type: 'note', scope: 'global', content: 'B', properties: src }))
      const rel = (body: object) => request('POST', `${baseUrl}/relate`, auth(), JSON.stringify(body))

      expect((await rel({ source_id: a.body.id, target_id: b.body.id, relation: 'nonsense' })).status).toBe(400)
      expect((await rel({ source_id: a.body.id, target_id: a.body.id, relation: 'related_to' })).status).toBe(400)
      expect((await rel({ source_id: a.body.id, target_id: 'ghost', relation: 'supports' })).status).toBe(404)

      const first = await rel({ source_id: a.body.id, target_id: b.body.id, relation: 'supports' })
      expect(first.status).toBe(201)
      expect(first.body.created).toBe(true)
      const second = await rel({ source_id: a.body.id, target_id: b.body.id, relation: 'supports' })
      expect(second.body.created).toBe(false)
    })
  })

  // v0.14 Cluster B: subjects over HTTP — registry routes, write path, closed notice, ?subject= filter.
  describe('subjects', () => {
    const auth = () => ({ Authorization: `Bearer ${provB.tokenPlaintext}` })
    const src = { source_id: 'x', source_type: 'agent' }

    it('POST /subject registers (slug id, active), GET /subjects lists with member count', async () => {
      const c = await request('POST', `${baseUrl}/subject`, auth(), JSON.stringify({ name: 'Norway Trip', description: 'summer' }))
      expect(c.status).toBe(201)
      expect(c.body.subject).toMatchObject({ id: 'norway-trip', status: 'active', engram_count: 0 })
      expect(c.body.created).toBe(true)
      // re-create the same slug → no-op, created:false, description NOT overwritten (v0.14 report E)
      const again = await request('POST', `${baseUrl}/subject`, auth(), JSON.stringify({ name: 'norway trip', description: 'different' }))
      expect(again.body.created).toBe(false)
      expect(again.body.subject.description).toBe('summer')
      const l = await request('GET', `${baseUrl}/subjects`, auth())
      expect(l.status).toBe(200)
      expect(l.body.subjects.map((t: { id: string }) => t.id)).toContain('norway-trip')
      expect((await request('GET', `${baseUrl}/subjects?status=done`, auth())).status).toBe(400)
    })

    it('a write with an unknown subject is a 400; a known one hydrates on read + ?subject= filters', async () => {
      const bad = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', content: 'x', subjects: ['ghost'], properties: src }))
      expect(bad.status).toBe(400)
      expect(bad.body.error).toMatch(/subject "ghost" not found/)

      const ok = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', content: 'ferry booked', subjects: ['norway-trip'], properties: src }))
      expect(ok.status).toBe(201)
      expect(ok.body.subjects).toEqual(['norway-trip'])
      expect(ok.body.closed_subjects).toBeUndefined()

      const got = await request('GET', `${baseUrl}/engram/${ok.body.id}`, auth())
      expect(got.body.subjects).toEqual(['norway-trip'])
      const list = await request('GET', `${baseUrl}/list?subject=norway-trip`, auth())
      expect(list.body.engrams.map((e: { id: string }) => e.id)).toEqual([ok.body.id])
    })

    it('PUT /subject/:id closes; filing into a closed subject works and carries closed_subjects', async () => {
      const closed = await request('PUT', `${baseUrl}/subject/norway-trip`, auth(), JSON.stringify({ status: 'closed' }))
      expect(closed.status).toBe(200)
      expect(closed.body.subject).toMatchObject({ status: 'closed', engram_count: 1 })

      const late = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'note', scope: 'global', content: 'photos sorted', subjects: ['norway-trip'], properties: src }))
      expect(late.status).toBe(201)
      expect(late.body.closed_subjects).toEqual(['norway-trip'])

      const upd = await request('POST', `${baseUrl}/update`, auth(),
        JSON.stringify({ id: late.body.id, patch: { content: 'photos sorted + printed' } }))
      expect(upd.body.closed_subjects).toBeUndefined()   // subjects not named in the request → no notice

      expect((await request('PUT', `${baseUrl}/subject/ghost`, auth(), JSON.stringify({ status: 'closed' }))).status).toBe(404)
      expect((await request('PUT', `${baseUrl}/subject/norway-trip`, auth(), JSON.stringify({ status: 'done' }))).status).toBe(400)
    })
  })

  // v0.15 Cluster B: the task model over HTTP — entries route, stage filter,
  // part_of via parent_id and /relate, the lifecycle errors as 400, confirm on a task.
  describe('task model over HTTP (v0.15)', () => {
    const auth = () => ({ Authorization: `Bearer ${provA.tokenPlaintext}` })
    const post = (path: string, body: unknown) => request('POST', `${baseUrl}${path}`, auth(), JSON.stringify(body))
    const get = (path: string) => request('GET', `${baseUrl}${path}`, auth())
    const newTask = async (extra: Record<string, unknown> = {}) => {
      const r = await post('/context', { type: 'task', scope: 'global', content: 'http task', ...extra })
      expect(r.status).toBe(201)
      return r.body as { id: string, ingested_by: string }
    }

    it('POST /task/:id/entry → 201 with author from the token; entries come back on GET (with and without relations)', async () => {
      const t = await newTask({ title: 'journal-http', properties: { stage: 'planning' } })
      const r = await post(`/task/${t.id}/entry`, { text: 'options listed', stage: 'ready' })
      expect(r.status).toBe(201)
      // the entry author is the token's handle — the same one that stamped the task
      expect(t.ingested_by).toBeTruthy()
      expect(r.body.entry).toMatchObject({ task_id: t.id, author: t.ingested_by, stage: 'ready', text: 'options listed' })

      const plain = await get(`/engram/${t.id}`)
      expect(plain.body.properties.stage).toBe('ready')
      expect(plain.body.entries.map((e: { text: string }) => e.text)).toEqual(['options listed'])
      const withRel = await get(`/engram/${t.id}?with_relations=true`)
      expect(withRel.body.entries).toHaveLength(1)
    })

    it('POST /task/:id/entry: unknown id → 404, not a task → 400, no text → 400', async () => {
      expect((await post('/task/no-such-id/entry', { text: 'x' })).status).toBe(404)
      const note = await post('/context', { type: 'note', scope: 'global', content: 'a note' })
      const notTask = await post(`/task/${note.body.id}/entry`, { text: 'x' })
      expect(notTask.status).toBe(400)
      expect(notTask.body.error).toMatch(/^Invalid engram: task_id .* is not a task\.$/)
      const t = await newTask()
      expect((await post(`/task/${t.id}/entry`, {})).status).toBe(400)
    })

    it('?stage= filters /list and /project/:id/engrams', async () => {
      await post('/project', { id: 'stagep', name: 'Stage project' })
      const r = await post('/context', { type: 'task', scope: 'project.stagep', content: 'being built', properties: { stage: 'implementation' } })
      await post('/context', { type: 'task', scope: 'project.stagep', content: 'just an idea', properties: { stage: 'ideation' } })
      for (const path of ['/list?stage=implementation&scope=project.stagep', '/project/stagep/engrams?stage=implementation']) {
        const l = await get(path)
        expect(l.status, path).toBe(200)
        expect(l.body.engrams.map((e: { id: string }) => e.id), path).toEqual([r.body.id])
      }
    })

    it('parent_id on /context draws part_of; resolving the parent with an open child is a 400 naming it', async () => {
      const parent = await newTask({ title: 'http-parent', status: 'active' })
      const child = await newTask({ title: 'http-child', parent_id: parent.id })
      const withRel = await get(`/engram/${child.id}?with_relations=true`)
      expect(withRel.body.relations.some((r: { relation: string, target_id: string }) =>
        r.relation === 'part_of' && r.target_id === parent.id)).toBe(true)

      const blocked = await post('/update', { id: parent.id, patch: { status: 'resolved', properties: { outcome: 'done' } } })
      expect(blocked.status).toBe(400)
      expect(blocked.body.error).toBe(`Invalid engram: task ${parent.id} has open sub-tasks: ${child.id} http-child`)

      const noOutcome = await post('/update', { id: child.id, patch: { status: 'resolved' } })
      expect(noOutcome.status).toBe(400)
      expect(noOutcome.body.error).toBe('Invalid engram: closing a task (resolved/invalidated) needs an outcome.')
    })

    it('a bad parent_id is a 400 and writes nothing', async () => {
      const before = (await get('/list?type=task&limit=200')).body.count
      const r = await post('/context', { type: 'task', scope: 'global', content: 'orphan?', parent_id: 'no-such-id' })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: part_of needs two tasks.')
      expect((await get('/list?type=task&limit=200')).body.count).toBe(before)
    })

    it('POST /relate part_of: accepted verb, rules enforced as 400', async () => {
      const a = await newTask(); const b = await newTask()
      const note = await post('/context', { type: 'note', scope: 'global', content: 'n' })
      expect((await post('/relate', { source_id: b.id, target_id: a.id, relation: 'part_of' })).status).toBe(201)
      const cycle = await post('/relate', { source_id: a.id, target_id: b.id, relation: 'part_of' })
      expect(cycle.status).toBe(400)
      expect(cycle.body.error).toBe('Invalid engram: part_of would create a cycle.')
      const nonTask = await post('/relate', { source_id: note.body.id, target_id: a.id, relation: 'part_of' })
      expect(nonTask.status).toBe(400)
    })

    it('a bad stage is a 400; confirm-review on a task is a 200', async () => {
      const bad = await post('/context', { type: 'task', scope: 'global', content: 'x', properties: { stage: 'done' } })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe('Invalid engram: stage must be one of ideation, planning, ready, implementation.')
      const t = await newTask()
      const c = await post(`/engram/${t.id}/confirm-review`, {})
      expect(c.status).toBe(200)
      expect(c.body.engram.id).toBe(t.id)
    })

    it('GET /hygiene lists the checks with their findings', async () => {
      const r = await post('/context', { type: 'rule', scope: 'global', title: 'fits-the-format', content: 'do Y', properties: { applies: 'always' } })
      expect(r.status).toBe(201)
      const h = await request('GET', `${baseUrl}/hygiene`, { Authorization: `Bearer ${provA.tokenPlaintext}` })
      expect(h.status).toBe(200)
      expect(h.body.checks.map((c: { id: string }) => c.id)).toEqual(['rule-profile-format', 'review-due'])
      expect(h.body.checks[0]).toMatchObject({ kind: 'migration', since_schema: 18, findings: [] })
      expect(typeof h.body.total).toBe('number')
      expect(typeof h.body.schema).toBe('number')
    })
  })

  // v0.15 Cluster C: task_id on a write — edge + entry in one core transaction,
  // entry authored by the token's handle; a bad task_id is a 400 that writes nothing.
  describe('task-linked writes over HTTP (v0.15)', () => {
    const auth = () => ({ Authorization: `Bearer ${provA.tokenPlaintext}` })
    const post = (path: string, body: unknown) => request('POST', `${baseUrl}${path}`, auth(), JSON.stringify(body))
    const get = (path: string) => request('GET', `${baseUrl}${path}`, auth())

    it('POST /context decision with task_id → derived_from edge + entry by the caller', async () => {
      const task = await post('/context', { type: 'task', scope: 'global', title: 'http-hub', content: 'hub' })
      const d = await post('/context', validDecision({ scope: 'global', title: 'http-pick', content: 'pick it', task_id: task.body.id }))
      expect(d.status).toBe(201)

      const got = await get(`/engram/${task.body.id}?with_relations=true`)
      expect(got.body.entries).toHaveLength(1)
      expect(got.body.entries[0]).toMatchObject({ author: task.body.ingested_by, text: `decision taken: http-pick (${d.body.id})` })
      expect(got.body.relations.some((r: { relation: string, source_id: string }) =>
        r.relation === 'derived_from' && r.source_id === d.body.id)).toBe(true)
    })

    it('a bad task_id is a 400 and leaves no orphan decision', async () => {
      const before = (await get('/list?type=decision&limit=200')).body.count
      const r = await post('/context', validDecision({ scope: 'global', content: 'orphan?', task_id: 'no-such-task' }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: task_id no-such-task is not a task.')
      expect((await get('/list?type=decision&limit=200')).body.count).toBe(before)
    })
  })

  // v0.15 Cluster A: the create-time decision rules surface as 400 (shared
  // `Invalid engram:` prefix in the error mapping), and /store has no default type.
  describe('decision validation over HTTP (v0.15)', () => {
    const auth = () => ({ Authorization: `Bearer ${provA.tokenPlaintext}` })

    it('POST /context: a decision without alternatives is a 400 naming what is missing, not a 500', async () => {
      const r = await request('POST', `${baseUrl}/context`, auth(),
        JSON.stringify({ type: 'decision', scope: 'global', content: 'use sqlite', properties: { rationale: 'one file' } }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: a decision needs at least one alternative that was considered and rejected.')
    })

    it('POST /store without type is a 400 (no implicit decision)', async () => {
      const r = await request('POST', `${baseUrl}/store`, auth(),
        JSON.stringify({ scope: 'global', content: 'untyped' }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('type required')
    })

    it('POST /store with a type still writes (deprecated path)', async () => {
      const r = await request('POST', `${baseUrl}/store`, auth(),
        JSON.stringify(validDecision({ scope: 'global', content: 'typed via /store' })))
      expect(r.status).toBe(201)
      expect(r.body.type).toBe('decision')
    })
  })
})
