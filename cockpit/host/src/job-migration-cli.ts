import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { readCockpitConfig } from './config.js'
import { COCKPIT_HOME, JOBS_FILE } from './paths.js'
import { readBrainInfo } from './brain-info.js'
import { jobMigrationReport, planJobMigration, type JobMigrationTask } from './domain/job-migration.js'
import type { JobV1 } from './domain/job-v1.js'
import type { JobRun } from './domain/job.js'
import { routineTaskOfJob } from './application/job-migration.js'

/**
 * `eml-cockpit migrate-jobs`: the dry run of the migration of jobs.json version 1 to version 2
 * (domain/job-migration.ts), by hand, on the home EML_COCKPIT_HOME names. It prints, per space and task, what the
 * host would do at its next start: which repeating times and which wake-up each task gets, which text is appended,
 * which jobs are dropped and why, which per-machine settings move.
 *
 * It only reads: jobs.json, the config, control.db and each space's brain file (opened read-only). It writes nothing
 * and needs no running host, so it can be pointed at a copy of a home. The brain may still be at schema 23: only a
 * task's status, owner, text and delegation are read. There is no --run: the host writes the migration at its start.
 */

const require = createRequire(import.meta.url)
type Db = { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void }
const Database = require('better-sqlite3') as new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => Db

interface V1Data { jobs: Record<string, JobV1>; runs: Record<string, JobRun[]>; keys: Record<string, Record<string, string>> }

/** The version 1 jobs of a jobs.json that are not migrated yet; null when it holds none. */
export function pendingJobsOf(raw: string): V1Data | null {
  const parsed = JSON.parse(raw) as { version?: number; jobs?: unknown; runs?: unknown; keys?: unknown; v1?: { jobs?: unknown; runs?: unknown; keys?: unknown } }
  const from = parsed.version === 1 ? parsed : parsed.version === 2 ? parsed.v1 : undefined
  const part = <T>(value: unknown) => (value && typeof value === 'object' ? value as Record<string, T> : {})
  const data: V1Data = { jobs: part(from?.jobs), runs: part(from?.runs), keys: part(from?.keys) }
  return Object.keys(data.jobs).length > 0 ? data : null
}

function taskFrom(db: Db, id: string): JobMigrationTask | null {
  const row = db.prepare("SELECT id, status, title, content, properties, ingested_by FROM engrams WHERE id = ? AND type = 'task'").get(id) as
    | { id: string; status: string; title: string | null; content: string; properties: string | null; ingested_by: string | null } | undefined
  if (!row) return null
  let properties: JobMigrationTask['properties'] = null
  try { properties = row.properties ? JSON.parse(row.properties) as JobMigrationTask['properties'] : null } catch { /* a task without readable properties has none */ }
  return { id: row.id, status: row.status, title: row.title, content: row.content, ingested_by: row.ingested_by, properties }
}

export async function runMigrateJobsCommand(argv: string[], out: (text: string) => void = (text) => { process.stdout.write(text) }): Promise<boolean> {
  if (argv[0] !== 'migrate-jobs') return false
  if (argv.includes('--run')) throw new Error('migrate-jobs is the dry run only: the host writes the migration at its start')
  const config = await readCockpitConfig()
  if (!config) throw new Error(`no cockpit config in ${COCKPIT_HOME}: this home is not set up`)
  if (!fs.existsSync(JOBS_FILE)) { out(`no jobs.json in ${COCKPIT_HOME}: nothing to move\n`); return true }
  const pending = pendingJobsOf(fs.readFileSync(JOBS_FILE, 'utf8'))
  if (!pending) { out('jobs.json holds no version 1 jobs: nothing to move\n'); return true }
  const jobs = Object.values(pending.jobs)
  const me = config.handle ?? 'user'
  const now = Date.now()
  const spaces = [{ token: config.token, name: config.mainName ?? 'Main', main: true }, ...(config.spaces ?? []).map((s) => ({ token: s.token, name: s.name ?? 'Space', main: false }))]
  const seen = new Set<string | null>()
  out(`Dry run on ${COCKPIT_HOME} as ${me}: nothing is written.\n\n`)
  for (const space of spaces) {
    const info = readBrainInfo(space.token)
    const key = space.main ? null : info.brainId
    if (!space.main && !key) { out(`# ${space.name}\n\nIts brain is not in this home's control.db: skipped.\n\n`); continue }
    seen.add(key)
    const mine = jobs.filter((j) => (j.spaceId ?? null) === key)
    if (mine.length === 0) continue
    if (!info.brainFile || !fs.existsSync(info.brainFile)) { out(`# ${space.name}\n\nIts brain file is not on this machine: its ${mine.length} job(s) cannot be planned here.\n\n`); continue }
    // Whose cockpit fires a task depends on whether its space is shared, and only the brain server says that. The
    // main space is this home's own brain, local by construction; any other space is not planned here, not guessed.
    if (!space.main) {
      out(`# ${space.name}\n\nWhether this space is shared only its brain server says, and the dry run does not ask it: its ${mine.length} job(s) are not planned here. The host plans them at its start, once the brain server has answered: in a local space every task's jobs move; in a shared one the jobs on another member's task go onto that task for the owner's cockpit to fire.\n\n`)
      continue
    }
    const db = new Database(info.brainFile, { readonly: true, fileMustExist: true })
    try {
      const tasks: Record<string, JobMigrationTask | null> = {}
      for (const id of new Set(mine.flatMap((j) => (j.taskId ? [j.taskId] : [])))) tasks[id] = taskFrom(db, id)
      const plan = planJobMigration({ jobs, runs: pending.runs, keys: pending.keys, space: { key, name: space.name, shared: false }, tasks, me, now, routineTaskOf: routineTaskOfJob(me) })
      out(`${jobMigrationReport(plan, { space: space.name, at: new Date(now).toISOString(), dryRun: true })}\n`)
    } finally {
      db.close()
    }
  }
  const homeless = jobs.filter((j) => !seen.has(j.spaceId ?? null))
  if (homeless.length > 0) out(`${homeless.length} job(s) belong to a space this home no longer has: they stay as they are.\n`)
  return true
}
