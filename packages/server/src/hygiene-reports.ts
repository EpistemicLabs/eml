import * as fs from 'fs'
import * as path from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION, type ConflictSweepState, type HygieneReport } from '@engramprotocol/core'
import type { HygieneSweepAnswer } from './reads'

// --- The hygiene reports (GET /hygiene) -------------------------------------------------
//
// A hygiene sweep reads the whole brain, and its conflict scan runs one search
// per engram: seconds on a brain of a few thousand engrams. The cockpit asks for
// the report whenever a page loads, so the server keeps one report per brain
// and answers from it:
//
// - The report is kept in memory and in a file next to the brains
//   (<data-dir>/cache/hygiene/<brain id>.json), so a restart starts from it.
// - A request gets the kept report at once. A report is taken as current while
//   the brain's log head is the one its sweep read and it is younger than
//   STALE_AFTER_MS: a review falls due by the clock, without a write. Past
//   that, or once the head moved and the report is older than REFRESH_AFTER_MS,
//   a new sweep starts in the background (one per brain at a time); the next
//   request gets it.
// - A brain without a report makes the request wait for its first sweep, and so
//   does `fresh` when the report is not current: the cockpit starts a hygiene
//   session from a report of the brain as it is now. A sweep that was already
//   under way may have read the brain before the last write; when its head is
//   not the brain's, the request waits for one more.
// - The first sweep reads everything. The ones after it start from the last
//   (core hygieneSweep: the engrams new or changed since and those of the known
//   pairs), and every FULL_AFTER_MS one reads everything again. A log head that
//   went back is another brain under the id (a restore): nothing of the kept
//   report holds, and the request waits for a sweep over everything.
// - A discarded brain's report goes with it (forget), also when a sweep of it
//   is still under way.
//
// The sweeps run where `sweep` runs them — the server passes its read pool, so
// the request thread stays free whatever a sweep costs.

/** A kept report is taken as current for this long, whatever was written since. */
export const REFRESH_AFTER_MS = 10 * 60_000
/** A kept report is taken as current for this long when nothing was written since: a review falls due by the clock. */
export const STALE_AFTER_MS = 60 * 60_000
/** After this long the next sweep reads the whole brain again. */
export const FULL_AFTER_MS = 24 * 60 * 60_000

/** A report as it is kept: what the sweep saw, and what the next one starts from. */
export interface KeptHygiene {
  /** The server version that swept: another version may check other things, and sweeps again. */
  version: string
  /** The brain schema the checks ran against. */
  schema: number
  /** The log head the sweep read before it started. */
  seq: number
  /** When the sweep started (ISO). */
  computed_at: string
  /** When the last sweep over the whole brain started (ISO). */
  full_at: string
  report: HygieneReport
  conflicts: ConflictSweepState
}

/** The brain a report is asked for: its id, and its log head now. */
export interface HygieneBrain {
  id: string
  head(): number
}

export interface HygieneReportsOptions {
  /** Where the reports are kept (<data-dir>/cache/hygiene). */
  dir: string
  /** The server version (KeptHygiene.version). */
  version: string
  now?: () => number
  log?: (line: string) => void
}

/** One sweep of a brain: over everything, or from the state of the sweep before. */
export type Sweep = (previous?: ConflictSweepState) => Promise<HygieneSweepAnswer>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `value` as a kept report of this version and schema, or null: a file from another build, or one that is not a report. */
export function keptHygiene(value: unknown, version: string): KeptHygiene | null {
  if (!isRecord(value) || value.version !== version || value.schema !== CURRENT_BRAIN_SCHEMA_VERSION) return null
  const { seq, computed_at, full_at, report, conflicts } = value
  if (typeof seq !== 'number' || typeof computed_at !== 'string' || typeof full_at !== 'string') return null
  if (!Number.isFinite(Date.parse(computed_at)) || !Number.isFinite(Date.parse(full_at))) return null
  if (!isRecord(report) || !Array.isArray(report.checks) || typeof report.total !== 'number') return null
  if (!isRecord(conflicts) || !isRecord(conflicts.revs) || !Object.values(conflicts.revs).every((rev) => typeof rev === 'number')) return null
  if (!Array.isArray(conflicts.ids) || !conflicts.ids.every((id) => typeof id === 'string')) return null
  return value as unknown as KeptHygiene
}

export class HygieneReports {
  private readonly dir: string
  private readonly version: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly kept = new Map<string, KeptHygiene>()
  private readonly sweeping = new Map<string, Promise<KeptHygiene>>()

  constructor(opts: HygieneReportsOptions) {
    this.dir = opts.dir
    this.version = opts.version
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  /**
   * The brain's report: the kept one while it is current (see above), else the
   * kept one with a sweep started for the next request, or — for a brain without
   * a report, one whose log went back, and with `fresh` — the one of a sweep
   * this call waits for.
   */
  async get(brain: HygieneBrain, sweep: Sweep, opts: { fresh?: boolean } = {}): Promise<KeptHygiene> {
    const kept = this.kept.get(brain.id) ?? this.read(brain.id)
    if (!kept) return this.current(brain, sweep, false)
    const head = brain.head()
    const age = this.now() - Date.parse(kept.computed_at)
    if (head === kept.seq && age < STALE_AFTER_MS) return kept
    // A log that went back is another brain under this id (a restore): nothing of the kept report holds.
    if (head < kept.seq) {
      this.kept.delete(brain.id)
      return this.current(brain, sweep, true)
    }
    if (opts.fresh) return this.current(brain, sweep, false)
    if (age >= (head === kept.seq ? STALE_AFTER_MS : REFRESH_AFTER_MS)) {
      this.sweep(brain.id, sweep, kept).catch((err) => this.log(`[hygiene] the sweep of ${brain.id} failed: ${(err as Error).message}`))
    }
    return kept
  }

  /** Drop a brain's report (the brain is discarded): what is kept, its file, and what a sweep under way would keep. */
  forget(brainId: string): void {
    this.kept.delete(brainId)
    this.sweeping.delete(brainId)
    const file = this.file(brainId)
    if (file) fs.rmSync(file, { force: true })
  }

  /**
   * A report of the brain as it is now, waited for. A sweep under way counts
   * when it read the brain at its present head — unless `replaced`: it started
   * from another brain's state. Else one more sweep runs, and its report is the
   * answer whatever was written meanwhile (one extra round, not a loop).
   */
  private async current(brain: HygieneBrain, sweep: Sweep, replaced: boolean): Promise<KeptHygiene> {
    const running = this.sweeping.get(brain.id)
    if (running) {
      const done = await running.catch(() => null)
      if (done && !replaced && done.seq === brain.head()) return done
    }
    return this.sweep(brain.id, sweep, replaced ? null : this.kept.get(brain.id) ?? null)
  }

  /** One sweep per brain at a time: a second caller gets the one under way. */
  private sweep(brainId: string, sweep: Sweep, kept: KeptHygiene | null): Promise<KeptHygiene> {
    const running = this.sweeping.get(brainId)
    if (running) return running
    // From the last sweep, unless there is none to start from or it is time to read everything again.
    const full = !kept || this.now() - Date.parse(kept.full_at) >= FULL_AFTER_MS
    const run: Promise<KeptHygiene> = sweep(full ? undefined : kept.conflicts).then((swept): KeptHygiene => {
      const next: KeptHygiene = {
        version: this.version,
        schema: swept.report.schema,
        seq: swept.seq,
        computed_at: swept.computed_at,
        full_at: full ? swept.computed_at : kept.full_at,
        report: swept.report,
        conflicts: swept.conflicts,
      }
      // Forgotten while it ran (the brain is discarded): its caller gets the report, nothing of it is kept.
      if (this.sweeping.get(brainId) !== run) return next
      this.kept.set(brainId, next)
      this.write(brainId, next)
      return next
    }).finally(() => { if (this.sweeping.get(brainId) === run) this.sweeping.delete(brainId) })
    this.sweeping.set(brainId, run)
    return run
  }

  /** The report's file; null for an id that is no file name. */
  private file(brainId: string): string | null {
    return /^[A-Za-z0-9_-]+$/.test(brainId) ? path.join(this.dir, `${brainId}.json`) : null
  }

  private read(brainId: string): KeptHygiene | null {
    const file = this.file(brainId)
    if (!file) return null
    let kept: KeptHygiene | null = null
    try {
      kept = keptHygiene(JSON.parse(fs.readFileSync(file, 'utf-8')), this.version)
    } catch {
      // no file yet, or not JSON: as if there were none — the next sweep writes it
    }
    if (kept) this.kept.set(brainId, kept)
    return kept
  }

  /** Written to a temporary file and renamed, so a reader never sees half a report. A failure costs only the next start a sweep. */
  private write(brainId: string, kept: KeptHygiene): void {
    const file = this.file(brainId)
    if (!file) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(kept))
      fs.renameSync(tmp, file)
    } catch (err) {
      this.log(`[hygiene] the report of ${brainId} could not be kept: ${(err as Error).message}`)
    }
  }
}
