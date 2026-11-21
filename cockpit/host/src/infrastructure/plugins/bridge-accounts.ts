import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { setPlugin, type BridgeAccount, type Connection } from '../../domain/space-plugins.js'
import type { PluginStore } from './plugin-store.js'

const STEP = 'import:bridge-accounts'

/**
 * Once per home: the accounts file written by hand before the plugins becomes the gmail plugin's
 * connections, each on in the space it named, under its own id (so the bridge's cursors and threads
 * carry on). The file is copied to the backups first; from then on the cockpit writes it.
 */
export async function importBridgeAccounts(file: string, store: PluginStore, backupsDir: string, now = new Date()): Promise<string[]> {
  if ((await store.spaces()).done.includes(STEP)) return []
  let entries: unknown
  try {
    entries = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    entries = []
  }
  const imported: Array<{ connection: Connection; spaces: string[] }> = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const { type, accountId, space, spaces, ...values } = entry as Record<string, unknown>
    if (typeof type !== 'string' || typeof accountId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(accountId)) continue
    const list = Array.isArray(spaces) ? spaces.filter((s): s is string => typeof s === 'string') : typeof space === 'string' ? [space] : []
    const stringValues = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    // The gmail adapter's type is the gmail plugin's id; a later channel plugin keeps that rule.
    imported.push({ connection: { id: accountId, plugin: type, label: stringValues.address ?? accountId, values: stringValues }, spaces: list })
  }
  if (imported.length > 0) {
    await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 })
    const backup = path.join(backupsDir, `accounts.json.${now.toISOString().replace(/[:.]/g, '-')}`)
    await fs.copyFile(file, backup)
    await fs.chmod(backup, 0o600)
    await store.updateConnections((all) => [...all.filter((c) => !imported.some((i) => i.connection.id === c.id)), ...imported.map((i) => i.connection)])
  }
  await store.updateSpaces((state) => {
    let next = state
    for (const { connection, spaces } of imported) for (const space of spaces) next = setPlugin(next, space, connection.plugin, { connection: connection.id })
    return { ...next, done: [...next.done, STEP] }
  })
  return imported.map((i) => i.connection.id)
}

/** Writes the accounts file the bridge reads at start (owner-only); none when there is no account. True when it changed. */
export async function writeBridgeAccounts(file: string, accounts: BridgeAccount[]): Promise<boolean> {
  let before: string | null = null
  try {
    before = await fs.readFile(file, 'utf8')
  } catch {
    before = null
  }
  if (accounts.length === 0) {
    if (before === null) return false
    await fs.rm(file, { force: true })
    return true
  }
  const text = `${JSON.stringify(accounts, null, 2)}\n`
  if (text === before) return false
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, file)
  return true
}
