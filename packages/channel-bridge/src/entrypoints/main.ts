import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { openBridgeDatabase } from '../adapters/sqlite/bridge-database'
import { SqliteMessageStore } from '../adapters/sqlite/sqlite-message-store'
import { SqliteWakeQueue } from '../adapters/sqlite/sqlite-wake-queue'
import { SqliteOutboxStore } from '../adapters/sqlite/sqlite-outbox-store'
import { CockpitHttpClient } from '../adapters/cockpit-http/cockpit-http-client'
import type { ChannelAccount, ChannelAccounts } from '../ports/channel'
import { createBridgeApi } from './bridge-api'
import type { Log } from './bridge-api'
import { startBridgeLoop } from './bridge-loop'

const COLLECT_MS = 120_000
const EVERY_MS = 60_000

/**
 * Starts the bridge: its database and tokens in CHANNEL_BRIDGE_HOME, its API on loopback at
 * CHANNEL_BRIDGE_PORT, the cockpit at COCKPIT_URL with one token per space from
 * COCKPIT_JOB_TOKENS_DIR. Channel accounts join with their plug-ins.
 */
export async function main(env: NodeJS.ProcessEnv = process.env, accounts: ChannelAccount[] = []): Promise<{ stop(): Promise<void> }> {
  const home = required(env, 'CHANNEL_BRIDGE_HOME')
  const port = Number(required(env, 'CHANNEL_BRIDGE_PORT'))
  const cockpitUrl = required(env, 'COCKPIT_URL')
  const tokensDir = required(env, 'COCKPIT_JOB_TOKENS_DIR')
  if (!Number.isInteger(port) || port <= 0) throw new Error('CHANNEL_BRIDGE_PORT must be a port number')

  mkdirSync(home, { recursive: true, mode: 0o700 })
  const db = openBridgeDatabase(join(home, 'bridge.db'))
  const cockpit = new CockpitHttpClient({ url: cockpitUrl, spaces: spaceTokens(tokensDir) })
  const channels: ChannelAccounts = { account: (id) => accounts.find((account) => account.accountId === id) ?? null }
  const log: Log = (event, fields) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`)
  const deps = {
    store: new SqliteMessageStore(db),
    wakes: new SqliteWakeQueue(db),
    outbox: new SqliteOutboxStore(db),
    jobs: cockpit,
    cockpit,
    channels,
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => randomUUID() },
  }

  const api = createBridgeApi(deps, {
    toolToken: ownerOnlyToken(join(home, 'tool-token')),
    cockpitToken: ownerOnlyToken(join(home, 'cockpit-token')),
    log,
  })
  await new Promise<void>((resolve) => api.listen(port, '127.0.0.1', resolve))
  const loop = startBridgeLoop(deps, { accounts, collectMs: COLLECT_MS, everyMs: EVERY_MS, log })
  log('bridge.started', { accounts: accounts.length })

  return {
    stop: async () => {
      loop.stop()
      await new Promise<void>((resolve) => api.close(() => resolve()))
      db.close()
    },
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

/** A token file readable by its owner only, created on first start. */
function ownerOnlyToken(path: string): string {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 })
  chmodSync(path, 0o600)
  return readFileSync(path, 'utf8').trim()
}

/** One file per space, named after the space, holding that space's token. */
function spaceTokens(dir: string): { space: string; token: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((space) => ({ space, token: readFileSync(join(dir, space), 'utf8').trim() }))
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : 'failed to start'}\n`)
    process.exit(1)
  })
}
