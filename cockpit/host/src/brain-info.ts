import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { BACKUPS_DIR, COCKPIT_HOME, DATA_DIR } from './paths.js'
import { platform } from './infrastructure/platform/index.js'

/**
 * Settings › Brain: what the local brain is (file, id, schema, identity) and
 * WAL-safe backups of it. Read-only on the brain and control DBs except the
 * backup copy; paths never leave the host except as display strings.
 */

const require = createRequire(import.meta.url)

// better-sqlite3 is a runtime dependency of the host (the bundled server uses
// it too); typed locally to what is used here.
type Statement = { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
type Db = {
  prepare(sql: string): Statement
  backup(destination: string): Promise<unknown>
  close(): void
}
const Database = require('better-sqlite3') as new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => Db

const CONTROL_DB = path.join(DATA_DIR, 'control.db')

export interface BrainInfo {
  source: 'local'
  home: string
  brainId: string | null
  brainName: string | null
  brainFile: string | null
  sizeBytes: number | null
  modifiedAt: string | null
  schemaVersion: number | null
  createdAt: string | null
  /** Handle stamped into ingested_by — the name of this cockpit's token. */
  author: string | null
  agents: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string }>
}

/** The control row of the brain this cockpit's token belongs to (tokens: eml_<8 prefix><32 secret>). */
function brainForToken(control: Db, token: string) {
  const body = token.startsWith('eml_') ? token.slice(4) : ''
  if (body.length !== 40) return null
  const prefix = body.slice(0, 8)
  const hash = createHash('sha256').update(body.slice(8)).digest('hex')
  return (control.prepare(
    `SELECT t.name AS author, b.id, b.name, b.brain_file, b.schema_version, b.created_at
       FROM tokens t JOIN brains b ON b.id = t.brain_id
      WHERE t.prefix = ? AND t.token_hash = ? AND t.revoked_at IS NULL`,
  ).get(prefix, hash) ?? null) as
    | { author: string | null; id: string; name: string; brain_file: string; schema_version: number; created_at: string }
    | null
}

/** Id + name of the brain a token belongs to (brain-space.ts), null when the token is unknown. */
export function brainForLocalToken(token: string): { id: string; name: string } | null {
  if (!fs.existsSync(CONTROL_DB)) return null
  const control = new Database(CONTROL_DB, { readonly: true, fileMustExist: true })
  try {
    const row = brainForToken(control, token)
    return row ? { id: row.id, name: row.name } : null
  } finally {
    control.close()
  }
}

function listRows(db: Db, table: 'agents' | 'users'): Array<{ id: string; name: string }> {
  try {
    return db.prepare(`SELECT id, name FROM ${table} ORDER BY name`).all() as Array<{ id: string; name: string }>
  } catch {
    return []
  }
}

export function readBrainInfo(token: string): BrainInfo {
  const info: BrainInfo = {
    source: 'local', home: COCKPIT_HOME, brainId: null, brainName: null, brainFile: null,
    sizeBytes: null, modifiedAt: null, schemaVersion: null, createdAt: null,
    author: null, agents: [], users: [],
  }
  if (!fs.existsSync(CONTROL_DB)) return info
  const control = new Database(CONTROL_DB, { readonly: true, fileMustExist: true })
  try {
    const row = brainForToken(control, token)
    if (!row) return info
    const file = path.join(DATA_DIR, row.brain_file)
    Object.assign(info, {
      brainId: row.id, brainName: row.name, brainFile: file,
      schemaVersion: row.schema_version, createdAt: row.created_at, author: row.author,
    })
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file)
      info.sizeBytes = stat.size
      // Recent writes sit in the WAL until a checkpoint; its mtime is the real "last write".
      const walMtime = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).mtimeMs : 0
      info.modifiedAt = new Date(Math.max(stat.mtimeMs, walMtime)).toISOString()
      const brain = new Database(file, { readonly: true, fileMustExist: true })
      try {
        info.agents = listRows(brain, 'agents')
        info.users = listRows(brain, 'users')
      } finally {
        brain.close()
      }
    }
  } finally {
    control.close()
  }
  return info
}

/** Show the brain file in the OS file manager (selected where the OS can). */
export function revealBrainFile(file: string): Promise<void> {
  return platform.revealFile(file)
}

export interface BrainBackup {
  /** Path relative to <home>/backups, e.g. "pre-migration/<file>.db". */
  name: string
  /** manual = "Back up now"; pre-migration = taken by the brain server before a schema update. */
  kind: 'manual' | 'pre-migration'
  sizeBytes: number
  createdAt: string
}

/** Backups in <home>/backups; with `brainId`, only that brain's (both kinds are named after it). */
export function listBackups(brainId?: string): BrainBackup[] {
  const prefix = brainId ? brainId.slice(0, 8) : ''
  const list = (sub: string, kind: BrainBackup['kind']): BrainBackup[] => {
    const dir = path.join(BACKUPS_DIR, sub)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.db') && name.startsWith(prefix))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name))
        return { name: path.posix.join(sub, name), kind, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() }
      })
  }
  return [...list('', 'manual'), ...list('pre-migration', 'pre-migration')]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * WAL-safe copy of the brain via SQLite's online backup API — consistent even
 * while the brain server writes. Lands in <home>/backups (chmod 700 / 600).
 */
export async function createBackup(token: string): Promise<BrainBackup> {
  const info = readBrainInfo(token)
  if (!info.brainFile || !info.brainId) throw new Error('no local brain to back up')
  fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const name = `${info.brainId.slice(0, 8)}-${stamp}.db`
  const dest = path.join(BACKUPS_DIR, name)
  const brain = new Database(info.brainFile, { readonly: true, fileMustExist: true })
  try {
    await brain.backup(dest)
  } finally {
    brain.close()
  }
  fs.chmodSync(dest, 0o600)
  const stat = fs.statSync(dest)
  return { name, kind: 'manual', sizeBytes: stat.size, createdAt: stat.mtime.toISOString() }
}
