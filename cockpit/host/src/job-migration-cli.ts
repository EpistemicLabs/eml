import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { readCockpitConfig, type CockpitConfig } from './config.js'
import { COCKPIT_HOME, JOBS_FILE } from './paths.js'
import { readBrainInfo, type BrainInfo } from './brain-info.js'
import { jobMigrationReport, planJobMigration, type JobMigrationTask } from './domain/job-migration.js'
import { JobStore } from './job-store.js'
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
type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; close(): void }
const Database = require('better-sqlite3') as new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => Db

type TaskRow = { id: string; status: string; title: string | null; content: string; properties: string | null; ingested_by: string | null }

function taskOfRow(row: TaskRow): JobMigrationTask {
  let properties: JobMigrationTask['properties'] = null
  try { properties = row.properties ? JSON.parse(row.properties) as JobMigrationTask['properties'] : null } catch { /* a task without readable properties has none */ }
  return { id: row.id, status: row.status, title: row.title, content: row.content, ingested_by: row.ingested_by, properties }
}

function taskFrom(db: Db, id: string): JobMigrationTask | null {
  const row = db.prepare("SELECT id, status, title, content, properties, ingested_by FROM engrams WHERE id = ? AND type = 'task'").get(id) as TaskRow | undefined
  return row ? taskOfRow(row) : null
}

/** The brain's open tasks that have a schedule: among them the pass looks for schedules left without a job. */
function scheduledFrom(db: Db): JobMigrationTask[] {
  const rows = db.prepare("SELECT id, status, title, content, properties, ingested_by FROM engrams WHERE type = 'task' AND status IN ('planned', 'active')").all() as TaskRow[]
  return rows.map(taskOfRow).filter((task) => task.properties?.delegation?.schedule)
}

/** The home the dry run reads: its folder (named in what it prints), its jobs.json, its config, and the brain a space's token belongs to. */
export interface MigrateJobsHome {
  dir: string
  jobsFile: string
  config(): Promise<Pick<CockpitConfig, 'token' | 'handle' | 'mainName' | 'spaces'> | null>
  brainOf(token: string): Pick<BrainInfo, 'brainId' | 'brainFile'>
}

const THIS_HOME: MigrateJobsHome = { dir: COCKPIT_HOME, jobsFile: JOBS_FILE, config: readCockpitConfig, brainOf: readBrainInfo }

export async function runMigrateJobsCommand(argv: string[], out: (text: string) => void = (text) => { process.stdout.write(text) }, home: MigrateJobsHome = THIS_HOME): Promise<boolean> {
  if (argv[0] !== 'migrate-jobs') return false
  if (argv.includes('--run')) throw new Error('migrate-jobs is the dry run only: the host writes the migration at its start')
  const config = await home.config()
  if (!config) throw new Error(`no cockpit config in ${home.dir}: this home is not set up`)
  if (!fs.existsSync(home.jobsFile)) { out(`no jobs.json in ${home.dir}: nothing to move\n`); return true }
  // Read as the host reads it (job-store.ts); the store writes only on a change, and none is made here.
  const store = new JobStore(home.jobsFile)
  const pending = store.pendingV1()
  const jobs = Object.values(pending?.jobs ?? {})
  // As the host's pass: in a home that was on version 1 the main space is looked through once for schedules left
  // without a job, also when it has no job.
  if (jobs.length === 0 && !store.awaitsLeftoverLook(null)) { out('jobs.json holds no version 1 jobs: nothing to move\n'); return true }
  const me = config.handle ?? 'user'
  const now = Date.now()
  const spaces = [{ token: config.token, name: config.mainName ?? 'Main', main: true }, ...(config.spaces ?? []).map((s) => ({ token: s.token, name: s.name ?? 'Space', main: false }))]
  const seen = new Set<string | null>()
  out(`Dry run on ${home.dir} as ${me}: nothing is written.\n\n`)
  for (const space of spaces) {
    const info = home.brainOf(space.token)
    const key = space.main ? null : info.brainId
    if (!space.main && !key) { out(`# ${space.name}\n\nIts brain is not in this home's control.db: skipped.\n\n`); continue }
    seen.add(key)
    const mine = jobs.filter((j) => (j.spaceId ?? null) === key)
    const first = store.awaitsLeftoverLook(key)
    if (mine.length === 0 && !(space.main && first)) continue
    if (!info.brainFile || !fs.existsSync(info.brainFile)) { out(`# ${space.name}\n\nIts brain file is not on this machine: ${mine.length > 0 ? `its ${mine.length} job(s) cannot be planned here` : 'it cannot be looked through here'}.\n\n`); continue }
    // Whose cockpit fires a task depends on whether its space is shared, and only the brain server says that. The
    // main space is this home's own brain, local by construction; any other space is not planned here, not guessed.
    if (!space.main) {
      out(`# ${space.name}\n\nWhether this space is shared only its brain server says, and the dry run does not ask it: its ${mine.length} job(s) are not planned here. The host plans them at its start, once the brain server has answered: in a local space every task's jobs move; in a shared one a job on another member's task is not moved, and the report says how its owner brings it back.\n\n`)
      continue
    }
    const db = new Database(info.brainFile, { readonly: true, fileMustExist: true })
    try {
      const tasks: Record<string, JobMigrationTask | null> = {}
      for (const id of new Set(mine.flatMap((j) => (j.taskId ? [j.taskId] : [])))) tasks[id] = taskFrom(db, id)
      // As the host's first pass of a space: the schedules the old mirror left on tasks without a job are named too.
      const plan = planJobMigration({
        jobs, runs: pending?.runs ?? {}, keys: pending?.keys ?? {}, space: { key, name: space.name, shared: false }, tasks, me, now, routineTaskOf: routineTaskOfJob(me),
        ...(first ? { scheduled: scheduledFrom(db), records: new Set(store.list().map((record) => record.id)) } : {}),
      })
      // A space that has no job and nothing left over has nothing to report, as in the host's pass.
      if (mine.length > 0 || (plan.leftovers?.length ?? 0) > 0) out(`${jobMigrationReport(plan, { space: space.name, at: new Date(now).toISOString(), dryRun: true })}\n`)
    } finally {
      db.close()
    }
  }
  const homeless = jobs.filter((j) => !seen.has(j.spaceId ?? null))
  if (homeless.length > 0) out(`${homeless.length} job(s) belong to a space this home no longer has: they stay as they are.\n`)
  return true
}
