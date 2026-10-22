import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { readCockpitConfig, updateCockpitConfig, type HygieneState } from './config.js'
import type { BrainSpace } from './brain-space.js'
import type { SpawnQueue } from './spawn-queue.js'

/**
 * Brain hygiene, offered by the cockpit (spec note brain-hygiene-spec): the
 * brain's hygiene check (GET /hygiene, core hygiene.ts) says which engrams no
 * longer fit what the current brain schema expects (kind migration) and which
 * are due for review (kind review). The open space's banner offers a session
 * (GET /api/brain-hygiene); Start writes the offered checks to findings.json in
 * the space's "Brain hygiene" folder project and queues a session with the
 * brain-hygiene skill there, which works from that file.
 *
 * Offered once per space:
 *   - migration: once per brain schema, when a migration check has findings;
 *   - review: once a week, when any review is due.
 * Start counts as offered (config.hygiene, per brain id); until then the
 * banner stays. The host opening the session by itself is a later step.
 */

export const HYGIENE_DIR = path.join(COCKPIT_HOME, 'brain-hygiene')
export const FINDINGS_FILE = 'findings.json'
export const REVIEW_INTERVAL_DAYS = 7

export interface HygieneFinding { id: string; type: string; scope: string; title: string | null; reason: string }
export interface HygieneCheckResult {
  id: string
  kind: 'migration' | 'review'
  /** Who decides a finding: agent (writes the clear cases) or user (needs their word). */
  decides: 'agent' | 'user'
  since_schema?: number
  what: string
  how: string
  findings: HygieneFinding[]
}
export interface HygieneReport { schema: number; checks: HygieneCheckResult[]; total: number }

export interface HygieneOffer {
  /** The brain schema the report ran against. */
  schema: number
  /** Why it is offered, one clause each, for the banner. */
  reasons: string[]
  /** The checks with findings the session gets. */
  checks: HygieneCheckResult[]
  /** Written when the offer is started. */
  next: HygieneState
}

const count = (checks: HygieneCheckResult[]) => checks.reduce((n, c) => n + c.findings.length, 0)

/** Whether brain hygiene is offered for one brain — pure, for the tests. */
export function hygieneOffer(report: HygieneReport, state: HygieneState, now: Date): HygieneOffer | null {
  const withFindings = report.checks.filter((c) => c.findings.length > 0)
  const reasons: string[] = []
  const checks: HygieneCheckResult[] = []
  const next: HygieneState = { ...state }

  const migration = withFindings.filter((c) => c.kind === 'migration')
  if (migration.length > 0 && (state.offeredSchema ?? 0) < report.schema) {
    const n = count(migration)
    reasons.push(`the new brain schema v${report.schema} changed the engram format — ${n} ${n === 1 ? 'entry needs' : 'entries need'} rewriting`)
    checks.push(...migration)
    next.offeredSchema = report.schema
  }

  const review = withFindings.filter((c) => c.kind === 'review')
  const last = state.reviewsOfferedAt ? Date.parse(state.reviewsOfferedAt) : NaN
  const rested = Number.isNaN(last) || now.getTime() - last >= REVIEW_INTERVAL_DAYS * 86_400_000
  if (review.length > 0 && rested) {
    const n = count(review)
    reasons.push(`${n} ${n === 1 ? 'review is' : 'reviews are'} due`)
    checks.push(...review)
    next.reviewsOfferedAt = now.toISOString()
  }

  return reasons.length ? { schema: report.schema, reasons, checks, next } : null
}

/** The session's first message: the skill, the file, the count per check. */
export function hygienePrompt(offer: HygieneOffer): string {
  const counts = offer.checks.map((c) => `${c.id} ${c.findings.length}`).join(', ')
  return `Use the brain-hygiene skill. The cockpit wrote this brain's hygiene findings to ${FINDINGS_FILE} in this folder: ${counts}.`
}

/**
 * The space's "Brain hygiene" folder: one per brain, side by side, so a
 * session in one space's folder cannot read another brain's findings.
 */
export function hygieneDir(space: BrainSpace): string {
  return path.join(HYGIENE_DIR, space.id)
}

export interface BrainHygieneDeps {
  spawns: SpawnQueue
  /** Whether the default agent CLI is installed and signed in; nothing is offered before. */
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

export type HygieneBannerView = { space: string; reasons: string[]; findings: number } | null
export type HygieneActResult = { ok: true; findings: number } | { ok: false; reason: 'nothing-due' | 'pending' }

/**
 * The offer of this host, per space. One start at a time per space: a second
 * click while the first is under way gets `pending`.
 */
export class BrainHygiene {
  private readonly busy = new Set<string>()

  constructor(private readonly deps: BrainHygieneDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** The offer for `space` now, or null: not before the agent CLI is ready, not during onboarding. */
  private async offer(space: BrainSpace): Promise<HygieneOffer | null> {
    if (!(await this.deps.isReady().catch(() => false))) return null
    const config = await readCockpitConfig()
    if (!config || config.onboarding === 'pending') return null
    const report = await (this.deps.fetchReport ?? fetchHygiene)(space)
    return hygieneOffer(report, config.hygiene?.[space.id] ?? {}, this.now())
  }

  /** GET /api/brain-hygiene: what the banner shows for `space`. */
  async view(space: BrainSpace): Promise<HygieneBannerView> {
    const offer = await this.offer(space)
    return offer && { space: space.name, reasons: offer.reasons, findings: count(offer.checks) }
  }

  /**
   * Start: findings.json into the space's folder, the offer recorded, then the
   * session queued there (a failed config write queues nothing).
   */
  async start(space: BrainSpace): Promise<HygieneActResult> {
    return this.once(space, (offer) => {
      const dir = hygieneDir(space)
      fs.mkdirSync(dir, { recursive: true })
      const file = {
        space: space.name,
        schema: offer.schema,
        generated_at: this.now().toISOString(),
        checks: offer.checks,
      }
      const target = path.join(dir, FINDINGS_FILE)
      fs.writeFileSync(target, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
      fs.chmodSync(target, 0o600)
    }, (offer) => {
      const dir = hygieneDir(space)
      this.deps.spawns.add({
        projectId: space.registry.create(dir, 'Brain hygiene').project.projectId,
        prompt: hygienePrompt(offer),
        title: 'Brain hygiene',
        fromSessionId: null,
        ...(space.main ? {} : { spaceId: space.id }),
      })
      this.deps.log?.(`brain hygiene: session queued for ${space.name} (${offer.reasons.join('; ')})`)
    })
  }

  /** One act per space at a time: prepare, record the offer, then follow up. */
  private async once(space: BrainSpace, prepare: (offer: HygieneOffer) => void, then: (offer: HygieneOffer) => void): Promise<HygieneActResult> {
    if (this.busy.has(space.id)) return { ok: false, reason: 'pending' }
    this.busy.add(space.id)
    try {
      const offer = await this.offer(space)
      if (!offer) return { ok: false, reason: 'nothing-due' }
      prepare(offer)
      await updateCockpitConfig((config) => config && { ...config, hygiene: { ...config.hygiene, [space.id]: offer.next } })
      then(offer)
      return { ok: true, findings: count(offer.checks) }
    } finally {
      this.busy.delete(space.id)
    }
  }
}
