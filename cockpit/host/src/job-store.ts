import * as fs from 'node:fs'
import * as path from 'node:path'
import { JOBS_FILE } from './paths.js'
import { JOB_LIMITS, type Job, type JobRun } from './domain/job.js'

/**
 * jobs.json: the jobs of every space and the last runs of each (domain/job.ts),
 * plus the time zone a job reads its times in when it names none. One file,
 * owner-only, rewritten whole through a temporary file on every change, like
 * the session ledger: small, and a crash leaves either the old or the new state.
 */

interface JobsFile {
  version: 1
  /** The user's time zone (taken from their browser); null until a page told the host. */
  timeZone: string | null
  jobs: Record<string, Job>
  runs: Record<string, JobRun[]>
  /** Per job, the channel event keys that woke it and when: the same event never wakes it twice. */
  keys: Record<string, Record<string, string>>
}

const empty = (): JobsFile => ({ version: 1, timeZone: null, jobs: {}, runs: {}, keys: {} })

function load(file: string): JobsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JobsFile>
    if (parsed.version !== 1) return empty()
    return {
      version: 1,
      timeZone: typeof parsed.timeZone === 'string' ? parsed.timeZone : null,
      jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
      runs: parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {},
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
    }
  } catch {
    return empty()
  }
}

export class JobStore {
  private data: JobsFile

  constructor(private file = JOBS_FILE) {
    this.data = load(file)
  }

  timeZone(): string | null {
    return this.data.timeZone
  }

  setTimeZone(zone: string): void {
    if (this.data.timeZone === zone) return
    this.data.timeZone = zone
    this.persist()
  }

  list(): Job[] {
    return Object.values(this.data.jobs)
  }

  get(id: string): Job | undefined {
    return this.data.jobs[id]
  }

  put(job: Job): void {
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.chmodSync(this.file, 0o600)
    } catch (err) {
      process.stderr.write(`[jobs] persist failed: ${(err as Error).message}\n`)
    }
  }
}
