import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer } from 'net'
import { main } from '../src/entrypoints/main'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('main', () => {
  it('starts on loopback with owner-only tokens and refuses requests without them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-bridge-main-'))
    try {
      const tokens = join(root, 'job-tokens')
      mkdirSync(tokens)
      writeFileSync(join(tokens, 'support'), 'space-token\n')
      const port = await freePort()
      writeFileSync(join(root, 'accounts.json'), '[]')
      const bridge = await main({
        CHANNEL_BRIDGE_HOME: join(root, 'home'), CHANNEL_BRIDGE_PORT: String(port),
        COCKPIT_URL: 'http://127.0.0.1:1', COCKPIT_JOB_TOKENS_DIR: tokens, CHANNEL_BRIDGE_ACCOUNTS_FILE: join(root, 'accounts.json'),
      })
      try {
        expect(statSync(join(root, 'home', 'tool-token')).mode & 0o777).toBe(0o600)
        expect(statSync(join(root, 'home', 'cockpit-token')).mode & 0o777).toBe(0o600)
        expect(readFileSync(join(root, 'home', 'url'), 'utf8')).toBe(`http://127.0.0.1:${port}`)
        const denied = await fetch(`http://127.0.0.1:${port}/v1/jobs/job-1/messages/read`, { method: 'POST' })
        expect(denied.status).toBe(401)
        const token = readFileSync(join(root, 'home', 'tool-token'), 'utf8')
        const allowed = await fetch(`http://127.0.0.1:${port}/v1/jobs/job-1/messages/read`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
        })
        // The cockpit at COCKPIT_URL is away, so the job cannot be looked up: a retryable answer.
        expect(allowed.status).toBe(503)
        expect(await allowed.json()).toMatchObject({ kind: 'unavailable', retryable: true })
      } finally {
        await bridge.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an accounts file it cannot read, naming the problem without its contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-bridge-main-'))
    try {
      mkdirSync(join(root, 'job-tokens'))
      writeFileSync(join(root, 'job-tokens', 'support'), 'space-token')
      const env = {
        CHANNEL_BRIDGE_HOME: join(root, 'home'), CHANNEL_BRIDGE_PORT: '1', COCKPIT_URL: 'http://127.0.0.1:1',
        COCKPIT_JOB_TOKENS_DIR: join(root, 'job-tokens'), CHANNEL_BRIDGE_ACCOUNTS_FILE: join(root, 'accounts.json'),
      }
      writeFileSync(join(root, 'accounts.json'), JSON.stringify([{ type: 'gmail', accountId: 'a', space: 'support' }]))
      await expect(main(env)).rejects.toThrow('CHANNEL_BRIDGE_ACCOUNTS_FILE')
      writeFileSync(join(root, 'accounts.json'), JSON.stringify([
        { type: 'gmail', accountId: 'a', space: 'support', address: 'me@home.example', credentialsFile: '/x', tokenFile: '/y' },
        { type: 'gmail', accountId: 'a', space: 'support', address: 'other@home.example', credentialsFile: '/x', tokenFile: '/y' },
      ]))
      await expect(main(env)).rejects.toThrow('accountId')
      writeFileSync(join(root, 'accounts.json'), JSON.stringify([
        { type: 'gmail', accountId: 'a', space: 'elsewhere', address: 'me@home.example', credentialsFile: '/x', tokenFile: '/y' },
      ]))
      await expect(main(env)).rejects.toThrow('space')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to start without its settings', async () => {
    await expect(main({})).rejects.toThrow('CHANNEL_BRIDGE_HOME')
  })

  it('refuses to start without a token for at least one space, or with an empty one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-bridge-main-'))
    try {
      writeFileSync(join(root, 'accounts.json'), '[]')
      const env = {
        CHANNEL_BRIDGE_HOME: join(root, 'home'), CHANNEL_BRIDGE_PORT: '1',
        COCKPIT_URL: 'http://127.0.0.1:1', COCKPIT_JOB_TOKENS_DIR: join(root, 'job-tokens'),
        CHANNEL_BRIDGE_ACCOUNTS_FILE: join(root, 'accounts.json'),
      }
      await expect(main(env)).rejects.toThrow('COCKPIT_JOB_TOKENS_DIR')
      mkdirSync(join(root, 'job-tokens'))
      await expect(main(env)).rejects.toThrow('COCKPIT_JOB_TOKENS_DIR')
      writeFileSync(join(root, 'job-tokens', 'support'), '  \n')
      await expect(main(env)).rejects.toThrow('support')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
