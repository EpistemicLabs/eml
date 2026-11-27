import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentProvider, Capability } from '../src/domain/agent-provider.js'
import type { ModelOption } from '../src/domain/session-runtime.js'
import { chatModels } from '../src/application/chat-models.js'
import { ReportedModels } from '../src/reported-models.js'
import type { AppServerProcess } from '../src/infrastructure/providers/codex/app-server-client.js'
import { CodexModels, listCodexModels } from '../src/infrastructure/providers/codex/models.js'

/**
 * The models the launchers' agent picker offers for a new chat (GET /api/providers/models): which
 * providers are listed, where their models come from, and Codex's own list from an app-server of
 * its own, kept a while. Providers and the app-server are fakes; model names are made up.
 */

const model = (id: string, label = id.toUpperCase()): ModelOption => ({ id, label, description: '', resolved: null })

const CHAT: Capability = { supported: true }
const NO_CHAT: Capability = { supported: false, reason: 'Terminal only.' }

/** A provider as chatModels reads it: its chat capability, whether it is set up, and maybe a list of its own. */
function provider(id: string, opts: { chat?: Capability; version?: string | null; list?: () => Promise<ModelOption[]> } = {}): AgentProvider {
  return {
    id,
    capabilities: { chat: opts.chat ?? CHAT },
    runtime: { version: () => (opts.version === undefined ? '1.0.0' : opts.version) },
    ...(opts.list ? { chatModels: opts.list } : {}),
  } as unknown as AgentProvider
}

describe('chatModels', () => {
  it('lists the chat-capable providers that are set up, a new one included, without naming any', async () => {
    const reported = (id: string) => (id === 'alpha' ? [model('a-big'), model('a-small')] : [])
    const answer = await chatModels({
      providers: [
        provider('alpha'),
        provider('beta', { list: async () => [model('b-1')] }),
        // A provider this code has never heard of: listed as soon as it says it has a chat.
        provider('newcomer'),
        provider('terminal-only', { chat: NO_CHAT }),
        provider('not-installed', { version: null }),
      ],
      reported,
    })
    expect(answer).toEqual([
      { id: 'alpha', models: [model('a-big'), model('a-small')] },
      { id: 'beta', models: [model('b-1')] },
      { id: 'newcomer', models: [] },
    ])
  })

  it('falls back to what the last chat offered when the provider cannot say, fails or takes too long', async () => {
    const reported = () => [model('remembered')]
    const answer = await chatModels({
      providers: [
        provider('empty', { list: async () => [] }),
        provider('broken', { list: () => Promise.reject(new Error('no')) }),
        provider('slow', { list: () => new Promise(() => {}) }),
      ],
      reported,
      timeoutMs: 20,
    })
    expect(answer.map((one) => one.models)).toEqual([[model('remembered')], [model('remembered')], [model('remembered')]])
  })
})

describe('ReportedModels', () => {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-chat-models-test-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('keeps the last list per provider across a restart, and only real models', () => {
    const file = join(home, 'chat-models.json')
    const store = new ReportedModels(file)
    expect(store.read('claude')).toEqual([])
    store.remember('claude', [
      { id: 'opus', label: 'Opus', description: 'Big', resolved: 'opus-x', efforts: [{ id: 'high', label: 'High', description: '' }], defaultEffort: 'high' },
      { id: '', label: 'Nameless' } as ModelOption,
    ])
    // An empty list says nothing: the one before stays.
    store.remember('claude', [])
    const again = new ReportedModels(file)
    expect(again.read('claude')).toEqual([
      { id: 'opus', label: 'Opus', description: 'Big', resolved: 'opus-x', efforts: [{ id: 'high', label: 'High', description: '' }], defaultEffort: 'high' },
    ])
    expect(again.read('codex')).toEqual([])
  })

  it('writes only when the list changed, and reads a damaged file as empty', () => {
    const file = join(home, 'other.json')
    writeFileSync(file, '{not json')
    const store = new ReportedModels(file)
    expect(store.read('claude')).toEqual([])
    store.remember('claude', [model('sonnet')])
    const written = readFileSync(file, 'utf8')
    writeFileSync(file, written.replace('SONNET', 'CHANGED BEHIND ITS BACK'))
    // The same list again: no write, so the change on disk stays.
    store.remember('claude', [model('sonnet')])
    expect(readFileSync(file, 'utf8')).toContain('CHANGED BEHIND ITS BACK')
  })
})

describe('CodexModels', () => {
  it('reads once, keeps the list until it is old, and reads again sooner after a failure', async () => {
    let now = 0
    const list = vi.fn<() => Promise<ModelOption[]>>()
      .mockRejectedValueOnce(new Error('not signed in'))
      .mockResolvedValue([model('gpt-x')])
    const models = new CodexModels({ list, version: () => '1.0.0', now: () => now, ttlMs: 1_000, failedTtlMs: 100 })
    expect(await models.get()).toEqual([])
    now = 50
    expect(await models.get()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    now = 200
    expect(await models.get()).toEqual([model('gpt-x')])
    now = 1_100
    expect(await models.get()).toEqual([model('gpt-x')])
    expect(list).toHaveBeenCalledTimes(2)
    now = 1_300
    await models.get()
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('asks one process for concurrent looks, again after an update or a sign-in, and none without Codex', async () => {
    let version: string | null = '1.0.0'
    const list = vi.fn(async () => [model('gpt-x')])
    const models = new CodexModels({ list, version: () => version })
    await Promise.all([models.get(), models.get(), models.get()])
    expect(list).toHaveBeenCalledTimes(1)
    version = '1.1.0'
    await models.get()
    expect(list).toHaveBeenCalledTimes(2)
    models.invalidate()
    await models.get()
    expect(list).toHaveBeenCalledTimes(3)
    version = null
    expect(await models.get()).toEqual([])
    expect(list).toHaveBeenCalledTimes(3)
  })
})

/** `codex app-server` that is none: answers each request from a table per method (a function gets the params). */
class FakeServer extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = []
  closed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as FakeServer['written'][number]
        this.written.push(message)
        if (message.id === undefined || !message.method) continue
        const answer = this.answers[message.method]
        if (answer === 'never') continue
        const result = typeof answer === 'function' ? answer(message.params ?? {}) : answer ?? {}
        queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)))
      }
    },
    end: () => { this.closed = true; queueMicrotask(() => this.emit('exit', 0, null)) },
  })

  constructor(private answers: Record<string, unknown>) { super() }

  kill(): boolean {
    this.closed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  }
}

const INIT = { userAgent: 'x', codexHome: '/codex', platformFamily: 'unix', platformOs: 'linux' }
const listed = (id: string, extra: Record<string, unknown> = {}) => ({
  id, model: `${id}-resolved`, displayName: id.toUpperCase(), description: `${id} model`, hidden: false, isDefault: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }], defaultReasoningEffort: 'low', ...extra,
})

describe('listCodexModels', () => {
  it('reads every page of model/list, leaves out the hidden ones and closes its process', async () => {
    const servers: FakeServer[] = []
    const spawn = () => {
      const fake = new FakeServer({
        initialize: INIT,
        'model/list': (params: Record<string, unknown>) => (params.cursor === 'page-2'
          ? { data: [listed('gpt-c')], nextCursor: null }
          : { data: [listed('gpt-a', { isDefault: true }), listed('gpt-b', { hidden: true })], nextCursor: 'page-2' }),
      })
      servers.push(fake)
      return fake as unknown as AppServerProcess
    }
    const models = await listCodexModels(spawn)
    expect(models.map((one) => one.id)).toEqual(['gpt-a', 'gpt-c'])
    expect(models[0]).toEqual({
      id: 'gpt-a', label: 'GPT-A', description: 'gpt-a model', resolved: 'gpt-a-resolved',
      efforts: [{ id: 'low', label: 'Low', description: 'Fast' }], defaultEffort: 'low',
    })
    expect(servers[0].written.map((message) => message.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
    expect(servers[0].closed).toBe(true)
  })

  it('gives up on a server that does not answer, and still closes it', async () => {
    const fake = new FakeServer({ initialize: INIT, 'model/list': 'never' })
    await expect(listCodexModels(() => fake as unknown as AppServerProcess, 30)).rejects.toThrow('Codex did not list its models.')
    expect(fake.closed).toBe(true)
  })
})
