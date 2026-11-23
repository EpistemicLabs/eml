import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { openBridgeDatabase } from '../adapters/sqlite/bridge-database'
import { SqliteMessageStore } from '../adapters/sqlite/sqlite-message-store'
import { SqliteWakeQueue } from '../adapters/sqlite/sqlite-wake-queue'
import { SqliteOutboxStore } from '../adapters/sqlite/sqlite-outbox-store'
import { CockpitHttpClient } from '../adapters/cockpit-http/cockpit-http-client'
import { z } from 'zod'
import type { ChannelAccount, ChannelAccounts } from '../ports/channel'
import { adapterFor } from './channel-adapters'
import { createBridgeApi } from './bridge-api'
import type { Log } from './bridge-api'
import { startBridgeLoop } from './bridge-loop'

const COLLECT_MS = 120_000
const EVERY_MS = 60_000

/**
 * Starts the bridge: its database and tokens in CHANNEL_BRIDGE_HOME, its API on loopback at
 * CHANNEL_BRIDGE_PORT, the cockpit at COCKPIT_URL with one token per space from
 * COCKPIT_JOB_TOKENS_DIR, the channel accounts from CHANNEL_BRIDGE_ACCOUNTS_FILE.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ stop(): Promise<void> }> {
  const home = required(env, 'CHANNEL_BRIDGE_HOME')
  const port = Number(required(env, 'CHANNEL_BRIDGE_PORT'))
  const cockpitUrl = required(env, 'COCKPIT_URL')
  const tokensDir = required(env, 'COCKPIT_JOB_TOKENS_DIR')
  const accountsFile = required(env, 'CHANNEL_BRIDGE_ACCOUNTS_FILE')
  if (!Number.isInteger(port) || port <= 0) throw new Error('CHANNEL_BRIDGE_PORT must be a port number')

  const spaces = spaceTokens(tokensDir)
  const accounts = channelAccounts(accountsFile, spaces.map((entry) => entry.space))
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const db = openBridgeDatabase(join(home, 'bridge.db'))
  const cockpit = new CockpitHttpClient({ url: cockpitUrl, spaces })
  const channels: ChannelAccounts = {
    account: (id) => accounts.find((account) => account.accountId === id) ?? null,
    inSpace: (space) => accounts.filter((account) => account.spaces.includes(space)),
  }
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
  // Where the job tools find the bridge; it changes with the port.
  writeFileSync(join(home, 'url'), `http://127.0.0.1:${port}`, { mode: 0o600 })
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

/**
 * What every entry of the accounts file has; the rest belongs to the adapter its `type` names. An
 * account lists the spaces where its plugin is on (`spaces`); a file written before that names one
 * (`space`), which still reads.
 */
const accountsSchema = z.array(
  z.looseObject({
    type: z.string().min(1),
    accountId: z.string().min(1),
    space: z.string().min(1).optional(),
    spaces: z.array(z.string().min(1)).min(1).optional(),
  }).refine((entry) => (entry.space === undefined) !== (entry.spaces === undefined), 'an account names its spaces, or one space'),
)

/** The accounts the bridge watches. Each lists spaces the bridge has a token for, under a unique id. */
function channelAccounts(file: string, spaces: string[]): ChannelAccount[] {
  let entries: { accountId: string; spaces: string[]; create(): ChannelAccount }[]
  try {
    entries = accountsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).map(({ type, accountId, space, spaces: listed, ...rest }) => {
      const adapter = adapterFor(type)
      if (!adapter) throw new Error('no plugin serves this account type')
      const accountSpaces = [...new Set(listed ?? [space as string])]
      const config = adapter.configSchema.parse({ type, accountId, spaces: accountSpaces, ...rest })
      return { accountId, spaces: accountSpaces, create: () => adapter.create(config, { accountId, spaces: accountSpaces }) }
    })
  } catch {
    throw new Error('CHANNEL_BRIDGE_ACCOUNTS_FILE is not a valid list of accounts')
  }
  const ids = entries.map((entry) => entry.accountId)
  if (new Set(ids).size !== ids.length) throw new Error('every account needs its own accountId')
  for (const entry of entries) {
    if (entry.spaces.some((space) => !spaces.includes(space))) throw new Error(`account ${entry.accountId} names a space without a token`)
  }
  return entries.map((entry) => entry.create())
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

/** One file per space, named after the space, holding that space's token. None, or an empty one, refuses the start. */
function spaceTokens(dir: string): { space: string; token: string }[] {
  const spaces = existsSync(dir) ? readdirSync(dir) : []
  if (spaces.length === 0) throw new Error('COCKPIT_JOB_TOKENS_DIR must hold a token file for at least one space')
  return spaces.map((space) => {
    const token = readFileSync(join(dir, space), 'utf8').trim()
    if (!token) throw new Error(`the token file for space ${space} is empty`)
    return { space, token }
  })
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : 'failed to start'}\n`)
    process.exit(1)
  })
}
