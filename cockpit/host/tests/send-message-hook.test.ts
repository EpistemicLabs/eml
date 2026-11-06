import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

// The SendMessage hook as Claude Code runs it: a node process, the call on
// stdin, URL, token and address in env. Whatever happens it exits 0, and only
// a message the host took cancels the call.

const HOOK = join(__dirname, '..', 'src', 'send-message-hook.ts')
const CALL = JSON.stringify({ tool_name: 'SendMessage', tool_input: { to: 'eml-1 [3fa9c1]', message: 'hello' } })

const runHook = (input: string, env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const { COCKPIT_URL: _url, COCKPIT_SPAWN_TOKEN: _token, COCKPIT_SESSION_ADDRESS: _address, COCKPIT_SESSION_ID: _session, ...rest } = process.env
  const child = spawn(process.execPath, ['--import', 'tsx', HOOK], { env: { ...rest, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.on('close', (code) => resolve({ code, out }))
  child.stdin.end(input)
})

async function withHost<T>(handler: RequestListener, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.close()
  }
}

const answering = (status: number, body: string, seen: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = []): RequestListener => (req, res) => {
  let text = ''
  req.on('data', (c) => { text += c })
  req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: text }); res.statusCode = status; res.end(body) })
}

const sessionEnv = (url: string) => ({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 'token-1', COCKPIT_SESSION_ADDRESS: 'eml-2', COCKPIT_SESSION_ID: 'session-2' })

describe('SendMessage hook', () => {
  it('cancels the call when the host woke the session, and says it was delivered', async () => {
    const seen: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = []
    const { code, out } = await withHost(answering(200, '{"outcome":"resumed"}', seen), (url) => runHook(CALL, sessionEnv(url)))
    expect(code).toBe(0)
    const { hookSpecificOutput: output } = JSON.parse(out) as { hookSpecificOutput: Record<string, string> }
    expect(output.hookEventName).toBe('PreToolUse')
    expect(output.permissionDecision).toBe('deny')
    expect(output.permissionDecisionReason).toContain('Delivered')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/api/sessions/eml-1/message')
    expect(seen[0].headers['x-cockpit-token']).toBe('token-1')
    expect(JSON.parse(seen[0].body)).toEqual({ text: 'hello', from: 'eml-2', onlyIfStoppedFor: 'session-2' })
  })

  it.each([
    [409, '{"outcome":"running"}'],
    [409, '{"outcome":"busy"}'],
    [404, '{"outcome":"unknown"}'],
    [403, '{"outcome":"refused"}'],
    [403, '{"error":{"code":"FORBIDDEN"}}'],
    [500, 'not json'],
  ])('lets SendMessage go ahead on %i %s', async (status, body) => {
    const result = await withHost(answering(status, body), (url) => runHook(CALL, sessionEnv(url)))
    expect(result).toEqual({ code: 0, out: '' })
  })

  it('lets SendMessage go ahead when the host is down', async () => {
    const down = await withHost(answering(200, ''), async (url) => url)
    expect(await runHook(CALL, sessionEnv(down))).toEqual({ code: 0, out: '' })
  })

  it('lets SendMessage go ahead outside a cockpit session', async () => {
    expect(await runHook(CALL, {})).toEqual({ code: 0, out: '' })
  })

  it('lets SendMessage go ahead on input it cannot read', async () => {
    expect(await runHook('not json', sessionEnv('http://127.0.0.1:9'))).toEqual({ code: 0, out: '' })
  })

  it('asks the host nothing about an idle subscription', async () => {
    const seen: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = []
    const subscribe = JSON.stringify({ tool_name: 'SendMessage', tool_input: { to: 'eml-1', notify_when_idle: true } })
    const result = await withHost(answering(200, '{"outcome":"resumed"}', seen), (url) => runHook(subscribe, sessionEnv(url)))
    expect(result).toEqual({ code: 0, out: '' })
    expect(seen).toEqual([])
  })
})
