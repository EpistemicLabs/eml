import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initControlDatabase, provisionUser, issueToken, revokeToken, type ProvisionResult } from '@engramprotocol/core'
import { validDecision, validTask, validNote, validRule } from '../../core/tests/fixtures'
import type { EngramInput } from '@engramprotocol/core'
import { request, waitForReady, flat } from './http-helpers'

/**
 * E2E multi-tenant acceptance (v0.9-PROPOSAL §9 Cluster A test plan).
 *
 * - Token A → brain A engrams; token B → brain B engrams
 * - Cross-brain leak test (negative): no engrams from another brain
 * - Auth validation: 200 valid / 401 invalid+revoked+missing
 *
 * Spawns the built server against tempDataDir with two provisioned users.
 */

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
  const create = (token: string, input: EngramInput) => {
    const { type, body } = flat(input)
    return request('POST', `${baseUrl}/engram/${type}`, { Authorization: `Bearer ${token}` }, JSON.stringify(body))
  }

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
      const r = await create(carolToken, validDecision({ scope: 'global', content: 'carol decision' }))
      expect(r.status).toBe(201)
      expect(r.body.ingested_by).toBe('carol')

      // read back independently → still carol (GET /engram/:id returns fields directly)
      const got = await request('GET', `${baseUrl}/engram/${r.body.id}`,
        { Authorization: `Bearer ${carolToken}` })
      expect(got.body.ingested_by).toBe('carol')
    })

    it('a different token on the same brain stamps its own name', async () => {
      const r = await create(daveToken, validDecision({ scope: 'global', content: 'dave decision' }))
      expect(r.status).toBe(201)
      expect(r.body.ingested_by).toBe('dave')
    })

    it('client cannot forge authorship via request body (v0.19: an unknown field, rejected)', async () => {
      const { body } = flat(validDecision({ scope: 'global', content: 'spoof attempt' }))
      const r = await request('POST', `${baseUrl}/engram/decision`,
        { Authorization: `Bearer ${carolToken}` }, JSON.stringify({ ...body, ingested_by: 'dave' }))
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/unknown field ingested_by for a decision/)
    })
  })

  // v0.11 team-brains: assignee filter exposed on /list (agent or user handle).
  describe('task assignee filter', () => {
    it('GET /list?type=task&assignee=<handle> returns only that handle\'s tasks', async () => {
      const mkTask = (assignee: string, content: string) =>
        create(provB.tokenPlaintext, validTask({ scope: 'global', content, properties: { assignee_id: assignee } }))
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
    it('POST /engram/decision surfaces potential_conflicts when a vocab-overlapping different-title write hits an active candidate', async () => {
      const seed = await create(provA.tokenPlaintext, validDecision({
        scope: 'global', title: 'brand-and-domain',
        content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
      }))
      expect(seed.status).toBe(201)

      const res = await create(provA.tokenPlaintext, validDecision({
        scope: 'global', title: 'brand-rename',
        content: 'Engram Protocol brand naming and domain choice canonical.',
      }))
      expect(res.status).toBe(201)
      expect(res.body.potential_conflicts).toBeDefined()
      const hit = (res.body.potential_conflicts as Array<{ id: string, coverage: number, overlap: string }>)
        .find(c => c.id === seed.body.id)
      expect(hit).toBeDefined()
      expect(hit!.coverage).toBeGreaterThanOrEqual(0.5)
      expect(hit!.overlap).toBe('fts')
    })

    it('a clean novel write omits potential_conflicts entirely', async () => {
      const res = await create(provB.tokenPlaintext, validDecision({
        scope: 'global', title: 'pick-ci-runner',
        content: 'Use GitHub Actions for continuous integration pipelines on pushes.',
      }))
      expect(res.status).toBe(201)
      expect(res.body.potential_conflicts).toBeUndefined()
    })
  })

  // v0.14 Cluster C: relations write-path — /relate validation + created flag, and
  // [[wikilink]] auto-materialize on the write path.
  describe('relations write-path', () => {
    const tok = () => provB.tokenPlaintext
    const auth = () => ({ Authorization: `Bearer ${tok()}` })

    it('a [[title]] in content auto-draws a related_to edge, visible with_relations', async () => {
      const target = await create(tok(), validNote({ title: 'wiki-target', content: 'the target' }))
      const linker = await create(tok(), validNote({ content: 'points at [[wiki-target]]' }))
      expect(linker.status).toBe(201)
      expect(linker.body.unresolved_links).toBeUndefined()

      const got = await request('GET', `${baseUrl}/engram/${linker.body.id}?with_relations=true`, auth())
      const edge = (got.body.relations as Array<{ target_id: string, relation: string, detection_method: string }>)
        .find(r => r.target_id === target.body.id && r.relation === 'related_to')
      expect(edge).toBeTruthy()
      expect(edge!.detection_method).toBe('agent_declared')
    })

    it('an unresolved [[link]] is surfaced on the write response', async () => {
      const r = await create(tok(), validNote({ content: 'dangling [[nope-not-here]]' }))
      expect(r.body.unresolved_links).toEqual(['nope-not-here'])
    })

    it('POST /relate validates verb + existence and reports created (idempotent)', async () => {
      const a = await create(tok(), validNote({ content: 'A' }))
      const b = await create(tok(), validNote({ content: 'B' }))
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

    it('v0.19: POST /relate supersedes / part_of is a 400 pointing to the write path', async () => {
      const a = await create(tok(), validNote({ content: 'A2' }))
      const b = await create(tok(), validNote({ content: 'B2' }))
      const rel = (relation: string) => request('POST', `${baseUrl}/relate`, auth(),
        JSON.stringify({ source_id: a.body.id, target_id: b.body.id, relation }))
      const sup = await rel('supersedes')
      expect(sup.status).toBe(400)
      expect(sup.body.error).toMatch(/supersedes is drawn by a write/)
      const part = await rel('part_of')
      expect(part.status).toBe(400)
      expect(part.body.error).toMatch(/part_of comes from a task's parent/)
    })
  })

  // v0.14 Cluster B: subjects over HTTP — v0.19 through /object/subject, write path, closed notice, ?subject= filter.
  describe('subjects', () => {
    const tok = () => provB.tokenPlaintext
    const auth = () => ({ Authorization: `Bearer ${tok()}` })

    it('POST /object/subject registers (slug id, active), GET /object/subject and /subjects list with member count', async () => {
      const c = await request('POST', `${baseUrl}/object/subject`, auth(), JSON.stringify({ name: 'Norway Trip', description: 'summer' }))
      expect(c.status).toBe(201)
      expect(c.body.object).toMatchObject({ id: 'norway-trip', status: 'active', engram_count: 0 })
      expect(c.body.created).toBe(true)
      // re-create the same slug → no-op, created:false, description NOT overwritten (v0.14 report E)
      const again = await request('POST', `${baseUrl}/object/subject`, auth(), JSON.stringify({ name: 'norway trip', description: 'different' }))
      expect(again.body.created).toBe(false)
      expect(again.body.object.description).toBe('summer')
      const l = await request('GET', `${baseUrl}/subjects`, auth())
      expect(l.status).toBe(200)
      expect(l.body.subjects.map((t: { id: string }) => t.id)).toContain('norway-trip')
      expect((await request('GET', `${baseUrl}/subjects?status=done`, auth())).status).toBe(400)
      const o = await request('GET', `${baseUrl}/object/subject`, auth())
      expect(o.body.objects.map((t: { id: string }) => t.id)).toContain('norway-trip')
    })

    it('a write with an unknown subject is a 400; a known one hydrates on read + ?subject= filters', async () => {
      const bad = await create(tok(), validNote({ content: 'x', subjects: ['ghost'] }))
      expect(bad.status).toBe(400)
      expect(bad.body.error).toMatch(/subject "ghost" not found/)

      const ok = await create(tok(), validNote({ content: 'ferry booked', subjects: ['norway-trip'] }))
      expect(ok.status).toBe(201)
      expect(ok.body.subjects).toEqual(['norway-trip'])
      expect(ok.body.closed_subjects).toBeUndefined()

      const got = await request('GET', `${baseUrl}/engram/${ok.body.id}`, auth())
      expect(got.body.subjects).toEqual(['norway-trip'])
      const list = await request('GET', `${baseUrl}/list?subject=norway-trip`, auth())
      expect(list.body.engrams.map((e: { id: string }) => e.id)).toEqual([ok.body.id])
    })

    it('PUT /object/subject/:id closes; filing into a closed subject works and carries closed_subjects', async () => {
      const closed = await request('PUT', `${baseUrl}/object/subject/norway-trip`, auth(), JSON.stringify({ status: 'closed' }))
      expect(closed.status).toBe(200)
      expect(closed.body.object).toMatchObject({ status: 'closed', engram_count: 1 })
      expect(closed.body.diff.status).toEqual(['active', 'closed'])

      const late = await create(tok(), validNote({ content: 'photos sorted', subjects: ['norway-trip'] }))
      expect(late.status).toBe(201)
      expect(late.body.closed_subjects).toEqual(['norway-trip'])

      const upd = await request('POST', `${baseUrl}/update`, auth(),
        JSON.stringify({ id: late.body.id, patch: { content: 'photos sorted + printed' } }))
      expect(upd.status).toBe(200)
      expect(upd.body.closed_subjects).toBeUndefined()   // subjects not named in the request → no notice

      expect((await request('PUT', `${baseUrl}/object/subject/ghost`, auth(), JSON.stringify({ status: 'closed' }))).status).toBe(404)
      expect((await request('PUT', `${baseUrl}/object/subject/norway-trip`, auth(), JSON.stringify({ status: 'done' }))).status).toBe(400)
    })
  })

  // v0.15 Cluster B / v0.19: the task model over HTTP — POST /task/:id/track,
  // stage filter, part_of via parent_id, the lifecycle errors as 400, confirm on a task.
  describe('task model over HTTP', () => {
    const tok = () => provA.tokenPlaintext
    const auth = () => ({ Authorization: `Bearer ${tok()}` })
    const post = (path: string, body: unknown) => request('POST', `${baseUrl}${path}`, auth(), JSON.stringify(body))
    const get = (path: string) => request('GET', `${baseUrl}${path}`, auth())
    const newTask = async (extra: Partial<EngramInput> = {}) => {
      const r = await create(tok(), validTask({ content: 'http task', ...extra }))
      expect(r.status).toBe(201)
      return r.body as { id: string, ingested_by: string }
    }

    it('POST /task/:id/track text + stage → note + change entries by the token\'s handle; entries come back on GET', async () => {
      const t = await newTask({ title: 'journal-http', properties: { stage: 'planning' } })
      const r = await post(`/task/${t.id}/track`, { text: 'options listed', stage: 'ready' })
      expect(r.status).toBe(200)
      expect(t.ingested_by).toBeTruthy()
      const written = r.body.entries_written as Array<{ kind: string, text: string, author: string, stage: string }>
      expect(written.map(e => [e.kind, e.text])).toEqual([['note', 'options listed'], ['change', 'stage planning → ready']])
      expect(written[0]).toMatchObject({ author: t.ingested_by, stage: 'ready' })

      const plain = await get(`/engram/${t.id}`)
      expect(plain.body.properties.stage).toBe('ready')
      expect(plain.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['change', 'note', 'change'])
      const withRel = await get(`/engram/${t.id}?with_relations=true`)
      expect(withRel.body.entries).toHaveLength(3)
    })

    it('POST /task/:id/track: unknown id → 404, not a task → 400, nothing → 400; /task/:id/entry is gone (410)', async () => {
      expect((await post('/task/no-such-id/track', { text: 'x' })).status).toBe(404)
      const note = await create(tok(), validNote({ content: 'a note' }))
      const notTask = await post(`/task/${note.body.id}/track`, { text: 'x' })
      expect(notTask.status).toBe(400)
      expect(notTask.body.error).toMatch(/is a note, not a task — use eml_update/)
      const t = await newTask()
      const nothing = await post(`/task/${t.id}/track`, {})
      expect(nothing.status).toBe(400)
      expect(nothing.body.error).toMatch(/nothing to track/)
      const gone = await post(`/task/${t.id}/entry`, { text: 'x' })
      expect(gone.status).toBe(410)
      expect(gone.body.error).toMatch(/upgrade @engramprotocol\/mcp-server/)
    })

    it('?stage= filters /list and /project/:id/engrams', async () => {
      expect((await post('/object/project', { id: 'stagep', name: 'Stage project' })).status).toBe(201)
      const r = await create(tok(), validTask({ scope: 'project.stagep', content: 'being built', properties: { stage: 'implementation' } }))
      await create(tok(), validTask({ scope: 'project.stagep', content: 'just an idea', properties: { stage: 'ideation' } }))
      for (const path of ['/list?stage=implementation&scope=project.stagep', '/project/stagep/engrams?stage=implementation']) {
        const l = await get(path)
        expect(l.status, path).toBe(200)
        expect(l.body.engrams.map((e: { id: string }) => e.id), path).toEqual([r.body.id])
      }
    })

    it('parent_id draws part_of; resolving the parent with an open child is a 400 naming it; closing needs outcome + text', async () => {
      const parent = await newTask({ title: 'http-parent', status: 'active' })
      const child = await newTask({ title: 'http-child', parent_id: parent.id })
      const withRel = await get(`/engram/${child.id}?with_relations=true`)
      expect(withRel.body.relations.some((r: { relation: string, target_id: string }) =>
        r.relation === 'part_of' && r.target_id === parent.id)).toBe(true)

      const blocked = await post(`/task/${parent.id}/track`, { status: 'resolved', outcome: 'done', text: 'done' })
      expect(blocked.status).toBe(400)
      expect(blocked.body.error).toBe(`Invalid engram: task ${parent.id} has open sub-tasks: ${child.id} http-child`)

      const noOutcome = await post(`/task/${child.id}/track`, { status: 'resolved', text: 'done' })
      expect(noOutcome.status).toBe(400)
      expect(noOutcome.body.error).toMatch(/closing a task needs an outcome/)
      const noText = await post(`/task/${child.id}/track`, { status: 'resolved', outcome: 'done' })
      expect(noText.status).toBe(400)
      expect(noText.body.error).toMatch(/closing needs text/)

      // a task is not changed through /update
      const viaUpdate = await post('/update', { id: child.id, patch: { content: 'x' } })
      expect(viaUpdate.status).toBe(400)
      expect(viaUpdate.body.error).toMatch(/everything about a task goes through eml_track_task/)
    })

    it('a bad parent_id is a 400 and writes nothing', async () => {
      const before = (await get('/list?type=task&limit=200')).body.count
      const r = await create(tok(), validTask({ content: 'orphan?', parent_id: 'no-such-id' }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: part_of needs two tasks.')
      expect((await get('/list?type=task&limit=200')).body.count).toBe(before)
    })

    it('re-parenting through track: parent_id moves the task, a cycle is a 400', async () => {
      const a = await newTask(); const b = await newTask()
      const moved = await post(`/task/${b.id}/track`, { parent_id: a.id })
      expect(moved.status).toBe(200)
      const cycle = await post(`/task/${a.id}/track`, { parent_id: b.id })
      expect(cycle.status).toBe(400)
      expect(cycle.body.error).toBe('Invalid engram: part_of would create a cycle.')
    })

    it('a bad stage is a 400; confirm-review on a task is a 200', async () => {
      const bad = await create(tok(), validTask({ content: 'x', properties: { stage: 'done' } }))
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe('Invalid engram: stage must be one of ideation, planning, ready, implementation.')
      const t = await newTask()
      const c = await post(`/engram/${t.id}/confirm-review`, {})
      expect(c.status).toBe(200)
      expect(c.body.engram.id).toBe(t.id)
    })

    it('GET /hygiene lists the checks with their findings', async () => {
      const r = await create(tok(), validRule({ title: 'fits-the-format', content: 'do Y' }))
      expect(r.status).toBe(201)
      const h = await get('/hygiene')
      expect(h.status).toBe(200)
      expect(h.body.checks.map((c: { id: string }) => c.id)).toEqual([
        'rule-profile-format', 'reference-without-source', 'profile-scope', 'superseded-without-successor',
        'rule-without-why', 'rule-without-agreement', 'task-link-without-binding', 'review-due',
      ])
      expect(h.body.checks[0]).toMatchObject({ kind: 'migration', since_schema: 18, findings: [] })
      expect(typeof h.body.total).toBe('number')
      expect(typeof h.body.schema).toBe('number')
    })
  })

  // v0.15 Cluster C: task_id on a write — edge + entry in one core transaction,
  // entry authored by the token's handle; a bad task_id is a 400 that writes nothing.
  describe('task-linked writes over HTTP', () => {
    const tok = () => provA.tokenPlaintext
    const get = (path: string) => request('GET', `${baseUrl}${path}`, { Authorization: `Bearer ${tok()}` })

    it('a decision with task_id + binding → derived_from edge + change entry by the caller', async () => {
      const task = await create(tok(), validTask({ title: 'http-hub', content: 'hub' }))
      const d = await create(tok(), validDecision({ title: 'http-pick', content: 'pick it', task_id: task.body.id, properties: { binding: 'task' } }))
      expect(d.status).toBe(201)

      const got = await get(`/engram/${task.body.id}?with_relations=true`)
      const linked = (got.body.entries as Array<{ kind: string, text: string, author: string }>).filter(e => e.text.startsWith('decision'))
      expect(linked).toEqual([expect.objectContaining({ kind: 'change', author: task.body.ingested_by, text: `decision taken: http-pick (${d.body.id})` })])
      expect(got.body.relations.some((r: { relation: string, source_id: string }) =>
        r.relation === 'derived_from' && r.source_id === d.body.id)).toBe(true)
      expect(got.body.bound.map((b: { id: string }) => b.id)).toEqual([d.body.id])
    })

    it('a bad task_id is a 400 and leaves no orphan decision; task_id without binding is a 400', async () => {
      const before = (await get('/list?type=decision&limit=200')).body.count
      const r = await create(tok(), validDecision({ content: 'orphan?', task_id: 'no-such-task', properties: { binding: 'task' } }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: task_id no-such-task is not a task.')
      const task = await create(tok(), validTask())
      const noBinding = await create(tok(), validDecision({ content: 'unbound', task_id: task.body.id }))
      expect(noBinding.status).toBe(400)
      expect(noBinding.body.error).toMatch(/needs binding/)
      expect((await get('/list?type=decision&limit=200')).body.count).toBe(before)
    })
  })

  // v0.15 Cluster A: the create-time decision rules surface as 400 (shared
  // `Invalid engram:` prefix in the error mapping); v0.19: /store and /context are gone.
  describe('decision validation over HTTP', () => {
    const auth = () => ({ Authorization: `Bearer ${provA.tokenPlaintext}` })

    it('POST /engram/decision without alternatives is a 400 naming what is missing, not a 500', async () => {
      const r = await request('POST', `${baseUrl}/engram/decision`, auth(),
        JSON.stringify({ scope: 'global', title: 'use-sqlite', content: 'use sqlite', rationale: 'one file' }))
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Invalid engram: a decision needs alternatives.')
    })

    it('POST /store and /context answer 410 with the upgrade hint', async () => {
      for (const path of ['/store', '/context']) {
        const r = await request('POST', `${baseUrl}${path}`, auth(),
          JSON.stringify({ type: 'decision', scope: 'global', content: 'old client' }))
        expect(r.status, path).toBe(410)
        expect(r.body.error).toMatch(/removed in EML v0\.19.*upgrade @engramprotocol\/mcp-server to ≥ 0\.19/)
      }
    })
  })
})
