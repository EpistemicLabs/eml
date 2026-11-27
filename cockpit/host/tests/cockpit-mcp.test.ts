import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { MessageRequest } from '../src/application/deliver-message.js'
import type { BrainSpace } from '../src/brain-space.js'
import type { DirectoryEntry } from '../src/domain/session-directory.js'
import type { EndTurn, TurnContext } from '../src/domain/turn-end.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-mcp-test-'))
process.env.EML_COCKPIT_HOME = home

// The cockpit's own session tools over MCP (cockpit-mcp.ts): who may call (as on
// the brain endpoint, and only a session whose provider gets the tools here), that a
// session acts as itself, and that an end_turn call is kept by the chat; a session in
// the terminal fallback has no turn routing.

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const ZONE = 'Asia/Bangkok (UTC+7)'
const NOW = Date.parse('2026-11-25T08:00:00Z')
const CTX: TurnContext = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }

const space = (id: string, agent: string | null, ledgerKey: string | null, mcpToken: string) => ({ id, name: id, agent, ledgerKey, mcpToken }) as unknown as BrainSpace
// The other space binds no agent: the cockpit's tools need no brain.
const SPACES = [space('brain-main', 'atlas', null, TOKEN_A), space('brain-other', null, 'brain-other', TOKEN_B)]

const entry = (address: string, name: string): DirectoryEntry =>
  ({ address, name, outcome: null, asked: null, project: 'EML', state: 'stopped', lastActive: '2026-11-25T07:00:00.000Z', parent: null, main: false })

let host: http.Server
let url: string
/** The endpoint as index.ts builds it: who is served is each session's provider's to say, and a chat session's call goes to the chat. */
let ruledHost: http.Server
let ruledUrl: string
let closeRuled: (sessionId?: string) => Promise<void>
const saidInChat: Array<[string, EndTurn]> = []
let closeHandler: (sessionId?: string) => Promise<void>
let ledger: import('../src/session-ledger.js').SessionLedger
let SESSION_TOOLS: typeof import('../src/domain/session-tools.js')['SESSION_TOOLS']
let CHAT_HAS_ITS_OWN: string
let notServed: typeof import('../src/cockpit-mcp.js')['notServed']

const scheduled: Array<[string, Record<string, unknown>]> = []
const delivered: MessageRequest[] = []
const listed: string[] = []
const checks: Array<[string, string | null]> = []
/** The session's task has a next run from its schedule (application/turn-wake.ts settle). */
let taskHasNextRun = false
/** The sessions a message sent back would reach, as their providers say (index.ts receives). */
const receivable = new Set(['chat-codex'])

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  const { createCockpitMcpHandler, COCKPIT_MCP_PATH, CHAT_HAS_ITS_OWN: chatReason, notServed: notServedRule } = await import('../src/cockpit-mcp.js')
  notServed = notServedRule
  const { SessionLedger } = await import('../src/session-ledger.js')
  SESSION_TOOLS = (await import('../src/domain/session-tools.js')).SESSION_TOOLS
  CHAT_HAS_ITS_OWN = chatReason

  ledger = new SessionLedger()
  ledger.recordSpawn('term-1', null, 'bp-eml', 'codex')
  ledger.recordSpawn('term-2', null, 'bp-eml', 'codex')
  ledger.recordSpawn('term-other', null, 'bp-life', 'codex', false, null, 'brain-other')
  // Sessions in the terminal fallback (a new one runs in the chat).
  for (const id of ['term-1', 'term-2', 'term-other']) ledger.setRuntime(id, 'terminal')
  ledger.recordSpawn('chat-1', null, 'bp-eml', 'claude')
  ledger.setRuntime('chat-1', 'sdk')

  const handler = createCockpitMcpHandler({
    spaces: { byMcpToken: (token: string | undefined) => SPACES.find((s) => s.mcpToken === token) ?? null },
    ledger,
    turnOf: async () => ({ ctx: CTX, task: null }),
    callTime: () => ({ now: NOW, zone: 'UTC' }),
    turnWake: async (sessionId, { edit }) => { checks.push([sessionId, edit.kind === 'set' ? edit.when : null]); return { problem: null, saved: null, nextRun: taskHasNextRun } },
    jobs: async (sessionId, input) => { scheduled.push([sessionId, input]); return `Jobs of ${sessionId}: none.` },
    directory: (sessionId) => { listed.push(sessionId); return [entry('eml-aaaa', 'Catalogue import'), entry('eml-bbbb', 'Release notes')] },
    addressOf: (sessionId) => `eml-${sessionId}`,
    deliver: async (request) => { delivered.push(request); return 'resumed' },
    timeZone: () => ZONE,
  })
  closeHandler = handler.close
  host = http.createServer((req, res) => { void handler.handle(req, res) })
  url = `http://127.0.0.1:${await listen(host)}${COCKPIT_MCP_PATH}`

  // Codex gets the tools here, in a terminal and in the chat; Claude Code has them built into its chat.
  ledger.recordSpawn('chat-codex', null, 'bp-eml', 'codex')
  ledger.setRuntime('chat-codex', 'sdk')
  const capabilities = {
    codex: { terminalTools: { supported: true } },
    claude: { terminalTools: { supported: false, reason: 'Claude Code sessions have the tools built in.' } },
  } as Record<string, never>
  const ruled = createCockpitMcpHandler({
    spaces: { byMcpToken: (token: string | undefined) => SPACES.find((s) => s.mcpToken === token) ?? null },
    ledger,
    chatTurns: { said: (sessionId, turn) => { saidInChat.push([sessionId, turn.call]) } },
    served: (sessionId) => notServedRule(ledger.get(sessionId), { capabilities: capabilities[ledger.get(sessionId)?.provider ?? 'claude'] }),
    turnOf: async () => ({ ctx: CTX, task: null }),
    callTime: () => ({ now: NOW, zone: 'UTC' }),
    directory: () => [entry('eml-aaaa', 'Catalogue import')],
    addressOf: (sessionId) => `eml-${sessionId}`,
    deliver: async (request) => { delivered.push(request); return 'delivered' },
    // As index.ts: whether the session's provider lets a message reach it where it runs (sessionMessaging).
    receives: (sessionId) => receivable.has(sessionId),
    timeZone: () => ZONE,
  })
  closeRuled = ruled.close
  ruledHost = http.createServer((req, res) => { void ruled.handle(req, res) })
  ruledUrl = `http://127.0.0.1:${await listen(ruledHost)}${COCKPIT_MCP_PATH}`
})

afterAll(async () => {
  await closeHandler()
  await closeRuled()
  await new Promise((r) => host.close(r))
  await new Promise((r) => ruledHost.close(r))
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  for (const list of [scheduled, delivered, listed, checks, saidInChat]) list.length = 0
  taskHasNextRun = false
})

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } } }

const post = (headers: Record<string, string>, body: unknown = initialize, to = url) => fetch(to, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
})

const as = (sessionId: string, token = TOKEN_A) => ({ 'x-cockpit-mcp-token': token, 'x-eml-session': sessionId })

async function connect(sessionId: string, token = TOKEN_A, to = url) {
  const transport = new StreamableHTTPClientTransport(new URL(to), { requestInit: { headers: as(sessionId, token) } })
  const client = new Client({ name: 'codex', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

type Answer = { content: Array<{ type: string; text: string }>; isError?: boolean }
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await client.callTool({ name, arguments: args }) as Answer
  return { text: answer.content.map((c) => c.text).join(''), isError: answer.isError === true }
}

describe('cockpit MCP endpoint access', () => {
  it('opens an MCP session for a terminal session with its space\'s token, with or without a bound agent', async () => {
    for (const [sessionId, token] of [['term-1', TOKEN_A], ['term-other', TOKEN_B]]) {
      const res = await post(as(sessionId, token))
      expect(res.status).toBe(200)
      expect(res.headers.get('mcp-session-id')).toBeTruthy()
      await res.text()
    }
  })

  it('refuses a request that is not local, even with a valid token and session', async () => {
    const proxied = await post({ ...as('term-1'), 'x-forwarded-for': '100.64.0.2' })
    expect(proxied.status).toBe(403)
    expect((await proxied.json()).error.message).toBe('The cockpit MCP endpoint is local only')
    expect((await post({ ...as('term-1'), 'tailscale-user-login': 'someone@example.com' })).status).toBe(403)
  })

  // A local refusal is 409, never 401/403, as on the brain endpoint (brain-mcp.ts mcpStatus).
  it('refuses a missing or unknown token, an unknown session and a session of another space (409)', async () => {
    expect((await post({ 'x-eml-session': 'term-1' })).status).toBe(409)
    const bad = await post(as('term-1', 'd'.repeat(64)))
    expect([bad.status, (await bad.json()).error.message]).toEqual([409, 'Bad MCP token'])
    expect((await post({ 'x-cockpit-mcp-token': TOKEN_A })).status).toBe(409)
    const unknown = await post(as('term-unknown'))
    expect([unknown.status, (await unknown.json()).error.message]).toEqual([409, 'Unknown session'])
    const other = await post(as('term-other'))
    expect([other.status, (await other.json()).error.message]).toEqual([409, 'The session belongs to another space'])
    expect((await post(as('term-1', TOKEN_B))).status).toBe(409)
  })

  it('refuses a session that runs in chat, and says where its tools are', async () => {
    const res = await post(as('chat-1'))
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toBe(CHAT_HAS_ITS_OWN)
    expect(CHAT_HAS_ITS_OWN).toBe('The cockpit MCP endpoint serves sessions that run in a terminal. This session runs in chat and has the cockpit\'s tools built in: call those instead.')
  })

  it('serves a session when its provider\'s sessions get the tools here, in a terminal and in the chat, and refuses another', () => {
    const provider = (terminalTools: { supported: true } | { supported: false; reason: string }) => ({ capabilities: { terminalTools } as never })
    const served = provider({ supported: true })
    const builtIn = provider({ supported: false, reason: 'Its sessions end a turn in the text of their reply.' })
    expect(notServed({ runtime: 'terminal' }, served)).toBeNull()
    expect(notServed({ runtime: 'terminal' }, builtIn)).toBe('Its sessions end a turn in the text of their reply.')
    // A chat session of such a provider has no other way to the tools (Codex); another's has them built in (Claude Code).
    expect(notServed({ runtime: 'sdk' }, served)).toBeNull()
    expect(notServed({ runtime: 'sdk' }, builtIn)).toBe(CHAT_HAS_ITS_OWN)
    expect(notServed(undefined, served)).toBe(CHAT_HAS_ITS_OWN)
  })

  it('refuses a session that moved to chat on the MCP session it opened in the terminal', async () => {
    ledger.recordSpawn('term-moving', null, 'bp-eml', 'claude')
    const init = await post(as('term-moving'))
    const mcpSession = init.headers.get('mcp-session-id') as string
    await init.text()
    ledger.setRuntime('term-moving', 'sdk')
    const res = await post({ ...as('term-moving'), 'mcp-session-id': mcpSession }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(res.status).toBe(409)
  })
})

describe('the tools a terminal session gets', () => {
  it('lists exactly the four session tools, as the shared definitions describe them, under the server name cockpit', async () => {
    const { client } = await connect('term-1')
    expect(client.getServerVersion()?.name).toBe('cockpit')
    const { tools } = await client.listTools()
    const T = SESSION_TOOLS
    expect(tools.map((t) => [t.name, t.description])).toEqual([
      [T.endTurn.name, T.endTurn.description(ZONE)],
      [T.schedule.name, T.schedule.description(ZONE)],
      [T.sendMessage.name, T.sendMessage.description()],
      [T.listSessions.name, T.listSessions.description()],
    ])
    expect(tools.map((t) => t.name)).toEqual(['end_turn', 'schedule', 'send_message', 'list_sessions'])
    expect(Object.keys(tools[2].inputSchema.properties ?? {})).toEqual(['to', 'text'])
    await client.close()
  })

  it('lets a session act only as itself: its jobs, its directory, its address, its own turn', async () => {
    const one = await connect('term-1')
    const two = await connect('term-2')
    await Promise.all([
      call(one.client, 'schedule', { action: 'list' }),
      call(two.client, 'schedule', { action: 'list' }),
    ])
    expect(scheduled.map(([sessionId]) => sessionId).sort()).toEqual(['term-1', 'term-2'])
    expect((await call(two.client, 'schedule', { action: 'list' })).text).toBe('Jobs of term-2: none.')

    await call(one.client, 'list_sessions', {})
    await call(two.client, 'send_message', { to: 'eml-aaaa', text: 'hello' })
    expect(listed).toEqual(['term-1', 'term-2'])
    expect(delivered.map((r) => r.from)).toEqual(['eml-term-2'])

    await call(two.client, 'end_turn', { result: 'Two is done', check: { when: '2026-11-25T10:00', why: 'Check it' } })
    expect(checks).toEqual([['term-2', '2026-11-25T10:00']])

    // Another session with the first one's MCP session id: the session is bound to its caller.
    const stolen = await post({ ...as('term-2'), 'mcp-session-id': one.transport.sessionId! }, { jsonrpc: '2.0', id: 9, method: 'tools/list' })
    expect(stolen.status).toBe(403)
    await one.client.close()
    await two.client.close()
  })

  it('closes the MCP sessions of a session that is gone', async () => {
    const { client, transport } = await connect('term-2')
    await closeHandler('term-2')
    const res = await post({ ...as('term-2'), 'mcp-session-id': transport.sessionId! }, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(res.status).toBe(404)
    await client.close().catch(() => undefined)
  })
})

describe('a chat session whose agent CLI gets the tools here', () => {
  it('is served, and a chat session with the tools built in is not', async () => {
    const served = await post(as('chat-codex'), initialize, ruledUrl)
    expect(served.status).toBe(200)
    await served.text()
    const builtIn = await post(as('chat-1'), initialize, ruledUrl)
    expect([builtIn.status, (await builtIn.json()).error.message]).toEqual([409, CHAT_HAS_ITS_OWN])
  })

  it('gets the two tools the chat renders as cards on top; a terminal session keeps the four', async () => {
    const chat = await connect('chat-codex', TOKEN_A, ruledUrl)
    const T = SESSION_TOOLS
    const { tools } = await chat.client.listTools()
    // No schedule here: this endpoint was built without the jobs.
    expect(tools.map((t) => t.name)).toEqual(['end_turn', 'send_message', 'list_sessions', 'offer_split', 'propose_sort'])
    expect(tools.slice(-2).map((t) => t.description)).toEqual([T.offerSplit.description(), T.proposeSort.description()])
    expect(await call(chat.client, 'propose_sort', { reason: 'Three topics', rows: [{ topic: 'Notes', pick: 'keep' }] })).toEqual({ text: T.proposeSort.answer, isError: false })
    const terminal = await connect('term-1', TOKEN_A, ruledUrl)
    expect((await terminal.client.listTools()).tools.map((t) => t.name)).toEqual(['end_turn', 'send_message', 'list_sessions'])
    await chat.client.close()
    await terminal.client.close()
  })

  it('has its end_turn call kept by the chat; a session in the terminal fallback has none kept', async () => {
    const { client } = await connect('chat-codex', TOKEN_A, ruledUrl)
    const answer = await call(client, 'end_turn', { result: 'Draft ready', questions: ['Send it today?'] })
    expect(answer.isError).toBe(false)
    expect(saidInChat).toEqual([['chat-codex', { result: 'Draft ready', questions: ['Send it today?'] }]])
    // A session in a terminal on the same endpoint: no turn routing, so nothing is kept for it.
    const terminal = await connect('term-1', TOKEN_A, ruledUrl)
    await call(terminal.client, 'end_turn', { result: 'One is done' })
    expect(saidInChat).toHaveLength(1)
    expect(ledger.get('term-1')!.unrouted).toBeUndefined()
    await client.close()
    await terminal.client.close()
  })

  it('can be answered: its message does not tell the receiver otherwise', async () => {
    const { client } = await connect('chat-codex', TOKEN_A, ruledUrl)
    await call(client, 'send_message', { to: 'eml-aaaa', text: 'The notes are ready.' })
    expect(delivered).toEqual([{ target: 'eml-aaaa', text: 'The notes are ready.', from: 'eml-chat-codex', caller: 'session' }])
    await client.close()
  })

  it('cannot be answered once its provider no longer lets a message reach it (Codex with its chat view off)', async () => {
    receivable.delete('chat-codex')
    try {
      const { client } = await connect('chat-codex', TOKEN_A, ruledUrl)
      await call(client, 'send_message', { to: 'eml-aaaa', text: 'The notes are ready.' })
      expect(delivered).toEqual([{ target: 'eml-aaaa', text: 'The notes are ready.', from: 'eml-chat-codex', caller: 'session', noReply: true }])
      await client.close()
    } finally {
      receivable.add('chat-codex')
    }
  })
})

describe('end_turn from a session in the terminal fallback', () => {
  it('is answered, and sets the wake-up its check.when asks for, but nothing is routed: no turn routing there', async () => {
    const { client } = await connect('term-1')
    const answer = await call(client, 'end_turn', { result: 'Waiting for the build', check: { when: '2026-11-25T10:00', why: 'Check the build' } })
    expect(answer.isError).toBe(false)
    expect(answer.text).toMatch(/^Recorded/)
    expect(checks).toEqual([['term-1', '2026-11-25T10:00']])
    expect(ledger.get('term-1')!.attention).toBeNull()
    expect(ledger.get('term-1')!.unrouted).toBeUndefined()
    await client.close()
  })

  it('refuses a call that cannot be read, or whose check time has passed', async () => {
    const { client } = await connect('term-1')
    const empty = await call(client, 'end_turn', { result: '   ' })
    expect([empty.isError, empty.text]).toEqual([true, expect.stringMatching(/^Not recorded: result is missing/)])
    const noWho = await call(client, 'end_turn', { result: 'Done', ask: { what: 'Review it' } })
    expect([noWho.isError, noWho.text]).toEqual([true, expect.stringMatching(/^Not recorded: ask\.who is missing/)])
    const passed = await call(client, 'end_turn', { result: 'Waiting', check: { when: '2026-11-24T10:00', why: 'Check' } })
    expect([passed.isError, passed.text]).toEqual([true, expect.stringMatching(/^Not recorded: check\.when "2026-11-24T10:00" has passed/)])
    expect(checks).toEqual([])
    await client.close()
  })

  it('a task with a next run needs no time', async () => {
    taskHasNextRun = true
    const { client } = await connect('term-1')
    const answer = await call(client, 'end_turn', { result: 'Asked Acme', ask: { who: 'outside:acme', what: 'Answer the offer' } })
    expect(answer.isError).toBeFalsy()
    expect(answer.text).not.toMatch(/check\.when/)
    await client.close()
  })
})

describe('send_message and list_sessions from a terminal session', () => {
  it('hands a message on as the caller, and tells the receiver that a reply does not reach it', async () => {
    const { client } = await connect('term-1')
    const answer = await call(client, 'send_message', { to: 'eml-bbbb', text: 'The notes are ready.' })
    expect(answer).toEqual({ text: expect.stringMatching(/^Delivered: eml-bbbb had stopped/), isError: false })
    expect(delivered).toEqual([{ target: 'eml-bbbb', text: 'The notes are ready.', from: 'eml-term-1', caller: 'session', noReply: true }])
    await client.close()
  })

  it('refuses an address outside the caller\'s directory, and asks nothing of the host for it', async () => {
    const { client } = await connect('term-1')
    const answer = await call(client, 'send_message', { to: 'life-cccc', text: 'hello' })
    expect(answer).toEqual({ text: 'Not sent: life-cccc is not a session you can message. list_sessions shows the addresses you can send to; take the address from there.', isError: true })
    expect(delivered).toEqual([])
    await client.close()
  })

  it('lists the sessions in words that name the tools, not the search command or ListAgents', async () => {
    const { client } = await connect('term-1')
    const found = await call(client, 'list_sessions', { words: 'catalogue' })
    expect(found.text).toMatch(/^One session fits:\n\neml-aaaa · stopped/)
    const none = await call(client, 'list_sessions', { words: 'zebra' })
    expect(none.text).toBe('No session matches "zebra". Retry with other words from what your user called it: list_sessions with other words. Archived sessions: list_sessions with archived true. The most recent sessions: list_sessions without words.')
    for (const text of [found.text, none.text]) expect(text).not.toMatch(/COCKPIT_SESSIONS_JS|ListAgents|SendMessage/)
    await client.close()
  })
})
