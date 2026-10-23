import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initControlDatabase,
  provisionUser,
  revokeToken,
  type ProvisionResult,
} from '@engramprotocol/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOL_NAMES } from '../src/tools'
import { validDecideArgs, validTaskArgs } from './fixtures'

type Result = { content: Array<{ type: string, text?: string }>, isError?: boolean }

/** The JSON body after the banner (the banner is prepended with a blank line). */
function jsonOf(r: Result): any {
  const t = textOf(r)
  const i = t.indexOf('{')
  return JSON.parse(t.slice(i))
}

/**
 * E2E (v0.9-PROPOSAL §6.6 Acceptance):
 *
 * Spawns the EML server against a temp data dir and bootstraps a user.
 * Spawns eml-mcp-server with the token and connects an MCP SDK client via stdio.
 * Validates: initialize handshake, tools/list, tool calls against the live server,
 * error handling as isError:true.
 *
 * v0.19: the 22-tool surface (create per type, track_task, update, relate,
 * objects, reads), strict schemas, banners from the live server.
 */

async function httpPost(port: number, path: string, body: unknown, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        if (res.statusCode && res.statusCode < 400) resolve(JSON.parse(raw))
        else reject(new Error(`HTTP ${res.statusCode}: ${raw}`))
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function httpPostWith(port: number, path: string, body: unknown, token: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
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

function textOf(result: { content: Array<{ type: string, text?: string }> }): string {
  const block = result.content.find(c => c.type === 'text')
  return block?.text ?? ''
}

describe('eml-mcp-server E2E (built server + MCP client via stdio)', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let prov: ProvisionResult
  let mcpClient: Client
  let mcpTransport: StdioClientTransport
  const port = 31380 + Math.floor(Math.random() * 100)

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-mcp-e2e-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })

    const control = initControlDatabase(join(tmpDir, 'control.db'))
    prov = provisionUser({ email: 'mcp-e2e@example.com', agentId: 'mcp', userId: 'mcp', control, dataDir: tmpDir })
    control.close()

    serverProc = spawn('node', [join(__dirname, '..', '..', 'server', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(port)

    mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [join(__dirname, '..', 'dist', 'cli.js')],
      env: {
        ...process.env,
        EML_API_URL: `http://127.0.0.1:${port}`,
        EML_API_TOKEN: prov.tokenPlaintext,
      },
    })
    mcpClient = new Client({ name: 'e2e-test-client', version: '0.0.1' }, { capabilities: {} })
    await mcpClient.connect(mcpTransport)
  }, 15000)

  afterAll(async () => {
    try { await mcpClient?.close() } catch { /* best-effort */ }
    // Wait for the exit: Windows can't delete the brain files while the server holds them open.
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('handshake + tools/list', () => {
    it('exposes tools with the correct names', async () => {
      const result = await mcpClient.listTools()
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual([...TOOL_NAMES].sort())
    })

    it('every schema is strict (additionalProperties false) and lists no removed field', async () => {
      const result = await mcpClient.listTools()
      for (const t of result.tools) {
        expect((t.inputSchema as Record<string, unknown>).additionalProperties, t.name).toBe(false)
        const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>)
        // relate's source_id is the edge's start and an entity's kind is person/org/asset — not the removed fields
        const removed = ['significance', 'properties', 'source_type']
          .concat(t.name === 'eml_relate' ? [] : ['source_id'])
          .concat(t.name.endsWith('_object') ? [] : ['kind'])
        for (const key of removed) expect(props, `${t.name}.${key}`).not.toContain(key)
      }
    })

    it('all tools have title + description + inputSchema', async () => {
      const result = await mcpClient.listTools()
      for (const t of result.tools) {
        expect(t.title, `${t.name}.title`).toBeTruthy()
        expect(t.description, `${t.name}.description`).toBeTruthy()
        expect(t.inputSchema, `${t.name}.inputSchema`).toBeTruthy()
        expect(t.inputSchema.type).toBe('object')
      }
    })
  })

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> =>
    await mcpClient.callTool({ name, arguments: args }) as Result

  describe('happy paths', () => {
    it('strict schema: an unknown key (significance) is rejected before the server', async () => {
      const r = await call('eml_decide', validDecideArgs({ title: 'x-strict', significance: 'high' }))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/significance|Unrecognized|unrecognized/)
    })

    it('eml_create_object / eml_read_object / eml_update_object for project, entity, tag, subject', async () => {
      const project = await call('eml_create_object', { object: 'project', name: 'EML', id: 'eml', goal: 'memory layer' })
      expect(project.isError).toBeFalsy()
      expect(jsonOf(project).created).toBe(true)
      expect((await call('eml_create_object', { object: 'entity', id: 'bob', name: 'Bob', kind: 'person' })).isError).toBeFalsy()
      expect((await call('eml_create_object', { object: 'tag', name: 'deploy' })).isError).toBeFalsy()
      expect((await call('eml_create_object', { object: 'subject', name: 'v0-19-build' })).isError).toBeFalsy()

      const list = await call('eml_read_object', { object: 'project' })
      expect(textOf(list)).toContain('"id": "eml"')
      const one = await call('eml_read_object', { object: 'entity', id: 'bob' })
      expect(jsonOf(one).object.kind).toBe('person')

      const upd = await call('eml_update_object', { object: 'project', id: 'eml', goal: 'engram protocol', status_tracks: 'brain schema version' })
      expect(upd.isError).toBeFalsy()
      expect(jsonOf(upd).diff.goal).toEqual(['memory layer', 'engram protocol'])

      const bad = await call('eml_create_object', { object: 'tag', name: 'x', goal: 'nope' })
      expect(bad.isError).toBe(true)
      expect(textOf(bad)).toContain('Invalid object')
    })

    it('eml_decide writes a decision engram (typed)', async () => {
      const r = await call('eml_decide', validDecideArgs({
        content: 'Bob builds the MCP server wrapper as the reference',
        scope: 'entity.bob',
        title: 'mcp-wrapper',
      }))
      expect(r.isError).toBeFalsy()
      const e = jsonOf(r)
      expect(e.type).toBe('decision')
      expect(e.scope).toBe('entity.bob')
      expect(e.properties.alternatives).toEqual(['test alternative'])
      expect(e.ingestion_method).toBe('mcp')
      expect(e.harness).toBe('e2e-test-client')
      expect(typeof e.session_id).toBe('string')
    })

    it('eml_decide: rationale + ≥ 1 alternative required; core rejects blank ones', async () => {
      const { tools } = await mcpClient.listTools()
      const decide = tools.find(t => t.name === 'eml_decide')!
      expect(decide.inputSchema.required).toEqual(expect.arrayContaining(['rationale', 'alternatives', 'title']))
      expect((await call('eml_decide', validDecideArgs({ title: 'no-alts', alternatives: [] }))).isError).toBe(true)
      expect((await call('eml_decide', validDecideArgs({ title: 'no-rat', rationale: undefined }))).isError).toBe(true)
      const blank = await call('eml_decide', validDecideArgs({ title: 'blank-alt', alternatives: ['  '] }))
      expect(blank.isError).toBe(true)
      expect(textOf(blank)).toContain('Invalid engram')
    })

    it('eml_list with a type filter finds the decision', async () => {
      expect(textOf(await call('eml_list', { type: 'decision', limit: 10 }))).toContain('mcp-wrapper')
    })

    it('eml_set_status: transition banner, status_tracks shown, later the previous state', async () => {
      const first = await call('eml_set_status', { scope: 'project.eml', state: 'schema 18', content: 'first status' })
      expect(first.isError).toBeFalsy()
      expect(textOf(first)).toContain('status (first) → schema 18')
      expect(textOf(first)).toContain("this scope's status tracks: brain schema version")
      const second = await call('eml_set_status', { scope: 'project.eml', state: 'schema 19', content: 'migrated' })
      expect(textOf(second)).toContain('status schema 18 → schema 19')
      expect(jsonOf(second).superseded).toHaveLength(1)
    })

    it('eml_set_status on an entity without status_tracks asks for it', async () => {
      const r = await call('eml_set_status', { scope: 'entity.bob', state: 'onboarded', content: 'Bob is in' })
      expect(textOf(r)).toContain('entity.bob has no status_tracks yet')
      expect(textOf(r)).toContain('eml_update_object(object=entity, id=bob')
    })

    it('eml_create_task + eml_track_task: progress, stage, sub-task, close with keep, reopen', async () => {
      const parent = jsonOf(await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'build-v019', stage: 'planning', priority: 'high' })))
      expect(parent.status).toBe('planned')
      const child = jsonOf(await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'child', parent_id: parent.id })))
      const d = jsonOf(await call('eml_decide', validDecideArgs({ scope: 'project.eml', title: 'keep-me', task_id: parent.id, binding: 'task' })))
      const n = jsonOf(await call('eml_note', { scope: 'project.eml', title: 'plan', content: 'the plan', task_id: parent.id, binding: 'task' }))

      const progress = await call('eml_track_task', { task_id: parent.id, text: 'options settled', stage: 'ready' })
      expect(progress.isError).toBeFalsy()
      expect(jsonOf(progress).properties.stage).toBe('ready')

      const noText = await call('eml_track_task', { task_id: parent.id, stage: 'implementation' })
      expect(noText.isError).toBe(true)
      expect(textOf(noText)).toContain('needs text')

      // the open sub-task blocks resolving
      expect((await call('eml_track_task', { task_id: parent.id, status: 'resolved', outcome: 'done', text: 'x', keep: [] })).isError).toBe(true)
      expect((await call('eml_track_task', { task_id: child.id, status: 'resolved', outcome: 'done', text: 'child done' })).isError).toBeFalsy()

      const noKeep = await call('eml_track_task', { task_id: parent.id, status: 'resolved', outcome: 'released', text: 'shipped' })
      expect(noKeep.isError).toBe(true)
      expect(textOf(noKeep)).toContain('keep=')

      const close = await call('eml_track_task', { task_id: parent.id, status: 'resolved', outcome: 'released', text: 'shipped', keep: [d.id] })
      expect(close.isError).toBeFalsy()
      expect(textOf(close)).toContain('kept as standing:')
      expect(textOf(close)).toContain('closed with the task:')

      const reopen = await call('eml_track_task', { task_id: parent.id, status: 'active', text: 'one more fix' })
      expect(textOf(reopen)).toContain('reactivate the ones that hold again')
      expect(textOf(reopen)).toContain(n.id)

      const got = jsonOf(await call('eml_get', { id: parent.id }))
      expect(got.entries.some((e: any) => e.kind === 'change')).toBe(true)
      const notesOnly = jsonOf(await call('eml_get', { id: parent.id, notes_only: true }))
      expect(notesOnly.entries.every((e: any) => e.kind === 'note')).toBe(true)

      const listed = await call('eml_list', { task_id: parent.id })
      expect(textOf(listed)).toContain(d.id)

      const ghost = await call('eml_track_task', { task_id: 'no-such-task', text: 'x' })
      expect(ghost.isError).toBe(true)
    })

    it('eml_create_task + eml_track_task carry the intent (set on create, changed and cleared on track)', async () => {
      const t = jsonOf(await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'why-task', intent: 'users see X' })))
      expect(t.properties.intent).toBe('users see X')
      const changed = await call('eml_track_task', { task_id: t.id, intent: 'users see X sooner' })
      expect(changed.isError).toBeFalsy()
      expect(jsonOf(changed).properties.intent).toBe('users see X sooner')
      expect(jsonOf(await call('eml_track_task', { task_id: t.id, intent: null })).properties.intent).toBeUndefined()
    })

    it('eml_create_task supersedes: open sub-tasks banner points to eml_track_task parent_id', async () => {
      const old = jsonOf(await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'old-parent' })))
      await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'old-child', parent_id: old.id }))
      const r = await call('eml_create_task', validTaskArgs({ scope: 'project.eml', title: 'new-parent', supersedes: [old.id] }))
      expect(textOf(r)).toContain('open sub-task')
      expect(textOf(r)).toContain('eml_track_task(<sub-task id>, parent_id=<new task id>)')
    })

    it('eml_note with a [[wikilink]] and a subject; eml_relate draws an edge', async () => {
      const target = jsonOf(await call('eml_note', { scope: 'global', title: 'wl-target', content: 'target note' }))
      const src = jsonOf(await call('eml_note', { scope: 'global', title: 'wl-source', content: 'see [[wl-target]]', subjects: ['v0-19-build'], tags: ['deploy'] }))
      expect(src.subjects).toEqual(['v0-19-build'])
      const rel = await call('eml_relate', { source_id: src.id, target_id: target.id, relation: 'supports', explanation: 'test' })
      expect(rel.isError).toBeFalsy()
      expect(textOf(await call('eml_list', { subject: 'v0-19-build' }))).toContain('wl-source')
    })

    it('eml_relate offers no supersedes / part_of', async () => {
      const { tools } = await mcpClient.listTools()
      const relate = tools.find(t => t.name === 'eml_relate')!
      const verbs = ((relate.inputSchema.properties as any).relation.enum) as string[]
      expect(verbs).not.toContain('supersedes')
      expect(verbs).not.toContain('part_of')
      expect(verbs).toEqual(expect.arrayContaining(['supports', 'contradicts', 'derived_from', 'refines', 'related_to', 'blocks']))
    })

    it('eml_rule, eml_event, eml_reference, eml_profile, eml_log create their types', async () => {
      const rule = await call('eml_rule', { scope: 'agent.mcp', title: 'ask-first', content: 'Ask before pushing.', applies: 'situational', trigger: 'before a push', why: 'user wants it', agreed: 'ja' })
      expect(rule.isError).toBeFalsy()
      expect(jsonOf(rule).type).toBe('rule')
      const noAgreed = await call('eml_rule', { scope: 'agent.mcp', title: 'x', content: 'x', applies: 'always', why: 'w' })
      expect(noAgreed.isError).toBe(true)

      const ev = await call('eml_event', { scope: 'global', title: 'release-1', content: 'released', change_type: 'released', occurred_at: '2026-10-19T10:00:00Z' })
      expect(jsonOf(ev).type).toBe('event')
      const ref = await call('eml_reference', { scope: 'global', title: 'docs', content: 'the docs', source: 'https://example.org' })
      expect(jsonOf(ref).properties.source).toBe('https://example.org')
      const prof = await call('eml_profile', { scope: 'agent.mcp', title: 'mcp-travel', content: 'likes trains' })
      expect(jsonOf(prof).type).toBe('profile')
      const badProf = await call('eml_profile', { scope: 'global', title: 'g', content: 'x' })
      expect(badProf.isError).toBe(true)

      const log = await call('eml_log', { scope: 'global', title: 'session-e2e', what: 'w', landed: 'l', next: 'n' })
      expect(jsonOf(log).content).toContain('**NEXT:** n')
      const second = await call('eml_log', { scope: 'global', title: 'session-e2e-2', what: 'w', landed: 'l', next: 'n' })
      expect(second.isError).toBe(true)
      expect(textOf(second)).toContain('this session already has a log')
    })

    it('eml_learning: create, topic match writes nothing, ripe after a second session', async () => {
      const first = await call('eml_learning', { scope: 'user.mcp', title: 'confirm-before-push', content: 'Confirm before pushing.', source: 'user', happened: 'pushed unasked', quote: 'frag erst' })
      expect(first.isError).toBeFalsy()
      const learning = jsonOf(first).engram
      const dup = await call('eml_learning', { scope: 'user.mcp', title: 'confirm-before-pushing', content: 'Confirm before pushing code.', source: 'self', happened: 'again' })
      expect(textOf(dup)).toContain('nothing written')
      expect(textOf(dup)).toContain(learning.id)
      // the same session counts once: still collecting
      const again = await call('eml_learning', { id: learning.id, source: 'observed', happened: 'frowned' })
      expect(jsonOf(again).learning.state).toBe('collecting')
      // evidence from another session (written over REST with another session header) makes it ripe
      const ripe = await httpPostWith(port, '/learning', { id: learning.id, source: 'self', happened: 'third time' }, prov.tokenPlaintext, { 'X-EML-Session': 'other-session' }) as any
      expect(ripe.learning.state).toBe('ripe')
      const list = await call('eml_list', { type: 'learning', state: 'ripe' })
      expect(textOf(list)).toContain(learning.id)
      const show = await call('eml_show', { scope: 'user.mcp' })
      expect(textOf(show)).not.toContain('confirm-before-push')
    })

    it('eml_update: a typed field, null clears, supersedes after the fact, tasks rejected', async () => {
      const ref = jsonOf(await call('eml_reference', { scope: 'global', title: 'old-ref', content: 'a synthesis', source: 'n/a', source_name: 'x' }))
      const upd = await call('eml_update', { id: ref.id, source_name: null, checked_at: '2026-10-19' })
      expect(upd.isError).toBeFalsy()
      const u = jsonOf(upd)
      expect(u.properties.source_name).toBeUndefined()
      expect(u.diff.checked_at).toEqual([null, '2026-10-19'])

      const note = jsonOf(await call('eml_note', { scope: 'global', title: 'old-ref-as-note', content: 'a synthesis' }))
      const sup = await call('eml_update', { id: note.id, supersedes: [ref.id] })
      expect(jsonOf(sup).superseded).toEqual([ref.id])
      expect(jsonOf(await call('eml_get', { id: ref.id })).status).toBe('superseded')

      const wrongField = await call('eml_update', { id: note.id, rationale: 'x' })
      expect(wrongField.isError).toBe(true)
      expect(textOf(wrongField)).toContain('unknown field rationale for a note')

      const task = jsonOf(await call('eml_create_task', validTaskArgs({ scope: 'global', title: 'not-via-update' })))
      const t = await call('eml_update', { id: task.id, content: 'x' })
      expect(t.isError).toBe(true)
      expect(textOf(t)).toContain('eml_track_task')
    })

    it('conflict banner points to eml_update(new, supersedes)', async () => {
      await call('eml_note', { scope: 'global', title: 'brand-one', content: 'Brand name is Engram Protocol with domain engramprotocol.io canonical naming' })
      const r = await call('eml_note', { scope: 'global', title: 'brand-two', content: 'Brand name is Engram Protocol with domain engramprotocol.io canonical naming choice' })
      expect(textOf(r)).toContain('eml_update(<new id>, supersedes=[<old id>])')
    })

    it('eml_show(scope) returns the brain state', async () => {
      const text = textOf(await call('eml_show', { scope: 'project.eml' }))
      expect(text).toContain('project.eml — brain state')
      expect(text).toContain('_tracks: brain schema version_')
      expect(text).toContain('## Open tasks')
    })

    it('eml_stats returns brain counts', async () => {
      const text = textOf(await call('eml_stats', {}))
      expect(text).toContain('"total_engrams"')
      expect(text).toContain('"by_type"')
    })

    it('eml_recall finds the decision via full-text search', async () => {
      expect(textOf(await call('eml_recall', { query: 'mcp wrapper', limit: 5 }))).toContain('mcp-wrapper')
    })

    it('eml_boot returns markdown', async () => {
      const text = textOf(await call('eml_boot', { agent: 'mcp' }))
      expect(text).toContain('"agent"')
      expect(text).toContain('"markdown"')
    })
  })

  describe('error handling — isError:true for backend errors', () => {
    it('eml_get with an unknown ID → isError:true with a clear message', async () => {
      const r = await call('eml_get', { id: 'no-such-id-12345' })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('EML API error')
      expect(textOf(r)).toMatch(/HTTP 404|HTTP 400/)
    })

    it('eml_update with an unknown ID → isError:true', async () => {
      const r = await call('eml_update', { id: 'no-such-id-12345', content: 'irrelevant' })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('EML API error')
    })

    it('a removed REST route answers 410 with the upgrade hint (old clients)', async () => {
      await expect(httpPost(port, '/context', { type: 'note', content: 'x', scope: 'global' }, prov.tokenPlaintext))
        .rejects.toThrow(/410.*upgrade @engramprotocol\/mcp-server/)
    })
  })

  describe('revoked token', () => {
    it('after revoke: every tool call → isError:true (HTTP 401)', async () => {
      const control = initControlDatabase(join(tmpDir, 'control.db'))
      revokeToken(control, prov.tokenId)
      control.close()
      const r = await call('eml_boot', {})
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('HTTP 401')
    })
  })
})
