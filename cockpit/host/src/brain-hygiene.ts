import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { readCockpitConfig, writeCockpitConfig, type HygieneState } from './config.js'
import type { BrainSpace, BrainSpaces } from './brain-space.js'
import type { SpawnQueue } from './spawn-queue.js'

/**
 * Brain hygiene, opened by the cockpit: the brain's hygiene check (GET
 * /hygiene, core hygiene.ts) says which engrams no longer fit what the current
 * version expects (kind migration) and which are due for review (kind review).
 * When it is time, the host opens a session with the brain-hygiene skill in a
 * cockpit-made folder project ("Brain hygiene", one per space), its prompt
 * carrying the checks with their findings — the skill works from there.
 *
 * When it is time, per brain:
 *   - after an update: a migration check has findings and no hygiene session
 *     was opened for this cockpit version yet;
 *   - reviews: at least REVIEW_THRESHOLD engrams are due and the last review
 *     round is REVIEW_INTERVAL_DAYS or longer ago.
 * Checked at start and then every CHECK_INTERVAL_MS. Settings › Brain can also
 * start it for one space now, regardless of the thresholds (runNow). The state
 * (config.hygiene) is written when a tab claims the session, so a request a
 * restart dropped is asked again; one request per space is pending at a time.
 */

export const HYGIENE_DIR = path.join(COCKPIT_HOME, 'brain-hygiene')
export const REVIEW_THRESHOLD = 5
export const REVIEW_INTERVAL_DAYS = 7
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Findings listed per check in the prompt; the rest is counted. */
const PROMPT_FINDINGS_PER_CHECK = 50

export interface HygieneFinding { id: string; type: string; scope: string; title: string | null; reason: string }
export interface HygieneCheckResult {
  id: string
  kind: 'migration' | 'review'
  since: string
  what: string
  how: string
  findings: HygieneFinding[]
}
export interface HygieneReport { checks: HygieneCheckResult[]; total: number }

export interface HygieneDue {
  /** Why the session opens, one clause each. */
  reasons: string[]
  /** The checks with findings, for the prompt. */
  checks: HygieneCheckResult[]
  /** Write-back when the session is claimed. */
  next: HygieneState
}

/** Whether a hygiene session is due for one brain — pure, for the tests. */
export function hygieneDue(report: HygieneReport, state: HygieneState, version: string, now: Date): HygieneDue | null {
  const withFindings = report.checks.filter((c) => c.findings.length > 0)
  const migration = withFindings.filter((c) => c.kind === 'migration')
  const reviews = withFindings.filter((c) => c.kind === 'review').reduce((n, c) => n + c.findings.length, 0)

  const reasons: string[] = []
  if (migration.length > 0 && state.version !== version) {
    reasons.push(`after the update to v${version}, engrams do not fit a requirement of the current version`)
  }
  const lastReview = state.reviewAt ? Date.parse(state.reviewAt) : NaN
  const reviewRest = Number.isNaN(lastReview) || now.getTime() - lastReview >= REVIEW_INTERVAL_DAYS * 86_400_000
  if (reviews >= REVIEW_THRESHOLD && reviewRest) reasons.push(`${reviews} engrams are due for review`)
  if (reasons.length === 0) return null

  // One session covers everything found; both clocks restart with it.
  return { reasons, checks: withFindings, next: { version, reviewAt: now.toISOString() } }
}

/** The first message of the session: the skill, why it opened, and the findings. */
export function hygienePrompt(due: HygieneDue): string {
  const lines = [
    'Use the brain-hygiene skill.',
    '',
    `The cockpit opened this session: ${due.reasons.join('; ')}. The brain's hygiene check found:`,
  ]
  for (const c of due.checks) {
    lines.push('', `## ${c.id} (${c.kind}, since v${c.since}) — ${c.findings.length} finding${c.findings.length === 1 ? '' : 's'}`)
    lines.push(`What: ${c.what}`, `How: ${c.how}`)
    for (const f of c.findings.slice(0, PROMPT_FINDINGS_PER_CHECK)) {
      lines.push(`- ${f.id} · ${f.type} · ${f.scope} · ${f.title ?? '(untitled)'} — ${f.reason}`)
    }
    const rest = c.findings.length - PROMPT_FINDINGS_PER_CHECK
    if (rest > 0) lines.push(`- … and ${rest} more (listed again in the next hygiene session).`)
  }
  return lines.join('\n')
}

/** The space's "Brain hygiene" folder project (created on first use). */
export function ensureHygieneProject(space: BrainSpace): string {
  const dir = space.main ? HYGIENE_DIR : path.join(HYGIENE_DIR, space.id)
  fs.mkdirSync(dir, { recursive: true })
  return space.registry.create(dir, 'Brain hygiene').project.projectId
}

export interface BrainHygieneDeps {
  spaces: BrainSpaces
  spawns: SpawnQueue
  /** The cockpit version (ABOUT.version). */
  version: string
  /** Whether the default agent CLI is installed and signed in; no session before. */
  isReady: () => Promise<boolean>
  /** Fetch a space's hygiene report; default GET <url>/hygiene with its token. */
  fetchReport?: (space: BrainSpace) => Promise<HygieneReport>
  now?: () => Date
  log?: (line: string) => void
}

async function fetchHygiene(space: BrainSpace): Promise<HygieneReport> {
  const res = await fetch(`${space.url}/hygiene`, { headers: { Authorization: `Bearer ${space.token}` } })
  if (!res.ok) throw new Error(`GET /hygiene → ${res.status}`)
  return (await res.json()) as HygieneReport
}

export type RunNowResult =
  | { started: true; findings: number }
  | { started: false; reason: 'not-ready' | 'pending' | 'clean' }

/**
 * The hygiene trigger of this host: one pending session per space at a time,
 * the state written when a tab claims it. The scheduler checks every space
 * against the thresholds; Settings › Brain runs one space now.
 */
export class BrainHygiene {
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: BrainHygieneDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /**
   * Check every space once (returns when done): open a session where it is
   * due. Nothing before the agent CLI is ready or while onboarding is pending;
   * a space that fails is logged and skipped.
   */
  async check(): Promise<void> {
    if (!(await this.deps.isReady().catch(() => false))) return
    const config = await readCockpitConfig()
    if (!config || config.onboarding === 'pending') return
    const now = this.now()
    for (const space of this.deps.spaces.list()) {
      if (this.pending.has(space.id)) continue
      try {
        const report = await (this.deps.fetchReport ?? fetchHygiene)(space)
        const due = hygieneDue(report, config.hygiene?.[space.id] ?? {}, this.deps.version, now)
        if (due) this.open(space, due)
      } catch (err) {
        this.deps.log?.(`brain hygiene: check of ${space.name} failed — ${(err as Error).message}`)
      }
    }
  }

  /**
   * Settings › Brain: open a session for `space` now, with every check that has
   * findings — no thresholds. Errors of the check reach the caller.
   */
  async runNow(space: BrainSpace): Promise<RunNowResult> {
    if (!(await this.deps.isReady().catch(() => false))) return { started: false, reason: 'not-ready' }
    if (this.pending.has(space.id)) return { started: false, reason: 'pending' }
    const report = await (this.deps.fetchReport ?? fetchHygiene)(space)
    const checks = report.checks.filter((c) => c.findings.length > 0)
    if (checks.length === 0) return { started: false, reason: 'clean' }
    const now = this.now()
    this.open(space, {
      reasons: ['the user started it from Settings › Brain'],
      checks,
      next: { version: this.deps.version, reviewAt: now.toISOString() },
    })
    return { started: true, findings: checks.reduce((n, c) => n + c.findings.length, 0) }
  }

  /** Check now and every CHECK_INTERVAL_MS. */
  schedule(): void {
    void this.check()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private open(space: BrainSpace, due: HygieneDue): void {
    const request = this.deps.spawns.add({
      projectId: ensureHygieneProject(space),
      prompt: hygienePrompt(due),
      title: 'Brain hygiene',
      fromSessionId: null,
      ...(space.main ? {} : { spaceId: space.id }),
    })
    this.pending.add(space.id)
    this.deps.log?.(`brain hygiene: session queued for ${space.name} (${due.reasons.join('; ')})`)
    const onClaimed = (id: string) => {
      if (id !== request.id) return
      this.deps.spawns.off('claimed', onClaimed)
      this.pending.delete(space.id)
      void recordHygiene(space.id, due.next)
    }
    this.deps.spawns.on('claimed', onClaimed)
  }
}

async function recordHygiene(brainId: string, next: HygieneState): Promise<void> {
  const config = await readCockpitConfig()
  if (!config) return
  await writeCockpitConfig({ ...config, hygiene: { ...config.hygiene, [brainId]: next } })
}
