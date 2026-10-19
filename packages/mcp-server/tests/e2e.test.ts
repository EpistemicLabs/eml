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

/**
 * E2E (v0.9-PROPOSAL §6.6 Acceptance):
 *
 * Spawns the EML server against a temp data dir and bootstraps a user.
 * Spawns eml-mcp-server with the token and connects an MCP SDK client via stdio.
 * Validates: initialize handshake, tools/list, tool calls against the live server,
 * error handling as isError:true.
 *
 * v0.9 Cluster 4 Phase 4.3 steps 1+2: 7 tools after cleanup
 * (boot, recall, list, get, update, entity_create, entity_update).
 * Steps 3+4 add 10 more tools.
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

  describe('happy paths', () => {
    it('eml_entity_create creates an entity', async () => {
      const create = await mcpClient.callTool({
        name: 'eml_entity_create',
        arguments: { id: 'bob', name: 'Bob', kind: 'person' },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(create.isError).toBeFalsy()
    })

    it('eml_decide writes a decision engram (typed)', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_decide',
        arguments: validDecideArgs({
          content: 'Bob builds the MCP server wrapper as the reference',
          scope: 'entity.bob',
          title: 'mcp-wrapper',
        }),
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBeFalsy()
      const text = textOf(r)
      expect(text).toContain('"type": "decision"')
      expect(text).toContain('"scope": "entity.bob"')
      expect(text).toContain('"alternatives"')
      expect(text).not.toContain('decision_type')
    })

    it('eml_decide (v0.15): no decision_type param; rationale + ≥ 1 alternative required', async () => {
      const { tools } = await mcpClient.listTools()
      const decide = tools.find(t => t.name === 'eml_decide')!
      const props = decide.inputSchema.properties as Record<string, unknown>
      expect(props.decision_type).toBeUndefined()
      expect(decide.inputSchema.required).toEqual(expect.arrayContaining(['rationale', 'alternatives']))

      const noAlts = await mcpClient.callTool({
        name: 'eml_decide',
        arguments: validDecideArgs({ scope: 'entity.bob', alternatives: [] }),
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(noAlts.isError).toBe(true)
      expect(textOf(noAlts)).toContain('Invalid engram: a decision needs at least one alternative that was considered and rejected.')

      const noRationale = await mcpClient.callTool({
        name: 'eml_decide',
        arguments: validDecideArgs({ scope: 'entity.bob', rationale: undefined }),
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(noRationale.isError).toBe(true)
      expect(textOf(noRationale)).toContain('Invalid engram: a decision needs a rationale — why this option won.')

      const blankAlt = await mcpClient.callTool({
        name: 'eml_decide',
        arguments: validDecideArgs({ scope: 'entity.bob', alternatives: ['  '] }),
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(blankAlt.isError).toBe(true)
      expect(textOf(blankAlt)).toContain('Invalid engram: a decision needs at least one alternative')
    })

    it('eml_list with a type filter finds the decision', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_list',
        arguments: { type: 'decision', limit: 10 },
      }) as { content: Array<{ type: string, text?: string }> }
      expect(textOf(r)).toContain('mcp-wrapper')
    })

    it('eml_relate draws a directed edge (idempotent); eml_note [[wikilink]] auto-links', async () => {
      // a typed write may prepend an advisory banner before the JSON → parse from the first '{'.
      const parseWrite = (t: string) => JSON.parse(t.slice(t.indexOf('{')))
      const mk = async (title: string, content: string) => parseWrite(textOf(await mcpClient.callTool({
        name: 'eml_note', arguments: { content, scope: 'global', title },
      }) as { content: Array<{ text?: string }> }))
      const aId = (await mk('rel-a', 'relate source')).id as string
      const bId = (await mk('rel-b', 'relate target')).id as string

      const rel = await mcpClient.callTool({
        name: 'eml_relate', arguments: { source_id: aId, target_id: bId, relation: 'supports', explanation: 'a backs b' },
      }) as { content: Array<{ text?: string }>, isError?: boolean }
      expect(rel.isError).toBeFalsy()
      expect(textOf(rel)).toContain('"created": true')

      // wikilink from a NEW note to rel-a's title → related_to edge, seen via eml_get
      const wId = (await mk('rel-w', 'see [[rel-a]] for context')).id as string
      const got = await mcpClient.callTool({
        name: 'eml_get', arguments: { id: wId, with_relations: true },
      }) as { content: Array<{ text?: string }> }
      expect(textOf(got)).toContain('related_to')
      expect(textOf(got)).toContain(aId)
    })

    it('v0.15 tasks: eml_track_task stage/parent_id/outcome, eml_task_entry, entries on eml_get, eml_list stage=', async () => {
      type R = { content: Array<{ type: string, text?: string }>, isError?: boolean }
      const call = async (name: string, args: Record<string, unknown>) =>
        await mcpClient.callTool({ name, arguments: args }) as R
      const parseWrite = (t: string) => JSON.parse(t.slice(t.indexOf('{')))

      const parent = parseWrite(textOf(await call('eml_track_task',
        validTaskArgs({ content: 'Ship the task hub', title: 'mcp-hub-parent', status: 'active', stage: 'planning' }))))
      expect(parent.properties.stage).toBe('planning')
      const child = parseWrite(textOf(await call('eml_track_task',
        validTaskArgs({ content: 'Write the migration', title: 'mcp-hub-child', parent_id: parent.id }))))

      // resolving the parent while the child is open fails and names the child
      const blocked = await call('eml_update', { id: parent.id, patch: { status: 'resolved', properties: { outcome: 'done' } } })
      expect(blocked.isError).toBe(true)
      expect(textOf(blocked)).toContain(`has open sub-tasks: ${child.id} mcp-hub-child`)

      // a stage change rides on the entry
      const entry = await call('eml_task_entry', { task_id: parent.id, text: 'options settled, plan next', stage: 'ready' })
      expect(entry.isError).toBeFalsy()
      expect(textOf(entry)).toContain('"stage": "ready"')

      const got = textOf(await call('eml_get', { id: parent.id }))
      expect(got).toContain('options settled, plan next')
      expect(got).toContain('"stage": "ready"')

      const listed = textOf(await call('eml_list', { type: 'task', stage: 'ready' }))
      expect(listed).toContain('mcp-hub-parent')
      expect(listed).not.toContain('mcp-hub-child')

      // created closed → outcome comes from the helper; without it → error
      const closed = await call('eml_track_task', validTaskArgs({ content: 'Already done', status: 'resolved' }))
      expect(closed.isError).toBeFalsy()
      expect(textOf(closed)).toContain('"outcome": "test outcome"')
      const noOutcome = await call('eml_track_task', { content: 'Already done', scope: 'global', status: 'resolved' })
      expect(noOutcome.isError).toBe(true)
      expect(textOf(noOutcome)).toContain('Invalid engram: closing a task (resolved/invalidated) needs an outcome.')

      // eml_task_entry on an unknown id fails instead of creating anything
      const ghost = await call('eml_task_entry', { task_id: 'no-such-task', text: 'x' })
      expect(ghost.isError).toBe(true)
    })

    it('v0.15: eml_decide / eml_note with task_id link to the task and add entries', async () => {
      type R = { content: Array<{ type: string, text?: string }>, isError?: boolean }
      const parseWrite = (t: string) => JSON.parse(t.slice(t.indexOf('{')))
      const task = parseWrite(textOf(await mcpClient.callTool({ name: 'eml_track_task',
        arguments: validTaskArgs({ content: 'Pick the queue', title: 'mcp-link-hub', stage: 'planning' }) }) as R))

      const d = await mcpClient.callTool({ name: 'eml_decide',
        arguments: validDecideArgs({ content: 'Use SQLite as the queue', title: 'mcp-link-decision', task_id: task.id }) }) as R
      expect(d.isError).toBeFalsy()
      const plan = await mcpClient.callTool({ name: 'eml_note',
        arguments: { content: 'Plan: table, worker, retries.', scope: 'global', title: 'mcp-link-plan', task_id: task.id } }) as R
      expect(plan.isError).toBeFalsy()

      const got = textOf(await mcpClient.callTool({ name: 'eml_get', arguments: { id: task.id, with_relations: true } }) as R)
      expect(got).toContain('decision taken: mcp-link-decision')
      expect(got).toContain('note written: mcp-link-plan')
      expect(got).toContain('"derived_from"')
      expect(got).toContain('"refines"')
      expect(got).toContain('"stage": "planning"')   // not advanced

      const bad = await mcpClient.callTool({ name: 'eml_decide',
        arguments: validDecideArgs({ content: 'orphan', task_id: 'no-such-task' }) }) as R
      expect(bad.isError).toBe(true)
      expect(textOf(bad)).toContain('Invalid engram: task_id no-such-task is not a task.')
    })

    it('v0.15: eml_decide supersedes flips the old decision and draws the edge in one call', async () => {
      type R = { content: Array<{ type: string, text?: string }>, isError?: boolean }
      const parseWrite = (t: string) => JSON.parse(t.slice(t.indexOf('{')))
      const old = parseWrite(textOf(await mcpClient.callTool({ name: 'eml_decide',
        arguments: validDecideArgs({ content: 'Queue on Redis', title: 'mcp-queue' }) }) as R))
      const next = parseWrite(textOf(await mcpClient.callTool({ name: 'eml_decide',
        arguments: validDecideArgs({ content: 'Queue on SQLite', title: 'mcp-queue', supersedes: [old.id] }) }) as R))

      const got = textOf(await mcpClient.callTool({ name: 'eml_get', arguments: { id: old.id, with_relations: true } }) as R)
      expect(got).toContain('"status": "superseded"')
      expect(got).toContain('"relation": "supersedes"')
      expect(got).toContain(next.id)
    })

    it('v0.15: superseding a parent task prints the open sub-tasks banner', async () => {
      type R = { content: Array<{ type: string, text?: string }>, isError?: boolean }
      const parseWrite = (t: string) => JSON.parse(t.slice(t.indexOf('{')))
      const parent = parseWrite(textOf(await mcpClient.callTool({ name: 'eml_track_task',
        arguments: validTaskArgs({ content: 'Old plan', title: 'mcp-old-plan' }) }) as R))
      await mcpClient.callTool({ name: 'eml_track_task',
        arguments: validTaskArgs({ content: 'Leftover step', title: 'mcp-leftover', parent_id: parent.id }) })
      const r = await mcpClient.callTool({ name: 'eml_update', arguments: { id: parent.id, patch: { status: 'superseded' } } }) as R
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('open sub-task of the superseded task stays open')
      expect(textOf(r)).toContain('mcp-leftover')
    })

    it('eml_subject_create + assign via eml_note, then eml_list subject= filters to it', async () => {
      const created = await mcpClient.callTool({
        name: 'eml_subject_create',
        arguments: { name: 'MCP E2E Subject', description: 'a strand for the e2e run' },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(created.isError).toBeFalsy()
      expect(textOf(created)).toContain('"id": "mcp-e2e-subject"')

      const wrote = await mcpClient.callTool({
        name: 'eml_note',
        arguments: { content: 'engram in the e2e subject', scope: 'entity.bob', subjects: ['mcp-e2e-subject'] },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(wrote.isError).toBeFalsy()
      expect(textOf(wrote)).toContain('"mcp-e2e-subject"')

      const listed = await mcpClient.callTool({
        name: 'eml_list',
        arguments: { subject: 'mcp-e2e-subject', limit: 10 },
      }) as { content: Array<{ type: string, text?: string }> }
      expect(textOf(listed)).toContain('engram in the e2e subject')
    })

    it('eml_set_status writes a status with auto-supersede', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_set_status',
        arguments: {
          content: 'MCP wrapper phase 1 running',
          scope: 'entity.bob',
          state: 'in-progress',
          next_step: 'tool tests green',
        },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('"type": "status"')
      expect(textOf(r)).toContain('"state": "in-progress"')
    })

    it('eml_track_task writes a task with priority', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_track_task',
        arguments: validTaskArgs({
          content: 'Review the tool suite',
          scope: 'entity.bob',
          priority: 'high',
          due_date: '2026-06-01',
        }),
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('"type": "task"')
      expect(textOf(r)).toContain('"priority": "high"')
    })

    it('eml_note(kind=event) writes an event engram', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_note',
        arguments: {
          kind: 'event',
          content: 'MCP E2E green',
          scope: 'global',
          properties: { occurred_at: '2026-05-10T12:00:00Z', change_type: 'completed' },
        },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('"type": "event"')
    })

    it('eml_show(scope) returns the brain state', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_show',
        arguments: { scope: 'entity.bob' },
      }) as { content: Array<{ type: string, text?: string }> }
      const text = textOf(r)
      // v0.10.5: eml_show returns a compact markdown dashboard, not the full JSON state.
      expect(text).toContain('"scope": "entity.bob"')
      expect(text).toContain('entity.bob — brain state')
      expect(text).toContain('## Status')
      expect(text).toContain('## Open tasks')
    })

    it('eml_entities lists entities', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_entities',
        arguments: {},
      }) as { content: Array<{ type: string, text?: string }> }
      expect(textOf(r)).toContain('bob')
    })

    it('eml_project_create + eml_projects + eml_project_update', async () => {
      const create = await mcpClient.callTool({
        name: 'eml_project_create',
        arguments: { id: 'eml', name: 'EML', goal: 'memory layer' },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(create.isError).toBeFalsy()

      const list = await mcpClient.callTool({
        name: 'eml_projects',
        arguments: {},
      }) as { content: Array<{ type: string, text?: string }> }
      expect(textOf(list)).toContain('"id": "eml"')

      const update = await mcpClient.callTool({
        name: 'eml_project_update',
        arguments: { id: 'eml', goal: 'engram protocol' },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(update.isError).toBeFalsy()
      expect(textOf(update)).toContain('engram protocol')
    })

    it('eml_stats returns brain counts', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_stats',
        arguments: {},
      }) as { content: Array<{ type: string, text?: string }> }
      const text = textOf(r)
      expect(text).toContain('"total_engrams"')
      expect(text).toContain('"by_type"')
      expect(text).toContain('"by_scope"')
    })

    it('eml_recall finds the decision via full-text search', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_recall',
        arguments: { query: 'mcp wrapper', limit: 5 },
      }) as { content: Array<{ type: string, text?: string }> }
      expect(textOf(r)).toContain('mcp-wrapper')
    })

    it('eml_boot returns markdown', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_boot',
        arguments: { agent: 'default' },
      }) as { content: Array<{ type: string, text?: string }> }
      const text = textOf(r)
      expect(text).toContain('"agent"')
      expect(text).toContain('"markdown"')
    })
  })

  describe('error handling — isError:true for backend errors', () => {
    it('eml_get with an unknown ID → isError:true with a clear message', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_get',
        arguments: { id: 'no-such-id-12345' },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('EML API error')
      expect(textOf(r)).toMatch(/HTTP 404|HTTP 400/)
    })

    it('eml_update with an unknown ID → isError:true', async () => {
      const r = await mcpClient.callTool({
        name: 'eml_update',
        arguments: {
          id: 'no-such-id-12345',
          patch: { content: 'irrelevant' },
        },
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('EML API error')
    })
  })

  describe('revoked token', () => {
    it('after revoke: every tool call → isError:true (HTTP 401)', async () => {
      // Revoke the token outside the MCP channel
      const control = initControlDatabase(join(tmpDir, 'control.db'))
      revokeToken(control, prov.tokenId)
      control.close()

      const r = await mcpClient.callTool({
        name: 'eml_boot',
        arguments: {},
      }) as { content: Array<{ type: string, text?: string }>, isError?: boolean }
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('HTTP 401')
    })
  })
})
