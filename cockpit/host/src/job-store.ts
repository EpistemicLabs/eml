import * as fs from 'node:fs'
import * as path from 'node:path'
import { JOBS_FILE } from './paths.js'
import { JOB_LIMITS, type Job, type JobRun } from './domain/job.js'
import type { JobV1 } from './domain/job-v1.js'

/**
 * jobs.json, version 2: the local record of every scheduled task and the last runs of each (domain/job.ts), plus
 * the time zone a time is read in when it names none. One file, owner-only, rewritten whole through a temporary
 * file on every change, like the session ledger: small, and a crash leaves either the old or the new state.
 *
 * A version 1 file (jobs with their own schedule, before brain schema 24) is not dropped: its jobs, runs and keys
 * are held under `v1` until the migration (application/job-migration.ts) has moved them onto their tasks, space by
 * space, and they survive every rewrite until then. The version 1 file itself is copied next to it
 * (<file>.v1-backup) before the first rewrite. Which job became which record is held under `renames` until the
 * channel bridge has taken the new id.
 */

/** What a version 1 file held, as far as it is not migrated yet. */
export interface JobsV1Data {
  jobs: Record<string, JobV1>
  runs: Record<string, JobRun[]>
  /** Per job, the channel event keys that woke it and when. */
  keys: Record<string, Record<string, string>>
}

interface JobsFile<J> {
  version: 2
  /** The user's time zone (Settings › Preferences; a browser fills it in once); null until a page told the host. */
  timeZone: string | null
  jobs: Record<string, J>
  runs: Record<string, JobRun[]>
  /** Per record, the channel event keys that woke it and when: the same event never wakes it twice. */
  keys: Record<string, Record<string, string>>
  /** The jobs of a version 1 file that are not on their tasks yet. */
  v1?: JobsV1Data
  /**
   * Version 1 job id → the id of the record it became (its task's), for every job that moved to a record: kept until
   * the channel bridge has confirmed the new id, since its own database still files messages, wakes and drafts under
   * the old one (application/job-migration.ts). It outlives `v1`.
   */
  renames?: Record<string, string>
}

/** One task's part of the version 1 migration, written in one go. */
export interface V1Step<J> {
  /** The version 1 jobs it settles: they leave `v1` with their runs and keys. */
  jobIds: string[]
  /** The task's record, or null when it gets none. */
  record: J | null
  /** The runs that go on under the record's id. */
  runs?: JobRun[]
  /** The channel event keys that go on under the record's id. */
  keys?: Record<string, string>
  /** Runs kept for history under the id of the job they belonged to. */
  history?: Record<string, JobRun[]>
  /** Job id → record id of the jobs that moved to the record: remembered until the channel bridge has the new id. */
  renames?: Record<string, string>
}

const record = <T>(value: unknown): Record<string, T> => (value && typeof value === 'object' ? value as Record<string, T> : {})

function empty<J>(): JobsFile<J> {
  return { version: 2, timeZone: null, jobs: {}, runs: {}, keys: {} }
}

/** The file as it is read, and whether what is on disk is still a version 1 file. */
function load<J>(file: string | null): { data: JobsFile<J>; v1OnDisk: boolean } {
  if (!file) return { data: empty(), v1OnDisk: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const timeZone = typeof parsed.timeZone === 'string' ? parsed.timeZone : null
    if (parsed.version === 1) {
      const v1: JobsV1Data = { jobs: record(parsed.jobs), runs: record(parsed.runs), keys: record(parsed.keys) }
      return { data: { ...empty<J>(), timeZone, ...(Object.keys(v1.jobs).length + Object.keys(v1.runs).length > 0 ? { v1 } : {}) }, v1OnDisk: true }
    }
    if (parsed.version !== 2) return { data: empty(), v1OnDisk: false }
    const old = parsed.v1 as Partial<JobsV1Data> | undefined
    return {
      data: {
        version: 2, timeZone, jobs: record(parsed.jobs), runs: record(parsed.runs), keys: record(parsed.keys),
        ...(old && typeof old === 'object' ? { v1: { jobs: record(old.jobs), runs: record(old.runs), keys: record(old.keys) } } : {}),
        ...(Object.keys(record(parsed.renames)).length > 0 ? { renames: record<string>(parsed.renames) } : {}),
      },
      v1OnDisk: false,
    }
  } catch {
    return { data: empty(), v1OnDisk: false }
  }
}

/** `J` is the record's shape: the task's local record. `file` null: nothing is read or written (a store in memory, for tests). */
export class JobStore<J extends { id: string; runCount: number } = Job> {
  private data: JobsFile<J>
  private v1OnDisk: boolean

  constructor(private file: string | null = JOBS_FILE) {
    const loaded = load<J>(file)
    this.data = loaded.data
    this.v1OnDisk = loaded.v1OnDisk
  }

  /** The jobs of a version 1 file that are not migrated yet, with their runs and keys; null when none is left. */
  pendingV1(): JobsV1Data | null {
    return this.data.v1 ?? null
  }

  /** Write one task's part of the version 1 migration: its jobs leave `v1`, its record and runs are in. */
  migrateV1(step: V1Step<J>): void {
    const v1 = this.data.v1
    for (const id of step.jobIds) {
      delete v1?.jobs[id]
      delete v1?.runs[id]
      delete v1?.keys[id]
    }
    if (step.record) {
      const id = step.record.id
      this.data.jobs[id] = step.record
      if (step.runs?.length) this.data.runs[id] = [...(this.data.runs[id] ?? []), ...step.runs]
      if (step.keys && Object.keys(step.keys).length) this.data.keys[id] = { ...this.data.keys[id], ...step.keys }
    }
    for (const [id, runs] of Object.entries(step.history ?? {})) if (runs.length) this.data.runs[id] = runs
    if (step.renames && Object.keys(step.renames).length > 0) this.data.renames = { ...this.data.renames, ...step.renames }
    if (v1 && Object.keys(v1.jobs).length === 0) {
      // Runs whose job was gone already stay as history.
      for (const [id, runs] of Object.entries(v1.runs)) if (runs.length && !this.data.runs[id]) this.data.runs[id] = runs
      delete this.data.v1
    }
    this.persist()
  }

  /** The jobs that became a record and whose new id the channel bridge has not confirmed yet: old id → record id. */
  pendingRenames(): Record<string, string> {
    return { ...this.data.renames }
  }

  /** The channel bridge has the new id of this job: its mapping is forgotten. */
  renameConfirmed(jobId: string): void {
    if (!this.data.renames || !(jobId in this.data.renames)) return
    delete this.data.renames[jobId]
    if (Object.keys(this.data.renames).length === 0) delete this.data.renames
    this.persist()
  }

  timeZone(): string | null {
    return this.data.timeZone
  }

  setTimeZone(zone: string): void {
    if (this.data.timeZone === zone) return
    this.data.timeZone = zone
    this.persist()
  }

  list(): J[] {
    return Object.values(this.data.jobs)
  }

  get(id: string): J | undefined {
    return this.data.jobs[id]
  }

  put(job: J): void {
    this.data.jobs[job.id] = job
    this.persist()
  }

  remove(id: string): boolean {
    if (!this.data.jobs[id]) return false
    delete this.data.jobs[id]
    delete this.data.runs[id]
    delete this.data.keys[id]
    this.persist()
    return true
  }

  /** Oldest first. */
  runs(jobId: string): JobRun[] {
    return this.data.runs[jobId] ?? []
  }

  /** Every run of every job, oldest first per job. */
  allRuns(): JobRun[] {
    return Object.values(this.data.runs).flat()
  }

  addRun(run: JobRun): void {
    const runs = this.data.runs[run.jobId] ?? []
    runs.push(run)
    // The oldest finished ones go first; open runs always stay.
    while (runs.length > JOB_LIMITS.history) {
      const index = runs.findIndex((r) => r.status !== 'waiting' && r.status !== 'starting' && r.status !== 'started')
      if (index < 0) break
      runs.splice(index, 1)
    }
    this.data.runs[run.jobId] = runs
    this.persist()
  }

  updateRun(run: JobRun): void {
    const runs = this.data.runs[run.jobId]
    const index = runs?.findIndex((r) => r.id === run.id) ?? -1
    if (index < 0) return
    runs[index] = run
    this.persist()
  }

  /** A run that never happened after all (a wake the bridge will retry); its number is given back. */
  dropRun(run: JobRun): void {
    const runs = this.data.runs[run.jobId]
    const index = runs?.findIndex((r) => r.id === run.id) ?? -1
    if (index < 0) return
    runs.splice(index, 1)
    const job = this.data.jobs[run.jobId]
    if (job && job.runCount === run.number) this.data.jobs[run.jobId] = { ...job, runCount: job.runCount - 1 }
    this.persist()
  }

  /** The key woke the job at or after `since`. */
  seenKey(jobId: string, key: string, since: number): boolean {
    const at = this.data.keys[jobId]?.[key]
    return at !== undefined && Date.parse(at) >= since
  }

  /** Remember a key; keys older than `forgetBefore` go. */
  rememberKey(jobId: string, key: string, at: string, forgetBefore: number): void {
    const keys = this.data.keys[jobId] ?? {}
    for (const [old, when] of Object.entries(keys)) if (Date.parse(when) < forgetBefore) delete keys[old]
    keys[key] = at
    this.data.keys[jobId] = keys
    this.persist()
  }

  private persist(): void {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      // The version 1 file is kept as it was before it is rewritten for the first time.
      if (this.v1OnDisk) {
        const backup = `${this.file}.v1-backup`
        if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup)
        fs.chmodSync(backup, 0o600)
        this.v1OnDisk = false
      }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.chmodSync(this.file, 0o600)
    } catch (err) {
      process.stderr.write(`[jobs] persist failed: ${(err as Error).message}\n`)
    }
  }
}
