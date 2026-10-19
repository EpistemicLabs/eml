import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initControlDatabase, provisionUser, type ProvisionResult, type EngramInput } from '@engramprotocol/core'
import {
  validDecision, validTask, validNote, validRule, validEvent, validLog, validReference, validProfile, validStatus,
} from '../../core/tests/fixtures'
import { request, waitForReady, flat } from './http-helpers'

// v0.19 REST surface: typed create routes, task tracking, learnings, the flat
// /update, confirm-review with text, objects, removed routes (410), provenance
// headers and the new list filters. Spawns the built server, one provisioned user.

describe('v0.19 REST', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let prov: ProvisionResult
  const port = 31480 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${prov.tokenPlaintext}`, ...extra })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request('POST', `${baseUrl}${path}`, auth(headers), JSON.stringify(body))
  const put = (path: string, body: unknown) => request('PUT', `${baseUrl}${path}`, auth(), JSON.stringify(body))
  const get = (path: string) => request('GET', `${baseUrl}${path}`, auth())
  const create = (input: EngramInput, headers: Record<string, string> = {}) => {
    const { type, body } = flat(input)
    return post(`/engram/${type}`, body, headers)
  }
  const MCP = { 'X-EML-Session': 'sess-1', 'X-EML-Model': 'claude-test-1', 'X-EML-Harness': 'claude-code', 'X-EML-Ingestion': 'mcp' }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-v019-rest-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    // agentId/userId 'default' so validProfile (scope user.default) has its scope
    prov = provisionUser({ email: 'rest@example.com', agentId: 'default', userId: 'default', control, dataDir: tmpDir })
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

  describe('POST /engram/:type', () => {
    it('creates every type except learning with its fields flat in the body', async () => {
      const inputs: EngramInput[] = [
        validDecision(), validTask(), validNote(), validRule(), validEvent(), validLog(), validReference(),
        validProfile(), validStatus(),
      ]
      for (const input of inputs) {
        const r = await create(input)
        expect(r.status, input.type).toBe(201)
        expect(r.body.type).toBe(input.type)
        for (const [k, v] of Object.entries(input.properties ?? {})) expect(r.body.properties[k], `${input.type}.${k}`).toEqual(v)
      }
      const learning = await post('/engram/learning', { scope: 'global', title: 'x', content: 'x', source: 'self', happened: 'x' })
      expect(learning.status).toBe(400)
      expect(learning.body.error).toMatch(/eml_learning/)
    })

    it('an unknown field is a 400 naming the allowed ones; a removed one adds the upgrade hint', async () => {
      const { body } = flat(validDecision())
      const r = await post('/engram/decision', { ...body, significance: 'high' })
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/unknown field significance for a decision\. Allowed: content, scope, title/)
      expect(r.body.error).toMatch(/upgrade @engramprotocol\/mcp-server to ≥ 0\.19/)
      const plain = await post('/engram/decision', { ...body, flavour: 'x' })
      expect(plain.status).toBe(400)
      expect(plain.body.error).not.toMatch(/upgrade/)
    })

    it('an unknown type is a 404', async () => {
      expect((await post('/engram/feedback', { scope: 'global', content: 'x' })).status).toBe(404)
    })
  })

  describe('provenance', () => {
    it('the MCP headers are stamped on the engram; without them a write is direct', async () => {
      const mcp = await create(validNote({ content: 'via mcp' }), MCP)
      expect(mcp.status).toBe(201)
      expect(mcp.body).toMatchObject({ session_id: 'sess-1', model: 'claude-test-1', harness: 'claude-code', ingestion_method: 'mcp' })
      const direct = await create(validNote({ content: 'via the cockpit' }))
      expect(direct.body).toMatchObject({ session_id: null, model: null, harness: null, ingestion_method: 'direct' })
    })

    it('one log per session: a second log in the same session is a 400 naming the first', async () => {
      const headers = { ...MCP, 'X-EML-Session': 'sess-log' }
      const first = await create(validLog({ title: 'session-log-1' }), headers)
      expect(first.status).toBe(201)
      const second = await create(validLog({ title: 'session-log-2' }), headers)
      expect(second.status).toBe(400)
      expect(second.body.error).toContain(first.body.id)
    })

    it('GET /list?session_id= and ?origin= filter', async () => {
      const l = await get('/list?session_id=sess-1')
      expect(l.status).toBe(200)
      expect(l.body.engrams.map((e: { content: string }) => e.content)).toEqual(['via mcp'])
      const pane = await create(validNote({ content: 'pane note', title: undefined, origin: 'cockpit-notes', app: { user_content_hash: 'h' } }))
      expect(pane.status).toBe(201)
      expect(pane.body.origin).toBe('cockpit-notes')
      const o = await get('/list?origin=cockpit-notes')
      expect(o.body.engrams.map((e: { id: string }) => e.id)).toEqual([pane.body.id])
    })
  })

  describe('POST /task/:id/track', () => {
    it('closing with bound items: keep missing → 400 listing them; keep=[id] → standing, the rest closed; reopen', async () => {
      const task = await create(validTask({ title: 'rest-hub' }))
      const d = await create(validDecision({ title: 'rest-keep', task_id: task.body.id, properties: { binding: 'task' } }))
      const n = await create(validNote({ title: 'rest-plan', task_id: task.body.id, properties: { binding: 'task' } }))

      const noKeep = await post(`/task/${task.body.id}/track`, { status: 'resolved', outcome: 'shipped', text: 'done' })
      expect(noKeep.status).toBe(400)
      expect(noKeep.body.error).toContain(d.body.id)
      expect(noKeep.body.error).toContain(n.body.id)

      const closed = await post(`/task/${task.body.id}/track`, { status: 'resolved', outcome: 'shipped', text: 'done', keep: [d.body.id] })
      expect(closed.status).toBe(200)
      expect(closed.body.status).toBe('resolved')
      expect(closed.body.kept.map((k: { id: string }) => k.id)).toEqual([d.body.id])
      expect(closed.body.closed_with_task.map((k: { id: string, status: string }) => [k.id, k.status])).toEqual([[n.body.id, 'invalidated']])
      expect((await get(`/engram/${d.body.id}`)).body.properties.binding).toBe('standing')

      const reopened = await post(`/task/${task.body.id}/track`, { status: 'active', text: 'one more thing' })
      expect(reopened.status).toBe(200)
      expect(reopened.body.properties.outcome).toBeUndefined()
      expect(reopened.body.reopen_candidates.map((k: { id: string }) => k.id)).toEqual([n.body.id])
    })
  })

  describe('POST /learning', () => {
    it('create → 201 with ripeness; the same topic → 200 written:false with the match; evidence by id', async () => {
      const first = await post('/learning', {
        scope: 'user.default', title: 'ask-before-push', content: 'Ask before pushing.',
        source: 'user', happened: 'pushed without asking', quote: 'frag erst',
      }, MCP)
      expect(first.status).toBe(201)
      expect(first.body.written).toBe(true)
      expect(first.body.learning.state).toBe('collecting')

      const again = await post('/learning', {
        scope: 'user.default', title: 'ask-before-pushing', content: 'Ask before pushing code.', source: 'self', happened: 'again',
      })
      expect(again.status).toBe(200)
      expect(again.body.written).toBe(false)
      expect(again.body.matches[0].id).toBe(first.body.engram.id)

      const evidence = await post('/learning', { id: first.body.engram.id, source: 'observed', happened: 'user frowned' },
        { ...MCP, 'X-EML-Session': 'sess-2' })
      expect(evidence.status).toBe(201)
      expect(evidence.body.learning.state).toBe('ripe')

      const userWithoutQuote = await post('/learning', { id: first.body.engram.id, source: 'user', happened: 'x' })
      expect(userWithoutQuote.status).toBe(400)
      expect(userWithoutQuote.body.error).toMatch(/needs quote/)
    })
  })

  describe('POST /update (flat patch)', () => {
    it('typed fields flat, null clears, the diff comes back; a field of another type is a 400', async () => {
      const ref = await create(validReference({ properties: { source: 'https://a.example', source_name: 'A' } }))
      const r = await post('/update', { id: ref.body.id, patch: { source: 'https://b.example', source_name: null, checked_at: '2026-10-19' } })
      expect(r.status).toBe(200)
      expect(r.body.properties).toMatchObject({ source: 'https://b.example', checked_at: '2026-10-19' })
      expect(r.body.properties.source_name).toBeUndefined()
      expect(r.body.diff.source).toEqual(['https://a.example', 'https://b.example'])
      const wrong = await post('/update', { id: ref.body.id, patch: { rationale: 'x' } })
      expect(wrong.status).toBe(400)
      expect(wrong.body.error).toMatch(/unknown field rationale for a reference/)
      // an older client's nested properties object is rejected, on update and on create
      const legacy = await post('/update', { id: ref.body.id, patch: { properties: { source: 'x' } } })
      expect(legacy.status).toBe(400)
      expect(legacy.body.error).toMatch(/unknown field properties for a reference.*upgrade/)
      const legacyCreate = await post('/engram/reference', { ...flat(validReference()).body, properties: { source: 'x' } })
      expect(legacyCreate.status).toBe(400)
      expect(legacyCreate.body.error).toMatch(/upgrade/)
    })

    it('supersedes after the fact, across types; a type change and superseded status are 400s', async () => {
      const ref = await create(validReference({ content: 'a synthesis, really' }))
      const note = await create(validNote({ content: 'a synthesis, as a note' }))
      const r = await post('/update', { id: note.body.id, patch: { supersedes: [ref.body.id] } })
      expect(r.status).toBe(200)
      expect(r.body.superseded).toEqual([ref.body.id])
      expect((await get(`/engram/${ref.body.id}`)).body.status).toBe('superseded')

      const typeChange = await post('/update', { id: note.body.id, patch: { type: 'reference' } })
      expect(typeChange.status).toBe(400)
      expect(typeChange.body.error).toMatch(/type of an engram does not change/)
      const sup = await post('/update', { id: note.body.id, patch: { status: 'superseded' } })
      expect(sup.status).toBe(400)
    })

    it('unknown id → 404', async () => {
      expect((await post('/update', { id: 'nope', patch: { content: 'x' } })).status).toBe(404)
    })
  })

  describe('POST /engram/:id/confirm-review', () => {
    it('a decision needs text and gets a review entry; unknown id → 404', async () => {
      const d = await create(validDecision())
      const noText = await post(`/engram/${d.body.id}/confirm-review`, {})
      expect(noText.status).toBe(400)
      expect(noText.body.error).toMatch(/needs text/)
      const ok = await post(`/engram/${d.body.id}/confirm-review`, { text: 'still holds' }, MCP)
      expect(ok.status).toBe(200)
      const got = await get(`/engram/${d.body.id}`)
      expect(got.body.entries).toEqual([expect.objectContaining({ kind: 'review', text: 'still holds', session_id: 'sess-1', model: 'claude-test-1' })])
      expect((await post('/engram/nope/confirm-review', { text: 'x' })).status).toBe(404)
    })
  })

  describe('/object/:object', () => {
    it('project: create, read one and the list, update with diff, archive sets ended_at; 404s; unknown field', async () => {
      const c = await post('/object/project', { name: 'Rest Project', goal: 'test', metadata: { repo: 'x/y' } })
      expect(c.status).toBe(201)
      expect(c.body.object).toMatchObject({ id: 'rest-project', name: 'Rest Project', metadata: { repo: 'x/y' } })

      const one = await get('/object/project?id=rest-project')
      expect(one.status).toBe(200)
      expect(one.body.object).toMatchObject({ id: 'rest-project', engram_count: 0 })
      expect((await get('/object/project?id=ghost')).status).toBe(404)
      const list = await get('/object/project')
      expect(list.body.objects.map((p: { id: string }) => p.id)).toContain('rest-project')

      const u = await put('/object/project/rest-project', { status_tracks: 'released version', status: 'archived' })
      expect(u.status).toBe(200)
      expect(u.body.diff.status_tracks).toEqual([null, 'released version'])
      expect(u.body.object.ended_at).toBeTruthy()
      expect((await get('/object/project')).body.objects.map((p: { id: string }) => p.id)).not.toContain('rest-project')
      expect((await get('/object/project?status=archived')).body.objects.map((p: { id: string }) => p.id)).toContain('rest-project')

      expect((await put('/object/project/ghost', { goal: 'x' })).status).toBe(404)
      const bad = await post('/object/project', { name: 'Tagged', tags: ['a'] })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toMatch(/^Invalid object: unknown field tags for a project/)
      const meta = await post('/object/project', { name: 'Nested', metadata: { a: { b: 1 } } })
      expect(meta.status).toBe(400)
      expect(meta.body.error).toMatch(/flat map of text values/)
      expect((await post('/object/planet', { name: 'x' })).status).toBe(400)
    })

    it('entity: kind required, status and status_tracks; set_status in its scope asks for status_tracks until set', async () => {
      expect((await post('/object/entity', { name: 'Acme' })).status).toBe(400)
      const e = await post('/object/entity', { name: 'Acme', kind: 'org' })
      expect(e.status).toBe(201)
      expect(e.body.object).toMatchObject({ id: 'acme', status: 'active', status_tracks: null })
      const s1 = await create(validStatus({ scope: 'entity.acme', properties: { state: 'prospect' } }))
      expect(s1.body).toMatchObject({ previous_state: null, status_tracks: null, status_tracks_missing: true })
      await put('/object/entity/acme', { status_tracks: 'deal stage' })
      const s2 = await create(validStatus({ scope: 'entity.acme', properties: { state: 'signed' } }))
      expect(s2.body).toMatchObject({ previous_state: 'prospect', status_tracks: 'deal stage' })
      expect(s2.body.status_tracks_missing).toBeUndefined()
    })

    it('tag: an archived tag stays on its engrams but is not assigned anew', async () => {
      expect((await post('/object/tag', { name: 'Deploy' })).status).toBe(201)
      const tagged = await create(validNote({ tags: ['deploy'] }))
      expect(tagged.status).toBe(201)
      const a = await put('/object/tag/deploy', { status: 'archived' })
      expect(a.status).toBe(200)
      expect(a.body.object).toMatchObject({ status: 'archived', engram_count: 1 })
      const fresh = await create(validNote({ tags: ['deploy'] }))
      expect(fresh.status).toBe(400)
      expect(fresh.body.error).toMatch(/is archived/)
      const keep = await post('/update', { id: tagged.body.id, patch: { tags: ['deploy'] } })
      expect(keep.status).toBe(200)
    })
  })

  describe('removed routes (410)', () => {
    it('every old write route answers 410 with the upgrade hint', async () => {
      const routes: Array<[string, string]> = [
        ['POST', '/store'], ['POST', '/context'], ['POST', '/task/x/entry'],
        ['POST', '/project'], ['PUT', '/project/x'], ['POST', '/tag'], ['POST', '/subject'], ['PUT', '/subject/x'],
        ['POST', '/entity'], ['PUT', '/entity/x'],
      ]
      for (const [method, path] of routes) {
        const r = await request(method, `${baseUrl}${path}`, auth(), JSON.stringify({}))
        expect(r.status, `${method} ${path}`).toBe(410)
        expect(r.body.error, `${method} ${path}`).toMatch(/removed in EML v0\.19.*upgrade/)
      }
    })

    it('the read routes the cockpit uses stay', async () => {
      for (const path of ['/projects', '/tags', '/subjects', '/entities']) expect((await get(path)).status, path).toBe(200)
    })
  })

  describe('GET /list filters', () => {
    it('binding and task_id', async () => {
      const task = await create(validTask({ title: 'filter-hub' }))
      const bound = await create(validDecision({ title: 'bound-one', task_id: task.body.id, properties: { binding: 'task' } }))
      const standing = await create(validNote({ title: 'standing-one', task_id: task.body.id, properties: { binding: 'standing' } }))
      const ids = async (q: string) => (await get(`/list?${q}`)).body.engrams.map((e: { id: string }) => e.id).sort()
      expect(await ids(`task_id=${task.body.id}`)).toEqual([bound.body.id, standing.body.id].sort())
      expect(await ids(`task_id=${task.body.id}&binding=task`)).toEqual([bound.body.id])
      expect(await ids(`task_id=${task.body.id}&binding=standing`)).toEqual([standing.body.id])
      expect((await get('/list?significance=high')).status).toBe(200)
      expect((await get('/list?flavour=x')).status).toBe(400)
    })
  })
})
