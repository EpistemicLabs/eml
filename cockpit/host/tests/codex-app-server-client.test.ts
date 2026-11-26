import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerClient, AppServerError, AppServerExitError, type AppServerExit } from '../src/infrastructure/providers/codex/app-server-client.js'

/**
 * The JSON-RPC client of `codex app-server` against a process that is none: what the
 * client writes is read here line by line, and what the server would say is pushed
 * into its stdout by hand.
 */

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  written = ''
  stdinEnded = false
  killed: string[] = []
  /** Like the real server: gone once its stdin closes. */
  exitsOnEof = true
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => { this.written += chunk },
    end: () => {
      this.stdinEnded = true
      if (this.exitsOnEof) queueMicrotask(() => this.emit('exit', 0, null))
    },
  })

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }

  /** What the client sent so far, one message per line. */
  sent(): Array<Record<string, unknown>> {
    return this.written.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  /** The server says something; `chunks` cuts the bytes where a pipe might. */
  say(message: unknown, chunks: number[] = []): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`)
    let from = 0
    for (const at of [...chunks, bytes.length]) {
      this.stdout.emit('data', bytes.subarray(from, at))
      from = at
    }
  }
}

function start(): { client: AppServerClient; process: FakeProcess } {
  const process = new FakeProcess()
  return { client: new AppServerClient(() => process), process }
}

const recorded = (name: string) => readFileSync(join(__dirname, 'fixtures', 'codex-app-server', name), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { dir: 'in' | 'out'; msg: Record<string, unknown> })

afterEach(() => { vi.useRealTimers() })

describe('AppServerClient', () => {
  it('writes one line per message, without a jsonrpc field, and counts its ids up', () => {
    const { client, process } = start()
    void client.request('initialize', { clientInfo: { name: 'test', title: null, version: '0' } })
    client.notify('initialized')
    void client.request('model/list', {})
    expect(process.written.endsWith('\n')).toBe(true)
    expect(process.sent()).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'test', title: null, version: '0' } } },
      { method: 'initialized' },
      { id: 2, method: 'model/list', params: {} },
    ])
    expect(client.pid).toBe(4242)
  })

  it('pairs each answer with its request, whatever the order', async () => {
    const { client, process } = start()
    const first = client.request('thread/start', {})
    const second = client.request('model/list', {})
    process.say({ id: 2, result: { data: [], nextCursor: null } })
    process.say({ id: 1, result: { thread: { id: 't1' } } })
    expect(await second).toEqual({ data: [], nextCursor: null })
    expect(await first).toEqual({ thread: { id: 't1' } })
  })

  it('speaks the recorded handshake', async () => {
    const { client, process } = start()
    const lines = recorded('handshake.jsonl')
    const answers: unknown[] = []
    for (const { dir, msg } of lines) {
      if (dir === 'in') process.say(msg)
      else if ('id' in msg) answers.push(client.request(msg.method as string, msg.params))
      else client.notify(msg.method as string, msg.params)
    }
    expect(process.sent()).toEqual(lines.filter((line) => line.dir === 'out').map((line) => line.msg))
    const [initialized, models] = await Promise.all(answers) as [{ codexHome: string }, { data: Array<{ id: string; isDefault: boolean }> }]
    expect(initialized.codexHome).toBe('/codex-home')
    expect(models.data.map((model) => [model.id, model.isDefault])).toEqual([['gpt-6-luna', true], ['gpt-5.6-terra', false]])
  })

  it('reads lines across chunks, several in one chunk, and a character cut in two', async () => {
    const { client, process } = start()
    const seen: Array<[string, unknown]> = []
    client.onNotification((method, params) => seen.push([method, params]))
    // "’" is three bytes: the second cut falls inside it.
    const delta = { method: 'item/agentMessage/delta', params: { delta: 'I’ll' } }
    process.say(delta, [5, Buffer.from(JSON.stringify(delta)).indexOf('’') + 1])
    expect(seen).toEqual([['item/agentMessage/delta', { delta: 'I’ll' }]])
    const answer = client.request('model/list', {})
    process.stdout.emit('data', '{"method":"turn/started","params":{}}\n\n{"id":1,"result":{"ok":true}}\n{"method":"turn/comp')
    expect(seen.map(([method]) => method)).toEqual(['item/agentMessage/delta', 'turn/started'])
    expect(await answer).toEqual({ ok: true })
    process.stdout.emit('data', 'leted"}\n')
    expect(seen.map(([method]) => method)).toEqual(['item/agentMessage/delta', 'turn/started', 'turn/completed'])
  })

  it('leaves out a line that is no message', () => {
    const { client, process } = start()
    const seen: string[] = []
    client.onNotification((method) => seen.push(method))
    process.stdout.emit('data', 'warning: not json\n[1,2]\n{"id":99,"result":{}}\n{"method":"error","params":{}}\n')
    expect(seen).toEqual(['error'])
  })

  it('rejects with the server\'s error, code and message', async () => {
    const { client, process } = start()
    const refused = client.request('collaborationMode/list', {})
    process.say({ error: { code: -32600, message: 'collaborationMode/list requires experimentalApi capability' }, id: 1 })
    const error = await refused.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AppServerError)
    expect(error).toMatchObject({ code: -32600, message: 'collaborationMode/list requires experimentalApi capability' })
  })

  it('hands on a request of the server, answered later by its id', () => {
    const { client, process } = start()
    const asked: Array<[number | string, string, unknown]> = []
    client.onRequest((id, method, params) => asked.push([id, method, params]))
    // The server's own counter starts at 0, and overlaps the client's.
    void client.request('turn/start', { threadId: 't', input: [] })
    process.say({ method: 'item/commandExecution/requestApproval', id: 0, params: { itemId: 'exec-1' } })
    process.say({ method: 'item/fileChange/requestApproval', id: 1, params: { itemId: 'patch-1' } })
    expect(asked).toEqual([
      [0, 'item/commandExecution/requestApproval', { itemId: 'exec-1' }],
      [1, 'item/fileChange/requestApproval', { itemId: 'patch-1' }],
    ])
    client.respond(1, { decision: 'decline' })
    client.respond(0, { decision: 'accept' })
    client.respondError(7, -32601, 'No such thing')
    expect(process.sent().slice(1)).toEqual([
      { id: 1, result: { decision: 'decline' } },
      { id: 0, result: { decision: 'accept' } },
      { id: 7, error: { code: -32601, message: 'No such thing' } },
    ])
  })

  it('refuses a request of the server nobody listens for', () => {
    const { process } = start()
    process.say({ method: 'item/tool/requestUserInput', id: 3, params: {} })
    expect(process.sent()).toEqual([{ id: 3, error: { code: -32601, message: 'No handler for item/tool/requestUserInput' } }])
  })

  it('rejects everything pending when the process ends, and whatever is asked after', async () => {
    const { client, process } = start()
    const exits: AppServerExit[] = []
    client.onExit((exit) => exits.push(exit))
    const pending = [client.request('thread/start', {}), client.request('model/list', {})]
    process.stderr.emit('data', Buffer.from('error: the reason\n'))
    process.emit('exit', 1, null)
    for (const request of pending) await expect(request).rejects.toBeInstanceOf(AppServerExitError)
    await expect(client.request('model/list', {})).rejects.toBeInstanceOf(AppServerExitError)
    await client.exited
    expect(exits).toEqual([{ code: 1, signal: null, expected: false }])
    expect(client.stderrTail()).toBe('error: the reason\n')
  })

  it('counts a process that never started as ended', async () => {
    const { client, process } = start()
    const pending = client.request('initialize', { clientInfo: { name: 'test', title: null, version: '0' } })
    process.emit('error', new Error('spawn codex ENOENT'))
    await expect(pending).rejects.toBeInstanceOf(AppServerExitError)
    await client.close()
  })

  it('closes by ending stdin, and resolves once the process is gone', async () => {
    const { client, process } = start()
    const exits: AppServerExit[] = []
    client.onExit((exit) => exits.push(exit))
    const pending = client.request('turn/start', { threadId: 't', input: [] })
    await client.close()
    expect(process.stdinEnded).toBe(true)
    expect(process.killed).toEqual([])
    expect(exits).toEqual([{ code: 0, signal: null, expected: true }])
    await expect(pending).rejects.toBeInstanceOf(AppServerExitError)
    await client.close()
  })

  it('kills a process that ignores the end of its stdin, after the timeout', async () => {
    vi.useFakeTimers()
    const { client, process } = start()
    process.exitsOnEof = false
    let closed = false
    const closing = client.close().then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(7_000)
    expect(process.killed).toEqual([])
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await closing
    expect(process.killed).toEqual(['SIGKILL'])
  })
})
