import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

// The turn-state hook as an agent CLI runs it: a node process, the event on
// stdin, the session id in env, URL and token in the config file.

const dir = mkdtempSync(join(tmpdir(), 'cockpit-turn-hook-test-'))
const HOOK = join(__dirname, '..', 'src', 'turn-hook.ts')

const runHook = (configFile: string, input: string) => new Promise<number | null>((resolve) => {
  const child = spawn(process.execPath, ['--import', 'tsx', HOOK, configFile], {
    env: { ...process.env, COCKPIT_SESSION_ID: 'session-1' },
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  child.on('exit', resolve)
  child.stdin.end(input)
})

describe('turn hook', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('posts the event with the token and the session id, and exits 0', async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { received.push({ headers: req.headers, body }); res.end() })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const { writeTurnHookConfig } = await import('../src/infrastructure/providers/shared.js')
      const config = join(dir, 'turn-hook.json')
      writeTurnHookConfig(config, `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hook`, 'token-1')
      expect(await runHook(config, '{"hook_event_name":"Stop"}')).toBe(0)
      expect(received).toHaveLength(1)
      expect(received[0].body).toBe('{"hook_event_name":"Stop"}')
      expect(received[0].headers).toMatchObject({ 'x-cockpit-hook': 'token-1', 'x-cockpit-session': 'session-1', 'content-type': 'application/json' })
    } finally {
      server.close()
    }
  }, 20_000)

  it('exits 0 when the host is gone or the config is missing', async () => {
    const { writeTurnHookConfig } = await import('../src/infrastructure/providers/shared.js')
    const config = join(dir, 'gone.json')
    writeTurnHookConfig(config, 'http://127.0.0.1:9/api/hook', 'token-1')
    expect(await runHook(config, '{}')).toBe(0)
    expect(await runHook(join(dir, 'missing.json'), '{}')).toBe(0)
  }, 20_000)
})
