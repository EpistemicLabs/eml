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
 * Checked at start and then every CHECK_INTERVAL_MS. The state (config.hygiene)
 * is written when a tab claims the session, so a request a restart dropped is
 * asked again; one request per space is pending at a time.
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

/**
 * Check every space once now (returns when done) — the scheduler below calls
 * it. A space that fails is logged and skipped.
 */
export async function checkBrainHygiene(deps: BrainHygieneDeps, pending: Set<string>): Promise<void> {
  if (!(await deps.isReady().catch(() => false))) return
  const config = await readCockpitConfig()
  if (!config || config.onboarding === 'pending') return
  const now = (deps.now ?? (() => new Date()))()
  for (const space of deps.spaces.list()) {
    if (pending.has(space.id)) continue
    try {
      const report = await (deps.fetchReport ?? fetchHygiene)(space)
      const due = hygieneDue(report, config.hygiene?.[space.id] ?? {}, deps.version, now)
      if (!due) continue
      const request = deps.spawns.add({
        projectId: ensureHygieneProject(space),
        prompt: hygienePrompt(due),
        title: 'Brain hygiene',
        fromSessionId: null,
        ...(space.main ? {} : { spaceId: space.id }),
      })
      pending.add(space.id)
      deps.log?.(`brain hygiene: session queued for ${space.name} (${due.reasons.join('; ')})`)
      const onClaimed = (id: string) => {
        if (id !== request.id) return
        deps.spawns.off('claimed', onClaimed)
        pending.delete(space.id)
        void recordHygiene(space.id, due.next)
      }
      deps.spawns.on('claimed', onClaimed)
    } catch (err) {
      deps.log?.(`brain hygiene: check of ${space.name} failed — ${(err as Error).message}`)
    }
  }
}

async function recordHygiene(brainId: string, next: HygieneState): Promise<void> {
  const config = await readCockpitConfig()
  if (!config) return
  await writeCockpitConfig({ ...config, hygiene: { ...config.hygiene, [brainId]: next } })
}

/** Check now and every CHECK_INTERVAL_MS. Returns a stop function. */
export function scheduleBrainHygiene(deps: BrainHygieneDeps): () => void {
  const pending = new Set<string>()
  void checkBrainHygiene(deps, pending)
  const timer = setInterval(() => void checkBrainHygiene(deps, pending), CHECK_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
