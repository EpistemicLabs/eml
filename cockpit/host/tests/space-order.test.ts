import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-space-order-test-'))
process.env.EML_COCKPIT_HOME = home

const fakeSpace = (id: string, main = false) => ({
  id,
  name: id,
  main,
  agent: null,
  runtime: null,
  ledgerKey: main ? null : id,
  token: `token-${id}`,
})

describe('space order', () => {
  let server: Server
  let base: string
  let config: typeof import('../src/config.js')

  beforeAll(async () => {
    config = await import('../src/config.js')
    const { BrainSpaces } = await import('../src/brain-space.js')
    const { createHostServer } = await import('../src/http.js')
    const { SessionLedger } = await import('../src/session-ledger.js')
    const { TurnTracker } = await import('../src/turn-state.js')
    await config.writeCockpitConfig({ token: 'token-main', spaces: [{ token: 'token-a' }, { token: 'token-b' }] })
    const spaces = new BrainSpaces(fakeSpace('main', true) as never, ['b'])
    spaces.add(fakeSpace('a') as never)
    spaces.add(fakeSpace('b') as never)
    const deps = {
      spaces,
      turns: new TurnTracker(),
      providers: { forSession: () => null, all: () => [] },
      bridge: { ledger: new SessionLedger(), sessionState: () => 'ended' },
      chat: { isRunning: () => false },
      spawns: { on: () => {}, off: () => {}, list: () => [] },
      spawnToken: 'spawn-token',
      hookToken: 'hook-token',
      turnHookConfig: '',
    }
    server = createHostServer(deps as never, ['http://cockpit.test'])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })

  const listed = async () => ((await (await fetch(`${base}/api/spaces`)).json()) as { spaces: Array<{ id: string }> }).spaces.map((s) => s.id)
  const putOrder = (ids: unknown) => fetch(`${base}/api/spaces/order`, {
    method: 'PUT',
    headers: { origin: 'http://cockpit.test', 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })

  it('lists the spaces the order names first, the others after in config order', async () => {
    expect(await listed()).toEqual(['b', 'main', 'a'])
  })

  it('stores a new order in the cockpit config, without ids it does not know', async () => {
    const res = await putOrder(['a', 'gone', 'main', 'b'])
    expect(res.status).toBe(200)
    expect(await listed()).toEqual(['a', 'main', 'b'])
    expect((await config.readCockpitConfig())?.spaceOrder).toEqual(['a', 'main', 'b'])
  })

  it('refuses an order that is not a list of ids', async () => {
    expect((await putOrder('a')).status).toBe(400)
    expect(await listed()).toEqual(['a', 'main', 'b'])
  })
})
